import { describe, expect, it } from 'vitest';
import { gateIsEnforced, ifBypassesFailedDependencies, parseJobGraph, transitiveNeeds, withoutComments } from '../workflow-graph.js';

/**
 * The parser is tested before it is trusted, against the shapes that have actually gone wrong
 * in this repository's workflows — not against invented ones.
 */

/** release.yml in miniature: `deploy` exists BOTH as a dispatch input and as a job. */
const DECOY = `name: Release
on:
  workflow_dispatch:
    inputs:
      bump:
        description: 'SemVer bump'
        type: choice
      deploy:
        description: 'Deploy to production?'
        type: boolean
        default: true
env:
  RUN_ID: rel-1
jobs:
  plan:
    runs-on: ubuntu-latest
    steps:
      - run: echo plan
  candidate-smoke:
    needs: [plan]
    if: \${{ inputs.deploy }}
    steps:
      - name: deploy:
        run: echo not-a-job
  deploy:
    needs: [plan, candidate-smoke]
    if: \${{ inputs.deploy }}
    steps:
      - run: echo deploy
`;

describe('a dispatch input never masquerades as a job', () => {
  it('finds exactly the jobs, not the input of the same name', () => {
    const jobs = parseJobGraph(DECOY);
    expect([...jobs.keys()]).toEqual(['plan', 'candidate-smoke', 'deploy']);
  });

  it('reads the JOB deploy, whose needs are real — not the input, which has none', () => {
    // The bug this pins: an anchor on "  deploy:\n" binds to the input block first, because
    // the inputs are declared above the jobs. A parser that keys off the `jobs:` block cannot.
    expect(parseJobGraph(DECOY).get('deploy')?.needs).toEqual(['plan', 'candidate-smoke']);
  });

  it('a step named "deploy:" inside another job is not a job', () => {
    expect(parseJobGraph(DECOY).has('run')).toBe(false);
    expect(parseJobGraph(DECOY).get('candidate-smoke')?.needs).toEqual(['plan']);
  });

  it('throws rather than guessing when there is no jobs: block', () => {
    expect(() => parseJobGraph('name: x\non:\n  push:\n')).toThrow(/no top-level "jobs:"/);
  });
});

describe('needs is read in every form a job may write it', () => {
  const mk = (needs: string) => `jobs:\n  a:\n    steps: []\n  b:\n${needs}    steps: []\n`;

  it('inline list', () => expect(parseJobGraph(mk('    needs: [a]\n')).get('b')?.needs).toEqual(['a']));
  it('bare scalar', () => expect(parseJobGraph(mk('    needs: a\n')).get('b')?.needs).toEqual(['a']));
  it('block list', () => expect(parseJobGraph(mk('    needs:\n      - a\n')).get('b')?.needs).toEqual(['a']));
  it('absent', () => expect(parseJobGraph(mk('')).get('b')?.needs).toEqual([]));
});

describe('a self-dependency is a deadlock, not a dependency', () => {
  it('refuses a job that needs itself', () => {
    // Written by hand during this branch's own development: the insertion left
    // `candidate-smoke: needs: [plan, release-plan, candidate-smoke]`, which can never start.
    // The workflow file was still perfectly valid YAML, and GitHub would have accepted it.
    const wf = 'jobs:\n  plan:\n    steps: []\n  gate:\n    needs: [plan, gate]\n    steps: []\n';
    expect(() => transitiveNeeds(parseJobGraph(wf), 'gate')).toThrow(/cycle/);
  });

  it('refuses a needs: pointing at a job that does not exist', () => {
    const wf = 'jobs:\n  deploy:\n    needs: [ghost]\n    steps: []\n';
    expect(() => transitiveNeeds(parseJobGraph(wf), 'deploy')).toThrow(/not defined/);
  });

  it('collects transitive dependencies', () => {
    const wf = 'jobs:\n  a:\n    steps: []\n  b:\n    needs: [a]\n    steps: []\n  c:\n    needs: [b]\n    steps: []\n';
    expect([...transitiveNeeds(parseJobGraph(wf), 'c')].sort()).toEqual(['a', 'b']);
  });
});

describe('an if: that re-admits a failed dependency is not a gate', () => {
  it.each([
    ['always()', true],
    ["${{ always() && inputs.deploy }}", true],
    ["${{ !cancelled() }}", true],
    ["${{ needs.gate.result == 'failure' || inputs.deploy }}", true],
    ["${{ inputs.deploy }}", false],
    ["${{ github.ref == 'refs/heads/main' }}", false],
    [null, false],
  ])('%s → bypasses=%s', (expr, expected) => {
    expect(ifBypassesFailedDependencies(expr as string | null)).toBe(expected);
  });
});

describe('assertions read what a job runs, not what it says about itself', () => {
  it('drops whole-line comments', () => {
    const wf = 'jobs:\n  a:\n    # never use :latest here\n    steps: []\n';
    expect(withoutComments(wf)).not.toContain(':latest');
    expect(withoutComments(wf)).toContain('steps: []');
  });

  it('keeps a # that is part of a shell command', () => {
    // `docker compose ... 2>&1 # note` is one thing; a shell heredoc containing `#!` is another.
    const wf = 'jobs:\n  a:\n    steps:\n      - run: echo "a#b"\n';
    expect(withoutComments(wf)).toContain('echo "a#b"');
  });
});

describe('a gate is enforced when its success is genuinely required', () => {
  const enforced = (e: string | null) => gateIsEnforced(e, 'candidate-smoke');

  it('the implicit precondition counts — no condition at all', () => {
    expect(enforced(null)).toBe(true);
  });

  it('a plain condition leaves the implicit precondition intact', () => {
    expect(enforced("${{ inputs.deploy }}")).toBe(true);
  });

  it('always() without naming the gate un-gates the pipeline', () => {
    expect(enforced("${{ always() && inputs.deploy }}")).toBe(false);
  });

  it('!cancelled() while explicitly requiring the gate is safe', () => {
    // The shape conditional approval forces: tolerate a SKIPPED approval job, never a FAILED gate.
    expect(
      enforced("${{ inputs.deploy && !cancelled() && needs.candidate-smoke.result == 'success' }}"),
    ).toBe(true);
  });

  it('requiring some OTHER job is not requiring this one', () => {
    expect(enforced("${{ !cancelled() && needs.risk-review.result == 'success' }}")).toBe(false);
  });

  it('the requirement must not sit inside a disjunction', () => {
    // `A || B` means B alone can admit the run. Naming the gate in one branch of an `||` reads
    // like a requirement and is not one.
    expect(
      enforced("${{ !cancelled() && (needs.candidate-smoke.result == 'success' || inputs.force) }}"),
    ).toBe(false);
  });

  it('tolerating a skipped approval job alongside the requirement is allowed', () => {
    expect(
      enforced(
        "${{ inputs.deploy && !cancelled() && needs.candidate-smoke.result == 'success' && (needs.risk-review.result == 'success' || needs.risk-review.result == 'skipped') }}",
      ),
    ).toBe(true);
  });
});

describe('a multi-line if: is read, not truncated to its block marker', () => {
  const blockIf = `jobs:
  deploy:
    needs: [gate, review]
    if: >-
      \${{ inputs.deploy
          && !cancelled()
          && needs.gate.result == 'success' }}
    steps: []
`;

  it('folds a >- block scalar into one expression', () => {
    const expr = parseJobGraph(blockIf).get('deploy')?.ifExpr ?? '';
    expect(expr).toContain('!cancelled()');
    expect(expr).toContain("needs.gate.result == 'success'");
    expect(expr).not.toBe('>-');
  });

  it('the folded expression is what the gate rules are evaluated against', () => {
    // The bug this pins: parseIf returned ">-", which contains no status function and no
    // `needs.*.result`, so gateIsEnforced returned true for LITERALLY ANY multi-line condition —
    // including a bare `always()`. The assertion looked green and checked nothing.
    const expr = parseJobGraph(blockIf).get('deploy')?.ifExpr ?? null;
    expect(gateIsEnforced(expr, 'gate')).toBe(true);
    expect(gateIsEnforced(expr, 'some-other-gate')).toBe(false);
  });

  it('a block-scalar always() is still caught', () => {
    const wf = blockIf.replace("&& needs.gate.result == 'success' }}", '&& always() }}');
    expect(gateIsEnforced(parseJobGraph(wf).get('deploy')?.ifExpr ?? null, 'gate')).toBe(false);
  });

  it('a single-line if: still parses', () => {
    const wf = "jobs:\n  a:\n    if: ${{ inputs.deploy }}\n    steps: []\n";
    expect(parseJobGraph(wf).get('a')?.ifExpr).toBe('${{ inputs.deploy }}');
  });
});
