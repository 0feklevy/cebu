import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Regression checks pinned to the REAL incidents from the initial deployment.
 * These read the actual repo files, so a future edit that reintroduces a failure
 * mode fails the release system's own test suite (which runs inside release:verify).
 */

const APP_ROOT = join(new URL('.', import.meta.url).pathname, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(APP_ROOT, rel), 'utf8');

describe('incident 1 — certbot one-off runs must bypass the renewal-loop entrypoint', () => {
  it('init-ssl.sh requests certificates with an explicit --entrypoint certbot', () => {
    const script = read('deploy/scripts/init-ssl.sh');
    expect(script).toMatch(/compose run --rm --entrypoint certbot certbot certonly/);
    // The broken form (default entrypoint = infinite renewal loop) must not return.
    expect(script).not.toMatch(/compose run --rm certbot certonly/);
  });

  it('the compose certbot service keeps its renewal-loop entrypoint (renewals still work)', () => {
    const compose = read('deploy/docker-compose.yml');
    expect(compose).toMatch(/certbot renew --webroot/);
  });

  it('production-audit.sh cert checks also use an explicit entrypoint', () => {
    const script = read('deploy/scripts/production-audit.sh');
    expect(script).toMatch(/compose run --rm --no-deps --entrypoint sh certbot/);
  });
});

describe('incident 2 — browser-visible localhost URLs (all four causes)', () => {
  it('cause A: next.config fails closed on localhost/internal/non-https public URLs (both apps)', () => {
    for (const app of ['client-web', 'admin-web']) {
      const cfg = read(`${app}/next.config.ts`);
      expect(cfg, app).toMatch(/resolvePublicUrl/);
      expect(cfg, app).toMatch(/must be a public URL in production|must be https in production/);
    }
  });

  it('cause B: compose sets BACKEND_API_URL to the public https origin for backend AND worker', () => {
    const compose = read('deploy/docker-compose.yml');
    const matches = compose.match(/BACKEND_API_URL: https:\/\/\$\{DOMAIN_API\}/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2); // web tier + worker
  });

  it('cause C: the bundle scan catches loopback AND internal-docker hosts', () => {
    const scan = read('deploy/scripts/scan-bundle-localhost.sh');
    expect(scan).toMatch(/localhost\|127\\\.0\\\.0\\\.1/);
    expect(scan).toMatch(/backend\|worker\|nginx\|client-web\|admin-web/);
  });

  it('cause D: the DB repair covers every historically-poisoned column', () => {
    const backfill = read('backend-api/src/scripts/backfill-localhost-urls.ts');
    for (const col of [
      "table: 'projects', urlCol: 'thumbnail_url'",
      "table: 'playlists', urlCol: 'banner_url'",
      "{ table: 'avatar_visuals', col: 'sim_entry_url' }",
      "{ table: 'timeline_sections', col: 'simulation_url' }",
    ]) {
      expect(backfill).toContain(col);
    }
  });
});

describe('incident 3 — release build contamination via .env.local', () => {
  it('release-verify.sh isolates every .env.local and restores via an EXIT trap', () => {
    const script = read('deploy/scripts/release-verify.sh');
    expect(script).toMatch(/client-web\/\.env\.local/);
    expect(script).toMatch(/admin-web\/\.env\.local/);
    expect(script).toMatch(/trap restore_env_local EXIT/);
    expect(script).toMatch(/\.release-bak/);
  });

  it('release-verify.sh supplies explicit production public URLs', () => {
    const script = read('deploy/scripts/release-verify.sh');
    expect(script).toContain('https://api.flowvidco.com');
    expect(script).toContain('https://flowvidco.com');
  });
});

describe('incident 4 — CSP correctness is structural, not textual', () => {
  it('both next.configs build the CSP from the shared pure builder', () => {
    for (const app of ['client-web', 'admin-web']) {
      expect(read(`${app}/next.config.ts`), app).toMatch(/buildFrontendCsp/);
    }
  });

  it('the shared builder derives the exact Firebase auth origin and never widens', () => {
    const csp = read('shared/src/csp.ts');
    expect(csp).toMatch(/firebaseAuthFrameOrigin/);
    expect(csp).toMatch(/frame-ancestors 'none'/);
  });
});

describe('incident 6 — no false-green: HTTP health alone can never conclude a release', () => {
  it('the release workflow gates on browser findings, not just endpoint status', () => {
    const wf = readFileSync(join(APP_ROOT, '..', '.github', 'workflows', 'release.yml'), 'utf8');
    expect(wf).toMatch(/browser-findings\.json/);
    expect(wf).toMatch(/playwright-summary\.json/);
    expect(wf).toMatch(/gate --phase post-deploy/);
    // publish requires the deploy job (which contains the gate) to succeed
    expect(wf).toMatch(/needs\.deploy\.result == 'success'/);
  });
});

describe('incident 7 (run 29528323804) — context-aware anonymous-401 classification stays in sync', () => {
  it('the Playwright spec mirrors config.api.protectedRoutes exactly (no blanket /api/v1 rule)', () => {
    const spec = read('client-web/e2e/production-audit.spec.ts');
    // The two explicitly-protected collection routes, nothing broader.
    expect(spec).toContain(String.raw`/^\/api\/v1\/projects\/?$/i`);
    expect(spec).toContain(String.raw`/^\/api\/v1\/playlists\/?$/i`);
    expect(spec).not.toMatch(/api\\\/v1(?!\\\/(projects|playlists))\\\/[a-z*]/i); // no wider api/v1 pattern
    // Auth context is explicit, and the admin flow flips it after signing in.
    expect(spec).toMatch(/authContext: 'anonymous'/);
    expect(spec).toMatch(/authContext = 'authenticated'/);
  });

  it('the spec mirrors the exact known-benign COOP message classification', () => {
    const spec = read('client-web/e2e/production-audit.spec.ts');
    expect(spec).toMatch(/Cross-Origin-Opener-Policy policy would block the window\\\.closed call/);
    expect(spec).toMatch(/knownBenignWarnings/);
  });
});

describe('incident 8 (PR #2) — deploy scripts must be valid on modern bash', () => {
  const SCRIPTS_DIR = join(APP_ROOT, 'deploy', 'scripts');
  const scripts = readdirSync(SCRIPTS_DIR).filter((f) => f.endsWith('.sh'));

  it('bash -n parses every deploy script', () => {
    for (const script of scripts) {
      expect(() => execFileSync('/bin/bash', ['-n', join(SCRIPTS_DIR, script)]), script).not.toThrow();
    }
  });

  it('no script combines array-length expansion with a :- default (bash-5 bad substitution)', () => {
    // `${#arr[@]:-0}` runs on macOS bash 3.2 but is a runtime "bad substitution" on
    // bash 4.4+/5 (the CI runner) — and `bash -n` cannot catch it (expansion errors
    // are runtime-only), so this pattern ban is the actual guard.
    const BAD = /\$\{#[A-Za-z_][A-Za-z0-9_]*\[[@*]\]:[-=?+]/;
    const isComment = (l: string) => /^\s*#/.test(l); // bash never expands inside comments
    for (const script of scripts) {
      const text = readFileSync(join(SCRIPTS_DIR, script), 'utf8');
      const hit = text.split('\n').findIndex((l) => !isComment(l) && BAD.test(l));
      expect(hit, `${script}:${hit + 1} uses \${#arr[@]:-…} — invalid on bash 5`).toBe(-1);
    }
  });
});

describe('the VM never builds on the release path', () => {
  it('deploy-images.sh pulls digests and refuses source builds', () => {
    const script = read('deploy/scripts/deploy-images.sh');
    expect(script).toMatch(/--no-build/);
    expect(script).toMatch(/docker pull/);
    expect(script).toMatch(/RepoDigests/);
    for (const forbidden of ['pnpm install', 'next build', 'compose build', 'docker build ', 'tsc']) {
      expect(script, `must not contain: ${forbidden}`).not.toContain(forbidden);
    }
  });
});
