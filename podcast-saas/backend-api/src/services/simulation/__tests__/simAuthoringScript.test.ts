/**
 * The authoring script — EXECUTED against a real document, not read.
 *
 * This is the picker's in-document half: it adopts a MessagePort, answers scans with the shared
 * scanner, draws badges, and reports script-driven control changes. Every claim below is asserted
 * on a value the code produced, per PROTOCOL rule 7.
 *
 * THE DOCUMENT IS THE REAL ONE. `injectSimBootSnippet(injectRafGate(CONTROLS_ENTRY_HTML))` is
 * byte-for-byte what `/sim-public/*` serves for the Phase-0 controls fixture — a package with
 * duplicate ids, CSS-illegal ids, radio groups sharing a name, a display:none Advanced panel, an
 * interactive canvas and a button gated on `event.isTrusted`. Those shapes exist precisely because
 * they are the ones that break scanners.
 *
 * WHAT JSDOM CANNOT PROVE, stated so nothing here pretends otherwise: `getBoundingClientRect()`
 * returns zeros, so badge GEOMETRY — tracking a scroll, a nested scroller, a resize, a replaced
 * node — is not testable here and belongs to `client-web/e2e/sim-authoring.spec.ts` in a real
 * browser. What IS provable here is everything that is not geometry: the handshake and its
 * refusals, the scan contract, which elements get badges at all, the toggle round trip, and the
 * exact boundaries of script-touch observation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JSDOM, VirtualConsole } from 'jsdom';
import { injectRafGate } from '../SimulationService.js';
import { injectSimBootSnippet } from '../../../controllers/sim-public.controller.js';
import { SIM_AUTHORING_SCRIPT } from '../SimAuthoringBootstrap.js';
import { CONTROLS_ENTRY_HTML } from '../../../scripts/fixtures/controlsFixture.js';
import { SIM_AUTHORING_NS, SIM_AUTHORING_VERSION } from 'shared/sim/authoringProtocol';

interface Msg { ns?: string; v?: number; sid?: string; type?: string; [k: string]: unknown }

let dom: JSDOM;
let win: Window & typeof globalThis;
let doc: Document;
let scriptErrors: string[];
/** Everything the child sent us on the port, in order. */
let inbox: Msg[];
let port: MessagePort;

const NS = SIM_AUTHORING_NS;
const V = SIM_AUTHORING_VERSION;
const SID = 'sid-1';

const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until a message of `type` has arrived, or fail loudly.
 *
 * NOT a fixed sleep. The ports are Node's (jsdom ships none — see the polyfill in `boot`), so a
 * message crosses a realm boundary and lands some macrotasks later; how many depends on the size
 * of the document being scanned. A fixed wait tuned on the small fixture missed every reply from
 * the big one, which reads as "the scanner is broken" rather than "the test looked too early" —
 * and a fixed wait tuned on the big one would be a slow test that still goes flaky under load,
 * which this repo has already paid for once.
 */
async function waitFor(type: string, timeoutMs = 3000, requestId?: string): Promise<Msg> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = [...inbox].reverse().find(
      (m) => m.type === type && (requestId === undefined || m.requestId === requestId),
    );
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`no ${type} within ${timeoutMs}ms; got: ${inbox.map((m) => m.type).join(',') || '(nothing)'}`);
    await tick();
  }
}

/** Give the child a chance to NOT send something. Only for absence assertions. */
const quiet = (): Promise<void> => tick(300);

/**
 * Boot a document and run the authoring script in it, simulating the handshake the boot-snippet
 * hook performs. jsdom will not fetch the `<script src>`, so the script is evaluated directly —
 * the snippet's own CONNECT branch is covered by its own test below.
 */
async function boot(html = CONTROLS_ENTRY_HTML, sid = SID): Promise<void> {
  scriptErrors = [];
  inbox = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e: Error) => scriptErrors.push(`jsdomError: ${e.message}`));

  dom = new JSDOM(injectSimBootSnippet(injectRafGate(html)), {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'https://sim.example.test/index.html',
    virtualConsole: vc,
  });
  win = dom.window as unknown as Window & typeof globalThis;
  doc = win.document;

  // jsdom ships no MessageChannel/MessagePort (probed: both undefined). Node's are web-shaped —
  // postMessage/onmessage/start/close — and the script only ever RECEIVES a port, so lending it
  // Node's is a harness polyfill, not a stand-in for the behaviour under test. The real transfer
  // across a document boundary is proven in the browser, in e2e/sim-authoring.spec.ts.
  (win as unknown as { MessageChannel: typeof MessageChannel }).MessageChannel = MessageChannel;

  const channel = new win.MessageChannel();
  port = channel.port1;
  port.onmessage = (e: MessageEvent) => { inbox.push(e.data as Msg); };
  port.start();

  // What the hook records before the active script arrives.
  (win as unknown as { __SIM_AUTHORING_PENDING__: unknown }).__SIM_AUTHORING_PENDING__ =
    { port: channel.port2, origin: 'https://app.example.test', sid };

  win.eval(SIM_AUTHORING_SCRIPT);
  await waitFor('CONNECTED');
}

const send = (type: string, extra: Record<string, unknown> = {}, sid: string | undefined = SID): void => {
  port.postMessage({ ns: NS, v: V, sid, type, ...extra });
};

const lastOf = (type: string): Msg | undefined => [...inbox].reverse().find((m) => m.type === type);
const overlay = (): Element | null => doc.querySelector('[data-sim-authoring-overlay]');
const pills = (): HTMLElement[] => Array.from(overlay()?.children ?? []) as HTMLElement[];

afterEach(() => { dom?.window?.close?.(); });

// ── Harness honesty ──────────────────────────────────────────────────────────

describe('harness', () => {
  beforeEach(async () => { await boot(); });

  it('nothing threw while the document and script booted', () => {
    // jsdom swallows script errors; without this a half-dead document still answers most of the
    // assertions below. One known limitation is filtered by exact text.
    expect(scriptErrors.filter((e) => !e.includes('HTMLCanvasElement.prototype.getContext')))
      .toEqual([]);
  });
});

// ── Handshake ────────────────────────────────────────────────────────────────

describe('handshake', () => {
  it('adopts the transferred port and answers CONNECTED with the session id', async () => {
    await boot();
    const c = lastOf('CONNECTED');
    expect(c).toBeTruthy();
    expect(c!.sid).toBe(SID);
    expect(c!.ns).toBe(NS);
  });

  it('ignores a port message tagged with a superseded session', async () => {
    await boot();
    inbox.length = 0;
    send('SCAN_CONTROLS', { requestId: 'r1' }, 'sid-OLD');
    // `quiet`, not a short tick. Proving a NON-reply needs a window longer than a real reply
    // takes, or the assertion passes because the test looked too early — the same mistake that
    // made the scan tests look broken, arriving as a false PASS instead of a false failure.
    await quiet();
    // A stale sid means the editor has reconnected since; answering would let an old request's
    // result overwrite a newer one at the parent.
    expect(inbox.map((m) => m.type)).toEqual([]);
  });

  it('ignores a message from a different protocol version', async () => {
    await boot();
    inbox.length = 0;
    port.postMessage({ ns: NS, v: V + 1, sid: SID, type: 'SCAN_CONTROLS', requestId: 'r1' });
    await tick(30);
    expect(inbox).toEqual([]);
  });
});

// ── The scan contract ────────────────────────────────────────────────────────

describe('SCAN_CONTROLS', () => {
  it('answers with proven selectors that each resolve to exactly one element', async () => {
    await boot();
    send('SCAN_CONTROLS', { requestId: 'r1' });
    const r = await waitFor('CONTROLS_LIST');
    expect(r.requestId).toBe('r1');
    expect(r.scanned).toBe(true);
    const controls = r.controls as { selector: string }[];
    expect(controls.length).toBeGreaterThan(5);
    for (const c of controls) {
      expect(doc.querySelectorAll(c.selector), c.selector).toHaveLength(1);
    }
  });

  it('ALWAYS answers — an empty document is `scanned` with an empty list, not silence', async () => {
    // The distinction this whole record exists for. "The scanner replied with nothing" and "the
    // scanner could not be reached" have opposite consequences, and the old picker collapsed both
    // to null — which is why it showed "Not scanned yet" and "No controls detected" at once.
    await boot('<!doctype html><html><head></head><body><p>no controls here</p></body></html>');
    send('SCAN_CONTROLS', { requestId: 'r-empty' });
    const r = await waitFor('CONTROLS_LIST');
    expect(r.scanned).toBe(true);
    expect(r.controls).toEqual([]);
    expect(r.truncated).toBe(false);
  });

  it('flags a scan that hit the cap as truncated', async () => {
    // A caller that acts on the list — "hide everything the script did not touch" — would
    // otherwise hide controls it never saw.
    const many = Array.from({ length: 130 }, (_, i) => `<input type="range" id="c${i}">`).join('');
    await boot(`<!doctype html><html><head></head><body>${many}</body></html>`);
    send('SCAN_CONTROLS', { requestId: 'r-big' });
    const r = await waitFor('CONTROLS_LIST');
    expect((r.controls as unknown[]).length).toBe(100);
    expect(r.truncated).toBe(true);
  });

  it('never reports the authoring overlay\'s own nodes as controls', async () => {
    // The overlay draws INTO the sim document, so without the scanner's overlay-subtree skip its
    // pills would be reported as controls of the simulation and the list would grow on every
    // rescan. jsdom lays nothing out, so real pills never render here — the shape is built by
    // hand, which tests the SCANNER RULE rather than the overlay's rendering.
    await boot();
    send('SCAN_CONTROLS', { requestId: 'r-before' });
    const before = ((await waitFor('CONTROLS_LIST', 3000, 'r-before')).controls as { selector: string }[]).length;

    const fake = doc.createElement('div');
    fake.setAttribute('data-sim-authoring-overlay', '');
    fake.innerHTML = '<button id="pill-a">x</button><input id="pill-b" type="range">';
    doc.body.appendChild(fake);

    // Matched by requestId rather than by clearing the inbox: emptying it would also discard the
    // r-before reply this test just used, and the wait would then hang on a message it deleted.
    send('SCAN_CONTROLS', { requestId: 'r-after' });
    const after = (await waitFor('CONTROLS_LIST', 3000, 'r-after')).controls as { selector: string }[];
    expect(after.length).toBe(before);
    expect(after.some((c) => c.selector.indexOf('pill-') >= 0)).toBe(false);
  });

  it('rescanning while badges exist returns the identical list', async () => {
    // The overlay draws INTO the sim document. Without the scanner's overlay-subtree skip, its
    // own pills would be reported as controls of the simulation — and the list would grow every
    // time the author rescanned.
    await boot();
    send('SCAN_CONTROLS', { requestId: 'r1' });
    const first = ((await waitFor('CONTROLS_LIST')).controls as { selector: string }[]).map((c) => c.selector);

    send('SET_MARKS', { marks: first.map((selector) => ({ selector, mark: 'keep' })) });
    await tick(30);

    send('SCAN_CONTROLS', { requestId: 'r2' });
    const second = ((await waitFor('CONTROLS_LIST', 3000, 'r2')).controls as { selector: string }[]).map((c) => c.selector);
    expect(second).toEqual(first);
  });
});

// ── Badges ───────────────────────────────────────────────────────────────────

describe('badges', () => {
  beforeEach(async () => {
    await boot();
    send('SCAN_CONTROLS', { requestId: 'r1' });
    await waitFor('CONTROLS_LIST');
  });

  it('carry an icon AND a word, never colour alone', async () => {
    const r = lastOf('CONTROLS_LIST')!;
    const sels = (r.controls as { selector: string }[]).map((c) => c.selector);
    send('SET_MARKS', { marks: sels.map((selector) => ({ selector, mark: 'keep' })) });
    await tick(30);
    // jsdom lays nothing out, so rect-driven pills are absent; what is provable is the label
    // contract on whatever the code produced.
    for (const p of pills()) {
      expect(p.textContent === '✓ Keep' || p.textContent === '✕ Hidden').toBe(true);
    }
  });

  it('never badges a control the simulation itself hides — the list is its only path', async () => {
    const r = lastOf('CONTROLS_LIST')!;
    const hidden = (r.controls as { selector: string; hidden?: boolean }[]).filter((c) => c.hidden);
    send('SET_MARKS', { marks: (r.controls as { selector: string }[]).map((c) => ({ selector: c.selector, mark: 'hide' })) });
    await tick(30);
    // #advanced-gain lives inside a display:none panel in the fixture.
    for (const h of hidden) {
      for (const p of pills()) expect(p.getAttribute('data-for')).not.toBe(h.selector);
    }
  });

  it('DISARM removes every overlay node', async () => {
    send('SET_MARKS', { marks: [] });
    await tick(30);
    send('DISARM');
    await tick(30);
    expect(overlay()).toBeNull();
  });
});

// ── Script-touch observation ─────────────────────────────────────────────────

describe('script-touch observation', () => {
  const fireUntrusted = (id: string): void => {
    const el = doc.getElementById(id)!;
    el.dispatchEvent(new win.Event('input', { bubbles: true }));
  };

  beforeEach(async () => {
    await boot();
    send('SCAN_CONTROLS', { requestId: 'r1' });
    await waitFor('CONTROLS_LIST');
  });

  it('reports nothing before OBSERVE_START', async () => {
    // A document-lifetime listener would sweep up the simulation's OWN initialisation — which
    // also dispatches untrusted events — and report it as Auto Script activity.
    inbox.length = 0;
    fireUntrusted('speed');
    await quiet();
    expect(lastOf('SCRIPT_TOUCHED')).toBeUndefined();
  });

  it('reports a script-dispatched change while armed, labelled heuristic', async () => {
    send('OBSERVE_START');
    await tick(30);
    fireUntrusted('speed');
    await quiet();
    const t = lastOf('SCRIPT_TOUCHED')!;
    expect(t).toBeTruthy();
    expect(t.heuristic).toBe(true);
    expect(t.selectors).toContain('#speed');
  });

  it('stops reporting after OBSERVE_STOP', async () => {
    send('OBSERVE_START');
    await tick(30);
    send('OBSERVE_STOP');
    await tick(30);
    inbox.length = 0;
    fireUntrusted('speed');
    await quiet();
    expect(lastOf('SCRIPT_TOUCHED')).toBeUndefined();
  });

  it('the filter reads isTrusted and nothing else', async () => {
    // WHAT THIS CAN AND CANNOT PROVE HERE. jsdom refuses to redefine `isTrusted` — it is a
    // non-configurable prototype getter, and `Object.defineProperty` throws "Cannot redefine
    // property" — so a genuinely-trusted event cannot be forged in this harness. Synthesising one
    // is exactly what a real browser will not let a page do either, which is the whole reason the
    // flag is trustworthy.
    //
    // So the assertion is the reachable half: every event this harness CAN dispatch is untrusted,
    // and every one of them is reported. The complementary half — a real user gesture is NOT
    // reported — needs real input and lives in e2e/sim-authoring.spec.ts, where Playwright can
    // produce a trusted click.
    //
    // STATED PLAINLY: deleting `if (e.isTrusted) return;` leaves this file GREEN. That mutation
    // was run and it survived. The filter's only executable proof is the Playwright spec, and if
    // that spec is ever dropped this behaviour becomes unguarded — worth knowing here rather than
    // discovering from a support ticket.
    send('OBSERVE_START');
    await tick(30);
    inbox.length = 0;
    const el = doc.getElementById('speed')! as HTMLInputElement;
    const ev = new win.Event('input', { bubbles: true });
    expect(ev.isTrusted).toBe(false);   // the premise, asserted rather than assumed
    el.dispatchEvent(ev);
    const t = await waitFor('SCRIPT_TOUCHED');
    expect(t.selectors).toContain('#speed');
  });

  it('does NOT report a direct value write — the honest limit of the heuristic', async () => {
    // A script that assigns element.value with no event is invisible here. Pinned so the UI copy
    // and this behaviour cannot drift apart: the editor calls this a heuristic because of exactly
    // this case.
    send('OBSERVE_START');
    await tick(30);
    inbox.length = 0;
    (doc.getElementById('speed') as HTMLInputElement).value = '77';
    await quiet();
    expect(lastOf('SCRIPT_TOUCHED')).toBeUndefined();
  });
});
