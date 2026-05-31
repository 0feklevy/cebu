import AdmZip from 'adm-zip';
import { createHash } from 'crypto';
import { z } from 'zod';
import type { StorageService } from '../storage/StorageService.js';
import { LLMService } from '../llm/LLMService.js';
import { db } from '../../db/index.js';
import { system_prompts } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { logger } from '../../lib/logger.js';

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

// ── Storage content types ─────────────────────────────────────────────────────

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm:  'text/html; charset=utf-8',
  js:   'application/javascript',
  mjs:  'application/javascript',
  css:  'text/css',
  json: 'application/json',
  png:  'image/png',
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  gif:  'image/gif',
  svg:  'image/svg+xml',
  ico:  'image/x-icon',
  woff: 'font/woff',
  woff2:'font/woff2',
  ttf:  'font/ttf',
  mp3:  'audio/mpeg',
  mp4:  'video/mp4',
  webm: 'video/webm',
  wav:  'audio/wav',
  txt:  'text/plain',
};

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

// ── BRIDGE_GENERATION_SYSTEM_PROMPT ─────────────────────────────────────────────
// The selected LLM provider receives the full simulation source + manifest and writes the bridge script.
// The prompt is stored in DB (key: bridge_plan) and admin-editable.

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
      // Use _hide() to hide elements.
      // Push intervals: _ivs.push(setInterval(..., ms));
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
  function stopScript() {
    if (_cancelFn) { _cancelFn(); _cancelFn = null; }
  }
  function startScript(name, params) {
    stopScript();
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

### DOM Access
17. ONLY access DOM elements whose IDs appear in the MANIFEST or are visible in the HTML source.
18. ONLY call functions from the MANIFEST or clearly visible in the source files.
19. Use optional chaining (?.): document.getElementById('x')?.style may not exist.

### Parameters
20. When params.simpleUi = true: hide all irrelevant controls AND their labels. Show only the target.
21. When params.autoScript = true: animate the target control. Stop animation in cleanup.
22. Use _hide() for hiding: it records originals automatically for restoration.

### Animation
23. Use setInterval for animation: step 0.1–0.3, intervalMs 30–150ms. Pingpong at min/max.
24. Push every interval ID into _ivs so cleanup clears it.
25. Push every listener into _listeners so cleanup removes it.

### Render functions
26. Call updateDerivedPhysics before render functions if it exists in the manifest.
27. Call render functions via window.fn?.() — they may not always be defined.

### Confidence scoring
28. confidence >= 0.9: all IDs/functions verified in manifest, no guesses
29. confidence 0.6–0.89: some assumptions made (guessed selectors, assumed functions)
30. confidence < 0.6: significant uncertainty — explain in warnings
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
    }
  }

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
    '  // ── LLM-GENERATED IMPLEMENTATION (SCRIPTS.main body only) ────────────────────',
    '  let _cancelFn = null;',
    '  const SCRIPTS = {',
    '    main: function (params) {',
    indented,
    '    },',
    '  };',
    '',
    '  // ── STANDARD LISTENER — system-owned, guaranteed correct ─────────────────────',
    '  function stopScript() {',
    '    if (_cancelFn) { _cancelFn(); _cancelFn = null; }',
    '  }',
    '  function startScript(name, params) {',
    '    stopScript();',
    '    const fn = SCRIPTS[name] ?? SCRIPTS.main;',
    '    if (fn) _cancelFn = fn(params ?? {}) ?? null;',
    '  }',
    '  window.SimAPI = { start: startScript, stop: stopScript };',
    "  window.addEventListener('message', e => {",
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

/** Compute a short hash of the generated bridge script */
function computeBridgeHash(code: string): string {
  return createHash('sha256').update(code).digest('hex').slice(0, 12);
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
export function validateGeneratedBridge(code: string, manifest: SimManifest, mainBody?: string): ValidationResult {
  const fatal: string[] = [];
  const warnings: string[] = [];
  const weak: string[] = [];
  const checkBody = mainBody ?? code;  // prefer checking mainBody when available

  // ── FATAL: Syntax check on the fully assembled script ────────────────────────
  try { new Function(code); } catch (e) { fatal.push(`Syntax error: ${(e as Error).message}`); }

  // ── FATAL: Sanity checks on assembled output (system guarantees these, but verify) ──
  if (!code.includes('SIM_READY'))        fatal.push('Assembled bridge missing SIM_READY (system error)');
  if (!code.includes('startScript'))      fatal.push('Assembled bridge missing startScript (system error)');
  if (!code.includes('stopScript'))       fatal.push('Assembled bridge missing stopScript (system error)');
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

  // getElementById references: both 'id' and "id" forms
  const getByIdRe = /document\.getElementById\(\s*['"`]([\w-]+)['"`]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = getByIdRe.exec(checkBody)) !== null) {
    if (!allManifestIds.has(m[1])) warnings.push(`getElementById('${m[1]}') — ID not found in manifest`);
  }

  // window.fn() and window.fn?.() calls — detect both patterns
  const windowFnRe = /window\.([\w]+)\s*\(|window\.([\w]+)\?\.\s*\(/g;
  while ((m = windowFnRe.exec(checkBody)) !== null) {
    const fn = m[1] ?? m[2];
    if (fn && !allFns.has(fn) && !ignoredWindowProps.has(fn)) {
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
  if (!checkBody.includes('params.simpleUi') && !checkBody.includes('simpleUi')) {
    weak.push('params.simpleUi not referenced — simpleUi toggle may have no effect');
  }
  if (!checkBody.includes('params.autoScript') && !checkBody.includes('autoScript')) {
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
    selectElements:   manifest.selectElements,
    checkboxElements: manifest.checkboxElements,
    canvasElements:   manifest.canvasElements,
    globalObjects:    manifest.globalObjects,
    renderFunctions:  manifest.renderFunctions,
    updateFunctions:  manifest.updateFunctions,
    hasSetSimSection: manifest.hasSetSimSection,
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
  constructor(
    private readonly storage: StorageService,
    private readonly llmService: LLMService,
  ) {}

  async processUpload(opts: {
    projectId: string;
    simId:     string;
    zipBuffer: Buffer;
  }): Promise<{ entryUrl: string; entryKey: string; bridgeFunctions: BridgeFunction[] }> {
    const { projectId, simId, zipBuffer } = opts;
    const prefix = `simulations/${projectId}/${simId}`;

    const files = this.extractZip(zipBuffer);
    if (files.size === 0) throw new Error('ZIP appears to be empty');

    const entryRelPath = this.findEntryHtml(files);
    if (!entryRelPath) throw new Error('No HTML file found in ZIP. Add an index.html or similar.');

    const bridgeFunctions: BridgeFunction[] = [];
    const rawHtml      = files.get(entryRelPath)!.toString('utf-8');
    const injectedHtml = this.injectBridge(rawHtml, bridgeFunctions);
    files.set(entryRelPath, Buffer.from(injectedHtml, 'utf-8'));

    const uploads: Promise<void>[] = [];
    for (const [relPath, buf] of files) {
      const storagePath = `${prefix}/${relPath}`;
      const ext = relPath.split('.').pop()?.toLowerCase() ?? '';
      const ct  = CONTENT_TYPES[ext] ?? 'application/octet-stream';
      uploads.push(this.storage.uploadFile(storagePath, buf, ct).then(() => undefined));
    }
    await Promise.all(uploads);

    const entryStoragePath = `${prefix}/${entryRelPath}`;
    const entryUrl = this.storage.getSimPublicUrl(entryStoragePath);

    logger.info({ simId, projectId, entryRelPath }, 'Simulation uploaded');
    return { entryUrl, entryKey: entryStoragePath, bridgeFunctions };
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
    storedSourceHash?: string;          // from sim_meta — service owns invalidation
    conversationHistory?: ConversationMessage[];
    onEvent?: (event: string, data: object) => void;
    signal?: AbortSignal;
  }): Promise<BridgeGenerationResult> {
    const { simId, sectionId, projectId, userId, prompt, simpleUi, autoScript, onEvent, signal } = opts;
    const prefix = `simulations/${projectId}/${simId}`;

    // 1. Load all text source files with priority budgeting
    onEvent?.('status', { status: 'Loading simulation files…', type: 'progress' });
    const allKeys = await this.storage.listObjects(prefix);
    const isText        = (k: string) => /\.(js|mjs|html|htm|css|ts)$/.test(k);
    const isSectionFile = (k: string) => /section_[^/]+\.(html|js)$/.test(k);

    // Read all candidate text files (skip section-specific generated files)
    const rawMap = new Map<string, string>();
    await Promise.all(
      allKeys.filter(k => isText(k)).map(async key => {
        try {
          const buf = await this.storage.readObject(key);
          const raw = buf.toString('utf-8')
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
    const baseSystemPrompt = dbPrompt?.is_customized ? dbPrompt.content : BRIDGE_GENERATION_SYSTEM_PROMPT;

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
      userId, projectId, conversationHistory, signal,
      onTokenChunk: tokenHeartbeat,
    });

    onEvent?.('status', { status: 'Validating bridge script...', type: 'progress' });
    // System wraps LLM-generated mainBody into the deterministic bridge template.
    // This guarantees SIM_READY, startScript, stopScript, and message listener are ALWAYS correct.
    const assembledBridgeScript = wrapBridgeMainBody(bridge.mainBody);
    let validation = validateGeneratedBridge(assembledBridgeScript, manifest, bridge.mainBody);

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
        userId, projectId, conversationHistory: updatedHistory, signal,
        onTokenChunk: tokenHeartbeat,
      });
      bridge = retryResult.bridge;
      updatedHistory = retryResult.conversationHistory;
      llmProvider = retryResult.provider;
      llmModel = retryResult.model;

      onEvent?.('status', { status: 'Validating fix...', type: 'progress' });
      const assembledBridgeScriptRetry = wrapBridgeMainBody(bridge.mainBody);
      validation = validateGeneratedBridge(assembledBridgeScriptRetry, manifest, bridge.mainBody);
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

    // Build metadata
    // Use the final assembled bridgeScript for upload and hashing
    const finalBridgeScript = wrapBridgeMainBody(bridge.mainBody);
    const bridgeHash = computeBridgeHash(finalBridgeScript);
    const allValidationWarnings = [
      ...validation.warnings,
      ...validation.weak,
      ...(bridge.warnings ?? []),
    ];

    logger.info({
      simId, sectionId, confidence, confidenceLevel,
      warnings: allValidationWarnings.length,
      bridgeLen: finalBridgeScript.length,
      retryCount, retryReason,
    }, 'Bridge script ready');

    // 8. Locate entry HTML and upload bridge files
    const entryKey = allKeys.find(k => /\/(index|main)\.(html|htm)$/.test(k))
      ?? allKeys.find(k => (k.endsWith('.html') || k.endsWith('.htm')) && !isSectionFile(k));
    if (!entryKey) throw new Error('No HTML entry file found in simulation');

    const entryDir = entryKey.substring(0, entryKey.lastIndexOf('/'));

    onEvent?.('status', { status: 'Uploading files…', type: 'progress' });
    const bridgeJsKey = `${prefix}/section_${sectionId}.js`;
    await this.storage.uploadFile(bridgeJsKey, Buffer.from(finalBridgeScript, 'utf-8'), 'application/javascript');

    // 12. Build section HTML (strip old bridge, add new external <script src>)
    const rawHtml = (await this.storage.readObject(entryKey)).toString('utf-8');
    const stripped = rawHtml
      .replace(/<script[^>]*>\s*\/\* sim-bridge[\s\S]*?<\/script>/gi, '')
      .replace(/<script[^>]*>\s*;?\s*\(function[\s\S]*?sim-bridge v[12][\s\S]*?<\/script>/gi, '');

    const relativeDepth = entryDir === prefix
      ? 0
      : entryDir.slice(prefix.length).split('/').filter(Boolean).length;
    const relPath = (relativeDepth > 0 ? '../'.repeat(relativeDepth) : './') + `section_${sectionId}.js`;

    // Include bridgeHash in the script src so the browser always fetches the new JS
    const scriptTag = `<script src="${relPath}?v=${bridgeHash}"></script>`;
    const sectionHtml = stripped.includes('</body>')
      ? stripped.replace('</body>', `${scriptTag}\n</body>`)
      : stripped + '\n' + scriptTag;

    // Validate no script tags were lost in strip (check original src without hash query)
    const srcRe = /<script[^>]+src="([^"]+)"/gi;
    let srcMatch: RegExpExecArray | null;
    while ((srcMatch = srcRe.exec(rawHtml)) !== null) {
      const src = srcMatch[1];
      if (!sectionHtml.includes(`src="${src}"`)) {
        throw new Error(`Section HTML validation failed: <script src="${src}"> was lost after bridge-strip.`);
      }
    }

    const sectionHtmlKey = `${entryDir}/section_${sectionId}.html`;
    await this.storage.uploadFile(sectionHtmlKey, Buffer.from(sectionHtml, 'utf-8'), 'text/html; charset=utf-8');
    // Append bridgeHash as version query param → unique URL per generation → forces
    // browser cache-bust and iframe key change in VideoPlayer/SectionEditor
    const sectionUrl = `${this.storage.getSimPublicUrl(sectionHtmlKey)}?v=${bridgeHash}`;

    logger.info({ simId, sectionId, projectId, sectionUrl }, 'Bridge script uploaded');

    // Return typed BridgeGenerationResult — controller builds sim_meta from this
    return {
      sectionUrl,
      conversationHistory:  updatedHistory,
      sourceHash,
      bridgeHash,
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
    };
  }

  reuseBridgeScript(existingUrl: string): { sectionUrl: string } {
    return { sectionUrl: existingUrl };
  }

  private async callLLMForBridge(opts: {
    contextPrompt:        string;
    manifest:             SimManifest;
    prompt:               string;
    simpleUi:             boolean;
    autoScript:           boolean;
    userId:               string;
    projectId:            string;
    conversationHistory?: ConversationMessage[];
    onTokenChunk?:        (chunk: string) => void;
    signal?:              AbortSignal;
  }): Promise<{ bridge: GeneratedBridge; conversationHistory: ConversationMessage[]; provider: string; model: string }> {
    const { contextPrompt, prompt, simpleUi, autoScript, userId, projectId, onTokenChunk, signal } = opts;
    const conversationHistory = opts.conversationHistory ?? [];
    const hasHistory = conversationHistory.length > 0;

    // User message is tiny — source files stay in contextPrompt (system prompt)
    const userContent = hasHistory
      ? `REFINEMENT PROMPT: ${prompt}\n\nsimpleUi = ${simpleUi}\nautoScript = ${autoScript}\n\nUpdate the bridge script.`
      : `SECTION PROMPT: ${prompt}\n\nsimpleUi = ${simpleUi}\nautoScript = ${autoScript}\n\nGenerate the bridge script now.`;

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

    private extractZip(buf: Buffer): Map<string, Buffer> {
    const zip   = new AdmZip(buf);
    const files = new Map<string, Buffer>();
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;
      const name = entry.entryName.replace(/^__MACOSX\//, '').replace(/\/\._[^/]+$/, '');
      if (!name || name.startsWith('.') || name.includes('/__MACOSX/')) continue;
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

  private injectBridge(html: string, fns: BridgeFunction[]): string {
    const fnJson  = JSON.stringify(fns);
    const script  = BRIDGE_TEMPLATE.replace('__SIM_BRIDGE_FUNCTIONS__', fnJson);
    const tag     = `<script>\n/* sim-bridge v2 — auto-injected by podcast-saas */\n${script}\n</script>`;
    if (html.includes('</body>')) return html.replace('</body>', `${tag}\n</body>`);
    return html + '\n' + tag;
  }
}
