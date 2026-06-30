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

// ── Storage content types ─────────────────────────────────────────────────────

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
        .replace(/\n$/, '');
      entries.set(id, dedented);
    }
  }
  return entries;
}

/** Build the full combined bridge.js IIFE from a sectionId→mainBody map. */
export function wrapBridgeCombined(entries: Map<string, string>): string {
  const sectionBlocks = [...entries.entries()]
    .map(([id, body]) => buildSectionEntry(id, body))
    .join('\n');

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
    '  var _ready = false;',
    '  function _fireReady() {',
    "    if (_ready) return; _ready = true; window._simReadyFired = true;",
    "    window.parent?.postMessage({ type: 'SIM_READY' }, '*');",
    '  }',
    "  if (document.readyState === 'loading')",
    "    document.addEventListener('DOMContentLoaded', function() { requestAnimationFrame(_fireReady); });",
    '  else requestAnimationFrame(_fireReady);',
    '  setTimeout(_fireReady, 3000);',
    '',
    '  // ── Dispatch — only wire listeners when a valid section param exists ─────────',
    "  var _sectionId = new URLSearchParams(location.search).get('section');",
    '  var _mainBodyFn = _sectionId ? __SECTIONS__[_sectionId] : null;',
    '  if (!_mainBodyFn) return;',
    '',
    '  // ── Standard Listener — system-owned, guaranteed correct ────────────────────',
    '  var _cancelFn = null;',
    '  var SCRIPTS = {',
    '    main: function (params) {',
    '      return _mainBodyFn(params);',
    '    },',
    '  };',
    '  function stopScript() {',
    '    if (_cancelFn) { _cancelFn(); _cancelFn = null; }',
    '  }',
    '  function startScript(name, params) {',
    '    stopScript();',
    '    var fn = SCRIPTS[name] || SCRIPTS.main;',
    '    if (fn) _cancelFn = fn(params || {}) || null;',
    '  }',
    '  window.SimAPI = { start: startScript, stop: stopScript };',
    "  window.addEventListener('message', function(e) {",
    '    var d = e.data || {}; var type = d.type; var script = d.script; var params = d.params;',
    "    if (type === 'startScript')  startScript(script || 'main', params);",
    "    if (type === 'stopScript')   stopScript();",
    "    if (type === 'PING_SIM_READY' && window._simReadyFired)",
    "      window.parent?.postMessage({ type: 'SIM_READY' }, '*');",
    '  });',
    "  document.addEventListener('pointerdown', function() {",
    "    window.parent?.postMessage({ type: 'userInteraction' }, '*');",
    '  }, { capture: true });',
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
  /** Per-simulation promise chain — serialises concurrent bridge.js read-modify-write. */
  private readonly bridgeLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly storage: StorageService,
    private readonly llmService: LLMService,
  ) {}

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
    for (let i = 0; i < entries.length; i += UPLOAD_CONCURRENCY) {
      await Promise.all(
        entries.slice(i, i + UPLOAD_CONCURRENCY).map(([relPath, buf]) =>
          this.storage.uploadFile(`${prefix}/${relPath}`, buf, getSimulationContentType(relPath)).then(() => undefined),
        ),
      );
    }

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
    entryKey?:         string;           // storage key for the entry HTML (from DB) — used when listing is denied
    storedSourceHash?: string;          // from sim_meta — service owns invalidation
    conversationHistory?: ConversationMessage[];
    onEvent?: (event: string, data: object) => void;
    signal?: AbortSignal;
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
    let allKeys: string[] = [];
    try {
      allKeys = await this.storage.listObjects(prefix);
    } catch {
      logger.warn({ prefix }, 'listObjects failed in generateBridgeScript — falling back to entry-HTML probe');
    }
    if (allKeys.length === 0 && opts.entryKey && !opts.entryKey.startsWith('http')) {
      const entryKey = opts.entryKey;
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
          raw = raw
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

    // Validate sectionId before touching storage
    if (!SAFE_SECTION_ID_RE.test(sectionId))
      throw new Error(`Unsafe sectionId: "${sectionId}"`);

    // 8. Locate entry HTML — prefer opts.entryKey (authoritative from DB), then probe allKeys
    const passedEntryKey = opts.entryKey && !opts.entryKey.startsWith('http') ? opts.entryKey : undefined;
    const entryKey = passedEntryKey
      ?? allKeys.find(k => /\/(index|main)\.(html|htm)$/.test(k))
      ?? allKeys.find(k => (k.endsWith('.html') || k.endsWith('.htm')) && !isSectionFile(k));
    if (!entryKey) throw new Error('No HTML entry file found in simulation');

    const entryDir = entryKey.substring(0, entryKey.lastIndexOf('/'));
    const relativeDepth = entryDir === prefix
      ? 0
      : entryDir.slice(prefix.length).split('/').filter(Boolean).length;
    const bridgeRelPath = (relativeDepth > 0 ? '../'.repeat(relativeDepth) : './') + 'bridge.js';
    const bridgeJsKey   = `${prefix}/bridge.js`;

    onEvent?.('status', { status: 'Uploading files…', type: 'progress' });

    // 9. Read-modify-write bridge.js under a per-simulation lock (concurrency safety)
    const { sectionUrl, bridgeHash } = await this.withBridgeLock(bridgeJsKey, async () => {
      // Read existing bridge.js (may not exist on first generation)
      let existingBridgeJs = '';
      try { existingBridgeJs = (await this.storage.readObject(bridgeJsKey)).toString('utf-8'); }
      catch { /* first generation — start fresh */ }

      // Merge: parse existing sections, add/replace current section
      const sectionEntries = parseSectionEntries(existingBridgeJs);
      sectionEntries.set(sectionId, bridge.mainBody);
      const combinedBridge = wrapBridgeCombined(sectionEntries);
      const hash = computeBridgeHash(combinedBridge);

      await this.storage.uploadFile(bridgeJsKey, Buffer.from(combinedBridge, 'utf-8'), 'application/javascript');

      // 10. Update index.html in place (stable marker approach).
      // Fall back to public URL read when storage GetObject is denied.
      let rawHtml: string;
      try {
        rawHtml = (await this.storage.readObject(entryKey)).toString('utf-8');
      } catch {
        const res = await fetch(this.storage.getSimPublicUrl(entryKey));
        if (!res.ok) throw new Error(`Could not read entry HTML for bridge injection (${res.status})`);
        rawHtml = await res.text();
      }
      const updatedHtml = injectBridgeScriptTag(rawHtml, bridgeRelPath, hash);
      await this.storage.uploadFile(entryKey, Buffer.from(updatedHtml, 'utf-8'), 'text/html; charset=utf-8');

      // sectionUrl encodes which section to run + busts the iframe cache on every generation
      const url = `${this.storage.getSimPublicUrl(entryKey)}?section=${sectionId}&v=${hash}`;
      logger.info({ simId, sectionId, projectId, url, sections: sectionEntries.size }, 'Bridge script uploaded');
      return { sectionUrl: url, bridgeHash: hash };
    });

    // Return typed BridgeGenerationResult — controller builds sim_meta from this
    return {
      sectionUrl,
      conversationHistory:  updatedHistory,
      sourceHash,
      bridgeHash,
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
    const zip   = new AdmZip(buf);
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

  private injectBridge(html: string, fns: BridgeFunction[]): string {
    const fnJson  = JSON.stringify(fns);
    const script  = BRIDGE_TEMPLATE.replace('__SIM_BRIDGE_FUNCTIONS__', fnJson);
    const tag     = `<script>\n/* sim-bridge v2 — auto-injected by podcast-saas */\n${script}\n</script>`;
    if (html.includes('</body>')) return html.replace('</body>', `${tag}\n</body>`);
    return html + '\n' + tag;
  }
}
