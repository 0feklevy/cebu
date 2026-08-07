/**
 * That the loopback guard's ROUTE HANDLER acts on the verdict — not merely that the verdict is right.
 *
 * `networkGuard.test.ts` pins `classifyGuardUrl`, and `sim-pool.spec.ts` has a live self-test that
 * fires a real non-loopback request. But that spec is env-gated (`SIM_POOL_E2E_BASE_URL`), so in an
 * automated run where the variable is unset it skips — and then replacing the handler body with an
 * unconditional `route.continue()` would leave every automated suite green with hermeticity
 * enforcement entirely off. This file closes that window without needing a browser: it drives the
 * real `installLoopbackGuard` against a minimal fake Page that records what the handler does.
 */
import { describe, it, expect } from 'vitest';
import { installLoopbackGuard } from '../e2e/networkGuard';

type RouteHandler = (route: FakeRoute) => unknown | Promise<unknown>;

interface FakeRoute {
  request(): { url(): string };
  continue(): Promise<void>;
  abort(reason?: string): Promise<void>;
}

/** The smallest object `installLoopbackGuard` needs: a `route` registrar and an event emitter. */
function fakePage() {
  let handler: RouteHandler | null = null;
  const responseHandlers: ((res: { url(): string }) => void)[] = [];
  return {
    page: {
      route: async (_pattern: string, h: RouteHandler) => { handler = h; },
      on: (event: string, h: (res: { url(): string }) => void) => {
        if (event === 'response') responseHandlers.push(h);
      },
    },
    /** Drive one request through the registered handler; returns 'continue' | 'abort'. */
    async request(url: string): Promise<'continue' | 'abort' | 'unhandled'> {
      if (!handler) return 'unhandled';
      let verdict: 'continue' | 'abort' | 'unhandled' = 'unhandled';
      await handler({
        request: () => ({ url: () => url }),
        continue: async () => { verdict = 'continue'; },
        abort: async () => { verdict = 'abort'; },
      });
      return verdict;
    },
    respond(url: string) { for (const h of responseHandlers) h({ url: () => url }); },
  };
}

describe('installLoopbackGuard — the handler enforces, it does not merely observe', () => {
  it('lets a loopback request through', async () => {
    const f = fakePage();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const guard = await installLoopbackGuard(f.page as any);
    expect(await f.request('http://localhost:3010/projects/x/view')).toBe('continue');
    expect(guard.violations()).toEqual([]);
  });

  // THE REGRESSION. A handler that always continues passes every other test in the repo.
  it('ABORTS a non-loopback request rather than continuing it', async () => {
    const f = fakePage();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const guard = await installLoopbackGuard(f.page as any);
    expect(await f.request('https://identitytoolkit.googleapis.com/v1/accounts:signUp'))
      .toBe('abort');
    expect(guard.violations()).toContain('identitytoolkit.googleapis.com');
    expect(() => guard.assertLoopbackOnly()).toThrow(/identitytoolkit/);
  });

  it('records the host it saw, so a passing run can prove where it went', async () => {
    const f = fakePage();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const guard = await installLoopbackGuard(f.page as any);
    await f.request('http://127.0.0.1:8080/api/v1/health');
    expect(guard.hosts()).toContain('127.0.0.1');
  });

  it('catches an off-loopback REDIRECT hop, which route handlers never see', async () => {
    const f = fakePage();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const guard = await installLoopbackGuard(f.page as any);
    f.respond('https://cdn.example.com/lib.js');
    expect(guard.violations()).toContain('cdn.example.com');
  });

  it('never leaks a query string into a violation marker', async () => {
    const f = fakePage();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const guard = await installLoopbackGuard(f.page as any);
    await f.request('http://');           // unparseable → marker is the sanitized URL
    for (const v of guard.violations()) expect(v).not.toContain('?');
  });
});
