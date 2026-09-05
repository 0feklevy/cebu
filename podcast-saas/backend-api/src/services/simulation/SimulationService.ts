import { simLegacyTextCache } from './simTextCache.js';
import { createHash } from 'crypto';
import { z } from 'zod';
import type { StorageService } from '../storage/StorageService.js';
import { LLMService } from '../llm/LLMService.js';
import { db } from '../../db/index.js';
import { simulations, system_prompts, video_files } from '../../db/schema.js';
import { asc, eq } from 'drizzle-orm';
import { projectOrientation } from 'shared/video/orientation';
import { logger } from '../../lib/logger.js';
import { mapWithLimit } from '../../lib/mapWithLimit.js';
import { SIM_SCANNER_SOURCE } from './simScannerSource.js';
import { assertSafeZipArchive } from '../security/zipGuard.js';
import { CAPTURE_AUTHORING_RULES } from 'shared/sim/captureAuthoring';
import { buildUiControlsPromptBlock, type SimUiSelection } from './SimUiControls.js';
import { buildChildRuntimeSource } from './simRuntimeChild.js';
import {
  isSystemOwnedKey, isSystemOwnedRelPath, revisionIdFromKey,
  revisionFileKey, revisionManifestKey, PACKAGE_SUBDIR,
} from 'shared/sim/simRevision';
// The staged-immutable publication machinery (Priority 7). NOT circular: RevisionService does not
// import this module. RevisionMigration DOES (deriveEntryRelPath/getSimulationContentType), so its
// helpers are pulled in lazily inside uploadSectionBridge — same pattern as GuidanceService.
import { RevisionService, type RevisionDbTx } from './RevisionService.js';
// The ONE staging primitive every in-place writer becomes: derive from the ACTIVE revision →
// transform → draft/upload/validate → compare-and-set activate (audit D-04). NOT circular:
// RevisionDerivation imports RevisionService and the schema, never this module.
import { deriveRevision, derivedCapabilities, type DerivedFile } from './RevisionDerivation.js';
import {
  bundleRelPathForManifestPath,
  manifestPathForBundleRel,
  packageRootRelPath,
} from './revisionPackagePaths.js';
import {
  BRIDGE_CAPABILITIES_KEY,
  detectBridgeCapabilities,
  detectEntryCapabilities,
  type BridgeCapabilities,
} from 'shared/sim/bridgeCapability';
import type {
  SimManifest as SimPackageManifest,
  SimManifestFile,
  SimFileRole,
} from 'shared/sim/simManifest';

// ── Public types ──────────────────────────────────────────────────────────────

export type ConversationMessage = { role: 'user' | 'assistant'; content: string };

export interface BridgeFunction {
  name:        string;
  windowFn:    string;
  description: string;
}

// Structured info extracted from simulation source files
export interface SimManifest {
  controls:        SimControl[];
  buttons:         SimButton[];
  sections:        SimSection[];
  renderFunctions: string[];   // e.g. ["redraw", "draw"]
  updateFunctions: string[];   // e.g. ["updateDerivedPhysics"]
  hasSetSimSection: boolean;
  selectElements:   Array<{ id: string; options: string[] }>;
  checkboxElements: Array<{ id: string; label: string }>;
  canvasElements:   string[];
  globalObjects:    string[];  // detected global libs: Plotly, d3, THREE, p5, etc.
  // Modern runtime-built sims: the UI is created in JS and the API is an object on a window global.
  // These give the LLM verified handles when there are no static HTML ids. (sim-bridge-deepfix)
  runtimeGlobals:   string[];  // `window.__murmuration = ...` → ["__murmuration"]
  instanceMethods:  string[];  // method names defined in classes / invoked as <global>.method(): ["toggleExploreExploit", ...]
  cssControls:      string[];  // control class/id names created via createElement+className / _el('div','controls',…): ["controls", "show-menu-tab", …]
}

interface SimControl {
  id:    string;
  type:  string;
  label: string;
  min?:  string;
  max?:  string;
  step?: string;
  aliases: string[];
}

interface SimButton  { id: string; label: string; }
interface SimSection { id: string; defaultHidden: boolean; childControlIds: string[]; childButtonIds: string[]; }

// The selected LLM provider generates the bridge script directly.
// Phase 5 (multi-file generation) will extend this via a file-operation pipeline —
// not by adding an optional field here. Do not add GeneratedFile or FileOperationType
// until the operation application pipeline exists.
export interface GeneratedBridge {
  message:    string;
  /** LLM writes only the body of SCRIPTS.main — system wraps it in the deterministic template */
  mainBody:   string;
  confidence: number;
  warnings:   string[];
}

/** Structured result returned from generateBridgeScript.
 *  Controller builds sim_meta from these fields — no recomputation needed. */
export interface BridgeGenerationResult {
  sectionUrl:        string;
  conversationHistory: ConversationMessage[];
  sourceHash:        string;
  bridgeHash:        string;
  mainBody:          string;
  provider:          string;
  model:             string;
  confidence:        number;
  confidenceLevel:   'high' | 'medium' | 'low';
  warnings:          string[];
  validationErrors:  string[];  // always empty on success (fatals throw before upload)
  validationWarnings: string[];
  retryCount:        number;
  retryReason:       string | null;
  contextTruncated:  boolean;
}

// Validation result — classified by severity
export interface ValidationResult {
  fatal:    string[];  // Block upload, trigger auto-retry
  warnings: string[];  // Trigger retry if present; save to metadata
  weak:     string[];  // Save to metadata, no retry
}

/**
 * In-transaction persistence hook for section-bridge publication.
 *
 * Runs INSIDE the revision-activation transaction, after the pointer flip — the caller (the
 * sections controller) uses it to update `timeline_sections` in the SAME transaction, so the
 * section row and the activation commit or roll back together. A throw here aborts the whole
 * activation. It is never invoked when the activation loses a compare-and-set.
 */
export type SectionPersistHook = (
  tx: RevisionDbTx,
  pub: { sectionUrl: string; bridgeHash: string },
) => Promise<void>;

/** The abort error every generation path throws — `classifySimulationError` maps it to 'aborted'. */
function generationAbortError(): Error {
  const err = new Error('generation cancelled');
  err.name = 'AbortError';
  return err;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw generationAbortError();
}

// ── Storage content types ─────────────────────────────────────────────────────

/**
 * Fan-out width for staging a revision's files (read from the base + write to storage).
 * 8 mirrors the bounded ZIP-upload waves (backend-010's cap of 12, kept slightly lower here
 * because each worker holds a whole file in memory while it writes): wide enough that a
 * 30MB many-file package is no longer a chain of serial round trips, narrow enough that
 * publication cannot monopolise storage connections.
 */
const REVISION_UPLOAD_CONCURRENCY = 8;

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm:  'text/html; charset=utf-8',
  js:   'application/javascript',
  mjs:  'application/javascript',
  cjs:  'application/javascript',
  jsx:  'text/plain; charset=utf-8',
  ts:   'text/plain; charset=utf-8',
  tsx:  'text/plain; charset=utf-8',
  css:  'text/css',
  json: 'application/json',
  map:  'application/json',
  png:  'image/png',
  apng: 'image/apng',
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  gif:  'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp:  'image/bmp',
  svg:  'image/svg+xml',
  ico:  'image/x-icon',
  woff: 'font/woff',
  woff2:'font/woff2',
  ttf:  'font/ttf',
  otf:  'font/otf',
  mp3:  'audio/mpeg',
  ogg:  'audio/ogg',
  mp4:  'video/mp4',
  webm: 'video/webm',
  wav:  'audio/wav',
  wasm: 'application/wasm',
  glb:  'model/gltf-binary',
  gltf: 'model/gltf+json',
  pdf:  'application/pdf',
  csv:  'text/csv; charset=utf-8',
  md:   'text/markdown; charset=utf-8',
  txt:  'text/plain; charset=utf-8',
  xml:  'application/xml',
  yaml: 'text/yaml; charset=utf-8',
  yml:  'text/yaml; charset=utf-8',
};

const TEXT_SIMULATION_EXTS = new Set([
  'html', 'htm', 'js', 'mjs', 'cjs', 'css', 'json', 'map',
  'ts', 'tsx', 'jsx', 'txt', 'md', 'csv', 'xml', 'yaml', 'yml',
]);

export interface UploadedSimulationFile {
  path:   string;
  buffer: Buffer;
}

export function getSimulationContentType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

export function isTextSimulationFile(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return TEXT_SIMULATION_EXTS.has(ext);
}

function normalizeSimulationPath(rawPath: string): string | null {
  const raw = rawPath.replace(/\\/g, '/').trim();
  if (!raw || raw.startsWith('/') || /^[a-zA-Z]:\//.test(raw)) return null;

  const parts = raw.split('/').filter(part => part && part !== '.');
  if (parts.length === 0) return null;

  if (parts.some(part => part === '..')) {
    throw new Error(`Unsafe file path in simulation bundle: ${rawPath}`);
  }

  // Finder ZIPs include resource forks under __MACOSX plus ._ sidecar files.
  // They are not web assets and can overwrite useful keys if we keep them.
  if (parts.some(part =>
    part === '__MACOSX' ||
    part === '.DS_Store' ||
    part.startsWith('._') ||
    part.startsWith('.'),
  )) {
    return null;
  }

  const normalized = parts.join('/');
  if (normalized.length > 512) {
    throw new Error(`File path is too long in simulation bundle: ${rawPath}`);
  }
  // RESERVED NAMESPACES. `revisions/` and `posters/` under this prefix belong to the system, and a
  // bundle writing there is not a traversal — it is an in-bounds path that lands on immutable
  // bytes. Revision ids are public (they appear inside `simulation_url` in every player config)
  // and revision objects are served `max-age=31536000, immutable`, so a bundle entry named
  // `revisions/<active-id>/package/app.js` would replace verified content in place and pin the
  // replacement for a year with no revalidation. Thrown, not silently dropped: unlike a __MACOSX
  // sidecar, this is a real asset the author expects to be served, and skipping it quietly would
  // publish a package missing a file.
  if (isSystemOwnedRelPath(normalized)) {
    throw new Error(
      `Simulation bundles may not write into the reserved "${normalized.split('/')[0]}/" `
      + `directory: ${rawPath}`,
    );
  }
  return normalized;
}

// ── BRIDGE_TEMPLATE (injected at upload time) ─────────────────────────────────
// Uses requestAnimationFrame so SIM_READY fires AFTER the sim's own boot() has run.
// (Sim typically does: DOMContentLoaded → requestAnimationFrame(boot). Without RAF here
//  SIM_READY would fire before boot() completes, causing SCRIPTS.main to run on an
//  uninitialised simulation.)

const BRIDGE_TEMPLATE = /* js */ `;(function(){
  var _ready=false,_cancel=null,_scripts={};
  function fireReady(){
    if(_ready)return;_ready=true;window._simReadyFired=true;
    window.parent&&window.parent.postMessage({type:'SIM_READY'},'*');
  }
  if(document.readyState==='loading')
    document.addEventListener('DOMContentLoaded',function(){requestAnimationFrame(fireReady)});
  else requestAnimationFrame(fireReady);
  setTimeout(fireReady,3000);
  var _discovered=__SIM_BRIDGE_FUNCTIONS__;
  _discovered.forEach(function(fn){
    _scripts[fn.name]=function(){var f=window[fn.windowFn];if(typeof f==='function')f();};
  });
  _scripts['auto']=function(){
    _discovered.forEach(function(fn){var f=window[fn.windowFn];if(typeof f==='function'){try{f();}catch(e){}}});
  };
  function startScript(name){
    if(_cancel){try{_cancel();}catch(e){}_cancel=null;}
    var fn=_scripts[name]||_scripts['auto'];
    if(fn){try{_cancel=fn()||null;}catch(e){}}
  }
  window.addEventListener('message',function(e){
    // Only our own parent — see the guard note on the combined bridge (simulation-004).
    if(e.source!==window.parent)return;
    var d=e.data||{};
    if(d.type==='startScript')startScript(d.script||'auto');
    if(d.type==='stopScript'&&_cancel){try{_cancel();}catch(e){}_cancel=null;}
    if(d.type==='PING_SIM_READY'&&_ready)
      window.parent&&window.parent.postMessage({type:'SIM_READY'},'*');
  });
  document.addEventListener('pointerdown',function(){
    window.parent&&window.parent.postMessage({type:'userInteraction'},'*');
  },{capture:true});
})();`;

// ── rAF gate (head-injected, runs BEFORE the sim's own scripts) ───────────────
// Real pause/freeze protocol for unmodified sims: the player posts {type:'simPause'} /
// {type:'simResume'} (e.g. when the sim overlay is hidden/shown) and the gate freezes /
// resumes every requestAnimationFrame-driven loop in the iframe — sim, bridge.js and
// guidance.js alike — without touching the sim's own code.
//
// Design constraints (keep in sync with the tests in __tests__/rafGate.test.ts):
//  - Injected at the START of <head> so the wrapper is installed before any sim script runs.
//  - Strictly message-driven: NO extra visibilitychange logic (the browser already throttles
//    rAF on hidden tabs natively; adding our own would double-pause sims that self-manage
//    simPause/simResume — the flagship sims stop their own loop, which is harmless here
//    because a stopped loop simply never requests a frame while paused).
//  - While paused, callbacks are queued (each function once) instead of scheduled; on resume
//    they are re-scheduled via the NATIVE rAF, so frame timestamps stay native — never fabricated.
//  - Accepts messages only from window.parent, matching the bridge listener (simulation-004).
//    Origin is deliberately NOT pinned: the gate is stored inside the entry HTML at publication
//    time, and the export capture backend posts from the document itself.
//  - Exposes window.__SIM_ENV parsed once from the iframe's own URL query params
//    (lowend / dpr / mem / section) — an enabler sims may consult later.
//  - v3: answers {type:'listSimControls'} with {type:'simControlsList', controls} — a runtime
//    scan of the LIVE DOM's interactive controls for the Minimal-UI picker. It scans ALL
//    matching elements: visible ones fill the 100 cap first, then hidden ones (display:none
//    menus like an "Advanced Mode" disclosure) are appended flagged hidden:true. Labels come
//    from an ordered ladder (aria-label → aria-labelledby → label[for] → wrapping label minus
//    the control's own subtree → sibling label before the control → short previous-sibling
//    text → parent's direct text → button text → title → placeholder → name → id → "<Kind> N")
//    so hand-rolled panels (sibling <label>Speed:</label> rows, label-wrapped checkboxes) get
//    human names — never a bare tag name. Kind/selector policy mirrors SimUiControls.ts (the
//    gate stays self-contained, so the logic is duplicated inline; keep the two in sync).
//    Selectors: #id → [name] → an unambiguous CHILD-combinator nth-of-type path anchored at
//    the nearest #id ancestor (or body) — only THIS live-DOM scanner may emit structural
//    paths; the static scanner emits #id/[name] only. Version bumps replace older blocks via
//    the existing marker machinery (RAF_GATE_BLOCK_RE strips any version).
//
// IMPORTANT: the script body must NOT start with `(function` and must not contain the string
// "sim-bridge v1"/"sim-bridge v2" — the legacy cleanup regexes in this file strip such blocks.

const RAF_GATE_VERSION = 5;
const RAF_GATE_MARKER_START = `<!-- sim-raf-gate v${RAF_GATE_VERSION} -->`;
const RAF_GATE_MARKER_END   = '<!-- /sim-raf-gate -->';
// Strips any version of the gate block (plus the '\n' separator injectRafGate adds before it)
// so strip→re-inject is byte-stable and a version bump replaces the old block cleanly.
const RAF_GATE_BLOCK_RE = /\n?<!-- sim-raf-gate v\d+ -->[\s\S]*?<!-- \/sim-raf-gate -->/g;

const RAF_GATE_TEMPLATE = /* js */ `;(function () {
  'use strict';
  if (window.__SIM_RAF_GATE__) return;
  var nativeRaf = window.requestAnimationFrame && window.requestAnimationFrame.bind(window);
  var nativeCancel = window.cancelAnimationFrame && window.cancelAnimationFrame.bind(window);
  var paused = false;
  var queued = [];        // callbacks requested while paused — each queued once, replayed once
  var nextQueuedId = -1;  // synthetic negative ids never collide with native (positive) handles
  // First-real-frame ack: the sim paints its scene inside its OWN rAF callback at page load
  // (independent of the bridge's startScript). The player pre-mounts the iframe hidden and
  // UNPAUSED so it actually runs frames; the instant one of those frames executes we tell the
  // player {type:'SIM_PAINTED'}. That — not SIM_READY (which fires before any frame draws) — is
  // when the sim is safe to reveal, so the crossfade never shows a blank/loading frame. Posted
  // exactly once, from a callback that ACTUALLY RAN while un-paused (a paused sim never paints).
  var painted = false;
  function firstPaintWrap(cb) {
    if (painted) return cb;
    return function (ts) {
      cb(ts);
      if (!painted) {
        painted = true;
        try { window.parent && window.parent.postMessage({ type: 'SIM_PAINTED', v: ${RAF_GATE_VERSION} }, '*'); } catch (e) {}
      }
    };
  }
  window.requestAnimationFrame = function (cb) {
    if (!paused || typeof cb !== 'function') return nativeRaf ? nativeRaf(firstPaintWrap(cb)) : 0;
    for (var i = 0; i < queued.length; i++) {
      if (queued[i].cb === cb) return queued[i].id;   // each callback queued once
    }
    var id = nextQueuedId--;
    queued.push({ id: id, cb: cb });
    return id;
  };
  // System rAF for the injected bridge/guidance scripts: pause-coupled EXACTLY like the
  // wrapped rAF (queues while paused, replays on resume) but NEVER counts as the sim's
  // first paint — a bookkeeping callback draws nothing, and letting it ack SIM_PAINTED
  // reported "painted" for scenes that had rendered nothing (audited false-paint source).
  function sysRaf(cb) {
    if (typeof cb !== 'function') return 0;
    if (!paused) return nativeRaf ? nativeRaf(cb) : 0;
    for (var i = 0; i < queued.length; i++) {
      if (queued[i].cb === cb) return queued[i].id;
    }
    var id = nextQueuedId--;
    queued.push({ id: id, cb: cb, sys: true });
    return id;
  }
  window.cancelAnimationFrame = function (id) {
    if (typeof id === 'number' && id < 0) {
      for (var i = 0; i < queued.length; i++) {
        if (queued[i].id === id) { queued.splice(i, 1); return; }
      }
      return;
    }
    if (nativeCancel) nativeCancel(id);
  };
  function flush() {
    var pending = queued;
    queued = [];
    if (!nativeRaf) return;
    for (var i = 0; i < pending.length; i++) {
      // Re-schedule via the NATIVE rAF: each callback runs once and receives the native
      // timestamp of the resumed frame. Timestamps are never fabricated here.
      // firstPaintWrap so a sim first unpaused via simResume (rather than warmed) still acks.
      // System callbacks (sys flag) replay unwrapped — they must never ack a paint.
      nativeRaf(pending[i].sys ? pending[i].cb : firstPaintWrap(pending[i].cb));
    }
  }
  // ── Minimal-UI control picker: runtime scan ─────────────────────────────────
  // The scanner itself lives in simScannerSource.ts and is shared, verbatim, with the serve-time
  // authoring script — see that file for why it is not duplicated. Only the transport differs:
  // the gate answers the parent's listSimControls message, so it needs a poster around it.
${SIM_SCANNER_SOURCE}
  function listSimControls() {
    var r = collectSimControls();
    window.parent && window.parent.postMessage({ type: 'simControlsList', controls: r.controls }, '*');
  }
  // ── Parent-controlled mute (belt-and-suspenders for warmed-while-hidden sims) ──
  // A sim is pre-mounted hidden and un-paused so it can paint; if such a sim autoplayed
  // audio it would leak sound before the section is on screen. Cross-origin autoplay is
  // already blocked without a gesture, but we also let the player force-mute the frame:
  // while muted, HTMLMediaElement.play() forces .muted=true first. Unmuted at reveal.
  var simMuted = false;
  try {
    var _mediaPlay = window.HTMLMediaElement && window.HTMLMediaElement.prototype.play;
    if (_mediaPlay) {
      window.HTMLMediaElement.prototype.play = function () {
        if (simMuted) { try { this.muted = true; } catch (e) {} }
        return _mediaPlay.apply(this, arguments);
      };
    }
  } catch (e) { /* environment without HTMLMediaElement — no media to mute */ }
  function applyMuteAll(on) {
    simMuted = on;
    try {
      var media = document.querySelectorAll('video, audio');
      for (var i = 0; i < media.length; i++) { try { media[i].muted = on; } catch (e) {} }
    } catch (e) { /* pre-DOM */ }
  }
  // KNOWN GAP: simPause freezes only requestAnimationFrame-driven loops. A sim whose loop
  // runs on setInterval/setTimeout, a Web Worker, or a WebAudio graph keeps running while
  // "paused" (and applyMuteAll below only mutes <video>/<audio> elements, not AudioContext
  // output). Generated sims are rAF-driven by construction; uploaded sims should be too.
  window.addEventListener('message', function (e) {
    // Only our own parent — see the guard note on the combined bridge (simulation-004).
    if (e.source !== window.parent) return;
    var d = (e && e.data) || {};
    if (d.type === 'simPause') { paused = true; }
    else if (d.type === 'simResume') { if (paused) { paused = false; flush(); } }
    else if (d.type === 'listSimControls') { listSimControls(); }
    else if (d.type === 'simMute') { applyMuteAll(true); }
    else if (d.type === 'simUnmute') { applyMuteAll(false); }
    // Re-sync a canvas/WebGL sim to the current container size/DPR after an opacity-only
    // reveal (which fires no native resize): dispatch a synthetic resize the sim listens for.
    else if (d.type === 'simRelayout') { try { window.dispatchEvent(new Event('resize')); } catch (e) {} }
    // The broadcast SIM_PAINTED can beat the player's listener (a sim animating during
    // document load paints before SIM_READY) — let the player re-query at any time.
    else if (d.type === 'PING_SIM_PAINTED') {
      if (painted) { try { window.parent && window.parent.postMessage({ type: 'SIM_PAINTED', v: ${RAF_GATE_VERSION} }, '*'); } catch (err) {} }
    }
  });
  var env = { lowend: null, dpr: null, mem: null, section: null };
  try {
    var q = new URLSearchParams(window.location.search);
    env.lowend = q.get('lowend');
    env.dpr = q.get('dpr');
    env.mem = q.get('mem');
    env.section = q.get('section');
  } catch (err) { /* keep nulls */ }
  window.__SIM_ENV = env;
  window.__SIM_RAF_GATE__ = {
    version: ${RAF_GATE_VERSION},
    isPaused: function () { return paused; },
    queuedCount: function () { return queued.length; },
    // The UNWRAPPED requestAnimationFrame. System scripts (bridge/guidance) schedule their
    // own bookkeeping through this so it can never count as the sim's first paint — the
    // wrapped rAF acks SIM_PAINTED on the first callback that completes, and a bookkeeping
    // callback (the bridge's _fireReady, guidance's poll loop) draws nothing (audited
    // false-paint source). Sims keep using the wrapped window.requestAnimationFrame.
    raw: nativeRaf || null,
    // Pause-coupled system rAF (queues while paused like the wrapped one, but paint-neutral).
    // Guidance's poll loop runs on this: it must freeze with simPause yet never ack a paint.
    sys: sysRaf
  };
})();`;

/** Remove every sim-raf-gate block (any version) from an HTML string. Used both for
 *  idempotent re-injection and to keep the gate out of LLM source context / sourceHash. */
export function stripRafGate(html: string): string {
  return html.replace(RAF_GATE_BLOCK_RE, '');
}

/** Idempotently inject the rAF gate at the START of <head> (marker-guarded — re-injection
 *  replaces the existing block, never duplicates). Fallback order when <head> is missing:
 *  before the first <script>, then top of <body>, then prepended to the document. */
export function injectRafGate(html: string): string {
  const tag = `<script>\n/* sim-raf-gate v${RAF_GATE_VERSION} — auto-injected by podcast-saas — do not edit */\n${RAF_GATE_TEMPLATE}\n</script>`;
  const block = `${RAF_GATE_MARKER_START}\n${tag}\n${RAF_GATE_MARKER_END}`;

  // Strip any existing gate first: collapses accidental duplicates and refreshes stale versions.
  const cleaned = stripRafGate(html);

  // `(\s[^>]*)?` keeps <header>/<body …> lookalikes from matching a bare <head>/<body> probe.
  const headMatch = /<head(\s[^>]*)?>/i.exec(cleaned);
  if (headMatch) {
    const at = headMatch.index + headMatch[0].length;
    return cleaned.slice(0, at) + '\n' + block + cleaned.slice(at);
  }
  const scriptIdx = cleaned.search(/<script\b/i);
  if (scriptIdx !== -1) {
    return cleaned.slice(0, scriptIdx) + block + '\n' + cleaned.slice(scriptIdx);
  }
  const bodyMatch = /<body(\s[^>]*)?>/i.exec(cleaned);
  if (bodyMatch) {
    const at = bodyMatch.index + bodyMatch[0].length;
    return cleaned.slice(0, at) + '\n' + block + cleaned.slice(at);
  }
  return block + '\n' + cleaned;
}

// ── BRIDGE_GENERATION_SYSTEM_PROMPT ─────────────────────────────────────────────
// The selected LLM provider receives the full simulation source + manifest and writes the bridge script.
// THIS CONSTANT IS THE LIVE DEFAULT — generateBridgeScript uses it unless an admin has customized the
// system_prompts row (key: bridge_plan, is_customized = true). The old shared/src/prompts/bridge-plan.txt
// was never loaded by anything and has been deleted; edit THIS constant. (sim-bridge-deepfix)

const BRIDGE_GENERATION_SYSTEM_PROMPT = `You generate a JavaScript bridge script for a science/physics simulation embedded in an iframe.
The bridge communicates with the parent player via postMessage.
You receive the simulation's FULL source code plus a manifest of verified IDs and functions.

## BRIDGE SCRIPT TEMPLATE
Your bridgeScript MUST follow this EXACT structure.

The two sections marked DO NOT MODIFY must be included VERBATIM — copy them exactly.
You only write the body of SCRIPTS.main.

\`\`\`javascript
(function () {
  'use strict';

  // ── SIM_READY — DO NOT MODIFY — copy exactly ────────────────────────────────
  let _ready = false;
  function _fireReady() {
    if (_ready) return; _ready = true; window._simReadyFired = true;
    window.parent?.postMessage({ type: 'SIM_READY' }, '*');
  }
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', () => requestAnimationFrame(_fireReady));
  else requestAnimationFrame(_fireReady);
  setTimeout(_fireReady, 3000);

  // ── YOUR IMPLEMENTATION — fill in SCRIPTS.main only ─────────────────────────
  let _cancelFn = null;

  const SCRIPTS = {
    main: function (params) {
      // params.simpleUi: boolean   — hide irrelevant controls when true
      // params.autoScript: boolean — animate the target control when true

      // Record original display values for all elements you hide
      const _hidden = [];
      function _hide(el) {
        if (!el) return;
        const orig = el.style.getPropertyValue('display') || '';
        el.style.setProperty('display', 'none');
        _hidden.push([el, orig]);
      }
      function _restoreAll() {
        _hidden.forEach(([el, orig]) => {
          if (orig) el.style.setProperty('display', orig);
          else el.style.removeProperty('display');
        });
      }

      // Track intervals, listeners, injected elements for cleanup
      const _ivs = [];
      const _listeners = [];
      const _injected = [];

      // [YOUR IMPLEMENTATION HERE]
      // (_hidden, _hide, _restoreAll, _ivs, _listeners, _injected ALSO exist in the enclosing bridge
      //  scope — a mainBody that omits the declarations above still works; declaring them is fine too.)
      // Use _hide() to hide elements.
      // Push intervals: _ivs.push(setInterval(..., ms));
      // Automation/demo intervals ONLY: _ivs.push(simDemoTimer(setInterval(..., ms)));
      // Push listeners: _listeners.push([el, event, handler]); el.addEventListener(event, handler);
      // Push injected: const el = document.createElement('div'); document.body.appendChild(el); _injected.push(el);

      return function cleanup() {
        _ivs.forEach(id => clearInterval(id));
        _listeners.forEach(([el, ev, fn]) => el.removeEventListener(ev, fn));
        _injected.forEach(el => el.remove?.());
        _restoreAll();
      };
    },
  };

  // ── STANDARD LISTENER — DO NOT MODIFY — copy exactly ─────────────────────────
  let _lastSig = null;
  function stopScript() {
    if (_cancelFn) { _cancelFn(); _cancelFn = null; }
    _lastSig = null;
  }
  function startScript(name, params) {
    const sig = (name || 'main') + ':' + JSON.stringify(params || {});
    if (_cancelFn && sig === _lastSig) return;   // identical re-post — keep the script running
    stopScript();
    _lastSig = sig;
    const fn = SCRIPTS[name] ?? SCRIPTS.main;
    if (fn) _cancelFn = fn(params ?? {}) ?? null;
  }
  window.SimAPI = { start: startScript, stop: stopScript };
  window.addEventListener('message', e => {
    const { type, script, params } = e.data || {};
    if (type === 'startScript')  startScript(script || 'main', params);
    if (type === 'stopScript')   stopScript();
    if (type === 'PING_SIM_READY' && window._simReadyFired)
      window.parent?.postMessage({ type: 'SIM_READY' }, '*');
  });
  document.addEventListener('pointerdown', () => {
    window.parent?.postMessage({ type: 'userInteraction' }, '*');
  }, { capture: true });
})();
\`\`\`

## OUTPUT FORMAT
Return ONLY a JSON object — no markdown, no explanations outside the JSON:
{
  "message": "What the bridge does and key decisions made",
  "mainBody": "// Your SCRIPTS.main body here (NOT the full IIFE wrapper)\n  const el = document.getElementById('velocity');\n  // ... implementation ...\n  return function cleanup() { /* ... */ };",
  "confidence": 0.9,
  "warnings": []
}

IMPORTANT: mainBody is ONLY the body of the SCRIPTS.main function.
Do NOT include the function signature (main: function(params) {) or its closing brace.
Do NOT include the IIFE wrapper, SIM_READY block, or message listener — the system provides those.
Write plain JavaScript that runs inside SCRIPTS.main with access to the params argument.
End the mainBody with: return function cleanup() { ... };

## MANDATORY RULES — NEVER VIOLATE

### Structure
1. Copy the SIM_READY block and the STANDARD LISTENER block VERBATIM. Do not modify them.
2. SCRIPTS.main MUST return a cleanup function that reverses all side effects.
3. The cleanup function MUST call clearInterval for every setInterval you use.
4. The cleanup function MUST call removeEventListener for every addEventListener you use.
5. The cleanup function MUST remove any HTML elements you inject.
6. The cleanup function MUST restore the original display value for every element you hide.
7. Do not write minified or obfuscated code. Use clear variable names and small helper functions.
8. Do not add external dependencies, network requests, or remote URLs.

### Security — NEVER do any of the following
9. Do not use fetch(), XMLHttpRequest, or any network call.
10. Do not access localStorage, sessionStorage, or document.cookie.
11. Do not use eval(), new Function(), or dynamic script evaluation.
12. Do not open popups (window.open, alert, confirm, prompt).
13. Do not add <script> tags or load external resources.
14. Do not navigate parent window (window.parent.location = ...).
15. Do not read or write parent DOM.
16. Do not exfiltrate any data outside of the established postMessage protocol.

### DOM access & APIs — the manifest is a HELP, not a WHITELIST
17. Access a control by its manifest ID when it has one. When a control has NO id, target it by a CSS
    class or selector that is clearly visible in the source — e.g. document.querySelectorAll('.controls'),
    matching a class assigned via createElement/className/class="…" or a helper like _el('div','controls',…).
    A source-visible selector is VALID even if it is not in the manifest. Do not refuse to act just
    because the manifest is empty — many sims build their whole UI at runtime with no static ids.
18. Call functions from the manifest, OR methods on a runtime global that is visible in the source
    (e.g. window.__murmuration.toggleExploreExploit()), OR functions/classes defined anywhere in the
    source — even if absent from the manifest's function lists. If the source shows it, you may use it.
19. Use optional chaining (?.) and existence checks — an element, global, or method may not exist yet.

### Runtime timing — async init()
20. Many sims build their UI and controller objects inside an async init() that finishes AFTER SIM_READY
    fires. If what you need (an element, a window global like window.__murmuration, a method) is not
    present immediately, POLL for it with a ~200ms setInterval (pushed to _ivs, cleared in cleanup) until
    it exists, then act. ALSO run one synchronous attempt up front so a re-fired startScript on an
    already-initialised sim takes effect immediately.
21. Prefer inline style.setProperty('display','none') over toggling CSS classes: runtime class churn (a
    later resize / collapse / setCollapsed) can otherwise resurrect a panel you hid. Re-apply the hide on
    each poll tick (guard it so you record each element's original display only once).

### Parameters & idempotency
22. When params.simpleUi = true (or the user prompt asks to hide the controls): hide ALL irrelevant
    controls AND their labels — by ID, or by CSS selector when they have no id. Show only the target.
23. When params.autoScript = true: animate the target control (setInterval). Stop the animation in cleanup.
24. TOGGLE methods that flip internal state (e.g. app.exploreExploit.toggle(), app.toggleExploreExploit(),
    app.togglePlay()) are NOT idempotent. Read the state boolean FIRST (e.g. app.exploreExploit.active) and
    only call the toggle when it is not already in the desired state. Make cleanup equally guarded so it
    only reverses what you actually changed — a re-fired startScript must NEVER bounce the state off/on.
25. Use _hide() for hiding: it records originals automatically for restoration. _hide, _restoreAll,
    _hidden, _ivs, _listeners and _injected are PROVIDED by the host in the scope enclosing your body —
    use them directly or declare your own; never reference any other helper you did not declare.

### Animation
26. Use setInterval for animation: step 0.1–0.3, intervalMs 30–150ms. Pingpong at min/max.
27. Push every interval ID into _ivs and every listener into _listeners so cleanup clears/removes them.
27b. Wrap EVERY automation/demo interval in simDemoTimer(...) when pushing it:
    _ivs.push(simDemoTimer(setInterval(step, 120)));
    It returns the id unchanged (cleanup still clears it normally) and is what lets the player stop
    the demo when the user grabs a control WITHOUT tearing your section down. Wrap ONLY automation
    timers — never a timer that drives the simulation's own engine or a control-polling loop.
    If simDemoTimer is undefined (older host), fall back: _ivs.push(setInterval(step, 120)).

### Render functions
28. Call updateDerivedPhysics before render functions if it exists. Call render functions defensively
    (fn?.()) — they may not always be defined.

### Confidence scoring
29. A reference is "verified" if it is in the manifest OR appears verbatim in the source (a class selector,
    a window-global method, a defined function/class). Count source-visible references as verified.
30. confidence >= 0.9: all references verified (manifest or source); 0.6–0.89: some guessed selectors/
    functions; < 0.6: significant uncertainty — explain in warnings.

## WORKED EXAMPLE — runtime-built UI + object-method global
When a sim builds its panel at runtime (no static ids) and exposes itself as a window global, follow this
shape: target controls by source-visible CSS selectors, poll for the async-built global, and toggle state
IDEMPOTENTLY. (This mainBody is self-contained — it declares its own tracking arrays.)

\`\`\`javascript
// Request: "hide all the controls of the menu totally + enable explore-exploit mode."
var _hidden = [], _ivs = [], _listeners = [], _injected = [];
var CONTROL_SELECTORS = ['.controls', '.show-menu-tab', '.collapse-menu-btn', '#hud'];
var HIDDEN_FLAG = '__bridgeHidden';
var _enabledByUs = false;

function hideControls() {
  for (var s = 0; s < CONTROL_SELECTORS.length; s++) {
    var nodes = document.querySelectorAll(CONTROL_SELECTORS[s]);
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el[HIDDEN_FLAG]) continue;                    // record original display only once
      el[HIDDEN_FLAG] = true;
      _hidden.push([el, el.style.getPropertyValue('display') || '']);
      el.style.setProperty('display', 'none');          // inline none beats class toggles
    }
  }
}
function appReady() {
  var app = window.__murmuration;
  return !!(app && app.exploreExploit && app.menu);
}
function enableExploreExploit() {
  var app = window.__murmuration;
  if (app && app.exploreExploit && app.exploreExploit.active === false) { // idempotent
    app.toggleExploreExploit();
    _enabledByUs = true;
  }
}

hideControls();                                          // one synchronous attempt (re-fired startScript)
if (appReady()) enableExploreExploit();
_ivs.push(setInterval(function () {                      // async init(): poll until ready, keep re-hiding
  hideControls();
  if (appReady()) enableExploreExploit();
}, 200));

return function cleanup() {
  _ivs.forEach(function (id) { clearInterval(id); });
  _listeners.forEach(function (l) { l[0].removeEventListener(l[1], l[2]); });
  _injected.forEach(function (el) { el.remove && el.remove(); });
  _hidden.forEach(function (h) {
    if (h[1]) h[0].style.setProperty('display', h[1]); else h[0].style.removeProperty('display');
    try { delete h[0][HIDDEN_FLAG]; } catch (e) { h[0][HIDDEN_FLAG] = false; }
  });
  var app = window.__murmuration;                        // only reverse what we changed
  if (_enabledByUs && app && app.exploreExploit && app.exploreExploit.active === true) {
    app.toggleExploreExploit();
  }
  _enabledByUs = false;
};
\`\`\`
`;

// ── Manifest builder ──────────────────────────────────────────────────────────

function buildControlAliases(id: string, label: string): string[] {
  const s = new Set<string>([id, label.toLowerCase().trim()]);

  const isV0y = /^(v0y|vy0|v_0y|vy)$/i.test(id) ||
    /\b(vy0|v0y|initial\s*(vertical\s*)?(velocity|speed)|vertical\s*(velocity|speed)|y[_\s-]*(vel|speed))\b/i.test(label);
  if (isV0y) {
    ['v0y','vy0','Vy0','v_0y','vy','initial vertical velocity','initial y velocity',
     'initial vy','vertical velocity','y velocity'].forEach(a => s.add(a));
  }

  const isV0x = /^(v0x|vx0|v_0x|vx)$/i.test(id) ||
    /\b(vx0|v0x|initial\s*(horizontal\s*)?(velocity|speed)|horizontal\s*(velocity|speed))\b/i.test(label);
  if (isV0x) {
    ['v0x','vx0','v_0x','vx','initial horizontal velocity','horizontal velocity'].forEach(a => s.add(a));
  }

  return [...s];
}

export function buildManifest(sourceMap: Map<string, string>): SimManifest {
  const manifest: SimManifest = {
    controls: [], buttons: [], sections: [],
    renderFunctions: [], updateFunctions: [], hasSetSimSection: false,
    selectElements: [], checkboxElements: [], canvasElements: [], globalObjects: [],
    runtimeGlobals: [], instanceMethods: [], cssControls: [],
  };

  for (const [key, content] of sourceMap) {
    const isHtml = /\.(html|htm)$/.test(key);
    const isJs   = /\.(js|mjs|ts)$/.test(key);

    if (isHtml) {
      let m: RegExpExecArray | null;

      // First pass: extract section divs WITH source positions (needed for containment tracking)
      const localSectionPos: Array<{ id: string; pos: number }> = [];
      const divRe = /<div([^>]*)id="([^"]+)"([^>]*)>/gi;
      while ((m = divRe.exec(content)) !== null) {
        const id = m[2];
        if (manifest.sections.some(s => s.id === id)) continue;
        const allAttrs = m[1] + m[3];
        const styleStr = /\bstyle="([^"]*)"/.exec(allAttrs)?.[1] ?? '';
        const defaultHidden = /display\s*:\s*none/.test(styleStr);
        manifest.sections.push({ id, defaultHidden, childControlIds: [], childButtonIds: [] });
        localSectionPos.push({ id, pos: m.index });
      }

      // Find the nearest section whose opening tag appears before a given source position.
      // "Nearest" = largest pos that is still less than the control/button's pos — i.e. the
      // innermost section that opened most recently before this element.
      const nearestSection = (pos: number): SimSection | null => {
        let best: { id: string; pos: number } | null = null;
        for (const sp of localSectionPos) {
          if (sp.pos < pos && (!best || sp.pos > best.pos)) best = sp;
        }
        return best ? (manifest.sections.find(s => s.id === best!.id) ?? null) : null;
      };

      // Second pass: extract <input> controls WITH positions
      const inputRe = /<input([^>]*)>/gi;
      while ((m = inputRe.exec(content)) !== null) {
        const attrs = m[1];
        const id   = /\bid="([^"]+)"/.exec(attrs)?.[1];
        if (!id) continue;
        if (manifest.controls.some(c => c.id === id)) continue;

        const type = /\btype="([^"]+)"/.exec(attrs)?.[1] ?? 'text';
        const min  = /\bmin="([^"]+)"/.exec(attrs)?.[1];
        const max  = /\bmax="([^"]+)"/.exec(attrs)?.[1];
        const step = /\bstep="([^"]+)"/.exec(attrs)?.[1];

        const labelRe = new RegExp(`<label[^>]+for="${id}"[^>]*>\\s*([^<]+?)\\s*</label>`, 'i');
        const label = labelRe.exec(content)?.[1]?.trim() ?? id;

        manifest.controls.push({ id, type, label, min, max, step, aliases: buildControlAliases(id, label) });

        const sec = nearestSection(m.index);
        if (sec && !sec.childControlIds.includes(id)) sec.childControlIds.push(id);
      }

      // Third pass: extract <button> elements WITH positions
      const btnRe = /<button[^>]+id="([^"]+)"[^>]*>([^<]*)</gi;
      while ((m = btnRe.exec(content)) !== null) {
        const id = m[1];
        if (manifest.buttons.some(b => b.id === id)) continue;
        manifest.buttons.push({ id, label: m[2].trim() });

        const sec = nearestSection(m.index);
        if (sec && !sec.childButtonIds.includes(id)) sec.childButtonIds.push(id);
      }

      // Fourth pass: <select> elements
      const selRe = /<select([^>]*)>/gi;
      while ((m = selRe.exec(content)) !== null) {
        const id = /\bid="([^"]+)"/.exec(m[1])?.[1];
        if (!id || manifest.selectElements.some(s => s.id === id)) continue;
        // Extract <option> values from the content following the <select>
        const selectBody = content.slice(m.index, m.index + 500);
        const options: string[] = [];
        const optRe = /<option[^>]*>([^<]*)</gi;
        let om: RegExpExecArray | null;
        while ((om = optRe.exec(selectBody)) !== null) options.push(om[1].trim());
        manifest.selectElements.push({ id, options });
      }

      // Fifth pass: <input type="checkbox"> elements
      const cbRe = /<input([^>]*type=["']?checkbox["']?[^>]*)>/gi;
      while ((m = cbRe.exec(content)) !== null) {
        const id = /\bid="([^"]+)"/.exec(m[1])?.[1];
        if (!id || manifest.checkboxElements.some(c => c.id === id)) continue;
        const labelRe = new RegExp(`<label[^>]+for="${id}"[^>]*>\\s*([^<]+?)\\s*</label>`, 'i');
        const label = labelRe.exec(content)?.[1]?.trim() ?? id;
        manifest.checkboxElements.push({ id, label });
      }

      // Sixth pass: <canvas> elements
      const canvasRe = /<canvas([^>]*)>/gi;
      while ((m = canvasRe.exec(content)) !== null) {
        const id = /\bid="([^"]+)"/.exec(m[1])?.[1];
        if (id && !manifest.canvasElements.includes(id)) manifest.canvasElements.push(id);
      }
    }

    if (isJs) {
      // Detect functions using multiple patterns: named fn, arrow fn, class method, export
      const fnExists = (fn: string): boolean => {
        const esc = fn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return [
          `function ${esc}\\s*\\(`,
          `(?:const|let|var)\\s+${esc}\\s*=\\s*(?:async\\s*)?(?:\\([^)]*\\)|\\w+)\\s*=>`,
          `(?:const|let|var)\\s+${esc}\\s*=\\s*(?:async\\s+)?function`,
          `^\\s+${esc}\\s*\\([^)]*\\)\\s*\\{`,
          `export\\s+(?:default\\s+)?(?:async\\s+)?function\\s+${esc}`,
          `export\\s+(?:default\\s+)?(?:const|let)\\s+${esc}\\s*=`,
        ].some(p => new RegExp(p, 'm').test(content));
      };

      for (const fn of ['redraw', 'draw', 'render', 'refresh', 'repaint', 'animate', 'update']) {
        if (!manifest.renderFunctions.includes(fn) && fnExists(fn)) {
          manifest.renderFunctions.push(fn);
        }
      }
      for (const fn of ['updateDerivedPhysics','updateActionDisplay','updateOptimalActionDisplay',
                         'updateEnergyBars','computeAll','computeState']) {
        if (!manifest.updateFunctions.includes(fn) && fnExists(fn)) {
          manifest.updateFunctions.push(fn);
        }
      }
      if (/setSimSection/.test(content)) manifest.hasSetSimSection = true;

      // Detect global library objects (Plotly, d3, THREE, p5, Chart, etc.)
      for (const lib of ['Plotly', 'd3', 'THREE', 'p5', 'Chart', 'Highcharts', 'echarts', 'Phaser']) {
        if (!manifest.globalObjects.includes(lib) && new RegExp(`\\b${lib}\\b`).test(content)) {
          manifest.globalObjects.push(lib);
        }
      }

      // ── Modern runtime-built sims (sim-bridge-deepfix) ────────────────────────
      // Runtime globals: `window.__murmuration = app`, `window.sim = ...` etc. These are the API
      // surface for sims that expose an app object instead of top-level functions.
      let rg: RegExpExecArray | null;
      const globalRe = /window\.([A-Za-z_$][\w$]*)\s*=/g;
      while ((rg = globalRe.exec(content)) !== null) {
        const g = rg[1];
        // Skip DOM/lifecycle assignments that aren't an app API (onload, addEventListener via = etc.)
        if (/^(on\w+|location|name|status|open|close|top|self|parent|length)$/.test(g)) continue;
        if (!manifest.runtimeGlobals.includes(g)) manifest.runtimeGlobals.push(g);
      }
      // Instance / API methods the LLM can DRIVE — action-named methods, captured whether they are
      // defined as a class method (`  toggleExploreExploit() {`) or invoked as `obj.toggleX(`. We filter
      // to action verbs (toggle/set/reset/play/…) so this stays high-signal and doesn't fill up with
      // generic helpers or THREE vector `.set()` noise. (sim-bridge-deepfix)
      let mm: RegExpExecArray | null;
      const ACTION_RE = /^(toggle[A-Z]|set[A-Z]|reset$|play$|pause$|start$|stop$|enable|disable|mute$|unmute$|show[A-Z]|hide[A-Z]|next[A-Z]?$|prev[A-Z]?$|select[A-Z]|step$|seek$|activate|deactivate)/;
      const methodRe = /(?:(?:^|\n)\s{2,}|\.)([A-Za-z_$][\w$]*)\s*\(/g;
      while ((mm = methodRe.exec(content)) !== null) {
        const name = mm[1];
        if (name.length < 3 || !ACTION_RE.test(name)) continue;
        if (!manifest.instanceMethods.includes(name)) manifest.instanceMethods.push(name);
      }
      // CSS controls: classes/ids assigned to created elements — className='controls',
      // class="show-menu-tab", or the _el('div','controls',…) helper. These are how the bridge hides
      // a runtime-built panel that has no static id.
      let cc: RegExpExecArray | null;
      const cssRe = /(?:className\s*=\s*|class\s*=\s*|_el\(\s*['"][\w-]+['"]\s*,\s*)['"]([\w][\w\s-]*)['"]/g;
      while ((cc = cssRe.exec(content)) !== null) {
        for (const cls of cc[1].trim().split(/\s+/)) {
          if (cls && !manifest.cssControls.includes(cls)) manifest.cssControls.push(cls);
        }
      }
    }
  }
  // Bound the runtime lists so a huge sim can't bloat the prompt.
  manifest.instanceMethods = manifest.instanceMethods.slice(0, 60);
  manifest.cssControls     = manifest.cssControls.slice(0, 60);

  return manifest;
}

// ── GeneratedBridge Zod schema ────────────────────────────────────────────────

const BridgeGenerationSchema = z.object({
  message:    z.string().min(1),
  /** Body of SCRIPTS.main only — not the full IIFE wrapper */
  mainBody:   z.string().min(5),
  confidence: z.number().min(0).max(1).default(0.5),
  warnings:   z.array(z.string()).default([]),
});

/**
 * The helpers the generation prompt promises every section body, declared ONCE in the enclosing
 * bridge scope. The prompt's template declares `_hidden/_hide/_restoreAll/_ivs/_listeners/_injected`
 * inside SCRIPTS.main and says "fill in [YOUR IMPLEMENTATION HERE]"; a model that returns only that
 * part relies on them, and both wrappers used to splice the body in bare — the first `_hide(...)`
 * threw `ReferenceError: _hidden is not defined` on activation, the runtime posted SCRIPT_ERROR, and
 * the viewer played the film through the whole window (2 of 6 generated bodies, 2026-09-05).
 *
 * They live in the scope that ENCLOSES the body functions, so a body that declares its own copies
 * (the worked example's `var _hidden = [] …`, or the template's `const _hidden = []`) shadows them
 * legally instead of colliding. `_drainPrelude()` runs from the standard stopScript AFTER the body's
 * own cleanup: whatever a body pushed into the shared collections is cleared, removed, restored, and
 * the collections are emptied for the next section on the same document.
 */
const BRIDGE_BODY_PRELUDE: readonly string[] = [
  '  // ── Body prelude — the helpers the generation prompt promises (see BRIDGE_BODY_PRELUDE) ──',
  '  var _hidden = [], _ivs = [], _listeners = [], _injected = [];',
  '  function _hide(el) {',
  '    if (!el || !el.style) return;',
  "    var orig = el.style.getPropertyValue('display') || '';",
  "    el.style.setProperty('display', 'none');",
  '    _hidden.push([el, orig]);',
  '  }',
  '  function _restoreAll() {',
  '    for (var i = _hidden.length - 1; i >= 0; i--) {',
  '      var h = _hidden[i];',
  "      try { if (h[1]) h[0].style.setProperty('display', h[1]); else h[0].style.removeProperty('display'); } catch (e) {}",
  '    }',
  '    _hidden.length = 0;',
  '  }',
  '  function _drainPrelude() {',
  '    for (var i = 0; i < _ivs.length; i++) { try { clearInterval(_ivs[i]); clearTimeout(_ivs[i]); } catch (e) {} }',
  '    _ivs.length = 0;',
  '    for (var j = 0; j < _listeners.length; j++) { var l = _listeners[j]; try { l[0].removeEventListener(l[1], l[2]); } catch (e) {} }',
  '    _listeners.length = 0;',
  '    for (var k = 0; k < _injected.length; k++) { try { if (_injected[k] && _injected[k].remove) _injected[k].remove(); } catch (e) {} }',
  '    _injected.length = 0;',
  '    _restoreAll();',
  '  }',
];

/** Wrap LLM-generated mainBody in the guaranteed-correct bridge template.
 *  The system owns: SIM_READY, startScript, stopScript, SimAPI, and the message listener.
 *  The LLM only writes the SCRIPTS.main function body — it can NEVER break the protocol. */
export function wrapBridgeMainBody(mainBody: string): string {
  const indented = mainBody
    .split('\n')
    .map(l => (l.trim() === '' ? '' : '      ' + l))
    .join('\n');
  return [
    '(function () {',
    "  'use strict';",
    '',
    '  // ── SIM_READY — system-owned, guaranteed correct ────────────────────────────',
    '  let _ready = false;',
    '  function _fireReady() {',
    "    if (_ready) return; _ready = true; window._simReadyFired = true;",
    "    window.parent?.postMessage({ type: 'SIM_READY' }, '*');",
    '  }',
    "  if (document.readyState === 'loading')",
    "    document.addEventListener('DOMContentLoaded', () => requestAnimationFrame(_fireReady));",
    '  else requestAnimationFrame(_fireReady);',
    '  setTimeout(_fireReady, 3000);',
    '',
    ...BRIDGE_BODY_PRELUDE,
    '',
    '  // ── LLM-GENERATED IMPLEMENTATION (SCRIPTS.main body only) ────────────────────',
    '  let _cancelFn = null;',
    '  const SCRIPTS = {',
    '    main: function (params) {',
    indented,
    '    },',
    '  };',
    '',
    '  // ── STANDARD LISTENER — system-owned, guaranteed correct ─────────────────────',
    '  let _lastSig = null;',
    '  // Minimal-UI mechanical hide: while params.simpleUi is on, params.hideSelectors are',
    '  // hidden via ONE <style id="__simHideUi"> (display:none !important), refreshed on every',
    '  // startScript and removed on stopScript / when simpleUi is falsy. hideSelectors take',
    '  // part in _lastSig naturally (the sig JSON.stringifies params), so a changed selection',
    '  // re-posts through startScript and refreshes the style. Selectors containing { } <',
    '  // or backslash are rejected (no style/markup breakouts); the > child combinator the',
    '  // runtime-scanned structural paths use is allowed.',
    '  function applyHideUi(params) {',
    "    let st = document.getElementById('__simHideUi');",
    '    if (params && params.simpleUi && Array.isArray(params.hideSelectors)) {',
    '      const rules = [];',
    '      for (const sel of params.hideSelectors) {',
    "        if (typeof sel !== 'string' || /[{}<\\\\]/.test(sel)) continue;",
    "        rules.push(sel + '{display:none !important}');",
    '      }',
    '      if (rules.length > 0) {',
    '        if (!st) {',
    "          st = document.createElement('style');",
    "          st.id = '__simHideUi';",
    '          (document.head || document.documentElement).appendChild(st);',
    '        }',
    "        st.textContent = rules.join('\\n');",
    '        return;',
    '      }',
    '    }',
    '    if (st) st.remove();',
    '  }',
    '  function stopScript() {',
    '    if (_cancelFn) { _cancelFn(); _cancelFn = null; }',
    '    _drainPrelude();',
    '    _lastSig = null;',
    "    const st = document.getElementById('__simHideUi');",
    '    if (st) st.remove();',
    '  }',
    '  function startScript(name, params) {',
    "    const sig = (name || 'main') + ':' + JSON.stringify(params || {});",
    '    if (_cancelFn && sig === _lastSig) return;   // identical re-post — keep the script running',
    '    stopScript();',
    '    _lastSig = sig;',
    '    applyHideUi(params);   // mechanical Minimal-UI hide — refreshed on every (re)start',
    "    const _bh = document.getElementById('__simBootHide');",
    '    if (_bh) _bh.remove();   // __simHideUi above is definitive — drop the boot-time hide',
    '    const fn = SCRIPTS[name] ?? SCRIPTS.main;',
    '    if (fn) _cancelFn = fn(params ?? {}) ?? null;',
    '  }',
    '  window.SimAPI = { start: startScript, stop: stopScript };',
    "  window.addEventListener('message', e => {",
    '    // Only our own parent — see the guard note on the combined bridge (simulation-004).',
    '    if (e.source !== window.parent) return;',
    '    const { type, script, params } = e.data || {};',
    "    if (type === 'startScript')  startScript(script || 'main', params);",
    "    if (type === 'stopScript')   stopScript();",
    "    if (type === 'PING_SIM_READY' && window._simReadyFired)",
    "      window.parent?.postMessage({ type: 'SIM_READY' }, '*');",
    '  });',
    "  document.addEventListener('pointerdown', () => {",
    "    window.parent?.postMessage({ type: 'userInteraction' }, '*');",
    '  }, { capture: true });',
    '})();',
  ].join('\n');
}

// ── Combined bridge.js helpers ────────────────────────────────────────────────

/** Only UUIDs and slugs — rejects anything that could break JS object keys or regex. */
export const SAFE_SECTION_ID_RE = /^[a-zA-Z0-9_-]+$/;

/** Format one section's entry with parse-markers so it can later be replaced in place. */
export function buildSectionEntry(sectionId: string, mainBody: string): string {
  if (!SAFE_SECTION_ID_RE.test(sectionId))
    throw new Error(`Unsafe sectionId: "${sectionId}"`);
  const indented = mainBody
    .split('\n')
    .map(l => (l.trim() === '' ? '' : '      ' + l))
    .join('\n');
  return [
    `    /* @@SIM_BRIDGE:${sectionId}@@ */`,
    `    '${sectionId}': function (params) {`,
    indented,
    '    },',
    `    /* @@/SIM_BRIDGE:${sectionId}@@ */`,
  ].join('\n');
}

/** Parse existing bridge.js and return a Map of sectionId → mainBody. */
export function parseSectionEntries(bridgeJs: string): Map<string, string> {
  const entries = new Map<string, string>();
  // Match /* @@SIM_BRIDGE:id@@ */ … /* @@/SIM_BRIDGE:id@@ */
  // Each entry wraps: '  id': function(params) { mainBody }
  const re = /\/\*\s*@@SIM_BRIDGE:([A-Za-z0-9_-]+)@@\s*\*\/([\s\S]*?)\/\*\s*@@\/SIM_BRIDGE:\1@@\s*\*\//g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bridgeJs)) !== null) {
    const id = m[1];
    // Extract the mainBody from inside: '  id': function (params) { ... },
    const block = m[2];
    const bodyMatch = /function\s*\(params\)\s*\{([\s\S]*)\},\s*$/.exec(block.trimEnd());
    if (bodyMatch) {
      const dedented = bodyMatch[1]
        .split('\n')
        .map(l => l.startsWith('      ') ? l.slice(6) : l)
        .join('\n')
        .replace(/^\n/, '')
        // Trim ALL trailing whitespace, not one newline: re-wrapping adds indentation, so a
        // single-newline trim let repeated rebuilds accrete blank lines in every body.
        .replace(/\s+$/, '');
      entries.set(id, dedented);
    }
  }
  return entries;
}

/**
 * The marker pair `buildSectionEntry` writes, with the id captured separately from the block.
 *
 * The SAME grammar `parseSectionEntries` reads, deliberately kept adjacent to it: a rewriter that
 * knew a different grammar than the parser would rename an entry the parser cannot find, or leave
 * one it can — and either way the dispatch map and the markers would describe different sections.
 */
const SECTION_ENTRY_RE =
  /(\/\*\s*@@SIM_BRIDGE:)([A-Za-z0-9_-]+)(@@\s*\*\/)([\s\S]*?)(\/\*\s*@@\/SIM_BRIDGE:)\2(@@\s*\*\/)/g;

/**
 * The `'<id>':` that opens a section entry's block.
 *
 * The id needs no escaping — `SECTION_ENTRY_RE` only ever captures `[A-Za-z0-9_-]+`, none of which
 * is a regex metacharacter outside a character class — but it is asserted rather than assumed.
 */
const sectionKeyRe = (id: string): RegExp => {
  if (!SAFE_SECTION_ID_RE.test(id)) throw new Error(`Unsafe sectionId: "${id}"`);
  return new RegExp(`^(\\s*)(['"])${id}\\2(\\s*:)`);
};

export interface BridgeSectionRewrite {
  /** The rewritten source. Byte-identical to the input when nothing was renamed. */
  source: string;
  /** How many `@@SIM_BRIDGE@@` entries the bridge carries at all. 0 = not a combined bridge. */
  sections: number;
  /** oldId → newId, for the entries that were actually renamed. */
  renamed: Map<string, string>;
}

/**
 * Rewrite the section ids a combined `bridge.js` dispatches on, in place, byte for byte otherwise.
 *
 * WHY THIS EXISTS: A DUPLICATED PROJECT'S SIMULATIONS RUN NOTHING WITHOUT IT.
 * `__SECTIONS__` is keyed by TIMELINE SECTION ID, and `startScript(name)` resolves `name` against
 * exactly that map (`own.call(SCRIPTS, name) ? … : _sectionBody(name)`), posting `SCRIPT_MISSING`
 * and running nothing when it misses. A project duplication mints a fresh id for every section and
 * remaps `?section=` accordingly — so a copy whose bridge bytes still carry the ORIGINAL's ids asks
 * for a section the bridge has never heard of, in every simulation section, in both the viewer and
 * the editor.
 *
 * SURGICAL, NOT A RE-WRAP. `wrapBridgeCombined(parseSectionEntries(js))` would also produce a
 * correctly-keyed bridge, but from TODAY's template — so a package published against an older
 * template would silently gain (or lose) runtime behaviour as a side effect of being copied. Here
 * only the three tokens that spell the id move: the opening marker, the closing marker, and the
 * object key. Everything else, including every byte of every body, is preserved.
 *
 * INCONSISTENCY IS FATAL, ABSENCE IS NOT. A bridge with no markers at all is a legacy or
 * hand-written package (`sections: 0`); the caller leaves its bytes alone. A bridge whose marker is
 * present but whose object key is not where the marker says it is would produce a document where
 * the parser and the runtime disagree about which sections exist, so it throws instead.
 */
export function rewriteBridgeSectionIds(
  bridgeJs: string,
  rename: ReadonlyMap<string, string>,
): BridgeSectionRewrite {
  let sections = 0;
  const renamed = new Map<string, string>();
  const source = bridgeJs.replace(
    SECTION_ENTRY_RE,
    (whole, open: string, id: string, openEnd: string, block: string, close: string, closeEnd: string) => {
      sections += 1;
      const next = rename.get(id);
      if (next === undefined || next === id) return whole;
      if (!SAFE_SECTION_ID_RE.test(next)) throw new Error(`Unsafe sectionId: "${next}"`);
      const keyRe = sectionKeyRe(id);
      if (!keyRe.test(block)) {
        throw new Error(
          `bridge.js: section "${id}" is marked but its dispatch key is not at the head of its block — refusing a half-renamed bridge`,
        );
      }
      renamed.set(id, next);
      const newBlock = block.replace(keyRe, (_m, lead: string, quote: string, colon: string) =>
        `${lead}${quote}${next}${quote}${colon}`);
      return `${open}${next}${openEnd}${newBlock}${close}${next}${closeEnd}`;
    },
  );
  return { source, sections, renamed };
}

/** Build the full combined bridge.js IIFE from a sectionId→mainBody map. */
export interface WrapBridgeOptions {
  /**
   * Embed the v3 activation-scoped runtime alongside the v2 listener.
   *
   * DEFAULT FALSE, deliberately. Every caller that produces bytes an existing test or a stored
   * package is compared against — the rebuild tooling, the e2e fixture generator, the rollout
   * gates — must keep producing exactly what it produced before, or the Priority 1 byte-identity
   * proof and the Priority 3 acceptance suite are both measuring a different artifact than the one
   * they were written for. Only the production generation path opts in.
   */
  runtimeV3?: boolean;
  /** Every section body in this package returns a managed lifecycle object. */
  allManaged?: boolean;
  /** At least one section implements setQuality. */
  anyQuality?: boolean;
}

export function wrapBridgeCombined(entries: Map<string, string>, opts?: WrapBridgeOptions): string {
  const sectionBlocks = [...entries.entries()]
    .map(([id, body]) => buildSectionEntry(id, body))
    .join('\n');

  // Emitted at the END of the IIFE, after __SECTIONS__ exists and after the v2 listener is wired.
  // Order matters: the v3 runtime reads __SECTIONS__ at install time, and installing it first
  // would capture an undefined binding.
  const v3 = opts?.runtimeV3
    ? buildChildRuntimeSource({ allManaged: !!opts.allManaged, anyQuality: !!opts.anyQuality })
    : null;

  return [
    '(function () {',
    "  'use strict';",
    '',
    '  // ── Section Bridges ────────────────────────────────────────────────────────',
    '  var __SECTIONS__ = {',
    sectionBlocks,
    '  };',
    '',
    '  // ── SIM_READY — fires unconditionally (simulation runs standalone too) ──────',
    '  // The payload advertises DYNAMIC section dispatch (v2): one loaded document can run',
    '  // ANY of its sections via startScript(sectionId). Players feature-detect on this —',
    '  // absence means an old load-time-locked bridge that needs a per-section URL.',
    '  var _ready = false;',
    '  // ONE payload builder for the initial fire AND the PING_SIM_READY re-fire: a bare',
    '  // re-fire without dispatch/sections would make the player downgrade this dynamic',
    '  // frame to legacy (per-URL navigation) whenever the initial handshake was missed.',
    '  function _readyMsg() {',
    "    var ids = []; for (var k in __SECTIONS__) { if (Object.prototype.hasOwnProperty.call(__SECTIONS__, k)) ids.push(k); }",
    // 'policy' advertises the P1.2 hot-swap handlers below. A package published BEFORE them simply
    // does not send the field, and the player reads that absence as "restart me instead" —
    // capability is NEGOTIATED, never assumed from the mere existence of a bridge.
    "    return { type: 'SIM_READY', dispatch: 'dynamic', sections: ids, policy: ['ui', 'automation'] };",
    '  }',
    '  function _fireReady() {',
    "    if (_ready) return; _ready = true; window._simReadyFired = true;",
    "    window.parent?.postMessage(_readyMsg(), '*');",
    '  }',
    '  // Scheduled through the gate\'s RAW (unwrapped) rAF: the wrapped one acks SIM_PAINTED on',
    '  // the first completed callback, and _fireReady draws nothing — with the wrapped handle a',
    '  // sim that failed to render still reported "painted" (audited false-paint source).',
    "  var _sysRaf = (window.__SIM_RAF_GATE__ && (window.__SIM_RAF_GATE__.sys || window.__SIM_RAF_GATE__.raw)) || window.requestAnimationFrame.bind(window);",
    "  if (document.readyState === 'loading')",
    "    document.addEventListener('DOMContentLoaded', function() { _sysRaf(_fireReady); });",
    '  else _sysRaf(_fireReady);',
    '  setTimeout(_fireReady, 3000);',
    '',
    '  // ── Dispatch — DYNAMIC (v2): the ?section= param is only the DEFAULT. startScript',
    '  // resolves the body at call time, so one resident document serves every section of',
    '  // the package (the player switches sections via postMessage instead of navigating,',
    '  // keeping ONE scene/WebGL context per package). Wire listeners whenever the bridge',
    '  // carries any sections at all.',
    "  var _defaultSectionId = new URLSearchParams(location.search).get('section');",
    '  var _hasAny = false;',
    '  for (var _k in __SECTIONS__) { if (Object.prototype.hasOwnProperty.call(__SECTIONS__, _k)) { _hasAny = true; break; } }',
    '  if (!_hasAny) return;',
    '',
    ...BRIDGE_BODY_PRELUDE,
    '',
    '  // ── Standard Listener — system-owned, guaranteed correct ────────────────────',
    '  var _cancelFn = null;',
    '  // hasOwnProperty guards are load-bearing: script names arrive via an origin-unchecked',
    '  // message listener, and a bare __SECTIONS__[name] would resolve prototype keys',
    "  // ('constructor', …) to callable functions.",
    '  function _sectionBody(name) {',
    '    return (name && Object.prototype.hasOwnProperty.call(__SECTIONS__, name)) ? __SECTIONS__[name] : null;',
    '  }',
    '  var SCRIPTS = {',
    '    main: function (params) {',
    '      var body = _sectionBody(_defaultSectionId);',
    '      return body ? body(params) : null;',
    '    },',
    '  };',
    '  // THE LIVE ACTIVATION, as three retained values rather than one opaque signature string.',
    '  // _lastSig is DERIVED from them (see _sigOf) instead of being captured at startScript time:',
    '  // a policy message changes params without restarting, and a signature frozen at start would',
    '  // then describe a state the document is no longer in — after which an identical re-post of',
    '  // the NEW params would fall through to a full restart, which is the reset P1.2 removes.',
    '  var _lastName = null;',
    '  var _lastParams = null;',
    '  var _lastToken = undefined;',
    '  var _lastSig = null;',
    "  function _sigOf(name, params) { return (name || 'main') + ':' + JSON.stringify(params || {}); }",
    '  function _cloneParams(p) {',
    '    var out = {};',
    '    for (var k in p) { if (Object.prototype.hasOwnProperty.call(p, k)) out[k] = p[k]; }',
    '    if (_isArray(out.hideSelectors)) out.hideSelectors = out.hideSelectors.slice();',
    '    return out;',
    '  }',
    "  function _isArray(v) { return Object.prototype.toString.call(v) === '[object Array]'; }",
    '  // Minimal-UI mechanical hide: while params.simpleUi is on, params.hideSelectors are',
    '  // hidden via ONE <style id="__simHideUi"> (display:none !important), refreshed on every',
    '  // startScript, on every SET_UI_POLICY, and removed on stopScript / when simpleUi is falsy.',
    '  // Selectors containing { } <',
    '  // or backslash are rejected (no style/markup breakouts); the > child combinator the',
    '  // runtime-scanned structural paths use is allowed.',
    '  function applyHideUi(params) {',
    "    var st = document.getElementById('__simHideUi');",
    '    if (params && params.simpleUi && Array.isArray(params.hideSelectors)) {',
    '      var rules = [];',
    '      for (var i = 0; i < params.hideSelectors.length; i++) {',
    '        var sel = params.hideSelectors[i];',
    "        if (typeof sel !== 'string' || /[{}<\\\\]/.test(sel)) continue;",
    "        rules.push(sel + '{display:none !important}');",
    '      }',
    '      if (rules.length > 0) {',
    '        if (!st) {',
    "          st = document.createElement('style');",
    "          st.id = '__simHideUi';",
    '          (document.head || document.documentElement).appendChild(st);',
    '        }',
    "        st.textContent = rules.join('\\n');",
    '        return;',
    '      }',
    '    }',
    '    if (st && st.remove) st.remove();',
    '  }',
    "  function _post(msg) { try { window.parent && window.parent.postMessage(msg, '*'); } catch (e) {} }",
    '  // ── Auto-script timer scope (narrow, no managed-lifecycle rewrite) ──────────',
    '  // Generated section bodies drive their demo with setInterval/setTimeout created at body top',
    '  // level. Those handles live in the body closure, so the player\'s pauseScript had NOTHING it',
    '  // could stop and automation kept fighting the user after they grabbed a control (audited).',
    '  //',
    '  // TWO scopes, because they need DIFFERENT precision:',
    '  //  • _timers — every timer scheduled during the synchronous body call. Cleared on TEARDOWN',
    '  //    only. This window unavoidably also catches timers scheduled by the simulation\'s OWN',
    '  //    engine when the body calls into it synchronously (the prompt mandates one up-front',
    '  //    attempt, e.g. togglePlay()), which is harmless when everything is being torn down.',
    '  //  • _demoTimers — handles the body EXPLICITLY registered as automation. Only these are',
    '  //    cleared on pauseScript. Attribution must be exact there: pauseScript keeps the scene',
    '  //    running, so clearing an engine timer by mistake FREEZES the simulation — strictly',
    '  //    worse than the automation it was meant to stop. Delay cannot discriminate (the',
    '  //    generation prompt specifies 30-150ms demo intervals, i.e. exactly engine-loop rates),',
    '  //    so guessing is not an option and unregistered timers are deliberately left alone.',
    '  var _timers = [];',
    '  var _demoTimers = [];',
    '  // RESPAWN RECORDS — what makes v2 automation RESUMABLE (audit P1.2).',
    '  //',
    '  // pauseScript used to be one-way: it cleared the demo handles and the ids in the body closure',
    '  // went dead, so the only route back to a running demonstration was re-running the body — i.e.',
    '  // resetting the simulation. The tracking shim already sees (fn, delay, ...args) at creation',
    '  // time, so keeping that tuple costs nothing and turns "stop the demo" into something with an',
    '  // inverse. A handle registered OUTSIDE the synchronous body call has no record, is still',
    '  // stopped, and is counted as UNRESTORABLE rather than silently reported as resumed.',
    '  var _timerSpecs = {};      // id -> {kind, fn, delay, args}',
    '  var _demoSaved = [];       // specs retained while automation is paused',
    '  var _demoLost = 0;         // paused handles with no record — honestly unrestorable',
    '  var _autoStarted = true;   // the autoScript value the CURRENT body was started with',
    '  var _autoRunning = true;   // the LIVE automation policy',
    '  var _uiHook = null;        // the body\'s own re-apply hook, if it registered one',
    '  // Captured before any body can replace them: a resume must schedule through the real',
    '  // primitives, not through a shim a section left installed.',
    '  var _natSetInterval = window.setInterval, _natSetTimeout = window.setTimeout;',
    '  function _trackTimers(run) {',
    '    var ni = window.setInterval, nt = window.setTimeout;',
    '    // .apply(window, arguments) — the (fn, delay, ...args) form must keep forwarding its',
    '    // extra callback arguments; a (f, d) shim silently dropped them for the body window.',
    "    window.setInterval = function (f, d) { var xs = Array.prototype.slice.call(arguments, 2);",
    '      var id = ni.apply(window, arguments); _record(1, id, f, d, xs); return id; };',
    "    window.setTimeout = function (f, d) { return _armTimeout(nt, f, d, Array.prototype.slice.call(arguments, 2)); };",
    '    try { return run(); } finally { window.setInterval = ni; window.setTimeout = nt; }',
    '  }',
    '  function _record(kind, id, f, d, args) {',
    '    _timers.push([kind, id]);',
    '    _timerSpecs[id] = { kind: kind, fn: f, delay: d, args: args };',
    '  }',
    '  // A ONE-SHOT THAT HAS ALREADY FIRED IS NOT AUTOMATION ANY MORE (audited).',
    '  //',
    '  // Nothing used to remove a setTimeout\'s spec when it fired, so _pauseDemoTimers retained a',
    '  // COMPLETED one-shot and _resumeDemoTimers scheduled it again: toggling Auto Script off and',
    '  // then on re-ran the body\'s one-shot demo steps — applyImpulse(), a scripted click, a reset.',
    '  // That changes what the simulation COMPUTES, not merely when it is shown, which is the one',
    '  // category of change this runtime is never allowed to make. So a setTimeout is armed through',
    '  // a wrapper that forgets its own handle the instant the callback runs, BEFORE the body sees',
    '  // it — a throwing body must still be forgotten, or the throw becomes resumable.',
    '  function _forget(id) {',
    '    delete _timerSpecs[id];',
    '    // Splice rather than filter: _demoTimers is walked by index in _pauseDemoTimers, and a',
    '    // fired one-shot left in it would be counted as "stopped" and reported as unrestorable.',
    '    for (var i = _demoTimers.length - 1; i >= 0; i--) { if (_demoTimers[i] === id) _demoTimers.splice(i, 1); }',
    '  }',
    '  function _armTimeout(schedule, f, d, args) {',
    '    // The id is not known until schedule() returns, and the callback cannot run before then',
    '    // (timers never fire synchronously), so a box read at fire time is exact.',
    '    var box = { id: 0 };',
    '    // Only a FUNCTION can be wrapped. The legacy string form is passed through untouched: it',
    '    // is not forgettable, and it is not faithfully re-creatable either.',
    "    var body = (typeof f === 'function')",
    '      ? function () { _forget(box.id); return f.apply(this, arguments); }',
    '      : f;',
    '    var id = schedule.apply(window, [body, d].concat(args));',
    '    box.id = id;',
    '    _record(0, id, f, d, args);',
    '    return id;',
    '  }',
    '  // Bodies opt a handle in: _ivs.push(simDemoTimer(setInterval(step, 120))). Returns the id',
    '  // unchanged, so it stays a normal handle the body\'s own cleanup still clears.',
    '  window.simDemoTimer = function (id) { _demoTimers.push(id); return id; };',
    '  // OPTIONAL body hook for Minimal-UI. The mechanical style covers params.hideSelectors, but a',
    '  // body that hides controls with its OWN logic keeps that logic in a closure the runtime can',
    '  // not reach. A body may register a re-apply function here so a UI policy change reaches it',
    '  // WITHOUT a restart; a body that registers nothing gets the mechanical change only, and the',
    '  // acknowledgement reports bodyHook:false so the residual is visible rather than assumed away.',
    '  window.simOnUiPolicy = function (fn) { _uiHook = (typeof fn === \'function\') ? fn : null; };',
    '  /** Stop registered automation, RETAINING what is needed to start it again. */',
    '  function _pauseDemoTimers() {',
    '    var stopped = 0;',
    '    for (var i = 0; i < _demoTimers.length; i++) {',
    '      var id = _demoTimers[i];',
    '      // clearTimeout/clearInterval share one active-timer list per the HTML spec, so both',
    '      // calls are safe regardless of which primitive created the handle.',
    '      try { clearInterval(id); clearTimeout(id); } catch (e) {}',
    '      stopped++;',
    '      var spec = _timerSpecs[id];',
    '      if (spec) { _demoSaved.push(spec); delete _timerSpecs[id]; } else { _demoLost++; }',
    '    }',
    '    _demoTimers = [];',
    '    return stopped;',
    '  }',
    '  /** Re-create what _pauseDemoTimers retained. Returns counts — never a bare boolean. */',
    '  function _resumeDemoTimers() {',
    '    var saved = _demoSaved; _demoSaved = [];',
    '    var restarted = 0;',
    '    for (var i = 0; i < saved.length; i++) {',
    '      var s = saved[i], id;',
    '      try {',
    '        if (s.kind) {',
    '          id = _natSetInterval.apply(window, [s.fn, s.delay].concat(s.args));',
    '          _record(1, id, s.fn, s.delay, s.args);',
    '        } else {',
    '          // Through the SAME arming wrapper as the first schedule, so a resumed one-shot',
    '          // forgets itself when it fires instead of becoming resumable all over again.',
    '          id = _armTimeout(_natSetTimeout, s.fn, s.delay, s.args);',
    '        }',
    '      } catch (e) { _demoLost++; continue; }',
    '      _demoTimers.push(id);',
    '      restarted++;',
    '    }',
    '    var lost = _demoLost; _demoLost = 0;',
    '    return { restarted: restarted, unrestorable: lost };',
    '  }',
    '  function _clearDemoTimers() { _pauseDemoTimers(); }',
    '  function _clearTimers() {',
    '    for (var i = 0; i < _timers.length; i++) {',
    '      try { if (_timers[i][0]) clearInterval(_timers[i][1]); else clearTimeout(_timers[i][1]); } catch (e) {}',
    '    }',
    '    _timers = [];',
    '    _clearDemoTimers();',
    '    // TEARDOWN, so nothing is retained: the body and its closures are gone, and a spec pointing',
    '    // at a dead body\'s callback would resurrect the OLD section on the next resume.',
    '    _timerSpecs = {}; _demoSaved = []; _demoLost = 0;',
    '  }',
    '  function stopScript() {',
    '    // A throwing cleanup must NEVER wedge dispatch: without the try/finally, _cancelFn kept',
    '    // pointing at the throwing cleanup and EVERY later section switch re-threw — the',
    '    '  + "// document was permanently broken (audited; the oldest template got this right).",
    '    _clearTimers();',
    '    if (_cancelFn) {',
    '      var fn = _cancelFn; _cancelFn = null;',
    "      try { if (typeof fn === 'function') fn(); }",
    "      catch (err) { _post({ type: 'SCRIPT_ERROR', phase: 'cleanup', message: String(err && err.message || err) }); }",
    '    }',
    '    _drainPrelude();',
    '    _lastSig = null; _lastName = null; _lastParams = null; _lastToken = undefined;',
    '    _autoStarted = true; _autoRunning = true; _uiHook = null;',
    "    var st = document.getElementById('__simHideUi');",
    '    if (st && st.remove) st.remove();',
    '  }',
    '  function startScript(name, params, token) {',
    '    var p = params || {};',
    '    var sig = _sigOf(name, p);',
    '    if (_cancelFn && sig === _lastSig) return;   // identical re-post — keep the script running',
    '    stopScript();',
    '    _lastName = name || \'main\';',
    '    // CLONED, not aliased: the policy handlers mutate this object, and mutating the caller\'s',
    '    // structured-clone would make the sig disagree with what the parent believes it sent.',
    '    _lastParams = _cloneParams(p);',
    '    _lastSig = _sigOf(_lastName, _lastParams);',
    '    _lastToken = token;',
    '    _autoStarted = p.autoScript !== false;',
    '    _autoRunning = _autoStarted;',
    '    applyHideUi(params);   // mechanical Minimal-UI hide — refreshed on every (re)start',
    "    var _bh = document.getElementById('__simBootHide');",
    '    if (_bh && _bh.remove) _bh.remove();   // __simHideUi above is definitive — drop the boot-time hide',
    "    // Dynamic dispatch: a section id resolves its own body; the literal 'main' (old players)",
    "    // falls back to the ?section= default. An UNKNOWN modern name runs NOTHING and reports",
    '    // SCRIPT_MISSING — silently running another section\'s body is the "same variation',
    '    '  + '// everywhere" bug resurfacing (audited). Own-property guard on BOTH maps: prototype',
    "    // names ('constructor', …) arrive via an origin-unchecked listener and previously",
    '    // resolved to inherited functions, wedging the document (audited).',
    '    var own = Object.prototype.hasOwnProperty;',
    '    var fn = (name && own.call(SCRIPTS, name)) ? SCRIPTS[name] : _sectionBody(name);',
    "    if (!fn && (!name || name === 'main')) fn = SCRIPTS.main;",
    '    if (!fn) {',
    "      _post({ type: 'SCRIPT_MISSING', script: name, token: token });",
    '      return;',
    '    }',
    '    try {',
    '      _cancelFn = _trackTimers(function () { return fn(params || {}) || null; });',
    '      // Acknowledge only after ONE further frame: the body has returned AND the browser has',
    '      // had a chance to lay out/paint its changes. Posting synchronously would ack a body',
    '      // whose visible effect had not landed yet. The SYSTEM rAF is used so this bookkeeping',
    '      // frame can never itself count as the simulation\'s first paint.',
    "      var _ack = function () { _post({ type: 'SCRIPT_APPLIED', script: name || 'main', token: token }); };",
    '      if (_sysRaf) _sysRaf(_ack); else _ack();',
    '    } catch (err) {',
    '      _cancelFn = null;',
    "      _post({ type: 'SCRIPT_ERROR', phase: 'start', script: name || 'main', token: token, message: String(err && err.message || err) });",
    '    }',
    '  }',
    '  // ── Policy (audit P1.2): chrome and automation WITHOUT a restart ────────────',
    '  //',
    '  // Toggling Minimal UI or Auto Script used to arrive as a startScript with different params,',
    '  // which falls through to stopScript() — the body\'s cleanup runs, every tracked timer dies and',
    '  // the body re-runs from scratch. For a physics demonstration that is a full state reset for',
    '  // the sake of hiding a slider. Neither handler below touches _cancelFn, the tracked timers or',
    '  // the body: they move the mechanical hide style and the registered automation handles, and',
    '  // nothing else.',
    '  //',
    '  // ACTIVATION SCOPE is the v2 token the player already mints per activation — deliberately not',
    '  // a second, parallel identity. A policy carrying a token the document was not started with',
    '  // belongs to a superseded activation and is refused.',
    '  function _policyResult(kind, applied, changed, reason, extra, token) {',
    '    var msg = {',
    "      type: 'POLICY_RESULT', kind: kind, applied: applied, changed: changed,",
    '      reason: reason || null,',
    '      // A STALE policy must never ask for a restart. It describes an activation that is already',
    "      // gone; restarting for it would tear down the section that superseded it — the exact",
    '      // wrong-activation defect the identity checks exist to prevent, arriving via the recovery',
    '      // path instead of the primary one.',
    "      requiresRestart: !applied && reason !== 'stale-activation',",
    '      token: token',
    '    };',
    '    if (extra) { for (var k in extra) { if (Object.prototype.hasOwnProperty.call(extra, k)) msg[k] = extra[k]; } }',
    '    _post(msg);',
    '  }',
    '  function _policyStale(token) {',
    '    // `_lastParams`, NOT `_cancelFn`. `_cancelFn` is the body\'s CLEANUP FUNCTION, and a body is',
    '    // free to return nothing — plenty do. Keying "is a section installed" on it made every',
    '    // policy for such a section answer `stale-activation`, which carries requiresRestart:false,',
    '    // so the player neither applied the toggle nor fell back to a restart: the Minimal-UI',
    '    // checkbox moved and NOTHING happened, with no error anywhere. That is strictly worse than',
    '    // the restart this finding set out to avoid, because the restart at least worked.',
    '    // `_lastParams` is set by startScript and cleared by stopScript, so it means exactly',
    '    // "a section is installed" — which is the question being asked.',
    '    return !_lastParams || (_lastToken !== undefined && token !== undefined && token !== _lastToken);',
    '  }',
    '  function _sameHide(a, b) {',
    '    var x = _uniqSorted(a), y = _uniqSorted(b);',
    '    if (x.length !== y.length) return false;',
    '    for (var i = 0; i < x.length; i++) { if (x[i] !== y[i]) return false; }',
    '    return true;',
    '  }',
    '  function _uniqSorted(list) {',
    '    var out = [];',
    '    if (!_isArray(list)) return out;',
    '    for (var i = 0; i < list.length; i++) { if (out.indexOf(list[i]) === -1) out.push(list[i]); }',
    '    return out.sort();',
    '  }',
    '  function _onUiPolicy(d) {',
    "    if (_policyStale(d.token)) { _policyResult('ui', false, false, 'stale-activation', null, d.token); return; }",
    '    var want = { simpleUi: !!d.simpleUi, hideSelectors: _isArray(d.hideSelectors) ? d.hideSelectors : [] };',
    '    var changed = (!!_lastParams.simpleUi !== want.simpleUi) || !_sameHide(_lastParams.hideSelectors, want.hideSelectors);',
    '    if (changed) {',
    '      _lastParams.simpleUi = want.simpleUi;',
    '      _lastParams.hideSelectors = want.hideSelectors.slice();',
    '      // Keep the signature describing what is INSTALLED, so a later identical startScript is',
    '      // still recognised as a no-op instead of restarting the section it already matches.',
    '      _lastSig = _sigOf(_lastName, _lastParams);',
    '      applyHideUi(_lastParams);',
    '    }',
    '    var hooked = false;',
    '    if (changed && _uiHook) {',
    '      try { _uiHook(want); hooked = true; }',
    "      catch (err) { _post({ type: 'SCRIPT_ERROR', phase: 'uiPolicy', token: _lastToken, message: String(err && err.message || err) }); }",
    '    }',
    "    _policyResult('ui', true, changed, null, { bodyHook: hooked }, d.token);",
    '  }',
    '  function _onAutoPolicy(d) {',
    "    if (_policyStale(d.token)) { _policyResult('automation', false, false, 'stale-activation', null, d.token); return; }",
    '    var want = !!d.autoScript;',
    "    if (want === _autoRunning) { _policyResult('automation', true, false, null, null, d.token); return; }",
    '    if (want && !_autoStarted) {',
    '      // The body was RUN with autoScript off, so it never registered anything. There is nothing',
    '      // to resume and saying otherwise would be a lie; only a restart can give this section a',
    '      // demonstration, and only the player can decide to pay for one.',
    "      _policyResult('automation', false, false, 'never-started', null, d.token);",
    '      return;',
    '    }',
    '    if (want) {',
    '      var r = _resumeDemoTimers();',
    '      if (r.restarted === 0 && r.unrestorable > 0) {',
    '        // Handles were stopped but none could be recreated. Acknowledging a resume here would',
    '        // report a running demonstration that is in fact dead.',
    '        _autoRunning = false;',
    "        _policyResult('automation', false, false, 'unrestorable', { unrestorable: r.unrestorable }, d.token);",
    '        return;',
    '      }',
    '      _autoRunning = true;',
    '      _lastParams.autoScript = true; _lastSig = _sigOf(_lastName, _lastParams);',
    "      _policyResult('automation', true, true, null, { restarted: r.restarted, unrestorable: r.unrestorable }, d.token);",
    '      return;',
    '    }',
    '    var stopped = _pauseDemoTimers();',
    '    _autoRunning = false;',
    '    _lastParams.autoScript = false; _lastSig = _sigOf(_lastName, _lastParams);',
    "    _policyResult('automation', true, true, null, { stopped: stopped }, d.token);",
    '  }',
    '  window.SimAPI = { start: startScript, stop: stopScript };',
    "  window.addEventListener('message', function(e) {",
    '    // ONLY OUR OWN PARENT (simulation-004). `frame-ancestors` stops an attacker page from',
    '    // FRAMING a sim; it does not stop one holding a handle to it — window.open() on the public',
    "    // /sim-public URL, or a third-party frame nested inside the customer's own package posting",
    '    // to window.parent. Either could swap the running section, stop it, or force a hide set.',
    '    // SOURCE, NOT ORIGIN: these bytes are STORED at publication time, so an origin allow-list',
    '    // baked in here would freeze the deploy topology into every published package forever; and',
    '    // the export capture backend navigates straight to the sim URL and self-posts, so its',
    "    // messages carry the SIM's origin (source === window === window.parent, which passes).",
    '    if (e.source !== window.parent) return;',
    '    var d = e.data || {}; var type = d.type; var script = d.script; var params = d.params;',
    "    if (type === 'startScript')  startScript(script || 'main', params, d.token);",
    "    if (type === 'stopScript')   stopScript();",
    "    if (type === 'uiPolicy')     _onUiPolicy(d);",
    "    if (type === 'autoPolicy')   _onAutoPolicy(d);",
    '    // Stop the demo WITHOUT tearing the section down: the scene, the applied Minimal-UI',
    '    // policy and manual interactivity all stay exactly as they are. Clears ONLY handles the',
    '    // body registered via simDemoTimer — never the broad body-call capture, which cannot be',
    '    // told apart from the simulation\'s own engine timers (see the two scopes above). A body',
    '    // that registers nothing is simply not pausable: a no-op, never a frozen scene.',
    '    // It now has an INVERSE (autoPolicy above): the retained respawn records mean the user',
    '    // interaction that paused the demo no longer costs a restart to undo.',
    "    if (type === 'pauseScript')  { _pauseDemoTimers(); _autoRunning = false; _post({ type: 'AUTO_PAUSED' }); }",
    "    if (type === 'PING_SIM_READY' && window._simReadyFired)",
    "      window.parent?.postMessage(_readyMsg(), '*');",
    '  });',
    "  document.addEventListener('pointerdown', function() {",
    "    window.parent?.postMessage({ type: 'userInteraction' }, '*');",
    '  }, { capture: true });',
    // The v3 runtime is ADDITIVE: everything above keeps running untouched, so a player that never
    // offers a port sees precisely the document it has always seen. That is what makes the upgrade
    // safe to ship to stored packages one stage at a time.
    ...(v3 ? ['', v3] : []),
    '})();',
  ].join('\n');
}

/** Inject or update the bridge.js script tag in an HTML string using stable markers.
 *  Removes old section_*.js script tags and any previous bridge.js tags, then inserts
 *  a fresh marker block.  Returns the updated HTML. */
export function injectBridgeScriptTag(html: string, relPath: string, bridgeHash: string): string {
  const tag = `<script src="${relPath}?v=${bridgeHash}"></script>`;
  const block = `<!-- SIM_BRIDGE_SCRIPT_START -->\n${tag}\n<!-- SIM_BRIDGE_SCRIPT_END -->`;

  // Replace existing marker block if present
  if (html.includes('<!-- SIM_BRIDGE_SCRIPT_START -->')) {
    return html.replace(
      /<!-- SIM_BRIDGE_SCRIPT_START -->[\s\S]*?<!-- SIM_BRIDGE_SCRIPT_END -->/,
      block,
    );
  }

  // First time: strip old section_*.js or inline bridge scripts, then inject before </body>
  let cleaned = html
    .replace(/<script[^>]*>\s*\/\* sim-bridge[\s\S]*?<\/script>/gi, '')
    .replace(/<script[^>]*>\s*;?\s*\(function[\s\S]*?sim-bridge v[12][\s\S]*?<\/script>/gi, '');
  // Strip any stale section_*.js or bridge.js script tags
  cleaned = cleaned.replace(
    /<script[^>]+src=["'][^"']*(?:section_[^"']*\.js|bridge\.js)[^"']*["'][^>]*>\s*<\/script>/gi,
    '',
  );

  return cleaned.includes('</body>')
    ? cleaned.replace('</body>', `${block}\n</body>`)
    : cleaned + '\n' + block;
}

// ── Deterministic source hash ─────────────────────────────────────────────────

/** Compute a deterministic hash of source files.
 *  Sort by full path so the same ZIP always produces the same hash regardless of
 *  Map insertion order. Include path in the hash so renaming a file changes it. */
export function computeSourceHash(sourceMap: Map<string, string>): string {
  const sorted = [...sourceMap.entries()].sort(([a], [b]) => a.localeCompare(b));
  const combined = sorted
    .map(([path, c]) => `${path}\n${c.replace(/\r\n/g, '\n')}`)
    .join('\n---FILE---\n');
  return createHash('sha256').update(combined).digest('hex').slice(0, 12);
}

/** Compute a short hash of the generated bridge script.
 *  Exported so the replace flow can re-derive the CURRENT ?v= hash of a preserved
 *  bridge.js when re-injecting its script tag into a fresh entry HTML. */
export function computeBridgeHash(code: string): string {
  return createHash('sha256').update(code).digest('hex').slice(0, 12);
}

/**
 * Assemble the two generated artifacts of a section-bridge publication: the combined bridge.js
 * (all section bodies, this section's merged in) and the entry HTML with the bridge tag + rAF gate
 * injected. PURE — reads and writes nothing — so the byte-assembly is exactly one piece of logic
 * whether the base package came from the legacy mutable prefix or from an immutable revision.
 *
 * `mainBody` is a resolver over the CURRENTLY-stored body for this section: the LLM path
 * overwrites (returns its fresh body ignoring the argument), while the mechanical path PRESERVES
 * an existing demonstration (returns the existing body, or a no-op when absent).
 */
export function assembleSectionBridgeArtifacts(opts: {
  sectionId: string;
  /** The base package's combined bridge.js source — '' when no bridge was ever generated. */
  existingBridgeJs: string;
  /** The base package's entry HTML, as stored. */
  rawEntryHtml: string;
  /** Entry path relative to the PACKAGE ROOT (e.g. 'index.html', 'app/main.html'). */
  entryRelPath: string;
  mainBody: (existing: string | undefined) => string;
}): {
  bridgeJs: string; entryHtml: string; bridgeHash: string; sectionCount: number;
  /**
   * What the assembled artefacts can do, and what they NEED, read off the bytes that are about to
   * be published (audit P0.5 for `scriptApplied`, P0.8 for `requiresImportMaps`). Decided HERE
   * rather than at the call site so every publication path records the same answer about the same
   * text — the alternative is a second detector that can disagree with the bytes, which is how a
   * "capability" becomes a guess again.
   */
  capabilities: BridgeCapabilities;
} {
  if (!SAFE_SECTION_ID_RE.test(opts.sectionId)) throw new Error(`Unsafe sectionId: "${opts.sectionId}"`);

  // Merge: parse existing sections, add/replace the current section's body.
  const sectionEntries = parseSectionEntries(opts.existingBridgeJs);
  sectionEntries.set(opts.sectionId, opts.mainBody(sectionEntries.get(opts.sectionId)));
  // Newly generated bridges CARRY the v3 runtime. Carrying it is not the same as being trusted
  // with it: the player only takes the modern path for a package the publish-time canary has
  // classified `managed-presentable`, so a package that can speak v3 but has never proven it
  // still runs on the v2 path. Emitting the runtime here is what makes that proof possible at
  // all — a package with no v3 code can never be canaried into the modern class.
  //
  // `allManaged` / `anyQuality` are deliberately LEFT FALSE, and that is not an oversight: the
  // generation prompt produces cleanup-closure bodies, which `toLifecycle` wraps as legacy. A
  // package whose bodies cannot suspend or render on demand must not claim it can — so
  // `capabilities()` reports those false, `classifyCanaryReport` caps the package at
  // `managed-partial`, and `enableModern` declines. The consequence, stated plainly because it
  // is easy to miss: a package generated today CANNOT reach `managed-presentable`, so the v3
  // reveal path is not yet reachable for it. Closing that requires teaching the generator to
  // emit ManagedSectionLifecycle bodies — see md-files/SIM-P456-ROLLOUT.md.
  const bridgeJs = wrapBridgeCombined(sectionEntries, { runtimeV3: true });
  const bridgeHash = computeBridgeHash(bridgeJs);

  // The bridge sits at the PACKAGE ROOT (`package/bridge.js` inside a revision — the same spot
  // `<prefix>/bridge.js` occupied in the legacy layout), so the tag's relative path is derived
  // from the entry's depth WITHIN the package. Layout preservation is what keeps this stable
  // across legacy → revision publication.
  const depth = opts.entryRelPath.split('/').length - 1;
  const bridgeRelPath = (depth > 0 ? '../'.repeat(depth) : './') + 'bridge.js';
  // Ensure the head rAF gate too: entry HTML uploaded before the gate existed gains it on the
  // next generation (injectRafGate is marker-guarded and idempotent).
  const entryHtml = injectBridgeScriptTag(injectRafGate(opts.rawEntryHtml), bridgeRelPath, bridgeHash);

  return {
    bridgeJs, entryHtml, bridgeHash, sectionCount: sectionEntries.size,
    // Read off `entryHtml`, not `opts.rawEntryHtml`: the injections above STRIP script tags (stale
    // `section_*.js`, previous bridge tags, inline bridges) and add others, and the record has to
    // describe the document that is actually uploaded. Detecting on the input would be answering a
    // question about bytes no viewer will ever load.
    capabilities: { ...detectBridgeCapabilities(bridgeJs), ...detectEntryCapabilities(entryHtml) },
  };
}

/** Derive the entry HTML path relative to the sim's storage prefix.
 *  entry_file is a storage key on new rows (`simulations/<p>/<s>/index.html`) and a full
 *  public URL on legacy rows — handle both; returns null when underivable. */
export function deriveEntryRelPath(entryFile: string | null | undefined, storagePrefix: string): string | null {
  if (!entryFile) return null;
  const noQuery = entryFile.split('?')[0];
  const marker = `${storagePrefix}/`;
  if (noQuery.startsWith(marker)) return noQuery.slice(marker.length) || null;
  const idx = noQuery.indexOf(`/${marker}`);
  if (idx !== -1) return noQuery.slice(idx + 1 + marker.length) || null;
  return null;
}

// ── Full bridge validation (fatal / strong warnings / weak) ──────────────────
//
// fatal    → block upload, trigger retry (if budget remains), throw on final retry
// warnings → strong: trigger retry if budget allows, always stored in metadata
// weak     → stored in metadata only, do not block or retry
//
// Runtime validation (Playwright-based start/stop cycle) is a required future step
// (Phase 5 / Phase 4B). Static validation catches structural and security issues only.

/**
 * Validate a generated bridge.
 * @param code     — the fully assembled bridge script (mainBody already wrapped)
 * @param manifest — simulation manifest for ID/function verification
 * @param mainBody — the raw LLM-generated mainBody (used for targeted checks)
 *
 * Since the system owns the wrapper (SIM_READY, startScript/stopScript, listener),
 * structural protocol checks are now just sanity assertions on the assembled output.
 * Security and cleanup checks run on mainBody to focus on what the LLM wrote.
 */
export function validateGeneratedBridge(code: string, manifest: SimManifest, mainBody?: string, sourceText?: string): ValidationResult {
  const fatal: string[] = [];
  const warnings: string[] = [];
  const weak: string[] = [];
  const checkBody = mainBody ?? code;  // prefer checking mainBody when available
  // A reference is legitimate if it appears verbatim in the sim source — a runtime-built sim has no
  // static ids, so class selectors / instance methods / window globals live only in the JS/CSS.
  // Such refs must NOT be strong-warned (which triggers a wasteful retry/downgrade). (sim-bridge-deepfix)
  const inSource = (needle: string): boolean => !!sourceText && sourceText.includes(needle);

  // ── FATAL: Syntax check on the fully assembled script ────────────────────────
  try { new Function(code); } catch (e) { fatal.push(`Syntax error: ${(e as Error).message}`); }

  // ── FATAL: Sanity checks on assembled output (system guarantees these, but verify) ──
  if (!code.includes('SIM_READY'))        fatal.push('Assembled bridge missing SIM_READY (system error)');
  if (!code.includes('startScript'))      fatal.push('Assembled bridge missing startScript (system error)');
  if (!code.includes('stopScript'))       fatal.push('Assembled bridge missing stopScript (system error)');
  // The P1.2 policy handlers are system-owned exactly like startScript/stopScript, so their absence
  // means the wrapper was bypassed — not that a package declined a feature. FATAL rather than a
  // warning for a concrete reason: a bridge that silently lacks them still WORKS, by restarting the
  // section on every Minimal-UI toggle, which is precisely the reset this finding removed. A
  // degradation that looks identical to correct behaviour is the kind that ships.
  //
  // SCOPED TO THE DYNAMIC TEMPLATE. `dispatch: 'dynamic'` is the marker of the combined wrapper —
  // the only one anything publishes today (assembleSectionBridgeArtifacts always calls
  // wrapBridgeCombined). A load-time-locked bridge from the pre-combined wrapper cannot switch
  // sections in place either; demanding hot-swappable chrome from it would be a requirement it was
  // never built to meet, and one no publication path can produce.
  if (code.includes("dispatch: 'dynamic'")) {
    if (!code.includes("type === 'uiPolicy'")) {
      fatal.push('Assembled bridge missing the uiPolicy handler (system error)');
    }
    if (!code.includes("type === 'autoPolicy'")) {
      fatal.push('Assembled bridge missing the autoPolicy handler (system error)');
    }
    // THE ACKNOWLEDGEMENT IS NOW LOAD-BEARING (audit P0.5). Publication records whether this bridge
    // posts SCRIPT_APPLIED and the viewer's apply gate consults that record BEFORE the first
    // activation, so a template regression that dropped the ack would not merely lose a message —
    // it would silently reclassify every package published afterwards from "proven-acking" to
    // "proven-silent", which tells the gate to reveal a switch it can no longer verify. Fatal, and
    // scoped to the dynamic template for the same reason the two handlers above are: only the
    // combined wrapper is expected to have it.
    if (!detectBridgeCapabilities(code).scriptApplied) {
      fatal.push('Assembled bridge never posts SCRIPT_APPLIED (system error)');
    }
  }
  if (!code.includes("window.addEventListener('message'")) {
    fatal.push('Assembled bridge missing message listener (system error)');
  }

  // ── FATAL: Cleanup return — check in mainBody ─────────────────────────────────
  const hasCleanupReturn = checkBody.match(/return\s+(function|cleanup|\(\s*\)|_restoreAll|\w+\s*=>\s*\{)/);
  if (!hasCleanupReturn) {
    fatal.push('SCRIPTS.main implementation does not appear to return a cleanup function');
  }

  // ── FATAL: Security — run on mainBody only (LLM-written code) ────────────────
  const securityChecks: Array<[RegExp, string]> = [
    [/\bfetch\s*\(/, 'Security: fetch() is not allowed'],
    [/new\s+XMLHttpRequest\b/, 'Security: XMLHttpRequest is not allowed'],
    [/\blocalStorage\b/, 'Security: localStorage access is not allowed'],
    [/\bsessionStorage\b/, 'Security: sessionStorage access is not allowed'],
    [/document\.cookie\b/, 'Security: cookie access is not allowed'],
    [/\beval\s*\(/, 'Security: eval() is not allowed'],
    [/new\s+Function\s*\(/, 'Security: new Function() is not allowed'],
    [/window\.open\s*\(/, 'Security: window.open() is not allowed'],
    [/<script[^>]*src\s*=/, 'Security: injecting external <script src> is not allowed'],
    [/window\.parent\.location\b/, 'Security: navigating parent window is not allowed'],
    [/window\.parent\.document\b/, 'Security: reading parent DOM is not allowed'],
  ];
  for (const [pattern, message] of securityChecks) {
    if (pattern.test(checkBody)) fatal.push(message);
  }

  // ── WARNINGS: Manifest ID mismatches ─────────────────────────────────────────
  // Detect both window.fn?.() and window.fn() — not just optional chaining
  const allManifestIds = new Set([
    ...manifest.controls.map(c => c.id),
    ...manifest.buttons.map(b => b.id),
    ...manifest.selectElements.map(s => s.id),
    ...manifest.canvasElements,
    ...manifest.sections.map(s => s.id),
  ]);
  const allFns = new Set([...manifest.renderFunctions, ...manifest.updateFunctions]);
  const ignoredWindowProps = new Set([
    'SimAPI', 'parent', '_simReadyFired', 'setSimSection',
    'setupCanvas', 'initializePoints', 'applyResponsiveTableLabels',
    'addEventListener', 'removeEventListener', 'postMessage',
  ]);

  // getElementById references: both 'id' and "id" forms. An id in the manifest OR visible in the
  // source (e.g. an id set at runtime) is fine; only a truly-invented id is a strong warning.
  const getByIdRe = /document\.getElementById\(\s*['"`]([\w-]+)['"`]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = getByIdRe.exec(checkBody)) !== null) {
    if (allManifestIds.has(m[1])) continue;
    if (inSource(`"${m[1]}"`) || inSource(`'${m[1]}'`) || inSource(`id="${m[1]}"`)) {
      weak.push(`getElementById('${m[1]}') — not in manifest but present in source`);
    } else {
      warnings.push(`getElementById('${m[1]}') — ID not found in manifest`);
    }
  }

  // window.fn() and window.fn?.() calls — detect both patterns. (Note: window.__x.method() is NOT
  // matched here — the regex needs a call right after window.<name> — so runtime-global method calls
  // like window.__murmuration.toggleExploreExploit() correctly do not warn.)
  const windowFnRe = /window\.([\w]+)\s*\(|window\.([\w]+)\?\.\s*\(/g;
  while ((m = windowFnRe.exec(checkBody)) !== null) {
    const fn = m[1] ?? m[2];
    if (!fn || allFns.has(fn) || ignoredWindowProps.has(fn)) continue;
    if ((manifest.runtimeGlobals ?? []).includes(fn) || (manifest.instanceMethods ?? []).includes(fn) || inSource(fn)) {
      weak.push(`window.${fn}() — not in manifest but present in source`);
    } else {
      warnings.push(`window.${fn}() — not found in manifest functions`);
    }
  }

  // ── WARNINGS: Cleanup completeness — whole-code analysis ─────────────────────
  // Approach: if a side-effect pattern appears anywhere in code,
  // the compensating pattern should also appear anywhere in code.
  // This avoids fragile nested-brace extraction.
  const sideEffects: Array<[string, string, string]> = [
    ['setInterval',        'clearInterval',       'setInterval used — clearInterval not found in code'],
    ['setTimeout',         'clearTimeout',        'setTimeout used — clearTimeout not found in code'],
    ['addEventListener',   'removeEventListener', 'addEventListener used — removeEventListener not found in code'],
    ['insertAdjacentHTML', '.remove()',            'DOM injection used — element removal not found in code'],
    ['appendChild',        '.remove()',            'appendChild used — element removal not found in code'],
    ['classList.add',      'classList.remove',    'classList.add used — classList.remove not found in code'],
  ];
  for (const [sideEffect, compensator, message] of sideEffects) {
    if (checkBody.includes(sideEffect) && !checkBody.includes(compensator)) {
      warnings.push(message);
    }
  }

  // style.display / style.opacity — check that restore pattern exists
  if (checkBody.includes('style.display') && !checkBody.match(/style\.(?:removeProperty|display\s*=\s*['"])/)) {
    warnings.push('style.display set — display restore not clearly found in code');
  }
  if (checkBody.includes('style.opacity') && !checkBody.match(/style\.opacity\s*=\s*['"]1|style\.removeProperty\('opacity'\)/)) {
    warnings.push('style.opacity modified — opacity restore not clearly found in code');
  }

  // ── WEAK: Informational ────────────────────────────────────────────────────────
  // A selector-based hide (querySelectorAll + display:none) fulfils "hide the controls" without
  // referencing params.simpleUi, so don't flag it — the user prompt drives it directly. (sim-bridge-deepfix)
  const hidesBySelector = /querySelector(?:All)?\([^)]*\)/.test(checkBody) && /style[^\n]*display/.test(checkBody);
  if (!checkBody.includes('simpleUi') && !hidesBySelector) {
    weak.push('params.simpleUi not referenced — simpleUi toggle may have no effect');
  }
  const animates = checkBody.includes('setInterval');
  if (!checkBody.includes('autoScript') && !animates) {
    weak.push('params.autoScript not referenced — autoScript toggle may have no effect');
  }

  return { fatal, warnings, weak };
}

// ── Retry feedback formatter ──────────────────────────────────────────────────

/** Format validation errors into a clear Fiji-style retry prompt.
 *  Source files are NOT included here — they stay in the context/system prompt. */
export function formatRetryPrompt(
  validation: ValidationResult,
  bridge: GeneratedBridge,
  originalPrompt: string,
  retryReason: string,
): string {
  const sections: string[] = [
    `The bridge script has issues that must be fixed (retry reason: ${retryReason}).`,
    '',
  ];

  if (validation.fatal.length > 0) {
    sections.push('FATAL ERRORS (must fix):');
    validation.fatal.forEach((e, i) => sections.push(`  ${i + 1}. ${e}`));
    sections.push('');
  }

  if (validation.warnings.length > 0) {
    sections.push('STRONG WARNINGS (should fix):');
    validation.warnings.forEach((w, i) => sections.push(`  ${i + 1}. ${w}`));
    sections.push('');
  }

  sections.push('CURRENT mainBody SUMMARY:');
  sections.push(`  Implementation length: ${bridge.mainBody.length} chars. Confidence: ${bridge.confidence}.`);
  sections.push(`  Original request: "${originalPrompt.slice(0, 120)}"`);
  sections.push('');

  sections.push('REQUIRED:');
  sections.push('  - Fix all fatal errors listed above');
  sections.push('  - Fix all strong warnings listed above');
  sections.push('  - Preserve SIM_READY, startScript, stopScript, SimAPI, and the message listener EXACTLY');
  sections.push('  - Ensure SCRIPTS.main returns a cleanup function that reverses ALL side effects');
  sections.push('  - Do NOT include source files in your response — they are in your context');
  sections.push('  - Return the COMPLETE corrected bridge script in your JSON response');

  return sections.join('\n');
}


// ── Priority-based source file selection and budgeting ────────────────────────

const SOURCE_BUDGETS = {
  totalChars:       200_000,  // overall context budget
  htmlPerFile:       50_000,  // HTML entry files get full budget
  highPriorityJs:    30_000,  // relevant JS files
  lowPriorityJs:     10_000,  // supporting JS files
  cssPerFile:         8_000,  // CSS only if relevant to UI
  minifiedExcerpt:    2_000,  // excerpt of minified files
  largeFileTail:      5_000,  // tail chars shown for truncated files
};

function isMinified(content: string): boolean {
  const lines = content.split('\n').filter(l => l.trim().length > 0);
  if (lines.length === 0) return false;
  const sampleLines = lines.slice(0, Math.min(10, lines.length));
  return sampleLines.filter(l => l.length > 500).length > sampleLines.length * 0.5;
}

function isVendorOrLibrary(path: string): boolean {
  return /[/\\](vendor|node_modules|dist|build|polyfill|chunk|bundle)[/\\]/i.test(path) ||
    /\.(min|bundle|chunk)\.[jt]s$/.test(path);
}

/** Score a JS/TS file by path to determine how relevant it is to the simulation */
function scoreJsFile(key: string): number {
  if (isVendorOrLibrary(key)) return -100;
  const name = key.split('/').pop()?.toLowerCase() ?? '';
  let score = 0;
  if (/^(index|main|app|simulation|sim)\.[jt]s$/.test(name)) score += 12;
  if (/render|draw|redraw|repaint|canvas|physics|animate/i.test(name)) score += 8;
  if (/control|slider|input|ui|param/i.test(name)) score += 6;
  if (/util|helper|math/i.test(name)) score += 2;
  if (/lib|vendor|polyfill|third[_-]?party/i.test(name)) score -= 20;
  return score;
}

interface SourceEntry { key: string; content: string; truncated: boolean; minified: boolean; }

export function selectSources(
  rawMap: Map<string, string>,
  isSectionFile: (k: string) => boolean,
): { sourceMap: Map<string, string>; contextTruncated: boolean } {
  let remaining = SOURCE_BUDGETS.totalChars;
  let contextTruncated = false;
  const selected: SourceEntry[] = [];

  const entries = [...rawMap.entries()].filter(([k]) => !isSectionFile(k));
  const htmlEntries = entries.filter(([k]) => /\.(html|htm)$/.test(k));
  const jsEntries   = entries.filter(([k]) => /\.(js|mjs|ts)$/.test(k)).sort(([a], [b]) => scoreJsFile(b) - scoreJsFile(a));
  const cssEntries  = entries.filter(([k]) => /\.css$/.test(k));

  const addEntry = (key: string, rawContent: string, budget: number) => {
    if (remaining <= 0) { contextTruncated = true; return; }
    const minfied = isMinified(rawContent);
    let content: string;
    let truncated = false;

    if (minfied) {
      content = rawContent.slice(0, SOURCE_BUDGETS.minifiedExcerpt) +
        (rawContent.length > SOURCE_BUDGETS.minifiedExcerpt
          ? `\n// [MINIFIED — showing first ${SOURCE_BUDGETS.minifiedExcerpt} of ${rawContent.length} chars]`
          : '');
      truncated = rawContent.length > SOURCE_BUDGETS.minifiedExcerpt;
    } else if (rawContent.length > budget) {
      const head = rawContent.slice(0, budget - SOURCE_BUDGETS.largeFileTail);
      const tail = rawContent.slice(-SOURCE_BUDGETS.largeFileTail);
      content = head +
        `\n// [TRUNCATED — ${rawContent.length - head.length - SOURCE_BUDGETS.largeFileTail} chars omitted]\n` +
        tail;
      truncated = true;
    } else {
      content = rawContent;
    }

    if (truncated) contextTruncated = true;
    remaining -= content.length;
    selected.push({ key, content, truncated, minified: minfied });
  };

  // HTML always first — they contain the DOM structure with controls
  for (const [key, raw] of htmlEntries) addEntry(key, raw, SOURCE_BUDGETS.htmlPerFile);

  // JS by relevance score (high → low)
  for (const [key, raw] of jsEntries) {
    const budget = scoreJsFile(key) >= 6 ? SOURCE_BUDGETS.highPriorityJs : SOURCE_BUDGETS.lowPriorityJs;
    addEntry(key, raw, budget);
  }

  // CSS last — lower priority
  for (const [key, raw] of cssEntries) addEntry(key, raw, SOURCE_BUDGETS.cssPerFile);

  // Rebuild as sorted Map (deterministic path order)
  const sourceMap = new Map<string, string>(
    selected.sort(({ key: a }, { key: b }) => a.localeCompare(b)).map(e => [e.key, e.content])
  );

  return { sourceMap, contextTruncated };
}

// ── Conversation history normalizer ───────────────────────────────────────────

/** Normalize conversation history before passing to LLM.
 *  Strips old-format source-heavy messages and raw bridge code.
 *  Handles multi-line prompts correctly. */
export function normalizeConversationHistory(history: ConversationMessage[]): ConversationMessage[] {
  return history.map(msg => {
    if (msg.role === 'user' && msg.content.includes('## SIMULATION SOURCE FILES')) {
      // Old format: user message contained full source files.
      // Extract the actual prompt — may be multi-line, stop at next section separator.
      const promptMatch = msg.content.match(
        /(?:SECTION|REFINEMENT|FIX)\s*PROMPT:\s*([\s\S]+?)(?:\n\n---|(?:\n)simpleUi\s*=|\nautoScript\s*=|\nGenerate the|\nUpdate the|\nFix all|$)/i
      );
      const extracted = promptMatch?.[1]?.trim();
      return {
        role: 'user' as const,
        content: extracted && extracted.length > 0 ? extracted : '[previous prompt]',
      };
    }
    if (msg.role === 'assistant') {
      // Old format: raw or truncated bridge code in history
      const looksLikeCode = msg.content.includes('(function') || msg.content.includes('SCRIPTS') ||
        msg.content.includes('startScript') || msg.content.includes('SIM_READY');
      const alreadySummarized = msg.content.startsWith('Bridge for:') || msg.content.startsWith('[Previous bridge');
      if (looksLikeCode && !alreadySummarized) {
        return {
          role: 'assistant' as const,
          content: `[Previous bridge generated (${msg.content.length} chars)]`,
        };
      }
    }
    return msg;
  });
}

// ── Bridge summary builder (for conversation history) ─────────────────────────

function buildBridgeSummary(bridge: GeneratedBridge, prompt: string): string {
  const code = bridge.mainBody;  // summary uses mainBody — bridgeScript is system-assembled
  const intervalCount = (code.match(/setInterval/g) ?? []).length;
  const fnCalls = [...code.matchAll(/window\.([\w]+)\?\./g)].map(m => m[1]).filter(Boolean);
  const hiddenIds = [...code.matchAll(/getElementById\(['"`]([\w-]+)['"`]\)/g)].map(m => m[1]);
  return [
    `Bridge for: "${prompt.slice(0, 80)}".`,
    `Length: ${code.length} chars. Confidence: ${bridge.confidence}.`,
    intervalCount > 0 ? `Animation: yes (${intervalCount} loops).` : 'Animation: no.',
    hiddenIds.length > 0 ? `DOM IDs: ${hiddenIds.slice(0, 6).join(', ')}.` : '',
    fnCalls.length > 0   ? `Calls: ${fnCalls.slice(0, 4).join(', ')}.` : '',
    bridge.warnings.length > 0 ? `Warnings: ${bridge.warnings.slice(0, 2).join('; ')}.` : '',
    'SCRIPTS.main returns cleanup.',
  ].filter(Boolean).join(' ');
}

// ── ContextPack builder (source files → system/context prompt) ───────────────

/**
 * The one extra rule a PORTRAIT project's bridge generator gets, or '' for landscape so every
 * existing prompt stays byte-identical (and its provider cache warm). Kept tiny and stable — it
 * is part of the cached system prefix.
 */
export const PORTRAIT_VIEWPORT_RULES =
  '\n\nVIEWPORT: this project is PORTRAIT. The simulation is displayed in a 9:16 frame (e.g. 1080×1920) ' +
  'in the editor, the viewer and the exported video. Lay out for a tall, narrow viewport: stack controls ' +
  'vertically, keep the main visual centred and full-width, never assume a wide canvas, and read the ' +
  'actual window size on resize rather than hard-coding a landscape aspect.';

async function portraitViewportRules(projectId: string): Promise<string> {
  try {
    const rows = await db.query.video_files.findMany({
      where: eq(video_files.project_id, projectId),
      orderBy: [asc(video_files.created_at)],
      columns: { width: true, height: true, is_broll: true },
    });
    return projectOrientation(rows) === 'portrait' ? PORTRAIT_VIEWPORT_RULES : '';
  } catch {
    return '';
  }
}

export function buildContextPrompt(
  baseInstructions: string,
  sourceMap: Map<string, string>,
  manifest: SimManifest,
  sourceHash: string,
  contextTruncated: boolean,
): string {
  // Sort deterministically by full storage path — critical for consistent prompt caching
  const sortedEntries = [...sourceMap.entries()].sort(([a], [b]) => a.localeCompare(b));

  const sourceFilesText = sortedEntries
    .map(([key, content]) => {
      const filename = key.split('/').pop() ?? key;
      const ext = filename.split('.').pop() ?? '';
      return `### ${filename}\n\`\`\`${ext}\n${content}\n\`\`\``;
    })
    .join('\n\n');

  const manifestSummary = JSON.stringify({
    controls:         manifest.controls.map(c => ({ id: c.id, type: c.type, label: c.label, min: c.min, max: c.max })),
    buttons:          manifest.buttons,
    sections:         manifest.sections.map(s => s.id),
    selectElements:   manifest.selectElements,
    checkboxElements: manifest.checkboxElements,
    canvasElements:   manifest.canvasElements,
    globalObjects:    manifest.globalObjects,
    renderFunctions:  manifest.renderFunctions,
    updateFunctions:  manifest.updateFunctions,
    hasSetSimSection: manifest.hasSetSimSection,
    // Handles for runtime-built sims (empty for classic static-HTML sims). (sim-bridge-deepfix)
    runtimeGlobals:   manifest.runtimeGlobals,   // e.g. ["__murmuration"] → window.__murmuration
    instanceMethods:  manifest.instanceMethods,  // e.g. ["toggleExploreExploit"] → app.<method>()
    cssControls:      manifest.cssControls,       // e.g. ["controls","show-menu-tab"] → querySelectorAll('.controls')
  }, null, 2);

  const contextMeta = [
    `<!-- sourceHash: ${sourceHash} -->`,
    contextTruncated ? '<!-- contextTruncated: true — some large files were excerpted -->' : '',
  ].filter(Boolean).join('\n');

  return [
    baseInstructions,
    '',
    '## SIMULATION SOURCE FILES',
    contextMeta,
    sourceFilesText,
    '',
    '## MANIFEST (verified IDs and functions)',
    '```json',
    manifestSummary,
    '```',
  ].join('\n');
}

// ── SimulationService ─────────────────────────────────────────────────────────

export class SimulationService {
  /**
   * Per-simulation promise chain — serialises concurrent section-bridge PUBLICATIONS in-process.
   *
   * Correctness no longer depends on this: publication is staged into a never-reused revision
   * prefix and activated by compare-and-set, so a cross-process race loses with a RevisionConflict
   * instead of clobbering anything. The lock is kept as a UX nicety for the common single-process
   * deployment — two sections of the same simulation generating concurrently serialise here, so the
   * second publication builds on the first's revision instead of losing its CAS and asking the
   * user to retry.
   */
  private readonly bridgeLocks = new Map<string, Promise<void>>();

  /** Lazily constructed so tests injecting a fake storage adapter get a RevisionService bound to it. */
  private _revisions: RevisionService | null = null;

  constructor(
    private readonly storage: StorageService,
    private readonly llmService: LLMService,
  ) {}

  private revisions(): RevisionService {
    if (!this._revisions) this._revisions = new RevisionService(this.storage);
    return this._revisions;
  }

  private async withBridgeLock<T>(simKey: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.bridgeLocks.get(simKey) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>(r => { release = r; });
    this.bridgeLocks.set(simKey, next);
    try {
      await prior;
      return await fn();
    } finally {
      release();
      if (this.bridgeLocks.get(simKey) === next) this.bridgeLocks.delete(simKey);
    }
  }

  async processUpload(opts: {
    projectId: string;
    simId:     string;
    zipBuffer: Buffer;
  }): Promise<{ entryUrl: string; entryKey: string; bridgeFunctions: BridgeFunction[] }> {
    const { projectId, simId, zipBuffer } = opts;
    const files = this.extractZip(zipBuffer);
    return this.processFiles({ projectId, simId, files });
  }

  async processFileUpload(opts: {
    projectId: string;
    simId:     string;
    files:     UploadedSimulationFile[];
  }): Promise<{ entryUrl: string; entryKey: string; bridgeFunctions: BridgeFunction[] }> {
    const files = this.normalizeUploadedFiles(opts.files);
    return this.processFiles({ projectId: opts.projectId, simId: opts.simId, files });
  }

  private async processFiles(opts: {
    projectId: string;
    simId:     string;
    files:     Map<string, Buffer>;
  }): Promise<{ entryUrl: string; entryKey: string; bridgeFunctions: BridgeFunction[] }> {
    const { projectId, simId, files } = opts;
    const prefix = `simulations/${projectId}/${simId}`;

    if (files.size === 0) throw new Error('Simulation bundle appears to be empty');

    const entryRelPath = this.findEntryHtml(files);
    if (!entryRelPath) throw new Error('No HTML file found in simulation bundle. Add an index.html or similar.');

    const bridgeFunctions: BridgeFunction[] = [];
    const rawHtml      = files.get(entryRelPath)!.toString('utf-8');
    const injectedHtml = this.injectBridge(rawHtml, bridgeFunctions);
    files.set(entryRelPath, Buffer.from(injectedHtml, 'utf-8'));

    // Bound the upload fan-out: a sim bundle can be up to ~1000 files, and firing every PUT at
    // once opened that many concurrent storage connections at peak. Upload in fixed-size waves
    // so concurrency (and live connections) stay capped (backend-010).
    const entries = [...files.entries()];
    const UPLOAD_CONCURRENCY = 12;
    logger.info({ simId, projectId, fileCount: entries.length }, 'Uploading simulation files to storage');
    for (let i = 0; i < entries.length; i += UPLOAD_CONCURRENCY) {
      await Promise.all(
        entries.slice(i, i + UPLOAD_CONCURRENCY).map(([relPath, buf]) => {
          // Keys are simId-scoped: media assets are write-once, so mark them immutable —
          // the browser/CDN then caches them across sim reloads (image-heavy sims load
          // once instead of re-fetching every asset). HTML/JS are excluded: the entry
          // HTML and bridge.js get overwritten in place by bridge (re)generation, and
          // they're served through the /sim-public proxy with its own cache policy anyway.
          const rewritable = /\.(html?|m?js)$/i.test(relPath);
          // BOUNDED, never `immutable`: "Replace simulation" overwrites every key in place, and
          // binary assets are served by a redirect to the bucket object — whose OWN Cache-Control
          // is what the browser keeps. A year-long immutable value pinned replaced textures/audio
          // with no revalidation path (audited). Restore long caching only with content-addressed
          // revision prefixes (roadmap).
          return this.storage
            .uploadFile(
              `${prefix}/${relPath}`,
              buf,
              getSimulationContentType(relPath),
              rewritable ? undefined : 'public, max-age=3600',
            )
            .then(() => undefined);
        }),
      );
    }

    // The package was written in place: anything served from memory for this prefix is stale.
    simLegacyTextCache.evictPrefix(prefix);

    const entryStoragePath = `${prefix}/${entryRelPath}`;
    const entryUrl = this.storage.getSimPublicUrl(entryStoragePath);

    logger.info({ simId, projectId, entryRelPath }, 'Simulation uploaded');
    return { entryUrl, entryKey: entryStoragePath, bridgeFunctions };
  }

  /** Normalize an upload (one ZIP or a file bundle) into a relPath→Buffer map.
   *  Public so the replace endpoint can validate the entry file BEFORE responding 202. */
  buildUploadFileMap(opts: { zipBuffer?: Buffer | null; files?: UploadedSimulationFile[] }): Map<string, Buffer> {
    if (opts.zipBuffer && opts.zipBuffer.length > 0) return this.extractZip(opts.zipBuffer);
    return this.normalizeUploadedFiles(opts.files ?? []);
  }

  /** In-place file swap for an existing simulation (same simId + storage prefix).
   *
   *  - New files are uploaded over the old keys; stale keys (present before, absent now)
   *    are deleted EXCEPT generated artifacts: bridge.js, guidance.js, guidance/* (audio +
   *    understanding.md) and legacy section_*.html/js files.
   *  - The new entry HTML gets the head rAF gate re-injected, plus either the existing
   *    combined bridge.js script tag (with its CURRENT content hash) or — when no bridge.js
   *    was ever generated — the inline bridge v2 template, and the guidance.js tag when a
   *    published guidance.js exists.
   *  - The new bundle MUST contain an HTML file at `entryRelPath` (the previous entry path):
   *    sections' stored simulation_url embeds that exact path, so renaming the entry would
   *    break them. Callers reject mismatches up front; this re-checks defensively.
   *  - Sections' simulation_url / sim_meta are intentionally NOT touched — the generate flow
   *    detects stale sources via sourceHash on the next generation.
   */
  async processReplace(opts: {
    projectId:    string;
    simId:        string;
    files:        Map<string, Buffer>;
    entryRelPath: string;
  }): Promise<{
    entryUrl:           string;
    entryKey:           string;
    bridgeFunctions:    BridgeFunction[];
    uploadedCount:      number;
    deletedStale:       string[];
    preservedGenerated: string[];
  }> {
    const { projectId, simId, files, entryRelPath } = opts;
    const prefix = `simulations/${projectId}/${simId}`;

    if (files.size === 0) throw new Error('Replacement bundle appears to be empty');
    if (!files.has(entryRelPath)) {
      throw new Error(
        `Replacement bundle must contain the entry file "${entryRelPath}" — upload with the same entry HTML name`,
      );
    }

    // Current keys — needed to compute stale files. Listing can be denied on restricted
    // tokens; then we do an overwrite-only replace (no stale deletion) instead of failing.
    let existingKeys: string[] = [];
    let listingAvailable = true;
    try {
      existingKeys = await this.storage.listObjects(prefix);
    } catch {
      listingAvailable = false;
      logger.warn({ prefix }, 'listObjects failed during replace — stale files will not be deleted');
    }

    // Generated artifacts must survive the swap (they are system-owned, not part of the upload).
    //
    // `isSystemOwnedKey` covers the two SUBTREES that are not part of the customer's bundle at
    // all: immutable revisions and captured posters. Both live under this same simulation prefix
    // and neither appears in an incoming bundle, so without it an ordinary replace swept every
    // published revision's bytes while its `sim_revisions` row survived — leaving a revision that
    // still activates (the promote CAS checks manifest_hash/entry_path, never that bytes exist)
    // and a pointer that resolves to nothing. Filename rules cannot express this: a revision's own
    // `bridge.js` matches the pattern below and survives while its `index.html` and `manifest.json`
    // do not, which corrupts the package more quietly than deleting all of it.
    const isGeneratedKey = (k: string): boolean =>
      isSystemOwnedKey(k, prefix) ||
      /\/(bridge|guidance)\.js$/.test(k) ||
      k.startsWith(`${prefix}/guidance/`) ||
      /\/section_[^/]+\.(html|js)$/.test(k);

    // Read the current generated artifacts so their script tags can be re-wired into the
    // fresh entry HTML with their CURRENT hashes (section URLs keep working unchanged).
    let bridgeJs: string | null = null;
    try { bridgeJs = (await this.storage.readObject(`${prefix}/bridge.js`)).toString('utf-8'); }
    catch { /* no combined bridge generated yet */ }
    let guidanceJs: string | null = null;
    try { guidanceJs = (await this.storage.readObject(`${prefix}/guidance.js`)).toString('utf-8'); }
    catch { /* no guidance published yet */ }

    const bridgeFunctions: BridgeFunction[] = [];
    const entryKey = `${prefix}/${entryRelPath}`;
    const entryDir = entryKey.substring(0, entryKey.lastIndexOf('/'));
    const relativeDepth = entryDir === prefix
      ? 0
      : entryDir.slice(prefix.length).split('/').filter(Boolean).length;
    const relPrefix = relativeDepth > 0 ? '../'.repeat(relativeDepth) : './';

    let html = injectRafGate(files.get(entryRelPath)!.toString('utf-8'));
    if (bridgeJs !== null) {
      html = injectBridgeScriptTag(html, `${relPrefix}bridge.js`, computeBridgeHash(bridgeJs));
    } else {
      html = injectInlineBridge(html, bridgeFunctions);
    }
    if (guidanceJs !== null) {
      // Lazy import — a static SimulationService⇄GuidanceService import would be circular.
      const { injectGuidanceScriptTag, computeGuidanceHash } = await import('./GuidanceService.js');
      html = injectGuidanceScriptTag(html, `${relPrefix}guidance.js`, computeGuidanceHash(guidanceJs));
    }
    files.set(entryRelPath, Buffer.from(html, 'utf-8'));

    // Upload in fixed-size waves — same concurrency cap as the initial upload (backend-010).
    // Unlike the initial upload, NOTHING is marked immutable here: replaced assets reuse
    // their old keys, so immutable metadata would pin stale content at the bucket edge.
    const entries = [...files.entries()];
    const UPLOAD_CONCURRENCY = 12;
    logger.info({ simId, projectId, fileCount: entries.length }, 'Replacing simulation files in storage');
    for (let i = 0; i < entries.length; i += UPLOAD_CONCURRENCY) {
      await Promise.all(
        entries.slice(i, i + UPLOAD_CONCURRENCY).map(([relPath, buf]) =>
          this.storage
            .uploadFile(`${prefix}/${relPath}`, buf, getSimulationContentType(relPath))
            .then(() => undefined),
        ),
      );
    }

    // Delete stale files AFTER the uploads so a viewer never sees a half-missing sim.
    // Best-effort: a failed delete leaves a harmless orphan and must not fail the swap.
    simLegacyTextCache.evictPrefix(prefix);
    const newKeySet = new Set(entries.map(([relPath]) => `${prefix}/${relPath}`));
    const staleKeys = listingAvailable
      ? existingKeys.filter(k => k.startsWith(`${prefix}/`) && !newKeySet.has(k) && !isGeneratedKey(k))
      : [];
    const deletedStale: string[] = [];
    for (const key of staleKeys) {
      try {
        await this.storage.deleteFile(key);
        deletedStale.push(key);
      } catch (err) {
        logger.warn({ err, key }, 'Could not delete stale simulation file during replace');
      }
    }
    const preservedGenerated = listingAvailable
      ? existingKeys.filter(k => k.startsWith(`${prefix}/`) && isGeneratedKey(k))
      : [];

    const entryUrl = this.storage.getSimPublicUrl(entryKey);
    logger.info(
      { simId, projectId, entryRelPath, uploaded: entries.length, deletedStale: deletedStale.length, preservedGenerated: preservedGenerated.length },
      'Simulation files replaced',
    );
    return { entryUrl, entryKey, bridgeFunctions, uploadedCount: entries.length, deletedStale, preservedGenerated };
  }

  /**
   * REPLACE, FOR A PACKAGE THAT PUBLISHES FROM IMMUTABLE REVISIONS (audit D-04).
   *
   * `processReplace` above overwrites the mutable prefix in place. A simulation with an
   * `active_revision_id` does not serve that prefix, so running it there wrote bytes nobody reads
   * and reported success — the defect 9a79c56 made loud. This is the operation it was refusing to
   * do: the same product behaviour (the customer's new files, the SAME entry name, the generated
   * runtime preserved and re-wired) expressed as a NEW revision that a compare-and-set makes live.
   *
   * WHAT COMBINES WITH WHAT
   *   - every uploaded file becomes package content of the new revision;
   *   - the LIVE runtime — `bridge.js` with every section body published so far, `guidance.js` with
   *     the published cues — is carried across from the ACTIVE revision, because it is system-owned
   *     and was never in the customer's bundle. That is the whole point of "replace" rather than
   *     "upload a new simulation": section scripts and guidance survive a file swap;
   *   - the uploaded entry document is re-wired to both, with their CURRENT hashes, plus the head
   *     rAF gate. An upload that itself contains `bridge.js` or `guidance.js` wins over the carried
   *     copy — those are the customer's bytes at that path and silently discarding them would be a
   *     different operation than the one they asked for;
   *   - a base file that the upload does not contain and that is not runtime is DROPPED. In the
   *     legacy path that was a stale-key delete; here it is simply a file the new revision does not
   *     contain, which is the same outcome without a delete that can half-fail.
   *
   * NOTHING IS WRITTEN OUTSIDE THE NEW REVISION'S PREFIX — no upload to the mutable prefix, no
   * delete anywhere, and the base revision's bytes are untouched so a rollback still has a package
   * to return to.
   *
   * THE ROW'S `status` MOVES INSIDE THE ACTIVATION TRANSACTION. A replace claims the row as
   * `processing`; if the terminal `ready` were a second statement after `activate()` resolved, a
   * lost compare-and-set or a crash in between would leave a simulation that is live and a row
   * that says it is still working — a package permanently unreplaceable because the status gate
   * never clears. `onActivated` runs inside the same transaction as the pointer flip, so the two
   * commit together or neither does.
   */
  async replaceIntoRevision(opts: {
    projectId:    string;
    simId:        string;
    files:        Map<string, Buffer>;
    entryRelPath: string;
    signal?:      AbortSignal;
  }): Promise<{
    revisionId:      string;
    revisionNumber:  number;
    entryKey:        string;
    bridgeFunctions: BridgeFunction[];
    /** Bundle paths taken from the ACTIVE revision because the upload did not supply them. */
    carriedForward:  string[];
    /** Bundle paths the ACTIVE revision had that the new one does not. */
    droppedFromBase: string[];
  }> {
    const { files, entryRelPath } = opts;
    if (files.size === 0) throw new Error('Replacement bundle appears to be empty');
    if (!files.has(entryRelPath)) {
      throw new Error(
        `Replacement bundle must contain the entry file "${entryRelPath}" — upload with the same entry HTML name`,
      );
    }

    // Filled by the transform, read by the activation hook. The transform always runs first, and
    // `deriveRevision` never reaches the hook when it does not.
    const bridgeFunctions: BridgeFunction[] = [];
    const carriedForward: string[] = [];
    let droppedFromBase: string[] = [];

    const result = await deriveRevision({
      storage: this.storage,
      revisions: this.revisions(),
      simulationId: opts.simId,
      projectId: opts.projectId,
      createdBy: 'simulation-replace',
      trigger: 'replace',
      signal: opts.signal,
      transform: async (base) => {
        // THE NEW REVISION IS ALWAYS `package/`-NESTED, and that is a correctness requirement here
        // rather than a convention.
        //
        // A replace rebuilds the whole customer package from an uploaded bundle, so every path —
        // the upload's and the runtime carried across — is re-derived from its bundle-relative
        // name. Preserving a pre-nesting base's FLAT layout would put customer paths at the
        // revision root, where a bundle containing `manifest.json` composes the same key as the
        // revision's own manifest: `validate()` writes ours last, so the customer's file would be
        // silently replaced by our manifest AFTER byte verification had already passed it. The
        // `package/` subdirectory exists precisely so a customer name cannot shadow ours.
        //
        // Re-nesting is safe because it moves EVERY file together — the break
        // `revisionPathForLegacy` warns about came from hoisting SOME files (runtime into a
        // sibling `runtime/`) while leaving the entry behind, which changed what the entry's own
        // relative references resolved to. A uniform shift changes nothing relative.
        const toManifestPath = (rel: string): string => manifestPathForBundleRel(rel, true);
        const uploaded = new Set(files.keys());

        // ── Runtime carried forward from the LIVE revision ────────────────────────────────────
        const carried: DerivedFile[] = [];
        const carriedBytes = new Map<string, Buffer>();
        for (const f of base.manifest.files ?? []) {
          if (f.role !== 'runtime') continue;
          const rel = bundleRelPathForManifestPath(f.path);
          if (!rel || uploaded.has(rel)) continue;
          const bytes = await base.read(f.path);
          carriedBytes.set(rel, bytes);
          carried.push({
            // Re-derived from the bundle name, like every other file — carrying `f.path` verbatim
            // would leave a pre-nesting base's `bridge.js` at the revision root while the entry
            // moved into `package/`, and the entry's `./bridge.js` would 404.
            manifestPath: toManifestPath(rel), role: 'runtime', contentType: f.contentType,
            read: async () => bytes,
          });
          carriedForward.push(rel);
        }
        droppedFromBase = (base.manifest.files ?? [])
          .filter((f) => f.role === 'asset' || f.role === 'entry')
          .map((f) => bundleRelPathForManifestPath(f.path))
          .filter((rel): rel is string => rel !== null && !uploaded.has(rel));

        // ── The entry document, re-wired to whichever runtime the new revision will contain ────
        const runtimeText = (rel: string): string | null => {
          const fromUpload = files.get(rel);
          if (fromUpload) return fromUpload.toString('utf-8');
          const fromBase = carriedBytes.get(rel);
          return fromBase ? fromBase.toString('utf-8') : null;
        };
        const bridgeJs = runtimeText('bridge.js');
        const guidanceJs = runtimeText('guidance.js');

        let html = injectRafGate(files.get(entryRelPath)!.toString('utf-8'));
        if (bridgeJs !== null) {
          html = injectBridgeScriptTag(html, packageRootRelPath(entryRelPath, 'bridge.js'), computeBridgeHash(bridgeJs));
        } else {
          html = injectInlineBridge(html, bridgeFunctions);
        }
        if (guidanceJs !== null) {
          // Lazy import — a static SimulationService⇄GuidanceService import would be circular.
          const { injectGuidanceScriptTag, computeGuidanceHash } = await import('./GuidanceService.js');
          html = injectGuidanceScriptTag(html, packageRootRelPath(entryRelPath, 'guidance.js'), computeGuidanceHash(guidanceJs));
        }

        const uploadedFiles: DerivedFile[] = [...files.entries()].map(([rel, bytes]) => {
          const isEntry = rel === entryRelPath;
          const isRuntime = rel === 'bridge.js' || rel === 'guidance.js';
          const finalBytes = isEntry ? Buffer.from(html, 'utf-8') : bytes;
          return {
            manifestPath: toManifestPath(rel),
            role: isEntry ? 'entry' : isRuntime ? 'runtime' : 'asset',
            contentType: getSimulationContentType(rel),
            read: async () => finalBytes,
          };
        });

        return {
          files: [...uploadedFiles, ...carried],
          entryManifestPath: toManifestPath(entryRelPath),
          metadata: {
            // Read off the bytes that are about to be published, not off the input — the injections
            // above strip and add script tags, so the record has to describe the document a viewer
            // will actually load (audit P0.5 / P0.8, same rule as assembleSectionBridgeArtifacts).
            [BRIDGE_CAPABILITIES_KEY]: derivedCapabilities({
              baseMetadata: base.metadata, bridgeJs, entryHtml: html,
            }),
            replacedFileCount: files.size,
          },
        };
      },
      onActivated: async (tx) => {
        await tx
          .update(simulations)
          .set({ status: 'ready', error: null, bridge_functions: bridgeFunctions })
          .where(eq(simulations.id, opts.simId));
      },
    });

    logger.info(
      { simId: opts.simId, projectId: opts.projectId, revisionId: result.revisionId,
        revisionNumber: result.revisionNumber, uploaded: files.size,
        carriedForward: carriedForward.length, droppedFromBase: droppedFromBase.length },
      'Simulation files replaced into a new revision',
    );

    return {
      revisionId: result.revisionId,
      revisionNumber: result.revisionNumber,
      entryKey: result.entryKey,
      bridgeFunctions,
      carriedForward,
      droppedFromBase,
    };
  }

  // ── AI-powered per-section bridge generation ──────────────────────────────────

  async generateBridgeScript(opts: {
    simId:             string;
    sectionId:         string;
    projectId:         string;
    userId:            string;
    prompt:            string;
    simpleUi:          boolean;
    autoScript:        boolean;
    uiControls?:       SimUiSelection;  // normalized Minimal-UI selection — adds ONE compact prompt block
    entryKey?:         string;           // storage key for the entry HTML (from DB) — used when listing is denied
    storedSourceHash?: string;          // from sim_meta — service owns invalidation
    conversationHistory?: ConversationMessage[];
    onEvent?: (event: string, data: object) => void;
    signal?: AbortSignal;
    /** Runs inside the activation transaction with the FULL generation result — see SectionPersistHook. */
    persistSection?: (tx: RevisionDbTx, result: BridgeGenerationResult) => Promise<void>;
  }): Promise<BridgeGenerationResult> {
    const { simId, sectionId, projectId, userId, prompt, simpleUi, autoScript, onEvent, signal } = opts;
    const prefix = `simulations/${projectId}/${simId}`;

    // 1. Load all text source files with priority budgeting
    onEvent?.('status', { status: 'Loading simulation files…', type: 'progress' });
    const isText        = (k: string) => /\.(js|mjs|html|htm|css|ts)$/.test(k);
    const isSectionFile = (k: string) =>
      /section_[^/]+\.(html|js)$/.test(k) || /\/bridge\.js$/.test(k);

    // Try to list objects; when the storage token lacks ListBucket permission
    // (e.g. R2 write-only token) fall back to probing the public entry HTML.
    const allKeys = await this.listSimKeys(prefix, opts.entryKey);

    // Read all candidate text files (skip section-specific generated files).
    // For each file, prefer storage.readObject; fall back to public URL read
    // when the storage token lacks GetObject permission.
    const rawMap = new Map<string, string>();
    await Promise.all(
      allKeys.filter(k => isText(k)).map(async key => {
        try {
          let raw: string;
          try {
            const buf = await this.storage.readObject(key);
            raw = buf.toString('utf-8');
          } catch {
            const res = await fetch(this.storage.getSimPublicUrl(key));
            if (!res.ok) return;
            raw = await res.text();
          }
          // Strip system-injected blocks (rAF gate + inline bridge) so the LLM context and
          // the deterministic sourceHash stay stable across gate/bridge (re-)injection.
          raw = stripRafGate(raw)
            .replace(/<script[^>]*>\s*\/\* sim-bridge[\s\S]*?<\/script>/gi, '')
            .replace(/<script[^>]*>\s*;?\s*\(function[\s\S]*?sim-bridge v[12][\s\S]*?<\/script>/gi, '');
          rawMap.set(key, raw);
        } catch { /* skip unreadable files */ }
      }),
    );

    // Apply priority scoring and budget — produce final sourceMap
    const { sourceMap, contextTruncated } = selectSources(rawMap, isSectionFile);

    // 2. Compute deterministic source hash (includes path + content, sorted)
    const sourceHash = computeSourceHash(sourceMap);

    // 3. Own sourceHash invalidation: if the stored hash differs, the old history
    //    references stale IDs/functions and must be discarded.
    let conversationHistory = opts.conversationHistory ?? [];
    if (opts.storedSourceHash && opts.storedSourceHash !== sourceHash) {
      conversationHistory = [];
      logger.info({ sectionId, old: opts.storedSourceHash, new: sourceHash }, 'sourceHash changed — conversation history cleared');
    }
    // Normalize regardless (strips old source-heavy or code-heavy messages)
    conversationHistory = normalizeConversationHistory(conversationHistory);

    // 4. Build manifest from the selected source files
    onEvent?.('status', { status: 'Analyzing simulation structure…', type: 'progress' });
    const manifest = buildManifest(sourceMap);
    logger.info({ simId, sectionId, controls: manifest.controls.length, renderFns: manifest.renderFunctions, contextTruncated }, 'Manifest built');

    // 5. Load system/context prompt from DB (admin-editable), fall back to hardcoded
    const dbPrompt = await db.query.system_prompts.findFirst({ where: eq(system_prompts.key, 'bridge_plan') });
    // The offline/capture rules are prepended OUTSIDE the fallback, deliberately. An admin who
    // customises this prompt must not be able to switch them off by accident: they are a platform
    // invariant the publish validator enforces regardless, so a package that ignores them is
    // rejected later anyway — stating them up front is the difference between a rejection and a
    // simulation that works. Appending them to the hardcoded default instead made them INERT for
    // exactly the case the comment above calls expected.
    const authored = dbPrompt?.is_customized ? dbPrompt.content : BRIDGE_GENERATION_SYSTEM_PROMPT;
    // A portrait project (night run 2026-09-03 §3) tells the generator so: the simulation will
    // be shown in a 9:16 frame in the editor, the viewer and the export, and a layout that
    // assumes a wide viewport wastes most of it. Landscape says nothing — byte-identical prompt.
    const viewportRules = await portraitViewportRules(projectId);
    const baseSystemPrompt = `${CAPTURE_AUTHORING_RULES}${viewportRules}\n\n${authored}`;

    // 6. Build deterministic ContextPack — source files + manifest live in the system prompt.
    //    This is provider-neutral: Claude caches it; OpenAI/Gemini receive it in system role.
    const contextPrompt = buildContextPrompt(baseSystemPrompt, sourceMap, manifest, sourceHash, contextTruncated);

    // 7. Call LLM + unified retry budget
    //    One maxBridgeRetries retry covers: fatal validation, strong warnings, low confidence.
    //    Runtime validation (Playwright-based start/stop cycle) is a REQUIRED future step.
    const MAX_BRIDGE_RETRIES = 1;
    const isRefinement = conversationHistory.length > 0;

    // Throttle token heartbeat to at most one SSE event per 500ms
    let lastTokenEventMs = 0;
    const tokenHeartbeat = opts.onEvent
      ? (_chunk: string) => {
          const now = Date.now();
          if (now - lastTokenEventMs >= 500) {
            lastTokenEventMs = now;
            opts.onEvent!('token', { content: '' });
          }
        }
      : undefined;

    onEvent?.('status', { status: isRefinement ? 'Refining bridge script...' : 'Generating bridge script...', type: 'progress' });

    let { bridge, conversationHistory: updatedHistory, provider: llmProvider, model: llmModel } = await this.callLLMForBridge({
      contextPrompt, manifest, prompt, simpleUi, autoScript,
      uiControls: opts.uiControls,
      userId, projectId, conversationHistory, signal,
      onTokenChunk: tokenHeartbeat,
    });

    onEvent?.('status', { status: 'Validating bridge script...', type: 'progress' });
    // System wraps LLM-generated mainBody into the deterministic bridge template.
    // This guarantees SIM_READY, startScript, stopScript, and message listener are ALWAYS correct.
    const assembledBridgeScript = wrapBridgeMainBody(bridge.mainBody);
    // Concatenated source so validation can recognise refs that are legitimate-but-not-in-manifest
    // (class selectors, instance methods, runtime globals in a dynamically-built sim). (sim-bridge-deepfix)
    const sourceText = [...sourceMap.values()].join('\n');
    let validation = validateGeneratedBridge(assembledBridgeScript, manifest, bridge.mainBody, sourceText);

    // ── Unified retry budget ──────────────────────────────────────────────────
    // Retry policy (in priority order):
    //   1. Fatal errors: ALWAYS retry if budget allows — upload is blocked until fixed
    //   2. Low confidence (<0.45): retry — LLM was uncertain, may produce better result
    //   3. HIGH-RISK warnings only: getElementById/window.fn with unknown ID/function
    //      These will cause runtime errors. Other warnings (setInterval cleanup, etc.)
    //      are stored in metadata but do NOT trigger retry — they're expected patterns.
    let retryCount = 0;
    let retryReason: string | null = null;

    const highRiskWarnings = validation.warnings.filter(w =>
      w.includes('ID not found in manifest') ||       // getElementById('xyz') missing from DOM
      w.includes('not found in manifest functions')   // window.fn() will throw at runtime
    );

    if (validation.fatal.length > 0) {
      retryReason = 'fatal_validation';
    } else if (bridge.confidence < 0.45) {
      retryReason = 'low_confidence';
    } else if (highRiskWarnings.length > 0) {
      retryReason = 'high_risk_warning';
    }
    // Other strong warnings (cleanup patterns, style restore, etc.) are saved to metadata
    // but do NOT trigger retry — they won't cause immediate runtime failures.

    // Auto-retry loop — one retry max, Fiji debug loop pattern
    if (retryReason && retryCount < MAX_BRIDGE_RETRIES) {
      retryCount++;
      onEvent?.('status', { status: 'Issues found, requesting fix...', type: 'progress' });

      const retryPrompt = formatRetryPrompt(validation, bridge, prompt, retryReason);

      const retryResult = await this.callLLMForBridge({
        contextPrompt, manifest,
        prompt: retryPrompt, simpleUi, autoScript,
        uiControls: opts.uiControls,   // the MINIMAL-UI CONTRACT still binds the retry
        userId, projectId, conversationHistory: updatedHistory, signal,
        onTokenChunk: tokenHeartbeat,
      });
      bridge = retryResult.bridge;
      updatedHistory = retryResult.conversationHistory;
      llmProvider = retryResult.provider;
      llmModel = retryResult.model;

      onEvent?.('status', { status: 'Validating fix...', type: 'progress' });
      const assembledBridgeScriptRetry = wrapBridgeMainBody(bridge.mainBody);
      validation = validateGeneratedBridge(assembledBridgeScriptRetry, manifest, bridge.mainBody, sourceText);
      logger.info({ sectionId, retryReason, fatalAfterRetry: validation.fatal.length }, 'Bridge retry completed');
    }

    // Safe failure: do NOT upload broken code — keep existing bridge intact
    if (validation.fatal.length > 0) {
      logger.warn({ sectionId, fatal: validation.fatal, retryReason }, 'Fatal errors remain after retry — aborting upload');
      throw new Error(
        'Bridge generation failed — fatal errors remain after retry. ' +
        `Errors: ${validation.fatal.slice(0, 2).join('; ')}. ` +
        'Try a simpler or more specific prompt.'
      );
    }

    // Confidence policy (uses same retry budget — already consumed above if needed)
    const confidence = bridge.confidence;
    const confidenceLevel: 'high' | 'medium' | 'low' =
      confidence >= 0.75 ? 'high' : confidence >= 0.45 ? 'medium' : 'low';

    if (confidence < 0.3) {
      throw new Error(
        'Bridge generation failed — confidence too low after retry. ' +
        'Try a more specific prompt or verify the simulation has the expected controls.'
      );
    }

    const allValidationWarnings = [
      ...validation.warnings,
      ...validation.weak,
      ...(bridge.warnings ?? []),
    ];

    logger.info({
      simId, sectionId, confidence, confidenceLevel,
      warnings: allValidationWarnings.length,
      mainBodyLen: bridge.mainBody.length,
      retryCount, retryReason,
    }, 'Bridge script ready');

    // Every field of the result except sectionUrl/bridgeHash is known BEFORE publication, so the
    // same builder serves both the in-transaction persistSection hook (which needs the full result
    // to write sim_meta atomically with the pointer flip) and the method's own return value.
    const finishResult = (pub: { sectionUrl: string; bridgeHash: string }): BridgeGenerationResult => ({
      sectionUrl:           pub.sectionUrl,
      conversationHistory:  updatedHistory,
      sourceHash,
      bridgeHash:           pub.bridgeHash,
      mainBody:             bridge.mainBody,
      provider:             llmProvider,
      model:                llmModel,
      confidence,
      confidenceLevel,
      contextTruncated,
      retryCount,
      retryReason,
      warnings:             allValidationWarnings,
      validationErrors:     [],  // always empty — fatals throw before upload
      validationWarnings:   validation.warnings,
    });

    // 8-10. Publish the section bridge as a staged immutable revision (CAS-activated) —
    // shared with applyMinimalUiOnly (the zero-LLM Minimal-UI path).
    const persistSection = opts.persistSection;
    const { sectionUrl, bridgeHash } = await this.uploadSectionBridge({
      simId, sectionId, projectId, prefix, allKeys,
      entryKey: opts.entryKey,
      mainBody: () => bridge.mainBody,   // LLM path overwrites the section body
      onEvent,
      signal,
      persistSection: persistSection
        ? (tx, pub) => persistSection(tx, finishResult(pub))
        : undefined,
    });

    // Return typed BridgeGenerationResult — controller builds sim_meta from this
    return finishResult({ sectionUrl, bridgeHash });
  }

  reuseBridgeScript(existingUrl: string): { sectionUrl: string } {
    return { sectionUrl: existingUrl };
  }

  /**
   * List a simulation's storage keys, falling back to an entry-HTML ref probe when the
   * storage token lacks ListBucket (write-only R2). Shared by generateBridgeScript and the
   * zero-LLM mechanical Minimal-UI path.
   */
  private async listSimKeys(prefix: string, entryKeyOpt?: string): Promise<string[]> {
    let allKeys: string[] = [];
    try {
      allKeys = await this.storage.listObjects(prefix);
    } catch {
      logger.warn({ prefix }, 'listObjects failed in generateBridgeScript — falling back to entry-HTML probe');
    }
    // The LEGACY prefix is the customer source of truth; system subtrees are not part of it.
    // Once a simulation has published revisions, `listObjects(prefix)` returns every revision's own
    // copy of every file — without this filter the LLM context doubles per revision and
    // `computeSourceHash` (which hashes PATH + content) changes on every publication, which would
    // clear the conversation history on every single generation. Same filter the migration applies.
    allKeys = allKeys.filter((k) => revisionIdFromKey(k) === null && !isSystemOwnedKey(k, prefix));
    if (allKeys.length === 0 && entryKeyOpt && !entryKeyOpt.startsWith('http')) {
      const entryKey = entryKeyOpt;
      const entryDir = entryKey.slice(0, entryKey.lastIndexOf('/') + 1);
      const found = new Set<string>([entryKey]);
      try {
        const res = await fetch(this.storage.getSimPublicUrl(entryKey));
        if (res.ok) {
          const html = await res.text();
          const refs = [...html.matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']/gi)]
            .map(m => m[1])
            .filter(r => !/^(https?:)?\/\//i.test(r) && !r.startsWith('data:') && !r.startsWith('#'));
          for (const ref of refs) {
            const clean = ref.split('?')[0].split('#')[0].trim();
            if (!clean) continue;
            try {
              const resolved = new URL(clean, `http://x/${entryDir}`).pathname.slice(1);
              if (resolved.startsWith(prefix)) found.add(resolved);
            } catch { /* skip invalid refs */ }
          }
        }
      } catch { /* entry unreachable */ }
      allKeys = [...found];
    }
    return allKeys;
  }

  /**
   * Publish this section's bridge as a NEW IMMUTABLE REVISION and activate it (audit P0.4).
   * Shared by generateBridgeScript and the zero-LLM mechanical path (applyMinimalUiOnly), so both
   * take the EXACT same publication contract.
   *
   * WHAT REPLACED THE OLD READ-MODIFY-WRITE
   * This used to overwrite `<prefix>/bridge.js` and the entry HTML in place — two writes a viewer
   * could land between, a client abort could orphan halfway, and a concurrent generation could
   * silently clobber. Now every byte of the publication is staged under a never-reused revision
   * prefix through RevisionService.writeFile (the sole write path into a revision), verified, and
   * made live by ONE compare-and-set activation whose transaction also carries the caller's
   * section-row update (`persistSection`). The legacy mutable prefix is never written again by
   * this path — it stays exactly as it was, which is what migration 050's rollback reverts to.
   *
   * BASE PACKAGE: the active revision when one exists; otherwise the legacy prefix
   * (migration-on-write — the FULL package layout is copied via the same plan the operator
   * migration uses, not just bridge + entry).
   *
   * VERDICT PARITY: the old path explicitly nulled package_class/canary_report/canary_at when the
   * bytes changed. Here a fresh-bytes revision has no canary yet, so its verdict columns are NULL
   * — and activation PROJECTS them onto the simulations row inside the same transaction. Same
   * downstream behaviour (unproven ⇒ legacy player path), now atomic with the pointer flip.
   * `simulations.bridge_hash` is deliberately NOT advanced: it describes the legacy prefix's
   * bytes, which this path no longer touches, and on a revisioned simulation the identity axis is
   * the revision id (`packageRevisionFor`), not the hash.
   *
   * ABORT SAFETY: the signal is checked before the draft exists (cheap bail), per staged file, and
   * once more after validation — where an abort marks the draft failed and leaves the pointer,
   * the section row and the previous bytes untouched. It is NEVER checked inside the activation
   * transaction, and after activation an abort is ignored (the publication is already live).
   * Failed/aborted drafts sit in an inactive never-referenced prefix; reaping them is the existing
   * gc/staleDrafts machinery's job (documented follow-up — no sweep is wired here).
   */
  private async uploadSectionBridge(opts: {
    simId:      string;
    sectionId:  string;
    projectId:  string;
    prefix:     string;
    allKeys:    string[];
    entryKey?:  string;
    mainBody:   (existing: string | undefined) => string;
    onEvent?:   (event: string, data: object) => void;
    signal?:    AbortSignal;
    persistSection?: SectionPersistHook;
  }): Promise<{ sectionUrl: string; bridgeHash: string }> {
    const { simId, sectionId, projectId, prefix, allKeys, mainBody, onEvent, signal } = opts;
    if (!SAFE_SECTION_ID_RE.test(sectionId)) throw new Error(`Unsafe sectionId: "${sectionId}"`);
    throwIfAborted(signal);

    // In-process serialisation only (see bridgeLocks). Cross-process safety is the activation CAS.
    return this.withBridgeLock(simId, async () => {
      // Lazy import — a static SimulationService⇄RevisionMigration import would be circular
      // (RevisionMigration imports deriveEntryRelPath/getSimulationContentType from here).
      const { planLegacyCopy, buildLegacyManifest } = await import('./RevisionMigration.js');
      const revisions = this.revisions();

      // ── (1) Pointer + canonical prefix, read at the START of the build ─────────────────────
      // `expectedActiveRevisionId` for the activation CAS is THIS read: a concurrent publication
      // that activates in between makes our activation lose with a RevisionConflict instead of
      // silently overwriting it.
      const [simRow] = await db
        .select({
          storage_prefix: simulations.storage_prefix,
          active_revision_id: simulations.active_revision_id,
        })
        .from(simulations)
        .where(eq(simulations.id, simId));
      if (!simRow) throw new Error('Simulation not found');
      const norm = (v: string): string => v.replace(/\/+$/, '');
      // Revision operations use the row's OWN storage_prefix — activate() refuses any other. The
      // legacy reads keep the caller-computed prefix, which is where those bytes actually live.
      const revisionRoot = norm(simRow.storage_prefix || prefix);
      const legacyRoot = norm(prefix);
      if (revisionRoot !== legacyRoot) {
        logger.warn({ simId, revisionRoot, legacyRoot }, 'sim: storage_prefix differs from computed prefix');
      }
      const baseRevisionId = simRow.active_revision_id;

      // ── (2) Resolve the base package: active revision, or legacy prefix (migration-on-write) ──
      type CopySource = {
        manifestPath: string;
        role: SimFileRole;
        contentType: string;
        read: () => Promise<Buffer>;
      };
      const bridgeManifestPath = `${PACKAGE_SUBDIR}/bridge.js`;
      let copyPlan: CopySource[];
      let existingBridgeJs = '';
      let rawEntryHtml: string;
      let entryManifestPath: string;

      if (baseRevisionId) {
        // Base = the ACTIVE revision: its manifest is the authoritative file list, its bridge.js
        // carries every section body published so far, and its entry HTML is what viewers load.
        let baseManifest: SimPackageManifest;
        try {
          const raw = await this.storage.readObject(revisionManifestKey(revisionRoot, baseRevisionId));
          baseManifest = JSON.parse(raw.toString('utf-8')) as SimPackageManifest;
        } catch (err) {
          throw new Error(
            `Could not read the active revision's manifest (${String(err).slice(0, 120)})`,
            { cause: err },
          );
        }
        entryManifestPath = baseManifest.entry;
        try {
          existingBridgeJs = (await this.storage
            .readObject(revisionFileKey(revisionRoot, baseRevisionId, bridgeManifestPath))).toString('utf-8');
        } catch { /* base revision has no combined bridge yet */ }
        rawEntryHtml = (await this.storage
          .readObject(revisionFileKey(revisionRoot, baseRevisionId, entryManifestPath))).toString('utf-8');
        copyPlan = baseManifest.files
          .filter((f) => f.path !== entryManifestPath && f.path !== bridgeManifestPath)
          .map((f) => ({
            manifestPath: f.path,
            role: f.role,
            contentType: f.contentType,
            read: () => this.storage.readObject(revisionFileKey(revisionRoot, baseRevisionId, f.path)),
          }));
      } else {
        // Base = the legacy mutable prefix. Prefer opts.entryKey (authoritative from DB), then
        // probe allKeys — exactly the resolution the old in-place path used.
        const isSectionFile = (k: string) => /section_[^/]+\.(html|js)$/.test(k) || /\/bridge\.js$/.test(k);
        const passedEntryKey = opts.entryKey && !opts.entryKey.startsWith('http') ? opts.entryKey : undefined;
        const entryKey = passedEntryKey
          ?? allKeys.find(k => /\/(index|main)\.(html|htm)$/.test(k))
          ?? allKeys.find(k => (k.endsWith('.html') || k.endsWith('.htm')) && !isSectionFile(k));
        if (!entryKey) throw new Error('No HTML entry file found in simulation');
        const entryRelPath = entryKey.slice(legacyRoot.length + 1);

        // FULL-PACKAGE migration-on-write: the same plan (classification + `package/` layout
        // preservation) the operator migration uses — the first live generation on a legacy
        // simulation publishes the whole package, not just bridge + entry.
        const keysForPlan = allKeys.includes(entryKey) ? allKeys : [...allKeys, entryKey];
        const { planned, entry } = planLegacyCopy({ allKeys: keysForPlan, prefix: legacyRoot, entryRelPath });
        if (!entry) throw new Error('No HTML entry file found in simulation');
        entryManifestPath = entry.revisionPath;

        try { existingBridgeJs = (await this.storage.readObject(`${legacyRoot}/bridge.js`)).toString('utf-8'); }
        catch { /* first generation — start fresh */ }
        // Fall back to a public URL read when storage GetObject is denied (write-only token).
        try {
          rawEntryHtml = (await this.storage.readObject(entryKey)).toString('utf-8');
        } catch {
          const res = await fetch(this.storage.getSimPublicUrl(entryKey));
          if (!res.ok) throw new Error(`Could not read entry HTML for bridge injection (${res.status})`);
          rawEntryHtml = await res.text();
        }
        copyPlan = planned
          .filter((p) => p.rel !== entryRelPath && p.revisionPath !== bridgeManifestPath)
          .map((p) => ({
            manifestPath: p.revisionPath,
            role: p.role,
            contentType: getSimulationContentType(p.key),
            read: () => this.storage.readObject(p.key),
          }));
      }

      // ── (3) Build the new bridge.js + entry HTML bytes (pure) ──────────────────────────────
      const entryRelWithinPackage = entryManifestPath.startsWith(`${PACKAGE_SUBDIR}/`)
        ? entryManifestPath.slice(PACKAGE_SUBDIR.length + 1)
        : entryManifestPath;
      const art = assembleSectionBridgeArtifacts({
        sectionId, existingBridgeJs, rawEntryHtml,
        entryRelPath: entryRelWithinPackage,
        mainBody,
      });

      // ── (3b) NO-OP SHORT-CIRCUIT: the assembled package is byte-identical to the active one ──
      // Owner requirement (2026-08-30, "load bridge"): a load that changes nothing must not
      // duplicate the package in storage nor republish a revision — "if it's identical, there's
      // nothing to do and no reason to duplicate it in storage."
      //
      // The signal is the BYTES, deliberately NOT a stored hash. `simulations.bridge_hash` is a
      // LEGACY field a revisioned simulation never advances (it stays null — see the class doc
      // above), so judgeBridgeLoad's `sameContent`, computed from it, is blind to the modern
      // revision path and cannot be relied on here. `assembleSectionBridgeArtifacts` is pure and
      // its injections are idempotent, so when the new body equals the section's current body the
      // combined bridge.js and the entry HTML come back byte-for-byte identical — and every other
      // file is copied verbatim from this same base — which means a republish would stage an exact
      // duplicate of the active revision under a fresh id. Skip the whole draft→upload→activate:
      // point the section at the revision that already holds these bytes and persist only its
      // settings (simple_ui / auto_script / sim_meta / ui selection) through the same hook. Gated
      // on `baseRevisionId` because a no-op only means anything when a base revision already exists
      // to reference; a first publication (legacy prefix) always stages revision 1.
      if (baseRevisionId && art.bridgeJs === existingBridgeJs && art.entryHtml === rawEntryHtml) {
        const currentEntryKey = revisionFileKey(revisionRoot, baseRevisionId, entryManifestPath);
        const sectionUrl = `${this.storage.getSimPublicUrl(currentEntryKey)}?section=${sectionId}&v=${art.bridgeHash}`;
        const persistSection = opts.persistSection;
        if (persistSection) {
          // No activation happens, so persist runs in its own transaction rather than inside
          // activate()'s. The section row still commits atomically; there is simply no pointer to
          // flip because the bytes it would point at are already live.
          await db.transaction(async (tx) => {
            await persistSection(tx, { sectionUrl, bridgeHash: art.bridgeHash });
          });
        }
        onEvent?.('status', { status: 'No changes — nothing to republish', type: 'progress' });
        logger.info(
          { simId, sectionId, projectId, revisionId: baseRevisionId, bridgeHash: art.bridgeHash },
          'Bridge unchanged — no republish (byte-identical to the active revision)',
        );
        return { sectionUrl, bridgeHash: art.bridgeHash };
      }

      onEvent?.('status', { status: 'Uploading files…', type: 'progress' });

      // ── (4) Stage the revision: draft → upload every file → validate ───────────────────────
      throwIfAborted(signal);   // cheap bail BEFORE the draft row exists
      const draft = await revisions.createDraft({
        simulationId: simId,
        createdBy: 'live-generation',
        metadata: {
          trigger: 'section-generation', sectionId, baseRevisionId,
          // WHAT THESE BYTES CAN DO AND WHAT THEY NEED, recorded with the bytes (audit P0.5, and
          // P0.8's import-map requirement in the same record). Written at DRAFT rather
          // than at activation because it describes the artefact this publication just assembled —
          // `activate()` only PROJECTS it onto the simulations row, so a rollback re-projects the
          // right answer for whichever revision the pointer lands on. Reading it back from the
          // stored bridge later would be the same fact resolved twice, from a place that can fail.
          [BRIDGE_CAPABILITIES_KEY]: art.capabilities,
        },
      });
      const uploading = await revisions.beginUpload(simId, draft.id);
      const files: SimManifestFile[] = [];
      const uploadStartedAt = Date.now();
      try {
        // Bounded fan-out, not a serial loop: for a 30MB / many-file package the read→write
        // round trips dominated publication wall time on cloud storage (every file waited for
        // the previous one). Order of `files` is preserved by mapWithLimit; the abort check
        // runs per item exactly as before, and the first failure rejects the whole stage.
        files.push(...await mapWithLimit(copyPlan, REVISION_UPLOAD_CONCURRENCY, async (item) => {
          throwIfAborted(signal);
          const bytes = await item.read();
          return revisions.writeFile(uploading, revisionRoot, {
            manifestPath: item.manifestPath, bytes, contentType: item.contentType, role: item.role,
          });
        }));
        files.push(await revisions.writeFile(uploading, revisionRoot, {
          manifestPath: bridgeManifestPath,
          bytes: Buffer.from(art.bridgeJs, 'utf-8'),
          contentType: 'application/javascript',
          role: 'runtime',
        }));
        files.push(await revisions.writeFile(uploading, revisionRoot, {
          manifestPath: entryManifestPath,
          bytes: Buffer.from(art.entryHtml, 'utf-8'),
          contentType: 'text/html; charset=utf-8',
          role: 'entry',
        }));
      } catch (err) {
        // The draft is abandoned where it stands — bytes in a never-referenced prefix, row failed.
        await revisions.markFailed(simId, draft.id, 'uploading', String(err).slice(0, 500))
          .catch(() => undefined);
        throw err;
      }
      // Publish observability: where a slow publication actually spends its time. One line per
      // publish, so it can stay.
      logger.info({
        simId, revisionId: draft.id,
        fileCount: files.length,
        totalBytes: files.reduce((a, f) => a + f.bytes, 0),
        uploadMs: Date.now() - uploadStartedAt,
      }, 'sim publish: revision files staged');

      const validating = await revisions.finishUpload(simId, draft.id);
      const manifest = buildLegacyManifest({
        sim: { id: simId, projectId },
        revisionId: draft.id,
        revisionNumber: draft.revisionNumber,
        entryPath: entryManifestPath,
        files,
        createdBy: 'live-generation',
      });
      const verdict = await revisions.validate(simId, validating, revisionRoot, { manifest });
      if (!verdict.ok) {
        // validate() already marked the revision failed, with every problem recorded on it.
        throw new Error(
          'Bridge publication failed verification: '
          + JSON.stringify({ manifest: verdict.problems, storage: verdict.verified.problems }).slice(0, 500),
        );
      }

      // ── (5) Last abort point — AFTER the build, BEFORE activation ──────────────────────────
      if (signal?.aborted) {
        await revisions.markFailed(simId, draft.id, 'canary_passed', 'generation aborted before activation')
          .catch(() => undefined);
        throw generationAbortError();
      }

      // ── (6) Activate: one transaction — demote, promote, pointer flip, section row ─────────
      // sectionUrl mirrors buildPlayerConfig.simulationUrlOf for the new revision exactly:
      // getSimPublicUrl(active_revision_entry_key) + ?section=<id>&v=<hash>.
      const newEntryKey = revisionFileKey(revisionRoot, draft.id, entryManifestPath);
      const sectionUrl = `${this.storage.getSimPublicUrl(newEntryKey)}?section=${sectionId}&v=${art.bridgeHash}`;
      const persistSection = opts.persistSection;
      try {
        await revisions.activate({
          simulationId: simId,
          revisionId: draft.id,
          storagePrefix: revisionRoot,
          expectedActiveRevisionId: baseRevisionId,
          supersede: 'retired',
          onActivated: persistSection
            ? (tx) => persistSection(tx, { sectionUrl, bridgeHash: art.bridgeHash })
            : undefined,
        });
      } catch (err) {
        // Whatever stopped the activation — a lost CAS (concurrent publication won) or a thrown
        // persistSection hook (e.g. the section row vanished) — the transaction rolled back whole,
        // so nothing this publication staged is referenced anywhere. Retire the draft so a stale
        // build can never be activated later by something else.
        await revisions.markFailed(simId, draft.id, 'canary_passed', `activation failed: ${String(err).slice(0, 300)}`)
          .catch(() => undefined);
        throw err;
      }

      logger.info(
        { simId, sectionId, projectId, revisionId: draft.id, revisionNumber: draft.revisionNumber,
          url: sectionUrl, sections: art.sectionCount, files: files.length },
        'Bridge revision published and activated',
      );
      return { sectionUrl, bridgeHash: art.bridgeHash };
    });
  }

  /**
   * Zero-LLM Minimal-UI path (owner direction 2026-07-30): when the user changes only the
   * Advanced-UI selection and generates WITHOUT a prompt, we don't burn any tokens — the
   * control hiding is entirely mechanical (params.hideSelectors, applied at runtime by the
   * bridge). We ensure a bridge exists for the section (PRESERVING any prior demonstration
   * body; a no-op when none), re-inject it, and let the persisted selection drive the hide.
   * Returns the fresh section URL + hash so the controller can persist sim_meta.
   */
  async applyMinimalUiOnly(opts: {
    simId:      string;
    sectionId:  string;
    projectId:  string;
    entryKey?:  string;
    onEvent?:   (event: string, data: object) => void;
    signal?:    AbortSignal;
    persistSection?: SectionPersistHook;
  }): Promise<{ sectionUrl: string; bridgeHash: string }> {
    const { simId, sectionId, projectId, onEvent } = opts;
    const prefix = `simulations/${projectId}/${simId}`;
    onEvent?.('status', { status: 'Applying minimal UI…', type: 'progress' });
    const allKeys = await this.listSimKeys(prefix, opts.entryKey);
    // No-op main body: SIM_READY + the mechanical hide (in the wrap template) do all the work;
    // an existing demonstration for this section is preserved untouched.
    const NOOP_MAIN_BODY = '// minimal-UI only (no scripted demo) — controls are hidden mechanically\nreturn function cleanup() {};';
    return this.uploadSectionBridge({
      simId, sectionId, projectId, prefix, allKeys,
      entryKey: opts.entryKey,
      mainBody: (existing) => (existing && existing.trim() ? existing : NOOP_MAIN_BODY),
      onEvent,
      signal: opts.signal,
      persistSection: opts.persistSection,
    });
  }

  /**
   * Paste a SAVED bridge body onto a section — the artifact path of "load bridge" (079).
   *
   * Same shape as applyMinimalUiOnly: one republication through uploadSectionBridge, so the
   * CAS-activation, entry re-injection and section-row hook behave identically to every other
   * bridge write. The body arrives from a saved_bridges row; by the time it reaches here the
   * caller has ALREADY re-verified the contract against this simulation's current sources —
   * this method trusts its caller exactly as far as applyMinimalUiOnly trusts its constant.
   */
  async applySavedBridgeBody(opts: {
    simId:      string;
    sectionId:  string;
    projectId:  string;
    body:       string;
    entryKey?:  string;
    onEvent?:   (event: string, data: object) => void;
    signal?:    AbortSignal;
    persistSection?: SectionPersistHook;
  }): Promise<{ sectionUrl: string; bridgeHash: string }> {
    const prefix = `simulations/${opts.projectId}/${opts.simId}`;
    opts.onEvent?.('status', { status: 'Applying saved bridge…', type: 'progress' });
    const allKeys = await this.listSimKeys(prefix, opts.entryKey);
    return this.uploadSectionBridge({
      simId: opts.simId, sectionId: opts.sectionId, projectId: opts.projectId, prefix, allKeys,
      entryKey: opts.entryKey,
      // The preset REPLACES whatever this section had — that is what "load" means. (Contrast
      // applyMinimalUiOnly, which preserves an existing demo; here the existing demo is exactly
      // the thing being swapped out.)
      mainBody: () => opts.body,
      onEvent: opts.onEvent,
      signal: opts.signal,
      persistSection: opts.persistSection,
    });
  }

  private async callLLMForBridge(opts: {
    contextPrompt:        string;
    manifest:             SimManifest;
    prompt:               string;
    simpleUi:             boolean;
    autoScript:           boolean;
    uiControls?:          SimUiSelection;
    userId:               string;
    projectId:            string;
    conversationHistory?: ConversationMessage[];
    onTokenChunk?:        (chunk: string) => void;
    signal?:              AbortSignal;
  }): Promise<{ bridge: GeneratedBridge; conversationHistory: ConversationMessage[]; provider: string; model: string }> {
    const { contextPrompt, prompt, simpleUi, autoScript, userId, projectId, onTokenChunk, signal } = opts;
    const conversationHistory = opts.conversationHistory ?? [];
    const hasHistory = conversationHistory.length > 0;

    // User message is tiny — source files stay in contextPrompt (system prompt).
    // A Minimal-UI selection adds exactly ONE compact contract block ('' when absent) —
    // no source duplication, zero overhead for the no-selection path.
    const uiBlock = buildUiControlsPromptBlock(opts.uiControls);
    const uiSuffix = uiBlock ? `\n\n${uiBlock}` : '';
    const userContent = hasHistory
      ? `REFINEMENT PROMPT: ${prompt}\n\nsimpleUi = ${simpleUi}\nautoScript = ${autoScript}${uiSuffix}\n\nUpdate the bridge script.`
      : `SECTION PROMPT: ${prompt}\n\nsimpleUi = ${simpleUi}\nautoScript = ${autoScript}${uiSuffix}\n\nGenerate the bridge script now.`;

    const abortController = new AbortController();
    const signalListener = () => abortController.abort();
    signal?.addEventListener('abort', signalListener);

    try {
      const result = await this.llmService.sendStructured({
        task: 'bridge_plan',
        systemPrompt: contextPrompt,
        userPrompt: userContent,
        previousMessages: hasHistory ? conversationHistory : undefined,
        schema: BridgeGenerationSchema,
        userId,
        projectId,
        abortSignal: signal ?? abortController.signal,
        onTokenChunk,
      });

      const bridge = result.data as GeneratedBridge;

      // Store structured summary — never raw or truncated bridge code
      const allHistory: ConversationMessage[] = [
        ...conversationHistory,
        { role: 'user',      content: userContent },
        { role: 'assistant', content: buildBridgeSummary(bridge, prompt) },
      ];
      const updatedHistory = allHistory.slice(-6);

      logger.debug({
        model: result.model, provider: result.provider,
        cachedTokens: result.usage.cached_input, mainBodyLen: bridge.mainBody.length,
      }, 'Bridge generated via LLM');

      return { bridge, conversationHistory: updatedHistory, provider: result.provider, model: result.model };
    } finally {
      signal?.removeEventListener('abort', signalListener);
    }
  }

  private normalizeUploadedFiles(uploadedFiles: UploadedSimulationFile[]): Map<string, Buffer> {
    const files = new Map<string, Buffer>();
    for (const file of uploadedFiles) {
      const name = normalizeSimulationPath(file.path);
      if (!name) continue;
      files.set(name, file.buffer);
    }
    return files;
  }

  private extractZip(buf: Buffer): Map<string, Buffer> {
    // Bound the archive on its DECLARED headers before anything is inflated: `entry.getData()`
    // below allocates whatever the central directory claims, and this buffer came off an upload
    // route. normalizeSimulationPath still runs per entry, but it only sees names the guard has
    // already cleared, and only after the whole archive has been accepted.
    const zip   = assertSafeZipArchive(buf, { label: 'Simulation ZIP' });
    const files = new Map<string, Buffer>();
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;
      const name = normalizeSimulationPath(entry.entryName);
      if (!name) continue;
      files.set(name, entry.getData());
    }
    return files;
  }

  private findEntryHtml(files: Map<string, Buffer>): string | null {
    const htmlFiles = [...files.keys()].filter(f => f.endsWith('.html') || f.endsWith('.htm'));
    if (htmlFiles.length === 0) return null;
    const rootIndex = htmlFiles.find(f => f === 'index.html' || f.match(/^[^/]+\/index\.html$/));
    if (rootIndex) return rootIndex;
    return htmlFiles.sort((a, b) => a.split('/').length - b.split('/').length)[0];
  }

  /** Upload-time entry-HTML injection: head rAF gate + inline bridge v2 template.
   *  Idempotent — re-running on already-injected HTML yields one gate and one bridge. */
  private injectBridge(html: string, fns: BridgeFunction[]): string {
    return injectInlineBridge(injectRafGate(html), fns);
  }
}

/** Idempotently inject the inline "sim-bridge v2" template before </body>.
 *  - An existing inline v2 block is refreshed in place (never duplicated).
 *  - When the combined bridge.js marker block is present the inline template is superseded
 *    and must NOT be reintroduced (generateBridgeScript stripped it on first generation). */
export function injectInlineBridge(html: string, fns: BridgeFunction[]): string {
  const fnJson  = JSON.stringify(fns);
  const script  = BRIDGE_TEMPLATE.replace('__SIM_BRIDGE_FUNCTIONS__', fnJson);
  const tag     = `<script>\n/* sim-bridge v2 — auto-injected by podcast-saas */\n${script}\n</script>`;

  const existingInline = /<script[^>]*>\s*\/\* sim-bridge v2[\s\S]*?<\/script>/i;
  if (existingInline.test(html)) return html.replace(existingInline, tag);
  if (html.includes('SIM_BRIDGE_SCRIPT_START')) return html;

  if (html.includes('</body>')) return html.replace('</body>', `${tag}\n</body>`);
  return html + '\n' + tag;
}
