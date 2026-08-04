/**
 * THE LEAK + STABILITY SUITE (Priority 6.7).
 *
 * WHAT THIS ASKS THAT NOTHING ELSE DOES
 * The canary (e2e/sim-canary.spec.ts) asks "does this package do the right thing ONCE". A resident
 * simulation pool does not do anything once: it enters and re-enters the same sections for the
 * length of a video, suspends every document it is not showing, and resumes them again. Every
 * defect that matters at that scale is invisible in a single pass — a listener that is added per
 * activation and removed per document, a rAF that is cancelled but never dropped from its registry,
 * a texture whose dispose throws and is silently swallowed. So this suite runs the lifecycle a
 * hundred times and looks at the SLOPE, not the value.
 *
 * THE HARNESS IS THE CANARY'S, DELIBERATELY
 * The parent half of the v3 bootstrap is the same driver sim-canary.spec.ts installs: a faithful
 * re-expression of lib/sim/SimTransport handed the wire constants AS DATA (see WIRE), recording
 * every inbound message raw and judging none of them in the browser. Validation happens in Node
 * with the REAL `validateEnvelope`. A second, differently-shaped harness would mean two ideas of
 * what the protocol is, and the leak numbers would be measured against whichever one happened to be
 * loaded.
 *
 * TWO INDEPENDENT WITNESSES, BECAUSE ONE OF THEM IS THE THING UNDER TEST
 *   1. The managed scope's OWN counters, off the wire: DOCUMENT_SUSPENDED and DISPOSED each carry a
 *      full SimResourceCounts. That is the number the product will act on.
 *   2. A native-resource observer installed in the CHILD frame by an init script (below the rAF
 *      gate, so it sees every scheduling call the scope makes). It counts live native rAFs,
 *      timeouts, intervals and durable DOM listeners with no help from the runtime at all.
 * A leak the scope cannot see shows up in (2); a counter that lies shows up as a disagreement
 * between (1) and (2). Judging by (1) alone would be judging the accused's own testimony — which is
 * exactly why scenario 4 poisons a tracked resource and requires the report to NAME it.
 *
 * THE THRESHOLDS ARE NOT RESTATED HERE. `judgeLeak` and `DEFAULT_PLATEAUS` are imported from
 * shared/src/sim/managedLifecycle and used as-is; a suite carrying its own copy of the plateau
 * would keep passing after the product's idea of an acceptable plateau changed.
 *
 * NOTHING IS EVER SKIPPED. Where an engine cannot provide a capability (WEBGL_lose_context), the
 * unavailability is ASSERTED and recorded as not-applicable in e2e-results/sim-leak-<engine>.json.
 * Where the fixture cannot allocate a resource kind (Worker, AudioContext), its ABSENCE is proven
 * independently rather than assumed, and the report says so in as many words.
 *
 *   npx playwright test --config=playwright.leak.config.ts
 *
 * Output: e2e-results/sim-leak-<engine>.json and e2e-results/sim-leak-playwright.json.
 */
import { test, expect, type Browser, type BrowserContext, type Page, type Route } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { extname, join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { fixtureIsFresh } from './fixtureSources';

import {
  ACTIVATE_SECTION,
  AUTOMATION_PAUSED,
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
  RESUME_AUTOMATION,
  RESUME_DOCUMENT,
  SECTION_APPLIED,
  SECTION_ERROR,
  SECTION_PRESENTED,
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
  type SectionErrorPayload,
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
  type SimPresentationConfig,
} from 'shared/src/sim/simIdentity';
import {
  DEFAULT_PLATEAUS,
  judgeLeak,
  type LeakVerdict,
  type ManagedResourceKind,
} from 'shared/src/sim/managedLifecycle';
import {
  SIM_DISPOSE_TIMEOUT_MS,
  SIM_PREPARE_TIMEOUT_MS,
  SIM_PRESENT_TIMEOUT_MS,
  SIM_SUSPEND_TIMEOUT_MS,
  SIM_CONTEXT_RESTORE_TIMEOUT_MS,
} from 'shared/src/sim/simFailurePolicy';
import { SIM_HELLO_KIND } from '../lib/sim/SimTransport';

// ─── Subject ──────────────────────────────────────────────────────────────────────────────────

/**
 * `v3allmanaged` and nothing else. It is the one fixture whose every section body returns a real
 * ManagedSectionLifecycle, so its resources are genuinely owned by the managed scope — a leak test
 * pointed at the mixed package would be measuring the legacy wrapper for half of its samples.
 */
const PACKAGE = process.env.LEAK_PACKAGE ?? 'v3allmanaged';
const API_ORIGIN = process.env.LEAK_API_URL ?? 'http://localhost:8080';
const HARNESS_URL = `${API_ORIGIN}/__leak/harness.html`;
const publicPrefix = (pkg: string): string => `/sim-public/__e2e/${pkg}`;

const FIXTURE_DIR = resolve(__dirname, '../../.sim-fixture');
const BACKEND = resolve(__dirname, '../../backend-api');
const RESULTS_DIR = resolve(__dirname, '../e2e-results');

/**
 * Section ids, named rather than imported.
 *
 * gen-sim-fixture.ts exports them, but importing that module pulls the server's SimulationService
 * and controller graph into the test process — the same reason viewer-e2e.spec.ts and
 * sim-canary.spec.ts name their fixture sections directly. Drift is caught, not tolerated: the
 * discovery test below FAILS if the document does not report exactly these.
 */
const V3A = '33333333-a111-4a11-8a11-333333333333';
const V3B = '44444444-b222-4b22-8b22-444444444444';
const V3THROWPREPARE = '88888888-f666-4f66-8f66-888888888888';
/** Labels the managed bodies publish their state under (V3_STATE_GLOBAL in the generator). */
const LABEL_OF: Record<string, string> = { [V3A]: 'V3A', [V3B]: 'V3B' };
const V3_STATE_GLOBAL = '__V3_STATE__';

// ─── Cycle counts. Never reduced to fit a clock — see the config header. ──────────────────────

/** A → B → A repetitions. Three activations each, so 300 activations in total. */
const AB_CYCLES = Number(process.env.LEAK_AB_CYCLES ?? 100);
/** SUSPEND → RESUME round trips on ONE activation. */
const SUSPEND_CYCLES = Number(process.env.LEAK_SUSPEND_CYCLES ?? 100);
/** Full document epochs: mount → init → activate → dispose, with a real teardown each time. */
const DOC_EPOCHS = Number(process.env.LEAK_DOC_EPOCHS ?? 20);

/** Long enough for the fixture's 40 ms automation interval to tick at least twice. */
const DWELL_MS = 120;
/** The background window scenario 7 measures over. */
const BACKGROUND_MS = 1_500;

const LOAD_TIMEOUT_MS = 30_000;
const HANDSHAKE_TIMEOUT_MS = 15_000;
const BASE_VIEWPORT = { width: 1280, height: 720 };

/** One configuration for every activation: A → B → A with an IDENTICAL config is the hard case. */
const CONFIG: SimPresentationConfig = { ...DEFAULT_PRESENTATION_CONFIG, autoScript: true };
const CONFIG_HASH = computeConfigHash(CONFIG);

/**
 * The kinds the v3allmanaged managed body (v3ManagedBody in gen-sim-fixture.ts) actually allocates:
 * a self-rescheduling rAF loop, an interval registered as automation, a listener on the document,
 * an AbortController, an object URL and an explicitly tracked fake GPU texture.
 *
 * This list is a VACUITY GUARD, not documentation. If the fixture stops allocating one of these,
 * every plateau judgement about it becomes "0 ≤ max, drift 0" — a pass that proves nothing — so the
 * suite asserts the set it measured contains all six and fails loudly when it does not.
 */
const EXPECTED_ALLOCATED: ManagedResourceKind[] = [
  'rafCallbacks', 'intervals', 'listeners', 'abortControllers', 'objectUrls', 'glTextures',
];

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
      throw new Error(`sim-leak: fixture generation failed: ${r.stderr || r.stdout}`);
    }
  }
  if (!existsSync(stamp)) {
    // FAIL, never skip. An unrun leak suite reads as a pass in every report that aggregates it.
    throw new Error(
      `sim-leak: the staged package '${pkg}' does not exist at ${stamp}.\n` +
      `Generate it with:  cd backend-api && npx tsx src/scripts/gen-sim-fixture.ts ${FIXTURE_DIR}`,
    );
  }
}

// ─── Local asset server (the canary's, unchanged) ─────────────────────────────────────────────

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
  <title>sim leak harness</title>
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
  if (pathname === '/__leak/harness.html') return '__harness__';
  if (pathname.startsWith('/sim-public/__e2e/')) return pathname.slice('/sim-public/__e2e/'.length);
  return null;
}

function startAssetServer(): Promise<void> {
  server = createServer((req, res) => {
    const pathname = (req.url ?? '/').split('?')[0].split('#')[0];
    if (pathname === '/__leak/harness.html') {
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

interface LeakApi {
  /** Create the frame. `deferOffer` holds the bootstrap back so the caller can stage the document. */
  mount(src: string, identity: DocumentIdentity, deferOffer: boolean): void;
  /** Start (or restart) offering the port. No-op once a port has been adopted. */
  beginHandshake(): void;
  send(type: string, payload: unknown, activation: ActivationIdentity | null): boolean;
  mode(): string;
  /** Global index of the last inbound message. Never reset, so a cursor stays valid across drains. */
  mark(): number;
  /** Live buffer — read by in-page predicates only, never serialised wholesale. */
  peek(): RawEntry[];
  /** Remove and return everything buffered, for validation in Node. */
  drain(): RawEntry[];
  close(): void;
}

interface LeakWindow extends Window {
  __leak: LeakApi;
}

/**
 * The parent half of the v3 bootstrap — the canary's driver, with three additions the leak suite
 * needs: a global (never-reset) message index so a cursor survives a drain, a `drain()` that hands
 * the buffered stream to Node instead of letting it grow to tens of thousands of entries over 300
 * activations, and a deferrable handshake so scenario 6 can put a WebGL-capable canvas into the
 * document BEFORE the runtime's one-shot context-event wiring runs.
 *
 * It judges nothing. Every inbound message is stored raw and validated in Node by the shipped
 * `validateEnvelope`.
 */
function installLeakDriver(K: WireConstants): void {
  // The init script runs in EVERY frame, including the simulation's. A second driver there would
  // add a competing window listener to the document that is trying to adopt a port.
  if (window.parent !== window) return;

  const raw: RawEntry[] = [];
  let nextIndex = 0;

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
    const data = e.data as { kind?: unknown; protocolVersion?: unknown } | null;
    if (!data || typeof data !== 'object') return;
    if (data.kind === K.HELLO && data.protocolVersion === K.VER) offer();
  });

  const api: LeakApi = {
    mount(src: string, ident: DocumentIdentity, deferOffer: boolean): void {
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
      outSeq = 0;
      identity = ident;
      targetOrigin = new URL(src, window.location.href).origin;

      const stage = document.getElementById('stage');
      if (!stage) throw new Error('leak harness has no #stage');
      while (stage.firstChild) stage.removeChild(stage.firstChild);
      const f = document.createElement('iframe');
      f.id = 'sim';
      f.title = 'sim leak';
      f.setAttribute('allow', 'autoplay; xr-spatial-tracking');
      f.style.cssText = 'display:block;border:0;width:100%;height:100%;background:transparent';
      // No `sandbox`: a sandboxed frame without allow-same-origin has an OPAQUE origin, there is no
      // exact origin to address the offer to, and both the counters and the child observer would
      // become unreadable.
      f.src = src;
      stage.appendChild(f);
      frame = f;

      mode = deferOffer ? 'staged' : 'offering';
      if (!deferOffer) {
        offer();
        timer = window.setInterval(offer, K.OFFER_INTERVAL_MS);
      }
    },

    beginHandshake(): void {
      if (mode !== 'staged') return;
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
    drain(): RawEntry[] {
      return raw.splice(0, raw.length);
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

  (window as unknown as LeakWindow).__leak = api;
}

// ─── The child-frame native resource observer ─────────────────────────────────────────────────

interface ObsSnapshot {
  liveRaf: number;
  liveTimeouts: number;
  liveIntervals: number;
  /** Listeners on window/document/Elements that were added and never removed. */
  listeners: number;
  animations: number;
  animationsRunning: number;
  mediaElements: number;
  mediaPlaying: number;
  /** Constructed, ever — the independent proof that a kind is ABSENT rather than merely unreported. */
  workersConstructed: number;
  audioContextsConstructed: number;
  rafScheduled: number;
  rafFired: number;
  intervalsSet: number;
  intervalsCleared: number;
}

/**
 * An independent witness inside the simulation document.
 *
 * WHY IT IS BELOW THE rAF GATE. `page.addInitScript` runs before any of the document's own scripts,
 * so the injected sim-raf-gate captures THIS wrapper as its `nativeRaf`, and the managed scope in
 * turn takes `__SIM_RAF_GATE__.raw` — which is this wrapper. Every scheduling call the scope makes
 * therefore passes through here, and the live counts are arrived at without asking the runtime
 * anything.
 *
 * WHICH LISTENERS COUNT. Only `window`, `document` and Elements — targets that live as long as the
 * document does. A listener on an AbortSignal or a MessagePort dies with the object it is attached
 * to, and counting those would report the fixture's per-activation `signal.addEventListener('abort')`
 * as 300 leaked listeners when it is 300 pieces of garbage. `{ once: true }` registrations are
 * excluded for the same reason: the DOM removes them without anyone calling removeEventListener.
 *
 * It OBSERVES and never intercepts: every wrapper delegates with the original arguments and returns
 * the original handle.
 */
function installChildObserver(): void {
  if (window.parent === window) return;
  const w = window as unknown as Record<string, unknown> & Window;
  if ((w as unknown as { __leakObs?: unknown }).__leakObs) return;

  const nativeRaf = typeof w.requestAnimationFrame === 'function' ? w.requestAnimationFrame.bind(w) : null;
  const nativeCaf = typeof w.cancelAnimationFrame === 'function' ? w.cancelAnimationFrame.bind(w) : null;
  const nativeSetTimeout = w.setTimeout.bind(w);
  const nativeClearTimeout = w.clearTimeout.bind(w);
  const nativeSetInterval = w.setInterval.bind(w);
  const nativeClearInterval = w.clearInterval.bind(w);

  const liveRaf: Record<number, number> = {};
  const liveTimeout: Record<number, number> = {};
  const liveInterval: Record<number, number> = {};
  let nRaf = 0;
  let nTimeout = 0;
  let nInterval = 0;
  let rafScheduled = 0;
  let rafFired = 0;
  let intervalsSet = 0;
  let intervalsCleared = 0;
  let workersConstructed = 0;
  let audioContextsConstructed = 0;

  if (nativeRaf) {
    (w as unknown as { requestAnimationFrame: (cb: FrameRequestCallback) => number }).requestAnimationFrame =
      function (cb: FrameRequestCallback): number {
        if (typeof cb !== 'function') return nativeRaf(cb);
        let id = 0;
        id = nativeRaf(function (t: number) {
          if (liveRaf[id]) {
            delete liveRaf[id];
            nRaf--;
          }
          rafFired++;
          return cb(t);
        });
        liveRaf[id] = 1;
        nRaf++;
        rafScheduled++;
        return id;
      };
  }
  if (nativeCaf) {
    (w as unknown as { cancelAnimationFrame: (id: number) => void }).cancelAnimationFrame = function (id: number): void {
      if (liveRaf[id]) {
        delete liveRaf[id];
        nRaf--;
      }
      nativeCaf(id);
    };
  }

  (w as unknown as { setTimeout: unknown }).setTimeout = function (fn: unknown, ms?: number): number {
    if (typeof fn !== 'function') return nativeSetTimeout(fn as TimerHandler, ms);
    const rest = Array.prototype.slice.call(arguments, 2);
    let id = 0;
    id = nativeSetTimeout(function () {
      if (liveTimeout[id]) {
        delete liveTimeout[id];
        nTimeout--;
      }
      return (fn as (...a: unknown[]) => unknown).apply(w, rest);
    }, ms);
    liveTimeout[id] = 1;
    nTimeout++;
    return id;
  };
  (w as unknown as { clearTimeout: unknown }).clearTimeout = function (id: number): void {
    if (liveTimeout[id]) {
      delete liveTimeout[id];
      nTimeout--;
    }
    nativeClearTimeout(id);
  };
  (w as unknown as { setInterval: unknown }).setInterval = function (fn: unknown, ms?: number): number {
    if (typeof fn !== 'function') return nativeSetInterval(fn as TimerHandler, ms);
    const rest = Array.prototype.slice.call(arguments, 2);
    const id = nativeSetInterval(function () {
      return (fn as (...a: unknown[]) => unknown).apply(w, rest);
    }, ms);
    liveInterval[id] = 1;
    nInterval++;
    intervalsSet++;
    return id;
  };
  (w as unknown as { clearInterval: unknown }).clearInterval = function (id: number): void {
    if (liveInterval[id]) {
      delete liveInterval[id];
      nInterval--;
      intervalsCleared++;
    }
    nativeClearInterval(id);
  };

  // Durable-listener bookkeeping.
  const records: { t: unknown; type: string; fn: unknown; cap: boolean }[] = [];
  const capOf = (opts: unknown): boolean =>
    opts === true || !!(opts && typeof opts === 'object' && (opts as { capture?: boolean }).capture);
  const durable = (t: unknown): boolean =>
    t === w || t === w.document || !!(t && (t as { nodeType?: number }).nodeType === 1);
  const etHolder = w as unknown as { EventTarget?: { prototype: EventTarget } };
  const ET = etHolder.EventTarget ? etHolder.EventTarget.prototype : null;
  if (ET && typeof ET.addEventListener === 'function' && typeof ET.removeEventListener === 'function') {
    const origAdd = ET.addEventListener;
    const origRemove = ET.removeEventListener;
    ET.addEventListener = function (this: unknown, type: string, fn: unknown, opts?: unknown): void {
      const once = !!(opts && typeof opts === 'object' && (opts as { once?: boolean }).once);
      if (!once && typeof fn === 'function' && durable(this)) {
        const cap = capOf(opts);
        let dup = false;
        for (let i = 0; i < records.length; i++) {
          const r = records[i];
          if (r.t === this && r.type === type && r.fn === fn && r.cap === cap) {
            dup = true;
            break;
          }
        }
        // The DOM ignores an identical (type, callback, capture) re-registration; counting it twice
        // would invent a leak out of a double-add that changed nothing.
        if (!dup) records.push({ t: this, type, fn, cap });
      }
      return origAdd.apply(this as EventTarget, arguments as unknown as Parameters<typeof origAdd>);
    } as typeof ET.addEventListener;
    ET.removeEventListener = function (this: unknown, type: string, fn: unknown, opts?: unknown): void {
      const cap = capOf(opts);
      for (let i = 0; i < records.length; i++) {
        const r = records[i];
        if (r.t === this && r.type === type && r.fn === fn && r.cap === cap) {
          records.splice(i, 1);
          break;
        }
      }
      return origRemove.apply(this as EventTarget, arguments as unknown as Parameters<typeof origRemove>);
    } as typeof ET.removeEventListener;
  }

  // Constructor counters. Their VALUE is that they can prove a kind is absent: the suspension
  // contract names Workers and the WebAudio graph, and "the fixture allocates none" is only an
  // honest answer if something other than the fixture's own source says so.
  const wrapCtor = (name: string): void => {
    const holder = w as unknown as Record<string, unknown>;
    const Orig = holder[name] as (new (...a: unknown[]) => unknown) | undefined;
    if (typeof Orig !== 'function') return;
    const Wrapped = function (this: unknown, a: unknown, b: unknown): unknown {
      if (name === 'Worker') workersConstructed++;
      else audioContextsConstructed++;
      return new (Orig as new (...args: unknown[]) => unknown)(a, b);
    };
    (Wrapped as unknown as { prototype: unknown }).prototype = Orig.prototype;
    holder[name] = Wrapped;
  };
  wrapCtor('Worker');
  wrapCtor('AudioContext');
  wrapCtor('webkitAudioContext');

  (w as unknown as { __leakObs: () => ObsSnapshot }).__leakObs = function (): ObsSnapshot {
    let animations = 0;
    let animationsRunning = 0;
    try {
      const doc = w.document as Document & { getAnimations?: () => Animation[] };
      const list = typeof doc.getAnimations === 'function' ? doc.getAnimations() : [];
      animations = list.length;
      for (let i = 0; i < list.length; i++) if (list[i].playState === 'running') animationsRunning++;
    } catch {
      /* an engine without the Web Animations API reports zero, and the caller asserts on that */
    }
    let mediaPlaying = 0;
    const media = w.document.querySelectorAll('video,audio');
    for (let i = 0; i < media.length; i++) {
      if (!(media[i] as HTMLMediaElement).paused) mediaPlaying++;
    }
    return {
      liveRaf: nRaf,
      liveTimeouts: nTimeout,
      liveIntervals: nInterval,
      listeners: records.length,
      animations,
      animationsRunning,
      mediaElements: media.length,
      mediaPlaying,
      workersConstructed,
      audioContextsConstructed,
      rafScheduled,
      rafFired,
      intervalsSet,
      intervalsCleared,
    };
  };
}

// ─── Node-side driver helpers ─────────────────────────────────────────────────────────────────

interface EnvelopeMatch {
  type: string;
  activationId?: string;
  after?: number;
}

const driverMode = (page: Page): Promise<string> =>
  page.evaluate(() => (window as unknown as LeakWindow).__leak.mode());

const mark = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as LeakWindow).__leak.mark());

async function waitForEnvelope(
  page: Page,
  m: EnvelopeMatch,
  timeout: number,
  what: string,
): Promise<Record<string, unknown>> {
  try {
    const handle = await page.waitForFunction(
      (match) => {
        const api = (window as unknown as LeakWindow).__leak;
        if (!api) return null;
        for (const r of api.peek()) {
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
      { timeout, polling: 16 },
    );
    return (await handle.jsonValue()) as Record<string, unknown>;
  } catch {
    throw new Error(`${what}: no ${m.type} arrived within ${timeout}ms`);
  }
}

async function send(page: Page, type: string, payload: unknown, activation: ActivationIdentity | null): Promise<void> {
  const ok = await page.evaluate(
    (args) => (window as unknown as LeakWindow).__leak.send(args.type, args.payload, args.activation),
    { type, payload, activation },
  );
  if (!ok) throw new Error(`could not send ${type} — no modern transport is open`);
}

/** Two animation frames: enough for a style change or a schedule to have landed. */
const settle = (page: Page): Promise<void> =>
  page.evaluate(
    () =>
      new Promise<void>((r) => {
        requestAnimationFrame(() => requestAnimationFrame(() => r()));
      }),
  );

// ─── Evidence read out of the child document ──────────────────────────────────────────────────

interface SectionState {
  frames: number;
  ticks: number;
  presented: number;
  draws: number;
  prepared: boolean;
  activated: boolean;
  suspended: boolean;
  disposed: boolean;
  aborted: boolean;
  autoPaused: boolean;
}

async function readSection(page: Page, label: string, stateGlobal: string): Promise<SectionState | null> {
  return page.evaluate(
    (args) => {
      const f = document.querySelector('#stage iframe') as HTMLIFrameElement | null;
      try {
        const w = f?.contentWindow as unknown as Record<string, Record<string, Record<string, unknown>>> | null;
        const s = w && w[args.stateGlobal] ? w[args.stateGlobal][args.label] : null;
        if (!s) return null;
        const n = (v: unknown): number => (typeof v === 'number' ? v : 0);
        return {
          frames: n(s.frames),
          ticks: n(s.ticks),
          presented: n(s.presented),
          draws: n(s.draws),
          prepared: !!s.prepared,
          activated: !!s.activated,
          suspended: !!s.suspended,
          disposed: !!s.disposed,
          aborted: !!s.aborted,
          autoPaused: !!s.autoPaused,
        };
      } catch {
        return null;
      }
    },
    { label, stateGlobal },
  );
}

async function readObs(page: Page): Promise<ObsSnapshot | null> {
  return page.evaluate(() => {
    const f = document.querySelector('#stage iframe') as HTMLIFrameElement | null;
    try {
      const w = f?.contentWindow as unknown as { __leakObs?: () => ObsSnapshot } | null;
      return w && typeof w.__leakObs === 'function' ? w.__leakObs() : null;
    } catch {
      return null;
    }
  });
}

/** The observer must exist and be answering, or every "independent" number below is a fiction. */
async function requireObs(page: Page, what: string): Promise<ObsSnapshot> {
  const obs = await readObs(page);
  expect(obs, `${what}: the child-frame resource observer is not installed — no independent witness`).not.toBeNull();
  return obs as ObsSnapshot;
}

/** The section state must exist, or every frame/tick assertion below is about nothing. */
async function requireSection(page: Page, variant: string, what: string): Promise<SectionState> {
  const s = await readSection(page, LABEL_OF[variant], V3_STATE_GLOBAL);
  expect(s, `${what}: the fixture published no state for ${LABEL_OF[variant]}`).not.toBeNull();
  return s as SectionState;
}

// ─── Protocol validation, in Node, with the real validator ────────────────────────────────────

interface Epoch {
  identity: DocumentIdentity;
  lastSeq: number;
  rejections: string[];
  messages: number;
}

let epoch: Epoch | null = null;

/**
 * Drain the buffered inbound stream and judge every envelope with the SHIPPED validator.
 *
 * Called at phase boundaries rather than per message: the buffer would otherwise reach tens of
 * thousands of entries over 300 activations, and serialising it once at the end would mean holding
 * all of it in the page. `lastSeq` is carried across drains, so the sequence check is continuous —
 * a duplicate or reordered message is caught even when it straddles a drain.
 */
async function drainAndValidate(page: Page): Promise<void> {
  const e = epoch;
  if (!e) return;
  const entries = (await page.evaluate(() => (window as unknown as LeakWindow).__leak.drain())) as RawEntry[];
  for (const entry of entries) {
    e.messages++;
    const result = validateEnvelope(entry.data, {
      playerSessionId: e.identity.playerSessionId,
      documentId: e.identity.documentId,
      lastSeq: e.lastSeq,
      allowedTypes: PARENT_INBOUND_TYPES,
    });
    if (result.ok) {
      e.lastSeq = result.envelope.seq;
      continue;
    }
    const type = typeof entry.data?.type === 'string' ? entry.data.type : '(no type)';
    e.rejections.push(`${result.reason}${result.detail ? `: ${result.detail}` : ''} (on ${type})`);
  }
}

// ─── Document + activation choreography ───────────────────────────────────────────────────────

const entryUrl = (variant: string): string =>
  `${API_ORIGIN}${publicPrefix(PACKAGE)}/index.html?section=${encodeURIComponent(variant)}&v=1`;

let packageRevision = '';
let playerSessionId = '';

interface BootResult {
  documentId: string;
  capabilities: SimRuntimeCapabilities | null;
  variants: string[];
}

/**
 * Bring one document epoch up: mount, adopt a port, INIT_DOCUMENT, DOCUMENT_READY.
 *
 * `stage` runs after the child document is loaded but BEFORE the bootstrap offer, which is the only
 * window in which the document can be altered and still be seen by the runtime's one-shot
 * `wireContextEvents()` scan.
 */
async function bootDocument(page: Page, variant: string, stage?: () => Promise<void>): Promise<BootResult> {
  const documentId = newDocumentId();
  const identity: DocumentIdentity = { playerSessionId, packageRevision, documentId };
  epoch = { identity, lastSeq: 0, rejections: [], messages: 0 };

  await page.evaluate(
    (args) => (window as unknown as LeakWindow).__leak.mount(args.src, args.identity, args.defer),
    { src: entryUrl(variant), identity, defer: !!stage },
  );
  await page.waitForFunction(
    () => {
      const f = document.querySelector('#stage iframe') as HTMLIFrameElement | null;
      if (!f) return false;
      try {
        return f.contentDocument ? f.contentDocument.readyState === 'complete' : true;
      } catch {
        return true;
      }
    },
    undefined,
    { timeout: LOAD_TIMEOUT_MS },
  );
  if (stage) {
    await stage();
    await page.evaluate(() => (window as unknown as LeakWindow).__leak.beginHandshake());
  }

  await page
    .waitForFunction(() => (window as unknown as LeakWindow).__leak.mode() === 'modern', undefined, {
      timeout: HANDSHAKE_TIMEOUT_MS,
    })
    .catch(() => {
      /* reported by the assertion below, not thrown here */
    });
  const mode = await driverMode(page);
  if (mode !== 'modern') {
    throw new Error(
      `the document never adopted a v3 port (driver mode '${mode}') — the leak suite has nothing to measure`,
    );
  }

  const cursor = await mark(page);
  await send(page, INIT_DOCUMENT, { parentOrigin: API_ORIGIN, quality: 'high', audible: { muted: true, volume: 0 } }, null);
  const ready = await waitForEnvelope(page, { type: DOCUMENT_READY, after: cursor }, HANDSHAKE_TIMEOUT_MS, 'handshake');
  const payload = ready.payload as DocumentReadyPayload;
  return {
    documentId,
    capabilities: payload?.capabilities ?? null,
    variants: Array.isArray(payload?.variants) ? payload.variants : [],
  };
}

/** PREPARE → SECTION_APPLIED → PRESENT → SECTION_PRESENTED for one activation. */
async function presentActivation(page: Page, variant: string, what: string): Promise<ActivationIdentity> {
  const activation: ActivationIdentity = {
    activationId: newActivationId(),
    variantKey: variant,
    configHash: CONFIG_HASH,
  };
  const cursor = await mark(page);
  await send(page, PREPARE_SECTION, { variantKey: variant, config: CONFIG }, activation);
  await waitForEnvelope(
    page,
    { type: SECTION_APPLIED, activationId: activation.activationId, after: cursor },
    SIM_PREPARE_TIMEOUT_MS,
    what,
  );
  await send(page, PRESENT_SECTION, {}, activation);
  const presented = await waitForEnvelope(
    page,
    { type: SECTION_PRESENTED, activationId: activation.activationId, after: cursor },
    SIM_PRESENT_TIMEOUT_MS,
    what,
  );
  const payload = presented.payload as SectionPresentedPayload;
  if (!(payload?.framesSubmitted >= 1)) {
    throw new Error(`${what}: SECTION_PRESENTED claimed ${String(payload?.framesSubmitted)} frames`);
  }
  return activation;
}

/** ACTIVATE_SECTION — the message that starts the section's public animation and automation. */
async function activateSection(page: Page, activation: ActivationIdentity): Promise<void> {
  await send(page, ACTIVATE_SECTION, {}, activation);
  await settle(page);
}

/**
 * SUSPEND_DOCUMENT → DOCUMENT_SUSPENDED, returning the counts snapshot.
 *
 * WHY THIS AND NOT A DISPOSE PER CYCLE. Both messages carry a full SimResourceCounts, but DISPOSED
 * ends the document: sampling with it would mean 100 iframe loads and 100 handshakes, turning a
 * 40-second measurement into a five-minute one and — worse — resetting the very state a leak would
 * accumulate in. SUSPEND is the only counts-bearing message that leaves the document alive, so the
 * A→B→A series is sampled with it and the full teardown gets its own (necessarily shorter) run in
 * scenario 3.
 */
async function suspendSnapshot(page: Page, what: string): Promise<DocumentSuspendedPayload> {
  const cursor = await mark(page);
  await send(page, SUSPEND_DOCUMENT, {}, null);
  const env = await waitForEnvelope(page, { type: DOCUMENT_SUSPENDED, after: cursor }, SIM_SUSPEND_TIMEOUT_MS, what);
  return env.payload as DocumentSuspendedPayload;
}

async function resumeDocument(page: Page, what: string): Promise<void> {
  const cursor = await mark(page);
  await send(page, RESUME_DOCUMENT, {}, null);
  await waitForEnvelope(page, { type: DOCUMENT_RESUMED, after: cursor }, SIM_SUSPEND_TIMEOUT_MS, what);
}

async function disposeDocument(page: Page, what: string): Promise<DisposedPayload> {
  const cursor = await mark(page);
  await send(page, DISPOSE_DOCUMENT, {}, null);
  const env = await waitForEnvelope(page, { type: DISPOSED, after: cursor }, SIM_DISPOSE_TIMEOUT_MS, what);
  return env.payload as DisposedPayload;
}

// ─── The report ───────────────────────────────────────────────────────────────────────────────

interface SeriesTable {
  series: string;
  samples: number;
  verdicts: LeakVerdict[];
}

interface LeakRunReport {
  engine: string;
  package: string;
  startedAt: string;
  finishedAt: string;
  cycles: { abCycles: number; suspendCycles: number; docEpochs: number };
  durationsMs: Record<string, number>;
  tables: SeriesTable[];
  observations: { scenario: string; note: string }[];
  notApplicable: { scenario: string; why: string }[];
  protocolRejections: string[];
  /** Worker generations that contributed. Playwright discards a worker after a failed test. */
  workers: number[];
}

/**
 * Every scenario the contract requires. Checked against what the merged report actually contains,
 * so a scenario that silently never ran cannot read as a pass — the same rule the canary applies to
 * an undecided step.
 */
const REQUIRED_SCENARIOS = [
  'ab-cycles',
  'suspend-resume',
  'raf-resume',
  'automation-stability',
  'doc-epochs',
  'cleanup-error',
  'startup-error',
  'context-loss',
  'suspension-contract',
  'background',
];

const report: LeakRunReport = {
  engine: '',
  package: PACKAGE,
  startedAt: new Date().toISOString(),
  finishedAt: '',
  cycles: { abCycles: AB_CYCLES, suspendCycles: SUSPEND_CYCLES, docEpochs: DOC_EPOCHS },
  durationsMs: {},
  tables: [],
  observations: [],
  notApplicable: [],
  protocolRejections: [],
  workers: [],
};

const reportPath = (): string => join(RESULTS_DIR, `sim-leak-${(report.engine.split('/')[0] || 'unknown')}.json`);

/**
 * Read whatever a PREVIOUS worker generation wrote.
 *
 * Playwright discards a worker process after a failed test and starts a fresh one, so a suite with
 * a genuine finding in it runs its module body several times. Without this merge the report would
 * describe only the tests that happened to run after the last failure — and the scenarios that
 * passed before it would look like they never ran, which is the one thing the completeness check
 * below must not be able to say wrongly.
 */
function loadPreviousReport(): LeakRunReport | null {
  const file = reportPath();
  if (workerIndex === 0 || !existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as LeakRunReport;
  } catch {
    return null;
  }
}

/** Scenarios recorded by this worker AND by every earlier generation of it. */
function recordedScenarios(): Set<string> {
  const seen = new Set<string>();
  const previous = loadPreviousReport();
  for (const o of previous?.observations ?? []) seen.add(o.scenario);
  for (const o of report.observations) seen.add(o.scenario);
  return seen;
}

const note = (scenario: string, text: string): void => {
  report.observations.push({ scenario, note: text });
};
const notApplicable = (scenario: string, why: string): void => {
  report.notApplicable.push({ scenario, why });
};

const COUNT_KINDS = Object.keys(ZERO_RESOURCE_COUNTS) as ManagedResourceKind[];

/** Which kinds a series actually exercised. A kind that never went above zero proves nothing. */
function allocatedKinds(series: Partial<Record<ManagedResourceKind, number[]>>): ManagedResourceKind[] {
  return COUNT_KINDS.filter((k) => (series[k] ?? []).some((n) => n > 0));
}

/**
 * Judge one series with the SHIPPED judge and the SHIPPED plateaus.
 *
 * A kind with no plateau entry in DEFAULT_PLATEAUS is reported, not silently passed: the absence of
 * a threshold is a gap in the contract, and hiding it here is how the gap survives.
 */
function judgeSeries(
  name: string,
  series: Partial<Record<ManagedResourceKind, number[]>>,
  kinds: ManagedResourceKind[],
): { verdicts: LeakVerdict[]; unjudged: ManagedResourceKind[]; vacuous: string[] } {
  const verdicts: LeakVerdict[] = [];
  const unjudged: ManagedResourceKind[] = [];
  const vacuous: string[] = [];
  let samples = 0;
  for (const kind of kinds) {
    const values = series[kind] ?? [];
    samples = Math.max(samples, values.length);
    const plateau = DEFAULT_PLATEAUS[kind];
    if (!plateau) {
      unjudged.push(kind);
      continue;
    }
    const verdict = judgeLeak(kind, values, plateau);
    verdicts.push(verdict);
    // `judgeLeak` discards a warm-up prefix, and a series SHORTER than that prefix leaves it with
    // nothing to judge — it then returns max 0 / drift 0, which reads exactly like a clean result.
    // Every kind here was selected because some sample was positive, so a judged max of zero can
    // only mean the whole series fell inside the warm-up. Detected without restating the constant.
    if (verdict.observedMax === 0) {
      vacuous.push(
        `${kind}: judged over ${values.length} samples but the warm-up window swallowed all of them ` +
          `(raw max ${Math.max(...values, 0)}) — the verdict is not about anything`,
      );
    }
  }
  report.tables.push({ series: name, samples, verdicts });
  return { verdicts, unjudged, vacuous };
}

const failedVerdicts = (verdicts: LeakVerdict[]): string[] =>
  verdicts
    .filter((v) => !v.ok)
    .map(
      (v) =>
        `${v.kind}: max ${v.observedMax} (plateau ${v.plateau.max}), drift ${v.observedDrift} ` +
        `(allowed ${v.plateau.maxDrift})`,
    );

// ─── Suite ────────────────────────────────────────────────────────────────────────────────────

let context: BrowserContext;
let page: Page;
let workerIndex = 0;
const consoleErrors: string[] = [];
const pageErrors: string[] = [];
const externalRequests: string[] = [];

test.beforeAll(async ({ browser }: { browser: Browser }, testInfo) => {
  test.setTimeout(180_000);
  workerIndex = testInfo.workerIndex;
  ensureFixture(PACKAGE);
  await startAssetServer();

  report.engine = `${browser.browserType().name()}/${browser.version()}`;

  const bridgePath = join(FIXTURE_DIR, PACKAGE, 'bridge.js');
  const bridgeHash = existsSync(bridgePath)
    ? createHash('sha256').update(readFileSync(bridgePath)).digest('hex').slice(0, 12)
    : null;
  packageRevision = derivePackageRevision(`e2e-${PACKAGE}`, bridgeHash);
  playerSessionId = newPlayerSessionId();

  context = await browser.newContext({ viewport: BASE_VIEWPORT });
  page = await context.newPage();

  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(`${m.text()} @ ${m.location().url}`);
  });
  // OBSERVE, never intercept, for hermeticity — a catch-all route changes loading behaviour, which
  // is exactly what a hermeticity check must not do.
  page.on('request', (req) => {
    const url = req.url();
    const allowed =
      url.startsWith(API_ORIGIN) || url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('about:');
    if (!allowed) externalRequests.push(url);
  });

  await page.route(`${API_ORIGIN}/**`, async (route: Route) => {
    const url = new URL(route.request().url());
    const local = localPathFor(url.pathname);
    if (local === null) {
      await route.fulfill({ status: 404, contentType: 'text/plain', body: 'not part of the staged package' });
      return;
    }
    const target = local === '__harness__' ? `${localOrigin}/__leak/harness.html` : `${localOrigin}/${local}${url.search}`;
    const upstream = await fetch(target);
    await route.fulfill({
      status: upstream.status,
      headers: Object.fromEntries(upstream.headers.entries()),
      body: Buffer.from(await upstream.arrayBuffer()),
    });
  });

  await page.addInitScript(installLeakDriver, WIRE);
  await page.addInitScript(installChildObserver);
  await page.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' });
});

/**
 * Nothing this suite measures survives a page that is throwing errors or talking to the internet,
 * so the check is per TEST rather than once at the end: a worker discarded after a failure would
 * otherwise take its console output with it and the run-level check would be blind to it.
 */
test.afterEach(async ({}, testInfo) => {
  const errors = [...pageErrors.splice(0), ...consoleErrors.splice(0)];
  const external = externalRequests.splice(0);
  if (errors.length > 0) note(testInfo.title, `errors: ${errors.join(' | ')}`);
  if (external.length > 0) note(testInfo.title, `external requests: ${external.join(' | ')}`);
  expect(errors.join('\n'), `${testInfo.title}: the page or the package raised errors`).toBe('');
  expect(external, `${testInfo.title}: requests outside the staged package`).toEqual([]);
});

test.afterAll(async () => {
  report.finishedAt = new Date().toISOString();
  report.workers.push(workerIndex);
  report.protocolRejections.push(...(epoch?.rejections ?? []));
  mkdirSync(RESULTS_DIR, { recursive: true });

  // Merge with the earlier worker generations of this same run (see loadPreviousReport).
  const previous = loadPreviousReport();
  const merged: LeakRunReport = previous
    ? {
        ...previous,
        finishedAt: report.finishedAt,
        durationsMs: { ...previous.durationsMs, ...report.durationsMs },
        tables: [...previous.tables, ...report.tables],
        observations: [...previous.observations, ...report.observations],
        notApplicable: [...previous.notApplicable, ...report.notApplicable],
        protocolRejections: [...previous.protocolRejections, ...report.protocolRejections],
        workers: [...previous.workers, workerIndex],
      }
    : report;
  writeFileSync(reportPath(), `${JSON.stringify(merged, null, 2)}\n`);

  // The table the contract asks for, in the run log where a reader will actually see it.
  const lines: string[] = ['', `LEAK PLATEAU TABLE — ${report.engine} — package ${report.package}`];
  for (const table of report.tables) {
    lines.push('', `  ${table.series}  (${table.samples} samples)`);
    lines.push('  kind                 observedMax  plateau.max  observedDrift  maxDrift  verdict');
    for (const v of table.verdicts) {
      lines.push(
        `  ${v.kind.padEnd(20)} ${String(v.observedMax).padStart(11)} ${String(v.plateau.max).padStart(12)} ` +
        `${String(v.observedDrift).padStart(14)} ${String(v.plateau.maxDrift).padStart(9)}  ${v.ok ? 'ok' : 'LEAK'}`,
      );
    }
  }
  if (report.notApplicable.length > 0) {
    lines.push('', '  NOT APPLICABLE (asserted, never skipped):');
    for (const na of report.notApplicable) lines.push(`   - [${na.scenario}] ${na.why}`);
  }
  lines.push('');
  console.log(lines.join('\n'));

  await context?.close().catch(() => {
    /* the browser may already be gone */
  });
  if (server) await new Promise<void>((r) => server.close(() => r()));
});

// ── 0. discovery ─────────────────────────────────────────────────────────────────────────────

test('the staged package reports the sections and capabilities this suite is written against', async () => {
  const boot = await bootDocument(page, V3A);
  expect(boot.capabilities, 'DOCUMENT_READY carried no capability report').not.toBeNull();
  const caps = boot.capabilities as SimRuntimeCapabilities;
  // Every measurement below is a measurement of the MANAGED scope. A package that does not claim
  // managedLifecycle/suspendable would be measured through the legacy wrapper instead, and the
  // numbers would be about something else entirely.
  expect(caps.managedLifecycle, 'the subject package does not claim managedLifecycle').toBe(true);
  expect(caps.suspendable, 'the subject package does not claim suspendable').toBe(true);
  expect(caps.activationScoped, 'the subject package does not claim activationScoped').toBe(true);
  for (const v of [V3A, V3B, V3THROWPREPARE]) {
    expect(boot.variants, `the package does not carry ${v} — fixture drift`).toContain(v);
  }

  const obs = await requireObs(page, 'discovery');
  note('discovery', `variants=${boot.variants.length}, observer baseline ${JSON.stringify(obs)}`);
  await drainAndValidate(page);
  await disposeDocument(page, 'discovery dispose');
  await drainAndValidate(page);
  expect(epoch?.rejections ?? [], 'the discovery epoch produced protocol rejections').toEqual([]);
});

// ── 1. A → B → A, 100 times ──────────────────────────────────────────────────────────────────

test(`${AB_CYCLES} × A → B → A: no resource kind grows`, async () => {
  note('ab-cycles', `${AB_CYCLES} cycles × 3 activations against ${PACKAGE}`);
  const t0 = Date.now();
  await bootDocument(page, V3A);

  const scopeSeries: Partial<Record<ManagedResourceKind, number[]>> = {};
  const nativeSeries: Partial<Record<ManagedResourceKind, number[]>> = {};
  for (const k of COUNT_KINDS) scopeSeries[k] = [];
  nativeSeries.rafCallbacks = [];
  nativeSeries.timeouts = [];
  nativeSeries.intervals = [];
  nativeSeries.listeners = [];

  let activations = 0;
  const activationIds = new Set<string>();

  for (let cycle = 0; cycle < AB_CYCLES; cycle++) {
    for (const variant of [V3A, V3B, V3A]) {
      const act = await presentActivation(page, variant, `cycle ${cycle + 1} (${LABEL_OF[variant]})`);
      // An id reused across activations would make every identity check below tautological.
      expect(activationIds.has(act.activationId), `activation id ${act.activationId} was reused`).toBe(false);
      activationIds.add(act.activationId);
      activations++;
    }

    // Independent sample FIRST, while the last activation is still running: SUSPEND clears the
    // scope's native timers, so a sample taken after it would report zero live intervals for a
    // healthy document and for a leaking one alike.
    const obs = await requireObs(page, `cycle ${cycle + 1}`);
    nativeSeries.rafCallbacks!.push(obs.liveRaf);
    nativeSeries.timeouts!.push(obs.liveTimeouts);
    nativeSeries.intervals!.push(obs.liveIntervals);
    nativeSeries.listeners!.push(obs.listeners);

    const suspended = await suspendSnapshot(page, `cycle ${cycle + 1} suspend`);
    const counts = suspended.counts as Partial<SimResourceCounts> | undefined;
    const missing = COUNT_KINDS.filter((k) => typeof counts?.[k] !== 'number');
    expect(missing.join(', '), `cycle ${cycle + 1}: DOCUMENT_SUSPENDED reported no count for these kinds`).toBe('');
    for (const k of COUNT_KINDS) scopeSeries[k]!.push(counts![k] as number);
    await resumeDocument(page, `cycle ${cycle + 1} resume`);

    if (cycle % 10 === 9) await drainAndValidate(page);
  }
  await drainAndValidate(page);

  expect(activations, 'the loop did not run the contracted number of activations').toBe(AB_CYCLES * 3);

  // ── vacuity guard ──────────────────────────────────────────────────────────────────────────
  const allocated = allocatedKinds(scopeSeries);
  const missingKinds = EXPECTED_ALLOCATED.filter((k) => !allocated.includes(k));
  expect(
    missingKinds.join(', '),
    'the fixture allocated none of these kinds, so judging them would be vacuous — the leak suite ' +
      'is measuring a section that no longer takes the resources it was written to take',
  ).toBe('');

  const scope = judgeSeries('scope counters (DOCUMENT_SUSPENDED) — A→B→A', scopeSeries, allocated);
  const nativeKinds = (['rafCallbacks', 'timeouts', 'intervals', 'listeners'] as ManagedResourceKind[]).filter(
    (k) => (nativeSeries[k] ?? []).some((n) => n > 0),
  );
  const native = judgeSeries('native observer (independent) — A→B→A', nativeSeries, nativeKinds);

  note(
    'ab-cycles',
    `${activations} activations in ${Date.now() - t0}ms; scope kinds judged: ${allocated.join(', ')}; ` +
      `native kinds judged: ${nativeKinds.join(', ')}`,
  );
  for (const k of scope.unjudged) note('ab-cycles', `no DEFAULT_PLATEAUS entry for ${k} — unjudged`);

  expect(
    [...scope.vacuous, ...native.vacuous].join('\n'),
    'the run was too short for the leak judge to have anything to judge',
  ).toBe('');
  expect(failedVerdicts(scope.verdicts).join('\n'), 'the managed scope reports unbounded growth').toBe('');
  expect(
    failedVerdicts(native.verdicts).join('\n'),
    'the independent native-resource observer reports unbounded growth (the scope counters may ' +
      'disagree — they are the thing under test)',
  ).toBe('');
  // The two witnesses must AGREE about the intervals the scope owns; a scope counter that says 1
  // while the document really holds 300 armed intervals is the failure this pairing exists to catch.
  const lastNativeIntervals = nativeSeries.intervals![nativeSeries.intervals!.length - 1];
  expect(
    lastNativeIntervals,
    `after ${activations} activations the document still holds ${lastNativeIntervals} armed native ` +
      'interval(s) — one per live activation is the whole budget',
  ).toBeLessThanOrEqual(DEFAULT_PLATEAUS.intervals!.max);

  expect(epoch?.rejections ?? [], 'the A→B→A epoch produced protocol rejections').toEqual([]);
  await disposeDocument(page, 'ab-cycles dispose');
  await drainAndValidate(page);
  report.durationsMs.abCycles = Date.now() - t0;
});

// ── 2. suspend / resume, 100 times ───────────────────────────────────────────────────────────

test(`${SUSPEND_CYCLES} × suspend/resume: counts return to the plateau and nothing advances while suspended`, async () => {
  note('suspend-resume', `${SUSPEND_CYCLES} SUSPEND/RESUME round trips on one activation`);
  const t0 = Date.now();
  await bootDocument(page, V3A);
  const act = await presentActivation(page, V3A, 'suspend subject');
  await activateSection(page, act);

  // Liveness first. "Nothing advanced while suspended" is only a statement about suspension if
  // something was advancing before it.
  const before = await requireSection(page, V3A, 'pre-suspend liveness');
  await page.waitForTimeout(DWELL_MS);
  const running = await requireSection(page, V3A, 'pre-suspend liveness');
  expect(running.frames, 'the section rAF loop was not advancing before the first suspend').toBeGreaterThan(before.frames);
  expect(running.ticks, 'the section automation timer was not advancing before the first suspend').toBeGreaterThan(before.ticks);

  const series: Partial<Record<ManagedResourceKind, number[]>> = {};
  for (const k of COUNT_KINDS) series[k] = [];
  const unstoppableSeen: string[] = [];
  let frozenTickChecks = 0;
  let livenessChecks = 0;

  for (let cycle = 0; cycle < SUSPEND_CYCLES; cycle++) {
    const suspended = await suspendSnapshot(page, `suspend ${cycle + 1}`);
    const counts = suspended.counts as Partial<SimResourceCounts> | undefined;
    const missing = COUNT_KINDS.filter((k) => typeof counts?.[k] !== 'number');
    expect(missing.join(', '), `suspend ${cycle + 1}: DOCUMENT_SUSPENDED reported no count for these kinds`).toBe('');
    for (const k of COUNT_KINDS) series[k]!.push(counts![k] as number);
    if (Array.isArray(suspended.unstoppable) && suspended.unstoppable.length > 0) {
      unstoppableSeen.push(`cycle ${cycle + 1}: ${suspended.unstoppable.join(', ')}`);
    }

    // THE SUSPENSION CONTRACT (6.6), asserted on every single cycle.
    //
    // The FRAME assertion is only load-bearing while the rAF loop is alive. If the loop does not
    // survive a resume, cycles 2..N would satisfy it trivially — which is precisely why the
    // separate 'RESUME_DOCUMENT restores the rAF-driven render loop' test exists and why the tick
    // liveness guard below is checked after every resume: the automation timer, not the frame
    // counter, is what keeps this loop's freeze assertions honest.
    const atSuspend = await requireSection(page, V3A, `suspend ${cycle + 1}`);
    const obsSuspended = await requireObs(page, `suspend ${cycle + 1}`);
    await page.waitForTimeout(DWELL_MS);
    const afterDwell = await requireSection(page, V3A, `suspend ${cycle + 1}`);
    const obsAfterDwell = await requireObs(page, `suspend ${cycle + 1}`);
    expect(afterDwell.frames, `cycle ${cycle + 1}: the rAF loop advanced while the document was suspended`).toBe(atSuspend.frames);
    expect(afterDwell.ticks, `cycle ${cycle + 1}: the automation timer advanced while the document was suspended`).toBe(atSuspend.ticks);
    expect(obsAfterDwell.rafFired, `cycle ${cycle + 1}: native rAF callbacks ran while suspended`).toBe(obsSuspended.rafFired);
    expect(obsAfterDwell.animationsRunning, `cycle ${cycle + 1}: a Web Animation was running while suspended`).toBe(0);
    expect(obsAfterDwell.mediaPlaying, `cycle ${cycle + 1}: an HTML media element was playing while suspended`).toBe(0);
    expect(obsAfterDwell.workersConstructed, `cycle ${cycle + 1}: a Worker existed while suspended`).toBe(0);
    expect(obsAfterDwell.audioContextsConstructed, `cycle ${cycle + 1}: an AudioContext existed while suspended`).toBe(0);
    frozenTickChecks++;

    await resumeDocument(page, `resume ${cycle + 1}`);

    // The liveness guard again, so the NEXT cycle's freeze assertion is not vacuous. The automation
    // timer is the witness: it is the resource the scope explicitly rearms on resume.
    const atResume = await requireSection(page, V3A, `resume ${cycle + 1}`);
    await page.waitForTimeout(DWELL_MS);
    const afterResume = await requireSection(page, V3A, `resume ${cycle + 1}`);
    expect(
      afterResume.ticks,
      `cycle ${cycle + 1}: the automation timer did not restart after RESUME_DOCUMENT, so every later ` +
        'freeze assertion would be vacuously true',
    ).toBeGreaterThan(atResume.ticks);
    livenessChecks++;

    if (cycle % 10 === 9) await drainAndValidate(page);
  }
  await drainAndValidate(page);

  expect(frozenTickChecks, 'the contracted number of suspensions was not exercised').toBe(SUSPEND_CYCLES);
  expect(livenessChecks, 'the contracted number of resumes was not exercised').toBe(SUSPEND_CYCLES);
  expect(unstoppableSeen.join('\n'), 'DOCUMENT_SUSPENDED reported resources it could not stop').toBe('');

  const allocated = allocatedKinds(series);
  const missingKinds = EXPECTED_ALLOCATED.filter((k) => !allocated.includes(k));
  expect(missingKinds.join(', '), 'the suspended activation held none of these kinds — judging them would be vacuous').toBe('');

  const judged = judgeSeries('scope counters (DOCUMENT_SUSPENDED) — suspend/resume', series, allocated);
  expect(judged.vacuous.join('\n'), 'the run was too short for the leak judge to have anything to judge').toBe('');
  expect(failedVerdicts(judged.verdicts).join('\n'), 'suspend/resume grew the resource set').toBe('');

  // "Returns to the SAME plateau" is stricter than the drift bound: one activation, suspended and
  // resumed a hundred times, must report an identical count every time.
  const drifted: string[] = [];
  for (const k of allocated) {
    const v = series[k]!;
    if (v.some((n) => n !== v[0])) drifted.push(`${k}: ${v[0]} → ${JSON.stringify([...new Set(v)])}`);
  }
  expect(drifted.join('\n'), 'a resource count did not return to the same plateau after every cycle').toBe('');

  note(
    'suspend-resume',
    `${SUSPEND_CYCLES} round trips in ${Date.now() - t0}ms; plateau ${allocated
      .map((k) => `${k}=${series[k]![0]}`)
      .join(', ')}`,
  );
  expect(epoch?.rejections ?? [], 'the suspend/resume epoch produced protocol rejections').toEqual([]);
  await disposeDocument(page, 'suspend-resume dispose');
  await drainAndValidate(page);
  report.durationsMs.suspendResume = Date.now() - t0;
});

test('RESUME_DOCUMENT restores the rAF-driven render loop, not only the timers', async () => {
  note('raf-resume', 'one activation, one suspend, one resume, frame counter read on both sides');
  // A resumed document that never renders again is not resumed: the resident pool suspends every
  // off-screen document and resumes the one it is about to show, so a scene whose loop is dead
  // after its first suspension is a frozen picture with a live acknowledgement path.
  await bootDocument(page, V3A);
  const act = await presentActivation(page, V3A, 'raf-resume subject');
  await activateSection(page, act);

  const a = await requireSection(page, V3A, 'raf-resume');
  await page.waitForTimeout(DWELL_MS);
  const b = await requireSection(page, V3A, 'raf-resume');
  expect(b.frames, 'the loop was not running before the suspend — the assertion below would be vacuous').toBeGreaterThan(a.frames);

  await suspendSnapshot(page, 'raf-resume suspend');
  await resumeDocument(page, 'raf-resume resume');

  const c = await requireSection(page, V3A, 'raf-resume');
  await page.waitForTimeout(DWELL_MS * 3);
  const d = await requireSection(page, V3A, 'raf-resume');
  note('raf-resume', `frames before suspend +${b.frames - a.frames}; frames after resume +${d.frames - c.frames}`);
  expect(
    d.frames,
    'the section rAF loop never resumed after RESUME_DOCUMENT — the callback is still registered ' +
      'and counted by the scope, but nothing re-requests a frame for it',
  ).toBeGreaterThan(c.frames);

  await drainAndValidate(page);
  await disposeDocument(page, 'raf-resume dispose');
  await drainAndValidate(page);
});

test('PAUSE_AUTOMATION keeps stopping the automation it acknowledges, round trip after round trip', async () => {
  note('automation-stability', 'three pauses: fresh, after an automation resume, after a document resume');
  /**
   * The stability half of the automation contract. PAUSE_AUTOMATION is acknowledged
   * UNCONDITIONALLY, so the acknowledgement can never be the evidence — the tick counter has to be.
   *
   * Three stages, measured separately so a failure names its own trigger: the first pause, a pause
   * after the automation has been resumed once, and a pause after a whole-document suspend/resume.
   * Both of the later two re-arm the underlying timer, which is exactly the moment a registry that
   * remembers the ORIGINAL handle would lose track of it.
   */
  await bootDocument(page, V3A);
  const act = await presentActivation(page, V3A, 'automation subject');
  await activateSection(page, act);

  const pauseAndMeasure = async (label: string): Promise<number> => {
    const cursor = await mark(page);
    await send(page, PAUSE_AUTOMATION, {}, act);
    await waitForEnvelope(
      page,
      { type: AUTOMATION_PAUSED, activationId: act.activationId, after: cursor },
      SIM_PRESENT_TIMEOUT_MS,
      label,
    );
    const before = await requireSection(page, V3A, label);
    await page.waitForTimeout(DWELL_MS * 2);
    const after = await requireSection(page, V3A, label);
    return after.ticks - before.ticks;
  };

  const resumeAutomation = async (label: string): Promise<void> => {
    await send(page, RESUME_AUTOMATION, {}, act);
    await settle(page);
    const before = await requireSection(page, V3A, label);
    await page.waitForTimeout(DWELL_MS);
    const after = await requireSection(page, V3A, label);
    expect(after.ticks, `${label}: the automation timer did not restart after RESUME_AUTOMATION`).toBeGreaterThan(
      before.ticks,
    );
  };

  const first = await pauseAndMeasure('first pause');
  await resumeAutomation('first resume');
  const second = await pauseAndMeasure('pause after an automation resume');
  await resumeAutomation('second resume');
  await suspendSnapshot(page, 'automation suspend');
  await resumeDocument(page, 'automation resume');
  const third = await pauseAndMeasure('pause after a document suspend/resume');

  note('automation-stability', `ticks accrued while "paused": first=${first}, second=${second}, third=${third}`);
  // Control first: if this fails, nothing below is about round trips at all.
  expect(first, 'PAUSE_AUTOMATION did not stop the automation timer on a fresh activation').toBe(0);
  expect(
    second,
    'AUTOMATION_PAUSED was acknowledged but the automation kept ticking on the SECOND pause — ' +
      'the parent is told the scene is paused while it is not',
  ).toBe(0);
  expect(
    third,
    'AUTOMATION_PAUSED was acknowledged but the automation kept ticking after a document ' +
      'suspend/resume round trip',
  ).toBe(0);

  await drainAndValidate(page);
  await disposeDocument(page, 'automation dispose');
  await drainAndValidate(page);
});

// ── 3. full document epochs ──────────────────────────────────────────────────────────────────

test(`${DOC_EPOCHS} full document epochs: DISPOSED reports an empty leak list every time`, async () => {
  note('doc-epochs', `${DOC_EPOCHS} epochs, each a real mount → init → activate → DISPOSE_DOCUMENT`);
  const t0 = Date.now();
  const leaks: string[] = [];
  const nonZero: string[] = [];
  const residual: string[] = [];

  for (let e = 0; e < DOC_EPOCHS; e++) {
    const variant = e % 2 === 0 ? V3A : V3B;
    await bootDocument(page, variant);

    // The document's own baseline, before any activation exists. Post-dispose state is compared to
    // THIS rather than to zero: the entry document and the injected rAF gate legitimately own a
    // frame of their own at load, and demanding zero would fail a clean teardown for something the
    // section never allocated.
    const baseline = await requireObs(page, `epoch ${e + 1} baseline`);

    const act = await presentActivation(page, variant, `epoch ${e + 1}`);
    await activateSection(page, act);
    await page.waitForTimeout(60);

    const live = await requireObs(page, `epoch ${e + 1} live`);
    expect(
      live.liveIntervals,
      `epoch ${e + 1}: the activation armed no native interval — the teardown assertion would be vacuous`,
    ).toBeGreaterThan(baseline.liveIntervals);

    const disposed = await disposeDocument(page, `epoch ${e + 1} dispose`);
    const leaked = Array.isArray(disposed.leaked) ? disposed.leaked : [];
    if (leaked.length > 0) leaks.push(`epoch ${e + 1}: ${leaked.join(', ')}`);

    const counts = disposed.counts as Partial<SimResourceCounts> | undefined;
    for (const k of COUNT_KINDS) {
      const n = counts?.[k];
      if (typeof n !== 'number') nonZero.push(`epoch ${e + 1}: ${k} not reported`);
      else if (n !== 0) nonZero.push(`epoch ${e + 1}: ${k}=${n}`);
    }

    // Independent teardown proof: the natives the activation armed are gone.
    await settle(page);
    const after = await requireObs(page, `epoch ${e + 1} after dispose`);
    if (after.liveIntervals > baseline.liveIntervals) {
      residual.push(`epoch ${e + 1}: ${after.liveIntervals} live native interval(s) (baseline ${baseline.liveIntervals})`);
    }
    if (after.listeners > baseline.listeners) {
      residual.push(`epoch ${e + 1}: ${after.listeners} durable listener(s) (baseline ${baseline.listeners})`);
    }

    const state = await readSection(page, LABEL_OF[variant], V3_STATE_GLOBAL);
    expect(state?.disposed, `epoch ${e + 1}: the section's own dispose() was never called`).toBe(true);

    await drainAndValidate(page);
    expect(epoch?.rejections ?? [], `epoch ${e + 1} produced protocol rejections`).toEqual([]);
  }

  note('doc-epochs', `${DOC_EPOCHS} epochs in ${Date.now() - t0}ms`);
  expect(leaks.join('\n'), 'DISPOSED reported leaked resources').toBe('');
  expect(nonZero.join('\n'), 'DISPOSED reported a non-zero resource count').toBe('');
  expect(residual.join('\n'), 'the child document still holds resources the activation armed').toBe('');
  report.durationsMs.docEpochs = Date.now() - t0;
});

// ── 4. a cleanup error must be NAMED ─────────────────────────────────────────────────────────

test('a tracked resource whose dispose throws is NAMED in the leak report, not swallowed', async () => {
  note('cleanup-error', 'the section-tracked glTextures resource is made to throw on release');
  await bootDocument(page, V3A);
  const act = await presentActivation(page, V3A, 'poison subject');
  await activateSection(page, act);

  /**
   * Poison the tracked resource the section registered as a GPU texture.
   *
   * A property whose SETTER throws is used rather than Object.freeze: freezing only throws in strict
   * mode, and a leak report that looked healthy purely because the emitted runtime was parsed
   * sloppily would be the most misleading possible pass. This throws in every mode and every engine.
   * Nothing about the runtime is touched — this is a section-owned resource refusing to release,
   * which is exactly the case the report exists to describe.
   */
  const poisoned = await page.evaluate(
    (args) => {
      const f = document.querySelector('#stage iframe') as HTMLIFrameElement | null;
      const w = f?.contentWindow as unknown as Record<string, Record<string, Record<string, unknown>>> | null;
      const state = w && w[args.stateGlobal] ? w[args.stateGlobal][args.label] : null;
      const tex = state ? (state.texture as object | null) : null;
      if (!tex) return false;
      Object.defineProperty(tex, 'disposed', {
        configurable: false,
        get() {
          return false;
        },
        set() {
          throw new Error('leak-canary: this tracked resource refuses to release');
        },
      });
      return true;
    },
    { label: LABEL_OF[V3A], stateGlobal: V3_STATE_GLOBAL },
  );
  expect(poisoned, 'the fixture published no tracked texture to poison — this test would prove nothing').toBe(true);

  const disposed = await disposeDocument(page, 'poisoned dispose');
  const leaked = Array.isArray(disposed.leaked) ? disposed.leaked : [];
  const counts = disposed.counts as Partial<SimResourceCounts> | undefined;
  note('cleanup-error', `leaked=${JSON.stringify(leaked)} glTextures=${String(counts?.glTextures)}`);

  expect(
    leaked.length,
    'a tracked resource whose dispose threw was reported as a CLEAN dispose — the leak report is ' +
      'structurally incapable of being non-empty and proves nothing about any package',
  ).toBeGreaterThan(0);
  expect(
    leaked.join(' | '),
    'the leak report does not NAME the resource kind that failed to release',
  ).toContain('glTextures');
  expect(
    leaked.some((l) => /dispose-threw/.test(l)),
    `the leak report does not say WHY the resource survived: ${leaked.join(' | ')}`,
  ).toBe(true);
  expect(
    counts?.glTextures,
    'the failed release was still counted down — a counter that decrements on a throw cannot ' +
      'detect the leak it exists to detect',
  ).toBe(1);

  await drainAndValidate(page);
  expect(epoch?.rejections ?? [], 'the poisoned-dispose epoch produced protocol rejections').toEqual([]);
});

// ── 5. a startup error leaves the document usable ────────────────────────────────────────────

test('a section whose prepare() throws leaves the document usable for the next activation', async () => {
  note('startup-error', 'V3THROWPREPARE, then a healthy activation in the same document');
  await bootDocument(page, V3THROWPREPARE);

  const bad: ActivationIdentity = {
    activationId: newActivationId(),
    variantKey: V3THROWPREPARE,
    configHash: CONFIG_HASH,
  };
  const cursor = await mark(page);
  await send(page, PREPARE_SECTION, { variantKey: V3THROWPREPARE, config: CONFIG }, bad);
  const errEnv = await waitForEnvelope(
    page,
    { type: SECTION_ERROR, activationId: bad.activationId, after: cursor },
    SIM_PREPARE_TIMEOUT_MS,
    'throwing prepare',
  );
  const err = errEnv.payload as SectionErrorPayload;
  expect(err.stage, 'the failure was not attributed to prepare').toBe('prepare');
  expect(err.recoverable, 'a prepare failure was reported as unrecoverable').toBe(true);

  // No SECTION_APPLIED may exist for an activation that never applied.
  const applied = await page.evaluate(
    (id) =>
      (window as unknown as LeakWindow).__leak
        .peek()
        .some((r) => r.data.type === 'SECTION_APPLIED' && r.data.activationId === id),
    bad.activationId,
  );
  expect(applied, 'the runtime acknowledged SECTION_APPLIED for a section whose prepare() threw').toBe(false);

  // The document must still work. This is the whole claim of `recoverable: true`.
  const good = await presentActivation(page, V3A, 'post-error activation');
  await activateSection(page, good);
  const s = await requireSection(page, V3A, 'post-error activation');
  expect(s.presented, 'the recovered activation never rendered').toBeGreaterThan(0);

  // And the failed activation must not have left its scope behind.
  const suspended = await suspendSnapshot(page, 'post-error suspend');
  const counts = suspended.counts as Partial<SimResourceCounts>;
  expect(
    counts.intervals,
    'the failed activation leaked its scope: more intervals are live than the one activation owns',
  ).toBeLessThanOrEqual(DEFAULT_PLATEAUS.intervals!.max);
  await resumeDocument(page, 'post-error resume');
  note('startup-error', `recovered; counts after recovery ${JSON.stringify(counts)}`);

  await drainAndValidate(page);
  const rejections = epoch?.rejections ?? [];
  expect(rejections, 'the startup-error epoch produced protocol rejections').toEqual([]);
  await disposeDocument(page, 'startup-error dispose');
  await drainAndValidate(page);
});

// ── 6. WebGL context loss ────────────────────────────────────────────────────────────────────

interface GlAttempt {
  ok: boolean;
  why: string;
  synthetic: boolean;
  pixel: number[] | null;
}

test('WebGL context loss is reported and the presented picture is invalidated', async () => {
  /**
   * The fixture's only canvas takes a 2d context during document load (ENTRY_HTML paints it in its
   * own rAF), and a canvas that already has a 2d context can never return a WebGL one. So the
   * WebGL surface is inserted BEFORE the bootstrap offer — the runtime's `wireContextEvents()` runs
   * once, at adoption, over `getElementsByTagName('canvas')`, so a canvas present at that moment is
   * covered by the runtime's OWN listeners. What is proven is therefore the runtime's reporting
   * path on a real WebGL context, not the fixture scene's context; that distinction is recorded.
   */
  note('context-loss', 'a WebGL surface is staged before the bootstrap so the runtime wires its own listeners to it');
  let attempt: GlAttempt = { ok: false, why: 'not attempted', synthetic: true, pixel: null };
  await bootDocument(page, V3A, async () => {
    attempt = (await page.evaluate(() => {
      const f = document.querySelector('#stage iframe') as HTMLIFrameElement | null;
      const doc = f?.contentDocument ?? null;
      const win = f?.contentWindow as unknown as Record<string, unknown> | null;
      if (!doc || !win) return { ok: false, why: 'the child document is unreadable', synthetic: true, pixel: null };
      const cv = doc.createElement('canvas');
      cv.width = 8;
      cv.height = 8;
      cv.id = '__leakGl';
      // Smaller than the fixture's own canvas so measureCanvas() keeps reporting the scene's size.
      cv.style.cssText = 'position:absolute;left:-100px;top:-100px;width:8px;height:8px';
      doc.body.appendChild(cv);
      let gl: WebGLRenderingContext | null = null;
      try {
        gl = (cv.getContext('webgl2') ?? cv.getContext('webgl')) as WebGLRenderingContext | null;
      } catch {
        gl = null;
      }
      if (!gl) return { ok: false, why: 'this engine provides no WebGL context', synthetic: true, pixel: null };
      const ext = gl.getExtension('WEBGL_lose_context');
      if (!ext) return { ok: false, why: 'this engine provides no WEBGL_lose_context extension', synthetic: true, pixel: null };
      (win as { __leakGl?: unknown }).__leakGl = { gl, ext };
      return { ok: true, why: '', synthetic: true, pixel: null };
    })) as GlAttempt;
  });

  if (!attempt.ok) {
    // ASSERTED, never skipped: the reason must be one of the two the harness recognises, so a
    // silent failure to even try cannot masquerade as an engine limitation.
    expect(
      attempt.why,
      'context loss could not be attempted, and not because the engine lacks the capability',
    ).toMatch(/no WebGL context|no WEBGL_lose_context extension/);
    notApplicable('context-loss', `${attempt.why} — CONTEXT_LOST could not be exercised in this engine`);
    note('context-loss', `NOT APPLICABLE: ${attempt.why}`);
    await drainAndValidate(page);
    await disposeDocument(page, 'context-loss dispose');
    await drainAndValidate(page);
    return;
  }

  const act = await presentActivation(page, V3A, 'context-loss subject');
  await activateSection(page, act);

  // Put a picture in the drawing buffer and prove it is there.
  const drawn = await page.evaluate(() => {
    const f = document.querySelector('#stage iframe') as HTMLIFrameElement | null;
    const holder = (f?.contentWindow as unknown as { __leakGl?: { gl: WebGLRenderingContext } })?.__leakGl;
    if (!holder) return null;
    const gl = holder.gl;
    gl.clearColor(1, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const px = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return Array.from(px);
  });
  expect(drawn, 'nothing could be drawn into the WebGL surface — the invalidation check would be vacuous').not.toBeNull();
  expect(drawn, 'the WebGL surface did not hold the colour it was just cleared to').toEqual([255, 0, 0, 255]);

  const lossCursor = await mark(page);
  await page.evaluate(() => {
    const f = document.querySelector('#stage iframe') as HTMLIFrameElement | null;
    const holder = (f?.contentWindow as unknown as { __leakGl?: { ext: WEBGL_lose_context } })?.__leakGl;
    holder?.ext.loseContext();
  });
  await waitForEnvelope(page, { type: CONTEXT_LOST, after: lossCursor }, SIM_PRESENT_TIMEOUT_MS, 'context loss');

  const afterLoss = await page.evaluate(() => {
    const f = document.querySelector('#stage iframe') as HTMLIFrameElement | null;
    const holder = (f?.contentWindow as unknown as { __leakGl?: { gl: WebGLRenderingContext } })?.__leakGl;
    if (!holder) return null;
    const gl = holder.gl;
    let px: number[] | null = null;
    try {
      const buf = new Uint8Array(4);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      px = Array.from(buf);
    } catch {
      px = null;
    }
    return { lost: gl.isContextLost(), pixel: px };
  });
  expect(afterLoss?.lost, 'CONTEXT_LOST was reported for a context that is not lost').toBe(true);
  expect(
    afterLoss?.pixel,
    'the drawing buffer still holds the picture that was presented before the context was lost — ' +
      'the presented state was not invalidated',
  ).not.toEqual([255, 0, 0, 255]);

  const restoreCursor = await mark(page);
  await page.evaluate(() => {
    const f = document.querySelector('#stage iframe') as HTMLIFrameElement | null;
    const holder = (f?.contentWindow as unknown as { __leakGl?: { ext: WEBGL_lose_context } })?.__leakGl;
    holder?.ext.restoreContext();
  });
  await waitForEnvelope(page, { type: CONTEXT_RESTORED, after: restoreCursor }, SIM_CONTEXT_RESTORE_TIMEOUT_MS, 'context restore');

  // A restored context is only useful if the document can present into it again.
  const revived = await presentActivation(page, V3A, 'post-restore activation');
  await activateSection(page, revived);
  note('context-loss', 'lost and restored on a WebGL context the runtime wired itself; re-presented after restore');

  await drainAndValidate(page);
  expect(epoch?.rejections ?? [], 'the context-loss epoch produced protocol rejections').toEqual([]);
  await disposeDocument(page, 'context-loss dispose');
  await drainAndValidate(page);
});

// ── 6b. the rest of the suspension contract, on real resources ───────────────────────────────

test('a suspended document stops a real Web Animation and a real HTML media element', async () => {
  note('suspension-contract', 'a real Web Animation and a real muted data-URI <audio> in the child document');
  /**
   * The fixture's managed body allocates a rAF loop and an automation interval — proven frozen a
   * hundred times over in scenario 2 — but no Web Animation and no media element, and the
   * suspension contract names both. They are created here, in the child document, so that
   * `collectAnimations()` and `collectMedia()` (which scan the DOCUMENT, not the scope's registry)
   * have something real to stop. The media is a generated silent WAV data URI: no network, no
   * fixture asset, and muted so no autoplay policy can refuse it.
   */
  await bootDocument(page, V3A);
  const act = await presentActivation(page, V3A, 'contract subject');
  await activateSection(page, act);

  const wav = silentWavDataUri();
  const started = await page.evaluate(async (src) => {
    const f = document.querySelector('#stage iframe') as HTMLIFrameElement | null;
    const doc = f?.contentDocument ?? null;
    if (!doc) return { animation: false, media: false, why: 'unreadable document' };
    const marker = doc.getElementById('marker');
    let animation = false;
    if (marker && typeof marker.animate === 'function') {
      const anim = marker.animate([{ opacity: 1 }, { opacity: 0.5 }], { duration: 100000, iterations: Infinity });
      (window as unknown as { __leakAnim?: Animation }).__leakAnim = anim;
      // 'pending' is not in the DOM enum: a freshly started animation reports 'running' immediately
      // and only reaches 'idle'/'finished' once it is over, so anything else means it is live.
      animation = anim.playState !== 'idle' && anim.playState !== 'finished';
    }
    const audio = doc.createElement('audio');
    audio.src = src;
    audio.loop = true;
    audio.muted = true;
    doc.body.appendChild(audio);
    let media = false;
    try {
      await audio.play();
      media = !audio.paused;
    } catch {
      media = false;
    }
    return { animation, media, why: '' };
  }, wav);

  const obsLive = await requireObs(page, 'contract live');
  expect(
    started.animation && obsLive.animations > 0,
    'no Web Animation could be created in the child document — the suspension assertion would be vacuous',
  ).toBe(true);

  let mediaExercised = started.media && obsLive.mediaPlaying > 0;
  if (!mediaExercised) {
    // Recorded, not hidden: the freeze assertion below still runs, and the report says that the
    // media half of the contract was not exercised with a playing element in this engine.
    notApplicable('suspension-contract', 'this engine would not start a muted data-URI <audio> element');
  }

  // Let the animation actually advance before the suspension, or "frozen" means nothing.
  const t0 = await page.evaluate(() => {
    const a = (window as unknown as { __leakAnim?: Animation }).__leakAnim;
    return a ? Number(a.currentTime ?? 0) : -1;
  });
  await page.waitForTimeout(DWELL_MS);
  const t1 = await page.evaluate(() => {
    const a = (window as unknown as { __leakAnim?: Animation }).__leakAnim;
    return a ? Number(a.currentTime ?? 0) : -1;
  });
  expect(t1, 'the Web Animation was not advancing before the suspend').toBeGreaterThan(t0);

  const suspended = await suspendSnapshot(page, 'contract suspend');
  expect(
    (suspended.unstoppable ?? []).join(', '),
    'the document reported resources it could not stop while a real animation/media element was live',
  ).toBe('');

  // ONE frame of grace before the baseline is taken, and only for the animation.
  // `Animation.pause()` is specified to defer setting the hold time to a pause task that runs at
  // the next frame update, so `currentTime` legitimately advances for up to one frame after the
  // call — a baseline captured inside that window would make this assertion flaky rather than
  // strict. The dwell that follows is twenty times longer, so a genuinely running animation still
  // fails by two orders of magnitude. Frames, ticks and media need no such grace: the scope
  // cancels and clears those synchronously, inside the SUSPEND_DOCUMENT handler.
  await settle(page);
  const t2 = await page.evaluate(() => {
    const a = (window as unknown as { __leakAnim?: Animation }).__leakAnim;
    return a ? Number(a.currentTime ?? 0) : -1;
  });
  const obsSuspended = await requireObs(page, 'contract suspended');
  await page.waitForTimeout(DWELL_MS * 2);
  const t3 = await page.evaluate(() => {
    const a = (window as unknown as { __leakAnim?: Animation }).__leakAnim;
    return a ? Number(a.currentTime ?? 0) : -1;
  });
  const obsAfter = await requireObs(page, 'contract suspended');

  expect(t3, 'the Web Animation kept advancing while the document was suspended').toBe(t2);
  expect(obsAfter.animationsRunning, 'a Web Animation was still running while the document was suspended').toBe(0);
  expect(obsSuspended.mediaPlaying, 'an HTML media element was still playing at the moment of suspension').toBe(0);
  expect(obsAfter.mediaPlaying, 'an HTML media element was playing while the document was suspended').toBe(0);
  expect(obsAfter.workersConstructed, 'a Worker was constructed in this document').toBe(0);
  expect(obsAfter.audioContextsConstructed, 'an AudioContext was constructed in this document').toBe(0);
  note(
    'suspension-contract',
    `animation frozen at ${t2}; media exercised=${mediaExercised}; workers=${obsAfter.workersConstructed}; ` +
      `audioContexts=${obsAfter.audioContextsConstructed}`,
  );

  await resumeDocument(page, 'contract resume');
  // Cancel what this test introduced before tearing the document down: a still-running animation is
  // a genuine `after-dispose:animation-still-running` leak, and it would be THIS test's leak, not
  // the package's.
  await page.evaluate(() => {
    const anim = (window as unknown as { __leakAnim?: Animation }).__leakAnim;
    try {
      anim?.cancel();
    } catch {
      /* already finished */
    }
    const f = document.querySelector('#stage iframe') as HTMLIFrameElement | null;
    const audio = f?.contentDocument?.querySelector('audio');
    audio?.pause();
    audio?.remove();
  });
  await drainAndValidate(page);
  const disposedPayload = await disposeDocument(page, 'contract dispose');
  expect(
    (disposedPayload.leaked ?? []).join(', '),
    'disposing the document after a real animation and media element reported a leak',
  ).toBe('');
  await drainAndValidate(page);
});

// ── 7. backgrounding ─────────────────────────────────────────────────────────────────────────

test('a suspended document does not advance while the page is hidden and backgrounded', async () => {
  note('background', `visibilitychange + a real focus shift, ${BACKGROUND_MS}ms per measurement window`);
  await bootDocument(page, V3A);
  const act = await presentActivation(page, V3A, 'background subject');
  await activateSection(page, act);

  const a = await requireSection(page, V3A, 'background liveness');
  await page.waitForTimeout(DWELL_MS);
  const b = await requireSection(page, V3A, 'background liveness');
  expect(b.frames, 'the rAF loop was not advancing before backgrounding').toBeGreaterThan(a.frames);
  expect(b.ticks, 'the automation timer was not advancing before backgrounding').toBeGreaterThan(a.ticks);

  // CONTROL: a backgrounded page still runs interval timers (throttled). Measured with the document
  // RESUMED, so the assertion that follows is about the SUSPENSION and not about the throttling.
  const other = await context.newPage();
  await other.goto('about:blank');
  await other.bringToFront();
  const cResume = await requireSection(page, V3A, 'background control');
  await page.waitForTimeout(BACKGROUND_MS);
  const dResume = await requireSection(page, V3A, 'background control');
  const controlTicks = dResume.ticks - cResume.ticks;
  const controlFrames = dResume.frames - cResume.frames;
  // What the engine actually did with the focus shift. Recorded rather than assumed: a headless
  // engine may keep a non-foreground page fully visible and fully scheduled, and if it does then
  // the freeze measured below is attributable to the SUSPENSION alone with nothing to argue about.
  const visibility = await page.evaluate(() => ({
    state: document.visibilityState,
    hidden: document.hidden,
    hasFocus: document.hasFocus(),
  }));
  await page.bringToFront();

  note(
    'background',
    `control (resumed, backgrounded ${BACKGROUND_MS}ms): ticks +${controlTicks}, frames +${controlFrames}; ` +
      `page reported visibilityState='${visibility.state}' hidden=${visibility.hidden} focus=${visibility.hasFocus}`,
  );
  expect(
    controlTicks,
    'a backgrounded but RESUMED document advanced nothing at all, so the suspended measurement ' +
      'below could not tell suspension apart from the browser throttling a hidden page',
  ).toBeGreaterThan(0);

  // The visibility event a real backgrounding fires, dispatched explicitly in both documents: the
  // runtime must not need it, and must not be broken by it.
  await page.evaluate(() => {
    document.dispatchEvent(new Event('visibilitychange'));
    const f = document.querySelector('#stage iframe') as HTMLIFrameElement | null;
    f?.contentDocument?.dispatchEvent(new Event('visibilitychange'));
  });

  const suspended = await suspendSnapshot(page, 'background suspend');
  expect((suspended.unstoppable ?? []).join(', '), 'the suspended document could not stop something').toBe('');

  const beforeBg = await requireSection(page, V3A, 'background suspended');
  const obsBefore = await requireObs(page, 'background suspended');
  await other.bringToFront();
  await page.waitForTimeout(BACKGROUND_MS);
  const afterBg = await requireSection(page, V3A, 'background suspended');
  const obsAfter = await requireObs(page, 'background suspended');
  await page.bringToFront();
  await other.close();

  expect(afterBg.frames, 'a suspended, backgrounded document advanced its frame counter').toBe(beforeBg.frames);
  expect(afterBg.ticks, 'a suspended, backgrounded document advanced its automation counter').toBe(beforeBg.ticks);
  expect(obsAfter.rafFired, 'native rAF callbacks ran in a suspended, backgrounded document').toBe(obsBefore.rafFired);
  note(
    'background',
    `suspended + backgrounded ${BACKGROUND_MS}ms: frames +${afterBg.frames - beforeBg.frames}, ` +
      `ticks +${afterBg.ticks - beforeBg.ticks}`,
  );

  // And it comes back.
  await resumeDocument(page, 'background resume');
  const revived = await presentActivation(page, V3A, 'post-background activation');
  await activateSection(page, revived);

  await drainAndValidate(page);
  expect(epoch?.rejections ?? [], 'the backgrounding epoch produced protocol rejections').toEqual([]);
  await disposeDocument(page, 'background dispose');
  await drainAndValidate(page);
});

// ── the run itself must be clean ─────────────────────────────────────────────────────────────

test('every contracted scenario actually ran and was recorded', () => {
  // A scenario that never executed must never read as a pass. The per-test cleanliness check lives
  // in afterEach; this is the completeness gate, and it reads the merged report so a scenario that
  // ran in an earlier worker generation still counts.
  const seen = recordedScenarios();
  const missing = REQUIRED_SCENARIOS.filter((s) => !seen.has(s));
  expect(missing.join(', '), 'these contracted scenarios recorded no observation at all').toBe('');
});

// ─── helpers ──────────────────────────────────────────────────────────────────────────────────

/**
 * A one-second silent 8 kHz mono WAV as a data URI.
 *
 * Generated rather than fetched: the suite is hermetic, and a media element is the only way to
 * exercise the media half of the suspension contract on a fixture that ships no audio.
 */
function silentWavDataUri(): string {
  const rate = 8000;
  const samples = rate;
  const buf = Buffer.alloc(44 + samples);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate, 28);
  buf.writeUInt16LE(1, 32);
  buf.writeUInt16LE(8, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples, 40);
  buf.fill(128, 44); // 8-bit PCM silence is 0x80, not 0x00
  return `data:audio/wav;base64,${buf.toString('base64')}`;
}
