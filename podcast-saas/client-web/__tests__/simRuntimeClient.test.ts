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
  fromChild(win, { type: 'SIM_READY', v: 2 });
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
    fromChild(win, { type: 'SIM_READY', v: 2 });   // dynamic, but it will never acknowledge
    fromChild(win, { type: 'SIM_PAINTED' });
    c.activate({ script: 'A' });
    c.activate({ script: 'B' });
    expect(c.getState().ackCapable).toBeNull();
    expect(c.getState().visible, 'waiting on a bridge that cannot answer makes it undisplayable').toBe(true);
  });

  it('a non-dynamic (navigating) bridge never uses the in-place gate', () => {
    const c = new SimRuntimeClient();
    const { el, win } = makeFrame();
    c.attach(el, 'doc-v1');
    fromChild(win, { type: 'SIM_READY', v: 1 });
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
    fromChild(first.win, { type: 'SIM_READY', v: 2 });   // stale source
    expect(c.getState().ready, 'events must be scoped to the bound document').toBe(false);
    fromChild(second.win, { type: 'SIM_READY', v: 2 });
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
    fromChild(first.win, { type: 'SIM_READY', v: 2 });
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
    fromChild(win, { type: 'SIM_READY', v: 2 });
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
    fromChild(win, { type: 'SIM_READY', v: 2 });
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
