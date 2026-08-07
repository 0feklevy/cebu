/**
 * THE HOSTILE-INPUT SUITE (Priority 4.8, second half).
 *
 * WHAT THIS ASKS THAT NOTHING ELSE DOES
 * The unit tests around `validateEnvelope` prove that a REJECTING FUNCTION rejects. They cannot
 * prove that the shipped child runtime calls it, that a browser's own bootstrap rules are what the
 * runtime believes they are, or that a message the runtime refuses leaves NOTHING behind. Those are
 * properties of code running in a real document with a real MessagePort, and the only way to
 * establish them is to send the hostile message and then look — at the child's own recorded
 * transcript, at its observable state, and at whether it still works afterwards.
 *
 * So this suite drives the REAL v3 child runtime
 * (backend-api/src/services/simulation/simRuntimeChild.ts, embedded verbatim in the generated
 * fixture package) and deliberately attacks it: offers from the wrong source, offers whose claimed
 * origin disagrees with the event's, wrong protocol versions, wrong port counts, offers missing
 * identity, a second offer after adoption, and — on the adopted port — wrong namespace, unknown
 * types, a parent-inbound type reflected back, wrong identity on every axis, activation-scoped
 * commands missing their activation identity, duplicated / reordered / illegal sequence numbers,
 * malformed payloads, structurally hostile objects, and a genuine A → B → A stale acknowledgement.
 *
 * WHAT "IGNORED" MEANS HERE, AND HOW EACH HALF IS PROVEN
 *   DELIVERED     the fixture's own recorder (`window.__PROTO_V3__`, installed BEFORE the runtime
 *                 and wrapping every offered port in both directions) shows the hostile message
 *                 arriving. Without this half every "nothing happened" would be satisfied by a
 *                 message that never got there, which is the vacuity this suite exists to avoid.
 *   NO OUTBOUND   the same recorder shows the child posted NOTHING on any port in the window that
 *                 follows — a stronger reading than the parent's inbox, which can only see the one
 *                 channel it adopted.
 *   NO STATE      a projection of the fixture's `window.__V3_STATE__` (excluding the free-running
 *                 frame/tick counters), the document's `#marker` section attribute, the Minimal-UI
 *                 stylesheet, and the child realm's `Object.prototype` shape, compared before/after.
 *   STILL ALIVE   a full PREPARE → SECTION_APPLIED → PRESENT → SECTION_PRESENTED cycle immediately
 *                 afterwards. For a bootstrap refusal that cycle is preceded by a LEGITIMATE offer,
 *                 which is also the proof the refused offer was never adopted: a child that had
 *                 adopted it would refuse the real one and the handshake would never complete.
 *
 * THE HARNESS IS THE CANARY'S, DELIBERATELY. The parent half of the bootstrap is the driver
 * sim-canary.spec.ts installs (and sim-leak.spec.ts reuses): a faithful re-expression of
 * lib/sim/SimTransport handed the wire constants AS DATA, recording every inbound message raw and
 * judging none of them in the browser. Validation happens in Node with the REAL `validateEnvelope`.
 * A second, differently-shaped harness would mean two ideas of what the protocol is.
 *
 * THE CENTRAL CASE is the A → B → A stale acknowledgement. Activation 3 re-enters the section
 * activation 1 used, with the SAME variantKey and the SAME configHash — so the only axis that
 * differs is `activationId`. Activation 1's SECTION_PRESENTED is then delivered verbatim, and the
 * suite proves with the SHIPPED functions that `validateEnvelope` ACCEPTS it (it is well-formed and
 * for the right document — the transport has no complaint to make) while `identityRefusal` names it
 * `activation-mismatch`. The defence is the identity gate, not the transport, and this is the test
 * that says so.
 *
 *   npx playwright test --config=playwright.protocol.config.ts
 *
 * ONE DRIVE PER ENGINE PER RUN. Playwright discards a worker after a failed test, which would
 * otherwise re-run the whole attack sequence once per remaining assertion — so every verdict would
 * be judging a different drive from the one that produced the failure. The ledger is written to disk
 * and reclaimed by the replacement worker (see `reusableLedger`), so one run means one body of
 * evidence and the report a reader opens is the report the verdicts came from.
 *
 * Output: e2e-results/sim-protocol-<engine>.json — the full attack ledger, including the evidence
 * for every attack that was proven ignored.
 */
import { test, expect, type Browser, type BrowserContext, type Page, type Route } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { extname, join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { fixtureIsFresh } from './fixtureSources';

import {
  DOCUMENT_READY,
  INIT_DOCUMENT,
  PARENT_INBOUND_TYPES,
  PREPARE_SECTION,
  PRESENT_SECTION,
  QUALITY_APPLIED,
  SECTION_APPLIED,
  SECTION_PRESENTED,
  SET_QUALITY,
  SIM_BOOTSTRAP_ACCEPT_KIND,
  SIM_BOOTSTRAP_KIND,
  SIM_PROTOCOL_NAMESPACE,
  SIM_PROTOCOL_VERSION,
  validateEnvelope,
  type DocumentReadyPayload,
  type SectionPresentedPayload,
} from 'shared/src/sim/runtimeProtocol';
import {
  DEFAULT_PRESENTATION_CONFIG,
  computeConfigHash,
  derivePackageRevision,
  newActivationId,
  newDocumentId,
  newPlayerSessionId,
  type PresentationIdentity,
  type SimPresentationConfig,
} from 'shared/src/sim/simIdentity';
import {
  activationReducer,
  identityRefusal,
  initialActivationState,
  mayReveal,
  type ActivationMachineState,
} from 'shared/src/sim/activationMachine';
import { SIM_PRESENT_TIMEOUT_MS } from 'shared/src/sim/simFailurePolicy';
import { isSignificantError, type CanaryError } from 'shared/src/sim/canaryContract';
import { SIM_HELLO_KIND } from '../lib/sim/SimTransport';

// ─── Subject ──────────────────────────────────────────────────────────────────────────────────

/**
 * `v3managed` — the package that carries the real child runtime AND every section this suite needs
 * (V3A, V3B and V3NOPRESENT), plus the legacy-bodied ones. Nothing here depends on the package
 * being all-managed: the subject is the TRANSPORT and the IDENTITY GATE, which are the same code in
 * both packages.
 */
const PACKAGE = process.env.PROTOCOL_PACKAGE ?? 'v3managed';
const API_ORIGIN = process.env.PROTOCOL_API_URL ?? 'http://localhost:8080';
const HARNESS_URL = `${API_ORIGIN}/__protocol/harness.html`;
const publicPrefix = (pkg: string): string => `/sim-public/__e2e/${pkg}`;

const FIXTURE_DIR = resolve(__dirname, '../../.sim-fixture');
const BACKEND = resolve(__dirname, '../../backend-api');
const RESULTS_DIR = resolve(__dirname, '../e2e-results');

/**
 * Section ids and fixture globals, named rather than imported.
 *
 * gen-sim-fixture.ts exports them, but importing that module pulls the server's SimulationService
 * and controller graph into the test process — the same reason viewer-e2e.spec.ts, sim-canary and
 * sim-leak name their fixture sections directly. Drift is caught rather than tolerated: the run
 * FAILS if DOCUMENT_READY does not report every id below.
 */
const V3A = '33333333-a111-4a11-8a11-333333333333';
const V3B = '44444444-b222-4b22-8b22-444444444444';
const V3NOPRESENT = '66666666-d444-4d44-8d44-666666666666';
/** Labels the managed bodies publish their state under (V3_STATE_GLOBAL in the generator). */
const LABEL_OF: Record<string, string> = { [V3A]: 'V3A', [V3B]: 'V3B', [V3NOPRESENT]: 'V3NOPRESENT' };
const V3_STATE_GLOBAL = '__V3_STATE__';
const V3_PROTO_GLOBAL = '__PROTO_V3__';
const V3_DEFERRED_ACK_GLOBAL = '__V3_DEFERRED_ACK__';
const V3_DOUBLE_ACK_KNOB = 'doubleAck';
const V3_DEFER_ACK_KNOB = 'deferAck';

const LOAD_TIMEOUT_MS = 30_000;
const HANDSHAKE_TIMEOUT_MS = 30_000;
const BASE_VIEWPORT = { width: 1280, height: 720 };

/**
 * The bound on the HEALTHY choreography — handshakes, prepares, presents, quality echoes.
 *
 * Deliberately NOT the shipped SIM_PREPARE/PRESENT_TIMEOUT_MS, which is what sim-canary uses. The
 * canary is CERTIFYING a package against the product's clock, so holding it to the shipped bound is
 * the whole point. This suite certifies REFUSAL, and nothing it asserts depends on how quickly a
 * healthy cycle completes — so binding the liveness cycle to a 5-second product bound would only
 * mean that a machine under load (this one runs three engines and a concurrent leak suite) reports
 * "the runtime did not recover" when what actually happened is that a laptop was busy. The one place
 * the shipped bound IS the subject — how long V3NOPRESENT is watched — keeps it, and asserts that it
 * exceeded it.
 */
const CHOREO_TIMEOUT_MS = 30_000;

/**
 * How long the suite watches for a response after delivering a hostile message.
 *
 * It is a WINDOW rather than a barrier because a wrong answer need not be synchronous: the runtime's
 * own acknowledgement path goes through a requestAnimationFrame, so a defect that produced one would
 * take a frame to show up. 250 ms plus two frames is many times that on every engine, and the whole
 * suite spends about eight seconds in these windows.
 */
const QUIET_MS = 250;

/** The bound the parent applies to a present. V3NOPRESENT is watched well past it — see below. */
const NO_PRESENT_WATCH_MS = Math.round(SIM_PRESENT_TIMEOUT_MS * 1.5);

/** One configuration for every ordinary activation. A → B → A with an IDENTICAL config is the hard case. */
const BASE_CONFIG: SimPresentationConfig = { ...DEFAULT_PRESENTATION_CONFIG, autoScript: true };
const BASE_HASH = computeConfigHash(BASE_CONFIG);

// ─── Fixture staging ──────────────────────────────────────────────────────────────────────────

function ensureFixture(pkg: string): void {
  const generator = join(BACKEND, 'src', 'scripts', 'gen-sim-fixture.ts');
  const stamp = join(FIXTURE_DIR, pkg, 'index.html');
  const fresh = fixtureIsFresh(BACKEND, stamp);
  if (!fresh) {
    mkdirSync(FIXTURE_DIR, { recursive: true });
    const r = spawnSync('npx', ['tsx', 'src/scripts/gen-sim-fixture.ts', FIXTURE_DIR], {
      cwd: BACKEND,
      encoding: 'utf8',
    });
    if (r.status !== 0 && !existsSync(stamp)) {
      throw new Error(`sim-protocol: fixture generation failed: ${r.stderr || r.stdout}`);
    }
  }
  if (!existsSync(stamp)) {
    // FAIL, never skip. An unrun hostile-input suite reads as a pass in every report that
    // aggregates it, and "the refusal paths were never exercised" must not look like "they hold".
    throw new Error(
      `sim-protocol: the staged package '${pkg}' does not exist at ${stamp}.\n` +
      `Generate it with:  cd backend-api && npx tsx src/scripts/gen-sim-fixture.ts ${FIXTURE_DIR}`,
    );
  }
}

// ─── Local asset server (the canary's, unchanged apart from the harness path) ─────────────────

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.mp4': 'video/mp4',
  '.wasm': 'application/wasm',
};

const HARNESS_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>sim protocol harness</title>
  <style>
    html, body { margin: 0; padding: 0; height: 100%; background: #000; overflow: hidden; }
    #stage { position: absolute; left: 0; top: 0; width: 1280px; height: 720px; overflow: hidden; background: #000; }
    #stage iframe { display: block; border: 0; width: 100%; height: 100%; }
  </style>
</head>
<body><div id="stage"></div></body>
</html>`;

let server: Server;
let localOrigin = '';

function localPathFor(pathname: string): string | null {
  if (pathname === '/__protocol/harness.html') return '__harness__';
  if (pathname.startsWith('/sim-public/__e2e/')) return pathname.slice('/sim-public/__e2e/'.length);
  return null;
}

function startAssetServer(): Promise<void> {
  server = createServer((req, res) => {
    const pathname = (req.url ?? '/').split('?')[0].split('#')[0];
    if (pathname === '/__protocol/harness.html') {
      const body = Buffer.from(HARNESS_HTML, 'utf-8');
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': String(body.length),
        'cache-control': 'no-cache',
      });
      res.end(body);
      return;
    }
    // Answered rather than 404'd on purpose: a 404 here is logged as a console error by two of the
    // three engines, and the error assertion below would then be measuring the harness.
    if (pathname === '/favicon.ico') {
      res.writeHead(204, { 'cache-control': 'no-cache' });
      res.end();
      return;
    }
    const file = join(FIXTURE_DIR, pathname.replace(/^\/+/, ''));
    if (!file.startsWith(FIXTURE_DIR) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    const buf = readFileSync(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'content-length': String(buf.length),
      'cache-control': 'no-cache',
    });
    res.end(buf);
  });
  return new Promise<void>((r) => {
    server.listen(0, '127.0.0.1', () => {
      localOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      r();
    });
  });
}

// ─── The in-page protocol driver ──────────────────────────────────────────────────────────────

interface WireConstants {
  NS: string;
  VER: number;
  BOOTSTRAP: string;
  ACCEPT: string;
  HELLO: string;
  OFFER_INTERVAL_MS: number;
  OFFER_LIMIT: number;
}

const WIRE: WireConstants = {
  NS: SIM_PROTOCOL_NAMESPACE,
  VER: SIM_PROTOCOL_VERSION,
  BOOTSTRAP: SIM_BOOTSTRAP_KIND,
  ACCEPT: SIM_BOOTSTRAP_ACCEPT_KIND,
  HELLO: SIM_HELLO_KIND,
  OFFER_INTERVAL_MS: 150,
  OFFER_LIMIT: 40,
};

interface RawEntry {
  i: number;
  at: number;
  data: Record<string, unknown>;
}

/** A light projection of an inbound message. The raw payload is never serialised back to Node. */
interface InboundNote {
  i: number;
  at: number;
  type: string | null;
  kind: string | null;
  activationId: string | null;
}

interface DocumentIdentity {
  playerSessionId: string;
  packageRevision: string;
  documentId: string;
}

interface ActivationIdentity {
  activationId: string;
  variantKey: string;
  configHash: string;
}

/** Payloads too large or too deep to hand across the Playwright boundary are BUILT in the page. */
type PayloadGen =
  | { kind: 'deep'; depth: number }
  | { kind: 'proto' }
  | { kind: 'long'; length: number }
  | null;

interface OfferSpec {
  /** The EXACT object to post. Built in Node so a missing field is genuinely missing. */
  message: Record<string, unknown>;
  /** How many MessagePorts to transfer. 0 and 2 are both legal to attempt and both illegal to accept. */
  ports: number;
  /** targetOrigin for the post. Defaults to the simulation frame's own origin. */
  targetOrigin?: string;
  /** Post from a same-origin RELAY frame, so `event.source` is not `window.parent`. */
  viaRelay?: boolean;
}

interface ChannelReport {
  index: number;
  /** Everything the parent's end of a HOSTILE channel received. Must always be empty. */
  messages: { at: number; kind: string | null; type: string | null }[];
  /** True when the engine told us the child closed its end. See `portCloseObservable`. */
  closed: boolean;
}

interface AttackApi {
  mount(src: string, ident: DocumentIdentity, defer: boolean): void;
  beginHandshake(): void;
  /** Deliver a hostile offer. Resolves with the indices of the channels it created. */
  offer(spec: OfferSpec): Promise<number[]>;
  channels(): ChannelReport[];
  /** Post an exact object on the ADOPTED port. */
  post(env: Record<string, unknown>, gen: PayloadGen): boolean;
  /** Post an exact object on a hostile channel's parent-side port. */
  postOn(index: number, env: Record<string, unknown>): boolean;
  mode(): string;
  mark(): number;
  peek(): RawEntry[];
  /** Does this engine report MessagePort closure to the other end at all? */
  portCloseObservable(): boolean;
  close(): void;
}

interface AttackWindow extends Window {
  __attack: AttackApi;
}

/**
 * The parent half of the v3 bootstrap, plus the delivery mechanisms the attacks need.
 *
 * The handshake half is the canary's driver verbatim in behaviour: offer a fresh MessageChannel per
 * attempt, address the child's EXACT origin, adopt whichever channel the child answers on, close the
 * losers. It is a re-expression of lib/sim/SimTransport rather than an import of it, because a
 * defect in the client's transport must not be able to launder a defect in the runtime, or the
 * reverse.
 *
 * THREE THINGS ARE ADDED, and each exists because an attack cannot be expressed without it:
 *   `offer(spec)`  posts an EXACT message object — so "missing documentId" is genuinely a missing
 *                  own property rather than an explicit `undefined`, which survives structured clone
 *                  as a present-but-empty field and would test something else entirely.
 *   `viaRelay`     forwards that offer through a same-origin srcdoc frame. The child's first
 *                  bootstrap check is `event.source !== window.parent`, and the only way to make
 *                  that true while keeping the origin honest is for the POSTING SCRIPT to live in
 *                  another realm — the message's `source` is the incumbent global, not the target.
 *   `gen`          builds a hostile payload IN THE PAGE. A 1 MB string and a 250-deep object are
 *                  fine over a MessagePort and pointless to push through the test-driver protocol.
 *
 * It judges nothing. Every inbound message is stored raw and validated in Node by the shipped
 * `validateEnvelope`.
 */
function installAttackDriver(K: WireConstants): void {
  // The init script runs in EVERY frame, including the simulation's and the relay's. A second driver
  // there would add a competing window listener to the document that is trying to adopt a port.
  if (window.parent !== window) return;

  const raw: RawEntry[] = [];
  let nextIndex = 0;

  let mode = 'idle';
  let identity: DocumentIdentity | null = null;
  let targetOrigin = '';
  let frame: HTMLIFrameElement | null = null;
  let port: MessagePort | null = null;
  let pending: MessageChannel[] = [];
  let timer = 0;

  interface HostileChannel {
    index: number;
    ch: MessageChannel;
    messages: { at: number; kind: string | null; type: string | null }[];
    closed: boolean;
  }
  const hostile: HostileChannel[] = [];
  let channelSeq = 0;

  let relay: HTMLIFrameElement | null = null;
  let relayLoading: Promise<void> | null = null;

  const closeObservable = typeof MessagePort !== 'undefined' && 'onclose' in MessagePort.prototype;

  function stopOffering(): void {
    if (timer) {
      clearInterval(timer);
      timer = 0;
    }
    for (const ch of pending) {
      try {
        ch.port1.onmessage = null;
        ch.port1.close();
      } catch {
        /* already closed */
      }
    }
    pending = [];
  }

  function adopt(ch: MessageChannel): void {
    port = ch.port1;
    pending = pending.filter((c) => c !== ch);
    stopOffering();
    port.onmessage = (ev: MessageEvent) => {
      raw.push({ i: nextIndex++, at: Date.now(), data: ev.data as Record<string, unknown> });
    };
    mode = 'modern';
  }

  function onFirstChannelMessage(ch: MessageChannel, ev: MessageEvent): void {
    if (mode !== 'offering' || !identity) {
      try {
        ch.port1.close();
      } catch {
        /* already closed */
      }
      return;
    }
    const data = ev.data as { kind?: unknown; protocolVersion?: unknown; documentId?: unknown } | null;
    if (
      !data ||
      typeof data !== 'object' ||
      data.kind !== K.ACCEPT ||
      data.protocolVersion !== K.VER ||
      data.documentId !== identity.documentId
    ) {
      return;
    }
    adopt(ch);
  }

  function offerLegit(): void {
    if (mode !== 'offering' || !identity || !frame) return;
    const win = frame.contentWindow;
    if (!win) return;
    if (pending.length >= K.OFFER_LIMIT) return;
    let ch: MessageChannel;
    try {
      ch = new MessageChannel();
    } catch {
      return;
    }
    ch.port1.onmessage = (ev: MessageEvent) => onFirstChannelMessage(ch, ev);
    ch.port1.start();
    try {
      win.postMessage(
        {
          kind: K.BOOTSTRAP,
          protocolVersion: K.VER,
          playerSessionId: identity.playerSessionId,
          packageRevision: identity.packageRevision,
          documentId: identity.documentId,
          parentOrigin: window.location.origin,
        },
        targetOrigin,
        [ch.port2],
      );
      pending.push(ch);
    } catch {
      try {
        ch.port1.close();
      } catch {
        /* already closed */
      }
    }
  }

  window.addEventListener('message', (e: MessageEvent) => {
    if (!frame || e.source !== frame.contentWindow) return;
    const data = e.data as { kind?: unknown; protocolVersion?: unknown } | null;
    if (!data || typeof data !== 'object') return;
    if (data.kind === K.HELLO && data.protocolVersion === K.VER) offerLegit();
  });

  /**
   * A same-origin forwarder whose OWN script does the posting.
   *
   * `srcdoc` inherits the harness's origin, so the forwarded offer still carries the harness origin
   * in `event.origin` — the offer's `parentOrigin` therefore still agrees with it, and `source` is
   * the ONLY thing wrong with the message. Isolating the defect to one field is the whole point:
   * a refusal that could equally be explained by a second fault proves nothing about the first.
   */
  function ensureRelay(): Promise<void> {
    if (relayLoading) return relayLoading;
    relayLoading = new Promise<void>((resolve, reject) => {
      const f = document.createElement('iframe');
      f.id = 'relay';
      f.setAttribute('aria-hidden', 'true');
      f.style.cssText = 'position:absolute;left:-9999px;top:0;width:1px;height:1px;border:0';
      f.srcdoc =
        '<!doctype html><meta charset="utf-8"><' + 'script>' +
        'window.addEventListener("message", function (e) {' +
        '  var d = e.data; if (!d || d.__relay !== 1) return;' +
        '  var t = null;' +
        '  try { t = parent.document.getElementById("sim").contentWindow; } catch (err) { t = null; }' +
        '  if (!t) return;' +
        '  t.postMessage(d.msg, d.origin, e.ports);' +
        '}, false);' +
        '<' + '/script>';
      f.onload = () => {
        relay = f;
        resolve();
      };
      f.onerror = () => reject(new Error('the relay frame could not load'));
      document.body.appendChild(f);
    });
    return relayLoading;
  }

  function makeHostileChannel(): HostileChannel {
    const ch = new MessageChannel();
    const rec: HostileChannel = { index: ++channelSeq, ch, messages: [], closed: false };
    // Setting onmessage STARTS the port, which is also what makes the `close` event (where the
    // engine has one) deliverable. Anything arriving here is a refusal that did not happen.
    ch.port1.onmessage = (ev: MessageEvent) => {
      const d = (ev.data ?? {}) as { kind?: unknown; type?: unknown };
      rec.messages.push({
        at: Date.now(),
        kind: typeof d.kind === 'string' ? d.kind : null,
        type: typeof d.type === 'string' ? d.type : null,
      });
    };
    if (closeObservable) {
      (ch.port1 as unknown as { onclose: (() => void) | null }).onclose = () => {
        rec.closed = true;
      };
    }
    hostile.push(rec);
    return rec;
  }

  function generatePayload(gen: PayloadGen): unknown {
    if (!gen) return undefined;
    if (gen.kind === 'deep') {
      let node: Record<string, unknown> = { leaf: true };
      for (let i = 0; i < gen.depth; i++) node = { depth: i, next: node };
      return node;
    }
    if (gen.kind === 'proto') {
      // JSON.parse is the classic pollution vector: it creates "__proto__" as an OWN data property,
      // which structured clone preserves and a naive merge would apply to Object.prototype.
      return JSON.parse(
        '{"__proto__":{"polluted":"yes"},' +
        '"inner":{"__proto__":{"pollutedInner":"yes"}},' +
        '"constructor":{"prototype":{"pollutedCtor":"yes"}}}',
      ) as unknown;
    }
    let s = 'x';
    while (s.length < gen.length) s += s;
    return { note: s.slice(0, gen.length) };
  }

  const api: AttackApi = {
    mount(src: string, ident: DocumentIdentity, defer: boolean): void {
      stopOffering();
      if (port) {
        try {
          port.onmessage = null;
          port.close();
        } catch {
          /* already closed */
        }
        port = null;
      }
      raw.length = 0;
      identity = ident;
      targetOrigin = new URL(src, window.location.href).origin;

      const stage = document.getElementById('stage');
      if (!stage) throw new Error('protocol harness has no #stage');
      while (stage.firstChild) stage.removeChild(stage.firstChild);
      const f = document.createElement('iframe');
      f.id = 'sim';
      f.title = 'sim protocol';
      f.setAttribute('allow', 'autoplay; xr-spatial-tracking');
      f.style.cssText = 'display:block;border:0;width:100%;height:100%;background:transparent';
      // No `sandbox`: a sandboxed frame without allow-same-origin has an OPAQUE origin, there is no
      // exact origin to address an offer to, and the child's recorder and state would be unreadable
      // — which would remove every "delivered" and "no state change" proof this suite depends on.
      f.src = src;
      stage.appendChild(f);
      frame = f;

      mode = defer ? 'staged' : 'offering';
      if (!defer) {
        offerLegit();
        timer = window.setInterval(offerLegit, K.OFFER_INTERVAL_MS);
      }
    },

    beginHandshake(): void {
      if (mode !== 'staged') return;
      mode = 'offering';
      offerLegit();
      timer = window.setInterval(offerLegit, K.OFFER_INTERVAL_MS);
    },

    offer(spec: OfferSpec): Promise<number[]> {
      const prepared = spec.viaRelay ? ensureRelay() : Promise.resolve();
      return prepared.then(() => {
        const win = frame && frame.contentWindow;
        if (!win) throw new Error('no simulation frame is mounted');
        const transfer: MessagePort[] = [];
        const made: number[] = [];
        for (let i = 0; i < spec.ports; i++) {
          const rec = makeHostileChannel();
          made.push(rec.index);
          transfer.push(rec.ch.port2);
        }
        const to = spec.targetOrigin !== undefined ? spec.targetOrigin : targetOrigin;
        if (spec.viaRelay) {
          const r = relay && relay.contentWindow;
          if (!r) throw new Error('the relay frame is not available');
          r.postMessage({ __relay: 1, msg: spec.message, origin: to }, '*', transfer);
        } else {
          win.postMessage(spec.message, to, transfer);
        }
        return made;
      });
    },

    channels(): ChannelReport[] {
      return hostile.map((h) => ({ index: h.index, messages: h.messages, closed: h.closed }));
    },

    post(env: Record<string, unknown>, gen: PayloadGen): boolean {
      if (!port) return false;
      if (gen) env.payload = generatePayload(gen);
      try {
        port.postMessage(env);
        return true;
      } catch {
        return false;
      }
    },

    postOn(index: number, env: Record<string, unknown>): boolean {
      const rec = hostile.find((h) => h.index === index);
      if (!rec) return false;
      try {
        rec.ch.port1.postMessage(env);
        return true;
      } catch {
        return false;
      }
    },

    mode(): string {
      return mode;
    },
    mark(): number {
      return nextIndex - 1;
    },
    peek(): RawEntry[] {
      return raw;
    },
    portCloseObservable(): boolean {
      return closeObservable;
    },
    close(): void {
      stopOffering();
      if (port) {
        try {
          port.onmessage = null;
          port.close();
        } catch {
          /* already closed */
        }
        port = null;
      }
      mode = 'closed';
    },
  };

  (window as unknown as AttackWindow).__attack = api;
}

// ─── Node-side driver helpers ─────────────────────────────────────────────────────────────────

let page: Page;
let context: BrowserContext;

const driverMode = (): Promise<string> =>
  page.evaluate(() => (window as unknown as AttackWindow).__attack.mode());

const mark = (): Promise<number> =>
  page.evaluate(() => (window as unknown as AttackWindow).__attack.mark());

const channelReports = (): Promise<ChannelReport[]> =>
  page.evaluate(() => (window as unknown as AttackWindow).__attack.channels());

const portCloseObservable = (): Promise<boolean> =>
  page.evaluate(() => (window as unknown as AttackWindow).__attack.portCloseObservable());

const postEnvelope = (env: Record<string, unknown>, gen: PayloadGen = null): Promise<boolean> =>
  page.evaluate(
    (a) => (window as unknown as AttackWindow).__attack.post(a.env, a.gen),
    { env, gen },
  );

const postOnChannel = (index: number, env: Record<string, unknown>): Promise<boolean> =>
  page.evaluate(
    (a) => (window as unknown as AttackWindow).__attack.postOn(a.index, a.env),
    { index, env },
  );

const offerHostile = (spec: OfferSpec): Promise<number[]> =>
  page.evaluate((s) => (window as unknown as AttackWindow).__attack.offer(s), spec);

/** Inbound messages the PARENT received on the adopted port after a cursor, as a light projection. */
const inboundAfter = (after: number): Promise<InboundNote[]> =>
  page.evaluate((cursor) => {
    const out: InboundNote[] = [];
    for (const r of (window as unknown as AttackWindow).__attack.peek()) {
      if (r.i <= cursor) continue;
      const d = (r.data ?? {}) as { type?: unknown; kind?: unknown; activationId?: unknown };
      out.push({
        i: r.i,
        at: r.at,
        type: typeof d.type === 'string' ? d.type : null,
        kind: typeof d.kind === 'string' ? d.kind : null,
        activationId: typeof d.activationId === 'string' ? d.activationId : null,
      });
    }
    return out;
  }, after);

interface EnvelopeMatch {
  type: string;
  activationId?: string;
  after?: number;
}

async function waitForEnvelope(m: EnvelopeMatch, timeout: number, what: string): Promise<Record<string, unknown>> {
  try {
    const handle = await page.waitForFunction(
      (match) => {
        const attack = (window as unknown as AttackWindow).__attack;
        if (!attack) return null;
        for (const r of attack.peek()) {
          if (match.after !== undefined && r.i <= match.after) continue;
          const e = r.data;
          if (!e || typeof e !== 'object') continue;
          if (e.type !== match.type) continue;
          if (match.activationId !== undefined && e.activationId !== match.activationId) continue;
          return e;
        }
        return null;
      },
      m,
      { timeout, polling: 20 },
    );
    return (await handle.jsonValue()) as Record<string, unknown>;
  } catch {
    throw new Error(`${what}: no ${m.type} matching ${JSON.stringify(m)} arrived within ${timeout}ms`);
  }
}

/** Two animation frames: enough for a scheduled acknowledgement to have landed. */
const settle = (): Promise<void> =>
  page.evaluate(
    () =>
      new Promise<void>((r) => {
        requestAnimationFrame(() => requestAnimationFrame(() => r()));
      }),
  );

async function quiet(ms: number = QUIET_MS): Promise<void> {
  await page.waitForTimeout(ms);
  await settle();
}

// ─── The child's own transcript and state ─────────────────────────────────────────────────────

/** One entry of the fixture's recorder. `payload` is deliberately never carried back to Node. */
interface ProtoRecord {
  dir: 'in' | 'out';
  channel: 'window' | 'port';
  port: number | null;
  at: number;
  kind: string | null;
  type: string | null;
  seq: number | null;
  playerSessionId: string | null;
  packageRevision: string | null;
  documentId: string | null;
  activationId: string | null;
  variantKey: string | null;
  configHash: string | null;
  payloadType: string;
}

async function protoLength(): Promise<number> {
  const n = await page.evaluate((g) => {
    const f = document.querySelector('#stage iframe') as HTMLIFrameElement | null;
    try {
      const w = f?.contentWindow as unknown as Record<string, unknown> | null;
      const log = w ? w[g] : undefined;
      return Array.isArray(log) ? log.length : -1;
    } catch {
      return -1;
    }
  }, V3_PROTO_GLOBAL);
  if (n < 0) {
    throw new Error(
      `the staged package exposes no ${V3_PROTO_GLOBAL} recorder — every delivery proof in this ` +
      'suite depends on it, so the run cannot continue',
    );
  }
  return n;
}

async function readProto(from: number): Promise<ProtoRecord[]> {
  const rows = await page.evaluate(
    (a) => {
      const f = document.querySelector('#stage iframe') as HTMLIFrameElement | null;
      const w = f?.contentWindow as unknown as Record<string, unknown> | null;
      const log = w ? (w[a.g] as Record<string, unknown>[] | undefined) : undefined;
      if (!Array.isArray(log)) return [];
      // The payload is dropped here on purpose: one attack carries a 1 MB string and another a
      // 250-deep object, and shipping either back through the driver protocol per attack would
      // dominate the run. Its TYPE is kept, which is the only part any assertion reads.
      return log.slice(a.from).map((r) => ({
        dir: r.dir,
        channel: r.channel,
        port: r.port,
        at: r.at,
        kind: r.kind,
        type: r.type,
        seq: r.seq,
        playerSessionId: r.playerSessionId,
        packageRevision: r.packageRevision,
        documentId: r.documentId,
        activationId: r.activationId,
        variantKey: r.variantKey,
        configHash: r.configHash,
        payloadType: Array.isArray(r.payload) ? 'array' : r.payload === null ? 'null' : typeof r.payload,
      }));
    },
    { g: V3_PROTO_GLOBAL, from },
  );
  return rows as unknown as ProtoRecord[];
}

/**
 * Everything about the child that an accepted message could move.
 *
 * The free-running counters (`frames`, `ticks`, `pings`) are DELIBERATELY excluded: the managed
 * body's rAF loop and its automation interval advance on their own, so including them would make
 * every before/after comparison differ and the "no state change" assertion would have to be
 * loosened into uselessness. Everything a command can touch is here, plus the document-level marker
 * and the child realm's `Object.prototype` shape — the witness for the pollution attack.
 */
interface ChildSnapshot {
  sections: string;
  markerSection: string | null;
  hideUiInstalled: boolean;
  objectPrototypeKeys: number;
  polluted: string[];
}

async function readChild(): Promise<ChildSnapshot> {
  const snap = await page.evaluate((g) => {
    const f = document.querySelector('#stage iframe') as HTMLIFrameElement | null;
    const w = f?.contentWindow as unknown as (Window & Record<string, unknown>) | null;
    const doc = f?.contentDocument ?? null;
    if (!w || !doc) return null;
    const num = (v: unknown): number => (typeof v === 'number' ? v : -1);
    const table = (w[g] ?? {}) as Record<string, Record<string, unknown>>;
    const projected: Record<string, unknown> = {};
    for (const label of Object.keys(table).sort()) {
      const s = table[label] ?? {};
      projected[label] = {
        presented: num(s.presented),
        draws: num(s.draws),
        presentCalls: num(s.presentCalls),
        attempts: num(s.attempts),
        prepared: !!s.prepared,
        activated: !!s.activated,
        autoPaused: !!s.autoPaused,
        suspended: !!s.suspended,
        released: !!s.released,
        disposed: !!s.disposed,
        aborted: !!s.aborted,
        cleaned: !!s.cleaned,
        resolved: !!s.resolved,
        quality: typeof s.quality === 'string' ? s.quality : null,
        audible: s.audible ? JSON.stringify(s.audible) : null,
      };
    }
    const marker = doc.getElementById('marker');
    // The pollution witness. A merge of the hostile payload into any object would show up as a new
    // own property on the CHILD's Object.prototype — which is a different realm from this script's.
    const ChildObject = (w as unknown as { Object: ObjectConstructor }).Object;
    const names = ChildObject.getOwnPropertyNames(ChildObject.prototype);
    const polluted = ['polluted', 'pollutedInner', 'pollutedCtor'].filter(
      (k) => (ChildObject.prototype as unknown as Record<string, unknown>)[k] !== undefined,
    );
    return {
      sections: JSON.stringify(projected),
      markerSection: marker ? marker.getAttribute('data-section') : null,
      hideUiInstalled: !!doc.getElementById('__simHideUi'),
      objectPrototypeKeys: names.length,
      polluted,
    };
  }, V3_STATE_GLOBAL);
  if (!snap) throw new Error('the simulation document is unreadable — no state witness is available');
  return snap;
}

const sameSnapshot = (a: ChildSnapshot, b: ChildSnapshot): boolean =>
  a.sections === b.sections &&
  a.markerSection === b.markerSection &&
  a.hideUiInstalled === b.hideUiInstalled &&
  a.objectPrototypeKeys === b.objectPrototypeKeys &&
  a.polluted.join(',') === b.polluted.join(',');

const describeSnapshot = (s: ChildSnapshot): string =>
  `marker=${s.markerSection} hideUi=${s.hideUiInstalled} protoKeys=${s.objectPrototypeKeys} ` +
  `polluted=[${s.polluted.join(',')}] sections=${s.sections}`;

// ─── The ledger ───────────────────────────────────────────────────────────────────────────────

type AttackGroup =
  | 'bootstrap'
  | 'adoption'
  // Deliberately separate from 'adoption': that group's verdict asserts REFUSAL, and this one must
  // be ADOPTED. Folding them together would make the recovery path read as a broken refusal.
  | 'adoption-recovery'
  | 'transport'
  | 'identity'
  | 'activation'
  | 'sequence'
  | 'payload'
  | 'structure';

interface ProbeEvidence {
  reachedChild: boolean;
  childOutbound: number;
  parentInbound: number;
  portCloseObservable: boolean;
  portClosed: boolean;
  /** Did the child answer the SECOND offer with a bootstrap accept — i.e. adopt it? */
  secondOfferAccepted: boolean;
  /** Does the ORIGINAL, adopted channel still complete a normal activation cycle afterwards? */
  originalPortStillAnswers: boolean;
}

interface AttackRecord {
  id: string;
  group: AttackGroup;
  what: string;
  /** Positive proof the hostile message reached the child. */
  delivered: boolean;
  delivery: string;
  /** Anything the child posted, on ANY port, in the window that followed. Must be empty. */
  outbound: string[];
  /** Anything that reached the parent on the adopted port. Must be empty. */
  parentInbound: string[];
  /**
   * Bootstrap accepts on the channels THIS attack offered. Must be 0.
   *
   * Scoped to the attack rather than counted across the whole run on purpose: the global count is
   * monotonic, so one genuine acceptance made every later record report it too and twenty-one
   * unrelated refusals were reported as failures of an attack that had in fact been refused
   * perfectly. Every hostile channel is created by exactly one attack, so nothing is lost.
   */
  accepts: number;
  stateBefore: string;
  stateAfter: string;
  stateUnchanged: boolean;
  /** Non-empty and starting with 'ok' when the full cycle completed after the attack. */
  liveness: string;
  probe: ProbeEvidence | null;
  notes: string[];
}

/** Every attack the contract requires. A silently missing one must not read as a pass. */
const REQUIRED_ATTACKS: readonly string[] = [
  'bootstrap/foreign-source',
  'bootstrap/origin-mismatch',
  'bootstrap/version-2',
  'bootstrap/version-4',
  'bootstrap/zero-ports',
  'bootstrap/two-ports',
  'bootstrap/no-player-session',
  'bootstrap/no-package-revision',
  'bootstrap/no-document-id',
  'bootstrap/second-offer-after-adoption',
  'transport/wrong-namespace',
  'transport/wrong-protocol-version',
  'transport/unknown-type',
  'transport/reflected-parent-inbound-type',
  'identity/wrong-player-session',
  'identity/wrong-package-revision',
  'identity/wrong-document-id',
  'activation/missing-activation-id',
  'activation/missing-variant-key',
  'activation/missing-config-hash',
  'sequence/duplicate',
  'sequence/lower',
  'sequence/zero',
  'sequence/non-integer',
  'sequence/missing',
  'payload/null',
  'payload/string',
  'payload/array',
  'payload/number',
  'structure/deep-nesting',
  'structure/proto-pollution',
  'structure/long-string',
];

interface StaleAckEvidence {
  act1: ActivationIdentity;
  act2: ActivationIdentity;
  act3: ActivationIdentity;
  sameVariantKey: boolean;
  sameConfigHash: boolean;
  differentActivationId: boolean;
  /** The child's OWN clocks, from its recorder. */
  staleMintedAt: number;
  act3BecameCurrentAt: number;
  replayDeliveredAt: number;
  /** The shipped transport validator's verdict on the stale envelope. */
  transportAccepts: boolean;
  transportReason: string | null;
  staleDocumentMatches: boolean;
  /** The shipped identity gate's verdict. */
  refusal: string | null;
  /** What the child did when the stale acknowledgement was delivered verbatim. */
  childOutboundAfterReplay: string[];
  parentInboundAfterReplay: string[];
  /** The reveal decisions, from the shipped reducer and gate. */
  revealBeforeAnyAcknowledgement: string;
  /** The state the machine reached when the STALE acknowledgement was allowed to drive it. */
  staleDroveMachineTo: string;
  revealWithStaleAcknowledgement: string;
  revealAfterOwnAcknowledgement: string;
  act3PresentedAfter: { activationId: string; framesSubmitted: number } | null;
  stateUnchanged: boolean;
}

interface MarkPresentedEvidence {
  noPresent: {
    activationId: string;
    presentCalls: number;
    acknowledgements: number;
    otherInbound: string[];
    watchedMs: number;
    liveness: string;
  };
  doubleAck: {
    activationId: string;
    acknowledgements: number;
    bodyPresentedCount: number;
    liveness: string;
  };
  deferAck: {
    deferredActivationId: string;
    supersededByActivationId: string;
    parked: boolean;
    bodyPresentedCount: number;
    acknowledgementsForDeferred: number;
    childOutboundAfterInvoke: string[];
    invokeThrew: string | null;
    liveness: string;
  };
}

interface RunReport {
  engine: string;
  package: string;
  /**
   * The Playwright RUNNER's process id — shared by every worker of one invocation and different
   * between invocations. It is what makes a ledger on disk identifiable as THIS run's rather than
   * a previous one's, which is what the worker-restart reuse below turns on.
   */
  runPid: number;
  /** Worker generations that read this ledger. More than one means a test failed and a worker died. */
  workerGenerations: number[];
  startedAt: string;
  finishedAt: string;
  aborted: string;
  variantsReported: string[];
  attacks: AttackRecord[];
  staleAck: StaleAckEvidence | null;
  markPresented: MarkPresentedEvidence | null;
  errors: CanaryError[];
  external: string[];
  portCloseObservable: boolean;
}

const report: RunReport = {
  engine: '',
  package: PACKAGE,
  runPid: process.ppid,
  workerGenerations: [],
  startedAt: new Date().toISOString(),
  finishedAt: '',
  aborted: '',
  variantsReported: [],
  attacks: [],
  staleAck: null,
  markPresented: null,
  errors: [],
  external: [],
  portCloseObservable: false,
};

const reportPath = (): string =>
  join(RESULTS_DIR, `sim-protocol-${report.engine.split('/')[0] || 'unknown'}.json`);

/**
 * The ledger THIS run already produced for THIS engine, if a worker died and took it with it.
 *
 * Playwright discards a worker process after a failed test and starts a fresh one, which re-runs
 * `beforeAll`. Without this, a suite with one genuine finding in it drives the whole attack sequence
 * once per remaining test — and every assertion would then be judging a DIFFERENT drive from the one
 * that produced the failure, which is both slow and dishonest: the report a reader opens would not be
 * the report the verdicts came from. Reusing the first drive's ledger makes "one run, one body of
 * evidence" true.
 *
 * The `runPid` guard is what keeps a ledger from a PREVIOUS invocation out: every worker of one
 * invocation is a child of the same runner process, and a stale file therefore never matches.
 */
function reusableLedger(engine: string): RunReport | null {
  const file = join(RESULTS_DIR, `sim-protocol-${engine.split('/')[0] || 'unknown'}.json`);
  if (!existsSync(file)) return null;
  try {
    const prev = JSON.parse(readFileSync(file, 'utf-8')) as RunReport;
    if (prev.runPid !== process.ppid || prev.engine !== engine) return null;
    return prev;
  } catch {
    return null;
  }
}

// ─── Envelope construction, in Node ───────────────────────────────────────────────────────────

/**
 * The transport's own bookkeeping, held in Node.
 *
 * The driver does NOT mint sequence numbers. Half the attacks are ABOUT the sequence number, and a
 * driver that owned the counter could not express "send exactly this seq" without a second, parallel
 * code path — which is how the attack and the healthy case stop being the same message with one
 * field changed.
 */
interface WireState {
  playerSessionId: string;
  packageRevision: string;
  documentId: string;
  seq: number;
}

let wire: WireState = { playerSessionId: '', packageRevision: '', documentId: '', seq: 0 };
/** The seq of the last message the child provably accepted (it answered it). */
let lastAcceptedSeq = 0;
/** Every activation this document has entered, oldest first. */
let history: ActivationIdentity[] = [];

function envelopeFor(
  type: string,
  payload: unknown,
  activation: ActivationIdentity | null,
  seq: number,
): Record<string, unknown> {
  const env: Record<string, unknown> = {
    namespace: SIM_PROTOCOL_NAMESPACE,
    protocolVersion: SIM_PROTOCOL_VERSION,
    type,
    playerSessionId: wire.playerSessionId,
    packageRevision: wire.packageRevision,
    documentId: wire.documentId,
    seq,
    payload: payload ?? {},
  };
  if (activation) {
    env.activationId = activation.activationId;
    env.variantKey = activation.variantKey;
    env.configHash = activation.configHash;
  }
  return env;
}

async function sendWellFormed(
  type: string,
  payload: unknown,
  activation: ActivationIdentity | null,
): Promise<number> {
  const seq = ++wire.seq;
  const ok = await postEnvelope(envelopeFor(type, payload, activation, seq));
  if (!ok) throw new Error(`could not send ${type} — no modern transport is open`);
  return seq;
}

// ─── Document + activation choreography ───────────────────────────────────────────────────────

const entryUrl = (variant: string): string =>
  `${API_ORIGIN}${publicPrefix(PACKAGE)}/index.html?section=${encodeURIComponent(variant)}&v=1`;

let playerSessionId = '';
let packageRevision = '';

/** Mount a fresh document epoch. `defer` withholds the bootstrap offer so an attack can precede it. */
async function mountDocument(defer: boolean): Promise<string> {
  const documentId = newDocumentId();
  wire = { playerSessionId, packageRevision, documentId, seq: 0 };
  lastAcceptedSeq = 0;
  history = [];
  await page.evaluate(
    (a) => (window as unknown as AttackWindow).__attack.mount(a.src, a.ident, a.defer),
    { src: entryUrl(V3A), ident: { playerSessionId, packageRevision, documentId }, defer },
  );
  // Readiness is "the BRIDGE has run", not "the document is complete".
  //
  // A freshly created iframe's `contentDocument` is the initial about:blank, whose readyState is
  // ALREADY 'complete' — so a readyState check (the one sim-canary and sim-leak use, where a slower
  // subsequent handshake absorbs the difference) returns immediately, before the fixture document
  // exists. Every measurement this suite takes before delivering an attack — the state snapshot, the
  // recorder cursor — would then be taken against about:blank, and `protoLength()` would abort the
  // run with "the package exposes no recorder". The recorder array is the one signal that says the
  // package's own bytes have executed.
  await page.waitForFunction(
    (g) => {
      const f = document.querySelector('#stage iframe') as HTMLIFrameElement | null;
      if (!f) return false;
      try {
        if (!f.contentDocument || f.contentDocument.readyState !== 'complete') return false;
        const w = f.contentWindow as unknown as Record<string, unknown> | null;
        return !!w && Array.isArray(w[g]);
      } catch {
        return false;
      }
    },
    V3_PROTO_GLOBAL,
    { timeout: LOAD_TIMEOUT_MS, polling: 20 },
  );
  return documentId;
}

/** Offer legitimately, adopt, and complete INIT_DOCUMENT → DOCUMENT_READY. */
async function handshake(): Promise<string[]> {
  await page.evaluate(() => (window as unknown as AttackWindow).__attack.beginHandshake());
  await page
    .waitForFunction(() => (window as unknown as AttackWindow).__attack.mode() === 'modern', undefined, {
      timeout: HANDSHAKE_TIMEOUT_MS,
    })
    .catch(() => {
      /* reported by the check below with the driver's actual state */
    });
  const mode = await driverMode();
  if (mode !== 'modern') {
    throw new Error(`the document never adopted a v3 port (driver mode '${mode}')`);
  }
  const cursor = await mark();
  await sendWellFormed(INIT_DOCUMENT, {
    parentOrigin: API_ORIGIN,
    quality: 'high',
    audible: { muted: true, volume: 0 },
  }, null);
  const ready = await waitForEnvelope({ type: DOCUMENT_READY, after: cursor }, HANDSHAKE_TIMEOUT_MS, 'handshake');
  lastAcceptedSeq = wire.seq;
  const payload = ready.payload as DocumentReadyPayload;
  return Array.isArray(payload?.variants) ? payload.variants : [];
}

/** PREPARE → SECTION_APPLIED → PRESENT → SECTION_PRESENTED for one activation. */
async function presentCycle(
  variantKey: string,
  config: SimPresentationConfig,
  what: string,
): Promise<{ activation: ActivationIdentity; presented: Record<string, unknown> }> {
  const activation: ActivationIdentity = {
    activationId: newActivationId(),
    variantKey,
    configHash: computeConfigHash(config),
  };
  const cursor = await mark();
  await sendWellFormed(PREPARE_SECTION, { variantKey, config }, activation);
  await waitForEnvelope(
    { type: SECTION_APPLIED, activationId: activation.activationId, after: cursor },
    CHOREO_TIMEOUT_MS,
    what,
  );
  await sendWellFormed(PRESENT_SECTION, {}, activation);
  const presented = await waitForEnvelope(
    { type: SECTION_PRESENTED, activationId: activation.activationId, after: cursor },
    CHOREO_TIMEOUT_MS,
    what,
  );
  const payload = presented.payload as SectionPresentedPayload;
  if (!(payload?.framesSubmitted >= 1)) {
    throw new Error(`${what}: SECTION_PRESENTED claimed ${String(payload?.framesSubmitted)} frames`);
  }
  lastAcceptedSeq = wire.seq;
  history.push(activation);
  return { activation, presented };
}

/**
 * The liveness proof run after EVERY attack: a full activation cycle, then a SET_QUALITY whose
 * QUALITY_APPLIED both closes the loop and leaves an observable mark (`__V3_STATE__.V3A.quality`)
 * for the next attack's "no state change" comparison to be measured against.
 */
async function proveLiveness(what: string): Promise<string> {
  const { activation } = await presentCycle(V3A, BASE_CONFIG, what);
  const cursor = await mark();
  await sendWellFormed(SET_QUALITY, { profile: 'high' }, null);
  const applied = await waitForEnvelope({ type: QUALITY_APPLIED, after: cursor }, CHOREO_TIMEOUT_MS, what);
  const qp = applied.payload as { profile?: string };
  if (qp?.profile !== 'high') {
    throw new Error(`${what}: QUALITY_APPLIED echoed '${String(qp?.profile)}'`);
  }
  lastAcceptedSeq = wire.seq;
  return `ok — activation ${activation.activationId} applied+presented, quality echoed`;
}

// ─── One attack ───────────────────────────────────────────────────────────────────────────────

interface AttackSpec {
  id: string;
  group: AttackGroup;
  what: string;
  /** Which recorder channel must show the message arriving. */
  expect: 'window' | 'port';
  deliver: () => Promise<void>;
  /** Extra evidence gathered while the attack is still the most recent thing that happened. */
  after?: (rec: AttackRecord) => Promise<void>;
  /** How liveness is re-established. Bootstrap attacks must handshake first. */
  liveness?: () => Promise<string>;
  /** Called when liveness fails, to bring the run back to a state later attacks can use. */
  recover?: () => Promise<void>;
}

const describeOut = (r: ProtoRecord): string =>
  `${r.kind ?? r.type ?? '(shapeless)'}${r.seq === null ? '' : ` seq=${r.seq}`}` +
  `${r.activationId ? ` act=${r.activationId}` : ''} on port ${r.port ?? '?'}`;

const describeIn = (r: ProtoRecord): string =>
  `${r.channel}:${r.kind ?? r.type ?? '(shapeless)'}${r.seq === null ? '' : ` seq=${r.seq}`}`;

/**
 * Every bootstrap-shaped message this document has seen or sent, in order.
 *
 * Recorded on every bootstrap attack because the interesting failure mode — "which offer did the
 * child actually adopt" — is invisible in a pass/fail. It is the difference between "the refusal
 * held" and "the refusal held because the handshake had not happened yet", and only the child's own
 * port numbering can tell them apart.
 */
async function bootstrapHistory(): Promise<string> {
  const all = await readProto(0);
  return all
    .filter((r) => r.channel === 'window' || r.kind !== null)
    .map((r) => `${r.dir}:${r.channel}${r.port === null ? '' : `#${r.port}`}:${r.kind ?? r.type ?? '?'}:${r.documentId ?? 'no-doc'}`)
    .join(' → ');
}

async function runAttack(spec: AttackSpec): Promise<AttackRecord> {
  const stateBefore = await readChild();
  const protoFrom = await protoLength();
  const cursor = await mark();
  const channelsBefore = new Set((await channelReports()).map((c) => c.index));

  const rec: AttackRecord = {
    id: spec.id,
    group: spec.group,
    what: spec.what,
    delivered: false,
    delivery: '',
    outbound: [],
    parentInbound: [],
    accepts: 0,
    stateBefore: describeSnapshot(stateBefore),
    stateAfter: '',
    stateUnchanged: false,
    liveness: '',
    probe: null,
    notes: [],
  };

  try {
    await spec.deliver();
  } catch (err) {
    rec.notes.push(`delivery threw: ${err instanceof Error ? err.message : String(err)}`);
  }
  await quiet();

  const records = await readProto(protoFrom);
  const inbound = await inboundAfter(cursor);
  const stateAfter = await readChild();
  const chans = await channelReports();

  const arrivals = records.filter((r) => r.dir === 'in' && r.channel === spec.expect);
  rec.delivered = arrivals.length > 0;
  rec.delivery = records.filter((r) => r.dir === 'in').map(describeIn).join(' | ') || '(nothing arrived)';
  rec.outbound = records.filter((r) => r.dir === 'out').map(describeOut);
  rec.parentInbound = inbound.map((e) => `${e.type ?? e.kind ?? '(shapeless)'}${e.activationId ? ` act=${e.activationId}` : ''}`);
  rec.accepts = chans
    .filter((c) => !channelsBefore.has(c.index))
    .reduce((n, c) => n + c.messages.filter((m) => m.kind === SIM_BOOTSTRAP_ACCEPT_KIND).length, 0);
  rec.stateAfter = describeSnapshot(stateAfter);
  rec.stateUnchanged = sameSnapshot(stateBefore, stateAfter);

  if (spec.after) await spec.after(rec);

  try {
    rec.liveness = await (spec.liveness ?? (() => proveLiveness(spec.id)))();
  } catch (err) {
    rec.liveness = `FAILED: ${err instanceof Error ? err.message : String(err)}`;
    if (spec.recover) {
      try {
        await spec.recover();
        rec.notes.push('the run was recovered onto a fresh document after the liveness failure');
      } catch (e2) {
        rec.notes.push(`recovery failed: ${e2 instanceof Error ? e2.message : String(e2)}`);
      }
    }
  }

  report.attacks.push(rec);
  return rec;
}

// ─── Bootstrap attacks ────────────────────────────────────────────────────────────────────────

function baseOffer(documentId: string): Record<string, unknown> {
  return {
    kind: SIM_BOOTSTRAP_KIND,
    protocolVersion: SIM_PROTOCOL_VERSION,
    playerSessionId,
    packageRevision,
    documentId,
    parentOrigin: API_ORIGIN,
  };
}

/**
 * One bootstrap refusal, on a document that has NOT yet adopted.
 *
 * The un-adopted state is essential: the runtime's very first bootstrap check is `if (adopted)`, so
 * an attack delivered to an adopted document would be refused for a reason that has nothing to do
 * with the field under test. Case 10 (a second offer AFTER adoption) is the one that deliberately
 * tests that branch, and it is written separately below.
 */
async function bootstrapAttack(
  id: string,
  what: string,
  mutate: (offer: Record<string, unknown>) => void,
  opts: { ports?: number; viaRelay?: boolean } = {},
): Promise<void> {
  await mountDocument(true);
  const hostileDocumentId = newDocumentId();
  const message = baseOffer(hostileDocumentId);
  mutate(message);
  await runAttack({
    id,
    group: 'bootstrap',
    what,
    expect: 'window',
    deliver: async () => {
      await offerHostile({ message, ports: opts.ports ?? 1, viaRelay: !!opts.viaRelay });
    },
    after: async (rec) => {
      rec.notes.push(`hostile offer documentId=${hostileDocumentId}, ports=${opts.ports ?? 1}`);
      rec.notes.push(`driver mode after the refused offer: ${await driverMode()}`);
      rec.notes.push(`bootstrap history: ${await bootstrapHistory()}`);
    },
    // The legitimate handshake IS the proof of refusal: a child that had adopted the hostile offer
    // would refuse this one and never answer.
    liveness: async () => {
      const variants = await handshake();
      if (variants.length > 0) report.variantsReported = variants;
      return `${await proveLiveness(id)} (after a legitimate offer was adopted)`;
    },
    recover: async () => {
      await mountDocument(true);
      await handshake();
      await proveLiveness('recovery');
    },
  });
}

async function runBootstrapAttacks(): Promise<void> {
  await bootstrapAttack(
    'bootstrap/foreign-source',
    'an otherwise perfect offer posted by a same-origin frame that is not window.parent',
    () => { /* nothing is wrong with the message itself — only who sent it */ },
    { viaRelay: true },
  );
  await bootstrapAttack(
    'bootstrap/origin-mismatch',
    'parentOrigin claims an origin the event did not come from',
    (o) => { o.parentOrigin = 'https://not-the-parent.invalid'; },
  );
  await bootstrapAttack('bootstrap/version-2', 'protocolVersion 2 — one below the shipped version', (o) => {
    o.protocolVersion = 2;
  });
  await bootstrapAttack('bootstrap/version-4', 'protocolVersion 4 — one above the shipped version', (o) => {
    o.protocolVersion = 4;
  });
  await bootstrapAttack('bootstrap/zero-ports', 'an offer that transfers no port at all', () => {}, { ports: 0 });
  await bootstrapAttack('bootstrap/two-ports', 'an offer that transfers two ports', () => {}, { ports: 2 });
  await bootstrapAttack('bootstrap/no-player-session', 'an offer with no playerSessionId', (o) => {
    delete o.playerSessionId;
  });
  await bootstrapAttack('bootstrap/no-package-revision', 'an offer with no packageRevision', (o) => {
    delete o.packageRevision;
  });
  await bootstrapAttack('bootstrap/no-document-id', 'an offer with no documentId', (o) => {
    delete o.documentId;
  });
}

/**
 * A SECOND offer after adoption — refused, and its port closed.
 *
 * "Closed" is asserted two ways. Directly, where the engine implements the MessagePort `close`
 * event; and behaviourally everywhere, by posting a message the runtime WOULD answer (a SET_QUALITY
 * carrying the ORIGINAL, adopted identity) down the refused port and showing that no QUALITY_APPLIED
 * comes back on the adopted one. That second proof needs no engine feature and is the stronger of
 * the two: it says the message reached no dispatcher at all.
 */
async function runSecondOfferAttack(): Promise<void> {
  await mountDocument(true);
  await handshake();
  await proveLiveness('bootstrap/second-offer-after-adoption setup');

  // THE ADOPTED EPOCH's documentId, not a fresh one.
  //
  // This attack models the parent's own retry loop: SimTransport re-offers every 150 ms and every
  // one of those offers carries the SAME documentId (`open()` mints one epoch, `offer()` reuses
  // it). Those are the offers that must be refused — adopting one races the parent, which closes
  // every losing channel the instant it adopts, and would strand the child on a port whose parent
  // end is already gone. No engine fires a MessagePort close event, so neither side could detect
  // it and the document would go silent forever.
  //
  // A fresh documentId is a DIFFERENT question — the parent gave up and re-opened — and is the only
  // recovery path from an abandoned handshake. It is covered by its own attack below.
  const secondDocumentId = wire.documentId;
  const message = baseOffer(secondDocumentId);
  let channelIndex = -1;

  await runAttack({
    id: 'bootstrap/second-offer-after-adoption',
    // Its OWN group, not 'bootstrap'. The nine attacks above ask "is a malformed offer refused
    // before adoption"; this one asks "what does a WELL-FORMED offer do after adoption" — a
    // different question with a different answer, and folding it in would make one policy decision
    // read as ten broken refusals.
    group: 'adoption',
    what: 'a second, well-formed offer arriving on an already-adopted document',
    expect: 'window',
    deliver: async () => {
      const made = await offerHostile({ message, ports: 1 });
      channelIndex = made[0] ?? -1;
    },
    after: async (rec) => {
      rec.notes.push(`second offer documentId=${secondDocumentId} on channel ${channelIndex}`);
      rec.notes.push(`adopted documentId=${wire.documentId}`);
      rec.notes.push(`bootstrap history: ${await bootstrapHistory()}`);
      if (channelIndex < 0) {
        rec.notes.push('no channel was created — the probe below could not run');
        return;
      }
      // Post down the refused port, addressed with the identity the child DID adopt. If the port
      // were live, this is a message the runtime answers unconditionally.
      const probeSeq = ++wire.seq;
      const probe = envelopeFor(SET_QUALITY, { profile: 'low' }, null, probeSeq);
      const from = await protoLength();
      const cursor = await mark();
      const posted = await postOnChannel(channelIndex, probe);
      await quiet();
      const records = await readProto(from);
      const inbound = await inboundAfter(cursor);
      const chans = await channelReports();
      const mine = chans.find((c) => c.index === channelIndex);
      rec.probe = {
        reachedChild: records.some((r) => r.dir === 'in'),
        childOutbound: records.filter((r) => r.dir === 'out').length,
        parentInbound: inbound.length,
        portCloseObservable: await portCloseObservable(),
        portClosed: !!mine?.closed,
        secondOfferAccepted: !!mine?.messages.some((m) => m.kind === SIM_BOOTSTRAP_ACCEPT_KIND),
        // Filled in after the liveness cycle, which runs on the ORIGINAL port.
        originalPortStillAnswers: false,
      };
      // Folded into the standard verdict so the same assertions cover the probe.
      rec.outbound.push(...records.filter((r) => r.dir === 'out').map(describeOut));
      rec.parentInbound.push(...inbound.map((e) => `probe→${e.type ?? e.kind ?? '(shapeless)'}`));
      rec.notes.push(
        `probe posted=${posted}, reached the child=${rec.probe.reachedChild}, ` +
        `close event observable in this engine=${rec.probe.portCloseObservable}, ` +
        `close reported=${rec.probe.portClosed}`,
      );
      const after = await readChild();
      rec.stateAfter = describeSnapshot(after);
      rec.stateUnchanged = rec.stateBefore === rec.stateAfter;
    },
  });

  const rec = report.attacks[report.attacks.length - 1];
  if (rec?.probe) rec.probe.originalPortStillAnswers = rec.liveness.startsWith('ok');
}

/**
 * A second offer carrying a NEW document epoch — ADOPTED, because it is the only recovery.
 *
 * The complement of the attack above, and the reason that one is scoped to the adopted epoch rather
 * than refusing everything. The parent abandons a handshake after a bounded deadline; a package
 * whose listener installs later would otherwise hold a port nobody is listening to for the rest of
 * the document's life, running v2 while the canary had certified it modern — with no signal in
 * either direction, because no engine fires a MessagePort close event.
 *
 * Only `window.parent` can reach the adoption path at all (proven by the source/origin attacks
 * above), so adopting a new epoch from it is exactly as private as refusing one.
 */
async function runNewEpochOfferAttack(): Promise<void> {
  const freshDocumentId = newDocumentId();
  const message = baseOffer(freshDocumentId);
  let channelIndex = -1;

  await runAttack({
    id: 'adoption-recovery/new-epoch-offer',
    group: 'adoption-recovery',
    what: 'a well-formed offer carrying a NEW documentId after adoption',
    expect: 'window',
    deliver: async () => {
      const made = await offerHostile({ message, ports: 1 });
      channelIndex = made[0] ?? -1;
    },
    after: async (rec) => {
      rec.notes.push(`new-epoch offer documentId=${freshDocumentId} on channel ${channelIndex}`);
      rec.notes.push(`previously adopted documentId=${wire.documentId}`);
      rec.notes.push(`bootstrap history: ${await bootstrapHistory()}`);
      const chans = await channelReports();
      const mine = chans.find((c) => c.index === channelIndex);
      rec.probe = {
        reachedChild: false,
        childOutbound: 0,
        parentInbound: 0,
        portCloseObservable: await portCloseObservable(),
        portClosed: !!mine?.closed,
        secondOfferAccepted: !!mine?.messages.some((m) => m.kind === SIM_BOOTSTRAP_ACCEPT_KIND),
        originalPortStillAnswers: false,
      };
    },
  });
}

// ─── Attacks on the adopted port ──────────────────────────────────────────────────────────────

/**
 * Every hostile envelope is the HEALTHY envelope with exactly one thing changed.
 *
 * That is not a stylistic choice. A message that is wrong in two ways is refused for one of them,
 * and which one is unknowable from the outside — so the refusal proves nothing about the field the
 * attack was named after. Each builder below therefore starts from a well-formed carrier and makes
 * a single, named mutation.
 *
 * THE CARRIERS ARE CHOSEN SO THAT ACCEPTANCE WOULD BE LOUD.
 *   SET_QUALITY     is answered unconditionally with QUALITY_APPLIED, and the managed body records
 *                   the profile it was handed — so a wrongly accepted one is visible twice.
 *   PREPARE_SECTION has NO activation guard: acceptance would release the live activation and
 *                   acknowledge a new one. It is therefore the only honest carrier for the
 *                   missing-activation-identity cases; PAUSE_AUTOMATION would return early on the
 *                   identity mismatch and stay silent whether it was validated or not, which is a
 *                   test that cannot fail.
 *   PRESENT_SECTION for a SUPERSEDED activation is the carrier for the structural attacks: the
 *                   envelope is fully valid, so the hostile payload really does traverse validation
 *                   and dispatch, and the only reason nothing happens is the activation gate.
 */
interface PortAttackSpec {
  id: string;
  group: AttackGroup;
  what: string;
  build: () => Record<string, unknown>;
  gen?: PayloadGen;
}

function portAttackSpecs(): PortAttackSpec[] {
  const quality = (): Record<string, unknown> =>
    envelopeFor(SET_QUALITY, { profile: 'low' }, null, ++wire.seq);
  const newActivation = (): ActivationIdentity => ({
    activationId: newActivationId(),
    variantKey: V3B,
    configHash: BASE_HASH,
  });
  const prepare = (): Record<string, unknown> =>
    envelopeFor(PREPARE_SECTION, { variantKey: V3B, config: BASE_CONFIG }, newActivation(), ++wire.seq);
  const supersededPresent = (): Record<string, unknown> => {
    const stale = history.length >= 2 ? history[history.length - 2] : history[0];
    if (!stale) throw new Error('no superseded activation exists to carry the structural attack');
    return envelopeFor(PRESENT_SECTION, {}, stale, ++wire.seq);
  };

  return [
    {
      id: 'transport/wrong-namespace',
      group: 'transport',
      what: 'a perfectly shaped envelope stamped with someone else\'s namespace',
      build: () => ({ ...quality(), namespace: 'flowvid.sim.impostor' }),
    },
    {
      id: 'transport/wrong-protocol-version',
      group: 'transport',
      what: 'protocolVersion 2 on the adopted port',
      build: () => ({ ...quality(), protocolVersion: 2 }),
    },
    {
      id: 'transport/unknown-type',
      group: 'transport',
      what: 'a type the child has no handler for',
      build: () => ({ ...quality(), type: 'REVEAL_SECTION_NOW' }),
    },
    {
      id: 'transport/reflected-parent-inbound-type',
      group: 'transport',
      what: 'SECTION_PRESENTED — a CHILD→PARENT type — reflected back at the child',
      build: () => {
        const current = history[history.length - 1];
        if (!current) throw new Error('no activation exists to reflect an acknowledgement for');
        return envelopeFor(
          SECTION_PRESENTED,
          {
            variantKey: current.variantKey,
            configHash: current.configHash,
            canvas: { width: 10, height: 10 },
            framesSubmitted: 1,
          },
          current,
          ++wire.seq,
        );
      },
    },
    {
      id: 'identity/wrong-player-session',
      group: 'identity',
      what: 'a command for another player session',
      build: () => ({ ...quality(), playerSessionId: newPlayerSessionId() }),
    },
    {
      id: 'identity/wrong-package-revision',
      group: 'identity',
      what: 'a command describing a different package revision',
      build: () => ({ ...quality(), packageRevision: derivePackageRevision('e2e-other-package', 'deadbeef') }),
    },
    {
      id: 'identity/wrong-document-id',
      group: 'identity',
      what: 'a command for a different document epoch',
      build: () => ({ ...quality(), documentId: newDocumentId() }),
    },
    {
      id: 'activation/missing-activation-id',
      group: 'activation',
      what: 'PREPARE_SECTION with no activationId',
      build: () => {
        const env = prepare();
        delete env.activationId;
        return env;
      },
    },
    {
      id: 'activation/missing-variant-key',
      group: 'activation',
      what: 'PREPARE_SECTION with no variantKey',
      build: () => {
        const env = prepare();
        delete env.variantKey;
        return env;
      },
    },
    {
      id: 'activation/missing-config-hash',
      group: 'activation',
      what: 'PREPARE_SECTION with no configHash',
      build: () => {
        const env = prepare();
        delete env.configHash;
        return env;
      },
    },
    {
      id: 'sequence/duplicate',
      group: 'sequence',
      what: 'the sequence number of the message the child just accepted, replayed',
      build: () => envelopeFor(SET_QUALITY, { profile: 'low' }, null, lastAcceptedSeq),
    },
    {
      id: 'sequence/lower',
      group: 'sequence',
      what: 'a sequence number below the highest accepted — an out-of-order message',
      build: () => envelopeFor(SET_QUALITY, { profile: 'low' }, null, lastAcceptedSeq - 1),
    },
    {
      id: 'sequence/zero',
      group: 'sequence',
      what: 'seq 0 — sequences start at 1',
      build: () => envelopeFor(SET_QUALITY, { profile: 'low' }, null, 0),
    },
    {
      id: 'sequence/non-integer',
      group: 'sequence',
      what: 'a fractional sequence number',
      build: () => envelopeFor(SET_QUALITY, { profile: 'low' }, null, lastAcceptedSeq + 0.5),
    },
    {
      id: 'sequence/missing',
      group: 'sequence',
      what: 'no seq field at all',
      build: () => {
        const env = quality();
        delete env.seq;
        return env;
      },
    },
    {
      id: 'payload/null',
      group: 'payload',
      what: 'payload null',
      build: () => ({ ...quality(), payload: null }),
    },
    {
      id: 'payload/string',
      group: 'payload',
      what: 'payload is a string',
      build: () => ({ ...quality(), payload: 'profile=low' }),
    },
    {
      id: 'payload/array',
      group: 'payload',
      what: 'payload is an array — an object to `typeof`, and not an object to the protocol',
      build: () => ({ ...quality(), payload: ['low'] }),
    },
    {
      id: 'payload/number',
      group: 'payload',
      what: 'payload is a number',
      build: () => ({ ...quality(), payload: 42 }),
    },
    {
      id: 'structure/deep-nesting',
      group: 'structure',
      what: 'a 250-deep payload on a superseded activation',
      build: supersededPresent,
      gen: { kind: 'deep', depth: 250 },
    },
    {
      id: 'structure/proto-pollution',
      group: 'structure',
      what: 'a payload carrying own __proto__ and constructor.prototype keys',
      build: supersededPresent,
      gen: { kind: 'proto' },
    },
    {
      id: 'structure/long-string',
      group: 'structure',
      what: 'a payload carrying a one-million-character string',
      build: supersededPresent,
      gen: { kind: 'long', length: 1_000_000 },
    },
  ];
}

async function runPortAttacks(): Promise<void> {
  await mountDocument(true);
  const variants = await handshake();
  if (variants.length > 0) report.variantsReported = variants;
  // Two activations before the first attack: the structural attacks need a SUPERSEDED one to carry,
  // and "superseded" has to be true rather than merely unrecognised.
  await presentCycle(V3A, BASE_CONFIG, 'port-attack setup A');
  await proveLiveness('port-attack setup B');

  for (const spec of portAttackSpecs()) {
    let built: Record<string, unknown> | null = null;
    await runAttack({
      id: spec.id,
      group: spec.group,
      what: spec.what,
      expect: 'port',
      deliver: async () => {
        built = spec.build();
        const ok = await postEnvelope(built, spec.gen ?? null);
        if (!ok) throw new Error('the envelope could not be posted on the adopted port');
      },
      after: async (rec) => {
        const e = (built ?? {}) as Record<string, unknown>;
        rec.notes.push(
          `envelope: type=${String(e.type)} seq=${String(e.seq)} ns=${String(e.namespace)} ` +
          `ver=${String(e.protocolVersion)} act=${String(e.activationId ?? '(none)')} ` +
          `payload=${spec.gen ? spec.gen.kind : Array.isArray(e.payload) ? 'array' : typeof e.payload}`,
        );
      },
      recover: async () => {
        await mountDocument(true);
        await handshake();
        await presentCycle(V3A, BASE_CONFIG, 'recovery A');
        await proveLiveness('recovery B');
      },
    });
  }
}

// ─── The central case: a stale acknowledgement across A → B → A ───────────────────────────────

async function runStaleAckScenario(): Promise<void> {
  await mountDocument(true);
  await handshake();

  const first = await presentCycle(V3A, BASE_CONFIG, 'stale-ack activation 1 (A)');
  const staleEnvelope = first.presented;
  await presentCycle(V3B, BASE_CONFIG, 'stale-ack activation 2 (B)');

  // Activation 3: the SAME section and the SAME configuration as activation 1. Every axis agrees
  // except the activationId, which is the axis this whole protocol exists to add.
  const act3: ActivationIdentity = {
    activationId: newActivationId(),
    variantKey: V3A,
    configHash: BASE_HASH,
  };
  const prepareCursor = await mark();
  await sendWellFormed(PREPARE_SECTION, { variantKey: V3A, config: BASE_CONFIG }, act3);
  await waitForEnvelope(
    { type: SECTION_APPLIED, activationId: act3.activationId, after: prepareCursor },
    CHOREO_TIMEOUT_MS,
    'stale-ack activation 3 (A again)',
  );
  lastAcceptedSeq = wire.seq;
  history.push(act3);

  // ── deliver activation 1's acknowledgement, verbatim ──────────────────────────────────────
  const stateBefore = await readChild();
  const protoFrom = await protoLength();
  const replayCursor = await mark();
  const posted = await postEnvelope({ ...staleEnvelope });
  if (!posted) throw new Error('the stale acknowledgement could not be delivered');
  await quiet();
  const replayRecords = await readProto(protoFrom);
  const parentAfter = await inboundAfter(replayCursor);
  const stateAfter = await readChild();

  // ── the child's OWN clock ─────────────────────────────────────────────────────────────────
  const wholeLog = await readProto(0);
  const staleOut = wholeLog.find(
    (r) => r.dir === 'out' && r.type === SECTION_PRESENTED && r.activationId === first.activation.activationId,
  );
  const act3In = wholeLog.find(
    (r) => r.dir === 'in' && r.type === PREPARE_SECTION && r.activationId === act3.activationId,
  );
  const replayIn = replayRecords.find((r) => r.dir === 'in' && r.channel === 'port');

  // ── the shipped transport validator, in Node ──────────────────────────────────────────────
  const staleSeq = Number(staleEnvelope.seq);
  const verdict = validateEnvelope(staleEnvelope, {
    playerSessionId: wire.playerSessionId,
    documentId: wire.documentId,
    // The seq it actually arrived behind. The point of this check is that the envelope was — and
    // still is — a legal message for this transport: nothing about its SHAPE is what stops it.
    lastSeq: staleSeq - 1,
    allowedTypes: PARENT_INBOUND_TYPES,
  });

  // ── the shipped identity gate ─────────────────────────────────────────────────────────────
  const staleIdentity: PresentationIdentity = {
    packageRevision: String(staleEnvelope.packageRevision),
    documentId: String(staleEnvelope.documentId),
    activationId: String(staleEnvelope.activationId),
    variantKey: String(staleEnvelope.variantKey),
    configHash: String(staleEnvelope.configHash),
  };
  const currentIdentity: PresentationIdentity = {
    packageRevision: wire.packageRevision,
    documentId: wire.documentId,
    activationId: act3.activationId,
    variantKey: act3.variantKey,
    configHash: act3.configHash,
  };
  const refusal = identityRefusal(staleIdentity, currentIdentity);

  // What the PLAYER would do, driven by the SHIPPED reducer and the SHIPPED gate.
  //
  // The stale acknowledgement is deliberately allowed to drive the machine all the way to PRESENTED
  // — the worst case, in which every earlier line of defence has already failed and the ack is
  // treated as genuine. `mayReveal` must STILL refuse, and must refuse on the activation axis. A
  // version of this check that stopped the ack before the reducer would be measuring the caller,
  // and the caller is exactly what the reveal invariant is designed not to have to trust.
  let machine: ActivationMachineState = initialActivationState(currentIdentity);
  machine = activationReducer(machine, { type: 'PREPARE' });
  machine = activationReducer(machine, { type: 'APPLIED' });
  machine = activationReducer(machine, { type: 'PRESENT' });
  const beforeAnyAck = mayReveal({ activation: machine, current: currentIdentity, documentReady: true, contextLost: false });
  const withStaleAck = activationReducer(machine, { type: 'PRESENTED', ackIdentity: staleIdentity });
  const staleReveal = mayReveal({ activation: withStaleAck, current: currentIdentity, documentReady: true, contextLost: false });
  const withOwnAck = activationReducer(machine, { type: 'PRESENTED', ackIdentity: currentIdentity });
  const afterOwnAck = mayReveal({ activation: withOwnAck, current: currentIdentity, documentReady: true, contextLost: false });

  // ── activation 3's own acknowledgement still arrives ──────────────────────────────────────
  const presentCursor = await mark();
  await sendWellFormed(PRESENT_SECTION, {}, act3);
  const own = await waitForEnvelope(
    { type: SECTION_PRESENTED, activationId: act3.activationId, after: presentCursor },
    CHOREO_TIMEOUT_MS,
    'stale-ack: activation 3 presents after the replay',
  );
  lastAcceptedSeq = wire.seq;
  const ownPayload = own.payload as SectionPresentedPayload;

  report.staleAck = {
    act1: first.activation,
    act2: history[1],
    act3,
    sameVariantKey: first.activation.variantKey === act3.variantKey,
    sameConfigHash: first.activation.configHash === act3.configHash,
    differentActivationId: first.activation.activationId !== act3.activationId,
    staleMintedAt: staleOut?.at ?? -1,
    act3BecameCurrentAt: act3In?.at ?? -1,
    replayDeliveredAt: replayIn?.at ?? -1,
    transportAccepts: verdict.ok,
    transportReason: verdict.ok ? null : verdict.reason,
    staleDocumentMatches:
      staleEnvelope.documentId === wire.documentId && staleEnvelope.playerSessionId === wire.playerSessionId,
    refusal,
    childOutboundAfterReplay: replayRecords.filter((r) => r.dir === 'out').map(describeOut),
    parentInboundAfterReplay: parentAfter.map((e) => `${e.type ?? e.kind ?? '(shapeless)'}`),
    revealBeforeAnyAcknowledgement: beforeAnyAck.allowed ? 'allowed' : beforeAnyAck.refusal,
    staleDroveMachineTo: withStaleAck.state,
    revealWithStaleAcknowledgement: staleReveal.allowed ? 'allowed' : staleReveal.refusal,
    revealAfterOwnAcknowledgement: afterOwnAck.allowed ? 'allowed' : afterOwnAck.refusal,
    act3PresentedAfter: {
      activationId: String(own.activationId),
      framesSubmitted: ownPayload?.framesSubmitted ?? -1,
    },
    stateUnchanged: sameSnapshot(stateBefore, stateAfter),
  };
}

// ─── markPresented discipline ─────────────────────────────────────────────────────────────────

const countAcks = (records: ProtoRecord[], activationId: string): number =>
  records.filter((r) => r.dir === 'out' && r.type === SECTION_PRESENTED && r.activationId === activationId).length;

async function readSectionNumber(label: string, field: string): Promise<number> {
  return page.evaluate(
    (a) => {
      const f = document.querySelector('#stage iframe') as HTMLIFrameElement | null;
      try {
        const w = f?.contentWindow as unknown as Record<string, Record<string, Record<string, unknown>>> | null;
        const s = w && w[a.g] ? w[a.g][a.label] : null;
        const v = s ? s[a.field] : undefined;
        return typeof v === 'number' ? v : -1;
      } catch {
        return -1;
      }
    },
    { g: V3_STATE_GLOBAL, label, field },
  );
}

async function runMarkPresentedScenarios(): Promise<void> {
  await mountDocument(true);
  await handshake();

  // ── 1. V3NOPRESENT: silence, and nothing manufactures an acknowledgement ──────────────────
  const silent: ActivationIdentity = {
    activationId: newActivationId(),
    variantKey: V3NOPRESENT,
    configHash: BASE_HASH,
  };
  let cursor = await mark();
  let from = await protoLength();
  await sendWellFormed(PREPARE_SECTION, { variantKey: V3NOPRESENT, config: BASE_CONFIG }, silent);
  await waitForEnvelope(
    { type: SECTION_APPLIED, activationId: silent.activationId, after: cursor },
    CHOREO_TIMEOUT_MS,
    'V3NOPRESENT prepare',
  );
  const presentCursor = await mark();
  await sendWellFormed(PRESENT_SECTION, {}, silent);
  // Watched well past the player's own present bound: the question is not whether the parent gives
  // up (it must), it is whether the CHILD ever invents an acknowledgement once it has.
  await page.waitForTimeout(NO_PRESENT_WATCH_MS);
  await settle();
  const silentRecords = await readProto(from);
  const silentInbound = await inboundAfter(presentCursor);
  const presentCalls = await readSectionNumber('V3NOPRESENT', 'presentCalls');
  const noPresentLiveness = await proveLiveness('after V3NOPRESENT').catch(
    (e: unknown) => `FAILED: ${e instanceof Error ? e.message : String(e)}`,
  );

  // ── 2. the doubleAck knob: exactly one acknowledgement ────────────────────────────────────
  const doubleConfig: SimPresentationConfig = { ...BASE_CONFIG, initialState: { [V3_DOUBLE_ACK_KNOB]: true } };
  const doubled: ActivationIdentity = {
    activationId: newActivationId(),
    variantKey: V3A,
    configHash: computeConfigHash(doubleConfig),
  };
  cursor = await mark();
  from = await protoLength();
  await sendWellFormed(PREPARE_SECTION, { variantKey: V3A, config: doubleConfig }, doubled);
  await waitForEnvelope(
    { type: SECTION_APPLIED, activationId: doubled.activationId, after: cursor },
    CHOREO_TIMEOUT_MS,
    'doubleAck prepare',
  );
  await sendWellFormed(PRESENT_SECTION, {}, doubled);
  await waitForEnvelope(
    { type: SECTION_PRESENTED, activationId: doubled.activationId, after: cursor },
    CHOREO_TIMEOUT_MS,
    'doubleAck present',
  );
  lastAcceptedSeq = wire.seq;
  history.push(doubled);
  // The second call is made in the SAME frame as the first, so it has already happened by the time
  // the first acknowledgement is observed. The extra window exists for a defect that would defer it.
  await quiet(500);
  const doubleRecords = await readProto(from);
  const bodyPresented = await readSectionNumber('V3A', 'presented');
  const doubleLiveness = await proveLiveness('after doubleAck').catch(
    (e: unknown) => `FAILED: ${e instanceof Error ? e.message : String(e)}`,
  );

  // ── 3. the deferAck knob: a stale closure acknowledges nothing ────────────────────────────
  await page.evaluate((g) => {
    const f = document.querySelector('#stage iframe') as HTMLIFrameElement | null;
    const w = f?.contentWindow as unknown as Record<string, unknown> | null;
    if (w) delete w[g];
  }, V3_DEFERRED_ACK_GLOBAL);

  const deferConfig: SimPresentationConfig = { ...BASE_CONFIG, initialState: { [V3_DEFER_ACK_KNOB]: true } };
  const deferred: ActivationIdentity = {
    activationId: newActivationId(),
    variantKey: V3A,
    configHash: computeConfigHash(deferConfig),
  };
  cursor = await mark();
  from = await protoLength();
  await sendWellFormed(PREPARE_SECTION, { variantKey: V3A, config: deferConfig }, deferred);
  await waitForEnvelope(
    { type: SECTION_APPLIED, activationId: deferred.activationId, after: cursor },
    CHOREO_TIMEOUT_MS,
    'deferAck prepare',
  );
  await sendWellFormed(PRESENT_SECTION, {}, deferred);
  // The closure has to be PARKED before the supersede, or there would be nothing stale to call and
  // the scenario would prove itself by having never happened.
  await page
    .waitForFunction(
      (g) => {
        const f = document.querySelector('#stage iframe') as HTMLIFrameElement | null;
        const w = f?.contentWindow as unknown as Record<string, unknown> | null;
        return !!w && typeof w[g] === 'function';
      },
      V3_DEFERRED_ACK_GLOBAL,
      { timeout: CHOREO_TIMEOUT_MS, polling: 20 },
    )
    .catch(() => {
      /* reported as parked=false below */
    });
  const parked = await page.evaluate((g) => {
    const f = document.querySelector('#stage iframe') as HTMLIFrameElement | null;
    const w = f?.contentWindow as unknown as Record<string, unknown> | null;
    return !!w && typeof w[g] === 'function';
  }, V3_DEFERRED_ACK_GLOBAL);
  const deferBodyPresented = await readSectionNumber('V3A', 'presented');
  lastAcceptedSeq = wire.seq;
  history.push(deferred);

  // Supersede it. From here on, the parked closure belongs to an activation that no longer exists.
  const superseding = await presentCycle(V3A, BASE_CONFIG, 'deferAck supersede');

  const invokeFrom = await protoLength();
  const invokeCursor = await mark();
  const invokeThrew = await page.evaluate((g) => {
    const f = document.querySelector('#stage iframe') as HTMLIFrameElement | null;
    const w = f?.contentWindow as unknown as Record<string, unknown> | null;
    const fn = w ? w[g] : undefined;
    if (typeof fn !== 'function') return 'the deferred acknowledgement was never parked';
    try {
      (fn as () => void)();
      return null;
    } catch (err) {
      return String(err);
    }
  }, V3_DEFERRED_ACK_GLOBAL);
  await quiet(400);
  const deferRecords = await readProto(invokeFrom);
  const deferInbound = await inboundAfter(invokeCursor);
  const deferLiveness = await proveLiveness('after deferAck').catch(
    (e: unknown) => `FAILED: ${e instanceof Error ? e.message : String(e)}`,
  );

  report.markPresented = {
    noPresent: {
      activationId: silent.activationId,
      presentCalls,
      acknowledgements: countAcks(silentRecords, silent.activationId),
      otherInbound: silentInbound.map((e) => `${e.type ?? e.kind ?? '(shapeless)'}`),
      watchedMs: NO_PRESENT_WATCH_MS,
      liveness: noPresentLiveness,
    },
    doubleAck: {
      activationId: doubled.activationId,
      acknowledgements: countAcks(doubleRecords, doubled.activationId),
      bodyPresentedCount: bodyPresented,
      liveness: doubleLiveness,
    },
    deferAck: {
      deferredActivationId: deferred.activationId,
      supersededByActivationId: superseding.activation.activationId,
      parked,
      bodyPresentedCount: deferBodyPresented,
      acknowledgementsForDeferred:
        countAcks(deferRecords, deferred.activationId) +
        deferInbound.filter((e) => e.type === SECTION_PRESENTED && e.activationId === deferred.activationId).length,
      childOutboundAfterInvoke: deferRecords.filter((r) => r.dir === 'out').map(describeOut),
      invokeThrew,
      liveness: deferLiveness,
    },
  };
}

// ─── The run ──────────────────────────────────────────────────────────────────────────────────

test.beforeAll(async ({ browser }: { browser: Browser }, workerInfo) => {
  test.setTimeout(1_400_000);
  const engine = `${browser.browserType().name()}/${browser.version()}`;
  const previous = workerInfo.workerIndex > 0 ? reusableLedger(engine) : null;
  if (previous) {
    Object.assign(report, previous);
    report.workerGenerations = [...previous.workerGenerations, workerInfo.workerIndex];
    mkdirSync(RESULTS_DIR, { recursive: true });
    writeFileSync(reportPath(), `${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  report.engine = engine;
  report.workerGenerations = [workerInfo.workerIndex];
  ensureFixture(PACKAGE);
  await startAssetServer();

  const simulationId = `e2e-${PACKAGE}`;
  const bridgePath = join(FIXTURE_DIR, PACKAGE, 'bridge.js');
  const bridgeHash = existsSync(bridgePath)
    ? createHash('sha256').update(readFileSync(bridgePath)).digest('hex').slice(0, 12)
    : null;
  packageRevision = derivePackageRevision(simulationId, bridgeHash);
  playerSessionId = newPlayerSessionId();

  context = await browser.newContext({ viewport: BASE_VIEWPORT });
  page = await context.newPage();

  page.on('pageerror', (e) => report.errors.push({ source: 'pageerror', message: String(e) }));
  page.on('console', (m) => {
    if (m.type() === 'error') report.errors.push({ source: 'console', message: m.text(), url: m.location().url });
  });
  page.on('requestfailed', (req) => {
    report.errors.push({
      source: 'network',
      message: `${req.method()} ${req.url()} failed: ${req.failure()?.errorText ?? 'unknown'}`,
      url: req.url(),
    });
  });
  // OBSERVE, never intercept, for hermeticity — a catch-all route changes loading behaviour, which
  // is exactly what a hermeticity check must not do (audited in viewer-e2e).
  page.on('request', (req) => {
    const url = req.url();
    const allowed =
      url.startsWith(API_ORIGIN) || url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('about:');
    if (!allowed) report.external.push(url);
  });

  // The package is addressed exactly as production addresses it — on the API origin, under
  // /sim-public/ — and fulfilled from the local fixture server. The harness shares that origin, so
  // the child's recorder and state are readable, which is what turns every "nothing happened" in
  // this suite into evidence rather than an absence of evidence.
  await page.route(`${API_ORIGIN}/**`, async (route: Route) => {
    const url = new URL(route.request().url());
    const local = localPathFor(url.pathname);
    const target =
      local === '__harness__'
        ? `${localOrigin}/__protocol/harness.html`
        : local === null
          ? `${localOrigin}${url.pathname}`
          : `${localOrigin}/${local}${url.search}`;
    const upstream = await fetch(target);
    await route.fulfill({
      status: upstream.status,
      headers: Object.fromEntries(upstream.headers.entries()),
      body: Buffer.from(await upstream.arrayBuffer()),
    });
  });

  await page.addInitScript(installAttackDriver, WIRE);
  await page.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' });

  try {
    report.portCloseObservable = await portCloseObservable();
    await runBootstrapAttacks();
    await runSecondOfferAttack();
    await runNewEpochOfferAttack();
    await runPortAttacks();
    await runStaleAckScenario();
    await runMarkPresentedScenarios();
  } catch (err) {
    // An exception here means the RUN could not complete. It is recorded rather than thrown so the
    // ledger is still written and every assertion below can report precisely what was and was not
    // established — an aborted hostile-input suite must never read as "nothing got through".
    report.aborted = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
  } finally {
    report.finishedAt = new Date().toISOString();
    mkdirSync(RESULTS_DIR, { recursive: true });
    writeFileSync(reportPath(), `${JSON.stringify(report, null, 2)}\n`);
    await context.close().catch(() => {
      /* the browser may already be gone */
    });
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ─── Assertions ───────────────────────────────────────────────────────────────────────────────

const attacksIn = (group: AttackGroup): AttackRecord[] => report.attacks.filter((a) => a.group === group);

/**
 * The four properties every refusal must have, checked identically for every attack.
 *
 * `delivered` is first on purpose. Without it the other three are satisfied by a message that never
 * arrived, and the suite would be certifying the harness rather than the runtime.
 */
function verdictFor(records: AttackRecord[]): string[] {
  const problems: string[] = [];
  for (const a of records) {
    if (!a.delivered) {
      problems.push(`[${a.id}] the hostile message never reached the child (${a.delivery}) — the refusal is unproven`);
    }
    if (a.outbound.length > 0) {
      problems.push(`[${a.id}] the child answered it: ${a.outbound.join(', ')}`);
    }
    if (a.parentInbound.length > 0) {
      problems.push(`[${a.id}] something reached the parent: ${a.parentInbound.join(', ')}`);
    }
    if (a.accepts > 0) {
      problems.push(`[${a.id}] ${a.accepts} bootstrap accept(s) arrived on a hostile channel`);
    }
    if (!a.stateUnchanged) {
      problems.push(`[${a.id}] the child's observable state moved:\n  before ${a.stateBefore}\n  after  ${a.stateAfter}`);
    }
    if (!a.liveness.startsWith('ok')) {
      problems.push(`[${a.id}] the runtime did not complete a normal cycle afterwards: ${a.liveness}`);
    }
  }
  return problems;
}

test('the run completed — an aborted hostile-input suite is not a verdict', () => {
  expect(report.aborted, 'the drive could not finish, so nothing below is established').toBe('');
  expect(
    report.attacks.length,
    'no attack was delivered — every assertion below would be vacuous',
  ).toBeGreaterThan(0);
});

test('the ledger covers every required attack, and the fixture carries every section it names', () => {
  const covered = new Set(report.attacks.map((a) => a.id));
  const missing = REQUIRED_ATTACKS.filter((id) => !covered.has(id));
  expect(missing.join('\n'), 'an attack that never ran must not read as an attack that was refused').toBe('');
  for (const section of [V3A, V3B, V3NOPRESENT]) {
    expect(
      report.variantsReported,
      `the staged package does not carry ${LABEL_OF[section]} (${section}); it reports ` +
        `${report.variantsReported.join(', ') || 'nothing'}`,
    ).toContain(section);
  }
});

test('bootstrap: every refused offer was delivered, ignored, and left the document adoptable', () => {
  const records = attacksIn('bootstrap');
  expect(records.length, 'no bootstrap attack ran').toBe(9);
  expect(verdictFor(records).join('\n')).toBe('');
});

test('bootstrap: the second offer after adoption was refused and its port carried nothing', () => {
  const rec = report.attacks.find((a) => a.id === 'bootstrap/second-offer-after-adoption');
  expect(rec, 'the second-offer attack did not run').toBeTruthy();
  const probe = rec!.probe;
  expect(probe, 'the refused channel was never probed — "its port is closed" would be unproven').toBeTruthy();
  // Stated first and separately because it is the whole question: does a later offer get REFUSED,
  // or does it take the transport over? The two are opposite contracts, and the rest of this test
  // only makes sense under the first.
  expect(
    probe!.secondOfferAccepted,
    'the child ACCEPTED the second offer instead of refusing it — it re-bound its identity to the ' +
      `second offer's documentId and answered on the second port. Original port still answers: ` +
      `${probe!.originalPortStillAnswers}. Bootstrap history: ${rec!.notes.join(' | ')}`,
  ).toBe(false);
  expect(
    probe!.reachedChild,
    `a command posted on the refused port REACHED the child: ${rec!.notes.join(' | ')}`,
  ).toBe(false);
  expect(probe!.childOutbound, 'the child answered a command posted on the refused port').toBe(0);
  expect(probe!.parentInbound, 'the parent received something after probing the refused port').toBe(0);
  // Where the engine implements it, the direct proof is asserted too; where it does not, that
  // absence is asserted rather than assumed, so this can never silently become a no-op.
  if (probe!.portCloseObservable) {
    expect(probe!.portClosed, 'the engine reports port closure and did NOT report this one closed').toBe(true);
  } else {
    expect(
      report.portCloseObservable,
      'the engine was recorded as having no MessagePort close event; the behavioural proof above stands alone',
    ).toBe(false);
  }
  // The same four properties every other refusal is held to, applied to this one.
  expect(verdictFor(attacksIn('adoption')).join('\n')).toBe('');
});

test('adoption: a NEW document epoch IS adopted — the only recovery from an abandoned handshake', () => {
  const rec = report.attacks.find((a) => a.id === 'adoption-recovery/new-epoch-offer');
  expect(rec, 'the new-epoch attack did not run').toBeTruthy();
  expect(rec!.delivered, 'the new-epoch offer never reached the child').toBe(true);

  // The counterpart to the refusal above, and the reason that one is scoped to the ADOPTED epoch
  // rather than refusing everything. The parent abandons a handshake after a bounded deadline; if
  // the child could never adopt again, a package whose listener installs late would hold a port
  // nobody listens to for the rest of the document's life — running v2 while certified modern,
  // with no signal in either direction, because no engine fires a MessagePort close event.
  expect(
    rec!.probe?.secondOfferAccepted,
    `a new document epoch was REFUSED, so an abandoned handshake can never recover. ` +
      `Bootstrap history: ${rec!.notes.join(' | ')}`,
  ).toBe(true);

  // Privacy is unchanged: only window.parent reaches the adoption path at all, which the
  // source/origin attacks above prove independently.
  const relayed = report.attacks.find((a) => a.id === 'bootstrap/foreign-source');
  expect(relayed, 'the foreign-source attack must exist for this claim to stand').toBeTruthy();
  expect(relayed!.accepts, 'a frame that is not window.parent must never be adopted').toBe(0);
});

test('transport: wrong namespace, wrong version, unknown type and a reflected parent type are all ignored', () => {
  const records = attacksIn('transport');
  expect(records.length).toBe(4);
  expect(verdictFor(records).join('\n')).toBe('');
});

test('identity: a command for another session, revision or document is ignored', () => {
  const records = attacksIn('identity');
  expect(records.length).toBe(3);
  expect(verdictFor(records).join('\n')).toBe('');
});

test('activation scope: a command missing activationId, variantKey or configHash is ignored', () => {
  const records = attacksIn('activation');
  expect(records.length).toBe(3);
  expect(verdictFor(records).join('\n')).toBe('');
});

test('sequence: duplicate, out-of-order, zero, fractional and missing sequence numbers are ignored', () => {
  const records = attacksIn('sequence');
  expect(records.length).toBe(5);
  expect(verdictFor(records).join('\n')).toBe('');
});

test('payload: null, a string, an array and a number are all refused as malformed', () => {
  const records = attacksIn('payload');
  expect(records.length).toBe(4);
  expect(verdictFor(records).join('\n')).toBe('');
});

test('hostile structure: deep nesting, a __proto__ key and a huge string change nothing and crash nothing', () => {
  const records = attacksIn('structure');
  expect(records.length).toBe(3);
  expect(verdictFor(records).join('\n')).toBe('');
  // Stated separately because it is the specific harm the __proto__ payload is aimed at, and the
  // generic state comparison would also be satisfied by a run where the payload never arrived.
  const pollution = records.find((a) => a.id === 'structure/proto-pollution');
  expect(pollution!.stateAfter, 'the child realm\'s Object.prototype was polluted').toContain('polluted=[]');
});

test('the stale A → B → A acknowledgement is refused by the IDENTITY gate, not by the transport', () => {
  const s = report.staleAck;
  expect(s, 'the stale-acknowledgement scenario did not run').toBeTruthy();

  // Activation 3 is a genuine re-entry: same section, same configuration, different activation.
  expect(s!.sameVariantKey, 'activation 3 did not re-enter activation 1\'s section').toBe(true);
  expect(s!.sameConfigHash, 'activation 3 used a different configuration, so the case is not A → B → A').toBe(true);
  expect(s!.differentActivationId, 'activation 3 reused activation 1\'s id').toBe(true);

  // The child's own clock: the acknowledgement was minted before activation 3 became current, and
  // it was replayed after.
  expect(s!.staleMintedAt, 'the child never recorded activation 1\'s acknowledgement').toBeGreaterThan(0);
  expect(s!.act3BecameCurrentAt, 'the child never recorded activation 3\'s PREPARE').toBeGreaterThan(0);
  expect(s!.replayDeliveredAt, 'the replayed acknowledgement never reached the child').toBeGreaterThan(0);
  expect(s!.staleMintedAt, 'the stale acknowledgement was not minted before activation 3 became current')
    .toBeLessThan(s!.act3BecameCurrentAt);
  expect(s!.replayDeliveredAt, 'the replay did not land after activation 3 became current')
    .toBeGreaterThanOrEqual(s!.act3BecameCurrentAt);

  // THE POINT. The transport has no objection to this envelope at all.
  expect(s!.staleDocumentMatches, 'the stale envelope was not for this document, so it proves nothing').toBe(true);
  expect(
    s!.transportAccepts,
    `the shipped validateEnvelope REJECTED the stale acknowledgement (${s!.transportReason}) — if the ` +
      'transport can refuse it, this case does not demonstrate that the identity gate is what stops it',
  ).toBe(true);
  expect(s!.refusal, 'the identity gate did not name the activation axis').toBe('activation-mismatch');

  // Nothing was revealed, and nothing was answered.
  expect(s!.revealBeforeAnyAcknowledgement, 'a reveal was authorised with no acknowledgement at all')
    .toBe('not-presented');
  // The worst case: the stale acknowledgement drove the machine all the way to PRESENTED, and the
  // gate still refused it. Asserting the state as well is what makes the refusal attributable to the
  // identity comparison rather than to the machine simply never having got there.
  expect(s!.staleDroveMachineTo, 'the stale acknowledgement did not reach the gate at all, so the gate is untested')
    .toBe('PRESENTED');
  expect(s!.revealWithStaleAcknowledgement, 'the stale acknowledgement authorised a reveal of activation 3')
    .toBe('activation-mismatch');
  expect(s!.revealAfterOwnAcknowledgement, 'activation 3\'s own acknowledgement did not authorise its reveal')
    .toBe('allowed');
  expect(s!.childOutboundAfterReplay, 'the child answered the replayed acknowledgement').toEqual([]);
  expect(s!.parentInboundAfterReplay, 'something reached the parent after the replay').toEqual([]);
  expect(s!.stateUnchanged, 'the child\'s observable state moved when the stale acknowledgement was replayed').toBe(true);

  // And the runtime carried on.
  expect(s!.act3PresentedAfter?.activationId, 'activation 3 never presented after the replay').toBe(s!.act3.activationId);
  expect(s!.act3PresentedAfter?.framesSubmitted ?? 0).toBeGreaterThanOrEqual(1);
});

test('V3NOPRESENT never acknowledges, and no timeout inside the child manufactures one', () => {
  const m = report.markPresented;
  expect(m, 'the markPresented scenarios did not run').toBeTruthy();
  const n = m!.noPresent;
  // Positive proof the silence is the SECTION's and not a lost message.
  expect(n.presentCalls, 'the section\'s present() was never called — its silence proves nothing').toBe(1);
  expect(n.acknowledgements, `the child produced ${n.acknowledgements} acknowledgement(s) for a section that never asks for one`).toBe(0);
  expect(n.otherInbound, `the child sent something else while the present was outstanding: ${n.otherInbound.join(', ')}`).toEqual([]);
  expect(n.watchedMs, 'the watch was shorter than the parent\'s own present bound').toBeGreaterThan(SIM_PRESENT_TIMEOUT_MS);
  expect(n.liveness.startsWith('ok'), `the runtime did not recover afterwards: ${n.liveness}`).toBe(true);
});

test('the doubleAck knob produces exactly ONE SECTION_PRESENTED', () => {
  const d = report.markPresented!.doubleAck;
  // The section really did call markPresented twice: its own counter proves the render ran once,
  // and the fixture calls the acknowledgement twice inside that single frame.
  expect(d.bodyPresentedCount, 'the doubleAck body never rendered — the guard was never exercised').toBe(1);
  expect(d.acknowledgements, `the runtime emitted ${d.acknowledgements} acknowledgements for one activation`).toBe(1);
  expect(d.liveness.startsWith('ok'), `the runtime did not recover afterwards: ${d.liveness}`).toBe(true);
});

test('the deferAck stale closure produces no acknowledgement after a new PREPARE', () => {
  const d = report.markPresented!.deferAck;
  expect(d.parked, 'the deferred acknowledgement was never parked — there was no stale closure to call').toBe(true);
  expect(d.bodyPresentedCount, 'the deferring body never rendered').toBe(1);
  expect(d.invokeThrew, `calling the stale closure threw: ${d.invokeThrew}`).toBeNull();
  expect(
    d.acknowledgementsForDeferred,
    'the superseded activation was acknowledged from its stale closure',
  ).toBe(0);
  expect(
    d.childOutboundAfterInvoke,
    `the child posted something when the stale closure ran: ${d.childOutboundAfterInvoke.join(', ')}`,
  ).toEqual([]);
  expect(d.liveness.startsWith('ok'), `the runtime did not recover afterwards: ${d.liveness}`).toBe(true);
});

test('the suite is hermetic and the documents raised no significant errors', () => {
  expect(
    report.external,
    `the suite made requests outside the staged package: ${[...new Set(report.external)].slice(0, 8).join(', ')}`,
  ).toEqual([]);
  const significant = report.errors.filter(isSignificantError);
  expect(significant.map((e) => `${e.source}: ${e.message}`).join('\n')).toBe('');
});
