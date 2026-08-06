/**
 * Pins the PRODUCTION wiring of the trusted-proxy setting.
 *
 * `sim-rum.test.ts` proves what a Fastify instance built with `TRUST_PROXY_HOPS` does with forged
 * X-Forwarded-For chains. That is only a claim about the SERVER if `server.ts` actually passes that
 * constant to Fastify. It previously did not have to: the suite declared its own local `1`, so
 * `trustProxy: true` in `server.ts` — the leftmost-entry vulnerability, i.e. an attacker-chosen
 * rate-limit key — was a fully green change.
 *
 * `server.ts` cannot be imported (module scope opens listeners and a database connection), so this
 * reads the source. A static assertion is the right shape here: the property being pinned is which
 * value reaches the framework, which is a wiring fact, not a runtime behaviour.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const serverSrc = readFileSync(resolve(HERE, '../server.ts'), 'utf-8');
/**
 * Comments stripped for the negative assertion: the block above `trustProxy` documents the
 * measured behaviour of `trustProxy: true` on purpose, and that prose must not read as the code
 * doing it. Only what the compiler sees can fail this test.
 */
const serverCode = serverSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('trusted-proxy production wiring', () => {
  it('server.ts configures Fastify from the shared TRUST_PROXY_HOPS constant', () => {
    expect(serverCode, 'server.ts no longer imports the shared hop count')
      .toMatch(/import\s*\{[^}]*TRUST_PROXY_HOPS[^}]*\}\s*from\s*'\.\/config\/trustProxy\.js'/);
    expect(serverCode, 'server.ts does not pass TRUST_PROXY_HOPS to Fastify')
      .toMatch(/trustProxy:\s*TRUST_PROXY_HOPS/);
  });

  it('server.ts never trusts the whole forwarded chain', () => {
    // `true` takes the LEFTMOST X-Forwarded-For entry, which the caller writes.
    expect(serverCode, 'trustProxy: true trusts a caller-chosen IP — every request gets its own bucket')
      .not.toMatch(/trustProxy:\s*true/);
    expect(serverCode, 'the rate-limit key must not fall back to the proxy container address')
      .not.toMatch(/trustProxy:\s*(false|0)\b/);
  });

  it('the hop count is a number matching the single-nginx-hop topology', async () => {
    const { TRUST_PROXY_HOPS } = await import('../config/trustProxy.js');
    expect(typeof TRUST_PROXY_HOPS, 'the hop count must be a hop COUNT, not a boolean').toBe('number');
    expect(TRUST_PROXY_HOPS).toBe(1);
  });
});
