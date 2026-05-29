import AdmZip from 'adm-zip';
import Anthropic from '@anthropic-ai/sdk';
import type { StorageService } from '../storage/StorageService.js';
import { logger } from '../../lib/logger.js';

// ── Public types ──────────────────────────────────────────────────────────────

export interface BridgeFunction {
  name:        string;
  windowFn:    string;
  description: string;
}

// Structured info extracted from simulation source files
export interface SimManifest {
  controls: SimControl[];
  buttons:  SimButton[];
  sections: SimSection[];
  renderFunctions: string[];   // e.g. ["redraw", "draw"]
  updateFunctions: string[];   // e.g. ["updateDerivedPhysics"]
  hasSetSimSection: boolean;
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
interface SimSection { id: string; defaultHidden: boolean; }

// JSON plan that Claude returns — describes WHAT to do, not HOW to code it
export interface BridgePlan {
  targetControlId:     string | null;
  showControlIds:      string[];
  hideControlIds:      string[];
  keepButtonIds:       string[];
  hideButtonIds:       string[];
  hideSelectorStrings: string[];
  setSimSection:       string | null;
  animation: {
    enabled:      boolean;
    controllerId: string | null;
    min:          number;
    max:          number;
    step:         number;
    intervalMs:   number;
    showOptimal:  boolean;
  } | null;
  renderCalls: string[];
  confidence:  number;
  warnings:    string[];
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

// ── BRIDGE_PLAN_SYSTEM_PROMPT ─────────────────────────────────────────────────
// Claude receives the manifest (structured data) and returns a JSON plan.
// The plan is then compiled deterministically — Claude never writes raw JS.

const BRIDGE_PLAN_SYSTEM_PROMPT = `You generate a structured JSON plan for a simulation bridge script.
You receive a parsed simulation manifest listing every control, button, section, and render function.
You output ONLY a JSON object — no prose, no markdown fences.

Output schema (all fields required):
{
  "targetControlId": string | null,
  "showControlIds":      string[],
  "hideControlIds":      string[],
  "keepButtonIds":       string[],
  "hideButtonIds":       string[],
  "hideSelectorStrings": string[],
  "setSimSection":       string | null,
  "animation": {
    "enabled":      boolean,
    "controllerId": string | null,
    "min":          number,
    "max":          number,
    "step":         number,
    "intervalMs":   number,
    "showOptimal":  boolean
  } | null,
  "renderCalls": string[],
  "confidence":  number,
  "warnings":    string[]
}

═══ MANDATORY RULES — NEVER VIOLATE ═══
1. targetControlId MUST be an exact id from manifest.controls (case-sensitive). Never invent an id.
2. targetControlId MUST appear in showControlIds. NEVER in hideControlIds.
3. Every id in showControlIds / hideControlIds / keepButtonIds / hideButtonIds MUST exist in the manifest.
4. "clear-btn" MUST be in keepButtonIds if manifest.buttons contains id="clear-btn".
5. animation.controllerId MUST equal targetControlId when animation.enabled=true.
6. animation.min/max MUST come from manifest.controls entry for targetControlId (parse as number).
7. animation.step: choose 0.1–0.3 for smooth motion. Never 0.
8. If simpleUi=false: showControlIds = all control ids, hideControlIds = [], hideSelectorStrings = [].
9. If autoScript=false: animation = { enabled:false, controllerId:targetControlId, ...rest from manifest }.
10. renderCalls: include only functions that appear in manifest.renderFunctions or manifest.updateFunctions.

═══ ALIAS RESOLUTION ═══
Map user prompt terms to canonical manifest IDs:
- "vy0", "v0y", "Vy0", "v_0y", "initial vertical velocity", "initial y velocity", "vertical velocity", "y-velocity" → id="v0y" (if manifest contains it)
- "vx0", "v0x", "initial horizontal velocity", "horizontal velocity" → id="v0x" (if manifest contains it)
- Use the label field in manifest.controls for other label-based lookups (case-insensitive)

═══ hideSelectorStrings guidelines ═══
Common safe patterns (include a warning if you're guessing):
  ".tabs"            — mode-switching tab bar
  ".sim-info"        — explanation/formula block
  ".legend"          — path legend
  ".action-display"  — action/energy display block
  ".instructions"    — instruction text

Output only the JSON object.`;

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
  };

  for (const [key, content] of sourceMap) {
    const isHtml = /\.(html|htm)$/.test(key);
    const isJs   = /\.(js|mjs|ts)$/.test(key);

    if (isHtml) {
      // Extract <input> elements
      const inputRe = /<input([^>]*)>/gi;
      let m: RegExpExecArray | null;
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
      }

      // Extract <button> elements
      const btnRe = /<button[^>]+id="([^"]+)"[^>]*>([^<]*)</gi;
      while ((m = btnRe.exec(content)) !== null) {
        const id = m[1];
        if (manifest.buttons.some(b => b.id === id)) continue;
        manifest.buttons.push({ id, label: m[2].trim() });
      }

      // Extract <div id="..."> sections
      const divRe = /<div([^>]*)id="([^"]+)"([^>]*)>/gi;
      while ((m = divRe.exec(content)) !== null) {
        const id = m[2];
        if (manifest.sections.some(s => s.id === id)) continue;
        const allAttrs = m[1] + m[3];
        const styleStr = /\bstyle="([^"]*)"/.exec(allAttrs)?.[1] ?? '';
        const defaultHidden = /display\s*:\s*none/.test(styleStr);
        manifest.sections.push({ id, defaultHidden });
      }
    }

    if (isJs) {
      for (const fn of ['redraw', 'draw', 'render', 'refresh', 'repaint']) {
        if (!manifest.renderFunctions.includes(fn) && new RegExp(`function ${fn}\\s*\\(`).test(content)) {
          manifest.renderFunctions.push(fn);
        }
      }
      for (const fn of ['updateDerivedPhysics','updateActionDisplay','updateOptimalActionDisplay',
                         'updateEnergyBars','computeAll','computeState','update']) {
        if (!manifest.updateFunctions.includes(fn) && new RegExp(`function ${fn}\\s*\\(`).test(content)) {
          manifest.updateFunctions.push(fn);
        }
      }
      if (/setSimSection/.test(content)) manifest.hasSetSimSection = true;
    }
  }

  return manifest;
}

// ── Plan validation & auto-repair ─────────────────────────────────────────────

function validateAndRepairPlan(plan: BridgePlan, manifest: SimManifest): BridgePlan {
  const controlIds = new Set(manifest.controls.map(c => c.id));
  const buttonIds  = new Set(manifest.buttons.map(b => b.id));
  let p = { ...plan };

  // Ensure targetControlId is in manifest
  if (p.targetControlId && !controlIds.has(p.targetControlId)) {
    logger.warn({ targetControlId: p.targetControlId }, 'Plan repair: targetControlId not in manifest');
    p.targetControlId = null;
  }

  // targetControlId must never be hidden
  if (p.targetControlId) {
    p.hideControlIds = p.hideControlIds.filter(id => id !== p.targetControlId);
  }

  // Filter IDs to those that exist in the manifest
  p.hideControlIds = p.hideControlIds.filter(id => controlIds.has(id));
  p.showControlIds = p.showControlIds.filter(id => controlIds.has(id));
  p.keepButtonIds  = p.keepButtonIds.filter(id => buttonIds.has(id));
  p.hideButtonIds  = p.hideButtonIds.filter(id => buttonIds.has(id));

  // Ensure clear-btn stays if it exists
  if (buttonIds.has('clear-btn')) {
    p.hideButtonIds = p.hideButtonIds.filter(id => id !== 'clear-btn');
    if (!p.keepButtonIds.includes('clear-btn')) p.keepButtonIds = [...p.keepButtonIds, 'clear-btn'];
  }

  // Fix animation
  if (p.animation) {
    if (p.animation.enabled && p.animation.controllerId !== p.targetControlId) {
      const ctrl = manifest.controls.find(c => c.id === p.targetControlId);
      p.animation = {
        ...p.animation,
        controllerId: p.targetControlId,
        min:  ctrl ? parseFloat(ctrl.min ?? '0') : p.animation.min,
        max:  ctrl ? parseFloat(ctrl.max ?? '100') : p.animation.max,
      };
    }
    if (!p.animation.step || p.animation.step <= 0) p.animation = { ...p.animation, step: 0.2 };
    if (!p.animation.intervalMs || p.animation.intervalMs < 20) p.animation = { ...p.animation, intervalMs: 60 };
  }

  // renderCalls: keep only known functions
  const allFns = new Set([...manifest.renderFunctions, ...manifest.updateFunctions]);
  p.renderCalls = p.renderCalls.filter(fn => allFns.has(fn));
  // Always put updateFunctions before renderFunctions
  p.renderCalls = [
    ...p.renderCalls.filter(fn => manifest.updateFunctions.includes(fn)),
    ...p.renderCalls.filter(fn => manifest.renderFunctions.includes(fn)),
  ];

  return p;
}

// ── Deterministic bridge compiler ─────────────────────────────────────────────

function countDecimals(num: number): number {
  const s = String(num);
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : s.length - dot - 1;
}

export function compileBridgeFromPlan(plan: BridgePlan, manifest: SimManifest): string {
  const L: string[] = [];

  L.push(`(function () {`);
  L.push(`  'use strict';`);
  L.push(``);

  // SIM_READY — one RAF so sim's own boot() has run first
  L.push(`  // ── SIM_READY — one RAF so sim boot() has run ────────────────────────────────`);
  L.push(`  let _ready = false;`);
  L.push(`  function _fireReady() {`);
  L.push(`    if (_ready) return; _ready = true; window._simReadyFired = true;`);
  L.push(`    window.parent?.postMessage({ type: 'SIM_READY' }, '*');`);
  L.push(`  }`);
  L.push(`  if (document.readyState === 'loading')`);
  L.push(`    document.addEventListener('DOMContentLoaded', () => requestAnimationFrame(_fireReady));`);
  L.push(`  else`);
  L.push(`    requestAnimationFrame(_fireReady);`);
  L.push(`  setTimeout(_fireReady, 3000);`);
  L.push(``);

  // Lifecycle
  L.push(`  // ── Script lifecycle ─────────────────────────────────────────────────────────`);
  L.push(`  let _cancelFn = null;`);
  L.push(``);
  L.push(`  function stopScript() {`);
  L.push(`    if (_cancelFn) { _cancelFn(); _cancelFn = null; }`);
  L.push(`    window._setScriptedMode?.(false);`);
  L.push(`    window.setSimSection?.('default');`);
  L.push(`  }`);
  L.push(`  function pauseScript() {`);
  L.push(`    if (_cancelFn) { _cancelFn(); _cancelFn = null; }`);
  L.push(`    window._setScriptedMode?.(false);`);
  L.push(`  }`);
  L.push(`  function startScript(name) {`);
  L.push(`    stopScript();`);
  L.push(`    window._setScriptedMode?.(true);`);
  L.push(`    const fn = SCRIPTS[name] ?? SCRIPTS['main'];`);
  L.push(`    if (fn) _cancelFn = fn();`);
  L.push(`  }`);
  L.push(``);

  const hasHide = plan.hideControlIds.length > 0 || plan.hideButtonIds.length > 0 || plan.hideSelectorStrings.length > 0;

  // SCRIPTS.main
  L.push(`  const SCRIPTS = {`);
  L.push(`    main: function () {`);

  if (hasHide) {
    L.push(`      // ── Record original display values for cleanup ─────────────────────────────`);
    L.push(`      const _hidden = [];`);
    L.push(`      function _hide(el) {`);
    L.push(`        if (!el) return;`);
    L.push(`        const orig = el.style.getPropertyValue('display');`);
    L.push(`        el.style.setProperty('display', 'none');`);
    L.push(`        _hidden.push([el, orig]);`);
    L.push(`      }`);
    L.push(``);

    for (const id of plan.hideControlIds) {
      L.push(`      _hide(document.getElementById('${id}')?.closest('.control-group') ?? document.getElementById('${id}'));`);
    }
    for (const id of plan.hideButtonIds) {
      L.push(`      _hide(document.getElementById('${id}'));`);
    }
    for (const sel of plan.hideSelectorStrings) {
      L.push(`      _hide(document.querySelector('${sel.replace(/'/g, "\\'")}'));`);
    }
    L.push(``);
  }

  // setSimSection
  if (plan.setSimSection && manifest.hasSetSimSection) {
    L.push(`      window.setSimSection?.('${plan.setSimSection}');`);
  }

  // Ensure draw-mode visible
  if (manifest.sections.some(s => s.id === 'draw-mode')) {
    L.push(`      document.getElementById('draw-mode')?.style.setProperty('display', 'block');`);
  }

  // showOptimal
  if (plan.animation?.showOptimal) {
    L.push(`      window.showOptimal = true;`);
  }

  // Static render calls (non-animation)
  if (!plan.animation?.enabled && plan.renderCalls.length > 0) {
    for (const fn of plan.renderCalls) L.push(`      window.${fn}?.();`);
  }

  // Animation
  if (plan.animation?.enabled && plan.animation.controllerId) {
    const anim = plan.animation;
    const dec  = countDecimals(anim.step);
    L.push(``);
    L.push(`      // ── Pingpong animation ────────────────────────────────────────────────────`);
    L.push(`      const _el = document.getElementById('${anim.controllerId}');`);
    L.push(`      if (!_el) { _restoreAll(); return () => {}; }`);
    L.push(`      let _val = parseFloat(_el.value) || ${anim.min};`);
    L.push(`      let _dir = 1;`);
    L.push(`      const _iv = setInterval(() => {`);
    L.push(`        _val += _dir * ${anim.step};`);
    L.push(`        if (_val >= ${anim.max}) { _val = ${anim.max}; _dir = -1; }`);
    L.push(`        if (_val <= ${anim.min}) { _val = ${anim.min}; _dir = 1; }`);
    L.push(`        _el.value = String(parseFloat(_val.toFixed(${dec})));`);
    L.push(`        _el.dispatchEvent(new Event('input', { bubbles: true }));`);
    for (const fn of plan.renderCalls) L.push(`        window.${fn}?.();`);
    if (anim.showOptimal) L.push(`        window.showOptimal = true;`);
    L.push(`      }, ${anim.intervalMs});`);
  }

  // Restore function
  L.push(``);
  if (hasHide) {
    L.push(`      function _restoreAll() {`);
    L.push(`        _hidden.forEach(([el, orig]) => {`);
    L.push(`          if (orig) el.style.setProperty('display', orig);`);
    L.push(`          else el.style.removeProperty('display');`);
    L.push(`        });`);
    L.push(`      }`);
    L.push(``);
  }

  // Cancel return
  if (plan.animation?.enabled) {
    if (hasHide) {
      L.push(`      return () => { clearInterval(_iv); _restoreAll(); };`);
    } else {
      L.push(`      return () => clearInterval(_iv);`);
    }
  } else {
    L.push(`      return ${hasHide ? '_restoreAll' : '() => {}'};`);
  }

  L.push(`    },`);
  L.push(`  };`);
  L.push(``);

  // Public API + postMessage + pointerdown
  L.push(`  window.SimAPI = { start: startScript, stop: stopScript };`);
  L.push(``);
  L.push(`  window.addEventListener('message', e => {`);
  L.push(`    const { type, script } = e.data || {};`);
  L.push(`    if (type === 'startScript')  startScript(script || 'main');`);
  L.push(`    if (type === 'stopScript')   stopScript();`);
  L.push(`    if (type === 'pauseScript')  pauseScript();`);
  L.push(`    if (type === 'PING_SIM_READY' && window._simReadyFired)`);
  L.push(`      window.parent?.postMessage({ type: 'SIM_READY' }, '*');`);
  L.push(`  });`);
  L.push(``);
  L.push(`  document.addEventListener('pointerdown', () => {`);
  L.push(`    window.parent?.postMessage({ type: 'userInteraction' }, '*');`);
  L.push(`  }, { capture: true });`);
  L.push(``);
  L.push(`})();`);

  return L.join('\n');
}

// ── SimulationService ─────────────────────────────────────────────────────────

export class SimulationService {
  constructor(
    private readonly storage: StorageService,
    private readonly anthropicApiKey: string,
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
    simId:      string;
    sectionId:  string;
    projectId:  string;
    prompt:     string;
    simpleUi:   boolean;
    autoScript: boolean;
  }): Promise<{ sectionUrl: string; plan: BridgePlan }> {
    const { simId, sectionId, projectId, prompt, simpleUi, autoScript } = opts;
    const prefix = `simulations/${projectId}/${simId}`;

    // 1. Gather source files
    const allKeys = await this.storage.listObjects(prefix);
    const isText       = (k: string) => /\.(js|mjs|html|htm|css|ts)$/.test(k);
    const isSectionFile = (k: string) => /section_[^/]+\.(html|js)$/.test(k);
    const textKeys  = allKeys.filter(k => isText(k) && !isSectionFile(k));
    const jsKeys    = textKeys.filter(k => /\.(js|mjs|ts)$/.test(k));
    const htmlCssKeys = textKeys.filter(k => /\.(html|htm|css)$/.test(k));
    const orderedKeys = [...jsKeys, ...htmlCssKeys].slice(0, 10);

    const sourceMap = new Map<string, string>();
    await Promise.all(orderedKeys.map(async key => {
      try {
        const buf = await this.storage.readObject(key);
        // Strip ALL previously-injected bridge blocks (v1 and v2)
        const raw = buf.toString('utf-8')
          .replace(/<script[^>]*>[\s\S]*?\/\* sim-bridge[\s\S]*?<\/script>\s*/gi, '')
          .replace(/<script[^>]*>[\s\S]*?sim-bridge v[12][\s\S]*?<\/script>\s*/gi, '');
        sourceMap.set(key, raw.slice(0, 12000));
      } catch { /* skip unreadable files */ }
    }));

    // 2. Build manifest
    const manifest = buildManifest(sourceMap);
    logger.info({ simId, sectionId, controls: manifest.controls.length, buttons: manifest.buttons.length }, 'Manifest built');

    // 3. Generate JSON plan from Claude
    const rawPlan = await this.callClaudeForPlan({ manifest, prompt, simpleUi, autoScript });

    // 4. Validate & auto-repair
    const plan = validateAndRepairPlan(rawPlan, manifest);
    logger.info({
      simId, sectionId,
      targetControlId: plan.targetControlId,
      confidence: plan.confidence,
      animationEnabled: plan.animation?.enabled,
      hideCount: plan.hideControlIds.length + plan.hideButtonIds.length,
    }, 'Bridge plan ready');

    // 5. Compile deterministic JS
    const jsCode = compileBridgeFromPlan(plan, manifest);

    // 6. Locate entry HTML
    const entryKey = allKeys.find(k => /\/(index|main)\.(html|htm)$/.test(k))
      ?? allKeys.find(k => (k.endsWith('.html') || k.endsWith('.htm')) && !isSectionFile(k));
    if (!entryKey) throw new Error('No HTML entry file found in simulation');

    const entryDir = entryKey.substring(0, entryKey.lastIndexOf('/'));

    // 7. Upload bridge JS
    const bridgeJsKey = `${prefix}/section_${sectionId}.js`;
    await this.storage.uploadFile(bridgeJsKey, Buffer.from(jsCode, 'utf-8'), 'application/javascript');

    // 8. Build section HTML (strip old bridge, add new external <script src>)
    const rawHtml = (await this.storage.readObject(entryKey)).toString('utf-8');
    const stripped = rawHtml
      .replace(/<script[^>]*>[\s\S]*?\/\* sim-bridge[\s\S]*?<\/script>\s*/gi, '')
      .replace(/<script[^>]*>[\s\S]*?sim-bridge v[12][\s\S]*?<\/script>\s*/gi, '');

    const relativeDepth = entryDir === prefix
      ? 0
      : entryDir.slice(prefix.length).split('/').filter(Boolean).length;
    const relPath = (relativeDepth > 0 ? '../'.repeat(relativeDepth) : './') + `section_${sectionId}.js`;

    const scriptTag = `<script src="${relPath}"></script>`;
    const sectionHtml = stripped.includes('</body>')
      ? stripped.replace('</body>', `${scriptTag}\n</body>`)
      : stripped + '\n' + scriptTag;

    const sectionHtmlKey = `${entryDir}/section_${sectionId}.html`;
    await this.storage.uploadFile(sectionHtmlKey, Buffer.from(sectionHtml, 'utf-8'), 'text/html; charset=utf-8');
    const sectionUrl = this.storage.getSimPublicUrl(sectionHtmlKey);

    logger.info({ simId, sectionId, projectId, sectionUrl, jsLen: jsCode.length }, 'Bridge script generated');
    return { sectionUrl, plan };
  }

  // ── Private ───────────────────────────────────────────────────────────────────

  private async callClaudeForPlan(opts: {
    manifest:   SimManifest;
    prompt:     string;
    simpleUi:   boolean;
    autoScript: boolean;
  }): Promise<BridgePlan> {
    const { manifest, prompt, simpleUi, autoScript } = opts;

    const userMessage = [
      'SIMULATION MANIFEST:',
      JSON.stringify(manifest, null, 2),
      '',
      '---',
      `SECTION PROMPT: ${prompt}`,
      '',
      '---',
      `TOGGLES:`,
      `simpleUi = ${simpleUi}`,
      `autoScript = ${autoScript}`,
      '',
      'Generate the bridge plan JSON now.',
    ].join('\n');

    const client = new Anthropic({ apiKey: this.anthropicApiKey });
    const msg = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 2048,
      system:     BRIDGE_PLAN_SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: userMessage }],
    });

    const rawText = (msg.content as Anthropic.ContentBlock[])
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('');

    const clean = rawText.replace(/^```(?:json)?\r?\n?/gm, '').replace(/^```\s*$/gm, '').trim();

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(clean);
    } catch {
      throw new Error(`Claude returned non-JSON plan: ${clean.slice(0, 300)}`);
    }

    return {
      targetControlId:     (parsed.targetControlId as string | null) ?? null,
      showControlIds:      Array.isArray(parsed.showControlIds)      ? (parsed.showControlIds as string[])      : [],
      hideControlIds:      Array.isArray(parsed.hideControlIds)      ? (parsed.hideControlIds as string[])      : [],
      keepButtonIds:       Array.isArray(parsed.keepButtonIds)       ? (parsed.keepButtonIds as string[])       : [],
      hideButtonIds:       Array.isArray(parsed.hideButtonIds)       ? (parsed.hideButtonIds as string[])       : [],
      hideSelectorStrings: Array.isArray(parsed.hideSelectorStrings) ? (parsed.hideSelectorStrings as string[]) : [],
      setSimSection:       (parsed.setSimSection as string | null)   ?? null,
      animation:           (parsed.animation as BridgePlan['animation']) ?? null,
      renderCalls:         Array.isArray(parsed.renderCalls)         ? (parsed.renderCalls as string[])         : [],
      confidence:          typeof parsed.confidence === 'number'     ? parsed.confidence                        : 0.5,
      warnings:            Array.isArray(parsed.warnings)            ? (parsed.warnings as string[])            : [],
    };
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
