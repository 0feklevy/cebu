import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Static checks over .github/workflows/*.yml — action runtime currency,
 * credential hygiene, audit metadata, and least-privilege invariants.
 * (Run 29528323804 fixes: Node-20 action deprecations, the post-checkout
 * git-128 warning, and audits reporting UNKNOWN with no Started time.)
 */

const WF_DIR = join(new URL('.', import.meta.url).pathname, '..', '..', '..', '..', '..', '.github', 'workflows');
const files = readdirSync(WF_DIR).filter((f) => f.endsWith('.yml'));
const wf = Object.fromEntries(files.map((f) => [f, readFileSync(join(WF_DIR, f), 'utf8')]));

describe('action runtimes are current (no Node-20-era majors)', () => {
  /** Versions the 2026-07-16 audit flagged as deprecated (or same-era peers). */
  const FORBIDDEN = [
    'actions/checkout@v4',
    'actions/setup-node@v4',
    'actions/upload-artifact@v4',
    'actions/download-artifact@v4',
    'pnpm/action-setup@v4',
    'docker/setup-buildx-action@v3',
    'docker/login-action@v3',
    'docker/build-push-action@v6',
  ];
  /** The reviewed replacements (see release-notes evidence in the fix commit). */
  const EXPECTED = [
    'actions/checkout@v6',
    'actions/setup-node@v6',
    'actions/upload-artifact@v6',
    'pnpm/action-setup@v6',
  ];

  for (const [name, text] of Object.entries(wf)) {
    it(`${name} uses no deprecated action majors`, () => {
      for (const bad of FORBIDDEN) {
        expect(text, `${name} still uses ${bad}`).not.toContain(`uses: ${bad}`);
      }
    });
  }

  it('the audit workflow uses the reviewed replacements', () => {
    for (const good of EXPECTED) {
      expect(wf['production-audit.yml']).toContain(`uses: ${good}`);
    }
  });

  it('every action reference is pinned to a major tag (no floating latest/main)', () => {
    for (const [name, text] of Object.entries(wf)) {
      for (const m of text.matchAll(/uses:\s*([^\s#]+)/g)) {
        expect(m[1], `${name}: ${m[1]}`).toMatch(/@v\d+(\.\d+)*$/);
      }
    }
  });
});

describe('checkout credential hygiene (git-128 post-step fix)', () => {
  it('the read-only production audit never persists git credentials', () => {
    expect(wf['production-audit.yml']).toContain('persist-credentials: false');
  });

  it('ci and rollback checkouts do not persist credentials (they never push)', () => {
    expect((wf['ci.yml'].match(/persist-credentials: false/g) ?? []).length).toBe(2);
    expect((wf['rollback.yml'].match(/persist-credentials: false/g) ?? []).length).toBe(2);
  });

  it('release keeps credentials ONLY for the remote-read (plan) and tag-push (release-plan) jobs', () => {
    const checkouts = (wf['release.yml'].match(/uses: actions\/checkout@v\d+/g) ?? []).length;
    const withoutCreds = (wf['release.yml'].match(/persist-credentials: false/g) ?? []).length;
    expect(checkouts).toBe(7);
    expect(withoutCreds).toBe(5); // all except plan + release-plan
    expect(wf['release.yml']).toContain('credentials kept: preflight runs `git ls-remote');
    expect(wf['release.yml']).toContain('credentials kept: this job pushes the annotated release tag');
  });
});

describe('audit report metadata (no UNKNOWN state, no missing Started)', () => {
  it('production audit records a start time and reports with --kind audit', () => {
    expect(wf['production-audit.yml']).toContain('AUDIT_STARTED_AT=$(date -u');
    expect(wf['production-audit.yml']).toContain('--kind audit');
    expect(wf['production-audit.yml']).toContain('--started-at "${AUDIT_STARTED_AT}"');
  });

  it('rollback records a start time and reports with --kind rollback', () => {
    expect(wf['rollback.yml']).toContain('ROLLBACK_STARTED_AT=$(date -u');
    expect(wf['rollback.yml']).toContain('--kind rollback');
  });
});

describe('least-privilege permissions are preserved', () => {
  for (const [name, text] of Object.entries(wf)) {
    it(`${name} defaults to contents: read`, () => {
      expect(text).toMatch(/^permissions:\n\s+contents: read/m);
    });
  }

  it('packages: write appears only in the image-build job; contents: write only for tag/publish', () => {
    expect((wf['release.yml'].match(/packages: write/g) ?? []).length).toBe(1);
    expect((wf['release.yml'].match(/contents: write/g) ?? []).length).toBe(2);
    expect(wf['production-audit.yml']).not.toContain('write');
  });
});
