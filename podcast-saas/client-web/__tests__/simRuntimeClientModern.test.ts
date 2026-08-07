/**
 * The v3 INTEGRATION LAYER of SimRuntimeClient, executed.
 *
 * WHY THIS FILE EXISTS
 * `simRuntimeClient.test.ts` covers the v2 path and `shared/src/sim/__tests__` covers the machines,
 * but the ~420 lines that JOIN them — enableModern, openTransport, onEnvelope, matchesActivation,
 * activateModern, sendPresent, failModern, retryModern, the handshake-window deferral in activate()
 * and the MODERN BRANCH of reveal() — were run by no test at all. Every guarantee the v3 protocol
 * makes is enforced in exactly those lines: the machines can only refuse what the glue actually asks
 * them about, and the glue is where the five-axis identity check is either passed the
 * ACKNOWLEDGEMENT's identity (so it means something) or the machine's own (so it is a tautology —
 * which is what already happened once; see the comment at SECTION_PRESENTED).
 *
 * WHAT IS REAL HERE AND WHAT IS NOT
 * The client is real. The transport is real (SimRuntimeClient constructs it itself; nothing here
 * mocks or subclasses it). The envelopes are built with the shipped `makeEnvelope`, validated by the
 * shipped `validateEnvelope` inside the transport, and every state decision is made by the shipped
 * reducers. The MessagePorts are the runtime's own — a real MessageChannel, a real transfer, real
 * asynchronous delivery.
 *
 * The only stand-in is the CHILD: a `FakeChild` whose `contentWindow.postMessage(msg, origin, [port])`
 * captures the transferred port and validates the offer the way the real child runtime does
 * (backend-api/src/services/simulation/simRuntimeChild.ts: exact parent origin, self-consistent
 * `parentOrigin`, exactly one port, non-empty identity, and adopt-only-for-a-new-epoch). It is a
 * stand-in for the DOCUMENT, never for the protocol — so a test that passes because the fake is
 * lenient is not possible for anything the parent decides.
 *
 * ASYNCHRONY
 * MessagePort delivery is asynchronous even in this environment, so every stimulus is followed by
 * `flush()`, which turns the event loop with a REAL `setImmediate` captured before the fake timers
 * are installed. That keeps `vi.advanceTimersByTime` in charge of the protocol's deadlines while the
 * ports still deliver.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SimRuntimeClient, type SimRuntimeState } from '../lib/sim/SimRuntimeClient';
import { SIM_PAINTED, SIM_READY, START_SCRIPT, SIM_MUTE, SIM_PAUSE } from '../lib/sim/protocol';
import {
  ACTIVATE_SECTION,
  CONTEXT_LOST,
  DISPOSE_DOCUMENT,
  DOCUMENT_READY,
  DOCUMENT_RESUMED,
  DOCUMENT_SUSPENDED,
  INIT_DOCUMENT,
  PREPARE_SECTION,
  PRESENT_SECTION,
  RELEASE_SECTION,
  SECTION_APPLIED,
  SECTION_PRESENTED,
  SIM_BOOTSTRAP_ACCEPT_KIND,
  SIM_BOOTSTRAP_TIMEOUT_MS,
  SIM_PROTOCOL_VERSION,
  ZERO_RESOURCE_COUNTS,
  isBootstrapOffer,
  makeEnvelope,
  type AnySimEnvelope,
  type SimBootstrapOffer,
  type SimRuntimeCapabilities,
} from 'shared/src/sim/runtimeProtocol';
import {
  DEFAULT_PRESENTATION_CONFIG,
  computeConfigHash,
  type SimPresentationConfig,
} from 'shared/src/sim/simIdentity';
import {
  PACKAGE_CLASS_ORDER,
  SIM_BREAKER_THRESHOLD,
  SIM_PREPARE_TIMEOUT_MS,
  SIM_PRESENT_TIMEOUT_MS,
} from 'shared/src/sim/simFailurePolicy';

// ── event-loop control ────────────────────────────────────────────────────────────────────────

/**
 * The REAL `setImmediate`, captured at module load — before any `vi.useFakeTimers()` can replace
 * the global. Port delivery rides the runtime's own event loop, so faking every timer would
 * otherwise make the handshake undeliverable and every modern test vacuously "legacy".
 */
const realImmediate: typeof setImmediate = setImmediate;

/** Turn the event loop enough times for a burst of port hops to land. */
async function flush(turns = 12): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise<void>((r) => { realImmediate(() => r()); });
}

// ── the fake child document ───────────────────────────────────────────────────────────────────

const FULL_CAPABILITIES: SimRuntimeCapabilities = {
  activationScoped: true,
  managedLifecycle: true,
  onDemandRender: true,
  contextEvents: true,
  suspendable: true,
  audioControl: true,
  qualityControl: true,
};

/** Which identity axis an acknowledgement should LIE about. */
interface Distortion {
  packageRevision?: string;
  documentId?: string;
  activationId?: string;
  variantKey?: string;
  configHash?: string;
}

interface ChildOptions {
  /** Adopt the offered port. `false` models a package that does not speak v3 at all. */
  adopt?: boolean;
  /** Answer INIT_DOCUMENT with DOCUMENT_READY. */
  autoReady?: boolean;
  /** Answer PREPARE_SECTION with SECTION_APPLIED. */
  autoApplied?: boolean;
  /** Answer PRESENT_SECTION with SECTION_PRESENTED. */
  autoPresented?: boolean;
  /** What the automatic SECTION_PRESENTED claims it submitted. */
  frames?: unknown;
  /** Send SECTION_PRESENTED with no `framesSubmitted` field at all. */
  omitFrames?: boolean;
  /** Lie about one identity axis in the automatic SECTION_PRESENTED. */
  distort?: Distortion;
}

interface DocIdent {
  playerSessionId: string;
  packageRevision: string;
  documentId: string;
}

/**
 * A stand-in for the iframe DOCUMENT.
 *
 * It owns no protocol decisions: it validates the offer exactly as the shipped child runtime does,
 * adopts one port, and answers with envelopes built by the shipped `makeEnvelope`. Everything about
 * what those answers MEAN is decided by the code under test.
 */
class FakeChild {
  readonly origin: string;
  readonly el: HTMLIFrameElement;
  readonly contentWindow: { postMessage: (msg: unknown, targetOrigin?: string, transfer?: unknown[]) => void };

  /** Offers this child was actually handed (i.e. addressed to its own origin). */
  readonly offers: SimBootstrapOffer[] = [];
  /** Offers the browser would have discarded because they named another origin. */
  readonly misaddressed: string[] = [];
  /** Every v3 envelope received on the adopted port, in order. */
  readonly received: AnySimEnvelope[] = [];
  /** Every v2 `window.postMessage` command the client sent to this document. */
  readonly v2: { type: string; [k: string]: unknown }[] = [];

  port: MessagePort | null = null;
  ident: DocIdent | null = null;
  private outSeq = 0;
  private opts: Required<Omit<ChildOptions, 'distort'>> & { distort: Distortion | null };
  private readonly unadopted: MessagePort[] = [];

  constructor(src: string, opts: ChildOptions = {}) {
    this.origin = new URL(src).origin;
    this.opts = {
      adopt: opts.adopt ?? true,
      autoReady: opts.autoReady ?? true,
      autoApplied: opts.autoApplied ?? true,
      autoPresented: opts.autoPresented ?? true,
      frames: opts.frames ?? 1,
      omitFrames: opts.omitFrames ?? false,
      distort: opts.distort ?? null,
    };
    this.contentWindow = {
      postMessage: (msg, targetOrigin, transfer) => this.onPost(msg, targetOrigin, transfer),
    };
    this.el = {
      src,
      contentWindow: this.contentWindow,
      // No sandbox attribute: the document keeps a real, addressable origin (see sandboxAllowsOrigin).
      getAttribute: () => null,
    } as unknown as HTMLIFrameElement;
  }

  // ── inbound from the parent ─────────────────────────────────────────────────────────────

  private onPost(msg: unknown, targetOrigin?: string, transfer?: unknown[]): void {
    if (!isBootstrapOffer(msg)) {
      // v2 traffic — posted to '*' with no port, exactly as the shipped bridge receives it.
      this.v2.push(msg as { type: string });
      return;
    }
    // THE BROWSER'S OWN RULE, modelled: a message addressed to another origin is never delivered.
    // This is what makes a misaddressed offer indistinguishable from a package that cannot answer.
    if (targetOrigin !== this.origin) {
      this.misaddressed.push(String(targetOrigin));
      return;
    }
    // The shipped child's checks (simRuntimeChild.onBootstrap), in the same order.
    if (msg.protocolVersion !== SIM_PROTOCOL_VERSION) return;
    if (msg.parentOrigin !== window.location.origin) return;
    if (!Array.isArray(transfer) || transfer.length !== 1) return;
    this.offers.push(msg);

    const port = transfer[0] as MessagePort;
    if (!this.opts.adopt) { this.unadopted.push(port); return; }

    // ADOPT ONLY FOR A NEW EPOCH: a repeat offer for the epoch already adopted is the parent's
    // retry loop, and taking it would swap onto a port the parent is about to close.
    if (this.port && this.ident?.documentId === msg.documentId) {
      try { port.close(); } catch { /* already dead */ }
      return;
    }
    if (this.port) { try { this.port.onmessage = null; this.port.close(); } catch { /* already dead */ } }

    this.outSeq = 0;
    this.ident = {
      playerSessionId: msg.playerSessionId,
      packageRevision: msg.packageRevision,
      documentId: msg.documentId,
    };
    this.port = port;
    port.onmessage = (ev: MessageEvent) => this.onEnvelope(ev.data as AnySimEnvelope);
    port.start();
    port.postMessage({
      kind: SIM_BOOTSTRAP_ACCEPT_KIND,
      protocolVersion: SIM_PROTOCOL_VERSION,
      documentId: msg.documentId,
    });
  }

  private onEnvelope(env: AnySimEnvelope): void {
    this.received.push(env);
    switch (env.type) {
      case INIT_DOCUMENT:
        if (this.opts.autoReady) this.documentReady();
        return;
      case PREPARE_SECTION:
        if (this.opts.autoApplied) this.sectionApplied(env);
        return;
      case PRESENT_SECTION:
        if (this.opts.autoPresented) this.sectionPresented(env);
        return;
      default:
        return;
    }
  }

  // ── outbound to the parent ──────────────────────────────────────────────────────────────

  /** Build and post one envelope on the adopted port, with the next sequence number. */
  send(type: string, activation: Partial<Distortion>, payload: unknown): AnySimEnvelope {
    if (!this.port || !this.ident) throw new Error('the child has adopted no port');
    const env = makeEnvelope(type, {
      playerSessionId: this.ident.playerSessionId,
      packageRevision: activation.packageRevision ?? this.ident.packageRevision,
      documentId: activation.documentId ?? this.ident.documentId,
      activationId: activation.activationId,
      variantKey: activation.variantKey,
      configHash: activation.configHash,
    }, ++this.outSeq, payload);
    this.port.postMessage(env);
    return env;
  }

  documentReady(variants: string[] = ['A', 'B'], capabilities: SimRuntimeCapabilities = FULL_CAPABILITIES): void {
    this.send(DOCUMENT_READY, {}, { capabilities, variants });
  }

  sectionApplied(prepare: AnySimEnvelope): void {
    this.send(SECTION_APPLIED, identityOf(prepare), {
      variantKey: prepare.variantKey,
      configHash: prepare.configHash,
      applyMs: 3,
    });
  }

  /** The acknowledgement that authorises a reveal — the one message worth attacking. */
  sectionPresented(present: AnySimEnvelope, over: { frames?: unknown; omitFrames?: boolean; distort?: Distortion } = {}): AnySimEnvelope {
    const distort = over.distort ?? this.opts.distort ?? {};
    const frames = over.frames ?? this.opts.frames;
    const omit = over.omitFrames ?? this.opts.omitFrames;
    const payload: Record<string, unknown> = {
      variantKey: present.variantKey,
      configHash: present.configHash,
    };
    if (!omit) payload.framesSubmitted = frames;
    return this.send(SECTION_PRESENTED, { ...identityOf(present), ...distort }, payload);
  }

  contextLost(): void { this.send(CONTEXT_LOST, {}, { contextKind: 'webgl' }); }

  suspended(): void { this.send(DOCUMENT_SUSPENDED, {}, { counts: ZERO_RESOURCE_COUNTS, unstoppable: [] }); }

  /** The confirmation the parent ignored entirely until this session — see the RESUMED test. */
  resumed(): void { this.send(DOCUMENT_RESUMED, {}, {}); }

  /** A document that missed the first handshake and is ready to answer the next offer. */
  startAdopting(): void { this.opts = { ...this.opts, adopt: true }; }

  /**
   * Re-post an envelope this child sent earlier, with a FRESH sequence number.
   *
   * The sequence number is deliberately renewed: replaying the original bytes would be rejected by
   * the transport as `duplicate-seq`, which proves nothing about whether the ACTIVATION identity is
   * checked. This delivers a message that is valid in every respect except the one under test.
   */
  replay(env: AnySimEnvelope): void {
    if (!this.port) throw new Error('the child has adopted no port');
    this.port.postMessage({ ...env, seq: ++this.outSeq });
  }

  /** The last envelope of a given type this child received. */
  last(type: string): AnySimEnvelope {
    const found = [...this.received].reverse().find((e) => e.type === type);
    if (!found) throw new Error(`the child never received a ${type} (saw: ${this.types().join(', ') || 'nothing'})`);
    return found;
  }

  types(): string[] { return this.received.map((e) => e.type); }

  close(): void {
    for (const p of this.unadopted) { try { p.close(); } catch { /* already dead */ } }
    this.unadopted.length = 0;
    if (this.port) { try { this.port.onmessage = null; this.port.close(); } catch { /* already dead */ } }
    this.port = null;
  }
}

const identityOf = (env: AnySimEnvelope): Distortion => ({
  activationId: env.activationId,
  variantKey: env.variantKey,
  configHash: env.configHash,
});

// ── harness ───────────────────────────────────────────────────────────────────────────────────

const CHILD_ORIGIN = 'http://sim.example';
const SRC = `${CHILD_ORIGIN}/sim-public/pkg/index.html?section=A&v=1`;
const PLAYER_SESSION = 'ps-modern-suite';
const PACKAGE_REVISION = 'rev-abcdef0123456789';

interface Tel { event: string; detail: Record<string, unknown> }

interface Harness {
  c: SimRuntimeClient;
  child: FakeChild;
  tel: Tel[];
  states: SimRuntimeState[];
}

const clients: SimRuntimeClient[] = [];
const children: FakeChild[] = [];

interface BootOptions {
  child?: ChildOptions;
  /** The stored documentKey, when it must differ from the frame's own src. */
  documentKey?: string;
  /** Deliver the v2 SIM_READY/SIM_PAINTED a regenerated package also sends. */
  v2?: boolean;
  /** Skip enableModern (used by the classification test, which calls it itself). */
  arm?: boolean;
  packageClass?: (typeof PACKAGE_CLASS_ORDER)[number];
}

/** Build a client bound to a fake child. Does NOT wait for the handshake. */
function build(opts: BootOptions = {}): Harness {
  const child = new FakeChild(SRC, opts.child);
  const tel: Tel[] = [];
  const states: SimRuntimeState[] = [];
  const c = new SimRuntimeClient({
    onTelemetry: (event, detail) => tel.push({ event, detail: (detail ?? {}) as Record<string, unknown> }),
    onState: (s) => states.push({ ...s }),
  });
  clients.push(c);
  children.push(child);
  c.attach(child.el, opts.documentKey ?? SRC);
  if (opts.arm !== false) {
    c.enableModern({
      playerSessionId: PLAYER_SESSION,
      packageRevision: PACKAGE_REVISION,
      packageClass: opts.packageClass ?? 'managed-presentable',
    });
  }
  return { c, child, tel, states };
}

/**
 * Build, and drive the handshake to a document that accepts commands.
 *
 * The v2 hello/paint of a REGENERATED package (which carries both listeners) is delivered AFTER the
 * handshake on purpose: delivered before it, the paint would reach a client whose transport has not
 * settled and be revealed down the v2 path, which is a different scenario — and one that would make
 * every later "nothing was revealed" assertion meaningless.
 */
async function boot(opts: BootOptions = {}): Promise<Harness> {
  const h = build(opts);
  await flush();
  if (opts.v2) {
    fromChild(h.child, { type: SIM_READY, dispatch: 'dynamic' });
    fromChild(h.child, { type: SIM_PAINTED });
  }
  return h;
}

/** Deliver a v2 child→parent message on the window, from this document. */
function fromChild(child: FakeChild, data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', {
    data,
    origin: child.origin,
    source: child.contentWindow as unknown as Window,
  }));
}

const events = (tel: Tel[]): string[] => tel.map((t) => t.event);
const lastTel = (tel: Tel[], event: string): Tel | undefined => [...tel].reverse().find((t) => t.event === event);
const countTel = (tel: Tel[], event: string): number => tel.filter((t) => t.event === event).length;
const v2Types = (child: FakeChild): string[] => child.v2.map((m) => m.type);

/** The configuration `activateModern` derives when the owner passes none. */
const configFor = (params?: { simpleUi?: boolean; hideSelectors?: string[]; autoScript?: boolean }): SimPresentationConfig => ({
  ...DEFAULT_PRESENTATION_CONFIG,
  simpleUi: !!params?.simpleUi,
  hideSelectors: params?.hideSelectors ?? [],
  autoScript: params?.autoScript !== false,
  quality: 'high',
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const c of clients) c.dispose();
  clients.length = 0;
  for (const ch of children) ch.close();
  children.length = 0;
  vi.useRealTimers();
});

// ══ 1. ARMING ════════════════════════════════════════════════════════════════════════════════

describe('enableModern — capability is what the CANARY proved, not what the package claims', () => {
  it('offers a bootstrap for exactly one package class, and declines the other four', async () => {
    const opened: string[] = [];
    const declined: string[] = [];

    for (const packageClass of PACKAGE_CLASS_ORDER) {
      const h = build({ packageClass });
      await flush();
      if (h.child.offers.length > 0) opened.push(packageClass);
      const declineTel = lastTel(h.tel, 'modern-declined');
      if (declineTel) {
        declined.push(packageClass);
        expect(declineTel.detail.packageClass, 'the decline must name the class it refused').toBe(packageClass);
      }
      // A declined class must leave the modern path completely inert — not merely unadopted.
      const modern = h.c.getModernState();
      if (packageClass !== 'managed-presentable') {
        expect(modern.active, `${packageClass} reached the modern path`).toBe(false);
        expect(modern.documentState, `${packageClass} mounted a document epoch`).toBe('UNMOUNTED');
        expect(h.child.received, `${packageClass} was sent v3 traffic`).toEqual([]);
      }
    }

    expect(PACKAGE_CLASS_ORDER.length, 'a new package class must be classified here explicitly').toBe(5);
    expect(opened).toEqual(['managed-presentable']);
    expect(declined).toEqual(['managed-partial', 'legacy-cooperative', 'legacy-opaque', 'failed']);
  });

  it('a canary-proven package handshakes: one offer, one port, INIT_DOCUMENT, then DOCUMENT_READY', async () => {
    const { c, child, tel } = await boot();

    expect(child.offers.length, 'the retry loop minted more than the one offer the child answered').toBe(1);
    expect(child.offers[0].playerSessionId).toBe(PLAYER_SESSION);
    expect(child.offers[0].packageRevision).toBe(PACKAGE_REVISION);
    expect(child.offers[0].parentOrigin, 'the offer must name the parent origin the child validates').toBe(window.location.origin);

    // The port being live is NOT readiness: INIT_DOCUMENT is what asks, DOCUMENT_READY is what answers.
    expect(child.types()).toEqual([INIT_DOCUMENT]);
    const init = child.last(INIT_DOCUMENT).payload as { audible: { muted: boolean }; quality: string };
    expect(init.audible.muted, 'a document is born silent').toBe(true);

    expect(c.modernActive()).toBe(true);
    expect(c.getModernState().documentState).toBe('DOCUMENT_READY');
    expect(events(tel)).toContain('modern-document-ready');
    expect(c.getState().visible, 'a ready document is not a presented one').toBe(false);
  });

  it('the offer is addressed to the FRAME’s src, never to a stale stored documentKey', async () => {
    // The production drift: a stored sim URL carries whatever API origin minted it, and resolveSimUrl
    // rebases it onto this environment's origin before assigning it. Addressing the stale value means
    // the browser silently discards the offer — port and all — and the package is misreported as
    // legacy on every environment that is not the one the row was saved under.
    const { c, child } = await boot({ documentKey: 'http://api-from-another-environment.example/sim-public/pkg/index.html?section=A&v=1' });

    expect(child.misaddressed, 'an offer was addressed to an origin the document is not at').toEqual([]);
    expect(child.offers.length, 'the child was never handed an offer it could adopt').toBe(1);
    expect(c.modernActive(), 'the handshake did not complete for a frame whose stored key drifted').toBe(true);

    // …and it is a WORKING transport, not merely an adopted one.
    c.activate({ script: 'A' });
    await flush();
    expect(c.getState().visible).toBe(true);
  });

  it('is safe to call on every render: an unchanged setup never touches a live transport', async () => {
    const { c, child } = await boot();
    c.activate({ script: 'A' });
    await flush();
    const before = { offers: child.offers.length, epoch: child.offers[0].documentId, types: child.types().length };
    expect(c.getState().visible).toBe(true);

    c.enableModern({
      playerSessionId: PLAYER_SESSION,
      packageRevision: PACKAGE_REVISION,
      packageClass: 'managed-presentable',
    });
    await flush();

    expect(child.offers.length, 'a re-render re-offered a bootstrap and minted a new epoch').toBe(before.offers);
    expect(child.offers[0].documentId).toBe(before.epoch);
    expect(child.types().length, 'a re-render sent the document new traffic').toBe(before.types);
    expect(c.getState().visible, 'a re-render tore down a live presentation').toBe(true);
    expect(c.getModernState().activationState).toBe('VISIBLE');
  });

  it('a canary-proven package that settled LEGACY is a failed handshake, and is retried', async () => {
    // Without this, one missed handshake left the modern path dead for the rest of the session —
    // and enableModern already refused everything below managed-presentable, so by construction
    // this document DOES speak v3.
    const { c, child, tel } = await boot({ child: { adopt: false } });
    vi.advanceTimersByTime(SIM_BOOTSTRAP_TIMEOUT_MS + 50);
    await flush();
    expect(c.modernActive(), 'the handshake was supposed to fail here').toBe(false);
    const missedOffers = child.offers.length;
    expect(missedOffers, 'the child was never offered anything').toBeGreaterThan(0);

    child.startAdopting();
    c.enableModern({
      playerSessionId: PLAYER_SESSION,
      packageRevision: PACKAGE_REVISION,
      packageClass: 'managed-presentable',
    });
    await flush();

    expect(events(tel)).toContain('modern-retry-handshake');
    expect(child.offers.length, 'no fresh offer was made after the failed handshake').toBeGreaterThan(missedOffers);
    expect(
      child.offers[child.offers.length - 1].documentId,
      'the retry must mint a NEW epoch — the child will not adopt a second offer for one it saw',
    ).not.toBe(child.offers[0].documentId);
    expect(c.modernActive(), 'the modern path stayed dead after a recoverable handshake failure').toBe(true);
  });

  it('a transport that has adopted a port is NOT yet modern — commands wait for DOCUMENT_READY', async () => {
    const { c, child } = await boot({ child: { autoReady: false } });

    // The port is live: the child adopted it and was asked to initialise.
    expect(child.port, 'the child adopted no port — this proves nothing about readiness').not.toBeNull();
    expect(child.types()).toEqual([INIT_DOCUMENT]);
    expect(c.modernActive(), 'an uninitialised document accepted commands').toBe(false);
    expect(c.getModernState().documentState).toBe('MOUNTING');

    c.activate({ script: 'A' });
    await flush();
    expect(child.types(), 'an activation-scoped command was sent to a document that cannot accept it')
      .not.toContain(PREPARE_SECTION);

    // The deferral now covers this window too. Running v2 here applied the body ONCE OUTSIDE the
    // managed scope — untracked timers, untracked listeners — and then PREPARE_SECTION applied the
    // same body again when readiness landed two hops later. So: no startScript in the gap, a hold
    // in place, and exactly one application, on the modern path, once the document is ready.
    expect(v2Types(child), 'the v2 path ran during the adopted-but-not-ready window').not.toContain(START_SCRIPT);
    expect(c.getState().visible, 'nothing may be shown while the deferral holds').toBe(false);

    child.documentReady();
    await flush();
    expect(c.modernActive()).toBe(true);
    expect(child.types(), 'the pending activation was never re-driven onto the modern path').toContain(PREPARE_SECTION);
    expect(
      child.types().filter((t) => t === PREPARE_SECTION).length,
      'the deferral exists to make the application happen exactly once',
    ).toBe(1);
    expect(v2Types(child), 'v2 must never have run for this activation at all').not.toContain(START_SCRIPT);
  });
});

// ══ 2. THE HAPPY PATH ════════════════════════════════════════════════════════════════════════

describe('the activation sequence — visible only after the MATCHED acknowledgement', () => {
  it('prepare → applied → present → presented → reveal, with nothing shown before the last step', async () => {
    const { c, child, tel, states } = await boot({ child: { autoApplied: false, autoPresented: false } });

    c.activate({ script: 'A', params: { simpleUi: true, hideSelectors: ['.panel'] } });
    await flush();

    const prepare = child.last(PREPARE_SECTION);
    expect(prepare.variantKey).toBe('A');
    expect(prepare.packageRevision).toBe(PACKAGE_REVISION);
    expect(prepare.documentId).toBe(child.offers[0].documentId);
    expect(
      prepare.configHash,
      'the configuration the child is asked for must be the one the identity hashes',
    ).toBe(computeConfigHash(configFor({ simpleUi: true, hideSelectors: ['.panel'] })));
    expect((prepare.payload as { config: SimPresentationConfig }).config.simpleUi).toBe(true);
    expect(c.getModernState().activationState).toBe('PREPARING');
    expect(c.getState().phase).toBe('awaiting-ack');
    expect(c.getState().visible, 'the incoming section was presented before it was even applied').toBe(false);

    child.sectionApplied(prepare);
    await flush();
    expect(child.types()).toContain(PRESENT_SECTION);
    expect(c.getModernState().activationState).toBe('RENDERING');
    expect(c.getState().visible, 'APPLIED is not PRESENTED — a body that installed has drawn nothing').toBe(false);

    child.sectionPresented(child.last(PRESENT_SECTION));
    await flush();
    expect(c.getState().visible, 'the acknowledged activation was never revealed').toBe(true);
    expect(c.getState().phase).toBe('visible');
    expect(c.getState().interactive).toBe(true);
    expect(c.getModernState().activationState).toBe('VISIBLE');
    expect(child.types(), 'the reveal must tell the child it is live').toContain(ACTIVATE_SECTION);

    // Order is the claim, not mere presence.
    expect(child.types()).toEqual([INIT_DOCUMENT, PREPARE_SECTION, PRESENT_SECTION, ACTIVATE_SECTION]);
    const order = events(tel);
    expect(order.indexOf('modern-prepare')).toBeLessThan(order.indexOf('modern-section-applied'));
    expect(order.indexOf('modern-section-applied')).toBeLessThan(order.indexOf('modern-section-presented'));
    expect(order.indexOf('modern-section-presented')).toBeLessThan(order.lastIndexOf('reveal'));
    expect(lastTel(tel, 'modern-section-presented')?.detail.frames).toBe(1);

    // The modern path must NOT also drive the v2 bridge: a regenerated package carries both
    // listeners, and applying the body twice puts one copy outside the managed scope.
    expect(v2Types(child), 'the same section was applied on both protocols').not.toContain(START_SCRIPT);
    expect(c.getModernState().failure).toBeNull();
    expect(c.getModernState().breakerOpen).toBe(false);

    // The React layer reads this through the subscription, not by polling getState().
    expect(states.filter((s) => s.visible).length, 'the reveal was never published to subscribers').toBeGreaterThan(0);
    expect(states[states.length - 1], 'the published state drifted from the client’s own').toEqual(c.getState());
  });

  it('a section switch releases the outgoing activation before preparing the next', async () => {
    const { c, child } = await boot();
    c.activate({ script: 'A' });
    await flush();
    const first = child.last(PREPARE_SECTION).activationId;

    c.activate({ script: 'B' });
    await flush();
    const release = child.received.find((e) => e.type === RELEASE_SECTION);
    expect(release, 'the outgoing activation was left registered — this is how a pool grows without bound').toBeDefined();
    expect(release!.activationId, 'the release named the wrong activation').toBe(first);
    expect(child.last(PREPARE_SECTION).activationId, 'a re-entry must be a NEW activation').not.toBe(first);
    expect(c.getState().visible).toBe(true);
  });
});

// ══ 3. THE REVEAL INVARIANT ══════════════════════════════════════════════════════════════════

describe('reveal refusals — the five axes, and the two document conditions', () => {
  /** Drive one activation to the point of acknowledgement, then let the child lie about one axis. */
  async function ackWith(distort: Distortion): Promise<Harness> {
    const h = await boot({ child: { autoPresented: false } });
    h.c.activate({ script: 'A' });
    await flush();
    h.child.sectionPresented(h.child.last(PRESENT_SECTION), { distort });
    await flush();
    return h;
  }

  it('an HONEST acknowledgement reveals — the control for every refusal below', async () => {
    const h = await ackWith({});
    expect(h.c.getState().visible).toBe(true);
  });

  it('a wrong activationId is not this activation (A → B → A is only safe because of this)', async () => {
    const h = await ackWith({ activationId: 'act_someone_else' });
    expect(h.c.getState().visible).toBe(false);
    expect(events(h.tel)).toContain('modern-stale-presented');
  });

  it('a wrong variantKey is a different sub-simulation', async () => {
    const h = await ackWith({ variantKey: 'B' });
    expect(h.c.getState().visible).toBe(false);
    expect(events(h.tel)).toContain('modern-stale-presented');
  });

  it('a wrong configHash is a different picture', async () => {
    const h = await ackWith({ configHash: 'deadbeefdeadbeef' });
    expect(h.c.getState().visible).toBe(false);
    expect(events(h.tel)).toContain('modern-stale-presented');
  });

  it('a wrong documentId is another epoch and never reaches the client at all', async () => {
    const h = await ackWith({ documentId: 'doc_a_previous_epoch' });
    expect(h.c.getState().visible).toBe(false);
    expect(lastTel(h.tel, 'modern-rejected')?.detail.reason, 'the transport must name what it refused')
      .toBe('unknown-document');
  });

  it('a wrong packageRevision is refused BY THE REVEAL GATE — the axis nothing else compares', async () => {
    // This is the one that proves the gate is not a tautology. `matchesActivation` deliberately
    // covers only three axes and the transport only checks that packageRevision is present, so this
    // acknowledgement reaches `activationReducer` and PRESENTS the activation. The refusal can only
    // come from `mayReveal` comparing the ACK's identity against the live intent — which is exactly
    // what recording `act.identity` instead of the ack's identity would make impossible.
    const h = await ackWith({ packageRevision: 'rev-from-a-republished-package' });
    expect(h.c.getState().visible, 'an acknowledgement from another package revision revealed').toBe(false);
    expect(lastTel(h.tel, 'modern-reveal-refused')?.detail.refusal).toBe('package-revision-mismatch');
    expect(events(h.tel), 'the reveal gate never ran — the ack was refused earlier than intended')
      .toContain('modern-section-presented');
  });

  it('a v2 SIM_PAINTED can never reveal a modern document (refusal: not-presented)', async () => {
    const { c, child, tel } = await boot({ v2: true, child: { autoPresented: false } });
    // The boot paint arrived before any activation existed — refused for exactly that reason.
    expect(lastTel(tel, 'modern-reveal-refused')?.detail.refusal).toBe('no-activation');
    expect(c.getState().visible).toBe(false);

    c.activate({ script: 'A' });
    await flush();

    fromChild(child, { type: SIM_PAINTED });
    expect(c.getState().painted, 'the paint never reached the client — this proves nothing').toBe(true);
    expect(c.getState().visible, 'a paint authorised a reveal on the modern path').toBe(false);
    expect(lastTel(tel, 'modern-reveal-refused')?.detail.refusal).toBe('not-presented');

    // …and the honest acknowledgement still reveals, so the refusal cost nothing.
    child.sectionPresented(child.last(PRESENT_SECTION));
    await flush();
    expect(c.getState().visible).toBe(true);
  });

  it('an owner-forced present() cannot bypass the modern gate', async () => {
    const { c, tel } = await boot({ v2: true, child: { autoPresented: false } });
    c.activate({ script: 'A' });
    await flush();

    c.present();     // reveal(force: true) — the v2 escape hatch
    expect(c.getState().visible, 'force revealed a modern activation with no acknowledgement').toBe(false);
    expect(lastTel(tel, 'modern-reveal-refused')?.detail).toMatchObject({ refusal: 'not-presented', forced: true });
  });

  it('a lost context invalidates the presentation, and the acknowledgement after it is refused', async () => {
    const { c, child, tel } = await boot({ child: { autoPresented: false } });
    c.activate({ script: 'A' });
    await flush();

    child.contextLost();
    await flush();
    expect(c.getModernState().contextLost).toBe(true);

    child.sectionPresented(child.last(PRESENT_SECTION));
    await flush();
    expect(c.getState().visible, 'a frame submitted into a lost context was revealed').toBe(false);
    expect(lastTel(tel, 'modern-reveal-refused')?.detail.refusal).toBe('context-lost');
  });

  it('a context lost AFTER the reveal takes the frame down', async () => {
    const { c, child } = await boot();
    c.activate({ script: 'A' });
    await flush();
    expect(c.getState().visible).toBe(true);

    child.contextLost();
    await flush();
    expect(c.getState().visible, 'undefined canvas content was left on screen').toBe(false);
    expect(c.getState().interactive).toBe(false);
  });

  it('a document that has confirmed SUSPENDED stops accepting activation commands', async () => {
    // `mayReveal`'s OTHER document condition is `documentReady`, and this is the predicate behind
    // it: `acceptsCommands(docMachine)`. It cannot produce a `document-not-ready` REFUSAL at
    // reveal()'s call site, because reveal() enters the modern branch only when `modernActive()` —
    // which reads the very same predicate — is already true. What is observable is the condition
    // itself, and that every command gated on it stops.
    const { c, child } = await boot({ child: { autoPresented: false } });
    c.activate({ script: 'A' });
    await flush();
    expect(c.modernActive()).toBe(true);

    c.freeze();
    child.suspended();
    await flush();

    expect(c.getModernState().documentState).toBe('SUSPENDED');
    expect(c.getModernState().active, 'a suspended document still claimed it accepts commands').toBe(false);

    const before = child.types().length;
    c.setQuality('low');
    c.resumeAutomation();
    await flush();
    expect(child.types().length, 'commands were sent to a document that cannot accept them').toBe(before);
  });

  it('an acknowledgement before any activation exists is refused, not remembered', async () => {
    const { c, child, tel } = await boot({ child: { autoPresented: false } });
    // No activate() at all: nothing has been prepared, so there is no intent to match.
    child.send(SECTION_PRESENTED, {
      activationId: 'act_invented',
      variantKey: 'A',
      configHash: 'cafecafecafecafe',
    }, { variantKey: 'A', configHash: 'cafecafecafecafe', framesSubmitted: 4 });
    await flush();
    expect(c.getState().visible).toBe(false);
    expect(events(tel)).toContain('modern-stale-presented');
    expect(c.getModernState().activationState).toBe('none');
  });
});

// ══ 4. THE FRAME GUARD ═══════════════════════════════════════════════════════════════════════

describe('SECTION_PRESENTED must claim a submitted frame', () => {
  const cases: { what: string; over: { frames?: unknown; omitFrames?: boolean } }[] = [
    { what: 'a count of zero', over: { frames: 0 } },
    { what: 'no count at all', over: { omitFrames: true } },
    { what: 'a negative count', over: { frames: -1 } },
    { what: 'a non-numeric count', over: { frames: 'lots' } },
    { what: 'a NaN count', over: { frames: Number.NaN } },
  ];

  for (const { what, over } of cases) {
    it(`refuses ${what} — and the honest acknowledgement that follows still reveals`, async () => {
      const { c, child, tel } = await boot({ child: { autoPresented: false } });
      c.activate({ script: 'A' });
      await flush();

      const present = child.last(PRESENT_SECTION);
      child.sectionPresented(present, over);
      await flush();
      expect(c.getState().visible, `${what} was accepted as a presentation`).toBe(false);
      expect(
        events(tel),
        'the acknowledgement was refused somewhere other than the frame guard',
      ).toContain('modern-presented-without-frame');
      expect(c.getModernState().activationState, 'a refused ack must not advance the activation').toBe('RENDERING');

      // NON-VACUITY: the ONLY thing wrong was the count.
      child.sectionPresented(present, { frames: 1 });
      await flush();
      expect(c.getState().visible).toBe(true);
    });
  }
});

// ══ 5. A → B → A ═════════════════════════════════════════════════════════════════════════════

describe('A → B → A: a replayed acknowledgement from the FIRST A', () => {
  it('re-entering A is a NEW activation, and the old one’s ack no longer names it', async () => {
    // A token distinguishes the second A from the first only while the parent's counter has not
    // been reset, and says nothing after a document reload. An activation id does.
    const { c, child, tel } = await boot();

    c.activate({ script: 'A' });
    await flush();
    expect(c.getState().visible).toBe(true);
    const a1 = child.last(PREPARE_SECTION);

    c.activate({ script: 'B' });
    await flush();
    c.activate({ script: 'A' });
    await flush();
    const a2 = child.last(PREPARE_SECTION);

    expect(a2.activationId, 'the two entries into A must be different activations').not.toBe(a1.activationId);
    expect(a2.variantKey, 'and they agree on everything else — which is the whole difficulty').toBe(a1.variantKey);
    expect(a2.configHash).toBe(a1.configHash);
    expect(a2.documentId).toBe(a1.documentId);

    // The first A's acknowledgement, replayed against the third activation.
    const before = countTel(tel, 'modern-stale-presented');
    child.send(SECTION_PRESENTED, identityOf(a1), {
      variantKey: a1.variantKey,
      configHash: a1.configHash,
      framesSubmitted: 7,
    });
    await flush();

    expect(
      countTel(tel, 'modern-stale-presented'),
      'the replay was never delivered — this test proved nothing',
    ).toBeGreaterThan(before);
    // The live activation is untouched: still VISIBLE by its OWN acknowledgement, not by the replay.
    expect(c.getModernState().activationState).toBe('VISIBLE');
  });

  it('a replay arriving while the third activation is still unacknowledged cannot reveal it', async () => {
    const { c, child, tel } = await boot({ child: { autoPresented: false } });

    c.activate({ script: 'A' });
    await flush();
    const a1Present = child.last(PRESENT_SECTION);
    const a1Ack = child.sectionPresented(a1Present);        // A1 acknowledged and revealed
    await flush();
    expect(c.getState().visible).toBe(true);

    c.activate({ script: 'B' });
    await flush();
    child.sectionPresented(child.last(PRESENT_SECTION));
    await flush();

    c.activate({ script: 'A' });                             // third activation, unacknowledged
    await flush();
    expect(c.getState().visible, 'the switch was not hidden while the incoming section applies').toBe(false);

    const before = countTel(tel, 'modern-stale-presented');
    child.replay(a1Ack);                                     // the first A's ack, fresh seq
    await flush();

    expect(countTel(tel, 'modern-stale-presented'), 'the replay never arrived').toBeGreaterThan(before);
    expect(c.getState().visible, 'a stale acknowledgement revealed the live activation').toBe(false);

    child.sectionPresented(child.last(PRESENT_SECTION));
    await flush();
    expect(c.getState().visible, 'the live acknowledgement must still work').toBe(true);
  });
});

// ══ 6. RELEASED ACTIVATIONS ══════════════════════════════════════════════════════════════════

describe('an acknowledgement for a RELEASED activation', () => {
  it('is refused, and does NOT report success or reset the breaker', async () => {
    const { c, child, tel } = await boot({ child: { autoApplied: false } });

    // One real failure first, so there is a breaker state a false success could destroy.
    c.activate({ script: 'A' });
    await flush();
    const present = { ...child.last(PREPARE_SECTION) };      // identity of the activation being failed
    vi.advanceTimersByTime(SIM_PREPARE_TIMEOUT_MS + 10);
    await flush();
    expect(c.getModernState().failure?.kind).toBe('prepare-timeout');

    c.deactivate({ teardown: false });
    await flush();
    expect(c.getModernState().activationState).toBe('RELEASED');

    // The child answers late, with an identity that still matches on all three checked axes.
    child.send(SECTION_PRESENTED, identityOf(present), {
      variantKey: present.variantKey,
      configHash: present.configHash,
      framesSubmitted: 3,
    });
    await flush();

    expect(c.getState().visible, 'a released activation was revealed').toBe(false);
    expect(lastTel(tel, 'modern-presented-refused')?.detail.state, 'the refusal must name the state that refused')
      .toBe('RELEASED');
    expect(events(tel), 'a refused presentation was reported as a successful one')
      .not.toContain('modern-section-presented');
    expect(
      c.getModernState().failure,
      'the refused acknowledgement cleared a failure that was never resolved',
    ).not.toBeNull();

    // …and the breaker's COUNT survived it: two more failures are enough to open it, which they
    // would not be if the refused acknowledgement had reset the count to zero.
    for (let i = 1; i < SIM_BREAKER_THRESHOLD; i++) {
      c.activate({ script: 'A' });
      await flush();
      vi.advanceTimersByTime(SIM_PREPARE_TIMEOUT_MS + 10);
      await flush();
    }
    expect(
      c.getModernState().breakerOpen,
      'the breaker forgot the failures that preceded the refused acknowledgement',
    ).toBe(true);
  });
});

// ══ 7. BOUNDED FAILURE ═══════════════════════════════════════════════════════════════════════

describe('timeouts are FAILURES, never reveals', () => {
  it('prepare-timeout: a bounded, described failure and nothing on screen', async () => {
    const { c, child, tel } = await boot({ v2: true, child: { autoApplied: false } });
    c.activate({ script: 'A' });
    await flush();
    expect(child.types()).toContain(PREPARE_SECTION);

    vi.advanceTimersByTime(SIM_PREPARE_TIMEOUT_MS - 50);
    await flush();
    expect(c.getModernState().failure, 'the bound fired early').toBeNull();

    vi.advanceTimersByTime(100);
    await flush();
    const failure = c.getModernState().failure;
    expect(failure?.kind).toBe('prepare-timeout');
    expect(failure?.attempt).toBe(1);
    expect(failure?.actions.length, 'a failure with no action is a dead end the user cannot leave').toBeGreaterThan(0);
    expect(failure?.breakerOpen).toBe(false);
    expect(c.getState().phase).toBe('failed');
    expect(c.getState().visible, 'a timeout showed a frame nothing vouched for').toBe(false);
    expect(events(tel), 'a modern timeout must never force a reveal').not.toContain('reveal-forced');
    expect(events(tel)).not.toContain('reveal');
    // A document that is still running something the user must not hear is silenced.
    expect(v2Types(child)).toContain(SIM_PAUSE);
    expect(v2Types(child)).toContain(SIM_MUTE);
  });

  it('present-timeout: the applied-but-never-drawn package fails instead of being shown', async () => {
    const { c, child, tel } = await boot({ v2: true, child: { autoPresented: false } });
    c.activate({ script: 'A' });
    await flush();
    expect(child.types()).toContain(PRESENT_SECTION);

    vi.advanceTimersByTime(Math.max(SIM_PREPARE_TIMEOUT_MS, SIM_PRESENT_TIMEOUT_MS) + 10);
    await flush();
    // The KIND is the assertion. The prepare bound was armed FIRST, so if SECTION_APPLIED had not
    // cleared it, it — not the present bound — is what would have fired, and this would read
    // 'prepare-timeout'. One failure, and it names the step that actually went unanswered.
    expect(c.getModernState().failure?.kind).toBe('present-timeout');
    expect(countTel(tel, 'modern-failure'), 'both bounds fired — one of them was never cleared').toBe(1);
    expect(c.getState().visible, 'the package promised SECTION_PRESENTED; waiting is not evidence').toBe(false);
    expect(events(tel)).not.toContain('reveal');
    expect(events(tel)).not.toContain('reveal-forced');
  });

  it('a duplicate SECTION_APPLIED does not arm a second present timeout', async () => {
    // `SECTION_APPLIED` calls `sendPresent()` unconditionally after `matchesActivation`, which
    // compares only activationId/variantKey/configHash — so a REPEAT of the same envelope with a
    // fresh `seq` passes both it and `validateEnvelope`. The reducer then refuses the illegal
    // transition by returning the SAME state object rather than throwing, so nothing upstream
    // notices. Without clearing first, the second `setTimeout` overwrote the handle: the first
    // timer became unclearable while its own guard (generation + activationId) still passed, so it
    // later fired `present-timeout` against an activation that HAD presented — hiding a working
    // simulation behind the recovery surface.
    const { c, child, tel } = await boot({ v2: true, child: { autoPresented: false } });
    c.activate({ script: 'A' });
    await flush();
    const prepare = child.last(PREPARE_SECTION);

    child.sectionApplied(prepare);
    await flush();
    child.sectionApplied(prepare);          // the duplicate
    await flush();

    // It DID present — so no timeout may fire for it.
    child.sectionPresented(child.last(PRESENT_SECTION));
    await flush();
    expect(c.getState().visible).toBe(true);

    vi.advanceTimersByTime(SIM_PRESENT_TIMEOUT_MS * 2 + 10);
    await flush();
    expect(countTel(tel, 'modern-failure'),
      'an orphaned present timer fired against an activation that already presented').toBe(0);
    expect(c.getState().visible, 'the presented simulation was hidden by a stale timeout').toBe(true);
  });

  /**
   * A LATE SECTION_APPLIED FOR AN ACTIVATION THAT HAS MOVED ON.
   *
   * `matchesActivation` compares identity only, never state, so a SECTION_APPLIED that arrives
   * after the activation reached a state where APPLIED is illegal still passes it. The reducer
   * refuses by returning the SAME state object; treating that as success posted PRESENT_SECTION and
   * armed the TERMINAL present bound, whose only guard is (generation, activationId) — neither
   * changed by a refusal. Five seconds later it fired `failModern('present-timeout')`.
   *
   * All three reachable shapes are covered because the damage differs in each.
   */
  describe('a SECTION_APPLIED the reducer refuses cannot arm the terminal present bound', () => {
    it('FAILED: one real fault is not counted twice, and keeps its true failure kind', async () => {
      const { c, child, tel } = await boot({ v2: true, child: { autoApplied: false } });
      c.activate({ script: 'A' });
      await flush();
      const prepare = child.last(PREPARE_SECTION);

      // The prepare bound fires first — this is the ONE real fault.
      vi.advanceTimersByTime(SIM_PREPARE_TIMEOUT_MS + 10);
      await flush();
      expect(c.getModernState().failure?.kind).toBe('prepare-timeout');
      const failuresAfterRealFault = countTel(tel, 'modern-failure');

      // The slow package finishes and acks the SAME activation.
      child.sectionApplied(prepare);
      await flush();
      // THE ENVELOPE MUST ACTUALLY REACH THE REFUSAL. Without this the test would pass for the
      // wrong reason — a harness that silently drops the late ack proves nothing about the guard.
      expect(events(tel), 'the late SECTION_APPLIED never reached the handler, so this test would '
        + 'pass even with the guard removed').toContain('modern-applied-refused');
      expect(child.types().filter((t) => t === PRESENT_SECTION),
        'PRESENT_SECTION was posted for a FAILED activation').toHaveLength(0);

      vi.advanceTimersByTime(SIM_PRESENT_TIMEOUT_MS * 2 + 10);
      await flush();
      expect(countTel(tel, 'modern-failure'),
        'a fabricated present-timeout was recorded on top of the one real fault')
        .toBe(failuresAfterRealFault);
      expect(c.getModernState().failure?.kind,
        'the true prepare-timeout was overwritten by a fabricated present-timeout')
        .toBe('prepare-timeout');
    });

    it('RELEASED: scrubbing away mid-apply does not fail the package afterwards', async () => {
      const { c, child, tel } = await boot({ v2: true, child: { autoApplied: false } });
      c.activate({ script: 'A' });
      await flush();
      const prepare = child.last(PREPARE_SECTION);

      c.deactivate({ teardown: false });          // viewer moved on while the child was applying
      await flush();

      child.sectionApplied(prepare);
      await flush();
      vi.advanceTimersByTime(SIM_PRESENT_TIMEOUT_MS * 2 + 10);
      await flush();
      expect(countTel(tel, 'modern-failure'),
        'a released activation was failed by a bound armed after its release').toBe(0);
    });

    it('VISIBLE: a re-ack cannot hide a simulation that is already on screen', async () => {
      const { c, child, tel } = await boot({ v2: true });
      c.activate({ script: 'A' });
      await flush();
      const prepare = child.last(PREPARE_SECTION);
      expect(c.getState().visible).toBe(true);
      const failuresWhileHealthy = countTel(tel, 'modern-failure');

      child.sectionApplied(prepare);              // the package re-acks an activation already shown
      await flush();
      vi.advanceTimersByTime(SIM_PRESENT_TIMEOUT_MS * 2 + 10);
      await flush();

      expect(countTel(tel, 'modern-failure'),
        'a re-ack armed a bound that then failed a healthy activation').toBe(failuresWhileHealthy);
      expect(c.getState().visible,
        'a working, on-screen simulation was hidden behind the recovery surface').toBe(true);
    });
  });

  it('a superseded activation’s bound cannot fail the one that replaced it', async () => {
    const { c, child } = await boot({ child: { autoApplied: false } });
    c.activate({ script: 'A' });
    await flush();
    vi.advanceTimersByTime(SIM_PREPARE_TIMEOUT_MS - 50);

    c.activate({ script: 'B' });                 // supersedes A, arms its own bound
    await flush();
    vi.advanceTimersByTime(100);                 // A's original deadline passes
    await flush();
    expect(c.getModernState().failure, 'A’s bound failed B').toBeNull();
    expect(child.last(PREPARE_SECTION).variantKey).toBe('B');

    vi.advanceTimersByTime(SIM_PREPARE_TIMEOUT_MS);
    await flush();
    expect(c.getModernState().failure?.kind, 'B’s own bound must still fire').toBe('prepare-timeout');
  });
});

describe('the circuit breaker', () => {
  it(`opens after ${SIM_BREAKER_THRESHOLD} failures, and retryModern then refuses`, async () => {
    const { c, tel } = await boot({ child: { autoApplied: false } });

    c.activate({ script: 'A' });
    await flush();
    vi.advanceTimersByTime(SIM_PREPARE_TIMEOUT_MS + 10);
    await flush();
    expect(c.getModernState().breakerOpen).toBe(false);

    // Two more attempts, driven through the retry the UI offers.
    for (let attempt = 2; attempt <= SIM_BREAKER_THRESHOLD; attempt++) {
      expect(c.retryModern(), `retry ${attempt} was refused while the breaker was still closed`).toBe(true);
      await flush();
      vi.advanceTimersByTime(SIM_PREPARE_TIMEOUT_MS + 10);
      await flush();
    }

    const failure = c.getModernState().failure;
    expect(c.getModernState().breakerOpen, 'the breaker never opened').toBe(true);
    expect(failure?.attempt).toBe(SIM_BREAKER_THRESHOLD);
    expect(failure?.breakerOpen).toBe(true);
    expect(failure?.actions, 'an open breaker must stop offering retry').not.toContain('retry');
    expect(c.retryModern(), 'the breaker did not stop automatic preparation — that is what a breaker is').toBe(false);
    expect(countTel(tel, 'modern-failure')).toBe(SIM_BREAKER_THRESHOLD);
    expect(c.getState().visible).toBe(false);
  });
});

// ══ 8. THE HANDSHAKE WINDOW ══════════════════════════════════════════════════════════════════

describe('an activation requested while the handshake is still undecided', () => {
  it('is HELD (a v2 paint must not reveal it) and then runs on v2 when the transport settles legacy', async () => {
    // A package that never adopts the port: the transport stays `offering` until its own deadline.
    const { c, child, tel } = await boot({ child: { adopt: false } });
    fromChild(child, { type: SIM_READY, dispatch: 'dynamic' });

    c.activate({ script: 'A' });
    expect(events(tel)).toContain('modern-activate-deferred');
    expect(c.getState().phase).toBe('awaiting-ack');
    expect(v2Types(child), 'the v2 body was applied during the handshake window').not.toContain(START_SCRIPT);

    // THE MUTATION THIS PINS: without the hold, this paint reaches maybeReveal with `holding` false
    // and — because the transport has not settled — reveal() takes the LEGACY branch and presents a
    // document that has been sent no startScript and no PREPARE_SECTION.
    fromChild(child, { type: SIM_PAINTED });
    expect(c.getState().painted, 'the paint never arrived — this proves nothing').toBe(true);
    expect(c.getState().visible, 'a document with NOTHING applied to it was presented').toBe(false);

    // The deferral is bounded: at the bootstrap deadline the transport settles legacy and the held
    // activation runs on v2 exactly as it always would have.
    vi.advanceTimersByTime(SIM_BOOTSTRAP_TIMEOUT_MS + 50);
    await flush();
    expect(lastTel(tel, 'transport-mode')?.detail.mode).toBe('legacy');
    expect(events(tel)).toContain('modern-activate-fallback-legacy');
    expect(v2Types(child), 'the deferred activation was dropped instead of run').toContain(START_SCRIPT);
    expect(child.v2.filter((m) => m.type === START_SCRIPT).length, 'the section was applied twice').toBe(1);
    expect(child.v2.find((m) => m.type === START_SCRIPT)?.script).toBe('A');
    expect(c.getState().visible, 'the section applied on v2 was never shown').toBe(true);
    expect(c.getModernState().active).toBe(false);
  });

  it('pins the REVEAL GATE alone: armed-but-not-active refuses a v2 paint with no hold in play', async () => {
    // The two fixes masked each other. Every other armed-not-active test has the deferral hold set,
    // so `maybeReveal` returns before `reveal()` is ever consulted — reverting `modernArmed` back to
    // `modernActive()` therefore passed the whole suite. This constructs the one state that
    // separates them: painted, NOT holding, armed, not active.
    const { c, child, tel } = await boot({ child: { autoReady: false } });
    expect(c.modernActive(), 'the document must be armed but not ready for this to prove anything').toBe(false);

    // No activation, so nothing sets `holding`.
    expect(c.getState().visible).toBe(false);
    fromChild(child, { type: SIM_PAINTED });
    expect(c.getState().painted, 'the paint never landed — this proves nothing').toBe(true);

    // A regenerated package carries BOTH listeners, so this v2 paint is real. Under the old gate it
    // fell through to the legacy branch and presented a document with nothing applied.
    expect(c.getState().visible, 'the legacy reveal branch was reachable for an ARMED document').toBe(false);
    expect(lastTel(tel, 'modern-reveal-refused')?.detail.refusal).toBe('document-not-ready');
  });

  it('holds the deferral behind BOTH the hold and the gate — the hold alone is not observable', async () => {
    // HONEST ABOUT WHAT THIS CAN PROVE. Mutating away `this.holding = true` in the deferral does NOT
    // fail any test, and no test here can make it fail: the reveal gate refuses every armed-but-
    // not-active reveal on its own, so `maybeReveal`'s hold check is redundant behind it. The hold
    // is kept as defence in depth — it becomes load-bearing again the moment the gate is narrowed,
    // and it is what stops `present()` and the legacy ceiling in the non-armed case — but claiming a
    // test pins it would be false. Recorded here so the next person does not go looking for one.
    //
    // What IS asserted: during the deferral nothing is presented and the v2 body never runs.
    const { c, child } = await boot({ child: { adopt: false } });
    fromChild(child, { type: SIM_READY, dispatch: 'dynamic' });
    c.activate({ script: 'A' });
    expect(c.getState().phase, 'the deferral did not take effect').toBe('awaiting-ack');

    fromChild(child, { type: SIM_PAINTED });
    expect(c.getState().painted, 'the paint never landed — this proves nothing').toBe(true);
    expect(c.getState().visible, 'a document with nothing applied was presented').toBe(false);
    expect(v2Types(child), 'the v2 body ran during the handshake window').not.toContain(START_SCRIPT);
  });

  it('a document that confirms SUSPENDED and then RESUMED becomes ready again', async () => {
    // The blocking defect: the child sends DOCUMENT_RESUMED, the protocol accepts it and the
    // machine's only edge out of SUSPENDED is `RESUMED` — but nothing dispatched it, so one
    // confirmed suspend left the document SUSPENDED for the session. With the reveal gate and the
    // deferral both reading `modernActive()`, that meant permanently held and hidden, unbounded.
    const { c, child } = await boot();
    expect(c.modernActive()).toBe(true);

    c.freeze();
    child.suspended();
    await flush();
    expect(c.getModernState().documentState).toBe('SUSPENDED');
    expect(c.modernActive(), 'a suspended document must not accept activation commands').toBe(false);

    c.thaw();
    child.resumed();
    await flush();
    expect(c.getModernState().documentState, 'the document never came back from SUSPENDED').toBe('DOCUMENT_READY');
    expect(c.modernActive(), 'the document is ready but still refuses commands').toBe(true);

    // And it can be presented again.
    c.activate({ script: 'A' });
    await flush();
    expect(c.getState().visible, 'a resumed document could never be shown again').toBe(true);
  });

  it('a teardown mid-deferral releases the hold — it must not strand the document invisible forever', async () => {
    // Found by reading the release paths, not by a failing test, so it is pinned here.
    //
    // The deferral sets `holding` and returns, expecting one of exactly two exits to clear it:
    // activateModern on DOCUMENT_READY, or the legacy fallback when the transport settles. A
    // teardown takes NEITHER — it drops pendingActivate — so the hold survived with nothing able to
    // clear it, and `maybeReveal` returns early while it is set. The document could then never be
    // shown again by any path, including the v2 one it had fallen back to.
    //
    // Reachable in production: enableModern is called on every activation with the section's class,
    // so a canary verdict published between two activations can re-arm this client with a class
    // below managed-presentable while a deferral is in flight.
    const { c, child, tel } = await boot({ child: { adopt: false } });
    fromChild(child, { type: SIM_READY, dispatch: 'dynamic' });

    c.activate({ script: 'A' });
    expect(events(tel), 'no deferral happened — this proves nothing').toContain('modern-activate-deferred');
    expect(c.getState().visible).toBe(false);

    // The verdict moved: this package is no longer certified. enableModern declines and tears the
    // modern path down mid-deferral.
    c.enableModern({
      playerSessionId: PLAYER_SESSION,
      packageRevision: PACKAGE_REVISION,
      packageClass: 'managed-partial',
    });
    expect(events(tel)).toContain('modern-declined');

    // NO further activate() here, deliberately. A second activation calls cancelPendingApply(),
    // which clears `holding` as a side effect and MASKS the defect entirely — the first version of
    // this test did exactly that and the mutation survived it. What is left after a teardown is a
    // document whose only remaining path to the screen is the v2 paint gate, so that is the path
    // this must exercise.
    fromChild(child, { type: SIM_PAINTED });
    expect(c.getState().painted, 'the paint never arrived — this proves nothing').toBe(true);
    expect(
      c.getState().visible,
      'a hold left armed by the teardown made the document permanently invisible',
    ).toBe(true);
  });

  it('a background warm during the handshake is never remembered as an intent to present', async () => {
    const { c, child, tel } = await boot({ child: { adopt: false } });
    c.activate({ script: 'A', reveal: 'never' });
    expect(events(tel), 'a warm was deferred as if it were a presentation').not.toContain('modern-activate-deferred');
    expect(v2Types(child)).toContain(START_SCRIPT);
    expect(c.getState().visible).toBe(false);
    expect(c.getState().muted, 'a hidden frame that keeps audio is the defect the exit mute exists for').toBe(true);

    vi.advanceTimersByTime(SIM_BOOTSTRAP_TIMEOUT_MS + 50);
    await flush();
    expect(events(tel)).not.toContain('modern-activate-fallback-legacy');
    expect(c.getState().visible).toBe(false);
  });
});

// ══ 9. DOCUMENT EPOCHS ═══════════════════════════════════════════════════════════════════════

describe('document navigation', () => {
  it('clears the activation, mints a new epoch, and tombstones the old one', async () => {
    const { c, child, tel } = await boot({ v2: true });
    c.activate({ script: 'A' });
    await flush();
    expect(c.getState().visible).toBe(true);
    const firstEpoch = child.offers[0].documentId;
    const staleActivation = identityOf(child.last(ACTIVATE_SECTION));

    // The browser replaced the document under us.
    c.handleFrameLoad();

    // SYNCHRONOUSLY, before anything can be re-driven: the activation died with the epoch. Leaving
    // it would carry a PRESENTED proof earned on the PREVIOUS document into the new one.
    expect(c.getModernState().activationState, 'a PRESENTED proof survived into the new document').toBe('none');
    expect(c.getModernState().documentState, 'the new document was not re-mounted').toBe('MOUNTING');

    await flush();
    expect(child.offers.length, 'no new epoch was offered after the navigation').toBe(2);
    const secondEpoch = child.offers[1].documentId;
    expect(secondEpoch, 'the new document reused the dead epoch’s id').not.toBe(firstEpoch);
    expect(c.modernActive(), 'the new document never handshook').toBe(true);
    expect(c.getState().painted, 'a stale paint latch survived the navigation').toBe(false);
    // The pending intent is re-driven onto the NEW epoch as a NEW activation — never as the old one.
    const redriven = child.last(PREPARE_SECTION);
    expect(redriven.documentId).toBe(secondEpoch);
    expect(redriven.activationId, 'the re-drive reused the dead epoch’s activation').not.toBe(staleActivation.activationId);

    // A message from the DEAD epoch, delivered on the live port: rejected for being from a dead
    // document — the failure mode a contentWindow comparison can never catch, because the element
    // is the same element.
    const revealsBefore = countTel(tel, 'reveal');
    child.send(SECTION_PRESENTED, { ...staleActivation, documentId: firstEpoch }, {
      variantKey: staleActivation.variantKey,
      configHash: staleActivation.configHash,
      framesSubmitted: 5,
    });
    await flush();
    expect(lastTel(tel, 'modern-rejected')?.detail.reason).toBe('tombstoned-document');
    expect(countTel(tel, 'reveal'), 'a dead epoch’s acknowledgement authorised a reveal').toBe(revealsBefore);

    // And the new epoch still works.
    c.activate({ script: 'B' });
    await flush();
    expect(child.last(PREPARE_SECTION).documentId).toBe(secondEpoch);
    expect(child.last(PREPARE_SECTION).variantKey).toBe('B');
    expect(c.getState().visible).toBe(true);
  });

  it('a new src is a new epoch: attach() re-offers and the activation does not carry over', async () => {
    const { c, child } = await boot();
    c.activate({ script: 'A' });
    await flush();
    expect(c.getModernState().activationState).toBe('VISIBLE');

    const firstActivation = child.last(ACTIVATE_SECTION).activationId;

    const next = new FakeChild(`${CHILD_ORIGIN}/sim-public/pkg/index.html?section=B&v=1`);
    children.push(next);
    c.attach(next.el, next.el.src);
    expect(c.getModernState().activationState, 'the activation outlived the document it was proven on').toBe('none');

    await flush();
    expect(next.offers.length, 'the newly attached document was never offered a bootstrap').toBe(1);
    expect(next.offers[0].documentId).not.toBe(child.offers[0].documentId);
    expect(c.modernActive()).toBe(true);
    expect(next.last(PREPARE_SECTION).activationId, 'the new document inherited the old activation')
      .not.toBe(firstActivation);
  });
});

// ══ 10. DISPOSAL ═════════════════════════════════════════════════════════════════════════════

describe('disposal', () => {
  it('releases the section, disposes the document, and leaves the client inert', async () => {
    const { c, child, tel } = await boot({ v2: true });
    c.activate({ script: 'A' });
    await flush();
    expect(c.getState().visible).toBe(true);
    const before = child.types().length;

    c.dispose();
    await flush();

    const after = child.types().slice(before);
    expect(after, 'a document that is going away should be told, so it can release GPU memory now')
      .toEqual([RELEASE_SECTION, DISPOSE_DOCUMENT]);
    expect(c.getState().phase).toBe('disposed');
    expect(c.getState().visible).toBe(false);
    expect(c.getModernState().active).toBe(false);
    expect(c.retryModern(), 'a disposed client still accepted a retry').toBe(false);

    // Nothing can drive it any more: not a v2 message, not a v3 envelope, not a timer.
    const events0 = tel.length;
    fromChild(child, { type: SIM_PAINTED });
    vi.advanceTimersByTime(60_000);
    await flush();
    expect(c.getState().phase).toBe('disposed');
    expect(c.getState().visible).toBe(false);
    expect(tel.length, 'a disposed client is still reporting').toBe(events0);
  });

  it('dispose during a live activation cancels its bounds', async () => {
    const { c } = await boot({ child: { autoApplied: false } });
    c.activate({ script: 'A' });
    await flush();
    c.dispose();
    vi.advanceTimersByTime(SIM_PREPARE_TIMEOUT_MS + SIM_PRESENT_TIMEOUT_MS + 1_000);
    await flush();
    expect(c.getModernState().failure, 'a bound fired after disposal').toBeNull();
    expect(c.getState().phase).toBe('disposed');
  });
});

// ══ TRANSITION MEASUREMENT (Priority 8.1) ════════════════════════════════════════════════════
//
// Measurement only: nothing here may change what the viewer sees. The claims are that the stages
// are recorded in protocol order, that the child's own numbers stop being discarded, and that an
// abandoned or refused transition never contributes a total — a p90 built from frames nobody saw
// would be worse than no measurement at all.

describe('transition measurement', () => {
  it('records every stage of a completed transition, in order', async () => {
    const { c, child } = await boot({ child: { autoApplied: false, autoPresented: false } });
    c.activate({ script: 'A' });
    await flush();
    vi.advanceTimersByTime(5);
    child.sectionApplied(child.last(PREPARE_SECTION));
    await flush();
    vi.advanceTimersByTime(5);
    child.sectionPresented(child.last(PRESENT_SECTION));
    await flush();

    const s = c.timingSummary();
    expect(s.samples).toBe(1);
    expect(s.completed).toBe(1);
    // ORDER, not merely presence. Asserting `p50TotalMs >= 0` cannot fail — clamp is Math.max(0,…)
    // and diff() already drops negatives — and an implementation that never marked `applied`,
    // `present-sent` or `presented` would satisfy every other line here.
    expect(s.p50PrepareMs, 'prepare was never measured').not.toBeNull();
    expect(s.p50TotalMs, 'total was never measured').not.toBeNull();
    // Each stage is a strict sub-span of the total, so a total that did not include them is wrong.
    expect(s.p50TotalMs!).toBeGreaterThanOrEqual(s.p50PrepareMs!);
    expect(s.abandonedAt).toEqual({});
  });

  it('captures the child applyMs that used to be read off the wire and dropped', async () => {
    const { c, child, tel } = await boot({ child: { autoApplied: false, autoPresented: false } });
    c.activate({ script: 'A' });
    await flush();
    child.sectionApplied(child.last(PREPARE_SECTION));
    await flush();
    // The FakeChild sends applyMs: 3, exactly as the real child has since the protocol shipped.
    expect(lastTel(tel, 'modern-section-applied')?.detail.applyMs).toBe(3);
    child.sectionPresented(child.last(PRESENT_SECTION));
    await flush();
    expect(c.timingSummary().p50ApplyMs).toBe(3);
  });

  it('keeps the child applyMs distinct from our own prepare measurement', async () => {
    // prepareMs spans two postMessage hops applyMs does not. Conflating them would hide whether a
    // slow prepare is the package's fault or the transport's.
    const { c, child } = await boot({ child: { autoApplied: false, autoPresented: false } });
    c.activate({ script: 'A' });
    await flush();
    vi.advanceTimersByTime(50);
    child.sectionApplied(child.last(PREPARE_SECTION));
    await flush();
    child.sectionPresented(child.last(PRESENT_SECTION));
    await flush();
    const s = c.timingSummary();
    expect(s.p50ApplyMs).toBe(3);
    expect(s.p50PrepareMs).not.toBe(3);
  });

  it('emits the durations on the reveal breadcrumb', async () => {
    const { c, tel } = await boot();
    c.activate({ script: 'A' });
    await flush();
    const rev = lastTel(tel, 'reveal');
    expect(rev).toBeDefined();
    expect(rev!.detail).toHaveProperty('totalMs');
    expect(rev!.detail).toHaveProperty('prepareMs');
  });

  it('records an ABANDONED transition rather than merging it into the next', async () => {
    // Without the roll on re-activation, the next mark('requested') is swallowed by first-write-wins
    // and one bogus measurement spans both sections.
    const { c, child } = await boot({ child: { autoApplied: false, autoPresented: false } });
    c.activate({ script: 'A' });
    await flush();
    c.activate({ script: 'B' });
    await flush();
    child.sectionApplied(child.last(PREPARE_SECTION));
    await flush();
    child.sectionPresented(child.last(PRESENT_SECTION));
    await flush();

    const s = c.timingSummary();
    expect(s.samples).toBe(2);
    expect(s.completed).toBe(1);
    // A that never got past its prepare is counted where it died, not ignored.
    expect(s.abandonedAt['prepare-sent']).toBe(1);
  });

  it('a REFUSED reveal contributes no total', async () => {
    // A p90 that included rejected activations would describe frames no viewer ever saw.
    const { c, child } = await boot({ child: { autoPresented: false } });
    c.activate({ script: 'A' });
    await flush();
    // Acknowledge with a distorted variantKey: the five-axis invariant refuses it.
    child.sectionPresented(child.last(PRESENT_SECTION), { distort: { variantKey: 'WRONG' } });
    await flush();
    expect(c.getState().visible).toBe(false);
    expect(c.timingSummary().completed).toBe(0);
  });

  it('a refused reveal is still not counted once the transition is rolled', async () => {
    // The subtler half of the previous test: an in-flight transition is not in the history yet, so
    // "completed === 0" can hold for the wrong reason. Starting a NEW activation rolls the refused
    // one into the history — and only a `revealed` mark placed AFTER the invariant check keeps it
    // out of the completed count there.
    // The distortion must be one that reaches `reveal()`. `matchesActivation` covers only
    // activationId/variantKey/configHash, so a wrong packageRevision passes it, PRESENTS the
    // activation, and is refused by the five-axis invariant inside reveal — which is the only place
    // a `revealed` mark could be wrongly stamped.
    const { c, child, tel } = await boot({ child: { autoPresented: false } });
    c.activate({ script: 'A' });
    await flush();
    child.sectionPresented(child.last(PRESENT_SECTION),
      { distort: { packageRevision: 'rev-from-a-republished-package' } });
    await flush();
    expect(c.getState().visible).toBe(false);
    expect(lastTel(tel, 'modern-reveal-refused')?.detail.refusal).toBe('package-revision-mismatch');

    c.activate({ script: 'B' });
    await flush();

    const s = c.timingSummary();
    expect(s.samples).toBeGreaterThanOrEqual(1);
    expect(s.completed, 'a reveal the invariant refused was counted as a completed transition').toBe(0);
    expect(s.p50TotalMs).toBeNull();
  });

  it('the first mark of a stage wins, so a repeat cannot shorten the measurement', async () => {
    // A duplicate SECTION_APPLIED (or a retried PREPARE) must not re-stamp the stage: overwriting
    // discards everything before the repeat, which is exactly the slow case worth seeing.
    const { c, child } = await boot({ child: { autoApplied: false, autoPresented: false } });
    c.activate({ script: 'A' });
    await flush();
    const prepare = child.last(PREPARE_SECTION);
    vi.advanceTimersByTime(10);
    child.sectionApplied(prepare);
    await flush();
    vi.advanceTimersByTime(500);
    child.sectionApplied(prepare);       // a repeat for the same activation
    await flush();
    child.sectionPresented(child.last(PRESENT_SECTION));
    await flush();

    const s = c.timingSummary();
    expect(s.completed).toBe(1);
    // Overwriting would move `applied` 500ms later and report a prepare that took ~510ms.
    expect(s.p50PrepareMs!, 'a repeated stage re-stamped the mark').toBeLessThan(500);
  });

  it('an acknowledgement claiming no frame contributes no total', async () => {
    const { c, child } = await boot({ child: { autoPresented: false } });
    c.activate({ script: 'A' });
    await flush();
    child.sectionPresented(child.last(PRESENT_SECTION), { frames: 0 });
    await flush();
    expect(c.getState().visible).toBe(false);
    expect(c.timingSummary().completed).toBe(0);
  });

  it('bounds the history and COUNTS what it dropped', async () => {
    // A silent cap makes a truncated sample look like a complete one.
    const { c, child } = await boot();
    for (let i = 0; i < 60; i += 1) {
      c.activate({ script: `S${i}` });
      await flush();
    }
    const s = c.timingSummary();
    // Exactly the cap, not merely "at most" — an implementation that dropped everything would
    // satisfy a <= assertion.
    expect(s.samples).toBe(50);
    expect(s.dropped).toBe(60 - 50);
    void child;
  });

  it('derives a lead time from measurement once there are enough samples, and says so', async () => {
    const { c } = await boot();
    expect(c.leadMs(800).source, 'a single sample is not a measurement').toBe('fallback');
    expect(c.leadMs(800).leadMs).toBe(800);

    for (let i = 0; i < 8; i += 1) {
      c.activate({ script: `S${i}` });
      await flush();
    }
    const derived = c.leadMs(800);
    expect(derived.source).toBe('measured');
    // Not `>= 0`, which clamp makes unfalsifiable: a measured lead must differ from the fallback it
    // replaced, or nothing was actually derived.
    expect(derived.leadMs).not.toBe(800);
  });

  it('measurement changes nothing a viewer sees', async () => {
    // The whole step is instrumentation. If any assertion about visibility or protocol order moved,
    // this stopped being measurement.
    const { c, child, tel } = await boot({ child: { autoApplied: false, autoPresented: false } });
    c.activate({ script: 'A' });
    await flush();
    expect(c.getState().visible).toBe(false);
    child.sectionApplied(child.last(PREPARE_SECTION));
    await flush();
    expect(c.getState().visible).toBe(false);
    child.sectionPresented(child.last(PRESENT_SECTION));
    await flush();
    expect(c.getState().visible).toBe(true);
    expect(child.types()).toEqual([INIT_DOCUMENT, PREPARE_SECTION, PRESENT_SECTION, ACTIVATE_SECTION]);
    expect(countTel(tel, 'reveal')).toBe(1);
  });
});
