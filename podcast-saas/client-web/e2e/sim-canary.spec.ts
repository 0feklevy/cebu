/**
 * THE PUBLISH-TIME BROWSER CANARY (Priority 5.4).
 *
 * Every other gate this codebase has for simulation packages is static: the bridge validator reads
 * bytes, the replace-compatibility contract compares anchors, the rebuild proof diffs strings. Not
 * one of them can answer the question the reveal invariant actually depends on — when this package
 * is asked to present a specific section in a specific configuration, does it submit a render and
 * SAY SO, with the identity it was asked for? That is not derivable from the bytes. It has to be
 * executed, in a real browser, once per (variant, configuration) pair, before publication.
 *
 * WHAT MAKES THIS DIFFERENT FROM e2e/viewer-e2e.spec.ts
 * The viewer suite drives the real React player and asks "does the product behave". This suite
 * drives the PROTOCOL directly against a staged package and asks "what is this package entitled to
 * claim". It deliberately does not boot the application: an application bug must not be able to
 * demote a package, and a package defect must not be able to hide behind the player's compatibility
 * behaviour.
 *
 * THE WIRE FORMAT IS NOT RETYPED HERE. Every constant the in-page driver posts is imported from
 * shared/src/sim/runtimeProtocol and handed to it as data (see WIRE below), and every message the
 * child sends is validated by the REAL `validateEnvelope` in Node. A canary that agreed with a
 * hand-copied protocol and disagreed with the shipped one would be worse than no canary.
 *
 * EVIDENCE, NOT ACKNOWLEDGEMENTS. Where an acknowledgement can be sent without the thing having
 * happened, this suite looks at the document instead: hidden controls are read out of the child's
 * computed style, posters are real screenshots whose PNG headers are parsed to prove the requested
 * size, automation is proven stopped by a counter or by pixels that stop changing, and disposal is
 * judged by the runtime's own leak report.
 *
 * INCOMPLETE PROOF IS NEVER SUCCESS. The suite FAILS — it never skips — when the fixture package is
 * absent, and a step that could not be decided is recorded as `skipped`, which blocks publication.
 *
 * TWO PACKAGES ARE CERTIFIED, because a gate that has only ever been observed saying yes has not
 * been observed working:
 *
 *   SUBJECT    (CANARY_PACKAGE, default 'v3managed')       the mixed package. It carries
 *              legacy-bodied sections, so its honest capability report declines `suspendable` and
 *              it must be classified `managed-partial` and REFUSED publication as modern.
 *   REFERENCE  (CANARY_REFERENCE_PACKAGE, default 'v3allmanaged')  only managed bodies, so its
 *              capability report can reach `managed-presentable` and it must be GRANTED.
 *
 * Both are produced by backend-api/src/scripts/gen-sim-fixture.ts and served at
 * /sim-public/__e2e/<package>/index.html. Point the canary at a real staged package with
 * CANARY_PACKAGE=<name>, and set CANARY_REFERENCE_PACKAGE= (empty) to certify only that one.
 *
 *   npx playwright test --config=playwright.canary.config.ts
 *
 * Output: e2e-results/sim-canary.json (the SUBJECT's CanaryReport),
 *         e2e-results/sim-canary-reference.json, and e2e-results/sim-canary-posters/.
 */
import { test, expect, type Browser, type Page, type Route } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { extname, join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { fixtureIsFresh } from './fixtureSources';

import {
  ACTIVATE_SECTION,
  AUTOMATION_PAUSED,
  AUTOMATION_RESUMED,
  CONTEXT_LOST,
  CONTEXT_RESTORED,
  DISPOSE_DOCUMENT,
  DISPOSED,
  DOCUMENT_READY,
  DOCUMENT_RESUMED,
  DOCUMENT_SUSPENDED,
  INIT_DOCUMENT,
  PARENT_INBOUND_TYPES,
  PAUSE_AUTOMATION,
  PREPARE_SECTION,
  PRESENT_SECTION,
  QUALITY_APPLIED,
  RESUME_AUTOMATION,
  RESUME_DOCUMENT,
  SECTION_APPLIED,
  SECTION_PRESENTED,
  SET_AUDIBLE,
  SET_QUALITY,
  SIM_BOOTSTRAP_ACCEPT_KIND,
  SIM_BOOTSTRAP_KIND,
  SIM_PROTOCOL_NAMESPACE,
  SIM_PROTOCOL_VERSION,
  SUSPEND_DOCUMENT,
  ZERO_RESOURCE_COUNTS,
  validateEnvelope,
  type DisposedPayload,
  type DocumentReadyPayload,
  type DocumentSuspendedPayload,
  type SectionPresentedPayload,
  type SimResourceCounts,
  type SimRuntimeCapabilities,
} from 'shared/src/sim/runtimeProtocol';
import {
  DEFAULT_PRESENTATION_CONFIG,
  computeConfigHash,
  derivePackageRevision,
  newActivationId,
  newDocumentId,
  newPlayerSessionId,
  type SimAspectProfile,
  type SimPresentationConfig,
  type SimQualityProfile,
} from 'shared/src/sim/simIdentity';
import { POSTER_SIZES, posterIdentityString } from 'shared/src/sim/posterIdentity';
import {
  CANARY_STEPS,
  isSignificantError,
  type CanaryCase,
  type CanaryCaseResult,
  type CanaryError,
  type CanaryReport,
  type CanaryStep,
  type CanaryStepResult,
} from 'shared/src/sim/canaryContract';
import {
  PACKAGE_CLASS_ORDER,
  SIM_CONTEXT_RESTORE_TIMEOUT_MS,
  SIM_DISPOSE_TIMEOUT_MS,
  SIM_PREPARE_TIMEOUT_MS,
  SIM_PRESENT_TIMEOUT_MS,
  SIM_SUSPEND_TIMEOUT_MS,
  classifyFromCapabilities,
  type SimPackageClass,
} from 'shared/src/sim/simFailurePolicy';
import { SIM_HELLO_KIND } from '../lib/sim/SimTransport';
// The SAME guard the publish path uses. Re-implementing it here would let the canary bless a
// package the server would refuse (or the reverse), which is the one disagreement that must not
// be possible.
import {
  assembleCanaryReport,
  describeCanaryDecision,
  judgeCanaryReport,
  mayPublishAsModern,
  type CanaryAssetResult,
} from '../../backend-api/src/services/simulation/canaryJudge';

// ─── Where the staged package lives ───────────────────────────────────────────────────────────

/**
 * The packages this canary certifies. Produced by backend-api/src/scripts/gen-sim-fixture.ts and
 * served, exactly as production serves a package, under /sim-public/ on the API origin.
 */
const SUBJECT_PACKAGE = process.env.CANARY_PACKAGE ?? 'v3managed';
/** Empty disables the reference run. See the module header for what it is for. */
const REFERENCE_PACKAGE = process.env.CANARY_REFERENCE_PACKAGE ?? 'v3allmanaged';
const API_ORIGIN = process.env.CANARY_API_URL ?? 'http://localhost:8080';
const HARNESS_URL = `${API_ORIGIN}/__canary/harness.html`;

const publicPrefix = (pkg: string): string => `/sim-public/__e2e/${pkg}`;

const FIXTURE_DIR = resolve(__dirname, '../../.sim-fixture');
const BACKEND = resolve(__dirname, '../../backend-api');
const RESULTS_DIR = resolve(__dirname, '../e2e-results');
const POSTER_ROOT = join(RESULTS_DIR, 'sim-canary-posters');
const reportPath = (role: 'subject' | 'reference'): string =>
  join(RESULTS_DIR, role === 'subject' ? 'sim-canary.json' : 'sim-canary-reference.json');

/** Identity of a staged package, as the publish pipeline would record it. */
const simulationIdFor = (pkg: string): string => `e2e-${pkg}`;
const storagePrefixFor = (pkg: string): string => `simulations/__e2e/${simulationIdFor(pkg)}`;

/**
 * Which sections to certify.
 *
 * DEFAULT: the two interchangeable healthy managed sections of the v3 fixtures. Their ids are
 * copied from FIXTURE_V3_SECTIONS in gen-sim-fixture.ts (V3A and V3B) rather than imported,
 * because that module pulls the server's SimulationService and controller graph in with it — the
 * same reason viewer-e2e.spec.ts names its fixture sections directly. A listed section that the
 * document does not report FAILS the run loudly, so fixture drift is visible immediately rather
 * than silently changing what got certified.
 *
 * The v3 fixtures deliberately also carry hostile sections (a `present()` that never acknowledges,
 * a `prepare()` that throws). Those exist to prove the PLAYER's bounded failure behaviour; a canary
 * pointed at them correctly returns `failed`, which is the right answer to a different question.
 * Set CANARY_VARIANTS= (empty) to certify every section the document reports.
 */
const DEFAULT_VARIANTS = ['33333333-a111-4a11-8a11-333333333333', '44444444-b222-4b22-8b22-444444444444'];
const VARIANT_ALLOWLIST =
  process.env.CANARY_VARIANTS === undefined
    ? DEFAULT_VARIANTS
    : process.env.CANARY_VARIANTS.split(',').map((s) => s.trim()).filter(Boolean);

/**
 * Control containers a canary knows how to look for. Minimal-UI hiding is MECHANICAL in this
 * product (a generated stylesheet over author-chosen selectors), so the canary cannot know the
 * selector without being told — it probes the loaded document for these and uses whichever
 * actually match. A selector that matches nothing would make the "controls are hidden" assertion
 * vacuously true, which is the failure mode this list exists to avoid.
 */
const CONTROL_CANDIDATES = (process.env.CANARY_CONTROL_SELECTORS ?? '.controls,#controls,.control-panel,[data-canary-controls]')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Bounds. Load and handshake get generous ones (a cold browser, a cold cache); every protocol step
// uses the SHIPPED failure bound, so the canary holds a package to the same clock the player does.
const LOAD_TIMEOUT_MS = 30_000;
const HANDSHAKE_TIMEOUT_MS = 15_000;
/** Cycles of A → B → A. The contract asks for at least three. */
const AB_CYCLES = 3;

const BASE_VIEWPORT = { width: 1280, height: 720 };

// ─── Fixture staging ──────────────────────────────────────────────────────────────────────────

function ensureFixture(packages: readonly string[]): void {
  const generator = join(BACKEND, 'src', 'scripts', 'gen-sim-fixture.ts');
  const stamps = packages.map((pkg) => join(FIXTURE_DIR, pkg, 'index.html'));
  const fresh = stamps.every((st) => fixtureIsFresh(BACKEND, st));
  if (!fresh) {
    mkdirSync(FIXTURE_DIR, { recursive: true });
    const r = spawnSync('npx', ['tsx', 'src/scripts/gen-sim-fixture.ts', FIXTURE_DIR], {
      cwd: BACKEND,
      encoding: 'utf8',
    });
    if (r.status !== 0 && !stamps.every((s) => existsSync(s))) {
      throw new Error(`sim-canary: fixture generation failed: ${r.stderr || r.stdout}`);
    }
  }
  packages.forEach((pkg, i) => {
    if (existsSync(stamps[i])) return;
    // FAIL, never skip. A canary that skips reads as a pass in every report that aggregates it,
    // and "the package was never certified" would be indistinguishable from "the package is fine".
    throw new Error(
      `sim-canary: the staged package '${pkg}' does not exist at ${stamps[i]}.\n` +
      `It is produced by ${generator} (the Priority 5.4 fixture), which must emit a package named ` +
      `'${pkg}' served at ${publicPrefix(pkg)}/index.html.\n` +
      `Generate it with:  cd backend-api && npx tsx src/scripts/gen-sim-fixture.ts ${FIXTURE_DIR}\n` +
      `This suite FAILS rather than skipping: an unrun canary must never read as a pass.`,
    );
  });
}

// ─── Local asset server ───────────────────────────────────────────────────────────────────────

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.glsl': 'text/plain; charset=utf-8',
  '.bin': 'application/octet-stream',
};

/**
 * What a served asset's content type must LOOK like.
 *
 * This is not bureaucracy: a public bucket in this product has been observed downgrading
 * `text/html` to `text/plain` (see the sim-serving notes), which loads as a blank page in an iframe
 * with no error anywhere. A canary that checked only the status code would have called that
 * package healthy.
 */
const EXPECTED_TYPE: Record<string, RegExp> = {
  '.html': /^text\/html/i,
  '.js': /(javascript|ecmascript)/i,
  '.mjs': /(javascript|ecmascript)/i,
  '.css': /^text\/css/i,
  '.json': /^application\/json/i,
  '.png': /^image\/png/i,
  '.jpg': /^image\/jpeg/i,
  '.jpeg': /^image\/jpeg/i,
  '.webp': /^image\/webp/i,
  '.avif': /^image\/avif/i,
  '.svg': /^image\/svg/i,
  '.wasm': /^application\/wasm/i,
  '.mp4': /^video\/mp4/i,
  '.m3u8': /mpegurl/i,
  '.ts': /^video\/mp2t/i,
};

const HARNESS_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>sim canary harness</title>
  <style>
    html, body { margin: 0; padding: 0; height: 100%; background: #000; overflow: hidden; }
    /* The stage is sized to the exact poster dimensions before each capture, and the frame fills
       it, so an element screenshot IS the poster at its declared size — no scaling, no cropping. */
    #stage { position: absolute; left: 0; top: 0; width: 1280px; height: 720px; overflow: hidden; background: #000; }
    #stage iframe { display: block; border: 0; width: 100%; height: 100%; }
  </style>
</head>
<body><div id="stage"></div></body>
</html>`;

let server: Server;
let localOrigin = '';

function localPathFor(pathname: string): string | null {
  if (pathname === '/__canary/harness.html') return '__harness__';
  if (pathname.startsWith('/sim-public/__e2e/')) return pathname.slice('/sim-public/__e2e/'.length);
  return null;
}

function startAssetServer(): Promise<void> {
  server = createServer((req, res) => {
    const pathname = (req.url ?? '/').split('?')[0].split('#')[0];
    if (pathname === '/__canary/harness.html') {
      const body = Buffer.from(HARNESS_HTML, 'utf-8');
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': String(body.length),
        'cache-control': 'no-cache',
      });
      res.end(body);
      return;
    }
    const file = join(FIXTURE_DIR, pathname.replace(/^\/+/, ''));
    if (!file.startsWith(FIXTURE_DIR) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    const buf = readFileSync(file);
    const type = TYPES[extname(file)] ?? 'application/octet-stream';
    // Range support: a media asset in a package will not start in WebKit without it, and an asset
    // check that never exercises the range path would miss a server that cannot serve one.
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const start = m && m[1] ? parseInt(m[1], 10) : 0;
      const end = m && m[2] ? parseInt(m[2], 10) : buf.length - 1;
      res.writeHead(206, {
        'content-type': type,
        'accept-ranges': 'bytes',
        'content-range': `bytes ${start}-${end}/${buf.length}`,
        'content-length': String(end - start + 1),
        'cache-control': 'no-cache',
      });
      res.end(buf.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, {
      'content-type': type,
      'accept-ranges': 'bytes',
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

/** Wire constants, handed to the page as DATA so nothing about the format is retyped in-browser. */
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
  // Matches SimTransport's own re-offer cadence: a child that booted before the parent attached has
  // already sent its only hello, so the offer has to repeat.
  OFFER_INTERVAL_MS: 150,
  OFFER_LIMIT: 40,
};

interface RawEntry {
  i: number;
  at: number;
  data: Record<string, unknown>;
}

interface DriverState {
  mode: string;
  raw: RawEntry[];
  v2: RawEntry[];
  sent: { at: number; type: string; seq: number }[];
  notes: string[];
}

interface ActivationIdentity {
  activationId: string;
  variantKey: string;
  configHash: string;
}

interface DocumentIdentity {
  playerSessionId: string;
  packageRevision: string;
  documentId: string;
}

interface CanaryApi {
  mount(src: string, identity: DocumentIdentity): void;
  send(type: string, payload: unknown, activation: ActivationIdentity | null): boolean;
  postV2(message: Record<string, unknown>): boolean;
  close(): void;
  state(): DriverState;
}

interface CanaryWindow extends Window {
  __canary: CanaryApi;
}

/**
 * The parent half of the v3 bootstrap, installed into the harness page.
 *
 * It is a faithful re-expression of lib/sim/SimTransport (offer a fresh MessageChannel per attempt,
 * address the child's EXACT origin, adopt whichever channel the child answers on, close the losers)
 * rather than an import of it, because the canary must be able to certify a package independently
 * of the client's own transport code — a bug in SimTransport must not be able to launder a broken
 * package through the gate, and vice versa.
 *
 * It records and validates NOTHING beyond shape: every inbound message is stored raw and judged in
 * Node by the real `validateEnvelope`, so the canary's idea of a legal message is the shipped one.
 */
function installCanaryDriver(K: WireConstants): void {
  // The init script runs in EVERY frame, including the simulation's. A second driver there would
  // add a competing window listener to the document that is trying to adopt a port.
  if (window.parent !== window) return;

  const raw: RawEntry[] = [];
  const v2: RawEntry[] = [];
  const sent: { at: number; type: string; seq: number }[] = [];
  const notes: string[] = [];

  let mode = 'idle';
  let identity: DocumentIdentity | null = null;
  let targetOrigin = '';
  let outSeq = 0;
  let frame: HTMLIFrameElement | null = null;
  let port: MessagePort | null = null;
  let pending: MessageChannel[] = [];
  let timer = 0;

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
      raw.push({ i: raw.length, at: Date.now(), data: ev.data as Record<string, unknown> });
    };
    mode = 'modern';
    notes.push('adopted');
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
      notes.push('bad-accept');
      return;
    }
    adopt(ch);
  }

  function offer(): void {
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
    const data = e.data as { kind?: unknown; type?: unknown; protocolVersion?: unknown } | null;
    if (!data || typeof data !== 'object') return;
    if (data.kind === K.HELLO && data.protocolVersion === K.VER) {
      notes.push('hello');
      offer();
      return;
    }
    // Everything else on the window belongs to the v2 protocol. It is recorded so a package that
    // cannot speak v3 can still be classified honestly instead of being called broken.
    if (typeof data.type === 'string') {
      v2.push({ i: v2.length, at: Date.now(), data: data as Record<string, unknown> });
    }
  });

  const api: CanaryApi = {
    mount(src: string, ident: DocumentIdentity): void {
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
      v2.length = 0;
      sent.length = 0;
      notes.length = 0;
      outSeq = 0;
      identity = ident;
      targetOrigin = new URL(src, window.location.href).origin;

      const stage = document.getElementById('stage');
      if (!stage) throw new Error('canary harness has no #stage');
      while (stage.firstChild) stage.removeChild(stage.firstChild);
      const f = document.createElement('iframe');
      f.id = 'sim';
      f.title = 'sim canary';
      f.setAttribute('allow', 'autoplay; xr-spatial-tracking');
      f.style.cssText = 'display:block;border:0;width:100%;height:100%;background:transparent';
      // No `sandbox` attribute: a sandboxed frame without allow-same-origin has an OPAQUE origin,
      // there is no exact origin to address the port offer to, and the package would be forced to
      // legacy for a reason that has nothing to do with the package.
      f.src = src;
      stage.appendChild(f);
      frame = f;

      mode = 'offering';
      offer();
      timer = window.setInterval(offer, K.OFFER_INTERVAL_MS);
    },

    send(type: string, payload: unknown, activation: ActivationIdentity | null): boolean {
      if (mode !== 'modern' || !port || !identity) return false;
      const env: Record<string, unknown> = {
        namespace: K.NS,
        protocolVersion: K.VER,
        type,
        playerSessionId: identity.playerSessionId,
        packageRevision: identity.packageRevision,
        documentId: identity.documentId,
        seq: ++outSeq,
        payload: payload ?? {},
      };
      if (activation) {
        env.activationId = activation.activationId;
        env.variantKey = activation.variantKey;
        env.configHash = activation.configHash;
      }
      try {
        port.postMessage(env);
        sent.push({ at: Date.now(), type, seq: outSeq });
        return true;
      } catch {
        return false;
      }
    },

    postV2(message: Record<string, unknown>): boolean {
      const win = frame?.contentWindow;
      if (!win) return false;
      try {
        win.postMessage(message, targetOrigin);
        return true;
      } catch {
        return false;
      }
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

    state(): DriverState {
      return { mode, raw, v2, sent, notes };
    },
  };

  (window as unknown as CanaryWindow).__canary = api;
}

// ─── Node-side driver helpers ─────────────────────────────────────────────────────────────────

class NotApplicable extends Error {}

interface EnvelopeMatch {
  type: string;
  activationId?: string;
  variantKey?: string;
  configHash?: string;
  /** Only consider entries recorded AFTER this index. -1 considers everything. */
  after?: number;
}

const driverState = (page: Page): Promise<DriverState> =>
  page.evaluate(() => (window as unknown as CanaryWindow).__canary.state());

/** Index of the last inbound message so far — the cursor a later wait is anchored to. */
const mark = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as CanaryWindow).__canary.state().raw.length - 1);

async function waitForEnvelope(page: Page, m: EnvelopeMatch, timeout: number, what: string): Promise<Record<string, unknown>> {
  try {
    const handle = await page.waitForFunction(
      (match) => {
        const api = (window as unknown as CanaryWindow).__canary;
        if (!api) return null;
        for (const r of api.state().raw) {
          if (match.after !== undefined && r.i <= match.after) continue;
          const e = r.data;
          if (!e || typeof e !== 'object') continue;
          if (e.type !== match.type) continue;
          if (match.activationId !== undefined && e.activationId !== match.activationId) continue;
          if (match.variantKey !== undefined && e.variantKey !== match.variantKey) continue;
          if (match.configHash !== undefined && e.configHash !== match.configHash) continue;
          return e;
        }
        return null;
      },
      m,
      { timeout, polling: 40 },
    );
    return (await handle.jsonValue()) as Record<string, unknown>;
  } catch {
    throw new Error(
      `${what}: no ${m.type} matching ${JSON.stringify({ ...m, after: undefined })} arrived within ${timeout}ms`,
    );
  }
}

async function send(page: Page, type: string, payload: unknown, activation: ActivationIdentity | null): Promise<void> {
  const ok = await page.evaluate(
    (args) => (window as unknown as CanaryWindow).__canary.send(args.type, args.payload, args.activation),
    { type, payload, activation },
  );
  if (!ok) throw new Error(`could not send ${type} — no modern transport is open`);
}

/** Two animation frames: enough for a style change or a resize to have landed and painted. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((r) => {
        requestAnimationFrame(() => requestAnimationFrame(() => r()));
      }),
  );
}

// ─── Evidence read out of the child document ──────────────────────────────────────────────────

interface ControlEvidence {
  readable: boolean;
  matched: number;
  hidden: number;
  visible: number;
  styleTagPresent: boolean;
}

async function readControls(page: Page, selectors: string[]): Promise<ControlEvidence> {
  return page.evaluate((sels) => {
    const out: ControlEvidence = { readable: false, matched: 0, hidden: 0, visible: 0, styleTagPresent: false };
    const f = document.querySelector('#stage iframe') as HTMLIFrameElement | null;
    let doc: Document | null = null;
    try {
      doc = f?.contentDocument ?? null;
    } catch {
      doc = null;
    }
    if (!doc) return out;
    out.readable = true;
    out.styleTagPresent = !!doc.getElementById('__simHideUi');
    const win = doc.defaultView;
    for (const sel of sels) {
      let nodes: Element[] = [];
      try {
        nodes = Array.from(doc.querySelectorAll(sel));
      } catch {
        continue;
      }
      for (const n of nodes) {
        out.matched++;
        const cs = win ? win.getComputedStyle(n) : null;
        const rect = n.getBoundingClientRect();
        // Deliberately NOT `offsetParent === null`: that is null for every `position: fixed`
        // element, visible or not — and a control overlay pinned over the scene is exactly the
        // shape Minimal UI exists to hide, so that test would report every Full-UI control as
        // hidden and the mirror assertion below would fail on a healthy package.
        const invisible =
          !cs ||
          cs.display === 'none' ||
          cs.visibility === 'hidden' ||
          Number(cs.opacity) === 0 ||
          rect.width === 0 ||
          rect.height === 0;
        if (invisible) out.hidden++;
        else out.visible++;
      }
    }
    return out;
  }, selectors);
}

interface AudibleEvidence {
  readable: boolean;
  media: { muted: boolean; volume: number }[];
  marker: { muted: boolean; volume: number } | null;
}

async function readAudible(page: Page): Promise<AudibleEvidence> {
  return page.evaluate(() => {
    const out: AudibleEvidence = { readable: false, media: [], marker: null };
    const f = document.querySelector('#stage iframe') as HTMLIFrameElement | null;
    let doc: Document | null = null;
    try {
      doc = f?.contentDocument ?? null;
    } catch {
      doc = null;
    }
    if (!doc) return out;
    out.readable = true;
    for (const el of Array.from(doc.querySelectorAll('video,audio')) as HTMLMediaElement[]) {
      out.media.push({ muted: el.muted, volume: el.volume });
    }
    try {
      const w = f?.contentWindow as
        | (Window & {
            __CANARY_AUDIBLE?: { muted: boolean; volume: number };
            __V3_STATE__?: Record<string, { audible?: { muted: boolean; volume: number } | null }>;
          })
        | null;
      if (w?.__CANARY_AUDIBLE) {
        out.marker = w.__CANARY_AUDIBLE;
      } else if (w?.__V3_STATE__) {
        // The generated managed section records what `setAudible` handed it. That is a stronger
        // reading than a media element's `muted` flag: it says the SECTION was told, not merely
        // that some element in the document happens to be silent.
        for (const entry of Object.values(w.__V3_STATE__)) {
          if (entry?.audible) out.marker = entry.audible;
        }
      }
    } catch {
      out.marker = null;
    }
    return out;
  });
}

/**
 * The section's own automation counter, when it publishes one.
 *
 * Three shapes are accepted, in order: `window.__CANARY_TICKS` (a bare number), a
 * `[data-canary-ticks]` attribute, and `window.__V3_STATE__[section].ticks` — the shape the
 * generated managed sections already expose, whose counter is incremented by the interval that is
 * REGISTERED AS AUTOMATION and is therefore exactly the thing `pauseAuto` is allowed to stop.
 *
 * Without any of them the canary falls back to pixels, which is weaker: a scene may legitimately
 * keep animating after `pauseAuto`, because that call stops the SECTION's automation and not the
 * engine's own loop.
 */
async function readTicks(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const f = document.querySelector('#stage iframe') as HTMLIFrameElement | null;
    try {
      const w = f?.contentWindow as
        | (Window & { __CANARY_TICKS?: number; __V3_STATE__?: Record<string, { ticks?: number }> })
        | null;
      if (w && typeof w.__CANARY_TICKS === 'number') return w.__CANARY_TICKS;
      const el = f?.contentDocument?.querySelector('[data-canary-ticks]') ?? null;
      const raw = el?.getAttribute('data-canary-ticks');
      if (raw !== null && raw !== undefined) {
        const n = Number(raw);
        return Number.isFinite(n) ? n : null;
      }
      if (w?.__V3_STATE__) {
        let total: number | null = null;
        for (const entry of Object.values(w.__V3_STATE__)) {
          if (typeof entry?.ticks === 'number') total = (total ?? 0) + entry.ticks;
        }
        return total;
      }
      return null;
    } catch {
      return null;
    }
  });
}

async function frameShot(page: Page): Promise<Buffer> {
  const el = await page.locator('#stage iframe').elementHandle();
  if (!el) throw new Error('the simulation frame is not present');
  return el.screenshot({ type: 'png' });
}

const digest = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

/** True when the frame's pixels changed over the window — i.e. something is animating. */
async function movedOver(page: Page, ms: number): Promise<boolean> {
  const before = digest(await frameShot(page));
  await page.waitForTimeout(ms);
  return digest(await frameShot(page)) !== before;
}

/** Width/height straight out of the PNG IHDR chunk. Proves the capture really is the asked size. */
function pngSize(buf: Buffer): { width: number; height: number } {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) {
    throw new Error('poster is not a PNG');
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// ─── Step bookkeeping ─────────────────────────────────────────────────────────────────────────

class CaseSteps {
  private readonly decided = new Map<CanaryStep, CanaryStepResult>();

  /**
   * Run one step. A thrown `NotApplicable` records `not-applicable` (a decision); anything else
   * records `fail` with the message. A step that is never run stays `skipped`, which is undecided
   * and blocks publication — the canary never converts "did not get there" into "fine".
   */
  async run(step: CanaryStep, fn: () => Promise<string | void>): Promise<boolean> {
    const t0 = Date.now();
    try {
      const detail = await fn();
      const result: CanaryStepResult = { step, status: 'pass', ms: Date.now() - t0 };
      if (typeof detail === 'string' && detail.length > 0) result.detail = detail;
      this.decided.set(step, result);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.decided.set(step, {
        step,
        status: err instanceof NotApplicable ? 'not-applicable' : 'fail',
        ms: Date.now() - t0,
        detail: message,
      });
      return err instanceof NotApplicable;
    }
  }

  set(step: CanaryStep, status: CanaryStepResult['status'], detail: string): void {
    this.decided.set(step, { step, status, detail });
  }

  results(): CanaryStepResult[] {
    return CANARY_STEPS.map((step) => this.decided.get(step) ?? { step, status: 'skipped' as const });
  }
}

// ─── The run ──────────────────────────────────────────────────────────────────────────────────

interface RunState {
  page: Page;
  pkg: string;
  playerSessionId: string;
  packageRevision: string;
  variants: string[];
  hideSelectors: string[];
  errors: CanaryError[];
  external: string[];
  observedAssets: Set<string>;
  posterHashes: Map<string, string>;
  assetResults: CanaryAssetResult[];
}

const entryUrl = (pkg: string, variant: string): string =>
  `${API_ORIGIN}${publicPrefix(pkg)}/index.html?section=${encodeURIComponent(variant)}&v=1`;

/**
 * Bring one document up and complete the handshake. Shared by the discovery pass and every case,
 * so the two can never disagree about what "up" means.
 */
async function bootDocument(
  state: RunState,
  variantKey: string,
  quality: SimQualityProfile,
): Promise<{ documentId: string; capabilities: SimRuntimeCapabilities | null; variants: string[] }> {
  const documentId = newDocumentId();
  await state.page.evaluate(
    (args) => (window as unknown as CanaryWindow).__canary.mount(args.src, args.identity),
    {
      src: entryUrl(state.pkg, variantKey),
      identity: {
        playerSessionId: state.playerSessionId,
        packageRevision: state.packageRevision,
        documentId,
      },
    },
  );
  await state.page.waitForFunction(
    () => {
      const f = document.querySelector('#stage iframe') as HTMLIFrameElement | null;
      if (!f) return false;
      try {
        return f.contentDocument ? f.contentDocument.readyState === 'complete' : true;
      } catch {
        // Cross-origin document: its readiness is unreadable, and its existence is all we get.
        return true;
      }
    },
    undefined,
    { timeout: LOAD_TIMEOUT_MS },
  );

  await state.page
    .waitForFunction(() => (window as unknown as CanaryWindow).__canary.state().mode === 'modern', undefined, {
      timeout: HANDSHAKE_TIMEOUT_MS,
    })
    .catch(() => {
      /* legacy package: reported by the caller, not thrown here */
    });

  const mode = (await driverState(state.page)).mode;
  if (mode !== 'modern') return { documentId, capabilities: null, variants: [] };

  const cursor = await mark(state.page);
  await send(
    state.page,
    INIT_DOCUMENT,
    {
      parentOrigin: API_ORIGIN,
      quality,
      // A document is born hidden and silent; the canary lifts audio explicitly in its own step.
      audible: { muted: true, volume: 0 },
    },
    null,
  );
  const ready = await waitForEnvelope(state.page, { type: DOCUMENT_READY, after: cursor }, HANDSHAKE_TIMEOUT_MS, 'handshake');
  const payload = ready.payload as DocumentReadyPayload;
  return {
    documentId,
    capabilities: payload?.capabilities ?? null,
    variants: Array.isArray(payload?.variants) ? payload.variants : [],
  };
}

/** Every protocol rejection the REAL validator finds in a document's inbound stream. */
function protocolErrors(raw: RawEntry[], identity: DocumentIdentity): CanaryError[] {
  const errors: CanaryError[] = [];
  let lastSeq = 0;
  for (const entry of raw) {
    const result = validateEnvelope(entry.data, {
      playerSessionId: identity.playerSessionId,
      documentId: identity.documentId,
      lastSeq,
      allowedTypes: PARENT_INBOUND_TYPES,
    });
    if (result.ok) {
      lastSeq = result.envelope.seq;
      continue;
    }
    const type = typeof entry.data?.type === 'string' ? entry.data.type : '(no type)';
    errors.push({
      source: 'protocol',
      message: `${result.reason}${result.detail ? `: ${result.detail}` : ''} (on ${type})`,
    });
  }
  return errors;
}

async function runCase(state: RunState, c: CanaryCase): Promise<CanaryCaseResult> {
  const page = state.page;
  const steps = new CaseSteps();
  const errorsAt = state.errors.length;
  const configHash = computeConfigHash(c.config);

  let capabilities: SimRuntimeCapabilities | null = null;
  let countsAfterDispose: SimResourceCounts | null = null;
  let leaked: string[] = [];
  let posterIdentity: string | null = null;
  let identity: DocumentIdentity = {
    playerSessionId: state.playerSessionId,
    packageRevision: state.packageRevision,
    documentId: '',
  };
  let current: ActivationIdentity = { activationId: newActivationId(), variantKey: c.variantKey, configHash };
  let modern = false;

  /** Prepare + present one activation and require its OWN acknowledgement. */
  const presentActivation = async (activation: ActivationIdentity, what: string): Promise<SectionPresentedPayload> => {
    const cursor = await mark(page);
    await send(page, PREPARE_SECTION, { variantKey: activation.variantKey, config: c.config }, activation);
    await waitForEnvelope(
      page,
      {
        type: SECTION_APPLIED,
        activationId: activation.activationId,
        variantKey: activation.variantKey,
        configHash: activation.configHash,
        after: cursor,
      },
      SIM_PREPARE_TIMEOUT_MS,
      what,
    );
    await send(page, PRESENT_SECTION, {}, activation);
    const presented = await waitForEnvelope(
      page,
      {
        type: SECTION_PRESENTED,
        activationId: activation.activationId,
        variantKey: activation.variantKey,
        configHash: activation.configHash,
        after: cursor,
      },
      SIM_PRESENT_TIMEOUT_MS,
      what,
    );
    const payload = presented.payload as SectionPresentedPayload;
    if (!(payload?.framesSubmitted >= 1)) {
      throw new Error(`${what}: SECTION_PRESENTED claimed ${payload?.framesSubmitted} frames — a presentation is at least one`);
    }
    return payload;
  };

  /**
   * Assemble the case result, folding in the protocol verdict.
   *
   * The rejections are computed by the SHIPPED `validateEnvelope` over this document's whole
   * inbound stream, against the identity the canary actually bound — so a message the player would
   * have refused counts against the package here, and a stale-document message cannot be laundered
   * by judging it against whatever documentId happened to arrive last.
   */
  const finish = async (): Promise<CanaryCaseResult> => {
    const stream = (await driverState(page)).raw;
    return {
      case: c,
      steps: steps.results(),
      capabilities,
      errors: [...state.errors.slice(errorsAt), ...protocolErrors(stream, identity)],
      countsAfterDispose,
      leaked,
      posterIdentity,
    };
  };

  // ── 1. load + 2. handshake ──────────────────────────────────────────────────────────────
  const loaded = await steps.run('load', async () => {
    const boot = await bootDocument(state, c.variantKey, c.qualityProfile);
    identity = { ...identity, documentId: boot.documentId };
    capabilities = boot.capabilities;
    modern = boot.capabilities !== null;
    if (boot.variants.length > 0) state.variants = boot.variants;
    return `document ${boot.documentId}`;
  });
  if (!loaded) return finish();

  await steps.run('handshake', async () => {
    if (!modern) {
      throw new Error(
        'the document never adopted a v3 port — it is a legacy package and cannot claim the modern guarantees',
      );
    }
    const caps = capabilities;
    if (!caps) throw new Error('DOCUMENT_READY carried no capability report');
    const missing = (Object.keys(caps) as (keyof SimRuntimeCapabilities)[]).filter((k) => !caps[k]);
    if (missing.length > 0) return `capabilities NOT claimed: ${missing.join(', ')}`;
    return 'all capabilities claimed';
  });

  // ── 3-6. prepare → applied → present → presented ────────────────────────────────────────
  if (modern) {
    let prepareCursor = -1;
    const prepared = await steps.run('prepare', async () => {
      prepareCursor = await mark(page);
      await send(page, PREPARE_SECTION, { variantKey: c.variantKey, config: c.config }, current);
      return `activation ${current.activationId}`;
    });

    const applied = prepared
      ? await steps.run('section-applied', async () => {
          const env = await waitForEnvelope(
            page,
            {
              type: SECTION_APPLIED,
              activationId: current.activationId,
              variantKey: c.variantKey,
              configHash,
              after: prepareCursor,
            },
            SIM_PREPARE_TIMEOUT_MS,
            'prepare',
          );
          if (env.documentId !== identity.documentId) {
            throw new Error(`SECTION_APPLIED carried documentId ${String(env.documentId)}, expected ${identity.documentId}`);
          }
          if (env.packageRevision !== identity.packageRevision) {
            throw new Error(`SECTION_APPLIED carried packageRevision ${String(env.packageRevision)}`);
          }
          return 'identity echoed exactly';
        })
      : false;

    const presentSent = applied
      ? await steps.run('present', async () => {
          await send(page, PRESENT_SECTION, {}, current);
          return '';
        })
      : false;

    const presented = presentSent
      ? await steps.run('section-presented', async () => {
          const env = await waitForEnvelope(
            page,
            {
              type: SECTION_PRESENTED,
              activationId: current.activationId,
              variantKey: c.variantKey,
              configHash,
              after: prepareCursor,
            },
            SIM_PRESENT_TIMEOUT_MS,
            'present',
          );
          const payload = env.payload as SectionPresentedPayload;
          if (!(payload?.framesSubmitted >= 1)) {
            throw new Error(`framesSubmitted was ${String(payload?.framesSubmitted)} — a presentation is at least one frame`);
          }
          const canvas = payload.canvas ? `${payload.canvas.width}x${payload.canvas.height}` : 'no canvas';
          return `frames=${payload.framesSubmitted}, canvas=${canvas}`;
        })
      : false;

    if (!presented) {
      // Nothing below can mean anything without a proven presentation: they would all be
      // measuring an unpresented document.
      return finish();
    }
  } else {
    // ── v2 compatibility path ──────────────────────────────────────────────────────────────
    // A legacy package cannot be held to promises it never made, but it CAN be observed applying
    // and painting — which is exactly the difference between legacy-cooperative and legacy-opaque.
    const token = Date.now() % 100000;
    await steps.run('prepare', async () => {
      const posted = await page.evaluate(
        (args) =>
          (window as unknown as CanaryWindow).__canary.postV2({
            type: 'startScript',
            script: args.script,
            params: { simpleUi: args.simpleUi, autoScript: args.autoScript, hideSelectors: args.hide },
            token: args.token,
          }),
        { script: c.variantKey, simpleUi: c.config.simpleUi, autoScript: c.config.autoScript, hide: c.config.hideSelectors, token },
      );
      if (!posted) throw new Error('could not post a v2 startScript — the frame is gone');
      return 'v2 startScript posted';
    });
    await steps.run('section-applied', async () => {
      await page
        .waitForFunction(
          (t) =>
            (window as unknown as CanaryWindow).__canary
              .state()
              .v2.some((r) => r.data.type === 'SCRIPT_APPLIED' && r.data.token === t),
          token,
          { timeout: SIM_PREPARE_TIMEOUT_MS, polling: 40 },
        )
        .catch(() => {
          throw new Error('no v2 SCRIPT_APPLIED for the requested token');
        });
      return 'v2 acknowledged the apply';
    });
    await steps.run('present', async () => 'v2 has no explicit present — the apply IS the present');
    await steps.run('section-presented', async () => {
      await page
        .waitForFunction(
          () => (window as unknown as CanaryWindow).__canary.state().v2.some((r) => r.data.type === 'SIM_PAINTED'),
          undefined,
          { timeout: SIM_PRESENT_TIMEOUT_MS, polling: 40 },
        )
        .catch(() => {
          throw new Error('the document never reported a paint — it cannot prove any presentation');
        });
      return 'v2 paint acknowledgement observed';
    });
    // Everything below is a v3 guarantee. A v2 document genuinely cannot offer it, and saying so
    // is the honest report — the legacy classification does not depend on these.
    for (const step of ['pause-automation', 'suspend-resume', 'audio-state', 'dispose-counters', 'context-loss'] as CanaryStep[]) {
      steps.set(step, 'not-applicable', 'legacy (v2) document: the v3 lifecycle is not available');
    }
  }

  // ── 7. posters ───────────────────────────────────────────────────────────────────────────
  await steps.run('poster-captured', async () => {
    const key = {
      packageRevision: state.packageRevision,
      variantKey: c.variantKey,
      configHash,
      aspectProfile: c.aspectProfile,
      qualityProfile: c.qualityProfile,
    };
    posterIdentity = posterIdentityString(key);
    const dir = join(POSTER_ROOT, posterIdentity);
    mkdirSync(dir, { recursive: true });
    const captured: string[] = [];
    for (const size of POSTER_SIZES[c.aspectProfile]) {
      // The viewport is set to the poster size so the frame fits without scrolling: an element
      // screenshot of something taller than the viewport is stitched, and a stitched capture of a
      // live simulation is two different moments glued together.
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.evaluate(
        (s) => {
          const stage = document.getElementById('stage');
          if (stage) {
            stage.style.width = `${s.width}px`;
            stage.style.height = `${s.height}px`;
          }
        },
        size,
      );
      await settle(page);
      const buf = await frameShot(page);
      const dims = pngSize(buf);
      if (dims.width !== size.width || dims.height !== size.height) {
        throw new Error(
          `poster '${size.name}' captured at ${dims.width}x${dims.height}, expected ${size.width}x${size.height}`,
        );
      }
      writeFileSync(join(dir, `${size.name}.png`), buf);
      state.posterHashes.set(`${c.variantKey}|${configHash}|${size.name}`, digest(buf));
      captured.push(`${size.name} ${size.width}x${size.height}`);
    }
    await page.setViewportSize(BASE_VIEWPORT);
    await page.evaluate((s) => {
      const stage = document.getElementById('stage');
      if (stage) {
        stage.style.width = `${s.width}px`;
        stage.style.height = `${s.height}px`;
      }
    }, BASE_VIEWPORT);
    await settle(page);
    return captured.join(', ');
  });

  // ── 8. controls / UI state ───────────────────────────────────────────────────────────────
  await steps.run('controls-verified', async () => {
    if (state.hideSelectors.length === 0) {
      throw new NotApplicable('the package exposes no control container this canary knows how to look for');
    }
    const evidence = await readControls(page, state.hideSelectors);
    if (!evidence.readable) {
      throw new NotApplicable('the child document is cross-origin — its UI state cannot be read');
    }
    if (evidence.matched === 0) {
      throw new Error(
        `none of ${state.hideSelectors.join(', ')} matched anything in the presented document — ` +
        'the Minimal-UI assertion would be vacuously true',
      );
    }
    if (c.config.simpleUi) {
      if (evidence.visible > 0) {
        throw new Error(
          `Minimal UI is on and ${evidence.visible}/${evidence.matched} control element(s) are still visible`,
        );
      }
      if (!evidence.styleTagPresent) {
        throw new Error('Minimal UI is on but the runtime installed no hide-UI stylesheet');
      }
      return `${evidence.hidden}/${evidence.matched} control element(s) hidden`;
    }
    // The mirror assertion. Without it "hidden" could simply mean the package never shows controls,
    // and the Minimal-UI case above would prove nothing about the configuration.
    if (evidence.visible === 0) {
      throw new Error(
        `Minimal UI is OFF but all ${evidence.matched} control element(s) are hidden anyway — ` +
        'the hidden state is not caused by the configuration',
      );
    }
    return `${evidence.visible}/${evidence.matched} control element(s) visible with Full UI`;
  });

  if (!modern) {
    // The remaining steps are v3-only and were already decided above.
    steps.set('ab-cycles', 'not-applicable', 'legacy (v2) document: activations are not identified');
    return finish();
  }

  // ── 9. A → B → A ─────────────────────────────────────────────────────────────────────────
  await steps.run('ab-cycles', async () => {
    const other = state.variants.find((v) => v !== c.variantKey);
    if (!other) {
      throw new Error(
        `the package reports only one variant (${state.variants.join(', ') || 'none'}) — ` +
        'A → B → A cannot be exercised, so the re-entry invariant is unproven',
      );
    }
    const seen = new Set<string>();
    for (let cycle = 0; cycle < AB_CYCLES; cycle++) {
      for (const variant of [c.variantKey, other, c.variantKey]) {
        const activation: ActivationIdentity = { activationId: newActivationId(), variantKey: variant, configHash };
        await presentActivation(activation, `A→B→A cycle ${cycle + 1} (${variant})`);
        if (seen.has(activation.activationId)) {
          throw new Error(`activation id ${activation.activationId} was reused — ids must be unique per entry`);
        }
        seen.add(activation.activationId);
        current = activation;
      }
    }
    // Every activation must have got its OWN acknowledgement. Counting the acknowledgements and
    // comparing to the activations is what makes "one ack answered two activations" detectable.
    const raw = (await driverState(page)).raw;
    const acked = new Set(
      raw
        .filter((r) => r.data.type === SECTION_PRESENTED && typeof r.data.activationId === 'string')
        .map((r) => r.data.activationId as string),
    );
    const missing = [...seen].filter((id) => !acked.has(id));
    if (missing.length > 0) {
      throw new Error(`${missing.length} of ${seen.size} activations never got their own SECTION_PRESENTED`);
    }
    return `${seen.size} activations, each acknowledged by id`;
  });

  // ── 10. automation ───────────────────────────────────────────────────────────────────────
  await steps.run('pause-automation', async () => {
    await send(page, ACTIVATE_SECTION, {}, current);
    const ticksBefore = await readTicks(page);
    let movingBefore = false;
    if (ticksBefore === null) {
      movingBefore = await movedOver(page, 400);
    } else {
      await page.waitForTimeout(400);
      const after = await readTicks(page);
      movingBefore = (after ?? 0) > ticksBefore;
    }

    let cursor = await mark(page);
    await send(page, PAUSE_AUTOMATION, {}, current);
    await waitForEnvelope(
      page,
      { type: AUTOMATION_PAUSED, activationId: current.activationId, after: cursor },
      SIM_PRESENT_TIMEOUT_MS,
      'pause automation',
    );

    let evidence: string;
    if (!movingBefore) {
      // Honest, not a pass by default: the acknowledgement is real, there was simply nothing
      // observable to stop. Recorded so a reader can see the difference.
      evidence = 'acknowledged; no observable automation was running to stop';
    } else if (ticksBefore === null) {
      const stillMoving = await movedOver(page, 500);
      if (stillMoving) {
        throw new Error('the frame kept changing after AUTOMATION_PAUSED — automation did not stop');
      }
      evidence = 'acknowledged; the frame stopped changing';
    } else {
      const a = await readTicks(page);
      await page.waitForTimeout(500);
      const b = await readTicks(page);
      if (a === null || b === null || b !== a) {
        throw new Error(`the automation counter advanced from ${String(a)} to ${String(b)} after AUTOMATION_PAUSED`);
      }
      evidence = `acknowledged; the automation counter held at ${a}`;
    }

    cursor = await mark(page);
    await send(page, RESUME_AUTOMATION, {}, current);
    await waitForEnvelope(
      page,
      { type: AUTOMATION_RESUMED, activationId: current.activationId, after: cursor },
      SIM_PRESENT_TIMEOUT_MS,
      'resume automation',
    );
    if (movingBefore && ticksBefore !== null) {
      const a = await readTicks(page);
      await page.waitForTimeout(500);
      const b = await readTicks(page);
      if (a === null || b === null || b <= a) {
        throw new Error('the automation counter did not resume advancing after AUTOMATION_RESUMED');
      }
    }
    return evidence;
  });

  // ── 11. suspend / resume ─────────────────────────────────────────────────────────────────
  await steps.run('suspend-resume', async () => {
    let cursor = await mark(page);
    await send(page, SUSPEND_DOCUMENT, {}, null);
    const suspended = await waitForEnvelope(page, { type: DOCUMENT_SUSPENDED, after: cursor }, SIM_SUSPEND_TIMEOUT_MS, 'suspend');
    const payload = suspended.payload as DocumentSuspendedPayload;
    const counts = payload?.counts as Partial<SimResourceCounts> | undefined;
    const missingKeys = (Object.keys(ZERO_RESOURCE_COUNTS) as (keyof SimResourceCounts)[]).filter(
      (k) => typeof counts?.[k] !== 'number',
    );
    if (missingKeys.length > 0) {
      throw new Error(`DOCUMENT_SUSPENDED reported no count for: ${missingKeys.join(', ')}`);
    }
    if (Array.isArray(payload.unstoppable) && payload.unstoppable.length > 0) {
      throw new Error(`the document could not stop: ${payload.unstoppable.join(', ')}`);
    }

    cursor = await mark(page);
    await send(page, RESUME_DOCUMENT, {}, null);
    await waitForEnvelope(page, { type: DOCUMENT_RESUMED, after: cursor }, SIM_SUSPEND_TIMEOUT_MS, 'resume');

    // A resume that does not restore a WORKING document is not a resume. Proving it by presenting a
    // fresh activation is the only check that cannot be satisfied by an acknowledgement alone.
    const revived: ActivationIdentity = { activationId: newActivationId(), variantKey: c.variantKey, configHash };
    await presentActivation(revived, 'post-resume presentation');
    current = revived;

    const live = (Object.keys(ZERO_RESOURCE_COUNTS) as (keyof SimResourceCounts)[])
      .filter((k) => (counts?.[k] ?? 0) > 0)
      .map((k) => `${k}=${counts?.[k]}`);
    return `quiescent with ${live.length > 0 ? live.join(', ') : 'no live resources'}; presented again after resume`;
  });

  // ── 12. audio + quality ──────────────────────────────────────────────────────────────────
  await steps.run('audio-state', async () => {
    await send(page, SET_AUDIBLE, { muted: false, volume: 0.5 }, null);
    await settle(page);
    const loud = await readAudible(page);
    await send(page, SET_AUDIBLE, { muted: true, volume: 0 }, null);
    await settle(page);
    const quiet = await readAudible(page);

    const observable = loud.media.length > 0 || loud.marker !== null;
    if (observable) {
      const loudOk = loud.marker
        ? loud.marker.muted === false && Math.abs(loud.marker.volume - 0.5) < 1e-6
        : loud.media.every((m) => !m.muted && Math.abs(m.volume - 0.5) < 1e-6);
      const quietOk = quiet.marker
        ? quiet.marker.muted === true
        : quiet.media.every((m) => m.muted && m.volume === 0);
      if (!loudOk) throw new Error('SET_AUDIBLE{muted:false,volume:0.5} did not reach the document');
      if (!quietOk) throw new Error('SET_AUDIBLE{muted:true} did not reach the document');
    }

    // Liveness after the audio commands. SET_AUDIBLE has no acknowledgement by design, so without
    // this a wedged document would look identical to a silent one.
    const cursor = await mark(page);
    await send(page, SET_QUALITY, { profile: c.qualityProfile }, null);
    const applied = await waitForEnvelope(page, { type: QUALITY_APPLIED, after: cursor }, SIM_PRESENT_TIMEOUT_MS, 'quality');
    const qp = applied.payload as { profile?: string; outcome?: string };
    if (qp?.profile !== c.qualityProfile) {
      throw new Error(`QUALITY_APPLIED echoed profile '${String(qp?.profile)}', expected '${c.qualityProfile}'`);
    }
    return observable
      ? `audio state observed on the document; quality outcome '${String(qp?.outcome)}'`
      : `no audio surface to observe; document answered SET_QUALITY with '${String(qp?.outcome)}'`;
  });

  // ── 13. WebGL context loss ───────────────────────────────────────────────────────────────
  await steps.run('context-loss', async () => {
    const lossCursor = await mark(page);
    const attempt = await page.evaluate(() => {
      const f = document.querySelector('#stage iframe') as HTMLIFrameElement | null;
      let doc: Document | null = null;
      try {
        doc = f?.contentDocument ?? null;
      } catch {
        doc = null;
      }
      if (!doc) return { ok: false, why: 'the child document is cross-origin', created: false };
      const canvases = Array.from(doc.querySelectorAll('canvas')) as HTMLCanvasElement[];
      if (canvases.length === 0) return { ok: false, why: 'the document has no canvas', created: false };
      for (const cv of canvases) {
        let gl: WebGLRenderingContext | null = null;
        let created = false;
        try {
          // getContext returns the EXISTING context when one of that type is already bound, and
          // creates one otherwise. A canvas already carrying a 2d context returns null, which is
          // why a null result is skipped rather than treated as a failure.
          const before = (cv as HTMLCanvasElement & { __canaryHadGl?: boolean }).__canaryHadGl;
          gl = (cv.getContext('webgl2') ?? cv.getContext('webgl')) as WebGLRenderingContext | null;
          created = before === undefined;
        } catch {
          gl = null;
        }
        if (!gl) continue;
        const ext = gl.getExtension('WEBGL_lose_context');
        if (!ext) continue;
        (window as unknown as { __canaryLose?: WEBGL_lose_context }).__canaryLose = ext;
        ext.loseContext();
        return { ok: true, why: '', created };
      }
      return { ok: false, why: 'no canvas exposes WEBGL_lose_context', created: false };
    });
    if (!attempt.ok) {
      // The loss is synthetic and some environments cannot simulate it. Not a defect in the
      // package — but not a demonstration of the recovery guarantee either.
      throw new NotApplicable(`context loss could not be simulated: ${attempt.why}`);
    }
    await waitForEnvelope(page, { type: CONTEXT_LOST, after: lossCursor }, SIM_PRESENT_TIMEOUT_MS, 'context loss');
    const cursor = await mark(page);
    await page.evaluate(() => {
      (window as unknown as { __canaryLose?: WEBGL_lose_context }).__canaryLose?.restoreContext();
    });
    await waitForEnvelope(page, { type: CONTEXT_RESTORED, after: cursor }, SIM_CONTEXT_RESTORE_TIMEOUT_MS, 'context restore');
    return attempt.created
      ? 'lost and restored (the canary created the context it lost — the reporting path is proven, not the scene’s own context)'
      : 'lost and restored on the document’s own context';
  });

  // ── 14. dispose ──────────────────────────────────────────────────────────────────────────
  await steps.run('dispose-counters', async () => {
    const cursor = await mark(page);
    await send(page, DISPOSE_DOCUMENT, {}, null);
    const disposed = await waitForEnvelope(page, { type: DISPOSED, after: cursor }, SIM_DISPOSE_TIMEOUT_MS, 'dispose');
    const payload = disposed.payload as DisposedPayload;
    countsAfterDispose = (payload?.counts ?? null) as SimResourceCounts | null;
    leaked = Array.isArray(payload?.leaked) ? payload.leaked : [];
    if (leaked.length > 0) throw new Error(`still live after dispose: ${leaked.join(', ')}`);
    return 'disposed with an empty leak report';
  });

  return finish();
}

// ─── Asset checking ───────────────────────────────────────────────────────────────────────────

interface ManifestShape {
  files?: unknown;
  assets?: unknown;
}

function manifestPaths(pkg: string): string[] {
  const file = join(FIXTURE_DIR, pkg, 'manifest.json');
  if (!existsSync(file)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return [];
  }
  const collect = (value: unknown): string[] => {
    if (!Array.isArray(value)) return [];
    return value
      .map((entry) => {
        if (typeof entry === 'string') return entry;
        if (entry && typeof entry === 'object' && typeof (entry as { path?: unknown }).path === 'string') {
          return (entry as { path: string }).path;
        }
        return '';
      })
      .filter(Boolean);
  };
  if (Array.isArray(parsed)) return collect(parsed);
  const obj = parsed as ManifestShape;
  return [...collect(obj.files), ...collect(obj.assets)];
}

/**
 * Every asset the package declares OR was actually seen to fetch.
 *
 * The union matters in both directions: a manifest that lists a file the browser never asks for is
 * still a file the package will need on some other device, and a subresource the document pulls but
 * never declared is exactly the one nobody thought to copy when the package was staged.
 */
async function checkAssets(pkg: string, observed: Iterable<string>): Promise<CanaryAssetResult[]> {
  const prefix = publicPrefix(pkg);
  const rel = new Set<string>(['index.html', 'bridge.js']);
  for (const p of manifestPaths(pkg)) rel.add(p.replace(/^\.?\//, ''));
  for (const url of observed) {
    const path = new URL(url).pathname;
    if (!path.startsWith(`${prefix}/`)) continue;
    rel.add(path.slice(prefix.length + 1));
  }

  const out: CanaryAssetResult[] = [];
  for (const relPath of [...rel].sort()) {
    const publicPath = `${prefix}/${relPath}`;
    try {
      const res = await fetch(`${localOrigin}/${pkg}/${relPath}`);
      const contentType = res.headers.get('content-type');
      const expect = EXPECTED_TYPE[extname(relPath).toLowerCase()];
      const typeOk = !expect || (contentType !== null && expect.test(contentType));
      out.push({ path: publicPath, ok: res.ok && typeOk, status: res.status, contentType });
    } catch (err) {
      out.push({
        path: publicPath,
        ok: false,
        status: 0,
        contentType: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

// ─── Certification of one package ─────────────────────────────────────────────────────────────

interface Certification {
  report: CanaryReport;
  posterHashes: Map<string, string>;
  external: string[];
}

async function certify(browser: Browser, pkg: string, role: 'subject' | 'reference'): Promise<Certification> {
  const startedAt = new Date().toISOString();
  const simulationId = simulationIdFor(pkg);
  const bridgePath = join(FIXTURE_DIR, pkg, 'bridge.js');
  const bridgeHash = existsSync(bridgePath)
    ? createHash('sha256').update(readFileSync(bridgePath)).digest('hex').slice(0, 12)
    : null;
  const packageRevision = derivePackageRevision(simulationId, bridgeHash);
  const prefix = publicPrefix(pkg);

  // A fresh context per package: a shared one would carry the previous package's cache, service
  // workers and storage into a run whose whole purpose is to describe THIS package's behaviour.
  const context = await browser.newContext({ viewport: BASE_VIEWPORT });
  const page = await context.newPage();

  const errors: CanaryError[] = [];
  const external: string[] = [];
  const observedAssets = new Set<string>();

  page.on('pageerror', (e) => errors.push({ source: 'pageerror', message: String(e) }));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push({ source: 'console', message: m.text(), url: m.location().url });
  });
  page.on('requestfailed', (req) => {
    errors.push({
      source: 'network',
      message: `${req.method()} ${req.url()} failed: ${req.failure()?.errorText ?? 'unknown'}`,
      url: req.url(),
    });
  });
  // OBSERVE, never intercept, for hermeticity — a catch-all route changes loading behaviour, which
  // is exactly what a hermeticity check must not do (audited in viewer-e2e).
  page.on('request', (req) => {
    const url = req.url();
    if (url.startsWith(`${API_ORIGIN}${prefix}/`)) observedAssets.add(url.split('#')[0]);
    const allowed =
      url.startsWith(API_ORIGIN) || url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('about:');
    if (!allowed) external.push(url);
  });

  // The package is addressed exactly as production addresses it — on the API origin, under
  // /sim-public/ — and fulfilled from the local fixture server. The harness page shares that origin
  // so the canary can read the child's computed style, which is what turns "the runtime says the
  // controls are hidden" into "the controls are hidden".
  await page.route(`${API_ORIGIN}/**`, async (route: Route) => {
    const url = new URL(route.request().url());
    const local = localPathFor(url.pathname);
    if (local === null) {
      await route.fulfill({ status: 404, contentType: 'text/plain', body: 'not part of the staged package' });
      return;
    }
    const target = local === '__harness__' ? `${localOrigin}/__canary/harness.html` : `${localOrigin}/${local}${url.search}`;
    const rangeHeader = route.request().headers()['range'];
    const upstream = await fetch(target, { headers: rangeHeader ? { range: rangeHeader } : {} });
    const headers = Object.fromEntries(upstream.headers.entries());
    await route.fulfill({
      status: upstream.status,
      headers,
      body: Buffer.from(await upstream.arrayBuffer()),
    });
  });

  await page.addInitScript(installCanaryDriver, WIRE);
  await page.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' });

  const state: RunState = {
    page,
    pkg,
    playerSessionId: newPlayerSessionId(),
    packageRevision,
    variants: [],
    hideSelectors: [],
    errors,
    external,
    observedAssets,
    posterHashes: new Map(),
    assetResults: [],
  };

  let aborted: { reason: string } | null = null;
  const cases: CanaryCaseResult[] = [];

  try {
    // ── discovery ────────────────────────────────────────────────────────────────────────
    // What the package HAS decides what the canary must exercise. Reading the variant list from
    // the document (rather than from the bytes, or from a hard-coded list) is what makes the same
    // canary usable for a real customer package.
    const discovery = await bootDocument(state, VARIANT_ALLOWLIST[0] ?? 'main', 'high');
    const fallbackVariants = VARIANT_ALLOWLIST.length > 0 ? [...VARIANT_ALLOWLIST] : ['main'];
    state.variants = discovery.variants.length > 0 ? discovery.variants : fallbackVariants;
    state.hideSelectors = await probeControlSelectors(page);
    await send(page, DISPOSE_DOCUMENT, {}, null).catch(() => {
      /* a legacy document has no port; nothing to dispose */
    });

    // A v2 document has no way to report what it carries, so the allowlist is all the canary has to
    // go on and a drift check against it would be a check against itself. For a v3 document the
    // list IS reported, so a requested section that is absent means the canary would silently
    // certify something other than what it was asked to.
    const missing = discovery.capabilities === null ? [] : VARIANT_ALLOWLIST.filter((v) => !state.variants.includes(v));
    if (missing.length > 0) {
      throw new Error(
        `package '${pkg}' does not carry the section(s) this canary was asked to certify: ${missing.join(', ')}. ` +
        `It reports: ${state.variants.join(', ')}. Set CANARY_VARIANTS to the sections to certify, ` +
        'or empty to certify every section the document reports.',
      );
    }

    state.assetResults = await checkAssets(pkg, observedAssets);

    for (const c of buildCases(state.variants, state.hideSelectors)) {
      const result = await runCase(state, c);
      // Two steps can only be decided here: the asset sweep is one check for the whole package,
      // and the error verdict must include the protocol rejections the case folded in last.
      const significant = result.errors.filter(isSignificantError);
      const steps = result.steps.map((s) =>
        s.step === 'manifest-assets'
          ? assetStep(state.assetResults)
          : s.step === 'no-errors'
            ? ({
                step: 'no-errors' as const,
                status: significant.length === 0 ? ('pass' as const) : ('fail' as const),
                detail:
                  significant.length === 0
                    ? `${result.errors.length - significant.length} ignorable error(s)`
                    : significant.map((e) => `${e.source}: ${e.message}`).join(' | '),
              })
            : s,
      );
      cases.push({ ...result, steps });
    }

    // Anything a later case pulled that the first pass had not seen yet.
    state.assetResults = await checkAssets(pkg, observedAssets);
  } catch (err) {
    // An exception here means the RUN could not complete — not that the package is legacy. The
    // contract is explicit that incomplete proof is `failed`, never a downgrade.
    aborted = { reason: err instanceof Error ? err.message : String(err) };
  } finally {
    await context.close().catch(() => {
      /* the browser may already be gone */
    });
  }

  const report = assembleCanaryReport(
    {
      packageRevision,
      simulationId,
      storagePrefix: storagePrefixFor(pkg),
      startedAt,
      finishedAt: new Date().toISOString(),
      engine: `${browser.browserType().name()}/${browser.version()}`,
    },
    cases,
    state.assetResults,
    aborted,
  );
  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(reportPath(role), `${JSON.stringify(report, null, 2)}\n`);
  return { report, posterHashes: state.posterHashes, external };
}

// ─── Suite ────────────────────────────────────────────────────────────────────────────────────

let subject: Certification;
let reference: Certification | null = null;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  test.setTimeout(900_000);
  const packages = [SUBJECT_PACKAGE, ...(REFERENCE_PACKAGE ? [REFERENCE_PACKAGE] : [])];
  ensureFixture(packages);
  await startAssetServer();
  subject = await certify(browser, SUBJECT_PACKAGE, 'subject');
  if (REFERENCE_PACKAGE) reference = await certify(browser, REFERENCE_PACKAGE, 'reference');
});

test.afterAll(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
});

function assetStep(assets: readonly CanaryAssetResult[]): CanaryStepResult {
  const bad = assets.filter((a) => !a.ok);
  return {
    step: 'manifest-assets',
    status: assets.length === 0 ? 'fail' : bad.length === 0 ? 'pass' : 'fail',
    detail:
      assets.length === 0
        ? 'no assets were checked — the manifest check would be vacuous'
        : bad.length === 0
          ? `${assets.length} asset(s) served with the expected content type`
          : bad.map((a) => `${a.path} → ${a.status} ${a.contentType ?? ''}`).join(' | '),
  };
}

/** Which of the known control selectors actually exist in the loaded document. */
async function probeControlSelectors(page: Page): Promise<string[]> {
  return page.evaluate((candidates) => {
    const f = document.querySelector('#stage iframe') as HTMLIFrameElement | null;
    let doc: Document | null = null;
    try {
      doc = f?.contentDocument ?? null;
    } catch {
      doc = null;
    }
    if (!doc) return [];
    const hits: string[] = [];
    for (const sel of candidates) {
      try {
        if (doc.querySelector(sel)) hits.push(sel);
      } catch {
        /* an invalid selector is simply not a candidate */
      }
    }
    return hits;
  }, CONTROL_CANDIDATES);
}

/**
 * One case per (variant, configuration) the package must prove.
 *
 * TWO configurations per variant, not one: `configHash` folds Minimal-UI and the hidden selectors
 * in, so a package certified only in Full UI has demonstrated nothing about the picture the player
 * will actually ask for when Minimal UI is on — and those are different pictures with different
 * posters. The two also differ in aspect and quality, which are the two axes the poster key names
 * separately, so both POSTER_SIZES tables get exercised.
 */
function buildCases(variants: string[], hideSelectors: string[]): CanaryCase[] {
  const base: SimPresentationConfig = { ...DEFAULT_PRESENTATION_CONFIG, autoScript: true };
  const cases: CanaryCase[] = [];
  // The allowlist decides WHICH sections; the cap only bounds an unfiltered run, because a package
  // with dozens of sections would otherwise turn publication into a ten-minute wait. Neither ever
  // trims the CONFIGURATIONS of a chosen section — a variant certified in only one of its two
  // configurations is exactly the half-proof this refuses.
  const allowed = VARIANT_ALLOWLIST.length > 0 ? variants.filter((v) => VARIANT_ALLOWLIST.includes(v)) : variants;
  const covered = allowed.slice(0, Number(process.env.CANARY_MAX_VARIANTS ?? 6));
  for (const variantKey of covered) {
    const wide: SimAspectProfile = 'wide';
    const portrait: SimAspectProfile = 'portrait';
    const high: SimQualityProfile = 'high';
    const balanced: SimQualityProfile = 'balanced';
    cases.push({
      variantKey,
      config: { ...base, simpleUi: false, hideSelectors: [], quality: high, aspect: wide },
      aspectProfile: wide,
      qualityProfile: high,
    });
    cases.push({
      variantKey,
      config: { ...base, simpleUi: true, hideSelectors, quality: balanced, aspect: portrait },
      aspectProfile: portrait,
      qualityProfile: balanced,
    });
  }
  return cases;
}

// ── assertions ────────────────────────────────────────────────────────────────────────────
//
// Every certified package must satisfy the MECHANISM assertions: it loaded, it handshook, it
// applied and presented with matching identity, its posters are real, its UI obeys the config, its
// lifecycle round-trips, its assets serve, and it produced no errors. Those are properties of a
// working package, and the reference package differs from the subject only in what its capability
// report is entitled to CLAIM — which is what the last two tests are about.

/** Every certification produced by this run: the subject, plus the reference when enabled. */
const runs = (): { label: string; cert: Certification }[] => [
  { label: SUBJECT_PACKAGE, cert: subject },
  ...(reference ? [{ label: REFERENCE_PACKAGE, cert: reference }] : []),
];

/** Collect one step's non-passing outcomes across every certified package. */
function stepFailures(steps: CanaryStep[], accept: CanaryStepResult['status'][] = ['pass']): string[] {
  const out: string[] = [];
  for (const { label, cert } of runs()) {
    for (const c of cert.report.cases) {
      for (const step of steps) {
        const s = c.steps.find((x) => x.step === step);
        if (!s || !accept.includes(s.status)) {
          out.push(`[${label}] ${c.case.variantKey}/${c.case.aspectProfile}: ${step} → ${s?.status ?? 'missing'} ${s?.detail ?? ''}`);
        }
      }
    }
  }
  return out;
}

test('the run completed — an aborted canary is never a verdict about the package', () => {
  for (const { label, cert } of runs()) {
    expect(cert.report.aborted?.reason ?? '', `[${label}] the canary could not complete, so it proves nothing`).toBe('');
    expect(cert.report.cases.length, `[${label}] no cases were exercised — every assertion below would be vacuous`).toBeGreaterThan(0);
  }
});

test('every case loaded, handshook, applied and presented with matching identity', () => {
  const failures = stepFailures(['load', 'handshake', 'prepare', 'section-applied', 'present', 'section-presented']);
  expect(failures.join('\n')).toBe('');
});

test('A → B → A: every activation received its OWN SECTION_PRESENTED', () => {
  expect(stepFailures(['ab-cycles']).join('\n')).toBe('');
});

test('posters were captured at every required size, and different sections look different', () => {
  expect(stepFailures(['poster-captured']).join('\n')).toBe('');
  for (const { label, cert } of runs()) {
    expect(
      cert.report.cases.every((c) => typeof c.posterIdentity === 'string' && c.posterIdentity.length > 0),
      `[${label}] a case produced no poster identity`,
    ).toBe(true);

    // A poster is a promise about a SPECIFIC picture. If every capture is byte-identical, the
    // captures are of something that does not depend on the section, and the whole poster
    // mechanism would be showing the wrong picture with total confidence.
    if (new Set(cert.report.cases.map((c) => c.case.variantKey)).size > 1) {
      const standard = [...cert.posterHashes.entries()].filter(([k]) => k.endsWith('|standard')).map(([, v]) => v);
      expect(
        new Set(standard).size,
        `[${label}] every section produced the identical poster — the captures cannot be of the sections`,
      ).toBeGreaterThan(1);
    }
  }
});

test('Minimal UI actually hides the controls, and Full UI actually shows them', () => {
  expect(stepFailures(['controls-verified'], ['pass', 'not-applicable']).join('\n')).toBe('');
  for (const { label, cert } of runs()) {
    // Vacuity guard: if EVERY case reported not-applicable, nothing about UI state was proven.
    const decided = cert.report.cases.map((c) => c.steps.find((x) => x.step === 'controls-verified'));
    expect(
      decided.some((s) => s?.status === 'pass'),
      `[${label}] no case could read the document’s UI state — the staged package must expose a ` +
        `control container matching one of: ${CONTROL_CANDIDATES.join(', ')}`,
    ).toBe(true);
  }
});

test('the lifecycle round-trips: automation, suspend/resume, audio, and a leak-free dispose', () => {
  const failures = stepFailures(['pause-automation', 'suspend-resume', 'audio-state', 'dispose-counters']);
  for (const { label, cert } of runs()) {
    for (const c of cert.report.cases) {
      if (c.leaked.length > 0) failures.push(`[${label}] ${c.case.variantKey}: leaked ${c.leaked.join(', ')}`);
    }
  }
  expect(failures.join('\n')).toBe('');
});

test('every manifest asset returns 200 with the expected content type', () => {
  const bad: string[] = [];
  for (const { label, cert } of runs()) {
    expect(cert.report.assets.length, `[${label}] no assets were checked — this assertion would be vacuous`).toBeGreaterThan(1);
    for (const a of cert.report.assets) {
      if (!a.ok) bad.push(`[${label}] ${a.path} → HTTP ${a.status} (${a.contentType ?? 'no type'})`);
    }
  }
  expect(bad.join('\n')).toBe('');
});

test('no significant console, page, network or protocol errors', () => {
  const significant: string[] = [];
  for (const { label, cert } of runs()) {
    for (const c of cert.report.cases) {
      for (const e of c.errors.filter(isSignificantError)) {
        significant.push(`[${label}] ${c.case.variantKey}: ${e.source} — ${e.message}`);
      }
    }
    expect(
      cert.external,
      `[${label}] the canary made requests outside the staged package — its verdict would depend on a third party`,
    ).toEqual([]);
  }
  expect(significant.join('\n')).toBe('');
});

test('the report is complete: every case decided every step', () => {
  const undecided: string[] = [];
  for (const { label, cert } of runs()) {
    for (const c of cert.report.cases) {
      const decided = new Set(c.steps.filter((s) => s.status !== 'skipped').map((s) => s.step));
      for (const step of CANARY_STEPS) {
        if (!decided.has(step)) undecided.push(`[${label}] ${c.case.variantKey}/${c.case.aspectProfile}: ${step}`);
      }
    }
  }
  expect(undecided.join('\n'), 'an undecided step is not a passed step').toBe('');
});

test('the verdict never grants more than the document’s own capability report allows', () => {
  const rank = [...PACKAGE_CLASS_ORDER];
  for (const { label, cert } of runs()) {
    const decision = judgeCanaryReport(cert.report);
    expect(decision.honest, `[${label}] ${describeCanaryDecision(decision)}`).toBe(true);
    expect(decision.complete, `[${label}] ${describeCanaryDecision(decision)}`).toBe(true);
    // The classification may be WORSE than the capability report allows (a step failed), never
    // better — a canary that granted a guarantee the document never claimed would be inventing it.
    const allowedByCaps = cert.report.cases.map((c) => classifyFromCapabilities(c.capabilities));
    const worstAllowed = allowedByCaps.reduce(
      (worst, cls) => (rank.indexOf(cls) > rank.indexOf(worst) ? cls : worst),
      'managed-presentable' as SimPackageClass,
    );
    expect(
      rank.indexOf(decision.classification),
      `[${label}] classified '${decision.classification}' but the capability report only allows ` +
        `'${worstAllowed}' at best`,
    ).toBeGreaterThanOrEqual(rank.indexOf(worstAllowed));
    // And the guard must be exactly the classification plus completeness — no other input.
    expect(mayPublishAsModern(cert.report), `[${label}] ${describeCanaryDecision(decision)}`).toBe(
      decision.classification === 'managed-presentable',
    );
  }
});

test('the gate GRANTS a package that proves everything, and WITHHOLDS from one that does not', () => {
  // A gate observed only saying yes has not been observed working. The reference package differs
  // from the subject in exactly one respect — every section body is managed, so its honest
  // capability report can reach `managed-presentable` — and the two must therefore be decided
  // differently by the same rule with no special-casing anywhere.
  test.skip(!reference, 'CANARY_REFERENCE_PACKAGE is empty — only one package was certified');
  const grant = judgeCanaryReport(reference!.report);
  expect(grant.classification, describeCanaryDecision(grant)).toBe('managed-presentable');
  expect(mayPublishAsModern(reference!.report), describeCanaryDecision(grant)).toBe(true);

  const withhold = judgeCanaryReport(subject.report);
  if (withhold.classification !== 'managed-presentable') {
    expect(mayPublishAsModern(subject.report), describeCanaryDecision(withhold)).toBe(false);
    // Withheld is not the same as broken: the subject must still be presentable to a user.
    expect(withhold.classification, describeCanaryDecision(withhold)).not.toBe('failed');
  }
});
