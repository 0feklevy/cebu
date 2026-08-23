/**
 * SECTION POLICY ON THE GENERATED v2 BRIDGE (audit P1.2) — proven by EXECUTING the emitted bytes.
 *
 * WHAT IS UNDER TEST. Nothing here imitates the bridge. Every test runs the exact string
 * `wrapBridgeCombined()` produces — the same bytes `assembleSectionBridgeArtifacts` uploads to a
 * package's `bridge.js` — inside a VM with a fake window/document and a clock the test owns. So
 * the message listener, `startScript`, `_trackTimers`, `applyHideUi`, the respawn records and the
 * two policy handlers are all the SHIPPING ones. A suite that string-matched the template would
 * prove only that the template still contains the characters someone typed.
 *
 * WHY v2 MATTERS AT ALL. Every package published to date runs on this bridge; v3 is offered only
 * to packages the canary has classified. On v2 a presentation change arrived as a `startScript`
 * with different params, which falls straight through `stopScript()`: the body's cleanup runs,
 * every tracked timer is cleared and the body is re-executed from the top. Hiding a slider
 * restarted the physics. That is the defect, and this file is where its absence is observable.
 *
 * ── THE PROXY FOR "THE BODY WAS NOT RE-RUN", AND ITS LIMITS ──────────────────────────────────
 * "The simulation was not reset" cannot be observed directly from outside a document, so it is
 * asserted through four things that can be:
 *
 *   • `runs`     — incremented once per synchronous execution of the section body. The bridge runs
 *                  a body exactly once per `startScript`, so `runs` staying at 1 across a policy
 *                  message means the body was not re-executed.
 *   • `cleanups` — the cleanup function the body returned. `stopScript()` is the ONLY caller, and
 *                  `startScript` opens with it, so an untouched counter means no teardown happened.
 *   • `t`        — a value the demo interval integrates, and which a fresh body run resets to 0.
 *                  A preserved `t` is trajectory continuity in the one sense a fixture can have it.
 *   • `interactive` — a value written by a simulated user interaction BETWEEN the activation and
 *                  the policy. It lives in the body's closure, so it is destroyed by a re-run even
 *                  if the body were to re-derive `t`. This is the closest analogue to the real
 *                  loss: the state a viewer built up by dragging a slider.
 *
 * WHAT THE PROXY DOES NOT PROVE. A real section's state lives in engine objects, WebGL buffers and
 * closures this harness has no equivalent of. These counters prove the BRIDGE did not re-run the
 * body; they cannot prove a body does not discard its own state in response to the `simOnUiPolicy`
 * hook it opted into. That is the section author's contract, and the honest statement of it is
 * `bodyHook` on the acknowledgement — which is why the wire carries it and why it is asserted here
 * in both directions. Nor does a preserved `t` prove pixel continuity: nothing in this file paints.
 *
 * The counterweight is at the bottom of the file: a genuinely structural change DOES re-run the
 * body. Without it, "the body was not re-run" could be a property of the harness rather than of
 * the bridge.
 */
import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import {
  buildManifest,
  validateGeneratedBridge,
  wrapBridgeCombined,
  wrapBridgeMainBody,
  type SimManifest,
} from '../SimulationService.js';

// ── the section bodies ────────────────────────────────────────────────────────────────────────

const SEC_HOOKED = 'sec-hooked-0001';
const SEC_BARE = 'sec-bare-0002';
const SEC_NOCLEANUP = 'sec-nocleanup-0003';
const SEC_LATEDEMO = 'sec-latedemo-0004';
const SEC_THROWHOOK = 'sec-throwhook-0005';

/** The shared observation record. Deliberately on `window`, so a body re-run cannot recreate it. */
const STATE_GLOBAL = '__policyProbe';

const probeBody = (opts: { uiHook: boolean; cleanup: boolean }): string => `
  var g = window.${STATE_GLOBAL} = window.${STATE_GLOBAL} || { runs: 0, cleanups: 0, uiCalls: [] };
  g.runs++;
  // Reset by a body run and by nothing else — that is what makes them evidence.
  g.t = 0;
  g.ticks = 0;
  g.interactive = null;
  g.startParams = params;
  g.autoAtStart = params.autoScript !== false;

  // simDemoTimer is the bridge's opt-in: only a handle registered through it is AUTOMATION, and
  // only automation may be stopped by a policy. A body that registers nothing is not pausable.
  if (g.autoAtStart) {
    window.simDemoTimer(setInterval(function () { g.ticks++; g.t += 1; }, 40));
  }
  ${opts.uiHook
    ? `window.simOnUiPolicy(function (p) {
    g.uiCalls.push({ simpleUi: !!p.simpleUi, hideSelectors: (p.hideSelectors || []).slice() });
  });`
    : '/* no simOnUiPolicy — the mechanical hide is all this section gets */'}
  ${opts.cleanup ? 'return function cleanup() { g.cleanups++; };' : '/* returns nothing — a legal body */'}
`;

/**
 * A body whose demo handle is created AFTER it returns, so `_trackTimers` never saw it and no
 * respawn record exists. Registered as automation all the same — which is what makes it stoppable
 * but not restartable, the one case an honest resume has to refuse.
 */
const LATE_DEMO_BODY = `
  var g = window.${STATE_GLOBAL} = window.${STATE_GLOBAL} || { runs: 0, cleanups: 0, uiCalls: [] };
  g.runs++; g.t = 0; g.ticks = 0;
  setTimeout(function () {
    // Created outside the synchronous body call: window.setInterval is the REAL one again here.
    window.simDemoTimer(setInterval(function () { g.ticks++; g.t += 1; }, 40));
  }, 10);
  return function cleanup() { g.cleanups++; };
`;

/** A section whose own re-apply hook is broken. Author code, reached from a system path. */
const THROWING_HOOK_BODY = `
  var g = window.${STATE_GLOBAL} = window.${STATE_GLOBAL} || { runs: 0, cleanups: 0, uiCalls: [] };
  g.runs++; g.t = 0; g.ticks = 0;
  window.simDemoTimer(setInterval(function () { g.ticks++; g.t += 1; }, 40));
  window.simOnUiPolicy(function () { throw new Error('hook exploded'); });
  return function cleanup() { g.cleanups++; };
`;

const BODIES = new Map<string, string>([
  [SEC_HOOKED, probeBody({ uiHook: true, cleanup: true })],
  [SEC_BARE, probeBody({ uiHook: false, cleanup: true })],
  [SEC_NOCLEANUP, probeBody({ uiHook: true, cleanup: false })],
  [SEC_LATEDEMO, LATE_DEMO_BODY],
  [SEC_THROWHOOK, THROWING_HOOK_BODY],
]);

/** The REAL published bridge for this package. Built once — it is deterministic and 600 lines. */
const BRIDGE = wrapBridgeCombined(BODIES);

/**
 * A stand-in for a package published BEFORE P1.2, built by removing exactly what P1.2 added to the
 * observable surface: the SIM_READY advertisement and the two dispatch lines.
 *
 * Synthesised rather than checked in, because the alternative — a frozen copy of the old template
 * — would stop being a stored package's bytes the moment anything else in the wrapper changed, and
 * would then be testing a bridge no one ever published either. Each replacement asserts that it
 * matched, so a renamed handler makes this fail loudly instead of silently re-testing today's
 * bridge under the name "legacy".
 */
function legacyBridge(): string {
  const cuts: [string, string][] = [
    [", policy: ['ui', 'automation']", ''],
    ["    if (type === 'uiPolicy')     _onUiPolicy(d);\n", ''],
    ["    if (type === 'autoPolicy')   _onAutoPolicy(d);\n", ''],
  ];
  let out = BRIDGE;
  for (const [from, to] of cuts) {
    expect(out.includes(from), `the P1.2 surface "${from.trim()}" is not in the generated bridge`).toBe(true);
    out = out.split(from).join(to);
  }
  return out;
}

// ── the harness ───────────────────────────────────────────────────────────────────────────────

interface Posted { type: string; [k: string]: unknown }

interface FakeElement {
  id: string;
  tagName: string;
  textContent: string;
  remove(): void;
}

/**
 * Run a bridge in a VM with a clock the test advances by hand.
 *
 * Time is fake because every wait here is a STATE the bridge is supposed to reach, never a
 * duration it is supposed to take: a real timer would turn "the demo is still ticking" into a race
 * whose failure mode is a flake rather than a diagnosis.
 */
function makeBridgeHarness(source: string = BRIDGE) {
  const posted: Posted[] = [];
  const winListeners: ((e: { data: unknown; source?: unknown }) => void)[] = [];

  // ── clock ──
  let now = 0;
  let timerSeq = 0;
  interface Timer { fn: (...a: unknown[]) => void; args: unknown[]; due: number; every: number | null }
  const timers = new Map<number, Timer>();
  const schedule = (fn: (...a: unknown[]) => void, ms: number, args: unknown[], every: number | null): number => {
    const id = ++timerSeq;
    timers.set(id, { fn, args, due: now + ms, every });
    return id;
  };
  function advance(ms: number): void {
    const target = now + ms;
    // Bounded, so a self-rescheduling timer cannot hang the suite instead of failing it.
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
  }

  // ── frames ──
  // Ids start far above the timer ids: `clearTimeout(id)` and `clearInterval(id)` share one list
  // per the HTML spec (and the bridge relies on that), so a colliding rAF id would kill a timer.
  let rafSeq = 1_000_000;
  let rafQueue: { id: number; cb: (t: number) => void }[] = [];
  const requestFrame = (cb: (t: number) => void): number => {
    const id = ++rafSeq;
    rafQueue.push({ id, cb });
    return id;
  };
  function pump(frames = 1): void {
    for (let i = 0; i < frames; i++) {
      const batch = rafQueue;
      rafQueue = [];
      for (const r of batch) r.cb(now);
    }
  }

  // ── document ──
  const byId: Record<string, FakeElement> = {};
  const makeElement = (tagName: string): FakeElement => {
    const el: FakeElement = {
      id: '', tagName, textContent: '',
      remove(): void { if (el.id && byId[el.id] === el) delete byId[el.id]; },
    };
    return el;
  };
  const head = makeElement('head');
  const doc = {
    readyState: 'complete',
    head: { ...head, appendChild(child: FakeElement) { if (child.id) byId[child.id] = child; } },
    documentElement: head,
    getElementById: (id: string): FakeElement | null => byId[id] ?? null,
    createElement: (tag: string): FakeElement => makeElement(tag),
    addEventListener(): void { /* pointerdown — nothing in this file dispatches one */ },
  };

  const ctx: Record<string, unknown> = {
    console, Object, JSON, String, Math, Date, Array, URLSearchParams,
    document: doc,
    location: { search: '', hash: '', href: 'https://sim.test/index.html' },
    parent: { postMessage: (m: Posted) => { posted.push(m); } },
    setTimeout: (fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => schedule(fn, ms ?? 0, args, null),
    setInterval: (fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => schedule(fn, ms ?? 0, args, ms ?? 0),
    clearTimeout: (id: number) => { timers.delete(id); },
    clearInterval: (id: number) => { timers.delete(id); },
    requestAnimationFrame: requestFrame,
    cancelAnimationFrame: (id: number) => { rafQueue = rafQueue.filter((r) => r.id !== id); },
    addEventListener(type: string, fn: (e: { data: unknown }) => void) { if (type === 'message') winListeners.push(fn); },
    removeEventListener() { /* nothing under test removes one */ },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(source, ctx as vm.Context, { filename: 'bridge.js' });
  // SIM_READY is scheduled on a frame; nothing else in the bridge needs one at boot.
  pump();

  /**
   * Deliver a parent→child message. STRUCTURED CLONE, exactly as `postMessage` does: without it
   * the bridge would hold a reference to the test's own params object, and its deliberate in-place
   * mutation of `_lastParams` would reach back out and rewrite the test's fixture.
   */
  const send = (msg: Record<string, unknown>): void => {
    const data = structuredClone(msg);
    // `source` is what a real parent post carries, and the bridge now requires it: a message whose
    // source is not this document's parent is ignored (simulation-004).
    for (const l of [...winListeners]) l({ data, source: ctx.parent });
  };

  const state = (): Record<string, unknown> => (ctx[STATE_GLOBAL] as Record<string, unknown>) ?? {};
  const posts = (type: string): Posted[] => posted.filter((p) => p.type === type);
  const lastPost = (type: string): Posted | undefined => [...posted].reverse().find((p) => p.type === type);
  /** The live `style#__simHideUi` text, or null when no mechanical hide is installed. */
  const hideRules = (): string | null => byId.__simHideUi?.textContent ?? null;

  return { ctx, posted, posts, lastPost, send, advance, pump, state, hideRules };
}

type Harness = ReturnType<typeof makeBridgeHarness>;

/** Start a section and let its acknowledgement frame land. */
function start(
  h: Harness,
  script: string,
  params: Record<string, unknown> = { simpleUi: false, autoScript: true },
  token = 1,
): void {
  h.send({ type: 'startScript', script, params, token });
  h.pump();
}

/** Boot a package and run one section, with the demo already under way. */
function boot(
  script = SEC_HOOKED,
  params: Record<string, unknown> = { simpleUi: false, autoScript: true },
  source: string = BRIDGE,
): Harness {
  const h = makeBridgeHarness(source);
  start(h, script, params);
  h.advance(200);
  return h;
}

/** A snapshot of everything a re-run of the body would disturb. */
const evidence = (h: Harness) => {
  const s = h.state();
  return { runs: s.runs as number, cleanups: s.cleanups as number, t: s.t as number, interactive: s.interactive };
};

// ══ 1. SIM_READY ADVERTISES THE CAPABILITY ════════════════════════════════════════════════════

describe('the published bridge advertises what it can hot-swap', () => {
  it("SIM_READY carries policy: ['ui','automation'] alongside the dispatch classification", () => {
    const h = makeBridgeHarness();
    const ready = h.lastPost('SIM_READY')!;
    expect(ready, 'the bridge never fired SIM_READY').toBeDefined();
    expect(ready.dispatch).toBe('dynamic');
    expect(ready.policy).toEqual(['ui', 'automation']);
    expect(ready.sections).toEqual([SEC_HOOKED, SEC_BARE, SEC_NOCLEANUP, SEC_LATEDEMO, SEC_THROWHOOK]);
  });

  it('the PING_SIM_READY re-fire carries the advertisement too', () => {
    // ONE payload builder for both fires. A bare re-fire without `policy` would make a player that
    // missed the first handshake permanently fall back to restarting for every toggle — the
    // pre-P1.2 behaviour, arriving as a silent downgrade rather than as a failure.
    const h = makeBridgeHarness();
    h.send({ type: 'PING_SIM_READY' });
    const refires = h.posts('SIM_READY');
    expect(refires.length).toBe(2);
    expect(refires[1].policy).toEqual(['ui', 'automation']);
  });

  it('a package published BEFORE the handlers advertises nothing at all', () => {
    // Absence is the answer, and it must be absence — not `policy: []`, which a player could not
    // tell from a package that answered and declined.
    const h = makeBridgeHarness(legacyBridge());
    const ready = h.lastPost('SIM_READY')!;
    expect(Object.prototype.hasOwnProperty.call(ready, 'policy')).toBe(false);
    expect(ready.dispatch, 'the legacy stand-in must still be a dynamic bridge').toBe('dynamic');
  });
});

// ══ 2. THE HEADLINE PROPERTY: A UI POLICY DOES NOT RE-RUN THE BODY ════════════════════════════

describe('a UI policy changes the chrome and nothing else', () => {
  it('does not re-run the body, does not run its cleanup, and does not reset the demo', () => {
    const h = boot(SEC_HOOKED);
    // Something the USER did, living in the body's closure. A re-run destroys it even if the
    // integrator were somehow re-derived, which is what makes it the strongest of the four.
    (h.state() as { interactive: unknown }).interactive = 'user dragged the mass slider';
    const before = evidence(h);
    expect(before.runs, 'the body must have run exactly once').toBe(1);
    expect(before.t, 'the demo never advanced, so continuity here is untestable').toBeGreaterThan(0);

    h.send({ type: 'uiPolicy', simpleUi: true, hideSelectors: ['.controls'], token: 1 });

    const after = evidence(h);
    expect(after.runs, 'the section body was re-executed for a chrome change').toBe(1);
    expect(after.cleanups, "the body's cleanup ran for a chrome change").toBe(0);
    expect(after.t, 'the integrator was reset — the trajectory was thrown away').toBe(before.t);
    expect(after.interactive, 'the user\'s own state was destroyed by a chrome change')
      .toBe('user dragged the mass slider');

    // …and the demo is still LIVE, not merely un-reset: the handles survived, so time moves on.
    h.advance(200);
    expect(h.state().t as number).toBeGreaterThan(before.t);

    // No lifecycle traffic either. A second SCRIPT_APPLIED is what a restart would produce.
    expect(h.posts('SCRIPT_APPLIED')).toHaveLength(1);
    expect(h.posts('SCRIPT_ERROR')).toHaveLength(0);
  });

  it('installs, narrows and removes the mechanical hide style', () => {
    const h = boot(SEC_HOOKED);
    expect(h.hideRules(), 'nothing is hidden before a policy asks for it').toBeNull();

    h.send({ type: 'uiPolicy', simpleUi: true, hideSelectors: ['.controls', '#legend'], token: 1 });
    expect(h.hideRules()).toBe('.controls{display:none !important}\n#legend{display:none !important}');

    h.send({ type: 'uiPolicy', simpleUi: true, hideSelectors: ['#legend'], token: 1 });
    expect(h.hideRules(), 'a narrowed selection must narrow the style').toBe('#legend{display:none !important}');

    // Minimal UI off is the UN-hide, and it must take the style away rather than empty it: an
    // empty <style> left behind is indistinguishable from a hide that silently stopped working.
    h.send({ type: 'uiPolicy', simpleUi: false, hideSelectors: ['#legend'], token: 1 });
    expect(h.hideRules()).toBeNull();
    expect(evidence(h).runs, 'un-hiding restarted the section').toBe(1);
  });

  it('refuses to smuggle markup through a selector, exactly as the startScript path does', () => {
    // The hot-swap path must not be a hole in a guard the cold path enforces.
    const h = boot(SEC_HOOKED);
    h.send({
      type: 'uiPolicy', token: 1, simpleUi: true,
      hideSelectors: ['.ok', '.bad{}', '</style><script>', '.tail\\', '#panel > button'],
    });
    expect(h.hideRules()).toBe('.ok{display:none !important}\n#panel > button{display:none !important}');
  });

  it('calls the body hook when the body registered one and reports bodyHook honestly when not', () => {
    const hooked = boot(SEC_HOOKED);
    hooked.send({ type: 'uiPolicy', simpleUi: true, hideSelectors: ['.a'], token: 1 });
    expect(hooked.state().uiCalls).toEqual([{ simpleUi: true, hideSelectors: ['.a'] }]);
    expect(hooked.lastPost('POLICY_RESULT')).toMatchObject({
      kind: 'ui', applied: true, changed: true, bodyHook: true, requiresRestart: false, token: 1,
    });

    const bare = boot(SEC_BARE);
    bare.send({ type: 'uiPolicy', simpleUi: true, hideSelectors: ['.a'], token: 1 });
    // bodyHook:false is NOT a failure and must NOT provoke a restart — the mechanical hide really
    // did move. It is reported so a section whose own hiding did not follow is visible in the
    // field instead of being diagnosed from a screenshot.
    expect(bare.lastPost('POLICY_RESULT')).toMatchObject({
      kind: 'ui', applied: true, changed: true, bodyHook: false, requiresRestart: false,
    });
    expect(bare.hideRules(), 'the mechanical hide must still apply without a body hook')
      .toBe('.a{display:none !important}');
    expect(evidence(bare).runs, 'a body with no hook was restarted instead').toBe(1);
  });

  it('a THROWING body hook is reported and still leaves the section running', () => {
    // The hook is section-author code reached from a system path. If it could wedge the bridge,
    // one bad section would take the toggle away from the whole package.
    const h = boot(SEC_THROWHOOK);
    h.send({ type: 'uiPolicy', simpleUi: true, hideSelectors: ['.a'], token: 1 });

    expect(h.lastPost('SCRIPT_ERROR')).toMatchObject({ phase: 'uiPolicy', message: 'hook exploded' });
    // The mechanical hide landed BEFORE the hook ran, and the acknowledgement is still an APPLY:
    // the chrome really did change, and only the body's own re-apply is in doubt.
    expect(h.hideRules()).toBe('.a{display:none !important}');
    expect(h.lastPost('POLICY_RESULT')).toMatchObject({ kind: 'ui', applied: true, changed: true, bodyHook: false });
    // Still dispatching afterwards — the throw did not leave the listener in a broken state — and
    // the section is still running, which is the part a wedged bridge would have cost.
    h.send({ type: 'uiPolicy', simpleUi: false, token: 1 });
    expect(h.hideRules()).toBeNull();
    expect(evidence(h).runs).toBe(1);
    expect(evidence(h).cleanups).toBe(0);
  });

  it('a body that returns NO cleanup can still be policed', () => {
    // REGRESSION. `_policyStale` originally keyed "is a section installed" on `_cancelFn`, which is
    // the body's cleanup FUNCTION — and a body is free to return nothing. Every policy for such a
    // section answered `stale-activation`, which carries requiresRestart:false, so the player
    // neither applied the toggle nor restarted: the checkbox moved and nothing happened, with no
    // error anywhere. Strictly worse than the restart this finding removed, because that worked.
    const h = boot(SEC_NOCLEANUP);
    h.send({ type: 'uiPolicy', simpleUi: true, hideSelectors: ['.a'], token: 1 });
    expect(h.lastPost('POLICY_RESULT')).toMatchObject({ kind: 'ui', applied: true, changed: true });
    expect(h.hideRules()).toBe('.a{display:none !important}');
    expect(evidence(h).runs).toBe(1);
  });
});

// ══ 3. IDEMPOTENCE, AND THE SIGNATURE THAT MUST FOLLOW THE POLICY ═════════════════════════════

describe('an identical policy is a no-op, and the activation signature keeps up', () => {
  it('a re-post of the same SET is changed:false and does not call the body hook again', () => {
    const h = boot(SEC_HOOKED);
    h.send({ type: 'uiPolicy', simpleUi: true, hideSelectors: ['.a', '.b'], token: 1 });
    // The same set, re-ordered, with a duplicate. Treating it as a change would re-invoke the body
    // hook on every keystroke of a picker that happens to reorder its output.
    h.send({ type: 'uiPolicy', simpleUi: true, hideSelectors: ['.b', '.a', '.a'], token: 1 });

    expect(h.posts('POLICY_RESULT').map((p) => p.changed)).toEqual([true, false]);
    expect(h.state().uiCalls).toHaveLength(1);
    expect(h.lastPost('POLICY_RESULT')).toMatchObject({ applied: true, changed: false });
  });

  it('REGRESSION: a startScript re-post of the POLICIED params is recognised as a no-op', () => {
    // THE DEFECT A FROZEN SIGNATURE WOULD REINTRODUCE, AND THE MOST LIKELY WAY TO LOSE P1.2.
    // `_lastSig` is the bridge's "this is already installed" check. A policy changes params
    // WITHOUT restarting, so a signature captured at startScript time would then describe a state
    // the document is no longer in — and the very next full activation carrying the new params
    // (a save, a remount, an editor re-render) would miss the early return and restart the
    // section. The reset would come back, one step later and much harder to attribute.
    const h = boot(SEC_HOOKED, { simpleUi: false, autoScript: true });
    h.send({ type: 'uiPolicy', simpleUi: true, hideSelectors: ['.a'], token: 1 });
    const before = evidence(h);

    h.send({
      type: 'startScript', script: SEC_HOOKED, token: 1,
      params: { simpleUi: true, autoScript: true, hideSelectors: ['.a'] },
    });
    h.pump();

    expect(evidence(h).runs, 'the body was re-run for params the section is ALREADY running with').toBe(1);
    expect(evidence(h).cleanups).toBe(0);
    expect(evidence(h).t).toBe(before.t);
    expect(h.posts('SCRIPT_APPLIED'), 'a no-op re-post acknowledged as a new activation').toHaveLength(1);
  });

  it('…and the automation policy keeps the signature in step the same way', () => {
    const h = boot(SEC_HOOKED, { simpleUi: false, autoScript: true });
    h.send({ type: 'autoPolicy', autoScript: false, token: 1 });
    h.send({
      type: 'startScript', script: SEC_HOOKED, token: 1,
      params: { simpleUi: false, autoScript: false },
    });
    h.pump();
    expect(evidence(h).runs, 'the body was re-run for the automation state it is already in').toBe(1);
  });

  it('a startScript with GENUINELY different params still restarts — the boundary of the saving', () => {
    // The counterweight. Without it, "the body was not re-run" could be a property of the harness.
    const h = boot(SEC_HOOKED);
    const before = evidence(h);
    h.send({
      type: 'startScript', script: SEC_HOOKED, token: 2,
      params: { simpleUi: false, autoScript: true, quality: 'low' },
    });
    h.pump();
    expect(evidence(h).runs, 'a structural change must re-run the body').toBe(2);
    expect(evidence(h).cleanups, 'the previous body must be torn down first').toBe(1);
    expect(evidence(h).t, 'a new activation starts the trajectory over').toBe(0);
    expect(before.t).toBeGreaterThan(0);
    expect(h.posts('SCRIPT_APPLIED')).toHaveLength(2);
  });
});

// ══ 4. AUTOMATION: A PAUSE THAT NOW HAS AN INVERSE ════════════════════════════════════════════

describe('an automation policy stops and restarts the demo without touching the body', () => {
  it('off then on: the demo stops, the body is untouched, and the trajectory continues', () => {
    const h = boot(SEC_HOOKED);
    const running = evidence(h).t;
    expect(running).toBeGreaterThan(0);

    h.send({ type: 'autoPolicy', autoScript: false, token: 1 });
    expect(h.lastPost('POLICY_RESULT')).toMatchObject({
      kind: 'automation', applied: true, changed: true, stopped: 1, requiresRestart: false,
    });

    h.advance(400);
    const paused = evidence(h).t;
    expect(paused, 'the demo kept firing while "paused"').toBe(running);

    h.send({ type: 'autoPolicy', autoScript: true, token: 1 });
    expect(h.lastPost('POLICY_RESULT')).toMatchObject({
      kind: 'automation', applied: true, changed: true, restarted: 1, unrestorable: 0,
    });

    // THE POINT: the resume did not go through the body. `t` continues from where it stopped
    // instead of restarting at zero, and the body still ran exactly once.
    expect(evidence(h).runs, 'resuming automation re-ran the body').toBe(1);
    expect(evidence(h).cleanups).toBe(0);
    expect(evidence(h).t, 'the resume reset the trajectory').toBe(paused);
    h.advance(200);
    expect(evidence(h).t).toBeGreaterThan(paused);
  });

  it('REGRESSION: pauseScript — which had NO inverse before P1.2 — is undone by a policy', () => {
    // `pauseScript` is what a user interaction sends ("stop fighting me while I drag this"). Before
    // the respawn records the only way back to a running demonstration was re-running the body, so
    // touching a control cost the state the user had just built up.
    const h = boot(SEC_HOOKED);
    const running = evidence(h).t;
    h.send({ type: 'pauseScript' });
    expect(h.lastPost('AUTO_PAUSED')).toBeDefined();
    h.advance(400);
    expect(evidence(h).t, 'pauseScript did not stop the demo').toBe(running);

    h.send({ type: 'autoPolicy', autoScript: true, token: 1 });
    expect(h.lastPost('POLICY_RESULT')).toMatchObject({ kind: 'automation', applied: true, restarted: 1 });
    expect(evidence(h).runs, 'the resume after a pauseScript re-ran the body').toBe(1);
    h.advance(200);
    expect(evidence(h).t, 'the demo did not restart').toBeGreaterThan(running);
  });

  it('an idempotent re-post stops nothing and changes nothing', () => {
    const h = boot(SEC_HOOKED);
    h.send({ type: 'autoPolicy', autoScript: true, token: 1 });
    expect(h.lastPost('POLICY_RESULT')).toMatchObject({ kind: 'automation', applied: true, changed: false });
    const before = evidence(h).t;
    h.advance(200);
    expect(evidence(h).t, 'a no-op automation policy stopped the demo').toBeGreaterThan(before);
  });

  it('turning automation ON for a body STARTED with it off is refused as never-started', () => {
    // The body registered nothing, so there is nothing to resume and no honest way to fake one.
    // Only a restart can give this section a demonstration, and only the player may pay for it.
    const h = boot(SEC_HOOKED, { simpleUi: false, autoScript: false });
    expect(h.state().autoAtStart).toBe(false);

    h.send({ type: 'autoPolicy', autoScript: true, token: 1 });
    expect(h.lastPost('POLICY_RESULT')).toMatchObject({
      kind: 'automation', applied: false, changed: false, reason: 'never-started', requiresRestart: true,
    });
    expect(evidence(h).runs, 'the bridge restarted the body on its own initiative').toBe(1);
  });

  it('a handle that cannot be recreated is refused as unrestorable, never reported as resumed', () => {
    // The demo handle here was created after the body returned, so `_trackTimers` never recorded
    // (fn, delay) for it. It can be STOPPED and not restarted. Acknowledging a resume would report
    // a running demonstration that is in fact dead — the failure mode that is worse than an error,
    // because the screenshot looks fine and the numbers are frozen.
    const h = boot(SEC_LATEDEMO);
    expect(evidence(h).t, 'the late demo never started, so this proves nothing').toBeGreaterThan(0);

    h.send({ type: 'autoPolicy', autoScript: false, token: 1 });
    expect(h.lastPost('POLICY_RESULT')).toMatchObject({ kind: 'automation', applied: true, stopped: 1 });
    const paused = evidence(h).t;
    h.advance(400);
    expect(evidence(h).t).toBe(paused);

    h.send({ type: 'autoPolicy', autoScript: true, token: 1 });
    expect(h.lastPost('POLICY_RESULT')).toMatchObject({
      kind: 'automation', applied: false, reason: 'unrestorable', unrestorable: 1, requiresRestart: true,
    });
    // The refusal must be TRUE: nothing restarted behind it.
    h.advance(400);
    expect(evidence(h).t, 'the "unrestorable" handle came back anyway').toBe(paused);
    expect(evidence(h).runs, 'the bridge restarted the body instead of refusing').toBe(1);
  });

  it('stopScript forgets every respawn record — a resume can never resurrect a dead body', () => {
    // The specs point at callbacks closed over the OLD body's state. Retaining them across a
    // teardown would let a later resume run the previous section's demo inside the new one.
    const h = boot(SEC_HOOKED);
    h.send({ type: 'autoPolicy', autoScript: false, token: 1 });
    h.send({ type: 'stopScript' });
    expect(evidence(h).cleanups).toBe(1);

    start(h, SEC_HOOKED, { simpleUi: false, autoScript: true }, 2);
    h.advance(200);
    const fresh = evidence(h);
    expect(fresh.runs).toBe(2);

    h.send({ type: 'autoPolicy', autoScript: false, token: 2 });
    h.send({ type: 'autoPolicy', autoScript: true, token: 2 });
    // Exactly ONE handle came back: the new body's. The old body's saved spec is gone.
    expect(h.lastPost('POLICY_RESULT')).toMatchObject({ kind: 'automation', restarted: 1 });
    const resumed = evidence(h).t;
    h.advance(100);
    // One interval at 40ms ⇒ 2 ticks in 100ms. Two live intervals would show 4.
    expect(evidence(h).t as number - resumed, 'a second demo loop is running').toBeLessThanOrEqual(3);
  });
});

// ══ 5. ACTIVATION SCOPE ═══════════════════════════════════════════════════════════════════════

describe('a policy is scoped to the activation it names', () => {
  it('a policy carrying a SUPERSEDED token is refused, and asks for no restart', () => {
    const h = boot(SEC_HOOKED);
    h.send({ type: 'uiPolicy', simpleUi: true, hideSelectors: ['.a'], token: 1 });
    expect(h.hideRules()).toBe('.a{display:none !important}');

    h.send({ type: 'uiPolicy', simpleUi: true, hideSelectors: ['.b'], token: 999 });
    expect(h.hideRules(), 'a stale policy reached the live section').toBe('.a{display:none !important}');
    expect(h.lastPost('POLICY_RESULT')).toMatchObject({
      kind: 'ui', applied: false, reason: 'stale-activation',
      // requiresRestart FALSE, uniquely. The policy describes an activation that is already gone;
      // restarting for it would tear down the section that superseded it — the wrong-activation
      // defect the identity checks exist to prevent, arriving through the recovery path.
      requiresRestart: false, token: 999,
    });
  });

  it('a stale AUTOMATION policy neither stops nor starts anything', () => {
    const h = boot(SEC_HOOKED);
    h.send({ type: 'autoPolicy', autoScript: false, token: 999 });
    expect(h.lastPost('POLICY_RESULT')).toMatchObject({
      kind: 'automation', applied: false, reason: 'stale-activation', requiresRestart: false,
    });
    const before = evidence(h).t;
    h.advance(200);
    expect(evidence(h).t, 'a stale policy paused the live section').toBeGreaterThan(before);
  });

  it('a policy that arrives with NOTHING installed is refused without asking for a restart', () => {
    // Before any startScript, and after a stopScript. There is no activation to police and no
    // activation to restart, so `requiresRestart: true` would ask the player to re-run a section
    // it has deliberately torn down.
    const cold = makeBridgeHarness();
    cold.send({ type: 'uiPolicy', simpleUi: true, hideSelectors: ['.a'], token: 1 });
    expect(cold.lastPost('POLICY_RESULT')).toMatchObject({
      applied: false, reason: 'stale-activation', requiresRestart: false,
    });
    expect(cold.hideRules()).toBeNull();

    const stopped = boot(SEC_HOOKED);
    stopped.send({ type: 'stopScript' });
    stopped.send({ type: 'autoPolicy', autoScript: false, token: 1 });
    expect(stopped.lastPost('POLICY_RESULT')).toMatchObject({
      applied: false, reason: 'stale-activation', requiresRestart: false,
    });
  });

  it('a policy with NO token is accepted — old players mint none, and silence is not staleness', () => {
    // The token is optional on the wire (a v2.0 player never sent one). Refusing an untokened
    // policy would make the whole path unreachable for those players while looking like a bug.
    const h = boot(SEC_HOOKED);
    h.send({ type: 'uiPolicy', simpleUi: true, hideSelectors: ['.a'] });
    expect(h.lastPost('POLICY_RESULT')).toMatchObject({ kind: 'ui', applied: true, changed: true });
    expect(h.hideRules()).toBe('.a{display:none !important}');
  });

  it('the policy applies to the section that is running NOW, not the one it was minted for', () => {
    // A second activation re-keys the token; the first activation's policy is then refused, and
    // the new section's chrome is untouched by it.
    const h = boot(SEC_HOOKED);
    h.send({ type: 'uiPolicy', simpleUi: true, hideSelectors: ['.first'], token: 1 });
    start(h, SEC_BARE, { simpleUi: false, autoScript: true }, 2);
    expect(h.hideRules(), 'the new activation inherited the old section\'s hides').toBeNull();

    h.send({ type: 'uiPolicy', simpleUi: true, hideSelectors: ['.first'], token: 1 });
    expect(h.lastPost('POLICY_RESULT')).toMatchObject({ applied: false, reason: 'stale-activation' });
    expect(h.hideRules()).toBeNull();

    h.send({ type: 'uiPolicy', simpleUi: true, hideSelectors: ['.second'], token: 2 });
    expect(h.hideRules()).toBe('.second{display:none !important}');
  });
});

// ══ 6. AN OLD PUBLISHED PACKAGE ═══════════════════════════════════════════════════════════════

describe('a bridge without the handlers still works, and takes the restart path', () => {
  it('ignores a policy message entirely — no answer, no change, no error', () => {
    // The honest shape of "unsupported" on the wire is SILENCE. That is precisely why the player
    // must feature-detect from SIM_READY rather than send-and-hope: a policy sent to this bridge
    // would leave the user's toggle with no effect at all and nothing to report.
    const h = boot(SEC_HOOKED, { simpleUi: false, autoScript: true }, legacyBridge());
    const before = evidence(h);
    h.send({ type: 'uiPolicy', simpleUi: true, hideSelectors: ['.a'], token: 1 });
    h.send({ type: 'autoPolicy', autoScript: false, token: 1 });

    expect(h.posts('POLICY_RESULT'), 'the legacy stand-in answered a policy').toHaveLength(0);
    expect(h.hideRules(), 'the legacy stand-in applied a hide it has no handler for').toBeNull();
    expect(evidence(h).runs).toBe(before.runs);
    h.advance(200);
    expect(evidence(h).t, 'the legacy stand-in paused a demo it has no handler for')
      .toBeGreaterThan(before.t);
  });

  it('…and the RESTART path still delivers the same presentation change', () => {
    // The fallback has to actually work, or "we restart instead" would be a euphemism. The cost is
    // visible in the same evidence: the body re-runs and the trajectory starts over.
    const h = boot(SEC_HOOKED, { simpleUi: false, autoScript: true }, legacyBridge());
    expect(evidence(h).t).toBeGreaterThan(0);

    h.send({
      type: 'startScript', script: SEC_HOOKED, token: 2,
      params: { simpleUi: true, autoScript: true, hideSelectors: ['.a'] },
    });
    h.pump();

    expect(h.hideRules(), 'the restart did not apply the new hide set').toBe('.a{display:none !important}');
    expect(evidence(h).runs, 'the restart did not re-run the body').toBe(2);
    expect(evidence(h).cleanups, 'the restart skipped the teardown').toBe(1);
    expect(evidence(h).t, 'THE COST: a restart resets the simulation').toBe(0);
  });
});

// ══ 7. THE HANDLERS ARE SYSTEM-OWNED ══════════════════════════════════════════════════════════

// The author's original two-string call iterated the HTML *character by character* (a string is
// iterable), matched nothing, and produced an EMPTY manifest — these tests have always run against
// one. Passing the map the signature asks for makes the canvas real without changing any verdict.
const MANIFEST: SimManifest = buildManifest(new Map([['sim.html', '<html><body><canvas id="c"></canvas></body></html>']]));

describe('validateGeneratedBridge treats the policy handlers as system-owned', () => {
  it('the real generated bridge passes', () => {
    const result = validateGeneratedBridge(BRIDGE, MANIFEST, 'return function cleanup() {};');
    expect(result.fatal).toEqual([]);
  });

  it('a dynamic bridge that LOST the handlers is fatal, not a warning', () => {
    // Fatal because the degradation is invisible: such a bridge still WORKS, by restarting the
    // section on every toggle — which is exactly the behaviour P1.2 removed. A regression that
    // looks identical to correct behaviour is the kind that ships.
    for (const handler of ["type === 'uiPolicy'", "type === 'autoPolicy'"]) {
      const stripped = BRIDGE.split(handler).join("type === '__gone__'");
      expect(stripped, `"${handler}" is not in the generated bridge`).not.toBe(BRIDGE);
      const result = validateGeneratedBridge(stripped, MANIFEST, 'return function cleanup() {};');
      expect(result.fatal.join(' | ')).toContain(handler.includes('ui') ? 'uiPolicy' : 'autoPolicy');
    }
  });

  it('the NON-dynamic single-body template is not held to a requirement it cannot meet', () => {
    // `wrapBridgeMainBody` is load-time-locked: it cannot switch sections in place either, and no
    // publication path produces it today. Demanding hot-swappable chrome from it would fail every
    // validation for a capability it was never built to have.
    const single = wrapBridgeMainBody('return function cleanup() {};');
    expect(single.includes("dispatch: 'dynamic'"), 'the single-body template became dynamic').toBe(false);
    const result = validateGeneratedBridge(single, MANIFEST, 'return function cleanup() {};');
    expect(result.fatal.filter((f) => /Policy/i.test(f))).toEqual([]);
  });
});
