/**
 * observability-008 — pins that the SERVER serves the real health check.
 *
 * `controllers/v1/__tests__/health.test.ts` proves what the routes do. `server.ts` cannot be
 * imported (module scope opens listeners and a database connection), so this reads the source to
 * prove the old database-only handler is gone and the routes are registered — otherwise the whole
 * fix is a file nothing calls.
 *
 * The negative assertion matters as much as the positive one: two `/health` handlers on one
 * Fastify instance is a boot-time duplicate-route crash, and a leftover inline handler that wins
 * would silently restore the always-green behaviour.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const serverSrc = readFileSync(resolve(HERE, '../server.ts'), 'utf-8');
const serverCode = serverSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('health-check production wiring', () => {
  it('server.ts registers the health routes', () => {
    expect(serverCode, 'server.ts no longer imports the health controller')
      .toMatch(/import\s*\{[^}]*registerHealthRoutes[^}]*\}\s*from\s*'\.\/controllers\/v1\/health\.controller\.js'/);
    expect(serverCode, 'server.ts never calls registerHealthRoutes')
      .toMatch(/registerHealthRoutes\(\s*app\s*\)/);
  });

  it('the old database-only inline handler is gone', () => {
    expect(serverCode, "server.ts still declares its own app.get('/health') — a duplicate route")
      .not.toMatch(/app\.get\(\s*'\/health'/);
  });

  it('the container healthcheck path is unchanged', () => {
    // deploy/docker-compose.yml runs `curl -fsS http://localhost:8080/health`, and `-f` fails the
    // container on any non-2xx. The path must keep existing, and /health must keep grading only
    // what makes THIS process unable to serve — see the header of health.controller.ts.
    const compose = readFileSync(resolve(HERE, '../../../deploy/docker-compose.yml'), 'utf-8');
    expect(compose).toContain('http://localhost:8080/health');
  });
});
