/**
 * RESUMING AUTOMATION MUST NOT RE-RUN A ONE-SHOT THAT ALREADY FIRED (audit).
 *
 * `_record` stored every tracked handle's respawn spec and nothing removed a `setTimeout`'s entry
 * when it fired. So `_pauseDemoTimers` retained an ALREADY-COMPLETED one-shot and
 * `_resumeDemoTimers` scheduled it again: toggling Auto Script off and then on re-ran the body's
 * one-shot demo steps — `applyImpulse()`, a scripted click, a reset. That changes what the
 * simulation COMPUTES, not merely when it is shown, which is the one category of change the
 * presentation layer is never allowed to make.
 *
 * Proven by EXECUTING the emitted bytes, the same way `simPolicyBridge.test.ts` does: the source
 * under test is exactly what `wrapBridgeCombined` writes to a package's `bridge.js`, run in a VM
 * with a clock the test advances by hand.
 */
import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { wrapBridgeCombined } from '../SimulationService.js';

const SECTION = 'sec-oneshot-0001';

/**
 * A body whose demonstration has BOTH shapes: a repeating tick (resumable by construction) and a
 * single impulse (not). Both are registered as automation via `simDemoTimer`, which is the only
 * thing that makes a handle pausable at all.
 */
const BODY = `
  var g = window.__probe = window.__probe || { runs: 0, impulses: 0, ticks: 0 };
  g.runs++;
  window.simDemoTimer(setTimeout(function () { g.impulses++; }, 50));
  window.simDemoTimer(setInterval(function () { g.ticks++; }, 40));
  return function () { g.cleanups = (g.cleanups || 0) + 1; };
`;

const BRIDGE = wrapBridgeCombined(new Map([[SECTION, BODY]]));

interface Posted { type: string; [k: string]: unknown }

/** The `simPolicyBridge` harness, reduced to what a timer test needs. */
function harness(): {
  send: (m: Record<string, unknown>) => void;
  advance: (ms: number) => void;
  pump: () => void;
  probe: () => { runs: number; impulses: number; ticks: number; cleanups?: number };
  lastPost: (type: string) => Posted | undefined;
} {
  const posted: Posted[] = [];
  const listeners: ((e: { data: unknown; source?: unknown }) => void)[] = [];

  let now = 0;
  let seq = 0;
  interface Timer { fn: (...a: unknown[]) => void; args: unknown[]; due: number; every: number | null }
  const timers = new Map<number, Timer>();
  const schedule = (fn: (...a: unknown[]) => void, ms: number, args: unknown[], every: number | null): number => {
    const id = ++seq;
    timers.set(id, { fn, args, due: now + ms, every });
    return id;
  };
  const advance = (ms: number): void => {
    const target = now + ms;
    for (let guard = 0; guard < 100_000; guard++) {
      let nextId: number | null = null;
      let nextDue = Infinity;
      for (const [id, t] of timers) if (t.due <= target && t.due < nextDue) { nextDue = t.due; nextId = id; }
      if (nextId === null) break;
      const t = timers.get(nextId)!;
      now = t.due;
      if (t.every === null) timers.delete(nextId);
      else t.due = now + Math.max(t.every, 1);
      t.fn(...t.args);
    }
    now = target;
  };

  let rafSeq = 1_000_000;
  let rafQueue: { id: number; cb: (t: number) => void }[] = [];
  const pump = (): void => {
    const batch = rafQueue;
    rafQueue = [];
    for (const r of batch) r.cb(now);
  };

  const el = (): { id: string; textContent: string; remove(): void } =>
    ({ id: '', textContent: '', remove(): void { /* nothing here inspects the hide style */ } });
  const doc = {
    readyState: 'complete',
    head: { appendChild(): void { /* no-op */ } },
    documentElement: el(),
    getElementById: (): null => null,
    createElement: (): ReturnType<typeof el> => el(),
    addEventListener(): void { /* pointerdown — nothing dispatches one here */ },
  };

  const ctx: Record<string, unknown> = {
    console, Object, JSON, String, Math, Date, Array, URLSearchParams,
    document: doc,
    location: { search: `?section=${SECTION}`, href: 'https://sim.test/index.html' },
    parent: { postMessage: (m: Posted) => { posted.push(m); } },
    setTimeout: (fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => schedule(fn, ms ?? 0, args, null),
    setInterval: (fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => schedule(fn, ms ?? 0, args, ms ?? 0),
    clearTimeout: (id: number) => { timers.delete(id); },
    clearInterval: (id: number) => { timers.delete(id); },
    requestAnimationFrame: (cb: (t: number) => void) => { const id = ++rafSeq; rafQueue.push({ id, cb }); return id; },
    cancelAnimationFrame: (id: number) => { rafQueue = rafQueue.filter((r) => r.id !== id); },
    addEventListener(type: string, fn: (e: { data: unknown }) => void) { if (type === 'message') listeners.push(fn); },
    removeEventListener() { /* nothing under test removes one */ },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(BRIDGE, ctx as vm.Context, { filename: 'bridge.js' });
  pump();

  return {
    // `source: ctx.parent` — the bridge ignores messages from any other window (simulation-004).
    send: (m) => { const data = structuredClone(m); for (const l of [...listeners]) l({ data, source: ctx.parent }); },
    advance,
    pump,
    probe: () => (ctx.__probe as { runs: number; impulses: number; ticks: number; cleanups?: number })
      ?? { runs: 0, impulses: 0, ticks: 0 },
    lastPost: (type) => [...posted].reverse().find((p) => p.type === type),
  };
}

/** Boot the package, run the section, and let the one-shot fire. */
function booted(): ReturnType<typeof harness> {
  const h = harness();
  h.send({ type: 'startScript', script: SECTION, params: { autoScript: true }, token: 1 });
  h.pump();
  h.advance(200);
  return h;
}

describe('auto-script resume and one-shot demo timers', () => {
  it('a fired one-shot is forgotten, so resuming automation does not re-run it', () => {
    const h = booted();
    expect(h.probe().impulses, 'the one-shot must have fired for this test to mean anything').toBe(1);
    const ticksBefore = h.probe().ticks;
    expect(ticksBefore).toBeGreaterThan(0);

    h.send({ type: 'autoPolicy', autoScript: false, token: 1 });
    h.send({ type: 'autoPolicy', autoScript: true, token: 1 });
    h.advance(500);

    // THE DEFECT: without the forget-on-fire wrapper this is 2 — the completed `applyImpulse()`
    // is re-scheduled by the resume and the simulation's state diverges from what the viewer saw.
    expect(h.probe().impulses).toBe(1);
    // The body was NOT re-run — this is a resume, not a restart.
    expect(h.probe().runs).toBe(1);
    // And the repeating half really did come back, so "impulses stayed at 1" is not just a dead
    // document.
    expect(h.probe().ticks).toBeGreaterThan(ticksBefore);
  });

  it('reports resuming ONE handle — the interval — not the spent one-shot as well', () => {
    const h = booted();
    h.send({ type: 'autoPolicy', autoScript: false, token: 1 });
    const paused = h.lastPost('POLICY_RESULT')!;
    // Only the live interval is still stoppable; the fired one-shot is gone from the registry.
    expect(paused).toMatchObject({ kind: 'automation', applied: true, stopped: 1 });

    h.send({ type: 'autoPolicy', autoScript: true, token: 1 });
    const resumed = h.lastPost('POLICY_RESULT')!;
    expect(resumed).toMatchObject({ kind: 'automation', applied: true, restarted: 1, unrestorable: 0 });
  });

  it('a one-shot still PENDING when automation pauses is genuinely resumable', () => {
    // The inverse, so "forget the fired one" is not implemented as "never resume a timeout".
    const h = harness();
    h.send({ type: 'startScript', script: SECTION, params: { autoScript: true }, token: 1 });
    h.pump();
    h.advance(10);                       // before the 50 ms impulse
    expect(h.probe().impulses).toBe(0);

    h.send({ type: 'autoPolicy', autoScript: false, token: 1 });
    h.advance(500);
    expect(h.probe().impulses, 'paused automation must not fire').toBe(0);

    h.send({ type: 'autoPolicy', autoScript: true, token: 1 });
    h.advance(500);
    expect(h.probe().impulses).toBe(1);
    // …and re-pausing after it has now fired must not make it resumable a second time.
    h.send({ type: 'autoPolicy', autoScript: false, token: 1 });
    h.send({ type: 'autoPolicy', autoScript: true, token: 1 });
    h.advance(500);
    expect(h.probe().impulses).toBe(1);
  });

  it('still forwards the extra (fn, delay, ...args) arguments a body passes', () => {
    // The arming wrapper rebuilds the argument list, so this is the thing it could quietly drop.
    const bridge = wrapBridgeCombined(new Map([['sec-args-0002', `
      var g = window.__probe = window.__probe || { runs: 0, impulses: 0, ticks: 0 };
      g.runs++;
      setTimeout(function (a, b) { g.args = [a, b]; }, 10, 'x', 7);
      return function () {};
    `]]));
    const posted: Posted[] = [];
    const listeners: ((e: { data: unknown; source?: unknown }) => void)[] = [];
    let now = 0; let seq = 0;
    const timers = new Map<number, { fn: (...a: unknown[]) => void; args: unknown[]; due: number }>();
    const ctx: Record<string, unknown> = {
      console, Object, JSON, String, Math, Date, Array, URLSearchParams,
      document: {
        readyState: 'complete', head: { appendChild(): void { /* no-op */ } },
        documentElement: {}, getElementById: (): null => null,
        createElement: (): Record<string, unknown> => ({ remove(): void { /* no-op */ } }),
        addEventListener(): void { /* no-op */ },
      },
      location: { search: '', href: 'https://sim.test/index.html' },
      parent: { postMessage: (m: Posted) => { posted.push(m); } },
      setTimeout: (fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
        const id = ++seq; timers.set(id, { fn, args, due: now + (ms ?? 0) }); return id;
      },
      setInterval: (fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
        const id = ++seq; timers.set(id, { fn, args, due: now + (ms ?? 0) }); return id;
      },
      clearTimeout: (id: number) => { timers.delete(id); },
      clearInterval: (id: number) => { timers.delete(id); },
      requestAnimationFrame: (cb: (t: number) => void) => { cb(0); return 1; },
      cancelAnimationFrame: () => { /* no-op */ },
      addEventListener(type: string, fn: (e: { data: unknown }) => void) { if (type === 'message') listeners.push(fn); },
      removeEventListener() { /* no-op */ },
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(bridge, ctx as vm.Context, { filename: 'bridge.js' });
    for (const l of [...listeners]) l({ data: { type: 'startScript', script: 'sec-args-0002', params: {}, token: 1 }, source: ctx.parent });
    now = 100;
    for (const [, t] of [...timers]) if (t.due <= now) t.fn(...t.args);

    expect((ctx.__probe as { args?: unknown[] }).args).toEqual(['x', 7]);
  });
});
