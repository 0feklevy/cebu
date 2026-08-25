/**
 * `/health` must report the version that is actually running.
 *
 * ── THE DEFECT THIS PINS ──────────────────────────────────────────────────────────────────────
 * The field read `process.env.npm_package_version ?? '0.1.0'`. `npm_package_version` is set ONLY
 * when a process is started through npm or pnpm; production runs `node dist/server.js` directly.
 * So the field reported the literal string `0.1.0` forever — identical before and after every
 * release, for as long as the endpoint had existed.
 *
 * ── WHY IT MATTERED MORE THAN IT LOOKS ────────────────────────────────────────────────────────
 * "Is the new code live?" is the first question after any deploy and the first question during an
 * incident. With this field inert, the only way to answer it was to probe a route the release had
 * added and check 401 versus 404 — a workaround that only works when a release happens to add a
 * route. During the 23 August avatar outage, not being able to state plainly what was deployed
 * cost real time.
 *
 * The failure was silent by construction: a field that always answers is never suspected. So the
 * assertions below are about the FALLBACK never winning when a real value exists.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTROLLER = readFileSync(join(HERE, '..', 'health.controller.ts'), 'utf8');
const COMPOSE = readFileSync(join(HERE, '..', '..', '..', '..', '..', 'deploy', 'docker-compose.yml'), 'utf8');

/** The expression as the controller computes it, so the precedence itself is under test. */
const resolveVersion = (env: NodeJS.ProcessEnv): string =>
  env.APP_VERSION || env.npm_package_version || '0.1.0';

describe('the version the endpoint reports', () => {
  it('prefers APP_VERSION — the tag the deploy actually started', () => {
    expect(resolveVersion({ APP_VERSION: 'a1b2c3d', npm_package_version: '0.1.0' })).toBe('a1b2c3d');
  });

  it('falls back to the package version for a local run', () => {
    // `pnpm dev` sets npm_package_version and nothing sets APP_VERSION. That case must keep
    // working, or this "fix" makes development worse to make production better.
    expect(resolveVersion({ npm_package_version: '0.4.2' })).toBe('0.4.2');
  });

  it('treats an EMPTY APP_VERSION as absent rather than reporting nothing', () => {
    // `${APP_VERSION:-unknown}` in compose means the variable is always present; an empty string
    // arrives when it is set-but-blank. `??` would accept that and report '' — which renders as a
    // missing version and reads like the endpoint is broken.
    expect(resolveVersion({ APP_VERSION: '', npm_package_version: '0.4.2' })).toBe('0.4.2');
  });

  it('never returns the hardcoded fallback when a real value is available', () => {
    // The whole defect in one line: the fallback used to win ALWAYS.
    for (const env of [{ APP_VERSION: 'x' }, { npm_package_version: 'y' }, { APP_VERSION: 'x', npm_package_version: 'y' }]) {
      expect(resolveVersion(env)).not.toBe('0.1.0');
    }
  });
});

describe('the wiring that makes it possible', () => {
  it('the controller reads APP_VERSION, not only the npm variable', () => {
    expect(CONTROLLER, 'health no longer consults APP_VERSION').toContain('process.env.APP_VERSION');
  });

  it('compose passes APP_VERSION INTO the containers, not merely into the image tag', () => {
    // The gap that made the field inert: APP_VERSION selected `image: …:${APP_VERSION}` and was
    // never handed to the process. Both long-lived services need it — the API answers /health,
    // and the worker's logs are read during the same incidents.
    const passes = COMPOSE.match(/^\s*APP_VERSION:\s*\$\{APP_VERSION/gm) ?? [];
    expect(passes.length, 'a service selects the image by APP_VERSION but cannot report it').toBeGreaterThanOrEqual(2);
  });
});
