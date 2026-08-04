/**
 * SimTransport — the parent half of the v3 bootstrap and the private MessageChannel that follows.
 *
 * WHAT THIS REPLACES
 * v2 traffic is `postMessage(msg, '*')` in both directions, with the parent filtering inbound
 * messages by `e.source === frame.contentWindow`. Both halves of that are weaker than they look:
 *
 *   • `'*'` means every frame that can get a reference to the window can read the command stream.
 *     For a simulation that is mostly harmless; for the ACK stream it is not, because an ack is
 *     what authorises a reveal.
 *   • `contentWindow` is a property of the ELEMENT, not of the document. It survives navigation.
 *     A message posted by the document that WAS in the iframe passes the check made against the
 *     document that is in it NOW — which is the stale-frame class, arriving through the front door.
 *
 * v3 fixes both structurally rather than by tightening the filter. The parent transfers one
 * MessagePort to one document. Only a holder of that port can send protocol traffic, and a
 * navigated-away document does not hold it — the port dies with its document. There is no filter
 * to get wrong.
 *
 * WHY THE HANDSHAKE LOOKS LIKE THIS
 * The parent cannot know when the child's listener is installed, and the child cannot know the
 * parent's origin before being told. So:
 *
 *   1. the child, on boot, posts a HELLO to `window.parent` (targetOrigin '*' — it carries no
 *      secret, and it is the one message sent before an origin is known);
 *   2. the parent offers a port, addressed to the child's EXACT derived origin, never '*';
 *   3. the child validates source + origin + namespace + version + schema, adopts the port, and
 *      answers ON THE PORT;
 *   4. everything after that is port-only.
 *
 * The parent additionally re-offers on a short timer, because a child that booted before the
 * parent attached has already sent its only hello. Each offer mints a fresh channel; whichever
 * channel the child answers on WINS and the rest are closed. That is why no offer id is needed —
 * the port that speaks is, by construction, the port the child took.
 *
 * WHEN v3 IS IMPOSSIBLE
 * A `srcDoc` frame, or any frame sandboxed without `allow-same-origin`, has an opaque origin.
 * There is no exact origin to address, so the offer would have to go to `'*'` — which is the thing
 * this transport exists to stop doing. Those surfaces stay on v2 and are classified legacy, which
 * is the honest outcome rather than a security exception carved out for convenience.
 */

import {
  SIM_BOOTSTRAP_KIND,
  SIM_BOOTSTRAP_TIMEOUT_MS,
  SIM_PROTOCOL_VERSION,
  isBootstrapAccept,
  makeEnvelope,
  validateEnvelope,
  PARENT_INBOUND_TYPES,
  type AnySimEnvelope,
  type EnvelopeIdentity,
  type EnvelopeRejectReason,
  type SimBootstrapOffer,
  type SimOutboundType,
} from 'shared/src/sim/runtimeProtocol';
import type { DocumentId, PackageRevision, PlayerSessionId } from 'shared/src/sim/simIdentity';

export type SimTransportMode = 'idle' | 'offering' | 'modern' | 'legacy' | 'closed';

export interface SimTransportCallbacks {
  /** A validated envelope arrived. */
  onEnvelope?: (env: AnySimEnvelope) => void;
  /** An inbound message was refused. `reason` is always specific — see runtimeProtocol. */
  onRejected?: (reason: EnvelopeRejectReason, detail?: string) => void;
  /** The transport settled into modern or legacy, or was closed. */
  onMode?: (mode: SimTransportMode) => void;
  onTelemetry?: (event: string, detail?: Record<string, unknown>) => void;
}

export interface SimTransportTarget {
  frame: HTMLIFrameElement;
  /** The resolved src actually assigned to the frame. Used to derive the target origin. */
  src: string;
  playerSessionId: PlayerSessionId;
  packageRevision: PackageRevision;
  documentId: DocumentId;
}

/** How often the parent re-offers while waiting for a child that may still be booting. */
const OFFER_INTERVAL_MS = 150;

/**
 * The child's unsolicited boot announcement. Deliberately NOT an envelope: it is sent before any
 * identity has been negotiated, so it cannot carry one, and giving it a different shape means no
 * code path can mistake it for protocol traffic.
 */
export const SIM_HELLO_KIND = 'flowvid.sim.hello' as const;

export interface SimHello {
  kind: typeof SIM_HELLO_KIND;
  protocolVersion: number;
}

function isHello(data: unknown): data is SimHello {
  return (
    typeof data === 'object' && data !== null &&
    (data as { kind?: unknown }).kind === SIM_HELLO_KIND &&
    (data as { protocolVersion?: unknown }).protocolVersion === SIM_PROTOCOL_VERSION
  );
}

/**
 * The exact origin to address the child at, or null when there is none.
 *
 * Returns null — meaning "no modern transport" — for a relative URL that resolves to our OWN
 * origin only if the frame is genuinely same-origin; that case is fine and returns the origin. It
 * returns null for `about:`, `data:`, `blob:` and `javascript:` documents, which have opaque or
 * inherited origins that cannot be addressed exactly.
 */
export function deriveTargetOrigin(src: string, base?: string): string | null {
  try {
    const u = new URL(src, base ?? (typeof window !== 'undefined' ? window.location.href : undefined));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** True when the frame's sandbox permits a real (addressable) origin. */
export function sandboxAllowsOrigin(frame: HTMLIFrameElement): boolean {
  const attr = frame.getAttribute('sandbox');
  // No sandbox attribute at all: the frame keeps its document's real origin.
  if (attr === null) return true;
  return attr.split(/\s+/).includes('allow-same-origin');
}

export class SimTransport {
  private cbs: SimTransportCallbacks;
  private mode: SimTransportMode = 'idle';

  private target: SimTransportTarget | null = null;
  private targetOrigin: string | null = null;

  /** Channels offered and not yet resolved. The one the child answers on becomes `port`. */
  private pending: MessageChannel[] = [];
  private port: MessagePort | null = null;

  private windowListener: ((e: MessageEvent) => void) | null = null;
  private offerTimer: ReturnType<typeof setInterval> | null = null;
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;

  private outSeq = 0;
  private lastInSeq = 0;
  private tombstoned = new Set<DocumentId>();

  constructor(cbs: SimTransportCallbacks = {}) {
    this.cbs = cbs;
  }

  getMode(): SimTransportMode { return this.mode; }
  isModern(): boolean { return this.mode === 'modern'; }

  private setMode(mode: SimTransportMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.cbs.onMode?.(mode);
  }

  private tel(event: string, detail?: Record<string, unknown>): void {
    this.cbs.onTelemetry?.(event, detail);
  }

  /**
   * Begin the handshake for a document. Idempotent per documentId: calling it again for the SAME
   * document while already modern is a no-op, so a re-render cannot tear down a live transport.
   */
  open(target: SimTransportTarget): void {
    if (this.mode === 'closed') return;
    if (this.target?.documentId === target.documentId && (this.mode === 'modern' || this.mode === 'offering')) {
      this.target = target;   // keep the newest frame reference; the handshake is already running
      return;
    }

    // A different document: the previous epoch is dead. Tombstone it before anything else, so a
    // message still in flight from it can never be accepted during the changeover.
    if (this.target && this.target.documentId !== target.documentId) {
      this.tombstoned.add(this.target.documentId);
      this.teardownChannels();
      // Close the previously ADOPTED port too, not just the pending losers.
      //
      // Overwriting `this.port` when the child answers the new offer leaves the old port1 open with
      // its handler still bound. Nothing wrong is ever ACCEPTED from it — the tombstone above sees
      // to that — but it is reclaimed only by GC, while every other channel this transport gives up
      // on is closed deterministically. A port pair per navigation is exactly the kind of slow leak
      // a resident pool accumulates over a long session.
      this.closePort();
    }

    this.target = target;
    this.outSeq = 0;
    this.lastInSeq = 0;

    const origin = deriveTargetOrigin(target.src);
    if (!origin || !sandboxAllowsOrigin(target.frame)) {
      // Opaque origin — see the module header. Legacy is the correct, honest outcome.
      this.targetOrigin = null;
      this.tel('transport-legacy-opaque-origin', { src: target.src });
      this.setMode('legacy');
      return;
    }
    this.targetOrigin = origin;

    this.ensureWindowListener();
    this.setMode('offering');
    this.offer();

    if (this.offerTimer) clearInterval(this.offerTimer);
    this.offerTimer = setInterval(() => this.offer(), OFFER_INTERVAL_MS);

    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.deadlineTimer = setTimeout(() => {
      this.deadlineTimer = null;
      if (this.mode !== 'offering') return;
      this.stopOffering();
      // CLOSE the abandoned channels. Leaving them open kept up to 12 entangled port pairs alive,
      // and — worse — left their port2s sitting in the child's task queue: a slow package that
      // adopted one AFTER this deadline would latch onto a port the parent had already given up on,
      // then post into a channel nobody listens to, with no way for either side to notice.
      this.teardownChannels();
      this.tel('transport-legacy-no-answer', { documentId: target.documentId });
      this.setMode('legacy');
    }, SIM_BOOTSTRAP_TIMEOUT_MS);
  }

  private ensureWindowListener(): void {
    if (this.windowListener || typeof window === 'undefined') return;
    this.windowListener = (e: MessageEvent) => this.onWindowMessage(e);
    window.addEventListener('message', this.windowListener);
  }

  /**
   * The ONLY window-level message v3 cares about is the child's boot hello. Everything else on the
   * window belongs to v2 (or to another component entirely) and is left alone — this transport
   * deliberately does not compete with SimRuntimeClient's own v2 listener.
   */
  private onWindowMessage(e: MessageEvent): void {
    if (this.mode !== 'offering') return;
    const frame = this.target?.frame;
    if (!frame || e.source !== frame.contentWindow) return;
    if (this.targetOrigin && e.origin !== this.targetOrigin) return;
    if (!isHello(e.data)) return;
    this.tel('transport-hello');
    this.offer();
  }

  /** Mint a fresh channel and hand port2 to the child, addressed to its exact origin. */
  private offer(): void {
    const target = this.target;
    const origin = this.targetOrigin;
    if (!target || !origin || this.mode !== 'offering') return;
    const win = target.frame.contentWindow;
    if (!win) return;

    // Bound the number of outstanding channels. Ten offers over 1.5s is already generous; an
    // unbounded list would allocate a port pair every 150ms for any document that never answers.
    if (this.pending.length >= 12) return;

    let channel: MessageChannel;
    try {
      channel = new MessageChannel();
    } catch {
      return;
    }
    const offer: SimBootstrapOffer = {
      kind: SIM_BOOTSTRAP_KIND,
      protocolVersion: SIM_PROTOCOL_VERSION,
      playerSessionId: target.playerSessionId,
      packageRevision: target.packageRevision,
      documentId: target.documentId,
      parentOrigin: typeof window !== 'undefined' ? window.location.origin : '',
    };

    channel.port1.onmessage = (ev: MessageEvent) => this.onChannelFirstMessage(channel, ev);
    try {
      channel.port1.start();
      win.postMessage(offer, origin, [channel.port2]);
      this.pending.push(channel);
    } catch {
      // A frame torn down mid-offer. Nothing to clean up beyond the channel itself.
      try { channel.port1.close(); } catch { /* already dead */ }
    }
  }

  /**
   * The first message on ANY offered channel decides which one the child took. It must be a
   * well-formed accept for THIS document; anything else means a channel that leaked to a document
   * we are not talking to, and it is closed rather than adopted.
   */
  private onChannelFirstMessage(channel: MessageChannel, ev: MessageEvent): void {
    if (this.mode !== 'offering' || !this.target) {
      try { channel.port1.close(); } catch { /* already closed */ }
      return;
    }
    if (!isBootstrapAccept(ev.data, this.target.documentId)) {
      // Close and de-list it, as the comment above promises. A channel that spoke and was not
      // adopted is one nobody will ever adopt.
      this.tel('transport-bad-accept');
      this.pending = this.pending.filter((c) => c !== channel);
      try { channel.port1.onmessage = null; channel.port1.close(); } catch { /* already closed */ }
      return;
    }

    this.port = channel.port1;
    this.pending = this.pending.filter((c) => c !== channel);
    this.stopOffering();
    this.teardownChannels();          // closes the losers; `port` is no longer in `pending`

    this.port.onmessage = (e: MessageEvent) => this.onPortMessage(e);
    this.setMode('modern');
    this.tel('transport-modern', { documentId: this.target.documentId });
  }

  private onPortMessage(e: MessageEvent): void {
    if (this.mode !== 'modern' || !this.target) return;
    const result = validateEnvelope(e.data, {
      playerSessionId: this.target.playerSessionId,
      documentId: this.target.documentId,
      tombstonedDocumentIds: this.tombstoned,
      lastSeq: this.lastInSeq,
      allowedTypes: PARENT_INBOUND_TYPES,
    });
    if (!result.ok) {
      // A rejected message NEVER changes visible state. It is counted and reported, because a
      // transport that silently drops is indistinguishable from one that is not receiving.
      this.tel('envelope-rejected', { reason: result.reason, detail: result.detail });
      this.cbs.onRejected?.(result.reason, result.detail);
      return;
    }
    this.lastInSeq = result.envelope.seq;
    this.cbs.onEnvelope?.(result.envelope);
  }

  /**
   * Send a command. Returns false when there is no modern transport — the caller then uses the v2
   * path, which is exactly what makes legacy packages keep working.
   */
  send<TPayload>(type: SimOutboundType, identity: Omit<EnvelopeIdentity, 'playerSessionId' | 'packageRevision' | 'documentId'>, payload: TPayload): boolean {
    if (this.mode !== 'modern' || !this.port || !this.target) return false;
    const env = makeEnvelope(type, {
      playerSessionId: this.target.playerSessionId,
      packageRevision: this.target.packageRevision,
      documentId: this.target.documentId,
      activationId: identity.activationId,
      variantKey: identity.variantKey,
      configHash: identity.configHash,
    }, ++this.outSeq, payload);
    try {
      this.port.postMessage(env);
      return true;
    } catch {
      // The port is dead (document gone). Fall back rather than pretend the command landed.
      this.tel('transport-send-failed', { type });
      this.closePort();
      this.setMode('legacy');
      return false;
    }
  }

  /** Mark a document epoch dead. Messages carrying it are rejected from now on. */
  tombstone(documentId: DocumentId): void {
    this.tombstoned.add(documentId);
  }

  isTombstoned(documentId: DocumentId): boolean {
    return this.tombstoned.has(documentId);
  }

  private stopOffering(): void {
    if (this.offerTimer) { clearInterval(this.offerTimer); this.offerTimer = null; }
    if (this.deadlineTimer) { clearTimeout(this.deadlineTimer); this.deadlineTimer = null; }
  }

  private teardownChannels(): void {
    for (const c of this.pending) {
      try { c.port1.onmessage = null; c.port1.close(); } catch { /* already closed */ }
    }
    this.pending = [];
  }

  private closePort(): void {
    if (!this.port) return;
    try { this.port.onmessage = null; this.port.close(); } catch { /* already closed */ }
    this.port = null;
  }

  /**
   * Close the transport and invalidate the port. Called on document disposal and on navigation.
   * Idempotent, and after it nothing can be sent or received — including by a timer that was
   * already scheduled.
   */
  close(): void {
    this.stopOffering();
    this.teardownChannels();
    this.closePort();
    if (this.target) this.tombstoned.add(this.target.documentId);
    if (this.windowListener && typeof window !== 'undefined') {
      window.removeEventListener('message', this.windowListener);
    }
    this.windowListener = null;
    this.target = null;
    this.targetOrigin = null;
    this.setMode('closed');
  }
}
