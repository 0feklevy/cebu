/**
 * The v3 fixture package, proven ON THE EMITTED BYTES.
 *
 * WHAT IS ACTUALLY UNDER TEST HERE. The fixture's bridge is not an imitation of the child runtime —
 * `v3ManagedBridge` concatenates the real `buildChildRuntimeSource` output verbatim, install call
 * and all. So running those bytes in a VM with a fake window/document/MessagePort exercises the
 * SHIPPING runtime: the bootstrap refusals, the envelope validator, the activation identity echo
 * and the exactly-once presentation guard are all the production ones. A test that stubbed the
 * runtime would prove only that the stub agrees with itself.
 *
 * WHY A VM AND NOT A BROWSER. The browser suites (canary, protocol, leak) run the same package for
 * real, but they cannot drive the negative space: an offer from a source that is not `window.parent`,
 * a second offer after adoption, an envelope with a duplicated sequence number. Those are all
 * things a correct parent never sends, so a browser harness would have to be deliberately broken to
 * produce them. Here they are one function call.
 *
 * TIME IS FAKE AND FRAMES ARE PUMPED, on purpose. Every wait in these tests is a state the runtime
 * is supposed to reach, not a duration it is supposed to take — a real timer would turn each
 * assertion into a race whose failure mode is a flake rather than a diagnosis.
 */
import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import type { SimRuntimeCapabilities } from 'shared/sim/runtimeProtocol';
import { allowsAggressivePreparation, classifyFromCapabilities } from 'shared/sim/simFailurePolicy';
import {
  FIXTURE_SECTIONS,
  FIXTURE_V3_SECTIONS,
  V3_ALL_MANAGED_DESCRIPTOR,
  V3_ALL_MANAGED_SECTION_BODIES,
  V3_DEFER_ACK_KNOB,
  V3_DEFERRED_ACK_GLOBAL,
  V3_DOUBLE_ACK_KNOB,
  V3_MANAGED_DESCRIPTOR,
  V3_MANAGED_SECTION_BODIES,
  V3_PROTO_GLOBAL,
  V3_SLOW_PREPARE_MS,
  V3_STATE_GLOBAL,
  v3ManagedBridge,
  type V3PackageDescriptor,
} from '../gen-sim-fixture.js';
import {
  ACTIVATE_SECTION,
  DISPOSE_DOCUMENT,
  INIT_DOCUMENT,
  PAUSE_AUTOMATION,
  PREPARE_SECTION,
  PRESENT_SECTION,
  RELEASE_SECTION,
  SET_QUALITY,
  SIM_BOOTSTRAP_ACCEPT_KIND,
  SIM_BOOTSTRAP_KIND,
  SIM_PROTOCOL_NAMESPACE,
  SIM_PROTOCOL_VERSION,
  SUSPEND_DOCUMENT,
  ZERO_RESOURCE_COUNTS,
  makeEnvelope,
} from 'shared/sim/runtimeProtocol';
import {
  DEFAULT_PRESENTATION_CONFIG,
  computeConfigHash,
  type SimPresentationConfig,
} from 'shared/sim/simIdentity';

const PARENT_ORIGIN = 'https://player.test';
const PLAYER_SESSION = 'ps-fixture-1';
const PACKAGE_REVISION = 'pkgrev-fixture-1';
const DOCUMENT_ID = 'doc-fixture-1';

const CONFIG: SimPresentationConfig = { ...DEFAULT_PRESENTATION_CONFIG };
const CONFIG_HASH = computeConfigHash(CONFIG);

const A = FIXTURE_SECTIONS.A;
const { V3A, V3B, V3LEGACYBODY, V3NOPRESENT, V3SLOWPREPARE, V3THROWPREPARE } = FIXTURE_V3_SECTIONS;

/** Strip cross-realm prototypes before a deep comparison. */
function plain<T>(value: unknown): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Let the host microtask queue drain — `runMaybeAsync` resolves prepare promises there. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// ── fake transport ────────────────────────────────────────────────────────────────────────────

/**
 * A MessagePort that only moves when told to. Delivery is synchronous and `start()` is explicit,
 * which is what makes "did this envelope produce an outbound message" answerable at all — with a
 * real port the answer would always be "not yet".
 */
class FakePort {
  other: FakePort | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  closed = false;
  started = false;
  private readonly listeners: ((e: { data: unknown }) => void)[] = [];
  private readonly queue: unknown[] = [];

  postMessage(message: unknown): void {
    if (this.closed || !this.other) return;
    this.other.receive(message);
  }

  receive(message: unknown): void {
    if (this.closed) return;
    if (!this.started) { this.queue.push(message); return; }
    this.deliver(message);
  }

  addEventListener(type: string, fn: (e: { data: unknown }) => void): void {
    if (type === 'message') this.listeners.push(fn);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const pending = this.queue.splice(0, this.queue.length);
    for (const m of pending) this.deliver(m);
  }

  close(): void { this.closed = true; }

  /** Registration order, exactly as a real port: addEventListener listeners, then `onmessage`. */
  private deliver(message: unknown): void {
    for (const fn of [...this.listeners]) fn({ data: message });
    if (this.onmessage) this.onmessage({ data: message });
  }
}

function channel(): { child: FakePort; parent: FakePort } {
  const child = new FakePort();
  const parent = new FakePort();
  child.other = parent;
  parent.other = child;
  return { child, parent };
}

// ── fake DOM ──────────────────────────────────────────────────────────────────────────────────

interface FakeContext2D { fillStyle: string; fillRect(x: number, y: number, w: number, h: number): void }

interface FakeElement {
  tagName: string;
  style: Record<string, string>;
  attrs: Record<string, string>;
  width: number;
  height: number;
  textContent: string;
  fills: string[];
  id: string;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  addEventListener(type: string, fn: (e: unknown) => void): void;
  removeEventListener(type: string, fn: (e: unknown) => void): void;
  appendChild(child: unknown): void;
  remove(): void;
  getContext(kind: string): FakeContext2D | null;
  dispatch(type: string): void;
}

function makeElement(tagName: string): FakeElement {
  const listeners: { type: string; fn: (e: unknown) => void }[] = [];
  const el: FakeElement = {
    tagName,
    style: {},
    attrs: {},
    width: 320,
    height: 180,
    textContent: '',
    fills: [],
    id: '',
    setAttribute(name, value) { el.attrs[name] = value; },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(el.attrs, name) ? el.attrs[name] : null; },
    addEventListener(type, fn) { listeners.push({ type, fn }); },
    removeEventListener(type, fn) {
      const i = listeners.findIndex((l) => l.type === type && l.fn === fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    appendChild() {},
    remove() {},
    getContext(kind) {
      if (kind !== '2d') return null;
      return {
        fillStyle: '',
        fillRect(_x, _y, _w, _h) { el.fills.push(this.fillStyle); },
      };
    },
    dispatch(type) { for (const l of [...listeners]) if (l.type === type) l.fn({ type }); },
  };
  return el;
}

// ── harness ───────────────────────────────────────────────────────────────────────────────────

interface OfferOptions {
  /** Fields spliced into the offer payload — how a malformed offer is built. */
  data?: Record<string, unknown>;
  /** The MessageEvent's own origin. Defaults to PARENT_ORIGIN. */
  origin?: string;
  /** The MessageEvent's source. Defaults to the fake parent window. */
  source?: unknown;
  /** How many ports the offer carries. Defaults to 1. */
  portCount?: number;
}

interface SendOptions {
  payload?: Record<string, unknown>;
  activationId?: string;
  variantKey?: string;
  configHash?: string;
  seq?: number;
  /** Applied LAST, so a test can corrupt exactly one field of an otherwise valid envelope. */
  overrides?: Record<string, unknown>;
}

function createHarness(bodies: Record<string, string>, descriptor: V3PackageDescriptor) {
  // ── fake clock ──
  let now = 0;
  let timerSeq = 0;
  interface Timer { at: number; fn: (...args: unknown[]) => void; args: unknown[]; every: number | null }
  const timers = new Map<number, Timer>();
  const schedule = (fn: (...a: unknown[]) => void, ms: number, args: unknown[], every: number | null): number => {
    const id = ++timerSeq;
    timers.set(id, { at: now + (ms || 0), fn, args, every });
    return id;
  };

  function advance(ms: number): void {
    const target = now + ms;
    // Bounded: a 40 ms automation interval across a long advance is dozens of firings, and an
    // unbounded loop here would hang the suite rather than fail it if a timer ever rescheduled
    // itself at zero delay.
    for (let guard = 0; guard < 10_000; guard++) {
      let dueId = -1;
      let due: Timer | null = null;
      for (const [id, t] of timers) if (t.at <= target && (due === null || t.at < due.at)) { dueId = id; due = t; }
      if (!due) break;
      now = Math.max(now, due.at);
      if (due.every === null) timers.delete(dueId); else due.at = now + due.every;
      due.fn(...due.args);
    }
    now = target;
  }

  // ── fake animation frames ──
  // Ids start far above the timer ids: the scope falls back to `clearTimeout(id)` for a handle it
  // does not recognise, and an rAF id that collided with a timer id would silently kill it.
  let rafSeq = 1_000_000;
  let rafQueue: { id: number; cb: (t: number) => void }[] = [];
  const requestFrame = (cb: (t: number) => void): number => {
    const id = ++rafSeq;
    rafQueue.push({ id, cb });
    return id;
  };
  const cancelFrame = (id: number): void => { rafQueue = rafQueue.filter((r) => r.id !== id); };
  function pump(frames = 1): void {
    for (let i = 0; i < frames; i++) {
      const batch = rafQueue;
      rafQueue = [];
      for (const r of batch) r.cb(now);
    }
  }

  // ── fake document ──
  const marker = makeElement('div');
  marker.id = 'marker';
  const canvas = makeElement('canvas');
  const head = makeElement('head');
  const byId: Record<string, FakeElement> = { marker };
  const docListeners: { type: string; fn: (e: unknown) => void }[] = [];

  /**
   * An APPENDED element with an id becomes findable, and `remove()` un-finds it.
   *
   * The runtime's only DOM construction is the Minimal-UI hide style, and it manages that style by
   * `getElementById('__simHideUi')` → create-or-update → `remove()`. Without this, every lookup
   * returned null, so the runtime created a fresh orphan style on every call and the mechanical
   * hide — the one visible effect a UI policy has when the section body exposes no hook — was
   * unobservable. Modelling append/remove is what makes `hideRules()` below mean anything.
   */
  head.appendChild = (child: unknown): void => {
    const el = child as FakeElement;
    if (!el || !el.id) return;
    byId[el.id] = el;
    const detach = el.remove.bind(el);
    el.remove = (): void => { detach(); if (byId[el.id] === el) delete byId[el.id]; };
  };
  const doc = {
    readyState: 'complete',
    head,
    documentElement: head,
    getElementById(id: string): FakeElement | null { return byId[id] ?? null; },
    getElementsByTagName(tag: string): FakeElement[] { return tag === 'canvas' ? [canvas] : []; },
    createElement(tag: string): FakeElement { return makeElement(tag); },
    addEventListener(type: string, fn: (e: unknown) => void): void { docListeners.push({ type, fn }); },
    removeEventListener(type: string, fn: (e: unknown) => void): void {
      const i = docListeners.findIndex((l) => l.type === type && l.fn === fn);
      if (i >= 0) docListeners.splice(i, 1);
    },
    dispatch(type: string): void { for (const l of [...docListeners]) if (l.type === type) l.fn({ type }); },
    listenerCount(): number { return docListeners.length; },
  };

  // ── fake object URLs ──
  let urlSeq = 0;
  const revokedUrls: string[] = [];
  const fakeURL = {
    createObjectURL: (): string => `blob:fixture-${++urlSeq}`,
    revokeObjectURL: (u: string): void => { revokedUrls.push(u); },
  };

  // ── fake window ──
  const winListeners: { type: string; fn: (e: unknown) => void }[] = [];
  const parentPosts: { message: Record<string, unknown>; targetOrigin: string }[] = [];
  const parentWindow = {
    postMessage(message: Record<string, unknown>, targetOrigin: string) {
      parentPosts.push({ message, targetOrigin });
    },
  };

  const ctx: Record<string, unknown> = {
    console,
    AbortController,
    Blob,
    URL: fakeURL,
    performance: { now: () => now },
    document: doc,
    parent: parentWindow,
    location: { search: '', hash: '', href: 'https://sim.test/index.html' },
    setTimeout: (fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => schedule(fn, ms ?? 0, args, null),
    setInterval: (fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => schedule(fn, ms ?? 0, args, ms ?? 0),
    clearTimeout: (id: number) => { timers.delete(id); },
    clearInterval: (id: number) => { timers.delete(id); },
    requestAnimationFrame: requestFrame,
    cancelAnimationFrame: cancelFrame,
    addEventListener(type: string, fn: (e: unknown) => void) { winListeners.push({ type, fn }); },
    removeEventListener(type: string, fn: (e: unknown) => void) {
      const i = winListeners.findIndex((l) => l.type === type && l.fn === fn);
      if (i >= 0) winListeners.splice(i, 1);
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(
    v3ManagedBridge(new Map(Object.entries(bodies)), descriptor),
    ctx as vm.Context,
    { filename: 'v3-fixture-bridge.js' },
  );

  // ── driving ──
  const inbox: Record<string, unknown>[] = [];
  let activePort: FakePort | null = null;
  let outSeq = 0;

  function dispatchWindow(event: unknown): void {
    for (const l of [...winListeners]) if (l.type === 'message') l.fn(event);
  }

  function offer(options: OfferOptions = {}): { child: FakePort; parent: FakePort }[] {
    const count = options.portCount ?? 1;
    const pairs = Array.from({ length: count }, () => channel());
    const data = {
      kind: SIM_BOOTSTRAP_KIND,
      protocolVersion: SIM_PROTOCOL_VERSION,
      playerSessionId: PLAYER_SESSION,
      packageRevision: PACKAGE_REVISION,
      documentId: DOCUMENT_ID,
      parentOrigin: PARENT_ORIGIN,
      ...(options.data ?? {}),
    };
    dispatchWindow({
      data,
      origin: options.origin ?? PARENT_ORIGIN,
      source: options.source ?? parentWindow,
      ports: pairs.map((p) => p.child),
    });
    // Attached AFTER the dispatch and before start(): the accept is already sitting in the port's
    // queue, so this sees it — which is exactly how a real parent, whose port is not started until
    // it has wired its handler, observes the same message.
    for (const p of pairs) {
      p.parent.addEventListener('message', (e) => inbox.push(e.data as Record<string, unknown>));
      p.parent.start();
    }
    return pairs;
  }

  function bootstrap(): { child: FakePort; parent: FakePort } {
    const [pair] = offer();
    activePort = pair.parent;
    return pair;
  }

  function send(type: string, options: SendOptions = {}): Record<string, unknown> {
    const seq = options.seq ?? ++outSeq;
    const envelope: Record<string, unknown> = {
      ...makeEnvelope(
        type,
        {
          playerSessionId: PLAYER_SESSION,
          packageRevision: PACKAGE_REVISION,
          documentId: DOCUMENT_ID,
          activationId: options.activationId,
          variantKey: options.variantKey,
          configHash: options.configHash,
        },
        seq,
        options.payload ?? {},
      ),
      ...(options.overrides ?? {}),
    };
    if (!activePort) throw new Error('send() before bootstrap()');
    // STRUCTURED CLONE, as a real MessagePort does. Without it the child holds a REFERENCE to the
    // test's own payload object, and the runtime's deliberate in-place mutation of the prepared
    // config (SET_UI_POLICY, audit P1.2) reaches back out and rewrites the fixture's shared
    // CONFIG — a leak that makes later tests in the file depend on the order they ran in.
    // `structuredClone` is also stricter than the fake was: an uncloneable payload now throws in
    // the test rather than being delivered as something no real transport could carry.
    activePort.postMessage(structuredClone(envelope));
    return envelope;
  }

  function init(): void {
    send(INIT_DOCUMENT, {
      payload: {
        parentOrigin: PARENT_ORIGIN,
        knownVariants: Object.keys(bodies),
        quality: 'high',
        audible: { muted: true, volume: 1 },
      },
    });
  }

  interface Activation { activationId: string; variantKey: string; configHash: string }

  function prepare(variantKey: string, activationId: string, config: SimPresentationConfig = CONFIG): Activation {
    const configHash = computeConfigHash(config);
    send(PREPARE_SECTION, { activationId, variantKey, configHash, payload: { variantKey, config } });
    return { activationId, variantKey, configHash };
  }

  function present(activation: Activation): void {
    send(PRESENT_SECTION, { ...activation, payload: {} });
  }

  /** Only protocol envelopes — the bootstrap accept is deliberately excluded. */
  const envelopes = (type?: string): Record<string, unknown>[] =>
    inbox.filter((m) => m.namespace === SIM_PROTOCOL_NAMESPACE && (type === undefined || m.type === type));

  const accepts = (): Record<string, unknown>[] =>
    inbox.filter((m) => m.kind === SIM_BOOTSTRAP_ACCEPT_KIND);

  const proto = (): Record<string, unknown>[] => plain(ctx[V3_PROTO_GLOBAL]);
  const state = (label: string): Record<string, unknown> =>
    ((ctx[V3_STATE_GLOBAL] as Record<string, Record<string, unknown>>) ?? {})[label];

  /** The live `style#__simHideUi` text, or null when no mechanical hide is installed. */
  const hideRules = (): string | null => byId.__simHideUi?.textContent ?? null;

  return {
    ctx, doc, marker, canvas, inbox, parentPosts, revokedUrls,
    advance, pump, offer, bootstrap, send, init, prepare, present,
    envelopes, accepts, proto, state, hideRules,
    setActivePort(port: FakePort) { activePort = port; },
  };
}

type Harness = ReturnType<typeof createHarness>;

/** The common preamble: adopt a port, become ready. */
function bootHarness(
  bodies: Record<string, string> = V3_MANAGED_SECTION_BODIES,
  descriptor: V3PackageDescriptor = V3_MANAGED_DESCRIPTOR,
): { h: Harness; pair: { child: FakePort; parent: FakePort } } {
  const h = createHarness(bodies, descriptor);
  const pair = h.bootstrap();
  h.init();
  return { h, pair };
}

// ── bootstrap ─────────────────────────────────────────────────────────────────────────────────

describe('v3 fixture — bootstrap', () => {
  it('adopts a valid offer and answers on the port it was handed', () => {
    const h = createHarness(V3_MANAGED_SECTION_BODIES, V3_MANAGED_DESCRIPTOR);
    h.bootstrap();
    expect(h.accepts()).toEqual([
      { kind: SIM_BOOTSTRAP_ACCEPT_KIND, protocolVersion: SIM_PROTOCOL_VERSION, documentId: DOCUMENT_ID },
    ]);
  });

  it('announces itself with a hello BEFORE any origin has been negotiated', () => {
    const h = createHarness(V3_MANAGED_SECTION_BODIES, V3_MANAGED_DESCRIPTOR);
    expect(h.parentPosts[0]).toEqual({
      message: { kind: 'flowvid.sim.hello', protocolVersion: SIM_PROTOCOL_VERSION },
      targetOrigin: '*',
    });
  });

  it.each([
    ['a source that is not window.parent', { source: { postMessage(): void {} } } as OfferOptions],
    ['a parentOrigin that disagrees with the event origin', { data: { parentOrigin: 'https://evil.test' } } as OfferOptions],
    ['zero ports', { portCount: 0 } as OfferOptions],
    ['two ports', { portCount: 2 } as OfferOptions],
    ['a mismatched protocol version', { data: { protocolVersion: SIM_PROTOCOL_VERSION + 1 } } as OfferOptions],
    ['a missing documentId', { data: { documentId: '' } } as OfferOptions],
  ])('refuses an offer with %s', (_label, options) => {
    const h = createHarness(V3_MANAGED_SECTION_BODIES, V3_MANAGED_DESCRIPTOR);
    h.offer(options);
    expect(h.accepts(), 'a malformed offer was adopted').toEqual([]);
  });

  it('a refused offer does not consume the handshake — a valid one still adopts', () => {
    const h = createHarness(V3_MANAGED_SECTION_BODIES, V3_MANAGED_DESCRIPTOR);
    h.offer({ source: { postMessage(): void {} } });
    h.offer({ data: { parentOrigin: 'https://evil.test' } });
    expect(h.accepts()).toEqual([]);
    h.bootstrap();
    expect(h.accepts()).toHaveLength(1);
  });

  it('IGNORES a repeat offer for the same epoch, and adopts one for a NEW epoch', () => {
    // Both halves matter, and they pull in opposite directions.
    //
    // Latching permanently on the first adoption was a wedge: the parent gives up after a bounded
    // deadline, so a package whose listener installs late latched onto a port the parent had
    // already abandoned and ran v2 for the rest of its life while certified modern.
    //
    // But replacing on ANY later offer is worse. The parent re-offers every 150 ms and, the moment
    // it adopts one, closes every other pending channel — so an offer still in flight would make
    // the child switch to a port whose parent end was just closed. No engine fires a close event on
    // a MessagePort, so neither side could ever detect it and the document would go silent forever.
    //
    // Scoping replacement to a DIFFERENT documentId keeps the recovery and makes the race impossible.
    const h = createHarness(V3_MANAGED_SECTION_BODIES, V3_MANAGED_DESCRIPTOR);
    const first = h.bootstrap();
    expect(h.accepts(), 'the first offer was adopted').toHaveLength(1);

    const [dup] = h.offer();                       // same DOCUMENT_ID — a retry
    expect(h.accepts(), 'a retry for the adopted epoch must not be adopted again').toHaveLength(1);
    expect(dup.child.closed, 'a refused offer must not leave a live entangled port').toBe(true);
    expect(first.child.closed, 'the adopted port must survive a retry').toBe(false);

    // The adopted channel is still the working one.
    h.send(INIT_DOCUMENT, {
      payload: { parentOrigin: PARENT_ORIGIN, quality: 'high', audible: { muted: true, volume: 0 } },
    });
    expect(h.envelopes('DOCUMENT_READY'), 'the original channel still works').toHaveLength(1);

    // A NEW epoch: the parent gave up and re-opened. This is the recovery path.
    const [fresh] = h.offer({ data: { documentId: 'doc-epoch-2' } });
    expect(h.accepts(), 'a new epoch must be adopted').toHaveLength(2);
    expect(first.child.closed, 'the superseded port must be closed, not leaked').toBe(true);
    expect(fresh.child.closed, 'the newly adopted port must stay open').toBe(false);
  });

  it('refuses a payload that is not a plain object — including an ARRAY', () => {
    // `typeof [] === 'object'` and `[]` is truthy, so the natural guard lets an array through. The
    // PARENT's validator does not (runtimeProtocol's isObject excludes arrays), and two halves of
    // one protocol disagreeing about what a legal envelope is means a message the parent would have
    // refused still advances the child's sequence and draws a reply.
    const h = createHarness(V3_MANAGED_SECTION_BODIES, V3_MANAGED_DESCRIPTOR);
    h.bootstrap();
    h.init();
    const before = h.envelopes('QUALITY_APPLIED').length;

    // `overrides`, not `payload`: the harness's `send` applies `options.payload ?? {}`, which would
    // quietly turn a null payload into a legal empty object and test nothing.
    for (const payload of [[], ['low'], null, 'low', 7]) {
      h.send(SET_QUALITY, { overrides: { payload } });
    }
    expect(h.envelopes('QUALITY_APPLIED').length, 'a non-object payload drew a reply').toBe(before);

    // And the child is still live: a well-formed command after the run is answered normally, so the
    // refusals were refusals and not a wedged dispatcher.
    h.send(SET_QUALITY, { payload: { profile: 'low' } });
    expect(h.envelopes('QUALITY_APPLIED').length).toBe(before + 1);
  });

  it('records both directions of the bootstrap, in the order the runtime saw them', () => {
    const h = createHarness(V3_MANAGED_SECTION_BODIES, V3_MANAGED_DESCRIPTOR);
    h.bootstrap();
    const log = h.proto();
    expect(log.map((e) => [e.dir, e.channel, e.kind])).toEqual([
      ['in', 'window', SIM_BOOTSTRAP_KIND],
      ['out', 'port', SIM_BOOTSTRAP_ACCEPT_KIND],
    ]);
    expect(log.every((e) => typeof e.at === 'number')).toBe(true);
  });
});

// ── document lifecycle ────────────────────────────────────────────────────────────────────────

describe('v3 fixture — document lifecycle', () => {
  it('INIT_DOCUMENT produces DOCUMENT_READY with the honest capabilities and the real variants', () => {
    const { h } = bootHarness();
    const ready = h.envelopes('DOCUMENT_READY');
    expect(ready).toHaveLength(1);
    expect(plain(ready[0].payload)).toEqual({
      capabilities: {
        activationScoped: true,
        managedLifecycle: false,
        onDemandRender: false,
        contextEvents: true,
        // FALSE because `v3managed` deliberately carries legacy-bodied sections — see
        // V3_MANAGED_DESCRIPTOR. A package that reported `true` here would be claiming a
        // suspension guarantee on behalf of bodies that cannot make it.
        suspendable: false,
        audioControl: true,
        qualityControl: true,
      },
      variants: Object.keys(V3_MANAGED_SECTION_BODIES),
      // P1.2. Advertised NEXT TO the capability report rather than inside it: `capabilities` is the
      // reveal-path contract the canary classifies (every flag there is load-bearing for
      // `managed-presentable`), and being unable to hot-swap chrome says nothing about whether a
      // package can draw a correct frame. A package published before the policy handlers omits
      // this field entirely, and the parent reads that absence as "restart me instead".
      policies: ['ui', 'automation'],
    });
    expect(ready[0].seq, 'outbound sequence numbers start at 1').toBe(1);
    expect(ready[0].documentId).toBe(DOCUMENT_ID);
    expect(ready[0].packageRevision).toBe(PACKAGE_REVISION);
  });

  it('the ALL-MANAGED package reports suspendable, and only it can reach managed-presentable', () => {
    const { h } = bootHarness(V3_ALL_MANAGED_SECTION_BODIES, V3_ALL_MANAGED_DESCRIPTOR);
    const payload = plain<{ capabilities: Record<string, boolean>; variants: string[] }>(
      h.envelopes('DOCUMENT_READY')[0].payload,
    );
    expect(payload.capabilities.suspendable).toBe(true);
    expect(payload.variants).toEqual(Object.keys(V3_ALL_MANAGED_SECTION_BODIES));

    // EVERY managed flag, not just `suspendable`. An earlier runtime derived these from the
    // INSTALLED lifecycle — which is necessarily null at INIT_DOCUMENT — so `managedLifecycle` and
    // `onDemandRender` were false for every package that has ever existed. `suspendable` alone
    // happened to be computed from the static descriptor, so a test that checked only it passed
    // both before and after the fix while the modern path was unreachable in production.
    expect(payload.capabilities.managedLifecycle).toBe(true);
    expect(payload.capabilities.onDemandRender).toBe(true);

    // The consequence that actually matters: this is the ONLY class that unlocks aggressive
    // preparation and live reveal, and it is unreachable unless every flag above is true.
    expect(classifyFromCapabilities(payload.capabilities as unknown as SimRuntimeCapabilities))
      .toBe('managed-presentable');
    expect(allowsAggressivePreparation('managed-presentable')).toBe(true);
  });

  it('a package carrying even one legacy-bodied section can NOT reach managed-presentable', () => {
    const { h } = bootHarness();   // v3managed — deliberately mixed
    const payload = plain<{ capabilities: Record<string, boolean> }>(
      h.envelopes('DOCUMENT_READY')[0].payload,
    );
    expect(classifyFromCapabilities(payload.capabilities as unknown as SimRuntimeCapabilities))
      .toBe('managed-partial');
    expect(allowsAggressivePreparation('managed-partial')).toBe(false);
  });

  it('records inbound and outbound envelopes with a timestamp and the seq the runtime used', () => {
    const { h } = bootHarness();
    const log = h.proto();
    expect(log.map((e) => [e.dir, e.type, e.seq])).toEqual([
      ['in', null, null],                 // the bootstrap offer (no type, no seq)
      ['out', null, null],                // the accept
      ['in', INIT_DOCUMENT, 1],
      ['out', 'DOCUMENT_READY', 1],
    ]);
    const stamps = log.map((e) => e.at as number);
    expect(stamps.every((t, i) => i === 0 || t >= stamps[i - 1])).toBe(true);
    // The parent is cross-origin in production and cannot read the log directly, so every record
    // is mirrored over window.postMessage. Losing that channel silently blinds the browser suites.
    const mirrored = h.parentPosts.filter((p) => p.message.type === 'PROTO_V3');
    expect(mirrored).toHaveLength(log.length);
  });
});

// ── activation lifecycle ──────────────────────────────────────────────────────────────────────

describe('v3 fixture — activation lifecycle', () => {
  it('PREPARE_SECTION echoes back the EXACT variantKey and configHash it was sent', () => {
    const { h } = bootHarness();
    const activation = h.prepare(V3A, 'act-1');
    const applied = h.envelopes('SECTION_APPLIED');
    expect(applied).toHaveLength(1);
    // Identity on the envelope AND in the payload: the envelope is what the reveal invariant
    // compares, the payload is what proves the child installed what it was asked to.
    expect(applied[0].activationId).toBe('act-1');
    expect(applied[0].variantKey).toBe(V3A);
    expect(applied[0].configHash).toBe(activation.configHash);
    const payload = plain<{ variantKey: string; configHash: string; applyMs: number }>(applied[0].payload);
    expect(payload.variantKey).toBe(V3A);
    expect(payload.configHash).toBe(activation.configHash);
    expect(h.state('V3A').prepared).toBe(true);
  });

  it('a DIFFERENT config on the same variant is echoed with ITS hash, not the previous one', () => {
    const { h } = bootHarness();
    h.prepare(V3A, 'act-1');
    const other: SimPresentationConfig = { ...CONFIG, simpleUi: true, hideSelectors: ['.controls'] };
    const second = h.prepare(V3A, 'act-2', other);
    expect(second.configHash).not.toBe(CONFIG_HASH);
    const applied = h.envelopes('SECTION_APPLIED');
    expect(applied.map((e) => [e.activationId, e.configHash])).toEqual([
      ['act-1', CONFIG_HASH],
      ['act-2', second.configHash],
    ]);
  });

  it('PRESENT_SECTION acknowledges with the SAME activationId, from inside the frame that drew', () => {
    const { h } = bootHarness();
    const activation = h.prepare(V3A, 'act-1');
    h.present(activation);
    expect(h.envelopes('SECTION_PRESENTED'), 'acknowledged before a frame ran').toHaveLength(0);
    h.pump();
    const presented = h.envelopes('SECTION_PRESENTED');
    expect(presented).toHaveLength(1);
    expect(presented[0].activationId).toBe('act-1');
    expect(presented[0].variantKey).toBe(V3A);
    expect(presented[0].configHash).toBe(activation.configHash);
    expect(plain(presented[0].payload)).toEqual({
      variantKey: V3A,
      configHash: activation.configHash,
      canvas: { width: 320, height: 180 },
      framesSubmitted: 1,
    });
    expect(h.canvas.fills, 'the ack described a render that never happened').toEqual(['#4040ff']);
  });

  it('ACTIVATE_SECTION and the automation pair are all activation-scoped', () => {
    const { h } = bootHarness();
    const activation = h.prepare(V3A, 'act-1');
    h.present(activation);
    h.pump();
    h.send(ACTIVATE_SECTION, { ...activation, payload: {} });
    expect(h.state('V3A').activated).toBe(true);

    h.send(PAUSE_AUTOMATION, { ...activation, payload: {} });
    expect(h.envelopes('AUTOMATION_PAUSED')).toHaveLength(1);
    expect(h.state('V3A').autoPaused).toBe(true);

    // A command carrying a DIFFERENT activation is not this section's business, even though every
    // other field is valid — the runtime must drop it rather than apply it to whatever is current.
    h.send(PAUSE_AUTOMATION, { ...activation, activationId: 'act-stale', payload: {} });
    expect(h.envelopes('AUTOMATION_PAUSED')).toHaveLength(1);
  });

  it('a MANAGED body is stamped __managed, a LEGACY return value never is', () => {
    const { h } = bootHarness();
    h.prepare(V3A, 'act-managed');
    expect((h.state('V3A').lifecycle as { __managed?: boolean }).__managed).toBe(true);

    h.prepare(V3LEGACYBODY, 'act-legacy');
    // The cleanup FUNCTION the legacy body returned is untouched: the runtime builds a separate
    // wrapper around it rather than describing it as a lifecycle. (The wrapper's own `__managed`
    // is not reachable from the document — the capability report at INIT_DOCUMENT, asserted above,
    // is where a package carrying bodies like this one states the fact on the wire.)
    expect((h.state('V3LEGACYBODY').cleanup as { __managed?: boolean }).__managed).toBeUndefined();
  });

  it('a LEGACY-bodied section still presents, and honestly declines the managed capabilities', () => {
    const { h } = bootHarness();
    const activation = h.prepare(V3LEGACYBODY, 'act-legacy');
    expect(h.envelopes('SECTION_APPLIED')).toHaveLength(1);

    h.present(activation);
    h.pump();
    const presented = h.envelopes('SECTION_PRESENTED');
    expect(presented, 'the legacy wrapper failed to present').toHaveLength(1);
    expect(presented[0].activationId).toBe('act-legacy');
    // measureCanvas(), not a canvas the body reported — a legacy body has no way to report one.
    expect(plain<{ canvas: unknown }>(presented[0].payload).canvas).toEqual({ width: 320, height: 180 });

    // The body called the GLOBAL setInterval, knowing nothing about the scope, and the scope
    // counted it anyway. That is the bounded global swap runLegacy performs around the synchronous
    // body call — the only reason a pre-managed body is accounted for at all.
    h.send(SUSPEND_DOCUMENT, { payload: {} });
    expect(plain<{ counts: Record<string, number> }>(h.envelopes('DOCUMENT_SUSPENDED')[0].payload).counts)
      .toEqual({ ...ZERO_RESOURCE_COUNTS, intervals: 1 });

    // The wrapper implements dispose from the cleanup function and NOTHING else. setQuality is the
    // capability that says so on the wire: `unsupported` is the report a `__managed: false`
    // lifecycle must produce, and a wrapper that claimed `applied` would be describing a legacy
    // body as managed.
    h.send(SET_QUALITY, { payload: { profile: 'low' } });
    expect(plain(h.envelopes('QUALITY_APPLIED').at(-1)!.payload)).toEqual({ profile: 'low', outcome: 'unsupported' });

    h.send(RELEASE_SECTION, { ...activation, payload: {} });
    expect(h.state('V3LEGACYBODY').cleaned, 'the cleanup function never ran').toBe(true);
    expect(h.envelopes('SECTION_RELEASED')).toHaveLength(1);
  });

  it('a MANAGED section applies a quality change, which is what makes the legacy report meaningful', () => {
    const { h } = bootHarness();
    h.prepare(V3A, 'act-1');
    h.send(SET_QUALITY, { payload: { profile: 'low' } });
    expect(plain(h.envelopes('QUALITY_APPLIED')[0].payload)).toEqual({ profile: 'low', outcome: 'applied' });
    expect(h.state('V3A').quality).toBe('low');
  });

  it('the reused v2 section bodies run unchanged through the legacy wrapper', () => {
    const { h } = bootHarness();
    const activation = h.prepare(A, 'act-a');
    h.present(activation);
    h.pump();
    expect(h.envelopes('SECTION_PRESENTED')).toHaveLength(1);
    // The colour contract every existing browser assertion is written against: A is BLUE.
    expect(h.marker.style.background).toBe('#0000ff');
    expect(h.marker.getAttribute('data-section')).toBe('A');
  });

  it('a section that never acknowledges produces NO acknowledgement and NO error', async () => {
    const { h } = bootHarness();
    const activation = h.prepare(V3NOPRESENT, 'act-nopresent');
    expect(h.envelopes('SECTION_APPLIED')).toHaveLength(1);
    h.present(activation);
    h.pump(10);
    h.advance(60_000);
    await flush();
    h.pump(10);
    expect(h.state('V3NOPRESENT').presentCalls, 'present() was never even called').toBe(1);
    expect(h.envelopes('SECTION_PRESENTED'), 'a silent section acknowledged anyway').toHaveLength(0);
    // The bound belongs to the PARENT. A child inventing an error here would let a player treat
    // "no answer" as a distinguishable event, which is exactly the guess the protocol removed.
    expect(h.envelopes('SECTION_ERROR')).toHaveLength(0);
  });

  it('a slow prepare acknowledges only once its promise settles', async () => {
    const { h } = bootHarness();
    h.prepare(V3SLOWPREPARE, 'act-slow');
    await flush();
    expect(h.envelopes('SECTION_APPLIED'), 'acknowledged before prepare resolved').toHaveLength(0);

    h.advance(V3_SLOW_PREPARE_MS - 1);
    await flush();
    expect(h.envelopes('SECTION_APPLIED')).toHaveLength(0);

    h.advance(1);
    await flush();
    expect(h.state('V3SLOWPREPARE').resolved).toBe(true);
    expect(h.envelopes('SECTION_APPLIED')).toHaveLength(1);
    expect(h.envelopes('SECTION_APPLIED')[0].activationId).toBe('act-slow');
  });

  it('a prepare that throws reports a recoverable SECTION_ERROR and NEVER a SECTION_APPLIED', () => {
    const { h } = bootHarness();
    h.prepare(V3THROWPREPARE, 'act-throw');
    const errors = h.envelopes('SECTION_ERROR');
    expect(errors).toHaveLength(1);
    expect(errors[0].activationId).toBe('act-throw');
    expect(plain<{ stage: string; recoverable: boolean; message: string }>(errors[0].payload)).toMatchObject({
      stage: 'prepare',
      recoverable: true,
      message: 'fixture prepare exploded',
    });
    expect(h.envelopes('SECTION_APPLIED'), 'a failed prepare was acknowledged as applied').toHaveLength(0);

    // …and the document is still usable, which is what `recoverable: true` promised.
    const next = h.prepare(V3A, 'act-after-throw');
    expect(h.envelopes('SECTION_APPLIED')).toHaveLength(1);
    h.present(next);
    h.pump();
    expect(h.envelopes('SECTION_PRESENTED')).toHaveLength(1);
  });
});

// ── section policy (audit P1.2) ───────────────────────────────────────────────────────────────

/**
 * A managed body that COUNTS ITS OWN EXECUTIONS and exposes a solver-ish integrator.
 *
 * THE PROXY, AND WHAT IT PROVES. "A UI toggle does not reset the simulation" is not directly
 * observable from outside a document, so it is asserted through three things that are:
 *
 *   • `runs` — incremented once per synchronous execution of the body source. The body runs exactly
 *     once per activation, so `runs` staying at 1 across a policy message means the runtime did not
 *     re-prepare the section.
 *   • `disposed` / `released` — the managed lifecycle's teardown hooks. `releaseCurrent()` is the
 *     only thing that calls them, and it is what a new activation opens with, so an untouched pair
 *     means no activation boundary was crossed.
 *   • `t` — a value the automation interval integrates. It is reset ONLY by a fresh body run, so a
 *     preserved `t` is trajectory continuity in the one sense a fixture can have one.
 *
 * WHAT IT DOES NOT PROVE. A real section's state lives in engine objects, GPU buffers and closures
 * this fixture has no equivalent of. `runs === 1` proves the RUNTIME did not re-execute the body;
 * it cannot prove a body does not throw its own state away in response to `setUiPolicy`. That is
 * the section author's contract, and the honest statement of it is `bodyHook` on the wire — which
 * is why the acknowledgement carries it.
 */
const policyBody = (label: string, opts: { uiHook: boolean }) => `
  var scope = ctx.scope;
  var g = window[${JSON.stringify(V3_STATE_GLOBAL)}] = window[${JSON.stringify(V3_STATE_GLOBAL)}] || {};
  // RETAINED ACROSS BODY RUNS on purpose: a counter re-created by the body could never show that
  // the body was re-created. Only 't' and the per-run flags are reset by a run.
  var state = g[${JSON.stringify(label)}] = g[${JSON.stringify(label)}] || { runs: 0, uiCalls: [], t: 0 };
  state.runs++;
  state.t = 0;
  state.disposed = false;
  state.released = false;
  state.autoPaused = false;
  state.ticks = 0;
  state.autoScriptAtStart = !!(ctx.config && ctx.config.autoScript !== false);
  state.configSeen = ctx.config;

  // Registered as AUTOMATION so the scope's pause/resume can reach it — the only handles a policy
  // message is allowed to touch. A body that registers nothing is deliberately not pausable.
  if (state.autoScriptAtStart) {
    state.autoId = scope.registerAutomation(scope.setInterval(function () {
      state.ticks++; state.t += 1;
    }, 40), 'interval');
  }

  var lifecycle = {
    prepare: function () {},
    present: function (c) { c.scope.requestAnimationFrame(function () { c.markPresented(); }); },
    pauseAuto: function () { state.autoPaused = true; },
    resumeAuto: function () { state.autoPaused = false; },
    release: function () { state.released = true; },
    dispose: function () { state.disposed = true; }
  };
  ${opts.uiHook
    ? `lifecycle.setUiPolicy = function (p) { state.uiCalls.push({ simpleUi: !!p.simpleUi, hideSelectors: (p.hideSelectors || []).slice() }); };`
    : '/* no setUiPolicy — the mechanical hide is all this section gets */'}
  return lifecycle;
`;

const POLICY_HOOKED = FIXTURE_V3_SECTIONS.V3A;
const POLICY_BARE = FIXTURE_V3_SECTIONS.V3B;

/** Only these two sections, so `allManaged` is honestly true and every body is a lifecycle. */
const POLICY_BODIES: Record<string, string> = {
  [POLICY_HOOKED]: policyBody('HOOKED', { uiHook: true }),
  [POLICY_BARE]: policyBody('BARE', { uiHook: false }),
};

const SET_UI_POLICY = 'SET_UI_POLICY';
const SET_AUTOMATION_POLICY = 'SET_AUTOMATION_POLICY';

/** Boot the policy package and bring one section all the way to activated. */
function bootPolicy(variantKey: string = POLICY_HOOKED, config: SimPresentationConfig = CONFIG) {
  const h = createHarness(POLICY_BODIES, V3_ALL_MANAGED_DESCRIPTOR);
  h.bootstrap();
  h.init();
  const activation = h.prepare(variantKey, 'act-policy', config);
  h.present(activation);
  h.pump();
  h.send(ACTIVATE_SECTION, { ...activation, payload: {} });
  return { h, activation };
}

describe('v3 child — a UI policy changes the chrome and NOTHING else', () => {
  it('does not re-run the body, does not release, does not dispose, and keeps the solver running', () => {
    const { h, activation } = bootPolicy();
    h.advance(200);
    const before = { runs: h.state('HOOKED').runs, t: h.state('HOOKED').t };
    expect(before.runs, 'the body must have run exactly once for this activation').toBe(1);
    expect(before.t, 'the automation never advanced, so continuity is untestable').toBeGreaterThan(0);

    h.send(SET_UI_POLICY, { ...activation, payload: { simpleUi: true, hideSelectors: ['.controls'] } });

    const after = h.state('HOOKED');
    expect(after.runs, 'the section body was re-executed for a chrome change').toBe(1);
    expect(after.disposed, 'the managed lifecycle was disposed for a chrome change').toBe(false);
    expect(after.released, 'the activation was released for a chrome change').toBe(false);
    expect(after.t, 'the integrator was reset — the trajectory was thrown away').toBe(before.t);

    // And time keeps moving: the automation was not merely left registered, it is still firing.
    h.advance(200);
    expect(h.state('HOOKED').t as number).toBeGreaterThan(before.t as number);
    // No LIFECYCLE traffic either — a second SECTION_APPLIED is what a re-prepare would produce,
    // and a SECTION_ERROR is what a handler that fell through to one would.
    expect(h.envelopes('SECTION_APPLIED'), 'a policy produced an activation acknowledgement').toHaveLength(1);
    expect(h.envelopes('SECTION_ERROR')).toHaveLength(0);
  });

  it('installs, updates and removes the mechanical hide style', () => {
    const { h, activation } = bootPolicy();
    expect(h.hideRules(), 'nothing is hidden before a policy asks for it').toBeNull();

    h.send(SET_UI_POLICY, { ...activation, payload: { simpleUi: true, hideSelectors: ['.controls', '#legend'] } });
    expect(h.hideRules()).toBe('.controls{display:none !important}\n#legend{display:none !important}');

    h.send(SET_UI_POLICY, { ...activation, payload: { simpleUi: true, hideSelectors: ['#legend'] } });
    expect(h.hideRules(), 'a narrowed selection must narrow the style').toBe('#legend{display:none !important}');

    // Minimal UI off is the un-hide, and it must take the style away rather than empty it: an
    // empty <style> left behind is indistinguishable from a hide that silently stopped working.
    h.send(SET_UI_POLICY, { ...activation, payload: { simpleUi: false, hideSelectors: ['#legend'] } });
    expect(h.hideRules()).toBeNull();
  });

  it('refuses to smuggle markup through a selector, exactly as the prepare path does', () => {
    const { h, activation } = bootPolicy();
    h.send(SET_UI_POLICY, {
      ...activation,
      payload: { simpleUi: true, hideSelectors: ['.ok', '.bad{}', '</style><script>', '.tail\\'] },
    });
    // The hot-swap path must not be a hole in a guard the cold path enforces.
    expect(h.hideRules()).toBe('.ok{display:none !important}');
  });

  it('calls lifecycle.setUiPolicy when the body has one, and reports bodyHook honestly when it does not', () => {
    const hooked = bootPolicy(POLICY_HOOKED);
    hooked.h.send(SET_UI_POLICY, { ...hooked.activation, payload: { simpleUi: true, hideSelectors: ['.a'] } });
    expect(hooked.h.state('HOOKED').uiCalls).toEqual([{ simpleUi: true, hideSelectors: ['.a'] }]);
    expect(plain(hooked.h.envelopes('POLICY_APPLIED').at(-1)!.payload))
      .toEqual({ kind: 'ui', changed: true, bodyHook: true });

    const bare = bootPolicy(POLICY_BARE);
    bare.h.send(SET_UI_POLICY, { ...bare.activation, payload: { simpleUi: true, hideSelectors: ['.a'] } });
    // bodyHook:false is NOT a failure and must not trigger a restart — the mechanical hide really
    // did move. It is reported so a section whose own hiding did not follow is visible in the
    // field rather than diagnosed from a screenshot.
    expect(plain(bare.h.envelopes('POLICY_APPLIED').at(-1)!.payload))
      .toEqual({ kind: 'ui', changed: true, bodyHook: false });
    expect(bare.h.hideRules(), 'the mechanical hide must still apply without a body hook')
      .toBe('.a{display:none !important}');
    expect(bare.h.state('BARE').runs, 'a body with no hook was restarted instead').toBe(1);
  });

  it('an IDENTICAL re-post is changed:false, and does not call the body hook again', () => {
    const { h, activation } = bootPolicy();
    const payload = { simpleUi: true, hideSelectors: ['.a', '.b'] };
    h.send(SET_UI_POLICY, { ...activation, payload });
    h.send(SET_UI_POLICY, { ...activation, payload: { simpleUi: true, hideSelectors: ['.b', '.a', '.a'] } });

    const applied = h.envelopes('POLICY_APPLIED').map((e) => plain<{ changed: boolean }>(e.payload).changed);
    // The second payload is the SAME SET in a different order with a duplicate. Treating it as a
    // change would re-invoke the body hook on every keystroke of a picker that reorders.
    expect(applied).toEqual([true, false]);
    expect(h.state('HOOKED').uiCalls).toHaveLength(1);
  });

  it('the prepared config is updated in place, so ctx.config keeps describing what is on screen', () => {
    const { h, activation } = bootPolicy();
    const seen = h.state('HOOKED').configSeen as { simpleUi?: boolean; hideSelectors?: string[] };
    expect(seen.simpleUi).toBe(false);

    h.send(SET_UI_POLICY, { ...activation, payload: { simpleUi: true, hideSelectors: ['.z'] } });
    // The SAME object the body was handed at prepare — a body that re-reads ctx.config (or a later
    // lifecycle callback that does) must see the live policy, not the one it was born with.
    expect(seen.simpleUi).toBe(true);
    expect(seen.hideSelectors).toEqual(['.z']);
  });

  it('a policy for a SUPERSEDED activation is dropped — it never reaches the live section', () => {
    const { h, activation } = bootPolicy();
    h.send(SET_UI_POLICY, { ...activation, payload: { simpleUi: true, hideSelectors: ['.a'] } });
    expect(h.hideRules()).toBe('.a{display:none !important}');

    // A late policy from the previous activation, valid in every respect except whose section it
    // describes. Applying it would hide controls on the section that superseded it.
    h.send(SET_UI_POLICY, {
      ...activation, activationId: 'act-superseded',
      payload: { simpleUi: true, hideSelectors: ['.b'] },
    });
    expect(h.hideRules(), 'a stale policy reached the live section').toBe('.a{display:none !important}');
    expect(h.envelopes('POLICY_APPLIED'), 'a stale policy was acknowledged').toHaveLength(1);

    // HONESTY NOTE. The v3 child DROPS a stale activation-scoped command silently, exactly as it
    // does for PAUSE_AUTOMATION and RELEASE_SECTION — it does not answer POLICY_REFUSED with
    // reason 'stale-activation'. That reason exists on the v2 bridge, where the activation token
    // is the only identity available and the parent has no way to tell silence from a refusal.
    // Here the parent MINTS the identity, so an unanswered policy is by construction one the
    // parent has already superseded. (Pinned on the v2 side in
    // services/simulation/__tests__/simPolicyBridge.test.ts.)
    expect(h.envelopes('POLICY_REFUSED')).toHaveLength(0);
  });

  it('POLICY_APPLIED carries the activation identity, so the parent can scope it', () => {
    // The parent runs `matchesActivation(env)` on every inbound acknowledgement. An answer posted
    // WITHOUT the activation stamp — `post('POLICY_APPLIED', payload)` instead of
    // `post(..., current)` — passes no five-axis check, so the parent would silently discard every
    // policy result it ever received. Nothing else would break, and nothing would report it: the
    // toggles would work and the telemetry would be empty forever.
    const { h, activation } = bootPolicy();
    h.send(SET_UI_POLICY, { ...activation, payload: { simpleUi: true, hideSelectors: ['.a'] } });
    const applied = h.envelopes('POLICY_APPLIED').at(-1)!;
    expect(applied.activationId).toBe(activation.activationId);
    expect(applied.variantKey).toBe(activation.variantKey);
    expect(applied.configHash).toBe(activation.configHash);
  });

  it('a policy does NOT re-key the activation — configHash still describes the PREPARE', () => {
    // The deliberate boundary from simPolicy.ts: `configHash` means "the config this activation was
    // prepared with", and the policy path does not repartition it (that would re-key every stored
    // poster and every canary verdict). So the echoed identity must stay put even though the live
    // presentation has drifted from it — and anything VISUAL must hash `effectiveConfig` instead of
    // assuming this hash still describes the picture.
    const { h, activation } = bootPolicy();
    const uiOnly: SimPresentationConfig = { ...CONFIG, simpleUi: true, hideSelectors: ['.a'] };
    expect(computeConfigHash(uiOnly), 'the premise is wrong — these configs hash the same')
      .not.toBe(activation.configHash);

    h.send(SET_UI_POLICY, { ...activation, payload: { simpleUi: true, hideSelectors: ['.a'] } });
    expect(h.envelopes('POLICY_APPLIED').at(-1)!.configHash,
      'the child re-derived an identity instead of echoing the one it was given')
      .toBe(activation.configHash);
    // …and every later acknowledgement for this activation agrees with it.
    h.send(PRESENT_SECTION, { ...activation, payload: {} });
    h.pump();
    expect(h.envelopes('SECTION_PRESENTED').at(-1)!.configHash).toBe(activation.configHash);
  });
});

describe('v3 child — an automation policy is a pause with an INVERSE', () => {
  it('pausing stops the ticks without touching the body, and resuming keeps the solver state', () => {
    const { h, activation } = bootPolicy();
    h.advance(200);
    const running = h.state('HOOKED').t as number;
    expect(running).toBeGreaterThan(0);

    h.send(SET_AUTOMATION_POLICY, { ...activation, payload: { autoScript: false } });
    expect(plain(h.envelopes('POLICY_APPLIED').at(-1)!.payload))
      .toEqual({ kind: 'automation', changed: true, stopped: 1 });
    expect(h.state('HOOKED').autoPaused, 'the body was not told to pause its own automation').toBe(true);

    h.advance(400);
    const paused = h.state('HOOKED').t as number;
    expect(paused, 'the automation kept firing while "paused"').toBe(running);

    h.send(SET_AUTOMATION_POLICY, { ...activation, payload: { autoScript: true } });
    expect(plain(h.envelopes('POLICY_APPLIED').at(-1)!.payload))
      .toEqual({ kind: 'automation', changed: true, restarted: 1, unrestorable: 0 });
    expect(h.state('HOOKED').autoPaused).toBe(false);

    // THE POINT: resume did not go through the body. The integrator continues from where it
    // stopped instead of restarting at zero, and the body still ran exactly once.
    expect(h.state('HOOKED').runs, 'resuming automation re-ran the body').toBe(1);
    expect(h.state('HOOKED').t, 'the solver state was reset by the resume').toBe(paused);
    h.advance(200);
    expect(h.state('HOOKED').t as number).toBeGreaterThan(paused);
  });

  it('turning automation ON for a body STARTED with it off is refused as never-started', () => {
    // The body registered nothing, so there is nothing to resume and no honest way to fake one.
    // Only a restart can give this section a demonstration, and only the parent may pay for it.
    const { h, activation } = bootPolicy(POLICY_HOOKED, { ...CONFIG, autoScript: false });
    expect(h.state('HOOKED').autoScriptAtStart).toBe(false);

    h.send(SET_AUTOMATION_POLICY, { ...activation, payload: { autoScript: true } });
    expect(plain(h.envelopes('POLICY_REFUSED').at(-1)!.payload))
      .toEqual({ kind: 'automation', reason: 'never-started', requiresRestart: true });
    expect(h.envelopes('POLICY_APPLIED'), 'a refusal was also acknowledged as applied').toHaveLength(0);
    expect(h.state('HOOKED').runs, 'the child restarted the body on its own initiative').toBe(1);
  });

  it('an idempotent re-post is changed:false and stops nothing', () => {
    const { h, activation } = bootPolicy();
    h.send(SET_AUTOMATION_POLICY, { ...activation, payload: { autoScript: true } });
    expect(plain(h.envelopes('POLICY_APPLIED').at(-1)!.payload)).toEqual({ kind: 'automation', changed: false });

    h.advance(200);
    expect(h.state('HOOKED').t as number, 'a no-op policy stopped the automation').toBeGreaterThan(0);
    expect(h.state('HOOKED').autoPaused, 'a no-op policy called the body pause hook').toBe(false);
  });

  it('a policy for a superseded activation is dropped here too', () => {
    const { h, activation } = bootPolicy();
    h.send(SET_AUTOMATION_POLICY, {
      ...activation, activationId: 'act-superseded', payload: { autoScript: false },
    });
    expect(h.envelopes('POLICY_APPLIED')).toHaveLength(0);
    expect(h.envelopes('POLICY_REFUSED')).toHaveLength(0);
    h.advance(200);
    expect(h.state('HOOKED').t as number, 'a stale policy paused the live section').toBeGreaterThan(0);
  });

  it('a NEW activation does re-run the body — the boundary of what a policy can save', () => {
    // The counterweight to every assertion above. If `runs` could never increase, "the body was not
    // re-run" would be a property of the fixture rather than of the runtime.
    const { h } = bootPolicy();
    h.advance(200);
    expect(h.state('HOOKED').runs).toBe(1);

    const structural: SimPresentationConfig = { ...CONFIG, quality: 'low' };
    h.prepare(POLICY_HOOKED, 'act-second', structural);
    expect(h.state('HOOKED').runs, 'a genuinely new activation must re-run the body').toBe(2);
    expect(h.state('HOOKED').t, 'a new activation starts the trajectory over').toBe(0);
    // `releaseCurrent('superseded')` is silent on the wire — it is an internal boundary, not an
    // answer to a RELEASE_SECTION — so the evidence is the lifecycle hooks the previous activation
    // ran. The body's fresh run resets these flags, which is why `runs` above is the anchor.
    expect(h.envelopes('SECTION_APPLIED'), 'the second activation was not acknowledged').toHaveLength(2);
  });
});

// ── envelope rejection ────────────────────────────────────────────────────────────────────────

describe('v3 fixture — a rejected envelope changes nothing', () => {
  /**
   * PAUSE_AUTOMATION is the probe because it answers SYNCHRONOUSLY and idempotently: one command in,
   * one AUTOMATION_PAUSED out, no frame to pump and no promise to settle. "Did this produce an
   * outbound message" is therefore answerable immediately, which is the whole assertion.
   */
  function armed(): { h: Harness; activation: { activationId: string; variantKey: string; configHash: string } } {
    const { h } = bootHarness();
    const activation = h.prepare(V3A, 'act-1');
    h.send(PAUSE_AUTOMATION, { ...activation, payload: {} });
    expect(h.envelopes('AUTOMATION_PAUSED')).toHaveLength(1);
    return { h, activation };
  }

  it('the probe is SENSITIVE: a second well-formed PAUSE_AUTOMATION is answered again', () => {
    // Without this, every assertion below ("still exactly one") would also hold for a runtime that
    // answered a PAUSE_AUTOMATION exactly once and ignored the rest for reasons of its own.
    const { h, activation } = armed();
    h.send(PAUSE_AUTOMATION, { ...activation, payload: {} });
    expect(h.envelopes('AUTOMATION_PAUSED')).toHaveLength(2);
  });

  it('ignores a DUPLICATE seq', () => {
    const { h, activation } = armed();
    // seq 3 was the PAUSE_AUTOMATION just accepted (1 = INIT, 2 = PREPARE).
    h.send(PAUSE_AUTOMATION, { ...activation, payload: {}, seq: 3 });
    expect(h.envelopes('AUTOMATION_PAUSED')).toHaveLength(1);
  });

  it('ignores an OUT-OF-ORDER seq', () => {
    const { h, activation } = armed();
    h.send(PAUSE_AUTOMATION, { ...activation, payload: {}, seq: 2 });
    expect(h.envelopes('AUTOMATION_PAUSED')).toHaveLength(1);
  });

  it.each([
    ['a wrong documentId', { documentId: 'doc-someone-else' }],
    ['a wrong playerSessionId', { playerSessionId: 'ps-someone-else' }],
    ['a wrong packageRevision', { packageRevision: 'pkgrev-previous' }],
    ['a wrong namespace', { namespace: 'someone.else' }],
    ['a wrong protocolVersion', { protocolVersion: SIM_PROTOCOL_VERSION + 1 }],
  ])('ignores %s', (_label, overrides) => {
    const { h, activation } = armed();
    h.send(PAUSE_AUTOMATION, { ...activation, payload: {}, overrides });
    expect(h.envelopes('AUTOMATION_PAUSED')).toHaveLength(1);
  });

  it('ignores an activation-scoped command with NO activationId', () => {
    const { h, activation } = armed();
    h.send(PAUSE_AUTOMATION, {
      variantKey: activation.variantKey,
      configHash: activation.configHash,
      payload: {},
    });
    expect(h.envelopes('AUTOMATION_PAUSED')).toHaveLength(1);
  });

  it('every rejection above leaves the transport usable — the next valid command is answered', () => {
    const { h, activation } = armed();
    h.send(PAUSE_AUTOMATION, { ...activation, payload: {}, seq: 3 });
    h.send(PAUSE_AUTOMATION, { ...activation, payload: {}, overrides: { documentId: 'doc-someone-else' } });
    h.send(PAUSE_AUTOMATION, { ...activation, payload: {}, overrides: { playerSessionId: 'ps-someone-else' } });
    h.send(PAUSE_AUTOMATION, { variantKey: activation.variantKey, configHash: activation.configHash, payload: {} });
    expect(h.envelopes('AUTOMATION_PAUSED')).toHaveLength(1);

    // A rejected envelope must not have advanced the accepted-sequence watermark either: if it
    // had, this perfectly valid command would be rejected as out-of-order.
    h.send('RESUME_AUTOMATION', { ...activation, payload: {} });
    expect(h.envelopes('AUTOMATION_RESUMED')).toHaveLength(1);
  });
});

// ── presentation acknowledgement ──────────────────────────────────────────────────────────────

describe('v3 fixture — the presentation acknowledgement is exactly once, and never stale', () => {
  const withKnob = (knob: string): SimPresentationConfig => ({ ...CONFIG, initialState: { [knob]: true } });

  it('markPresented called TWICE produces exactly ONE SECTION_PRESENTED', () => {
    const { h } = bootHarness();
    const activation = h.prepare(V3A, 'act-1', withKnob(V3_DOUBLE_ACK_KNOB));
    h.present(activation);
    h.pump();
    const presented = h.envelopes('SECTION_PRESENTED');
    expect(presented, 'the exactly-once guard let a second acknowledgement through').toHaveLength(1);
    // framesSubmitted is the counter the guard protects: a second ack would report 2 and the
    // parent would believe two verified frames existed for one activation.
    expect(plain<{ framesSubmitted: number }>(presented[0].payload).framesSubmitted).toBe(1);
  });

  it('markPresented from a STALE closure, after a new PREPARE, acknowledges nothing', () => {
    const { h } = bootHarness();
    const stale = h.prepare(V3A, 'act-1', withKnob(V3_DEFER_ACK_KNOB));
    h.present(stale);
    h.pump();
    expect(h.envelopes('SECTION_PRESENTED'), 'the deferred ack fired on its own').toHaveLength(0);
    const deferred = h.ctx[V3_DEFERRED_ACK_GLOBAL] as (() => void) | undefined;
    expect(typeof deferred, 'the fixture never parked a deferred acknowledgement').toBe('function');

    // Supersede. The stale closure still holds a valid-looking activation — same document, same
    // package, same variant — and the ONLY thing that can tell it apart is the activation id.
    h.prepare(V3B, 'act-2');
    deferred!();
    expect(h.envelopes('SECTION_PRESENTED'), 'a superseded activation forged an acknowledgement').toHaveLength(0);

    // The live activation still works, so the refusal above was identity-scoped and not a wedge.
    h.present({ activationId: 'act-2', variantKey: V3B, configHash: CONFIG_HASH });
    h.pump();
    const presented = h.envelopes('SECTION_PRESENTED');
    expect(presented).toHaveLength(1);
    expect(presented[0].activationId).toBe('act-2');
  });

  it('PRESENT for an activation that is not current is dropped outright', () => {
    const { h } = bootHarness();
    const first = h.prepare(V3A, 'act-1');
    h.prepare(V3B, 'act-2');
    h.present(first);
    h.pump(3);
    expect(h.envelopes('SECTION_PRESENTED')).toHaveLength(0);
  });
});

// ── resource accounting ───────────────────────────────────────────────────────────────────────

describe('v3 fixture — resource accounting', () => {
  it('SUSPEND reports the resources the section really holds', () => {
    const { h } = bootHarness();
    const activation = h.prepare(V3A, 'act-1');
    h.present(activation);
    h.pump();

    h.send(SUSPEND_DOCUMENT, { payload: {} });
    const suspended = h.envelopes('DOCUMENT_SUSPENDED');
    expect(suspended).toHaveLength(1);
    const payload = plain<{ counts: Record<string, number>; unstoppable: string[] }>(suspended[0].payload);
    // Exact, not "at least": a fixture whose allocations drifted would quietly weaken every leak
    // test that runs against it, and the drift would be invisible in a >= assertion.
    expect(payload.counts).toEqual({
      ...ZERO_RESOURCE_COUNTS,
      rafCallbacks: 1,     // the section's own animation loop, registered but no longer scheduled
      intervals: 1,        // the registered automation timer
      listeners: 1,        // the document listener taken through the scope
      abortControllers: 1,
      objectUrls: 1,
      glTextures: 1,       // the explicitly tracked stand-in for a GPU resource
    });
    expect(payload.unstoppable).toEqual([]);
    expect(h.state('V3A').suspended, 'the lifecycle suspend hook never ran').toBe(true);
  });

  it('DISPOSE_DOCUMENT reports zeroed counts, an EMPTY leak list, and really releases everything', () => {
    const { h, pair } = bootHarness();
    const activation = h.prepare(V3A, 'act-1');
    h.present(activation);
    h.pump();
    const objectUrl = h.state('V3A').objectUrl as string;
    expect(typeof objectUrl).toBe('string');
    expect(h.doc.listenerCount(), 'the section never took a document listener to begin with').toBe(1);

    h.send(DISPOSE_DOCUMENT, { payload: {} });
    const disposed = h.envelopes('DISPOSED');
    expect(disposed).toHaveLength(1);
    const payload = plain<{ counts: Record<string, number>; leaked: string[] }>(disposed[0].payload);
    expect(payload.counts).toEqual(ZERO_RESOURCE_COUNTS);
    expect(payload.leaked).toEqual([]);

    // The counts above are bookkeeping. These are the receipts: each kind of resource had to be
    // released through a DIFFERENT mechanism, and a scope that only zeroed its counters would
    // pass the assertion above and fail every one of these.
    const state = h.state('V3A');
    expect(state.released, 'lifecycle.release() never ran').toBe(true);
    expect(state.disposed, 'lifecycle.dispose() never ran').toBe(true);
    expect((state.texture as { disposed: boolean }).disposed, 'the tracked resource was never disposed').toBe(true);
    expect(state.aborted, 'the activation AbortController was never aborted').toBe(true);
    expect(h.revokedUrls, 'the object URL was never revoked').toEqual([objectUrl]);
    expect(h.doc.listenerCount(), 'the scoped document listener outlived the scope').toBe(0);

    // A disposed document must not keep a live entangled port.
    expect(pair.child.closed).toBe(true);
  });

  it('a superseding PREPARE releases the previous activation before installing the next', () => {
    const { h } = bootHarness();
    const first = h.prepare(V3A, 'act-1');
    h.present(first);
    h.pump();
    const objectUrl = h.state('V3A').objectUrl as string;
    expect(h.state('V3A').disposed, 'the section was disposed before anything superseded it').toBe(false);
    expect(h.doc.listenerCount()).toBe(1);

    h.prepare(V3B, 'act-2');

    // Counts alone CANNOT see this: a supersede that forgot to release simply points `scope` at a
    // fresh scope, whose counters are innocent while the previous scope's resources stay alive.
    // The receipts below are on the SECTION, so a skipped release is visible.
    const previous = h.state('V3A');
    expect(previous.released, 'the superseded lifecycle was never released').toBe(true);
    expect(previous.disposed, 'the superseded lifecycle was never disposed').toBe(true);
    expect((previous.texture as { disposed: boolean }).disposed).toBe(true);
    expect(previous.aborted, 'the superseded activation signal was never aborted').toBe(true);
    expect(h.revokedUrls).toEqual([objectUrl]);
    // One listener, not two: V3B's replaced V3A's rather than accumulating beside it.
    expect(h.doc.listenerCount(), 'the superseded section kept its document listener').toBe(1);
  });

  it('an A → B → A cycle returns to the SAME resource plateau', () => {
    const { h } = bootHarness();
    const counts = (): Record<string, number> => {
      h.send(SUSPEND_DOCUMENT, { payload: {} });
      const all = h.envelopes('DOCUMENT_SUSPENDED');
      return plain<{ counts: Record<string, number> }>(all.at(-1)!.payload).counts;
    };
    const cycle = (variant: string, id: string): Record<string, number> => {
      const activation = h.prepare(variant, id);
      h.present(activation);
      h.pump();
      return counts();
    };
    const first = cycle(V3A, 'act-1');
    // Pinned, so "the plateau is stable" can never degenerate into "both cycles allocated nothing".
    expect(first).toEqual({
      ...ZERO_RESOURCE_COUNTS,
      rafCallbacks: 1, intervals: 1, listeners: 1, abortControllers: 1, objectUrls: 1, glTextures: 1,
    });
    cycle(V3B, 'act-2');
    const third = cycle(V3A, 'act-3');
    // The superseding PREPARE releases the previous activation before installing the next one; if
    // it did not, this is where a resident pool's unbounded growth would first become visible.
    expect(third).toEqual(first);
  });
});
