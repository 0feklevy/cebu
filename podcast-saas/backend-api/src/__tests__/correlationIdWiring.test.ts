/**
 * observability-003 — pins the PRODUCTION wiring of the correlation scope.
 *
 * `middleware/__tests__/correlationId.test.ts` proves what a Fastify instance with
 * `registerCorrelationId` does. That is only a claim about THIS SERVER if `server.ts` actually
 * installs it, and installs it FIRST: the hook opens the AsyncLocalStorage scope every later hook,
 * handler and error-handler line reads, so a plugin registered ahead of it logs outside the scope
 * and its lines carry no id.
 *
 * `server.ts` cannot be imported (module scope opens listeners and a database connection), so this
 * reads the source — the same shape as `trustProxyWiring.test.ts`, and for the same reason: the
 * property is which call reaches the framework, which is a wiring fact.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const serverSrc = readFileSync(resolve(HERE, '../server.ts'), 'utf-8');
/** Comments stripped: prose describing the hook must not read as the hook being installed. */
const serverCode = serverSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('correlation-id production wiring', () => {
  it('server.ts installs the correlation scope', () => {
    expect(serverCode, 'server.ts no longer imports the correlation middleware')
      .toMatch(/import\s*\{[^}]*registerCorrelationId[^}]*\}\s*from\s*'\.\/middleware\/correlationId\.js'/);
    expect(serverCode, 'server.ts never calls registerCorrelationId — no request has an id')
      .toMatch(/registerCorrelationId\(\s*app\s*\)/);
  });

  it('installs it before any other hook-registering plugin', () => {
    const install = serverCode.indexOf('registerCorrelationId(app)');
    expect(install, 'registerCorrelationId(app) not found').toBeGreaterThan(-1);
    // @fastify/cors and @fastify/helmet both add onRequest hooks; hooks run in registration order.
    for (const plugin of ['app.register(cors', 'app.register(helmet', 'app.register(multipart']) {
      const at = serverCode.indexOf(plugin);
      expect(at, `${plugin} not found in server.ts`).toBeGreaterThan(-1);
      expect(install, `${plugin} is registered before the correlation scope — its logs get no id`)
        .toBeLessThan(at);
    }
  });

  it('the error boundary is still the app-wide handler, so its 5xx lines land inside the scope', () => {
    expect(serverCode).toMatch(/app\.setErrorHandler\(\s*apiErrorHandler\s*\)/);
  });
});
