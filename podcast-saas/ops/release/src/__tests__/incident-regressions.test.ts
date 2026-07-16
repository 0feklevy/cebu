import { readFileSync } from 'node:fs';
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
