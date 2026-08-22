/**
 * The job graph of a GitHub Actions workflow, read structurally.
 *
 * Why this exists rather than `text.includes('needs: [a, b]')`: a workflow file has several
 * places where the same key name is legal. `deploy` is both a `workflow_dispatch` *input* and
 * a *job* in release.yml, so a substring or naive-anchor match can bind to the wrong one — and
 * did, corrupting the inputs block while looking, in a diff, exactly like the intended edit.
 * Everything here therefore keys off column position: top-level keys sit at column 0, their
 * children at 2. That is enough structure for a job graph and stays a pure function of the text.
 *
 * This is deliberately NOT a general YAML parser. It understands the subset these workflows are
 * written in, and it is unit-tested against the shapes that have actually gone wrong.
 */

export interface JobNode {
  /** Job id as it appears under `jobs:`. */
  name: string;
  /** Job ids listed in `needs:`, in declaration order. Empty when the job declares none. */
  needs: string[];
  /** Raw text of the job's `if:` expression, or null when unconditional. */
  ifExpr: string | null;
  /** The job's own lines, for assertions that need to look inside it. */
  text: string;
}

/** Lines belonging to the top-level `key:` block, excluding the key line itself. */
function topLevelBlock(text: string, key: string): string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l === `${key}:`);
  if (start === -1) throw new Error(`workflow has no top-level "${key}:" key`);
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    // A non-blank line at column 0 ends the block. Comments at column 0 do too — they are
    // conventionally written above the next top-level key, not inside the previous block.
    if (line.trim() !== '' && !/^[\s]/.test(line)) break;
    out.push(line);
  }
  return out;
}

/**
 * Parse `jobs:` into a graph. Job ids are the 2-space-indented keys directly under `jobs:`;
 * anything deeper belongs to a job body and is never mistaken for a job.
 */
export function parseJobGraph(workflowText: string): Map<string, JobNode> {
  const block = topLevelBlock(workflowText, 'jobs');
  const jobs = new Map<string, JobNode>();

  let current: string | null = null;
  let buffer: string[] = [];
  const flush = () => {
    if (current === null) return;
    const text = buffer.join('\n');
    jobs.set(current, { name: current, needs: parseNeeds(text), ifExpr: parseIf(text), text });
  };

  for (const line of block) {
    const m = /^ {2}([A-Za-z_][A-Za-z0-9_-]*):\s*$/.exec(line);
    if (m) {
      flush();
      current = m[1];
      buffer = [];
      continue;
    }
    if (current !== null) buffer.push(line);
  }
  flush();
  return jobs;
}

/** `needs: [a, b]` or a `needs:` block list. Only the job's own top-level (4-space) key counts. */
function parseNeeds(jobText: string): string[] {
  const inline = /^ {4}needs:\s*\[([^\]]*)\]\s*$/m.exec(jobText);
  if (inline) {
    return inline[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const scalar = /^ {4}needs:\s*([A-Za-z_][A-Za-z0-9_-]*)\s*$/m.exec(jobText);
  if (scalar) return [scalar[1]];

  const blockStart = /^ {4}needs:\s*$/m.exec(jobText);
  if (!blockStart) return [];
  const rest = jobText.slice(blockStart.index + blockStart[0].length).split('\n').slice(1);
  const out: string[] = [];
  for (const line of rest) {
    const item = /^ {6}- \s*([A-Za-z_][A-Za-z0-9_-]*)\s*$/.exec(line);
    if (!item) break;
    out.push(item[1]);
  }
  return out;
}

/**
 * The job's own `if:` (4-space), never a step's — folded when written as a block scalar.
 *
 * A condition long enough to be interesting is usually written `if: >-` across several lines,
 * which is exactly what a real gate condition looks like once it has to name the jobs it
 * requires. Returning the first line for those yields the literal string ">-", and an assertion
 * like `expect(ifExpr).not.toContain("always()")` then passes against every condition ever
 * written. A parser that silently returns the wrong thing is worse than one that throws.
 */
function parseIf(jobText: string): string | null {
  const lines = jobText.split('\n');
  const idx = lines.findIndex((l) => /^ {4}if:/.test(l));
  if (idx === -1) return null;
  const head = /^ {4}if:\s*(.*?)\s*$/.exec(lines[idx])![1];
  if (head !== '>' && head !== '>-' && head !== '|' && head !== '|-') return head || null;

  // Block scalar: take the more-indented lines that follow and fold them into one expression.
  const folded: string[] = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    if (!/^ {6}/.test(line)) break;
    folded.push(line.trim());
  }
  return folded.length > 0 ? folded.join(' ') : null;
}

/**
 * Every job that `target` waits on, directly or transitively.
 * Throws on a cycle — a job that (however indirectly) needs itself can never start, and a
 * workflow that deadlocks is a workflow whose gates never run.
 */
export function transitiveNeeds(jobs: Map<string, JobNode>, target: string): Set<string> {
  const seen = new Set<string>();
  const walk = (name: string, path: string[]): void => {
    const node = jobs.get(name);
    if (!node) throw new Error(`job "${name}" is needed by ${path[path.length - 1] ?? '?'} but is not defined`);
    for (const dep of node.needs) {
      if (path.includes(dep)) throw new Error(`needs cycle: ${[...path, dep].join(' → ')}`);
      if (!seen.has(dep)) {
        seen.add(dep);
        walk(dep, [...path, dep]);
      }
    }
  };
  walk(target, [target]);
  return seen;
}

/**
 * Status functions that switch OFF the implicit "all needs succeeded" precondition.
 * Their presence is not by itself a defect — see `gateIsEnforced`.
 */
const STATUS_FUNCTIONS = ['always(', 'cancelled(', 'failure('];

/** True when `if:` would let the job run despite a failed or skipped dependency. */
export function ifBypassesFailedDependencies(ifExpr: string | null): boolean {
  if (!ifExpr) return false;
  const normalized = ifExpr.replace(/\s+/g, '');
  if (STATUS_FUNCTIONS.some((fn) => normalized.includes(fn))) return true;
  return /needs\.[A-Za-z0-9_-]+\.result/.test(normalized);
}

/**
 * Is `gate`'s SUCCESS actually a precondition for this job?
 *
 * `ifBypassesFailedDependencies` asks a blunter question, and on its own it is the wrong rule for
 * a pipeline that has any conditional job in it. GitHub skips a job when any of its `needs` was
 * skipped, so an *optional* step — a human approval required only for risky releases — forces the
 * dependant to use a status function just to tolerate the skip. Forbidding status functions
 * outright would therefore forbid conditional approval, and the natural workaround is a blanket
 * `always()`, which really does un-gate everything. The blunt rule pushes you toward the unsafe
 * edit.
 *
 * So the precise property is asserted instead: either the job relies on the implicit precondition
 * (no status function anywhere), or it names the gate and demands success explicitly. Tolerating a
 * skipped approval is fine. Tolerating a failed smoke test is not, and no spelling of this
 * expression can do the second without failing here.
 */
export function gateIsEnforced(ifExpr: string | null, gate: string): boolean {
  if (!ifExpr) return true; // no condition ⇒ the implicit "needs all succeeded" applies
  const normalized = ifExpr.replace(/\s+/g, '');
  const hasStatusFn = STATUS_FUNCTIONS.some((fn) => normalized.includes(fn));
  const inspectsResults = /needs\.[A-Za-z0-9_-]+\.result/.test(normalized);
  if (!hasStatusFn && !inspectsResults) return true;

  // Once the implicit precondition is off, the gate must be named and required to have succeeded.
  const required = new RegExp(`needs\\.${gate.replace(/[-]/g, '-')}\\.result=='success'`);
  if (!required.test(normalized)) return false;
  // ...and never in a disjunction, where some other branch could admit the failure anyway.
  const clauses = normalized.split('&&');
  return clauses.some((c) => required.test(c) && !c.includes('||'));
}

/**
 * The workflow with its prose removed — whole-line `#` comments only.
 *
 * Assertions like "this job never names a floating tag" have to read what the job *runs*, not
 * what it says about itself. Two of this module's sibling tests initially failed against their
 * own explanatory comments, which is a false alarm that would train the next reader to loosen a
 * real check. Trailing comments are left alone: `#` is legal inside a shell `run:` block and
 * stripping it there would corrupt the command being asserted on.
 */
export function withoutComments(workflowText: string): string {
  return workflowText
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}
