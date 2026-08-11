/**
 * Adversarial tests for SimRuntimeClient — the shared simulation lifecycle.
 *
 * These drive the real class against a fake iframe/window, so every rule that used to live in
 * four different components is now pinned once. The scenarios are the ones that actually broke in
 * production audits: a reveal before the acknowledgement, a teardown during the fade, a stale ack
 * from a superseded activation, a timer firing into a newly navigated document, a retained frame
 * coming back muted.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SimRuntimeClient, type SimRuntimeState } from '../lib/sim/SimRuntimeClient';
import { SIM_APPLY_STALL_MS, SIM_EXIT_STOP_MS } from '../lib/sim/protocol';

// ── fake document plumbing ────────────────────────────────────────────────────────────────
interface Sent { type: string; [k: string]: unknown }

let listeners: ((e: MessageEvent) => void)[] = [];
let sent: Sent[] = [];

/** A stand-in for the cross-origin iframe: records what the parent posted to it. */
function makeFrame(): { el: HTMLIFrameElement; win: object } {
  const win = { postMessage: (msg: Sent) => { sent.push(msg); } };
  const el = { contentWindow: win } as unknown as HTMLIFrameElement;
  return { el, win };
}

/** Deliver a child→parent message as if it came from `win`. */
function fromChild(win: object, data: unknown): void {
  const ev = { source: win, data } as unknown as MessageEvent;
  for (const l of [...listeners]) l(ev);
}

const typesSent = (): string[] => sent.map((s) => s.type);
const lastOf = (type: string): Sent | undefined => [...sent].reverse().find((s) => s.type === type);

beforeEach(() => {
  vi.useFakeTimers();
  listeners = [];
  sent = [];
  vi.stubGlobal('window', {
    addEventListener: (t: string, fn: (e: MessageEvent) => void) => { if (t === 'message') listeners.push(fn); },
    removeEventListener: (t: string, fn: (e: MessageEvent) => void) => {
      if (t === 'message') listeners = listeners.filter((l) => l !== fn);
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Bring a client to a modern, painted, acknowledged document running `firstScript`. */
function bootModern(firstScript = 'A'): { c: SimRuntimeClient; win: object; states: SimRuntimeState[] } {
  const states: SimRuntimeState[] = [];
  const c = new SimRuntimeClient({ onState: (s) => states.push(s) });
  const { el, win } = makeFrame();
  c.attach(el, 'doc-1');
  fromChild(win, { type: 'SIM_READY', dispatch: 'dynamic' });
  fromChild(win, { type: 'SIM_PAINTED' });
  c.activate({ script: firstScript });
  // First activation reveals immediately (nothing to switch away from), and the ack that follows
  // is what teaches the client this document is ack-capable.
  fromChild(win, { type: 'SCRIPT_APPLIED', script: firstScript, token: c.getState().activationToken });
  return { c, win, states };
}

describe('first activation and same-section re-entry', () => {
  it('reveals immediately on the first activation — there is nothing to switch away from', () => {
    const { c } = bootModern('A');
    expect(c.getState().visible).toBe(true);
    expect(c.getState().ackCapable).toBe(true);
  });

  it('re-entering the SAME section reveals immediately (already applied — no flicker)', () => {
    const { c } = bootModern('A');
    c.hide();
    c.activate({ script: 'A' });
    expect(c.getState().visible).toBe(true);
    expect(c.getState().phase).not.toBe('awaiting-ack');
  });
});

describe('same-package section switch — the reveal must wait for its acknowledgement', () => {
  it('A → B holds the reveal until SCRIPT_APPLIED for B', () => {
    const { c, win } = bootModern('A');
    c.activate({ script: 'B' });
    expect(c.getState().phase).toBe('awaiting-ack');
    expect(c.getState().visible, 'B must not be presented over A’s frozen frame').toBe(false);

    fromChild(win, { type: 'SCRIPT_APPLIED', script: 'B', token: c.getState().activationToken });
    expect(c.getState().visible).toBe(true);
    expect(c.getState().currentScript).toBe('B');
  });

  it('A → B → A: a STALE ack from the first A can never release the live activation', () => {
    const { c, win } = bootModern('A');
    const tokenA1 = c.getState().activationToken;

    c.activate({ script: 'B' });
    c.activate({ script: 'A' });                       // superseded B before it acked
    const tokenA2 = c.getState().activationToken;
    expect(tokenA2).toBeGreaterThan(tokenA1);
    expect(c.getState().visible).toBe(false);

    // The old A's ack arrives late. Same script name, different token — it must be ignored.
    fromChild(win, { type: 'SCRIPT_APPLIED', script: 'A', token: tokenA1 });
    expect(c.getState().visible, 'a stale ack released the hold').toBe(false);

    fromChild(win, { type: 'SCRIPT_APPLIED', script: 'A', token: tokenA2 });
    expect(c.getState().visible).toBe(true);
  });

  it('the wait is TERMINAL — a bridge that never acks still releases at the bound', () => {
    const { c } = bootModern('A');
    c.activate({ script: 'B' });
    expect(c.getState().visible).toBe(false);
    vi.advanceTimersByTime(SIM_APPLY_STALL_MS + 10);
    expect(c.getState().visible, 'a wedged document must never hold the screen forever').toBe(true);
  });
});

describe('legacy documents are never made to wait on silence', () => {
  it('a document that has never acked reveals immediately on a switch', () => {
    const states: SimRuntimeState[] = [];
    const c = new SimRuntimeClient({ onState: (s) => states.push(s) });
    const { el, win } = makeFrame();
    c.attach(el, 'doc-legacy');
    fromChild(win, { type: 'SIM_READY', dispatch: 'dynamic' });   // dynamic, but it will never acknowledge
    fromChild(win, { type: 'SIM_PAINTED' });
    c.activate({ script: 'A' });
    c.activate({ script: 'B' });
    expect(c.getState().ackCapable).toBeNull();
    expect(c.getState().visible, 'waiting on a bridge that cannot answer makes it undisplayable').toBe(true);
  });

  it('a bridge that advertises NO dispatch is legacy and never uses the in-place gate', () => {
    // The real wire format: a v2 bridge sends `dispatch: 'dynamic'`; an old load-time-locked one
    // sends a bare SIM_READY. There is no version number in this protocol — classifying on one
    // (as an earlier draft of the runtime did) leaves every real document `null` and silently
    // disables the gate in production while every test still passes.
    const c = new SimRuntimeClient();
    const { el, win } = makeFrame();
    c.attach(el, 'doc-v1');
    fromChild(win, { type: 'SIM_READY' });
    fromChild(win, { type: 'SIM_PAINTED' });
    c.activate({ script: 'A' });
    c.activate({ script: 'B' });
    expect(c.getState().visible).toBe(true);
  });
});

describe('atomic exit — teardown never runs while the frame is still on screen', () => {
  it('freezes and mutes immediately, and defers stopScript past the fade', () => {
    const { c } = bootModern('A');
    sent = [];
    c.deactivate();

    expect(typesSent()).toContain('simPause');
    expect(typesSent()).toContain('simMute');
    expect(typesSent(), 'stopScript during the fade restores the hidden controls').not.toContain('stopScript');
    expect(c.getState().visible).toBe(false);

    vi.advanceTimersByTime(SIM_EXIT_STOP_MS + 10);
    expect(typesSent()).toContain('stopScript');
    expect(c.getState().stopped).toBe(true);
  });

  it('re-entry inside the fade CANCELS the deferred teardown', () => {
    const { c } = bootModern('A');
    c.deactivate();
    vi.advanceTimersByTime(SIM_EXIT_STOP_MS - 50);
    sent = [];
    c.activate({ script: 'A' });                 // back before the stop fired
    vi.advanceTimersByTime(500);
    expect(typesSent(), 'a late stop would tear down the LIVE section').not.toContain('stopScript');
    expect(c.hasDeferredStop()).toBe(false);
  });

  it('a torn-down document waits for the ack on re-entry — it is not a fresh document', () => {
    const { c } = bootModern('A');
    c.deactivate();
    vi.advanceTimersByTime(SIM_EXIT_STOP_MS + 10);
    expect(c.getState().stopped).toBe(true);

    // Its cleanup restored the full UI while the canvas still holds A's frozen frame. Revealing
    // that before the new body applies is exactly the defect the gate exists to prevent.
    c.activate({ script: 'B' });
    expect(c.getState().phase).toBe('awaiting-ack');
    expect(c.getState().visible).toBe(false);
  });

  it('exposes the deferred stop so an owner cannot evict the frame mid-fade', () => {
    const { c } = bootModern('A');
    expect(c.hasDeferredStop()).toBe(false);
    c.deactivate();
    expect(c.hasDeferredStop(), 'the planner needs this to protect a fading frame').toBe(true);
    vi.advanceTimersByTime(SIM_EXIT_STOP_MS + 10);
    expect(c.hasDeferredStop()).toBe(false);
  });
});

describe('missing section, script error, throwing cleanup', () => {
  it('SCRIPT_MISSING releases the hold and hides — never shows another section’s body', () => {
    const { c, win } = bootModern('A');
    c.activate({ script: 'nope' });
    expect(c.getState().visible).toBe(false);
    fromChild(win, { type: 'SCRIPT_MISSING', script: 'nope', token: c.getState().activationToken });
    expect(c.getState().visible, 'degrade to the underlying content').toBe(false);
    expect(c.getState().lastError).toContain('nope');
  });

  it('SCRIPT_ERROR marks the document failed and hides it', () => {
    const { c, win } = bootModern('A');
    c.activate({ script: 'B' });
    fromChild(win, { type: 'SCRIPT_ERROR', message: 'boom', token: c.getState().activationToken });
    expect(c.getState().phase).toBe('failed');
    expect(c.getState().visible).toBe(false);
  });

  it('a document that errored can still be driven again (never permanently wedged)', () => {
    const { c, win } = bootModern('A');
    c.activate({ script: 'B' });
    fromChild(win, { type: 'SCRIPT_ERROR', message: 'boom', token: c.getState().activationToken });
    c.activate({ script: 'A' });
    fromChild(win, { type: 'SCRIPT_APPLIED', script: 'A', token: c.getState().activationToken });
    expect(c.getState().visible).toBe(true);
  });
});

describe('late and out-of-order events', () => {
  it('a late SIM_PAINTED does NOT reveal a frame that is still awaiting its ack', () => {
    const { c, win } = bootModern('A');
    c.activate({ script: 'B' });
    fromChild(win, { type: 'SIM_PAINTED' });      // the OLD section repainting
    expect(c.getState().visible, 'paint is per-document, not per-section').toBe(false);
  });

  it('a late SIM_READY from a previous document cannot drive the new one', () => {
    const c = new SimRuntimeClient();
    const first = makeFrame();
    c.attach(first.el, 'doc-1');
    const second = makeFrame();
    c.attach(second.el, 'doc-2');
    fromChild(first.win, { type: 'SIM_READY', dispatch: 'dynamic' });   // stale source
    expect(c.getState().ready, 'events must be scoped to the bound document').toBe(false);
    fromChild(second.win, { type: 'SIM_READY', dispatch: 'dynamic' });
    expect(c.getState().ready).toBe(true);
  });

  it('a native frame load resets readiness, so a stale paint latch cannot early-exit a poll', () => {
    const { c } = bootModern('A');
    expect(c.getState().painted).toBe(true);
    c.handleFrameLoad();
    expect(c.getState().painted).toBe(false);
    expect(c.getState().ready).toBe(false);
    expect(c.getState().currentScript).toBeNull();
  });
});

describe('rapid enter/exit and navigation races', () => {
  it('a deferred stop from a PREVIOUS document never fires into a newly navigated one', () => {
    const c = new SimRuntimeClient();
    const first = makeFrame();
    c.attach(first.el, 'doc-1');
    fromChild(first.win, { type: 'SIM_READY', dispatch: 'dynamic' });
    fromChild(first.win, { type: 'SIM_PAINTED' });
    c.activate({ script: 'A' });
    c.deactivate();                                 // arms the deferred stop

    const second = makeFrame();
    c.attach(second.el, 'doc-2');                   // navigate before it fires
    sent = [];
    vi.advanceTimersByTime(SIM_EXIT_STOP_MS + 50);
    expect(typesSent(), 'the stop must not reach the new document').not.toContain('stopScript');
  });

  it('the apply-stall timer of a superseded activation does not reveal the new one early', () => {
    const { c } = bootModern('A');
    c.activate({ script: 'B' });
    vi.advanceTimersByTime(SIM_APPLY_STALL_MS - 20);
    c.activate({ script: 'C' });                    // supersedes B, arms its own timer
    vi.advanceTimersByTime(30);                     // B's original deadline passes
    expect(c.getState().visible, 'B’s timer released C early').toBe(false);
    vi.advanceTimersByTime(SIM_APPLY_STALL_MS);
    expect(c.getState().visible).toBe(true);        // C's own terminal bound
  });
});

describe('audio and accessibility of hidden frames', () => {
  it('exit mutes, and every activation unmutes (a retained frame must not come back silent)', () => {
    const { c } = bootModern('A');
    c.deactivate();
    expect(c.getState().muted).toBe(true);
    sent = [];
    c.activate({ script: 'A' });
    expect(typesSent(), 'the mute is LATCHED by the gate until an explicit unmute').toContain('simUnmute');
    expect(c.getState().muted).toBe(false);
  });

  it('a hidden frame is never interactive', () => {
    const { c } = bootModern('A');
    expect(c.getState().interactive).toBe(true);
    c.hide();
    expect(c.getState().interactive).toBe(false);
    c.suspend();
    expect(c.getState().interactive).toBe(false);
    expect(c.getState().muted).toBe(true);
  });
});

describe('automation', () => {
  it('pauseAutomation stops the demo WITHOUT tearing the section down', () => {
    const { c } = bootModern('A');
    sent = [];
    c.pauseAutomation();
    expect(typesSent()).toEqual(['pauseScript']);
    expect(c.getState().currentScript, 'the section must stay applied').toBe('A');
    expect(c.getState().visible).toBe(true);
  });

  it('a userInteraction message reaches the owner', () => {
    const onUserInteraction = vi.fn();
    const c = new SimRuntimeClient({ onUserInteraction });
    const { el, win } = makeFrame();
    c.attach(el, 'doc-1');
    fromChild(win, { type: 'userInteraction' });
    expect(onUserInteraction).toHaveBeenCalledOnce();
  });
});

describe('disposal', () => {
  it('dispose removes the listener and makes every pending timer inert', () => {
    const { c, win } = bootModern('A');
    c.activate({ script: 'B' });
    c.deactivate();
    sent = [];
    c.dispose();

    expect(listeners.length, 'the window listener must be removed').toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(sent, 'no timer may fire after disposal').toEqual([]);
    fromChild(win, { type: 'SCRIPT_APPLIED', script: 'B', token: 99 });
    expect(c.getState().phase).toBe('disposed');
  });

  it('dispose is idempotent', () => {
    const { c } = bootModern('A');
    c.dispose();
    expect(() => c.dispose()).not.toThrow();
  });

  it('detaching (element null) cancels pending work without disposing the client', () => {
    const { c } = bootModern('A');
    c.deactivate();
    c.attach(null, null);
    sent = [];
    vi.advanceTimersByTime(10_000);
    expect(sent).toEqual([]);
    expect(c.getState().phase).toBe('unmounted');
  });
});

describe('paint recovery for packages that can never ack a paint', () => {
  it('polls, then force-reveals at the bounded ceiling', () => {
    const c = new SimRuntimeClient();
    const { el, win } = makeFrame();
    c.attach(el, 'doc-noraf');
    fromChild(win, { type: 'SIM_READY', dispatch: 'dynamic' });
    c.activate({ script: 'A' });
    c.startPaintRecovery({ legacyCeilingMs: 800 });
    expect(c.getState().visible).toBe(false);

    vi.advanceTimersByTime(350);
    expect(typesSent()).toContain('PING_SIM_PAINTED');

    vi.advanceTimersByTime(500);
    expect(c.getState().visible, 'a sim that never drives rAF must still be displayable').toBe(true);
  });

  it('a real paint cancels the ceiling and the poll', () => {
    const c = new SimRuntimeClient();
    const { el, win } = makeFrame();
    c.attach(el, 'doc-1');
    fromChild(win, { type: 'SIM_READY', dispatch: 'dynamic' });
    c.activate({ script: 'A' });
    c.startPaintRecovery({ legacyCeilingMs: 800 });
    fromChild(win, { type: 'SIM_PAINTED' });
    expect(c.getState().visible).toBe(true);
    sent = [];
    vi.advanceTimersByTime(5_000);
    expect(typesSent(), 'the poll must stop once painted').not.toContain('PING_SIM_PAINTED');
  });
});

describe('activation message ordering (the child depends on it)', () => {
  it('sends resume → startScript → clearBootHide → relayout → unmute, in that order', () => {
    const { c } = bootModern('A');
    sent = [];
    c.activate({ script: 'B', params: { simpleUi: true, hideSelectors: ['.panel'] } });
    const order = typesSent();
    expect(order.indexOf('simResume')).toBeLessThan(order.indexOf('startScript'));
    // clearBootHide must follow startScript: its __simHideUi set is the definitive one.
    expect(order.indexOf('startScript')).toBeLessThan(order.indexOf('clearBootHide'));
    expect(order).toContain('simRelayout');
    expect(order).toContain('simUnmute');
    const start = lastOf('startScript')!;
    expect(start.script).toBe('B');
    expect((start.params as { simpleUi?: boolean }).simpleUi).toBe(true);
    expect(typeof start.token).toBe('number');
  });
});

describe('capability classification uses the REAL wire format', () => {
  it("classifies dispatch:'dynamic' as in-place capable", () => {
    const c = new SimRuntimeClient();
    const { el, win } = makeFrame();
    c.attach(el, 'doc-1');
    fromChild(win, { type: 'SIM_READY', dispatch: 'dynamic', sections: ['A', 'B'] });
    expect(c.getState().dynamic).toBe(true);
  });

  it('classifies a bare SIM_READY as legacy', () => {
    const c = new SimRuntimeClient();
    const { el, win } = makeFrame();
    c.attach(el, 'doc-1');
    fromChild(win, { type: 'SIM_READY' });
    expect(c.getState().dynamic).toBeNull();
  });

  it('a re-fire without dispatch never DOWNGRADES a proven dynamic document', () => {
    // PING_SIM_READY is answered with the same builder, but a partial re-post must not demote a
    // frame that already proved it dispatches in place — that would drop it to the no-wait path.
    const c = new SimRuntimeClient();
    const { el, win } = makeFrame();
    c.attach(el, 'doc-1');
    fromChild(win, { type: 'SIM_READY', dispatch: 'dynamic' });
    fromChild(win, { type: 'SIM_READY' });
    expect(c.getState().dynamic).toBe(true);
  });
});

describe("the bridge's cleanup error must not kill the incoming activation", () => {
  // startScript runs stopScript FIRST, so a section whose cleanup throws emits a SCRIPT_ERROR
  // with no token and no script IN THE MIDDLE of every switch away from it. That error describes
  // the OUTGOING section. Treating it as the live activation's failure dropped the pending apply,
  // after which the real SCRIPT_APPLIED was rejected as stale — the incoming section ran correctly
  // and was never shown. Reproduced on WebKit; the other engines' timing hid it.
  it('an unscoped cleanup error is ignored and the switch still completes', () => {
    const { c, win } = bootModern('A');
    c.activate({ script: 'B' });
    expect(c.getState().phase).toBe('awaiting-ack');

    fromChild(win, { type: 'SCRIPT_ERROR', phase: 'cleanup', message: 'fixture cleanup exploded' });
    expect(c.getState().phase, 'the cleanup error failed the document').not.toBe('failed');

    fromChild(win, { type: 'SCRIPT_APPLIED', script: 'B', token: c.getState().activationToken });
    expect(c.getState().visible, 'B applied but was never presented').toBe(true);
    expect(c.getState().currentScript).toBe('B');
  });

  it('a TOKENED start error for the live activation still fails the document', () => {
    const { c, win } = bootModern('A');
    c.activate({ script: 'B' });
    fromChild(win, {
      type: 'SCRIPT_ERROR', phase: 'start', script: 'B',
      token: c.getState().activationToken, message: 'body threw',
    });
    expect(c.getState().phase).toBe('failed');
    expect(c.getState().visible).toBe(false);
  });
});

describe('painted has ONE owner — a policy paint must grant visibility', () => {
  // The viewer used to keep its own "treat as painted" latch for packages whose gate cannot ack a
  // paint. The runtime never learned of it, so once the viewer's reveal became gated on the
  // runtime's grant, such a package was permanently invisible on re-entry: no spinner, and no
  // timer left armed to release it. This pins the single-owner contract.
  it('markPaintedByPolicy makes a never-painting document presentable', () => {
    const c = new SimRuntimeClient();
    const { el, win } = makeFrame();
    c.attach(el, 'doc-nopaint');
    fromChild(win, { type: 'SIM_READY' });        // legacy: will never emit SIM_PAINTED
    c.activate({ script: 'A' });
    expect(c.getState().visible, 'nothing has painted yet').toBe(false);

    c.markPaintedByPolicy('bounded-hold');
    expect(c.getState().painted).toBe(true);
    expect(c.getState().visible, 'a policy paint must grant visibility').toBe(true);
  });

  it('re-entering a policy-painted document still reveals', () => {
    const c = new SimRuntimeClient();
    const { el, win } = makeFrame();
    c.attach(el, 'doc-nopaint');
    fromChild(win, { type: 'SIM_READY' });
    c.activate({ script: 'A' });
    c.markPaintedByPolicy('bounded-hold');
    c.deactivate();
    vi.advanceTimersByTime(SIM_EXIT_STOP_MS + 10);

    c.activate({ script: 'A' });                  // the re-entry that used to deadlock
    expect(c.getState().visible, 'the document was permanently invisible on re-entry').toBe(true);
  });

  it('a policy paint does NOT release a gated switch', () => {
    const { c } = bootModern('A');                // proven-modern, ack-capable
    c.activate({ script: 'B' });
    expect(c.getState().phase).toBe('awaiting-ack');
    c.markPaintedByPolicy('bounded-hold');
    expect(c.getState().visible, 'a policy paint must never bypass the apply gate').toBe(false);
  });
});

describe('the paint-recovery ceiling must never bypass a live apply hold', () => {
  // Proven by execution in review: a dynamic, ack-capable, unpainted document with a pending
  // gated switch was force-revealed by the 800ms legacy ceiling — presented before its
  // acknowledgement and before the terminal bound. The ceiling now defers to the hold; only the
  // hold's own terminal bound (which clears the pending apply as it fires) may force through.
  it('a held switch is NOT revealed at the ceiling', () => {
    const { c, win } = bootModern('A');       // proven dynamic + ackCapable
    c.handleFrameLoad();                       // fresh document: unpainted
    fromChild(win, { type: 'SIM_READY', dispatch: 'dynamic' });
    c.activate({ script: 'A' });
    fromChild(win, { type: 'SCRIPT_APPLIED', script: 'A', token: c.getState().activationToken });
    c.activate({ script: 'B' });               // gated switch — hold armed
    expect(c.getState().phase).toBe('awaiting-ack');

    c.startPaintRecovery({ legacyCeilingMs: 120 });
    vi.advanceTimersByTime(200);               // ceiling fires…
    expect(c.getState().visible, 'the ceiling revealed a held switch').toBe(false);

    vi.advanceTimersByTime(SIM_APPLY_STALL_MS);   // …the hold's own terminal bound releases
    expect(c.getState().visible, 'the terminal bound must still release the hold').toBe(true);
  });
});

// ── Transition instrumentation on the v2 path ────────────────────────────────────────────────────
//
// WHY THIS SUITE EXISTS: a mutation deleting these three lines from `activate()` —
//
//     rollTransition(); mark('requested'); mark('prepare-sent');
//
// SURVIVED the entire matrix. Nothing asserted the instrumentation, so the measurement layer could
// be silently deleted. That is not hypothetical for this exact code: the marks originally existed
// only on the v3 modern path, which no stored package uses, so in the FIELD the layer produced
// nothing at all and a perf run reported zero transitions while the viewer was plainly performing
// them. These lines are the fix for that, and this pins them.
//
// The observable is the real production one: `computeDurations` published through the `reveal`
// telemetry callback, plus the public `timingSummary()`. `dispatchMs` is
// `diff(requested -> prepare-sent)`, so a finite non-negative value proves BOTH marks exist AND
// that they are ordered; `totalMs` proves the transition was not abandoned.
describe('transition instrumentation — the v2 activation path is measured', () => {
  function bootWithTelemetry() {
    const tel: Array<{ event: string; detail: Record<string, unknown> }> = [];
    const c = new SimRuntimeClient({
      onState: () => {},
      onTelemetry: (event: string, detail?: Record<string, unknown>) => {
        tel.push({ event, detail: detail ?? {} });
      },
    });
    const { el, win } = makeFrame();
    c.attach(el, 'doc-marks');
    fromChild(win, { type: 'SIM_READY', dispatch: 'dynamic' });
    fromChild(win, { type: 'SIM_PAINTED' });
    return { c, win, tel };
  }

  const applyAck = (c: SimRuntimeClient, win: object, script: string) =>
    fromChild(win, { type: 'SCRIPT_APPLIED', script, token: c.getState().activationToken });

  it('stamps requested and prepare-sent, in order, with finite non-negative timestamps', () => {
    const { c, win, tel } = bootWithTelemetry();
    c.activate({ script: 'A' });
    applyAck(c, win, 'A');

    const reveals = tel.filter((t) => t.event === 'reveal')
      .map((t) => t.detail as Record<string, number | null>);
    expect(reveals.length, 'no reveal telemetry at all — nothing was measured').toBeGreaterThan(0);

    // Several reveal paths roll an already-closed transition and legitimately publish nulls. The
    // contract is that the ACTIVATION's own transition produced a measured dispatch — exactly one
    // reveal carries it, and with the marks deleted NONE would.
    const measured = reveals.filter((d) => typeof d.dispatchMs === 'number');
    expect(measured.length, 'no reveal carried a dispatch measurement — requested and/or prepare-sent is missing')
      .toBeGreaterThan(0);
    for (const d of measured) {
      // requested -> prepare-sent. `diff` returns null when either mark is absent or out of order,
      // so a number here proves both exist AND that requested precedes prepare-sent.
      expect(Number.isFinite(d.dispatchMs as number)).toBe(true);
      expect(d.dispatchMs as number, 'prepare-sent was stamped BEFORE requested').toBeGreaterThanOrEqual(0);
      // requested -> revealed. Null would mean the transition had no start.
      expect(typeof d.totalMs, 'totalMs is null — the transition has no requested mark').toBe('number');
      expect(d.totalMs as number).toBeGreaterThanOrEqual(0);
    }
  });

  it('produces a COMPLETE transition in the summary, not an abandoned or empty one', () => {
    const { c, win } = bootWithTelemetry();
    c.activate({ script: 'A' });
    applyAck(c, win, 'A');

    const s = c.timingSummary();
    expect(s.samples, 'no transition was rolled into the history at all').toBeGreaterThanOrEqual(1);
    // `isComplete` requires BOTH `requested` and `revealed`, so this is 0 without the marks.
    expect(s.completed, 'the activation produced no COMPLETE transition').toBe(1);
    expect(s.p50TotalMs, 'a completed transition produced no total').not.toBeNull();
    expect(Number.isFinite(s.p50TotalMs as number)).toBe(true);
  });

  // REGRESSION: reveal() is not idempotent and runs for non-transition reasons (first paint, poll,
  // owner nudge). Stamping presented/revealed unconditionally manufactured history entries with no
  // `requested`: never complete, so no percentile moved, but counted in `samples` and tallied into
  // `abandonedAt.revealed` — the field that answers "where do transitions die".
  it('does NOT manufacture a transition from a reveal that no activation opened', () => {
    const { c } = bootWithTelemetry();          // boots + paints, so reveal() runs with no activate()
    const s = c.timingSummary();
    expect(s.samples, 'a reveal with no activation was recorded as a transition').toBe(0);
    expect(s.abandonedAt.revealed ?? 0, 'phantom transitions inflated abandonedAt.revealed').toBe(0);
  });

  it('still measures a real activation after such a reveal', () => {
    const { c, win } = bootWithTelemetry();
    c.activate({ script: 'A' });
    applyAck(c, win, 'A');
    const s = c.timingSummary();
    expect(s.samples).toBe(1);
    expect(s.completed).toBe(1);
  });

  it('ROLLS a separate transition per activation instead of merging them', () => {
    const { c, win } = bootWithTelemetry();
    c.activate({ script: 'A' });
    applyAck(c, win, 'A');
    expect(c.timingSummary().completed).toBe(1);

    c.activate({ script: 'B' });
    applyAck(c, win, 'B');
    // Without rollTransition the second activation's marks land on the first transition, whose
    // `requested` is already stamped (first write wins) — one merged sample, not two.
    expect(c.timingSummary().completed, 'the two activations did not produce two complete transitions').toBe(2);
  });
});

// ══ SECTION POLICY ON THE v2 PATH (audit P1.2) ═══════════════════════════════════════════════
//
// `setPolicy` exists so that hiding a control does not restart the section. What it must NEVER do
// is fail QUIETLY: a policy the package cannot take has to end in a re-activation the caller can
// see, because a toggle that silently does nothing is strictly worse than the restart this finding
// set out to avoid — the restart at least worked.
//
// WHAT THIS BLOCK DOES AND DOES NOT PROVE. The client's job is the DECISION: send, don't send, or
// restart. That everything downstream of "send" leaves the body alone is a property of the bridge,
// and it is proven by executing the emitted bytes in
// backend-api/src/services/simulation/__tests__/simPolicyBridge.test.ts. Here the frame is a
// recorder, so "no startScript was posted" is exactly as strong as "the section was not restarted"
// and no stronger.

interface Tel { event: string; detail: Record<string, unknown> }

/** Boot a v2 document, optionally advertising the policy families it can hot-swap. */
function bootPolicy(opts: { policy?: string[]; script?: string } = {}): {
  c: SimRuntimeClient; win: object; tel: Tel[];
} {
  const tel: Tel[] = [];
  const c = new SimRuntimeClient({
    onTelemetry: (event, detail) => tel.push({ event, detail: (detail ?? {}) as Record<string, unknown> }),
  });
  const { el, win } = makeFrame();
  c.attach(el, 'doc-policy');
  // The wire shape of an advertising bridge. `policy` ABSENT is what every package published
  // before P1.2 sends, and the client must read that silence as "no support".
  fromChild(win, { type: 'SIM_READY', dispatch: 'dynamic', ...(opts.policy ? { policy: opts.policy } : {}) });
  fromChild(win, { type: 'SIM_PAINTED' });
  c.activate({ script: opts.script ?? 'A', params: { simpleUi: false, autoScript: true } });
  fromChild(win, { type: 'SCRIPT_APPLIED', script: opts.script ?? 'A', token: c.getState().activationToken });
  sent = [];
  return { c, win, tel };
}

const BOTH = ['ui', 'automation'];
const events = (tel: Tel[]): string[] => tel.map((t) => t.event);
const lastTel = (tel: Tel[], event: string): Record<string, unknown> | undefined =>
  [...tel].reverse().find((t) => t.event === event)?.detail;

describe('setPolicy — a supported package is policed, never restarted', () => {
  it('sends ONE uiPolicy carrying the live activation token, and no startScript', () => {
    const { c } = bootPolicy({ policy: BOTH });
    const token = c.getState().activationToken;

    expect(c.setPolicy({ simpleUi: true, hideSelectors: ['.controls'] })).toBe('policy');

    expect(typesSent(), 'a policy fell through to a re-activation').not.toContain('startScript');
    expect(typesSent().filter((t) => t === 'uiPolicy')).toHaveLength(1);
    expect(lastOf('uiPolicy')).toEqual({
      type: 'uiPolicy', simpleUi: true, hideSelectors: ['.controls'], token,
    });
  });

  it('sends only the family that MOVED — a UI change posts no automation message', () => {
    const { c } = bootPolicy({ policy: BOTH });
    expect(c.setPolicy({ simpleUi: true })).toBe('policy');
    expect(typesSent()).toEqual(['uiPolicy']);

    sent = [];
    expect(c.setPolicy({ autoScript: false })).toBe('policy');
    expect(typesSent()).toEqual(['autoPolicy']);
    expect(lastOf('autoPolicy')).toMatchObject({ autoScript: false });
  });

  it('a change on BOTH axes posts both messages, in one call', () => {
    const { c } = bootPolicy({ policy: BOTH });
    expect(c.setPolicy({ simpleUi: true, autoScript: false })).toBe('policy');
    expect(typesSent()).toEqual(['uiPolicy', 'autoPolicy']);
  });

  it('normalises the hide set on the wire — the bridge is never asked to dedupe', () => {
    const { c } = bootPolicy({ policy: BOTH });
    c.setPolicy({ simpleUi: true, hideSelectors: ['.b', '.a', '.b'] });
    expect(lastOf('uiPolicy')!.hideSelectors).toEqual(['.a', '.b']);
  });

  it('reports the outcome as telemetry, so the policy path is observable in the field', () => {
    const { c, tel } = bootPolicy({ policy: BOTH });
    c.setPolicy({ simpleUi: true });
    expect(events(tel)).toContain('policy-sent');
    expect(lastTel(tel, 'policy-sent')).toMatchObject({ ui: true, automation: false, modern: false });
  });
});

describe('setPolicy — an unsupported package is re-activated, and says so', () => {
  it('a package that advertised nothing returns "reactivated" and restarts instead', () => {
    // THE HONEST FALLBACK. Not `false`, not `'policy'`: the caller is told the toggle took effect
    // AND that it cost a restart. A boolean cannot express the difference, which is the whole
    // reason SimPolicyOutcome is not one.
    const { c } = bootPolicy();               // bare SIM_READY — every stored package
    expect(c.getState().policies, 'silence must read as "no support", never as "unknown"').toEqual([]);

    expect(c.setPolicy({ simpleUi: true, hideSelectors: ['.controls'] })).toBe('reactivated');

    expect(typesSent(), 'a policy message was sent to a package that cannot take it')
      .not.toContain('uiPolicy');
    expect(typesSent()).toContain('startScript');
    // The restart carries the NEW policy, or the toggle would have been lost entirely.
    expect(lastOf('startScript')).toMatchObject({
      script: 'A', params: { simpleUi: true, autoScript: true, hideSelectors: ['.controls'] },
    });
  });

  it('names the missing families and the reason — a silent fallback is indistinguishable from a bug', () => {
    const { c, tel } = bootPolicy();
    c.setPolicy({ simpleUi: true });
    expect(events(tel)).toContain('policy-unsupported');
    expect(lastTel(tel, 'policy-unsupported')).toMatchObject({ missing: ['ui'], advertised: [] });
    expect(events(tel)).toContain('policy-fallback-restart');
    expect(lastTel(tel, 'policy-fallback-restart')).toMatchObject({ reason: 'unsupported', script: 'A' });
  });

  it('PARTIAL support: the advertised family is policed, the unadvertised one restarts', () => {
    const { c } = bootPolicy({ policy: ['ui'] });
    expect(c.setPolicy({ simpleUi: true })).toBe('policy');
    expect(typesSent()).toEqual(['uiPolicy']);

    sent = [];
    expect(c.setPolicy({ autoScript: false })).toBe('reactivated');
    expect(typesSent()).toContain('startScript');
  });

  it('a MIXED change with one family missing restarts ONCE and sends no half-policy', () => {
    // Sending the deliverable half and restarting for the other would apply the UI change twice
    // and make the restart's params disagree with what the package was just told.
    const { c, tel } = bootPolicy({ policy: ['ui'] });
    expect(c.setPolicy({ simpleUi: true, autoScript: false })).toBe('reactivated');
    expect(typesSent(), 'half the policy was delivered before the restart').not.toContain('uiPolicy');
    expect(typesSent().filter((t) => t === 'startScript')).toHaveLength(1);
    expect(lastTel(tel, 'policy-unsupported')).toMatchObject({ missing: ['automation'], advertised: ['ui'] });
  });

  it('an unknown family name in the advertisement is discarded, not trusted', () => {
    const { c } = bootPolicy({ policy: ['ui', 'telepathy'] });
    expect(c.getState().policies).toEqual(['ui']);
    expect(c.setPolicy({ autoScript: false })).toBe('reactivated');
  });

  it('a PING_SIM_READY re-fire without `policy` does not un-prove a proven document', () => {
    // Same never-downgrade rule as `dispatch`. A partial re-post is a re-post, not a retraction —
    // and treating it as one would silently return the document to restarting for every toggle.
    const { c, win } = bootPolicy({ policy: BOTH });
    fromChild(win, { type: 'SIM_READY' });
    expect(c.getState().policies).toEqual(BOTH);
    expect(c.setPolicy({ simpleUi: true })).toBe('policy');
  });
});

describe('setPolicy — idempotence and activation identity', () => {
  it('an identical re-post is "unchanged" and sends nothing at all', () => {
    const { c } = bootPolicy({ policy: BOTH });
    c.setPolicy({ simpleUi: true, hideSelectors: ['.a'] });
    sent = [];
    expect(c.setPolicy({ simpleUi: true, hideSelectors: ['.a'] })).toBe('unchanged');
    expect(sent, 'an unchanged policy still cost a message').toEqual([]);
  });

  it('a RE-ORDERED or duplicated hide set is not a change', () => {
    const { c } = bootPolicy({ policy: BOTH });
    c.setPolicy({ simpleUi: true, hideSelectors: ['.a', '.b'] });
    sent = [];
    expect(c.setPolicy({ simpleUi: true, hideSelectors: ['.b', '.a', '.a'] })).toBe('unchanged');
    expect(sent).toEqual([]);
  });

  it('null and [] are the same LIVE policy — a toggle must not re-post forever', () => {
    // They differ only on the restart path, where the body sees the value (see simPolicy.ts).
    const { c } = bootPolicy({ policy: BOTH });
    expect(c.setPolicy({ simpleUi: true, hideSelectors: [] })).toBe('policy');
    sent = [];
    expect(c.setPolicy({ simpleUi: true, hideSelectors: null })).toBe('unchanged');
    expect(sent).toEqual([]);
  });

  it('a PATCH leaves the fields it omits alone', () => {
    const { c } = bootPolicy({ policy: BOTH });
    c.setPolicy({ autoScript: false });
    expect(c.getLivePolicy()).toEqual({ simpleUi: false, hideSelectors: null, autoScript: false });
    c.setPolicy({ simpleUi: true });
    expect(c.getLivePolicy(), 'a UI patch cleared the automation policy')
      .toEqual({ simpleUi: true, hideSelectors: null, autoScript: false });
  });

  it('getLivePolicy hands out a COPY — the live policy cannot be edited through it', () => {
    const { c } = bootPolicy({ policy: BOTH });
    const snapshot = c.getLivePolicy()!;
    snapshot.simpleUi = true;
    expect(c.getLivePolicy()!.simpleUi).toBe(false);
  });

  it('the policy is scoped to the CURRENT activation, and re-based by the next one', () => {
    const { c, win } = bootPolicy({ policy: BOTH });
    c.setPolicy({ simpleUi: true });
    expect(c.getLivePolicy()!.simpleUi).toBe(true);

    // A different section, activated with its own params. The live policy is that section's, not
    // a carry-over: a policy applied to A must not silently describe B.
    c.activate({ script: 'B', params: { simpleUi: false, autoScript: false } });
    fromChild(win, { type: 'SCRIPT_APPLIED', script: 'B', token: c.getState().activationToken });
    expect(c.getLivePolicy()).toEqual({ simpleUi: false, hideSelectors: null, autoScript: false });

    sent = [];
    const tokenB = c.getState().activationToken;
    expect(c.setPolicy({ simpleUi: true })).toBe('policy');
    expect(lastOf('uiPolicy')!.token, 'the policy carried the superseded activation\'s token').toBe(tokenB);
  });

  it('there is nothing to police before an activation, after stopNow, or on a new document', () => {
    const c1 = new SimRuntimeClient();
    const f1 = makeFrame();
    c1.attach(f1.el, 'doc-cold');
    fromChild(f1.win, { type: 'SIM_READY', dispatch: 'dynamic', policy: BOTH });
    expect(c1.setPolicy({ simpleUi: true }), 'policed a document with no section running')
      .toBe('no-activation');
    expect(c1.getLivePolicy()).toBeNull();

    const { c } = bootPolicy({ policy: BOTH });
    c.stopNow();
    sent = [];
    expect(c.setPolicy({ simpleUi: true })).toBe('no-activation');
    expect(sent, 'a policy was sent to a section that had been torn down').toEqual([]);

    const second = makeFrame();
    c.attach(second.el, 'doc-other');
    expect(c.setPolicy({ simpleUi: true })).toBe('no-activation');
  });
});

describe('POLICY_RESULT — what the package answers, and what the client does about it', () => {
  const result = (over: Record<string, unknown>) => ({
    type: 'POLICY_RESULT', kind: 'ui', applied: true, changed: true, reason: null,
    requiresRestart: false, ...over,
  });

  it('an APPLIED result changes nothing and is reported', () => {
    const { c, win, tel } = bootPolicy({ policy: BOTH });
    c.setPolicy({ simpleUi: true });
    sent = [];
    fromChild(win, result({ bodyHook: false, token: c.getState().activationToken }));

    expect(sent, 'an applied policy triggered a restart').toEqual([]);
    expect(lastTel(tel, 'policy-applied')).toMatchObject({ kind: 'ui', changed: true, bodyHook: false });
  });

  it('a REFUSAL that asks for a restart gets one, carrying the policy it refused', () => {
    const { c, win, tel } = bootPolicy({ policy: BOTH });
    c.setPolicy({ simpleUi: true, hideSelectors: ['.a'] });
    sent = [];
    fromChild(win, result({
      applied: false, changed: false, reason: 'never-started', kind: 'automation',
      requiresRestart: true, token: c.getState().activationToken,
    }));

    expect(lastTel(tel, 'policy-refused')).toMatchObject({ kind: 'automation', reason: 'never-started' });
    expect(lastTel(tel, 'policy-fallback-restart')).toMatchObject({ reason: 'never-started' });
    expect(typesSent()).toContain('startScript');
    expect(lastOf('startScript')).toMatchObject({
      params: { simpleUi: true, autoScript: true, hideSelectors: ['.a'] },
    });
  });

  it('a STALE-ACTIVATION refusal is reported but NOT restarted', () => {
    // `requiresRestart: false` is how a package refuses without asking to be torn down. Restarting
    // for a policy whose activation is already gone would evict the section that superseded it —
    // the wrong-activation defect arriving through the recovery path.
    const { c, win, tel } = bootPolicy({ policy: BOTH });
    c.setPolicy({ simpleUi: true });
    sent = [];
    fromChild(win, result({
      applied: false, reason: 'stale-activation', requiresRestart: false,
      token: c.getState().activationToken,
    }));

    expect(lastTel(tel, 'policy-refused')).toMatchObject({ reason: 'stale-activation' });
    expect(sent, 'a stale refusal tore down the live section').toEqual([]);
  });

  it('a result carrying a SUPERSEDED token is ignored entirely', () => {
    const { c, win, tel } = bootPolicy({ policy: BOTH });
    const stale = c.getState().activationToken;
    c.activate({ script: 'B' });
    fromChild(win, { type: 'SCRIPT_APPLIED', script: 'B', token: c.getState().activationToken });
    sent = [];

    fromChild(win, result({ applied: false, reason: 'never-started', requiresRestart: true, token: stale }));
    expect(sent, 'a refusal for a dead activation restarted the live one').toEqual([]);
    expect(events(tel)).toContain('policy-stale-result-ignored');
  });

  it('the fallback restart reproduces the hide set EXACTLY — absent stays absent', () => {
    // `paramsForPolicy` omits the key when there is no mechanical set and sends `[]` when the set
    // is empty. The body's own generated hide logic reads that difference on the restart path, so
    // collapsing the two here would change what the re-run section hides.
    const { c } = bootPolicy();                       // unsupported ⇒ every change restarts
    c.setPolicy({ simpleUi: true, hideSelectors: null });
    const omitted = lastOf('startScript')!.params as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(omitted, 'hideSelectors')).toBe(false);

    sent = [];
    c.setPolicy({ hideSelectors: ['.a'] });
    expect((lastOf('startScript')!.params as Record<string, unknown>).hideSelectors).toEqual(['.a']);

    // ['.a'] → [] is a real change (an empty set is not "no set"), so this restart must carry the
    // key. Going straight from `null` to `[]` would be `unchanged` and send nothing, which is the
    // correct answer for the LIVE policy and the reason the two cases are sequenced.
    sent = [];
    c.setPolicy({ hideSelectors: [] });
    const empty = lastOf('startScript')!.params as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(empty, 'hideSelectors')).toBe(true);
    expect(empty.hideSelectors).toEqual([]);
  });
});
