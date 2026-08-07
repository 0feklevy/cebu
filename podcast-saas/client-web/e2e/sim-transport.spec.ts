/**
 * THE PARENT TRANSPORT, EXECUTED — lib/sim/SimTransport.ts running in a real browser.
 *
 * WHY THIS EXISTS
 * Every other browser suite in this repository re-expresses the parent half of the v3 bootstrap
 * instead of importing it. sim-canary.spec.ts says so in its own header ("a faithful re-expression
 * of lib/sim/SimTransport … rather than an import of it"), and sim-protocol.spec.ts reuses that
 * driver. There is a good reason for it there: a canary must be able to certify a PACKAGE without
 * the client's transport being able to launder a broken one through the gate.
 *
 * But it leaves the shipped module in a position no amount of unit testing fixes: the code that
 * actually runs in the product — the code that offers ports, adopts one, validates every inbound
 * envelope and decides what the player is allowed to believe — has never been executed by a test in
 * a browser. A re-expression cannot detect that it has drifted from the thing it re-expresses. That
 * hazard is not theoretical: it produced two real defects in this codebase's history, each of which
 * lived in the gap between "the imitation is right" and "the shipped code is right".
 *
 * So this suite imports NOTHING of the transport's behaviour. It BUNDLES lib/sim/SimTransport.ts
 * with esbuild in `beforeAll` — freshly, every run, so a stale build can never be what passes —
 * injects the bundle into the harness page, and constructs `new SimTransport({...})` there. Every
 * assertion below is about that object: its modes, its retry loop, its channel cap, its tombstones,
 * its rejections, its port.
 *
 * WHAT IT TALKS TO
 * The real v3 child runtime (backend-api/src/services/simulation/simRuntimeChild.ts, embedded
 * verbatim in the generated `v3managed` fixture package), served exactly as production serves a
 * package: on the API origin, under /sim-public/, from an in-process fixture server addressed
 * through route interception. Nothing here boots the application, and nothing here touches the
 * network. Three deliberately hostile documents are served alongside it — one that never answers,
 * one that floods hellos and never adopts, and one loaded into a sandboxed frame with an opaque
 * origin — because "the handshake works" and "the handshake gives up correctly" are different
 * claims and only one of them is provable with a healthy package.
 *
 * HOW A CHILD-SIDE ATTACK IS DELIVERED WITHOUT FAKING THE CHILD
 * Several assertions need an envelope on the ADOPTED port that the honest child would never send
 * (a duplicate sequence number, a replayed acknowledgement, a wrong session). The harness does not
 * simulate a child to get them. The harness page is same-origin with the child document, so it adds
 * its own `message` listener to the CHILD's window and keeps a reference to the very MessagePort the
 * child adopted (`e.ports[0]` is one object; the runtime holding it does not make it private within
 * that realm). Which captured port the child adopted is read from the child's OWN recorder
 * (`window.__PROTO_V3__`, which stamps the port index on the bootstrap accept it posted), never
 * assumed. Every injected message therefore travels the same wire, in the same direction, on the
 * same port as the real child's traffic — it is indistinguishable from the child's own bytes, which
 * is exactly the threat model the parent's validator exists for.
 *
 * NON-VACUITY IS ASSERTED, NEVER ASSUMED. Every "nothing happened" assertion is preceded by proof
 * that the thing under test actually happened: the ledger is non-empty, the attack was delivered
 * (the reject count moved), the child recorded the message, the section's own counter incremented.
 *
 *   npx playwright test --config=playwright.transport.config.ts
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { extname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { fixtureIsFresh } from './fixtureSources';

import {
  AUTOMATION_PAUSED,
  AUTOMATION_RESUMED,
  DOCUMENT_READY,
  DOMAIN_EVENT,
  INIT_DOCUMENT,
  PAUSE_AUTOMATION,
  PREPARE_SECTION,
  PRESENT_SECTION,
  QUALITY_APPLIED,
  RESUME_AUTOMATION,
  SECTION_APPLIED,
  SECTION_PRESENTED,
  SET_QUALITY,
  SIM_BOOTSTRAP_ACCEPT_KIND,
  SIM_BOOTSTRAP_KIND,
  SIM_BOOTSTRAP_TIMEOUT_MS,
  SIM_PROTOCOL_NAMESPACE,
  SIM_PROTOCOL_VERSION,
  type DocumentReadyPayload,
  type EnvelopeRejectReason,
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
  type ActivationEvent,
  type ActivationMachineState,
} from 'shared/src/sim/activationMachine';
import { SIM_PREPARE_TIMEOUT_MS, SIM_PRESENT_TIMEOUT_MS } from 'shared/src/sim/simFailurePolicy';
// The ONE thing imported from the module under test in Node: the hello constant the hostile
// flooder document must reproduce byte-for-byte. Retyping it would let the flooder and the
// transport drift apart, and a flooder the transport ignores proves nothing about the cap.
import { SIM_HELLO_KIND } from '../lib/sim/SimTransport';
import type { SimTransport, SimTransportCallbacks } from '../lib/sim/SimTransport';

// ─── Where things live ────────────────────────────────────────────────────────────────────────

const API_ORIGIN = process.env.TRANSPORT_API_URL ?? 'http://localhost:8080';
/**
 * A SECOND origin, fulfilled from the same fixture server through a second route.
 *
 * It exists for exactly one test: the document that navigates the frame away from the origin the
 * transport addressed. It differs from API_ORIGIN only in port, which is enough to be a different
 * origin, and — like API_ORIGIN — it is answered by route interception and never touches the
 * network. (A real second loopback port would be refused by Chromium's local-network-access check,
 * which is a property of the browser and has nothing to do with the transport.)
 */
const FOREIGN_ORIGIN = process.env.TRANSPORT_FOREIGN_URL ?? 'http://localhost:8081';
const HARNESS_URL = `${API_ORIGIN}/__transport/harness.html`;
const DEAF_URL = `${API_ORIGIN}/__transport/deaf.html`;
const FLOOD_URL = `${API_ORIGIN}/__transport/flood.html`;
/** Loads on the API origin and then navigates ITSELF to another origin. See the stale-frame test. */
const HOP_URL = `${API_ORIGIN}/__transport/hop.html`;

const PACKAGE = 'v3managed';
const FIXTURE_DIR = resolve(__dirname, '../../.sim-fixture');
const BACKEND = resolve(__dirname, '../../backend-api');
const CLIENT = resolve(__dirname, '..');

/**
 * Section ids of the v3 fixture, copied from FIXTURE_V3_SECTIONS in gen-sim-fixture.ts rather than
 * imported — that module pulls the server's SimulationService and controller graph in with it, for
 * the same reason sim-canary.spec.ts names them directly. Drift is caught immediately: every id
 * used here is asserted against the variant list the DOCUMENT itself reports (see `bootDocument`),
 * so a renamed section fails loudly instead of silently certifying nothing.
 */
const V3A = '33333333-a111-4a11-8a11-333333333333';
const V3B = '44444444-b222-4b22-8b22-444444444444';
const V3NOPRESENT = '66666666-d444-4d44-8d44-666666666666';

const LOAD_TIMEOUT_MS = 30_000;
const HANDSHAKE_TIMEOUT_MS = 15_000;
/** How long a document that must never acknowledge is watched before the absence is a verdict. */
const SILENCE_WINDOW_MS = SIM_PRESENT_TIMEOUT_MS;

const entryUrl = (variant: string, extra = ''): string =>
  `${API_ORIGIN}/sim-public/__e2e/${PACKAGE}/index.html?section=${encodeURIComponent(variant)}&v=1${extra}`;

// ─── Fixture staging ──────────────────────────────────────────────────────────────────────────

function ensureFixture(): void {
  const stamp = join(FIXTURE_DIR, PACKAGE, 'index.html');
  if (!fixtureIsFresh(BACKEND, stamp)) {
    mkdirSync(FIXTURE_DIR, { recursive: true });
    const r = spawnSync('npx', ['tsx', 'src/scripts/gen-sim-fixture.ts', FIXTURE_DIR], {
      cwd: BACKEND,
      encoding: 'utf8',
    });
    if (r.status !== 0 && !existsSync(stamp)) {
      throw new Error(`sim-transport: fixture generation failed: ${r.stderr || r.stdout}`);
    }
  }
  if (!existsSync(stamp)) {
    // FAIL, never skip. A transport suite that did not run reads as a pass in every aggregate.
    throw new Error(
      `sim-transport: the staged package '${PACKAGE}' does not exist at ${stamp}.\n` +
      `Generate it with:  cd backend-api && npx tsx src/scripts/gen-sim-fixture.ts ${FIXTURE_DIR}`,
    );
  }
}

// ─── The bundle of the REAL module ────────────────────────────────────────────────────────────

let bundleDir = '';
let bundlePath = '';

/**
 * Bundle lib/sim/SimTransport.ts for the browser, FRESHLY, on every run.
 *
 * Freshness is the whole point. A cached artefact would let this suite go green against a build of
 * the transport that no longer exists on disk — which is the same class of false signal the
 * re-expression problem is, arriving by a different road.
 */
function buildBundle(): void {
  bundleDir = mkdtempSync(join(tmpdir(), 'sim-transport-'));
  bundlePath = join(bundleDir, 'simtransport.js');
  const esbuild = join(CLIENT, 'node_modules', '.bin', 'esbuild');
  if (!existsSync(esbuild)) {
    throw new Error(`sim-transport: esbuild is not installed at ${esbuild} — the real module cannot be bundled`);
  }
  const r = spawnSync(
    esbuild,
    [
      'lib/sim/SimTransport.ts',
      '--bundle',
      '--format=iife',
      '--global-name=__SimTransportMod',
      '--platform=browser',
      `--outfile=${bundlePath}`,
    ],
    { cwd: CLIENT, encoding: 'utf8' },
  );
  if (r.status !== 0 || !existsSync(bundlePath)) {
    throw new Error(`sim-transport: bundling lib/sim/SimTransport.ts failed:\n${r.stderr || r.stdout}`);
  }
  const bytes = statSync(bundlePath).size;
  if (bytes < 4_000) {
    throw new Error(`sim-transport: the bundle is only ${bytes} bytes — that is not the transport`);
  }
}

// ─── Documents this suite serves ──────────────────────────────────────────────────────────────

const HARNESS_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>sim transport harness</title>
  <style>
    html, body { margin: 0; padding: 0; height: 100%; background: #000; overflow: hidden; }
    /* Visible and on-screen on purpose: a managed section acknowledges its presentation from
       INSIDE a requestAnimationFrame, and rAF does not run in a frame the engine considers
       invisible — a hidden stage would turn every presentation assertion into a timeout. */
    #stage { position: absolute; left: 0; top: 0; width: 1280px; height: 720px; overflow: hidden; background: #000; }
    #stage iframe { display: block; border: 0; width: 100%; height: 100%; }
  </style>
</head>
<body><div id="stage"></div></body>
</html>`;

/** Loads, and answers nothing. The parent's own deadline is the only thing that can end the wait. */
const DEAF_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>deaf child</title></head>
<body>a document that never speaks the protocol</body></html>`;

/**
 * Shouts the child's boot hello forever and never adopts a port.
 *
 * Each hello makes the parent mint another channel, so this is the document that decides whether
 * the 12-channel cap is a real bound or a comment. The hello shape comes from SIM_HELLO_KIND and
 * SIM_PROTOCOL_VERSION — the shipped constants — so a hello the transport ignores can never be
 * mistaken for a cap that held.
 */
const FLOOD_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>hello flooder</title></head>
<body><script>
(function () {
  var HELLO = ${JSON.stringify(SIM_HELLO_KIND)};
  var VER = ${JSON.stringify(SIM_PROTOCOL_VERSION)};
  window.__HELLOS__ = 0;
  function shout() {
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ kind: HELLO, protocolVersion: VER }, '*');
        window.__HELLOS__++;
      }
    } catch (e) {}
  }
  shout();
  setInterval(shout, 5);
})();
</script></body></html>`;

// ─── Local asset server + route proxy ─────────────────────────────────────────────────────────

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.mp4': 'video/mp4',
};

let server: Server;
let localOrigin = '';

/**
 * The stale-frame document.
 *
 * It is fetched from the API origin — so the transport derives THAT origin to address its offers to
 * — and then immediately navigates itself to a DIFFERENT origin, where it floods hellos.
 * `frame.contentWindow` is unchanged by the navigation (it belongs to the element, not the
 * document), which is exactly why source-matching alone was never sufficient and why the transport
 * also compares `e.origin`.
 */
const HOP_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>navigating child</title></head>
<body><script>location.replace(${JSON.stringify(`${FOREIGN_ORIGIN}/__transport/flood.html`)});</script></body></html>`;

const SERVED: Record<string, string> = {
  '/__transport/harness.html': HARNESS_HTML,
  '/__transport/deaf.html': DEAF_HTML,
  '/__transport/flood.html': FLOOD_HTML,
  '/__transport/hop.html': HOP_HTML,
};

function startAssetServer(): Promise<void> {
  server = createServer((req, res) => {
    const pathname = (req.url ?? '/').split('?')[0].split('#')[0];
    const inline = SERVED[pathname];
    if (inline !== undefined) {
      const body = Buffer.from(inline, 'utf-8');
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': String(body.length),
        'cache-control': 'no-cache',
      });
      res.end(body);
      return;
    }
    if (!pathname.startsWith('/sim-public/__e2e/')) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not served by this suite');
      return;
    }
    const file = join(FIXTURE_DIR, pathname.slice('/sim-public/__e2e/'.length));
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

/**
 * Everything the page asks for on the API origin is fulfilled from the fixture server, exactly as
 * sim-canary does it. The harness and the package therefore share ONE origin, which is what lets
 * the harness read the child's recorder and hold the adopted port — and what makes the child's own
 * `parentOrigin === e.origin` bootstrap rule meaningful rather than bypassed.
 *
 * `slowboot=1` on the entry URL delays the response. That is the whole mechanism behind the
 * late-boot test: the parent's first offers are posted into a frame that has no child yet.
 */
async function installRoute(page: Page, slowBootMs: number): Promise<void> {
  const fulfil = async (route: Route): Promise<void> => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('slowboot') === '1' && slowBootMs > 0) {
      await new Promise<void>((r) => setTimeout(r, slowBootMs));
    }
    const upstream = await fetch(`${localOrigin}${url.pathname}${url.search}`);
    await route.fulfill({
      status: upstream.status,
      headers: Object.fromEntries(upstream.headers.entries()),
      body: Buffer.from(await upstream.arrayBuffer()),
    });
  };
  await page.route(`${API_ORIGIN}/**`, fulfil);
  await page.route(`${FOREIGN_ORIGIN}/**`, fulfil);
}

// ─── The in-page driver ───────────────────────────────────────────────────────────────────────

/** Wire constants handed to the page as DATA, so nothing about the format is retyped in-browser. */
interface Wire {
  BOOTSTRAP: string;
  HELLO: string;
  NS: string;
  VER: number;
}

const WIRE: Wire = {
  BOOTSTRAP: SIM_BOOTSTRAP_KIND,
  HELLO: SIM_HELLO_KIND,
  NS: SIM_PROTOCOL_NAMESPACE,
  VER: SIM_PROTOCOL_VERSION,
};

interface DocIdent {
  playerSessionId: string;
  packageRevision: string;
  documentId: string;
}

interface ActivationIdent {
  activationId: string;
  variantKey: string;
  configHash: string;
}

type RawEnvelope = Record<string, unknown>;

/** One ordered record of everything the transport told the harness, or was told by it. */
interface LedgerEntry {
  /** Position on the single monotonic clock shared by sends and receipts. */
  n: number;
  at: number;
}

interface SentEntry extends LedgerEntry {
  type: string;
  activationId: string | null;
  accepted: boolean;
}

interface EnvelopeEntry extends LedgerEntry {
  env: RawEnvelope;
}

interface RejectEntry extends LedgerEntry {
  reason: string;
  detail: string | null;
}

interface TelemetryEntry extends LedgerEntry {
  event: string;
  detail: Record<string, unknown> | null;
}

interface LedgerState {
  mode: string;
  modes: string[];
  sent: SentEntry[];
  envelopes: EnvelopeEntry[];
  rejected: RejectEntry[];
  telemetry: TelemetryEntry[];
  /** MessageChannel constructions since `create()` — the transport's offers, counted at the source. */
  channels: number;
  /** Ports the harness captured off the child's window, in offer order. */
  ports: number;
  /**
   * Every child hello that reached the HARNESS window, with the origin it came from — an
   * independent observer of the same events the transport is deciding about. Without it, "the
   * transport ignored the hello" and "no hello was ever sent" are the same observation.
   */
  hellosSeen: { origin: string }[];
  mounted: boolean;
}

interface ProtoEntry {
  dir: string;
  channel: string;
  port: number | null;
  at: number;
  kind: string | null;
  type: string | null;
  seq: number | null;
  documentId: string | null;
  activationId: string | null;
  variantKey: string | null;
  configHash: string | null;
  payload: Record<string, unknown> | null;
}

interface DriverApi {
  create(): void;
  mount(src: string, opts: { sandbox: string | null; awaitLoad: boolean }): Promise<void>;
  spy(): boolean;
  open(ident: DocIdent): void;
  send(type: string, activation: ActivationIdent | null, payload: unknown): boolean;
  raw(portIndex: number, data: unknown): boolean;
  tombstone(documentId: string): void;
  isTombstoned(documentId: string): boolean;
  close(): void;
  state(): LedgerState;
  proto(): ProtoEntry[];
  childState(): Record<string, Record<string, number | string | boolean>> | null;
  helloCount(): number;
}

interface TransportModule {
  SimTransport: new (cbs?: SimTransportCallbacks) => SimTransport;
  deriveTargetOrigin: (src: string, base?: string) => string | null;
  sandboxAllowsOrigin: (frame: HTMLIFrameElement) => boolean;
  SIM_HELLO_KIND: string;
}

interface DriverWindow extends Window {
  __SimTransportMod: TransportModule;
  __D: DriverApi;
}

/**
 * Install the harness driver. It owns NO protocol logic: it constructs the REAL SimTransport, wires
 * its four callbacks into one ordered ledger, and exposes the handful of operations a Node-side test
 * needs. Every decision about what a legal message is belongs to the module under test.
 */
function installTransportDriver(K: Wire): void {
  const w = window as unknown as DriverWindow;
  const mod = w.__SimTransportMod;
  if (!mod || typeof mod.SimTransport !== 'function') {
    throw new Error('the real SimTransport bundle is not present on this page');
  }

  let transport: SimTransport | null = null;
  let frame: HTMLIFrameElement | null = null;
  let currentSrc = '';
  let clock = 0;
  let channels = 0;
  let captured: MessagePort[] = [];
  let hellosSeen: { origin: string }[] = [];
  let mounted = false;

  // An INDEPENDENT observer of the child's hellos, on the harness window, subject to no origin rule
  // of its own. It is what makes "the transport ignored it" a measurement rather than an absence.
  window.addEventListener('message', (e: MessageEvent) => {
    const data = e.data as { kind?: unknown } | null;
    if (data && typeof data === 'object' && data.kind === K.HELLO) hellosSeen.push({ origin: e.origin });
  });

  let modes: string[] = [];
  let sent: SentEntry[] = [];
  let envelopes: EnvelopeEntry[] = [];
  let rejected: RejectEntry[] = [];
  let telemetry: TelemetryEntry[] = [];

  // Count the transport's channel minting AT THE SOURCE. The offer count is otherwise unobservable
  // from outside — and it is the number the 12-channel cap is a statement about.
  const NativeChannel = window.MessageChannel;
  class CountedChannel extends NativeChannel {
    constructor() {
      super();
      channels++;
    }
  }
  (window as unknown as { MessageChannel: typeof MessageChannel }).MessageChannel =
    CountedChannel as unknown as typeof MessageChannel;

  const stamp = (): { n: number; at: number } => ({ n: ++clock, at: Date.now() });

  const api: DriverApi = {
    create(): void {
      if (transport) transport.close();
      transport = new mod.SimTransport({
        onEnvelope: (env) => {
          envelopes.push({ ...stamp(), env: env as unknown as RawEnvelope });
        },
        onRejected: (reason, detail) => {
          rejected.push({ ...stamp(), reason, detail: detail ?? null });
        },
        onMode: (mode) => {
          modes.push(mode);
        },
        onTelemetry: (event, detail) => {
          telemetry.push({ ...stamp(), event, detail: (detail as Record<string, unknown>) ?? null });
        },
      });
      clock = 0;
      channels = 0;
      captured = [];
      hellosSeen = [];
      modes = [];
      sent = [];
      envelopes = [];
      rejected = [];
      telemetry = [];
    },

    mount(src: string, opts: { sandbox: string | null; awaitLoad: boolean }): Promise<void> {
      const stage = document.getElementById('stage');
      if (!stage) throw new Error('the harness page has no #stage');
      while (stage.firstChild) stage.removeChild(stage.firstChild);
      const f = document.createElement('iframe');
      f.id = 'sim';
      f.title = 'sim transport subject';
      f.setAttribute('allow', 'autoplay');
      if (opts.sandbox !== null) f.setAttribute('sandbox', opts.sandbox);
      f.style.cssText = 'display:block;border:0;width:100%;height:100%;background:transparent';
      const loaded = new Promise<void>((resolve) => {
        f.addEventListener('load', () => resolve(), { once: true });
      });
      f.src = src;
      stage.appendChild(f);
      frame = f;
      currentSrc = src;
      mounted = true;
      captured = [];
      return opts.awaitLoad ? loaded : Promise.resolve();
    },

    /**
     * Keep a reference to every MessagePort the transport offers the child.
     *
     * This is NOT a second child. The listener is added to the CHILD's window (same-origin, so it
     * is allowed), it runs after the runtime's own bootstrap listener, and the port objects it
     * keeps are the same objects the runtime adopts. Injecting through one of them is therefore
     * byte-indistinguishable from the child sending it — which is precisely the position the
     * parent's validator has to defend from.
     */
    spy(): boolean {
      const win = frame?.contentWindow;
      if (!win) return false;
      win.addEventListener('message', (e: MessageEvent) => {
        const d = e.data as { kind?: unknown } | null;
        if (!d || typeof d !== 'object' || d.kind !== K.BOOTSTRAP) return;
        for (const p of Array.from(e.ports)) captured.push(p);
      });
      return true;
    },

    open(ident: DocIdent): void {
      if (!transport || !frame) throw new Error('mount() and create() first');
      transport.open({
        frame,
        src: currentSrc,
        playerSessionId: ident.playerSessionId,
        packageRevision: ident.packageRevision,
        documentId: ident.documentId,
      });
    },

    send(type: string, activation: ActivationIdent | null, payload: unknown): boolean {
      if (!transport) throw new Error('create() first');
      const accepted = transport.send(
        type as Parameters<SimTransport['send']>[0],
        activation ?? {},
        payload,
      );
      sent.push({ ...stamp(), type, activationId: activation?.activationId ?? null, accepted });
      return accepted;
    },

    raw(portIndex: number, data: unknown): boolean {
      const p = captured[portIndex];
      if (!p) return false;
      try {
        p.postMessage(data);
        return true;
      } catch {
        return false;
      }
    },

    tombstone(documentId: string): void {
      transport?.tombstone(documentId);
    },

    isTombstoned(documentId: string): boolean {
      return transport ? transport.isTombstoned(documentId) : false;
    },

    close(): void {
      transport?.close();
    },

    state(): LedgerState {
      return {
        mode: transport ? transport.getMode() : 'none',
        modes: [...modes],
        sent: [...sent],
        envelopes: envelopes.map((e) => ({ ...e })),
        rejected: [...rejected],
        telemetry: [...telemetry],
        channels,
        ports: captured.length,
        hellosSeen: hellosSeen.map((h) => ({ ...h })),
        mounted,
      };
    },

    proto(): ProtoEntry[] {
      try {
        const cw = frame?.contentWindow as (Window & { __PROTO_V3__?: ProtoEntry[] }) | null | undefined;
        const arr = cw?.__PROTO_V3__;
        return arr ? arr.map((e) => ({ ...e })) : [];
      } catch {
        return [];
      }
    },

    /** The fixture sections' own scalar counters — evidence taken from the document, not the wire. */
    childState(): Record<string, Record<string, number | string | boolean>> | null {
      try {
        const cw = frame?.contentWindow as
          | (Window & { __V3_STATE__?: Record<string, Record<string, unknown>> })
          | null
          | undefined;
        const src = cw?.__V3_STATE__;
        if (!src) return null;
        const out: Record<string, Record<string, number | string | boolean>> = {};
        for (const key of Object.keys(src)) {
          const entry: Record<string, number | string | boolean> = {};
          const from = src[key] ?? {};
          for (const k of Object.keys(from)) {
            const v = from[k];
            if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') entry[k] = v;
          }
          out[key] = entry;
        }
        return out;
      } catch {
        return null;
      }
    },

    helloCount(): number {
      try {
        const cw = frame?.contentWindow as (Window & { __HELLOS__?: number }) | null | undefined;
        return typeof cw?.__HELLOS__ === 'number' ? cw.__HELLOS__ : 0;
      } catch {
        return 0;
      }
    },
  };

  w.__D = api;
}

// ─── Node-side driver helpers ─────────────────────────────────────────────────────────────────

const d = (page: Page) => ({
  state: (): Promise<LedgerState> => page.evaluate(() => (window as unknown as DriverWindow).__D.state()),
  proto: (): Promise<ProtoEntry[]> => page.evaluate(() => (window as unknown as DriverWindow).__D.proto()),
  childState: () =>
    page.evaluate(() => (window as unknown as DriverWindow).__D.childState()),
  helloCount: (): Promise<number> =>
    page.evaluate(() => (window as unknown as DriverWindow).__D.helloCount()),
  create: (): Promise<void> => page.evaluate(() => (window as unknown as DriverWindow).__D.create()),
  mount: (src: string, opts: { sandbox?: string | null; awaitLoad?: boolean } = {}): Promise<void> =>
    page.evaluate(
      (a) => (window as unknown as DriverWindow).__D.mount(a.src, { sandbox: a.sandbox, awaitLoad: a.awaitLoad }),
      { src, sandbox: opts.sandbox ?? null, awaitLoad: opts.awaitLoad ?? true },
    ),
  spy: (): Promise<boolean> => page.evaluate(() => (window as unknown as DriverWindow).__D.spy()),
  open: (ident: DocIdent): Promise<void> =>
    page.evaluate((i) => (window as unknown as DriverWindow).__D.open(i), ident),
  send: (type: string, activation: ActivationIdent | null, payload: unknown): Promise<boolean> =>
    page.evaluate(
      (a) => (window as unknown as DriverWindow).__D.send(a.type, a.activation, a.payload),
      { type, activation, payload },
    ),
  raw: (portIndex: number, data: unknown): Promise<boolean> =>
    page.evaluate((a) => (window as unknown as DriverWindow).__D.raw(a.portIndex, a.data), { portIndex, data }),
  tombstone: (documentId: string): Promise<void> =>
    page.evaluate((id) => (window as unknown as DriverWindow).__D.tombstone(id), documentId),
  isTombstoned: (documentId: string): Promise<boolean> =>
    page.evaluate((id) => (window as unknown as DriverWindow).__D.isTombstoned(id), documentId),
  close: (): Promise<void> => page.evaluate(() => (window as unknown as DriverWindow).__D.close()),
});

async function bootHarness(page: Page, slowBootMs = 0): Promise<void> {
  await installRoute(page, slowBootMs);
  await page.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' });
  // The REAL module, freshly bundled this run, injected into the page's main world.
  await page.addScriptTag({ path: bundlePath });
  const present = await page.evaluate(
    () => typeof (window as unknown as DriverWindow).__SimTransportMod?.SimTransport === 'function',
  );
  if (!present) throw new Error('sim-transport: the SimTransport bundle did not expose window.__SimTransportMod');
  await page.evaluate(installTransportDriver, WIRE);
}

async function waitForMode(page: Page, mode: string, timeout: number, what: string): Promise<void> {
  try {
    await page.waitForFunction(
      (m) => (window as unknown as DriverWindow).__D.state().mode === m,
      mode,
      { timeout, polling: 25 },
    );
  } catch {
    const st = await d(page).state();
    throw new Error(
      `${what}: the transport never reached '${mode}' within ${timeout}ms — it is '${st.mode}' ` +
      `(modes seen: ${st.modes.join(' → ') || 'none'}; telemetry: ${st.telemetry.map((t) => t.event).join(', ') || 'none'})`,
    );
  }
}

interface EnvelopeMatch {
  type: string;
  activationId?: string;
  variantKey?: string;
  configHash?: string;
  after?: number;
}

async function waitForEnvelope(page: Page, m: EnvelopeMatch, timeout: number, what: string): Promise<RawEnvelope> {
  try {
    const handle = await page.waitForFunction(
      (match) => {
        const api = (window as unknown as DriverWindow).__D;
        if (!api) return null;
        for (const entry of api.state().envelopes) {
          if (match.after !== undefined && entry.n <= match.after) continue;
          const e = entry.env;
          if (e.type !== match.type) continue;
          if (match.activationId !== undefined && e.activationId !== match.activationId) continue;
          if (match.variantKey !== undefined && e.variantKey !== match.variantKey) continue;
          if (match.configHash !== undefined && e.configHash !== match.configHash) continue;
          return e;
        }
        return null;
      },
      m,
      { timeout, polling: 25 },
    );
    return (await handle.jsonValue()) as RawEnvelope;
  } catch {
    const st = await d(page).state();
    throw new Error(
      `${what}: no ${m.type} matching ${JSON.stringify({ ...m, after: undefined })} arrived within ${timeout}ms. ` +
      `Inbox: ${st.envelopes.map((e) => String(e.env.type)).join(', ') || 'empty'}; ` +
      `rejections: ${st.rejected.map((r) => r.reason).join(', ') || 'none'}`,
    );
  }
}

/** Wait until the transport has reported at least `count` rejections. */
async function waitForRejections(page: Page, count: number, timeout: number, what: string): Promise<RejectEntry[]> {
  try {
    await page.waitForFunction(
      (n) => (window as unknown as DriverWindow).__D.state().rejected.length >= n,
      count,
      { timeout, polling: 15 },
    );
  } catch {
    const st = await d(page).state();
    throw new Error(
      `${what}: expected at least ${count} rejection(s) within ${timeout}ms, saw ${st.rejected.length} ` +
      `(${st.rejected.map((r) => r.reason).join(', ') || 'none'})`,
    );
  }
  return (await d(page).state()).rejected;
}

/** The activation identity carried by an envelope, as the reveal invariant compares it. */
const identityOf = (env: RawEnvelope): PresentationIdentity => ({
  packageRevision: String(env.packageRevision),
  documentId: String(env.documentId),
  activationId: String(env.activationId),
  variantKey: String(env.variantKey),
  configHash: String(env.configHash),
});

const newDocIdent = (): DocIdent => ({
  playerSessionId: newPlayerSessionId(),
  packageRevision: derivePackageRevision(`e2e-${PACKAGE}`, 'sim-transport-suite'),
  documentId: newDocumentId(),
});

/**
 * Mount the real package, hand the harness the child's ports, complete the handshake with the REAL
 * transport, and initialise the document. Every test that needs a live modern transport starts here,
 * so no two tests can disagree about what "up" means.
 */
async function bootDocument(
  page: Page,
  variant: string,
  opts: { spy?: boolean; ident?: DocIdent } = {},
): Promise<{ ident: DocIdent; variants: string[] }> {
  const ident = opts.ident ?? newDocIdent();
  await d(page).mount(entryUrl(variant));
  if (opts.spy !== false) {
    expect(await d(page).spy(), 'the harness could not attach to the child window').toBe(true);
  }
  await d(page).open(ident);
  await waitForMode(page, 'modern', HANDSHAKE_TIMEOUT_MS, `handshake for ${variant}`);

  await d(page).send(INIT_DOCUMENT, null, {
    parentOrigin: API_ORIGIN,
    quality: 'high',
    audible: { muted: true, volume: 0 },
  });
  const ready = await waitForEnvelope(page, { type: DOCUMENT_READY }, HANDSHAKE_TIMEOUT_MS, 'INIT_DOCUMENT');
  const payload = ready.payload as DocumentReadyPayload;
  const variants = Array.isArray(payload?.variants) ? payload.variants : [];
  // Fixture drift check: a renamed section must fail here rather than silently change what ran.
  expect(variants, `the staged package no longer reports the section '${variant}' this suite drives`).toContain(variant);
  return { ident, variants };
}

/** Index (0-based) of the captured port the CHILD says it adopted, read from the child's recorder. */
async function adoptedPortIndex(page: Page, documentId: string): Promise<number> {
  const proto = await d(page).proto();
  const accepts = proto.filter(
    (e) => e.dir === 'out' && e.kind === SIM_BOOTSTRAP_ACCEPT_KIND && e.documentId === documentId,
  );
  expect(accepts.length, `the child never posted a bootstrap accept for document ${documentId}`).toBeGreaterThan(0);
  const portOrdinal = accepts[accepts.length - 1].port;
  expect(portOrdinal, 'the child recorded an accept with no port ordinal').not.toBeNull();
  const idx = Number(portOrdinal) - 1;
  const st = await d(page).state();
  expect(
    st.ports,
    'the harness captured fewer ports than the child was offered — the adopted port cannot be identified',
  ).toBeGreaterThan(idx);
  return idx;
}

/** Drive one activation to a proven presentation through the REAL transport. */
async function presentActivation(
  page: Page,
  activation: ActivationIdent,
  config: SimPresentationConfig,
  what: string,
): Promise<RawEnvelope> {
  const ledger = await d(page).state();
  const before = ledger.envelopes.length > 0 ? ledger.envelopes[ledger.envelopes.length - 1].n : 0;
  expect(await d(page).send(PREPARE_SECTION, activation, { variantKey: activation.variantKey, config }), `${what}: PREPARE_SECTION was not sent`).toBe(true);
  await waitForEnvelope(
    page,
    { type: SECTION_APPLIED, activationId: activation.activationId, variantKey: activation.variantKey, configHash: activation.configHash, after: before },
    SIM_PREPARE_TIMEOUT_MS,
    what,
  );
  expect(await d(page).send(PRESENT_SECTION, activation, {}), `${what}: PRESENT_SECTION was not sent`).toBe(true);
  const presented = await waitForEnvelope(
    page,
    { type: SECTION_PRESENTED, activationId: activation.activationId, variantKey: activation.variantKey, configHash: activation.configHash, after: before },
    SIM_PRESENT_TIMEOUT_MS,
    what,
  );
  const payload = presented.payload as SectionPresentedPayload;
  expect(payload?.framesSubmitted, `${what}: SECTION_PRESENTED claimed no submitted frame`).toBeGreaterThanOrEqual(1);
  return presented;
}

// ─── The reveal invariant, evaluated in Node with the SHIPPED functions ───────────────────────

interface TimelineItem {
  n: number;
  kind: 'sent' | 'recv';
  type: string;
  activationId: string | null;
  env: RawEnvelope | null;
}

function timelineOf(state: LedgerState): TimelineItem[] {
  const items: TimelineItem[] = [
    ...state.sent.map((s) => ({ n: s.n, kind: 'sent' as const, type: s.type, activationId: s.activationId, env: null })),
    ...state.envelopes.map((e) => ({
      n: e.n,
      kind: 'recv' as const,
      type: String(e.env.type),
      activationId: typeof e.env.activationId === 'string' ? e.env.activationId : null,
      env: e.env,
    })),
  ];
  return items.sort((a, b) => a.n - b.n);
}

/** Map one timeline item onto the activation machine's event vocabulary, or null if it is not one. */
function activationEventFor(item: TimelineItem, activationId: string): ActivationEvent | null {
  if (item.activationId !== activationId) return null;
  if (item.kind === 'sent' && item.type === PREPARE_SECTION) return { type: 'PREPARE' };
  if (item.kind === 'sent' && item.type === PRESENT_SECTION) return { type: 'PRESENT' };
  if (item.kind === 'recv' && item.type === SECTION_APPLIED) return { type: 'APPLIED' };
  if (item.kind === 'recv' && item.type === SECTION_PRESENTED && item.env) {
    return { type: 'PRESENTED', ackIdentity: identityOf(item.env) };
  }
  return null;
}

interface RevealStep {
  n: number;
  what: string;
  activationId: string | null;
  allowed: boolean;
  refusal: string | null;
}

/**
 * Replay the whole ledger through the SHIPPED reducer and ask the SHIPPED gate after every step.
 *
 * This is the only honest way to state "no reveal was authorised before the acknowledgement": a
 * single check at the end cannot distinguish a gate that opened at the right moment from one that
 * was open the whole time.
 */
function revealTrace(state: LedgerState, intent: PresentationIdentity): RevealStep[] {
  let machine: ActivationMachineState = initialActivationState(intent);
  let documentReady = false;
  const steps: RevealStep[] = [];
  for (const item of timelineOf(state)) {
    if (item.kind === 'recv' && item.type === DOCUMENT_READY) documentReady = true;
    const event = activationEventFor(item, intent.activationId);
    if (event) machine = activationReducer(machine, event);
    const decision = mayReveal({ activation: machine, current: intent, documentReady, contextLost: false });
    steps.push({
      n: item.n,
      what: `${item.kind}:${item.type}`,
      activationId: item.activationId,
      allowed: decision.allowed,
      refusal: decision.allowed ? null : decision.refusal,
    });
  }
  return steps;
}

// ─── Suite ────────────────────────────────────────────────────────────────────────────────────

// Deliberately NOT serial. Every test mounts its own document and constructs its own transport, so
// nothing here depends on a predecessor — and in serial mode one failure would mark every later
// test `skipped`, which would hide the other things a regression broke behind the first one.
test.beforeAll(async () => {
  ensureFixture();
  buildBundle();
  await startAssetServer();
});

test.afterAll(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (bundleDir) rmSync(bundleDir, { recursive: true, force: true });
});

// ── 1. HANDSHAKE ─────────────────────────────────────────────────────────────────────────────

test('the real transport completes the v3 handshake against the real child: idle → offering → modern', async ({ page }) => {
  await bootHarness(page);
  await d(page).create();
  await d(page).mount(entryUrl(V3A));
  expect(await d(page).spy()).toBe(true);

  const before = await d(page).state();
  expect(before.mode, 'a transport that has not been opened is idle').toBe('idle');
  expect(before.channels, 'no channel may be minted before open()').toBe(0);

  const ident = newDocIdent();
  await d(page).open(ident);
  await waitForMode(page, 'modern', HANDSHAKE_TIMEOUT_MS, 'handshake');

  const st = await d(page).state();
  // The mode CALLBACK is what the player reacts to; getMode() alone would not prove it fired.
  expect(st.modes, 'onMode must report exactly the offering → modern transition').toEqual(['offering', 'modern']);
  expect(st.telemetry.map((t) => t.event)).toContain('transport-modern');
  expect(
    st.telemetry.find((t) => t.event === 'transport-modern')?.detail?.documentId,
    'the modern telemetry must name the document it adopted for',
  ).toBe(ident.documentId);

  // The child's OWN transcript: it received an offer for this document and accepted it on a port.
  const proto = await d(page).proto();
  const offers = proto.filter((e) => e.dir === 'in' && e.kind === SIM_BOOTSTRAP_KIND && e.documentId === ident.documentId);
  const accepts = proto.filter((e) => e.dir === 'out' && e.kind === SIM_BOOTSTRAP_ACCEPT_KIND && e.documentId === ident.documentId);
  expect(offers.length, 'the child recorded no bootstrap offer — the handshake was not what completed').toBeGreaterThan(0);
  expect(accepts.length, 'the child never accepted a port').toBe(1);
  expect(accepts[0].channel, 'the accept must be sent ON THE PORT, never on the window').toBe('port');

  // Port capture alignment: the harness saw exactly the offers the child did, so the port ordinal
  // the child stamped on its accept indexes the harness's array. Every injection below depends on it.
  expect(st.ports, 'the harness captured a different number of ports than the child was offered').toBe(offers.length);

  // A modern transport is one that carries traffic, not one that reached a state name.
  const ok = await d(page).send(INIT_DOCUMENT, null, {
    parentOrigin: API_ORIGIN,
    quality: 'high',
    audible: { muted: true, volume: 0 },
  });
  expect(ok, 'send() refused on a modern transport').toBe(true);
  const ready = await waitForEnvelope(page, { type: DOCUMENT_READY }, HANDSHAKE_TIMEOUT_MS, 'INIT_DOCUMENT');
  const payload = ready.payload as DocumentReadyPayload;
  expect(payload.variants, 'DOCUMENT_READY did not report the sections this suite drives').toEqual(
    expect.arrayContaining([V3A, V3B, V3NOPRESENT]),
  );
  expect(payload.capabilities.activationScoped).toBe(true);
  expect(ready.playerSessionId, 'the child echoed a different session').toBe(ident.playerSessionId);
  expect(ready.documentId, 'the child echoed a different document epoch').toBe(ident.documentId);

  const final = await d(page).state();
  expect(final.rejected, `the healthy handshake produced rejections: ${final.rejected.map((r) => r.reason).join(', ')}`).toEqual([]);
});

// ── 2. OFFER / RETRY LOOP ────────────────────────────────────────────────────────────────────

test('the 150 ms retry loop adopts a child that boots AFTER the first offers were made', async ({ page }) => {
  // The entry document is held back, so the parent's first offers land in a frame with no child in
  // it. Only the re-offer can adopt — which is the branch the OFFER_INTERVAL_MS timer exists for.
  const SLOW_BOOT_MS = 400;
  await bootHarness(page, SLOW_BOOT_MS);
  await d(page).create();
  await d(page).mount(entryUrl(V3A, '&slowboot=1'), { awaitLoad: false });

  const ident = newDocIdent();
  const t0 = Date.now();
  await d(page).open(ident);
  await waitForMode(page, 'modern', HANDSHAKE_TIMEOUT_MS, 'late-boot handshake');
  const elapsed = Date.now() - t0;

  const st = await d(page).state();
  const proto = await d(page).proto();
  const offersSeenByChild = proto.filter((e) => e.dir === 'in' && e.kind === SIM_BOOTSTRAP_KIND).length;

  // NON-VACUITY: the child cannot have been there for the first offer.
  expect(elapsed, 'the child was not actually late — this run proves nothing about the retry loop')
    .toBeGreaterThanOrEqual(SLOW_BOOT_MS);
  expect(st.channels, 'only one channel was ever minted, so no retry happened').toBeGreaterThan(1);
  expect(
    offersSeenByChild,
    'the child received every offer the parent made, so no offer was lost to the late boot',
  ).toBeLessThan(st.channels);
  expect(offersSeenByChild, 'the child received no offer at all').toBeGreaterThan(0);
  expect(st.modes).toEqual(['offering', 'modern']);

  // The hello path is the other half of the recovery: a child that booted late has already sent its
  // only hello, and the parent answers a hello with a fresh offer.
  expect(
    st.telemetry.filter((t) => t.event === 'transport-hello').length,
    'the parent never saw the late child’s hello',
  ).toBeGreaterThan(0);

  // And it is a WORKING transport, not merely an adopted one.
  await d(page).send(INIT_DOCUMENT, null, { parentOrigin: API_ORIGIN, quality: 'high', audible: { muted: true, volume: 0 } });
  await waitForEnvelope(page, { type: DOCUMENT_READY }, HANDSHAKE_TIMEOUT_MS, 'late-boot INIT_DOCUMENT');
});

test('the offer loop is bounded: 12 channels at most, and a child that never answers ends legacy', async ({ page }) => {
  await bootHarness(page);

  // ── a child that floods hellos and never adopts ──────────────────────────────────────────
  await d(page).create();
  await d(page).mount(FLOOD_URL);
  const flooded = newDocIdent();
  await d(page).open(flooded);
  await waitForMode(page, 'legacy', SIM_BOOTSTRAP_TIMEOUT_MS + 8_000, 'flooded bootstrap');

  const floodState = await d(page).state();
  const hellos = floodState.telemetry.filter((t) => t.event === 'transport-hello').length;
  // NON-VACUITY: the attack was delivered many times over, so 12 is a cap and not a coincidence.
  expect(await d(page).helloCount(), 'the flooder never posted a hello').toBeGreaterThan(20);
  expect(hellos, 'the parent did not see the flood — the cap was never under pressure').toBeGreaterThan(12);
  expect(floodState.channels, 'the transport minted more channels than its own cap allows').toBe(12);
  expect(floodState.mode).toBe('legacy');
  expect(floodState.modes).toEqual(['offering', 'legacy']);
  expect(floodState.telemetry.map((t) => t.event)).toContain('transport-legacy-no-answer');

  // ── a child that answers nothing at all ──────────────────────────────────────────────────
  await d(page).create();
  await d(page).mount(DEAF_URL);
  const deaf = newDocIdent();
  const t0 = Date.now();
  await d(page).open(deaf);
  await waitForMode(page, 'legacy', SIM_BOOTSTRAP_TIMEOUT_MS + 8_000, 'deaf bootstrap');
  const waited = Date.now() - t0;

  const deafState = await d(page).state();
  expect(waited, 'the transport gave up before its own bootstrap deadline').toBeGreaterThanOrEqual(SIM_BOOTSTRAP_TIMEOUT_MS - 50);
  expect(deafState.channels, 'the retry loop did not run against the silent child').toBeGreaterThan(1);
  expect(deafState.channels, 'the retry loop exceeded the channel cap').toBeLessThanOrEqual(12);
  expect(deafState.mode).toBe('legacy');
  expect(deafState.telemetry.map((t) => t.event)).toContain('transport-legacy-no-answer');
  expect(await d(page).send(INIT_DOCUMENT, null, {}), 'send() must refuse on a legacy transport').toBe(false);

  // ── a frame whose origin cannot be addressed at all ──────────────────────────────────────
  // Sandboxed without allow-same-origin: there is no exact origin to offer a port to, so the only
  // honest outcome is legacy — decided BEFORE any channel is minted.
  await d(page).create();
  await d(page).mount(entryUrl(V3A), { sandbox: 'allow-scripts', awaitLoad: false });
  await d(page).open(newDocIdent());
  const opaque = await d(page).state();
  expect(opaque.mode, 'an opaque-origin frame must be classified legacy immediately').toBe('legacy');
  expect(opaque.modes).toEqual(['legacy']);
  expect(opaque.channels, 'a port was offered to a frame with no addressable origin').toBe(0);
  expect(opaque.telemetry.map((t) => t.event)).toContain('transport-legacy-opaque-origin');
});

test('a hello from a document that NAVIGATED the frame to another origin is ignored', async ({ page }) => {
  // THE STALE-FRAME CLASS, ARRIVING THROUGH THE FRONT DOOR (see the module header of SimTransport).
  // `frame.contentWindow` belongs to the ELEMENT and survives navigation, so `e.source === frame
  // .contentWindow` is TRUE for a document that is no longer the one the parent addressed. The
  // origin comparison is the only thing standing between that document and an offered port.
  await bootHarness(page);
  await d(page).create();
  await d(page).mount(HOP_URL, { awaitLoad: false });
  await d(page).open(newDocIdent());
  await waitForMode(page, 'legacy', SIM_BOOTSTRAP_TIMEOUT_MS + 8_000, 'navigated-frame bootstrap');

  const st = await d(page).state();
  const foreign = st.hellosSeen.filter((h) => h.origin !== API_ORIGIN);

  // NON-VACUITY: the hellos were really posted, really reached this window, and really came from a
  // different origin than the one the transport is addressing.
  expect(st.hellosSeen.length, 'no hello ever arrived — the navigation did not happen').toBeGreaterThan(20);
  expect(foreign.length, 'every hello came from the addressed origin, so nothing was under test').toBe(
    st.hellosSeen.length,
  );
  expect(foreign[0].origin, 'the hellos did not come from the origin the frame navigated to').toBe(FOREIGN_ORIGIN);

  // AND THE TRANSPORT SAW NONE OF THEM.
  expect(
    st.telemetry.filter((t) => t.event === 'transport-hello').length,
    'the transport accepted a hello from a document at an origin it never addressed',
  ).toBe(0);
  expect(st.mode, 'a navigated-away frame must not be able to complete a handshake').toBe('legacy');
  expect(
    st.channels,
    'the foreign hellos minted offers — the transport reached its 12-channel cap, which only the flood can do',
  ).toBeLessThan(12);
});

// ── 3. PORT REPLACEMENT ──────────────────────────────────────────────────────────────────────

test('a new documentId tombstones the old epoch, the child re-adopts, and the dead epoch is refused', async ({ page }) => {
  await bootHarness(page);
  await d(page).create();

  const first = await bootDocument(page, V3A);
  expect(await d(page).isTombstoned(first.ident.documentId), 'a live epoch must not be tombstoned').toBe(false);

  // The SAME live frame, a NEW document epoch. Nothing is reloaded: this is the changeover the
  // tombstone exists for, and the window in which a message from the old epoch is most dangerous.
  const second: DocIdent = { ...first.ident, documentId: newDocumentId() };
  await d(page).open(second);
  await waitForMode(page, 'modern', HANDSHAKE_TIMEOUT_MS, 'second epoch handshake');

  const st = await d(page).state();
  expect(st.modes, 'the transport must leave and re-enter modern across an epoch change').toEqual([
    'offering', 'modern', 'offering', 'modern',
  ]);
  expect(await d(page).isTombstoned(first.ident.documentId), 'the previous epoch was not tombstoned').toBe(true);
  expect(await d(page).isTombstoned(second.documentId), 'the live epoch must not be tombstoned').toBe(false);

  // The CHILD's transcript: two accepts, one per epoch, in order.
  const proto = await d(page).proto();
  const accepts = proto.filter((e) => e.dir === 'out' && e.kind === SIM_BOOTSTRAP_ACCEPT_KIND);
  expect(accepts.map((a) => a.documentId), 'the child did not adopt the new epoch').toEqual([
    first.ident.documentId, second.documentId,
  ]);

  // The new port really carries traffic. Anchored past everything the FIRST epoch said, so the
  // first epoch's DOCUMENT_READY cannot be mistaken for the second's.
  const cursor = st.envelopes.length > 0 ? st.envelopes[st.envelopes.length - 1].n : 0;
  await d(page).send(INIT_DOCUMENT, null, { parentOrigin: API_ORIGIN, quality: 'high', audible: { muted: true, volume: 0 } });
  const ready = await waitForEnvelope(page, { type: DOCUMENT_READY, after: cursor }, HANDSHAKE_TIMEOUT_MS, 'second epoch INIT_DOCUMENT');
  expect(ready.documentId, 'DOCUMENT_READY came from the wrong epoch').toBe(second.documentId);

  // A message from the DEAD epoch, delivered on the live port, is refused for being dead — not for
  // being out of order, and not silently.
  const portIdx = await adoptedPortIndex(page, second.documentId);
  const beforeInjection = await d(page).state();
  const stale = {
    namespace: SIM_PROTOCOL_NAMESPACE,
    protocolVersion: SIM_PROTOCOL_VERSION,
    type: SECTION_PRESENTED,
    playerSessionId: second.playerSessionId,
    packageRevision: second.packageRevision,
    documentId: first.ident.documentId,
    activationId: 'act_from_the_dead',
    variantKey: V3A,
    configHash: computeConfigHash(DEFAULT_PRESENTATION_CONFIG),
    seq: 9001,
    payload: { variantKey: V3A, configHash: computeConfigHash(DEFAULT_PRESENTATION_CONFIG), framesSubmitted: 1 },
  };
  expect(await d(page).raw(portIdx, stale), 'the stale envelope could not be delivered').toBe(true);
  const rejections = await waitForRejections(page, beforeInjection.rejected.length + 1, 5_000, 'tombstoned epoch');

  const newest = rejections[rejections.length - 1];
  expect(newest.reason).toBe('tombstoned-document');
  expect(newest.detail).toBe(first.ident.documentId);
  const after = await d(page).state();
  expect(
    after.envelopes.length,
    'the tombstoned message was DELIVERED to the application — onEnvelope must never fire for it',
  ).toBe(beforeInjection.envelopes.length);
});

// ── 4. ENVELOPE VALIDATION AT THE PARENT ─────────────────────────────────────────────────────

/**
 * Every reason the shipped validator can give, as a Record so the type system enforces coverage: a
 * reason ADDED to EnvelopeRejectReason fails to compile here (missing property) and a reason REMOVED
 * fails too (excess property). A hand-written array could silently fall behind the union, which is
 * the exact drift this suite exists to eliminate.
 */
const REASON_COVERAGE: Record<EnvelopeRejectReason, true> = {
  'not-an-object': true,
  'wrong-namespace': true,
  'wrong-protocol-version': true,
  'missing-type': true,
  'unknown-type': true,
  'missing-player-session': true,
  'wrong-player-session': true,
  'missing-package-revision': true,
  'missing-document-id': true,
  'unknown-document': true,
  'tombstoned-document': true,
  'missing-activation-id': true,
  'missing-variant-key': true,
  'missing-config-hash': true,
  'bad-seq': true,
  'duplicate-seq': true,
  'out-of-order-seq': true,
  'malformed-payload': true,
};

test('every rejection reason the parent can give is produced by a real hostile envelope on the real port', async ({ page }) => {
  await bootHarness(page);
  await d(page).create();
  const { ident } = await bootDocument(page, V3A);
  const portIdx = await adoptedPortIndex(page, ident.documentId);

  const config = { ...DEFAULT_PRESENTATION_CONFIG };
  const configHash = computeConfigHash(config);
  const wellFormed = (over: Record<string, unknown>): Record<string, unknown> => ({
    namespace: SIM_PROTOCOL_NAMESPACE,
    protocolVersion: SIM_PROTOCOL_VERSION,
    type: DOMAIN_EVENT,
    playerSessionId: ident.playerSessionId,
    packageRevision: ident.packageRevision,
    documentId: ident.documentId,
    activationId: 'act_probe',
    variantKey: V3A,
    configHash,
    seq: 5_000,
    payload: { event: 'probe' },
    ...over,
  });

  const deadDocument = newDocumentId();
  await d(page).tombstone(deadDocument);

  /**
   * Attacks, in order. The sequence-number cases come LAST on purpose: the two that are ACCEPTED
   * advance the transport's inbound watermark, and everything after them would then be judged
   * against a moved goalpost.
   */
  const attacks: { what: string; data: unknown; reason: EnvelopeRejectReason }[] = [
    { what: 'a bare number', data: 42, reason: 'not-an-object' },
    { what: 'an array (structurally an object, semantically not one)', data: [1, 2, 3], reason: 'not-an-object' },
    { what: 'another library’s traffic', data: wellFormed({ namespace: 'someone.else' }), reason: 'wrong-namespace' },
    { what: 'a v2-era protocol version', data: wellFormed({ protocolVersion: 2 }), reason: 'wrong-protocol-version' },
    { what: 'no type at all', data: wellFormed({ type: '' }), reason: 'missing-type' },
    // The reflection trick: a parent→child COMMAND posted back as though it were an acknowledgement.
    { what: 'a reflected parent→child command', data: wellFormed({ type: PRESENT_SECTION }), reason: 'unknown-type' },
    { what: 'no session', data: wellFormed({ playerSessionId: '' }), reason: 'missing-player-session' },
    { what: 'another player session', data: wellFormed({ playerSessionId: newPlayerSessionId() }), reason: 'wrong-player-session' },
    { what: 'no package revision', data: wellFormed({ packageRevision: '' }), reason: 'missing-package-revision' },
    { what: 'no document id', data: wellFormed({ documentId: '' }), reason: 'missing-document-id' },
    { what: 'a tombstoned document epoch', data: wellFormed({ documentId: deadDocument }), reason: 'tombstoned-document' },
    { what: 'a document this transport never opened', data: wellFormed({ documentId: newDocumentId() }), reason: 'unknown-document' },
    {
      what: 'an activation-scoped ack with no activation id',
      data: wellFormed({ type: SECTION_PRESENTED, activationId: undefined }),
      reason: 'missing-activation-id',
    },
    {
      what: 'an activation-scoped ack with no variant key',
      data: wellFormed({ type: SECTION_PRESENTED, variantKey: undefined }),
      reason: 'missing-variant-key',
    },
    {
      what: 'an activation-scoped ack with no config hash',
      data: wellFormed({ type: SECTION_PRESENTED, configHash: undefined }),
      reason: 'missing-config-hash',
    },
    { what: 'a sequence number of zero', data: wellFormed({ seq: 0 }), reason: 'bad-seq' },
    { what: 'a fractional sequence number', data: wellFormed({ seq: 7.5 }), reason: 'bad-seq' },
    { what: 'a non-object payload', data: wellFormed({ payload: 7 }), reason: 'malformed-payload' },
    { what: 'an array payload', data: wellFormed({ payload: [] }), reason: 'malformed-payload' },
  ];

  const observed = new Set<string>();
  for (const attack of attacks) {
    const before = await d(page).state();
    expect(await d(page).raw(portIdx, attack.data), `${attack.what}: the attack could not be delivered`).toBe(true);
    const rejected = await waitForRejections(page, before.rejected.length + 1, 5_000, attack.what);
    const newest = rejected[rejected.length - 1];
    expect(newest.reason, `${attack.what}: wrong reason`).toBe(attack.reason);
    const after = await d(page).state();
    expect(
      after.envelopes.length,
      `${attack.what}: onEnvelope fired for a message the transport claims to have rejected`,
    ).toBe(before.envelopes.length);
    expect(after.rejected.length, `${attack.what}: exactly one rejection was expected`).toBe(before.rejected.length + 1);
    observed.add(newest.reason);
  }

  // ── the sequence guard, which needs an ACCEPTED envelope to have a watermark at all ───────
  const seqBase = 5_000;
  const accepted = wellFormed({ seq: seqBase });
  const beforeAccept = await d(page).state();
  expect(await d(page).raw(portIdx, accepted)).toBe(true);
  await page.waitForFunction(
    (n) => (window as unknown as DriverWindow).__D.state().envelopes.length > n,
    beforeAccept.envelopes.length,
    { timeout: 5_000, polling: 15 },
  );
  const afterAccept = await d(page).state();
  expect(afterAccept.rejected.length, 'the well-formed envelope was rejected').toBe(beforeAccept.rejected.length);
  expect(String(afterAccept.envelopes[afterAccept.envelopes.length - 1].env.seq)).toBe(String(seqBase));

  for (const [what, seq, reason] of [
    ['the same sequence number twice', seqBase, 'duplicate-seq'],
    ['a sequence number that went backwards', seqBase - 1, 'out-of-order-seq'],
  ] as const) {
    const before = await d(page).state();
    expect(await d(page).raw(portIdx, wellFormed({ seq })), `${what}: the attack could not be delivered`).toBe(true);
    const rejected = await waitForRejections(page, before.rejected.length + 1, 5_000, what);
    const newest = rejected[rejected.length - 1];
    expect(newest.reason, `${what}: wrong reason`).toBe(reason);
    expect((await d(page).state()).envelopes.length, `${what}: onEnvelope fired anyway`).toBe(before.envelopes.length);
    observed.add(newest.reason);
  }

  // Coverage is asserted, not hoped for: every reason the shipped union declares was produced by a
  // real message on a real port, and none of them arrived by any other route.
  expect([...observed].sort(), 'not every EnvelopeRejectReason was exercised at the parent').toEqual(
    Object.keys(REASON_COVERAGE).sort(),
  );
});

// ── 5. ACTIVATION IDENTITY + STALE REJECTION ─────────────────────────────────────────────────

test('A → B → A: a replayed acknowledgement is ACCEPTED by the transport and refused by the identity gate', async ({ page }) => {
  await bootHarness(page);
  await d(page).create();
  const { ident } = await bootDocument(page, V3A);
  const portIdx = await adoptedPortIndex(page, ident.documentId);

  // ONE configuration for all three activations, so `configHash` is identical across them and the
  // ONLY axis that distinguishes activation 3 from activation 1 is `activationId`. That is the
  // whole point: every weaker identity scheme this codebase has tried would call them the same.
  const config: SimPresentationConfig = { ...DEFAULT_PRESENTATION_CONFIG, autoScript: true };
  const configHash = computeConfigHash(config);

  const act1: ActivationIdent = { activationId: newActivationId(), variantKey: V3A, configHash };
  const act2: ActivationIdent = { activationId: newActivationId(), variantKey: V3B, configHash };
  const act3: ActivationIdent = { activationId: newActivationId(), variantKey: V3A, configHash };

  const ack1 = await presentActivation(page, act1, config, 'activation 1 (V3A)');
  const ack2 = await presentActivation(page, act2, config, 'activation 2 (V3B)');
  const ack3 = await presentActivation(page, act3, config, 'activation 3 (V3A again)');

  // NON-VACUITY: the three acknowledgements really are three, and 1 and 3 really do agree on
  // everything except the activation.
  expect(new Set([act1.activationId, act2.activationId, act3.activationId]).size).toBe(3);
  expect(ack1.variantKey).toBe(ack3.variantKey);
  expect(ack1.configHash).toBe(ack3.configHash);
  expect(ack1.activationId).not.toBe(ack3.activationId);
  expect(ack2.variantKey).toBe(V3B);

  // Activation 3 owns the channel: its own command round-trips before anything hostile arrives.
  expect(await d(page).send(PAUSE_AUTOMATION, act3, {})).toBe(true);
  await waitForEnvelope(page, { type: AUTOMATION_PAUSED, activationId: act3.activationId }, SIM_PRESENT_TIMEOUT_MS, 'activation 3 liveness');

  const beforeReplay = await d(page).state();
  const maxSeq = beforeReplay.envelopes.reduce((m, e) => Math.max(m, Number(e.env.seq) || 0), 0);
  // Activation 1's acknowledgement, verbatim, with a fresh sequence number.
  //
  // The sequence number MUST move: replaying it with its original seq is rejected as `duplicate-seq`
  // (proven in the validation test above), and a rejection by the sequence guard would say nothing
  // about the identity gate — it would mask the very thing under test. Every identity axis is
  // untouched, which is what makes this a stale acknowledgement rather than a malformed one.
  const replay = { ...ack1, seq: maxSeq + 1 };
  expect(await d(page).raw(portIdx, replay), 'the replayed acknowledgement could not be delivered').toBe(true);
  await page.waitForFunction(
    (n) => (window as unknown as DriverWindow).__D.state().envelopes.length > n,
    beforeReplay.envelopes.length,
    { timeout: 5_000, polling: 15 },
  );

  const afterReplay = await d(page).state();
  const delivered = afterReplay.envelopes[afterReplay.envelopes.length - 1].env;
  // THE TRANSPORT ACCEPTS IT. It is well-formed, for the right session, the right document and a
  // live epoch — the transport has no complaint to make, and pretending otherwise would mean the
  // transport was silently doing the identity gate's job somewhere it could not be inspected.
  expect(delivered.type).toBe(SECTION_PRESENTED);
  expect(delivered.activationId, 'the replayed acknowledgement was not the one delivered').toBe(act1.activationId);
  expect(
    afterReplay.rejected.length,
    `the transport rejected a well-formed envelope: ${afterReplay.rejected.map((r) => r.reason).join(', ')}`,
  ).toBe(beforeReplay.rejected.length);

  // AND THE IDENTITY GATE REFUSES IT — with the shipped function, on the shipped axis order.
  const intent3: PresentationIdentity = {
    packageRevision: ident.packageRevision,
    documentId: ident.documentId,
    activationId: act3.activationId,
    variantKey: act3.variantKey,
    configHash: act3.configHash,
  };
  expect(identityRefusal(identityOf(delivered), intent3)).toBe('activation-mismatch');
  // Stated as the player states it: a machine driven to PRESENTED by the replayed ack may not reveal.
  const byReplay = activationReducer(
    activationReducer(
      activationReducer(activationReducer(initialActivationState(intent3), { type: 'PREPARE' }), { type: 'APPLIED' }),
      { type: 'PRESENT' },
    ),
    { type: 'PRESENTED', ackIdentity: identityOf(delivered) },
  );
  expect(mayReveal({ activation: byReplay, current: intent3, documentReady: true, contextLost: false })).toEqual({
    allowed: false,
    refusal: 'activation-mismatch',
  });

  // Activation 3's OWN acknowledgement still authorises the reveal — the stale one changed nothing.
  const byOwn = activationReducer(
    activationReducer(
      activationReducer(activationReducer(initialActivationState(intent3), { type: 'PREPARE' }), { type: 'APPLIED' }),
      { type: 'PRESENT' },
    ),
    { type: 'PRESENTED', ackIdentity: identityOf(ack3) },
  );
  expect(mayReveal({ activation: byOwn, current: intent3, documentReady: true, contextLost: false })).toEqual({ allowed: true });

  // The observable consequence of the acceptance, measured rather than assumed.
  //
  // The replay was numbered `maxSeq + 1` — the exact number the child's next message was going to
  // use — so that message is refused as a duplicate. And then the channel RECOVERS: the message
  // after it numbers higher than the watermark and is accepted normally. Both halves are asserted,
  // because "the transport accepted a well-formed replay" and "an injected envelope silently kills
  // the channel" are very different claims and only the first one is true.
  const beforeResume = await d(page).state();
  expect(await d(page).send(RESUME_AUTOMATION, act3, {})).toBe(true);
  const rejected = await waitForRejections(page, beforeResume.rejected.length + 1, SIM_PRESENT_TIMEOUT_MS, 'post-replay sequence collision');
  expect(rejected[rejected.length - 1].reason).toBe('duplicate-seq');
  expect(rejected[rejected.length - 1].detail).toBe(String(maxSeq + 1));
  expect(
    (await d(page).state()).envelopes.filter((e) => e.env.type === AUTOMATION_RESUMED).length,
    'the child’s reply arrived despite the replay having taken its sequence number',
  ).toBe(0);

  const beforeHeal = await d(page).state();
  const healCursor = beforeHeal.envelopes[beforeHeal.envelopes.length - 1].n;
  expect(await d(page).send(PAUSE_AUTOMATION, act3, {})).toBe(true);
  await waitForEnvelope(
    page,
    { type: AUTOMATION_PAUSED, activationId: act3.activationId, after: healCursor },
    SIM_PRESENT_TIMEOUT_MS,
    'the channel did not recover after the replay took one sequence number',
  );
  expect(
    (await d(page).state()).rejected.length,
    'the recovered message was rejected as well — the collision cost more than the one number it took',
  ).toBe(beforeHeal.rejected.length);
});

// ── 6. PREPARATION / PRESENTATION / REVEAL GATING ────────────────────────────────────────────

test('no reveal is authorised before the matching SECTION_PRESENTED, and V3NOPRESENT never authorises one', async ({ page }) => {
  await bootHarness(page);
  await d(page).create();
  const { ident } = await bootDocument(page, V3A);

  const config: SimPresentationConfig = { ...DEFAULT_PRESENTATION_CONFIG };
  const configHash = computeConfigHash(config);
  const healthy: ActivationIdent = { activationId: newActivationId(), variantKey: V3A, configHash };
  const presented = await presentActivation(page, healthy, config, 'the healthy activation');

  const intent: PresentationIdentity = {
    packageRevision: ident.packageRevision,
    documentId: ident.documentId,
    activationId: healthy.activationId,
    variantKey: healthy.variantKey,
    configHash: healthy.configHash,
  };
  const trace = revealTrace(await d(page).state(), intent);
  expect(trace.length, 'the ledger is empty — the whole trace would be vacuous').toBeGreaterThan(4);

  const firstAllowed = trace.findIndex((s) => s.allowed);
  expect(firstAllowed, 'the gate never authorised the reveal of a section that WAS presented').toBeGreaterThanOrEqual(0);
  expect(
    trace[firstAllowed].what,
    'the gate opened on some step other than the matching SECTION_PRESENTED',
  ).toBe(`recv:${SECTION_PRESENTED}`);
  expect(
    trace[firstAllowed].activationId,
    'the gate opened on an acknowledgement belonging to some other activation',
  ).toBe(healthy.activationId);
  // Everything before it refuses, and refuses for a reason that names the missing proof.
  for (const step of trace.slice(0, firstAllowed)) {
    expect(step.allowed, `a reveal was authorised at ${step.what}, before the acknowledgement`).toBe(false);
    expect(['document-not-ready', 'not-presented']).toContain(step.refusal);
  }
  expect(Number((presented.payload as SectionPresentedPayload).framesSubmitted)).toBeGreaterThanOrEqual(1);

  // ── the section that renders and never says so ────────────────────────────────────────────
  const silent: ActivationIdent = { activationId: newActivationId(), variantKey: V3NOPRESENT, configHash };
  const beforeSilent = (await d(page).state()).envelopes.length;
  expect(await d(page).send(PREPARE_SECTION, silent, { variantKey: V3NOPRESENT, config })).toBe(true);
  await waitForEnvelope(
    page,
    { type: SECTION_APPLIED, activationId: silent.activationId },
    SIM_PREPARE_TIMEOUT_MS,
    'V3NOPRESENT prepare',
  );
  expect(await d(page).send(PRESENT_SECTION, silent, {})).toBe(true);
  await page.waitForTimeout(SILENCE_WINDOW_MS);

  const finalState = await d(page).state();
  // NON-VACUITY: the section's present() really ran. Silence has to be a CHOICE the document made,
  // not a command that never arrived — otherwise this proves nothing about the gate.
  const child = await d(page).childState();
  expect(child, 'the child exposed no state — the silence cannot be attributed').not.toBeNull();
  expect(
    Number(child?.V3NOPRESENT?.presentCalls ?? 0),
    'V3NOPRESENT.present() never ran, so its silence is not evidence of anything',
  ).toBeGreaterThanOrEqual(1);
  expect(
    finalState.envelopes.filter((e) => e.env.type === SECTION_PRESENTED && e.env.activationId === silent.activationId).length,
    'V3NOPRESENT acknowledged a presentation it never made',
  ).toBe(0);
  expect(finalState.envelopes.length, 'the silent activation produced no traffic at all').toBeGreaterThan(beforeSilent);

  const silentIntent: PresentationIdentity = { ...intent, activationId: silent.activationId, variantKey: V3NOPRESENT };
  const silentTrace = revealTrace(finalState, silentIntent);
  expect(silentTrace.length).toBeGreaterThan(4);
  expect(
    silentTrace.filter((s) => s.allowed),
    'a reveal was authorised for a section that never acknowledged a presentation',
  ).toEqual([]);
  // …and it refuses for the RIGHT reason: the acknowledgement is missing, not the document.
  expect(silentTrace[silentTrace.length - 1].refusal).toBe('not-presented');
});

// ── 7. DISPOSAL ──────────────────────────────────────────────────────────────────────────────

test('close() invalidates the port in both directions', async ({ page }) => {
  await bootHarness(page);
  await d(page).create();
  const { ident } = await bootDocument(page, V3A);
  const portIdx = await adoptedPortIndex(page, ident.documentId);

  // NON-VACUITY: the transport is carrying traffic in both directions right up to the close.
  expect(await d(page).send(SET_QUALITY, null, { profile: 'balanced' })).toBe(true);
  await waitForEnvelope(page, { type: QUALITY_APPLIED }, SIM_PRESENT_TIMEOUT_MS, 'pre-close round trip');
  const before = await d(page).state();
  const childInboundBefore = (await d(page).proto()).filter((e) => e.dir === 'in' && e.channel === 'port').length;
  expect(childInboundBefore, 'the child received nothing before the close — the baseline is empty').toBeGreaterThan(0);

  await d(page).close();
  const closed = await d(page).state();
  expect(closed.mode).toBe('closed');
  expect(closed.modes[closed.modes.length - 1]).toBe('closed');
  expect(await d(page).isTombstoned(ident.documentId), 'close() must tombstone the epoch it was serving').toBe(true);

  // Parent → child is dead.
  expect(await d(page).send(SET_QUALITY, null, { profile: 'low' }), 'send() succeeded after close()').toBe(false);
  expect(await d(page).send(PREPARE_SECTION, { activationId: newActivationId(), variantKey: V3A, configHash: computeConfigHash(DEFAULT_PRESENTATION_CONFIG) }, { variantKey: V3A, config: DEFAULT_PRESENTATION_CONFIG }), 'an activation command was sent after close()').toBe(false);

  // Child → parent is dead too: a message on the port the child still holds reaches nothing.
  expect(
    await d(page).raw(portIdx, {
      namespace: SIM_PROTOCOL_NAMESPACE,
      protocolVersion: SIM_PROTOCOL_VERSION,
      type: DOMAIN_EVENT,
      playerSessionId: ident.playerSessionId,
      packageRevision: ident.packageRevision,
      documentId: ident.documentId,
      seq: 8_000,
      payload: { event: 'after-close' },
    }),
    'the post-close message could not even be attempted',
  ).toBe(true);
  await page.waitForTimeout(500);

  const after = await d(page).state();
  expect(after.envelopes.length, 'an envelope was delivered after close()').toBe(before.envelopes.length);
  expect(after.rejected.length, 'a closed transport must not even be listening').toBe(before.rejected.length);
  const childInboundAfter = (await d(page).proto()).filter((e) => e.dir === 'in' && e.channel === 'port').length;
  expect(childInboundAfter, 'a command reached the child after close()').toBe(childInboundBefore);

  // Idempotent: a second close changes nothing and throws nothing.
  await d(page).close();
  expect((await d(page).state()).mode).toBe('closed');
});
