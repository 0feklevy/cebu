import { createHash } from 'crypto';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { StorageService } from '../storage/StorageService.js';
import { LLMService } from '../llm/LLMService.js';
import { GuidanceTTSService, resolveGuidanceVoice } from '../audio/GuidanceTTSService.js';
import {
  selectSources,
  computeSourceHash,
  buildManifest,
  buildContextPrompt,
  SAFE_SECTION_ID_RE,
  type SimManifest,
} from './SimulationService.js';
import { db } from '../../db/index.js';
import { system_prompts } from '../../db/schema.js';
import { logger } from '../../lib/logger.js';

// ── Public types ────────────────────────────────────────────────────────────

export type GuidanceTrigger =
  | { kind: 'feature'; targetId: string; events: Array<'pointerdown' | 'input' | 'change'> }
  | { kind: 'config';  predicateBody: string; observables: string[]; debounce?: number };

export interface GuidanceEntryStored {
  id:         string;
  kind:       'feature' | 'config';
  title:      string;
  narration:  string;
  enabled:    boolean;
  trigger:    GuidanceTrigger;
  audioUrl:   string | null;   // null until published
  confidence: number;
  warnings:   string[];
}

export interface GuidanceDraftResult {
  entries:      GuidanceEntryStored[];
  mdUrl:        string;
  sourceHash:   string;
  provider:     string;
  model:        string;
  confidence:   number;
  language:     string;
  droppedCount: number;
  warnings:     string[];
}

export interface GuidancePublishResult {
  entries:      GuidanceEntryStored[];   // audioUrl filled in for enabled entries
  guidanceHash: string;
  language:     string;
}

type OnEvent = (event: string, data: object) => void;

// ── LLM output schemas (Pass 2) ──────────────────────────────────────────────

const FeatureTriggerSchema = z.object({
  kind:     z.literal('feature'),
  targetId: z.string().min(1),
  events:   z.array(z.enum(['pointerdown', 'input', 'change'])).min(1),
});
const ConfigTriggerSchema = z.object({
  kind:          z.literal('config'),
  predicateBody: z.string().min(3),
  observables:   z.array(z.string()).default([]),
  debounce:      z.number().int().min(1).max(20).optional(),
});
const GuidanceEntrySchema = z.object({
  id:         z.string().regex(SAFE_SECTION_ID_RE),
  kind:       z.enum(['feature', 'config']),
  title:      z.string().min(1),
  narration:  z.string().min(1).max(400),
  trigger:    z.discriminatedUnion('kind', [FeatureTriggerSchema, ConfigTriggerSchema]),
  confidence: z.number().min(0).max(1).default(0.6),
  warnings:   z.array(z.string()).default([]),
});
const GuidancePlanSchema = z.object({
  message:    z.string().default(''),
  entries:    z.array(GuidanceEntrySchema).default([]),
  confidence: z.number().min(0).max(1).default(0.6),
});
type GuidancePlan = z.infer<typeof GuidancePlanSchema>;

// ── Hardcoded fallback system prompts (admin-editable copies live in system_prompts) ──

const GUIDANCE_ANALYZE_SYSTEM_PROMPT = `You are a physics/science educator analyzing an interactive simulation embedded in a learning video.
You receive the simulation's FULL source code plus a manifest of verified element IDs and functions.

Your job: understand the simulation DEEPLY and critically, then write a structured markdown "understanding document".

Cover, concretely and grounded in the actual code:
1. WHAT the simulation models (the system, its variables, what is being visualized).
2. FEATURES — for every meaningful control, slider, button, select, checkbox: what it does AND its conceptual meaning (why a learner would touch it, what changes).
3. INTERESTING CONFIGURATIONS / PHENOMENA — the heart of this task. Identify emergent states, special parameter regimes, and phenomena a curious learner might reach, e.g.:
   - Ising model: a fully uniform grid = the global energy minimum; a striped/domain pattern = a local minimum; pressing "play" lets the system relax.
   - Diffusion: a phenomenon that appears when sliders reach a particular regime.
   For each phenomenon: describe the state, its scientific significance, and — CRITICALLY — what is OBSERVABLE about it at runtime.
4. OBSERVABILITY — for each phenomenon, name the concrete runtime signal that could detect it: a displayed readout element id (e.g. an energy/temperature value), an input/checkbox/select value, or a JS global variable that clearly exists in the source (e.g. a grid array assigned to window). Prefer DOM-readable signals over guessed JS globals. If a phenomenon has NO reliable observable signal in the code, say so explicitly.

Be precise and skeptical: only claim what the code supports. This document will be turned into short voice cues, so be clear about which features and phenomena are worth narrating.`;

const GUIDANCE_PLAN_SYSTEM_PROMPT = `You convert a simulation analysis into a JSON list of "guidance cues" for a guided-learning overlay.
You receive the simulation's FULL source code, a manifest of verified IDs/functions, and (as prior turn) the analysis document.

A cue fires ONCE at runtime, the first time the learner either USES a feature or REACHES an interesting configuration, and plays a 1–2 sentence voice narration.

There are two trigger kinds:

1) FEATURE (interaction): the learner touches a control/button.
   trigger = { "kind": "feature", "targetId": "<element id that EXISTS in the manifest/source>", "events": ["pointerdown"|"input"|"change", ...] }
   Use "pointerdown" for buttons, "input"/"change" for sliders/selects/checkboxes.

2) CONFIG (state reached): an observable predicate over simulation state becomes true.
   trigger = { "kind": "config", "predicateBody": "<JS body that returns a boolean>", "observables": ["<id or global it reads>", ...], "debounce": 3 }
   The predicate body is the BODY of  function predicate(S) { ... return <boolean>; }
   It MUST be pure and read-only and may ONLY read state through the provided S accessor (NO window., NO document., NO fetch/timers/listeners/eval):
     S.el(id)        -> element or null
     S.val(id)       -> input value as string ('' if none)
     S.num(id)       -> number from value or textContent (null if NaN)
     S.text(id)      -> textContent string
     S.checked(id)   -> boolean
     S.select(id)    -> selected value string
     S.global(name)  -> window[name] (use only for globals clearly present in the source, e.g. a grid array)
     S.flat(arr)     -> flattens a 2D array one level
     S.allEqual(arr) -> true if all (flattened) elements are strictly equal
     S.fracTrue(arr, pred?) -> fraction (0..1) of truthy / pred-matching elements
     S.count(arr, pred)     -> count of matching elements
   Example (Ising uniform grid = global minimum):
     "predicateBody": "var g = S.global('grid'); return !!g && S.allEqual(g);", "observables": ["grid"]
   Example (a displayed energy readout near zero):
     "predicateBody": "var e = S.num('energyValue'); return e !== null && Math.abs(e) < 0.01;", "observables": ["energyValue"]

RULES:
- Ground EVERYTHING in real ids/globals visible in the source/manifest. Never invent ids.
- Prefer DOM-readable observables; only use S.global for globals that clearly exist in the source.
- If a phenomenon has no reliable observable, OMIT it (do not guess). Feature cues are always safe.
- Keep each narration to 1–2 short sentences, in the requested language, encouraging and instructive.
- Give a unique short id per cue (letters/digits/_/- only) and a per-cue confidence.

OUTPUT: return ONLY a JSON object:
{ "message": "<short summary>", "confidence": 0.0-1.0,
  "entries": [ { "id": "...", "kind": "feature"|"config", "title": "...", "narration": "...", "trigger": {...}, "confidence": 0.0-1.0, "warnings": [] } ] }`;

// ── Predicate security scan ───────────────────────────────────────────────────

const PREDICATE_BANS: Array<[RegExp, string]> = [
  [/\bfetch\s*\(/,        'fetch()'],
  [/XMLHttpRequest/,      'XMLHttpRequest'],
  [/\blocalStorage\b/,    'localStorage'],
  [/\bsessionStorage\b/,  'sessionStorage'],
  [/document\s*\.\s*cookie/, 'document.cookie'],
  [/\beval\s*\(/,         'eval()'],
  [/new\s+Function/,      'new Function()'],
  [/\bwindow\s*\./,       'window.* (use S.global instead)'],
  [/\bdocument\s*\./,     'document.* (use S.el/S.text instead)'],
  [/\bpostMessage\b/,     'postMessage'],
  [/\.innerHTML\b/,       'innerHTML'],
  [/\bsetTimeout\b/,      'setTimeout'],
  [/\bsetInterval\b/,     'setInterval'],
  [/addEventListener/,    'addEventListener'],
  [/\bimport\b/,          'import'],
];

// ── Grounding helpers ─────────────────────────────────────────────────────────

/** All element ids declared anywhere in the HTML sources (broad read-only allow-list). */
function collectElementIds(sourceMap: Map<string, string>): Set<string> {
  const ids = new Set<string>();
  for (const [key, content] of sourceMap) {
    if (!/\.(html|htm)$/.test(key)) continue;
    const re = /\bid\s*=\s*["']([^"']+)["']/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) ids.add(m[1]);
  }
  return ids;
}

/** Soft allow-list of identifiers that could be globals (used only to warn on ungrounded observables). */
function collectGlobalCandidates(sourceMap: Map<string, string>, manifest: SimManifest): Set<string> {
  const names = new Set<string>(manifest.globalObjects);
  for (const [key, content] of sourceMap) {
    if (!/\.(js|mjs|ts)$/.test(key)) continue;
    let m: RegExpExecArray | null;
    const winRe = /window\.([A-Za-z_$][\w$]*)\s*=/g;
    while ((m = winRe.exec(content)) !== null) names.add(m[1]);
    const declRe = /\b(?:var|let|const|function)\s+([A-Za-z_$][\w$]*)/g;
    while ((m = declRe.exec(content)) !== null) names.add(m[1]);
  }
  return names;
}

// ── Validation ────────────────────────────────────────────────────────────────

/** Defensive re-scan of a single predicate body (used before baking into guidance.js). */
export function scanPredicate(body: string): string | null {
  const ban = PREDICATE_BANS.find(([re]) => re.test(body));
  if (ban) return `banned ${ban[1]}`;
  try { new Function('S', body); } catch (err) { return `syntax error: ${(err as Error).message}`; }
  return null;
}

interface ValidationOutput { entries: GuidanceEntryStored[]; dropped: Array<{ id: string; reason: string }>; }

function validateGuidanceEntries(
  plan: GuidancePlan,
  elementIds: Set<string>,
  globalCandidates: Set<string>,
): ValidationOutput {
  const entries: GuidanceEntryStored[] = [];
  const dropped: Array<{ id: string; reason: string }> = [];
  const seen = new Set<string>();

  for (const e of plan.entries) {
    if (seen.has(e.id)) { dropped.push({ id: e.id, reason: 'duplicate id' }); continue; }
    seen.add(e.id);

    const warnings = [...e.warnings];

    if (e.trigger.kind === 'feature') {
      if (!elementIds.has(e.trigger.targetId)) {
        dropped.push({ id: e.id, reason: `feature targetId "${e.trigger.targetId}" not found in source` });
        continue;
      }
    } else {
      const body = e.trigger.predicateBody;
      const ban = PREDICATE_BANS.find(([re]) => re.test(body));
      if (ban) { dropped.push({ id: e.id, reason: `predicate uses banned ${ban[1]}` }); continue; }
      try { new Function('S', body); } catch (err) {
        dropped.push({ id: e.id, reason: `predicate syntax error: ${(err as Error).message}` });
        continue;
      }
      const grounded = e.trigger.observables.filter(o => elementIds.has(o) || globalCandidates.has(o));
      if (e.trigger.observables.length > 0 && grounded.length === 0) {
        warnings.push('no declared observable was found in the source — this cue may never fire');
      }
      e.trigger.debounce = e.trigger.debounce ?? 3;
    }

    entries.push({
      id: e.id, kind: e.kind, title: e.title, narration: e.narration,
      enabled: true, trigger: e.trigger, audioUrl: null,
      confidence: e.confidence, warnings,
    });
  }

  return { entries, dropped };
}

// ── guidance.js assembly ──────────────────────────────────────────────────────

function indentLines(s: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return s.split('\n').map(l => (l.trim() === '' ? '' : pad + l)).join('\n');
}

/** Build the self-contained guidance.js overlay from validated, published entries. */
export function wrapGuidanceCombined(entries: GuidanceEntryStored[]): string {
  const features = entries.filter(e => e.enabled && e.trigger.kind === 'feature');
  const configs  = entries.filter(e => e.enabled && e.trigger.kind === 'config');

  const featuresData = JSON.stringify(
    features.map(e => ({
      id: e.id,
      targetId: (e.trigger as Extract<GuidanceTrigger, { kind: 'feature' }>).targetId,
      events:   (e.trigger as Extract<GuidanceTrigger, { kind: 'feature' }>).events,
      narration: e.narration, audioUrl: e.audioUrl,
    })),
    null, 2,
  );

  const configBlocks = configs.map(e => {
    const t = e.trigger as Extract<GuidanceTrigger, { kind: 'config' }>;
    const meta = JSON.stringify({ id: e.id, narration: e.narration, audioUrl: e.audioUrl, debounce: t.debounce ?? 3 });
    return `    { meta: ${meta}, predicate: function (S) {\n${indentLines(t.predicateBody, 6)}\n    } }`;
  }).join(',\n');

  return `;(function () {
  'use strict';
  /* guidance v1 — auto-generated by podcast-saas. Layer ABOVE the original sim files. */
  var __FEATURES__ = ${indentLines(featuresData, 2).trimStart()};
  var __CONFIGS__ = [
${configBlocks}
  ];

  var _fired = {}, _streak = {}, _gate = true, _autoScript = false, _lastPoll = 0;
  function _post(msg){ try { if (window.parent) window.parent.postMessage(msg, '*'); } catch (e) {} }
  function _active(){ return _gate && !_autoScript; }
  function _matchesId(el, id){ while (el) { if (el.id === id) return true; el = el.parentElement; } return false; }
  function _fire(id, narration, audioUrl){ if (_fired[id]) return; _fired[id] = true; _post({ type: 'guidanceCue', id: id, text: narration, audioUrl: audioUrl }); }

  // Read-only sim-state accessors — the ONLY API guidance predicates may use.
  var S = {
    el: function (id) { try { return document.getElementById(id); } catch (e) { return null; } },
    val: function (id) { var e = S.el(id); return (e && 'value' in e) ? String(e.value) : ''; },
    num: function (id) { var e = S.el(id); if (!e) return null; var v = ('value' in e && e.value !== '') ? e.value : e.textContent; var n = parseFloat(v); return isNaN(n) ? null : n; },
    text: function (id) { var e = S.el(id); return e ? String(e.textContent || '') : ''; },
    checked: function (id) { var e = S.el(id); return !!(e && e.checked); },
    select: function (id) { var e = S.el(id); return (e && 'value' in e) ? String(e.value) : ''; },
    global: function (name) { try { return window[name]; } catch (e) { return undefined; } },
    flat: function (a) { var out = []; if (!a || a.length == null) return out; for (var i = 0; i < a.length; i++) { var x = a[i]; if (x && x.length != null && typeof x !== 'string') { for (var j = 0; j < x.length; j++) out.push(x[j]); } else out.push(x); } return out; },
    allEqual: function (a) { a = S.flat(a); if (!a.length) return false; for (var i = 1; i < a.length; i++) { if (a[i] !== a[0]) return false; } return true; },
    fracTrue: function (a, pred) { a = S.flat(a); if (!a.length) return 0; var c = 0; for (var i = 0; i < a.length; i++) { if (pred ? pred(a[i]) : a[i]) c++; } return c / a.length; },
    count: function (a, pred) { a = S.flat(a); var c = 0; for (var i = 0; i < a.length; i++) { if (pred ? pred(a[i]) : a[i]) c++; } return c; }
  };

  // Feature interaction triggers — only genuine user input (isTrusted ignores synthetic auto-script events).
  function _onEvt(ev){
    if (!ev || !ev.isTrusted) return;
    for (var i = 0; i < __FEATURES__.length; i++) {
      var f = __FEATURES__[i];
      if (_fired[f.id]) continue;
      if (f.events.indexOf(ev.type) === -1) continue;
      if (_matchesId(ev.target, f.targetId)) _fire(f.id, f.narration, f.audioUrl);
    }
  }
  document.addEventListener('pointerdown', _onEvt, true);
  document.addEventListener('input', _onEvt, true);
  document.addEventListener('change', _onEvt, true);

  // Configuration triggers — throttled rAF poll with stability debounce; gated off during auto-demos.
  function _loop(ts){
    requestAnimationFrame(_loop);
    if (ts - _lastPoll < 150) return; _lastPoll = ts;
    if (!_active()) return;
    for (var i = 0; i < __CONFIGS__.length; i++) {
      var c = __CONFIGS__[i], id = c.meta.id;
      if (_fired[id]) continue;
      var ok = false;
      try { ok = !!c.predicate(S); } catch (e) { ok = false; }
      if (ok) { _streak[id] = (_streak[id] || 0) + 1; if (_streak[id] >= (c.meta.debounce || 3)) _fire(id, c.meta.narration, c.meta.audioUrl); }
      else _streak[id] = 0;
    }
  }
  requestAnimationFrame(_loop);

  window.addEventListener('message', function (e) {
    var d = e.data || {};
    if (d.type === 'guidanceInit' && d.firedIds) { for (var i = 0; i < d.firedIds.length; i++) _fired[d.firedIds[i]] = true; }
    else if (d.type === 'guidanceFired' && d.ids) { for (var j = 0; j < d.ids.length; j++) _fired[d.ids[j]] = true; }
    else if (d.type === 'guidanceGate') { _gate = !!d.active; }
    else if (d.type === 'startScript') { _autoScript = !!(d.params && d.params.autoScript); }
    else if (d.type === 'stopScript' || d.type === 'pauseScript') { _autoScript = false; }
  });

  function _ready(){ _post({ type: 'GUIDANCE_READY' }); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { requestAnimationFrame(_ready); });
  else requestAnimationFrame(_ready);
  setTimeout(_ready, 1500);
})();
`;
}

export function computeGuidanceHash(code: string): string {
  return createHash('sha256').update(code).digest('hex').slice(0, 12);
}

/** Inject/replace the guidance.js script tag using stable markers, distinct from the bridge's. */
export function injectGuidanceScriptTag(html: string, relPath: string, hash: string): string {
  const tag = `<script src="${relPath}?v=${hash}"></script>`;
  const block = `<!-- SIM_GUIDANCE_SCRIPT_START -->\n${tag}\n<!-- SIM_GUIDANCE_SCRIPT_END -->`;

  if (html.includes('<!-- SIM_GUIDANCE_SCRIPT_START -->')) {
    return html.replace(
      /<!-- SIM_GUIDANCE_SCRIPT_START -->[\s\S]*?<!-- SIM_GUIDANCE_SCRIPT_END -->/,
      block,
    );
  }
  // First time: strip only stale guidance.js tags (never touch bridge.js), insert after the bridge block.
  const cleaned = html.replace(
    /<script[^>]+src=["'][^"']*guidance\.js[^"']*["'][^>]*>\s*<\/script>/gi,
    '',
  );
  return cleaned.includes('</body>')
    ? cleaned.replace('</body>', `${block}\n</body>`)
    : cleaned + '\n' + block;
}

// ── Per-simulation lock for guidance.js / index.html read-modify-write ─────────

const _guidanceLocks = new Map<string, Promise<void>>();
async function withGuidanceLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  while (_guidanceLocks.has(key)) { await _guidanceLocks.get(key)!.catch(() => {}); }
  let release!: () => void;
  _guidanceLocks.set(key, new Promise<void>(r => { release = r; }));
  try { return await fn(); }
  finally { _guidanceLocks.delete(key); release(); }
}

// ── Service ────────────────────────────────────────────────────────────────────

export class GuidanceService {
  constructor(
    private readonly storage: StorageService,
    private readonly llm: LLMService,
    private readonly tts: GuidanceTTSService = new GuidanceTTSService(),
  ) {}

  /** Load + budget the simulation source (excluding generated bridge/guidance files). */
  private async loadSources(prefix: string): Promise<Map<string, string>> {
    const allKeys = await this.storage.listObjects(prefix);
    const isText        = (k: string) => /\.(js|mjs|html|htm|css|ts)$/.test(k);
    const isGenerated   = (k: string) => /\/(bridge|guidance)\.js$/.test(k) || /section_[^/]+\.(html|js)$/.test(k);

    const rawMap = new Map<string, string>();
    await Promise.all(
      allKeys.filter(isText).map(async key => {
        try {
          const buf = await this.storage.readObject(key);
          const raw = buf.toString('utf-8')
            .replace(/<script[^>]*>\s*\/\* sim-bridge[\s\S]*?<\/script>/gi, '')
            .replace(/<!-- SIM_BRIDGE_SCRIPT_START -->[\s\S]*?<!-- SIM_BRIDGE_SCRIPT_END -->/gi, '')
            .replace(/<!-- SIM_GUIDANCE_SCRIPT_START -->[\s\S]*?<!-- SIM_GUIDANCE_SCRIPT_END -->/gi, '');
          rawMap.set(key, raw);
        } catch { /* skip unreadable */ }
      }),
    );

    const { sourceMap } = selectSources(rawMap, isGenerated);
    return sourceMap;
  }

  private async loadBasePrompt(key: 'guidance_analyze' | 'guidance_plan', fallback: string): Promise<string> {
    const row = await db.query.system_prompts.findFirst({ where: eq(system_prompts.key, key) });
    return row?.is_customized ? row.content : fallback;
  }

  /** Step A — deep analysis → understanding.md + structured draft cues (no audio). */
  async analyzeAndDraft(opts: {
    simId: string; projectId: string; userId: string;
    language?: string; onEvent?: OnEvent; signal?: AbortSignal;
  }): Promise<GuidanceDraftResult> {
    const { simId, projectId, userId, onEvent } = opts;
    const language = opts.language || 'en';
    const signal = opts.signal ?? new AbortController().signal;
    const prefix = `simulations/${projectId}/${simId}`;

    onEvent?.('status', { status: 'Loading simulation files…', type: 'progress' });
    const sourceMap = await this.loadSources(prefix);
    if (sourceMap.size === 0) throw new Error('No readable simulation source files found');

    const sourceHash = computeSourceHash(sourceMap);
    const manifest   = buildManifest(sourceMap);
    const elementIds = collectElementIds(sourceMap);
    const globals    = collectGlobalCandidates(sourceMap, manifest);

    // Pass 1 — deep analysis → markdown understanding document
    onEvent?.('status', { status: 'Analyzing the simulation in depth…', type: 'progress' });
    const analyzeBase = await this.loadBasePrompt('guidance_analyze', GUIDANCE_ANALYZE_SYSTEM_PROMPT);
    const analyzeSystem = buildContextPrompt(analyzeBase, sourceMap, manifest, sourceHash, false);
    const analyzeUser = `Analyze this simulation deeply and write the understanding document.\nLanguage for any narration examples: ${language}.`;
    const pass1 = await this.llm.sendText({
      task: 'guidance_plan', systemPrompt: analyzeSystem, userPrompt: analyzeUser,
      userId, projectId, abortSignal: signal,
    });
    const understandingMd = pass1.text;

    const mdKey = `${prefix}/guidance/understanding.md`;
    await this.storage.uploadFile(mdKey, Buffer.from(understandingMd, 'utf-8'), 'text/markdown; charset=utf-8');
    const mdUrl = this.storage.getSimPublicUrl(mdKey);

    // Pass 2 — structured cues, grounded in the analysis
    onEvent?.('status', { status: 'Generating guidance cues…', type: 'progress' });
    const planBase = await this.loadBasePrompt('guidance_plan', GUIDANCE_PLAN_SYSTEM_PROMPT);
    const planSystem = buildContextPrompt(planBase, sourceMap, manifest, sourceHash, false);
    const planUser = `Produce the structured guidance cues now as JSON.\nNarration language: ${language}.\nGround every targetId/observable in the source. Omit configurations that have no reliable observable.`;

    const planRes = await this.llm.sendStructured({
      task: 'guidance_plan', systemPrompt: planSystem, userPrompt: planUser,
      previousMessages: [{ role: 'user', content: analyzeUser }, { role: 'assistant', content: understandingMd }],
      schema: GuidancePlanSchema, userId, projectId, abortSignal: signal,
    });
    let plan = planRes.data as GuidancePlan;
    let provider = planRes.provider;
    let model = planRes.model;

    let { entries, dropped } = validateGuidanceEntries(plan, elementIds, globals);

    // One retry if nothing survived or confidence is low
    if ((entries.length === 0 || (plan.confidence ?? 0.6) < 0.45) && !signal.aborted) {
      onEvent?.('status', { status: 'Refining guidance cues…', type: 'progress' });
      const retryUser = `${planUser}\n\nThe previous attempt yielded ${entries.length} valid cues (dropped: ${dropped.map(d => d.id + '=' + d.reason).join('; ') || 'none'}). Fix grounding and predicates, and return more reliable cues.`;
      const retry = await this.llm.sendStructured({
        task: 'guidance_plan', systemPrompt: planSystem, userPrompt: retryUser,
        previousMessages: [{ role: 'user', content: analyzeUser }, { role: 'assistant', content: understandingMd }],
        schema: GuidancePlanSchema, userId, projectId, abortSignal: signal,
      });
      const retryPlan = retry.data as GuidancePlan;
      const re = validateGuidanceEntries(retryPlan, elementIds, globals);
      if (re.entries.length >= entries.length) { plan = retryPlan; entries = re.entries; dropped = re.dropped; provider = retry.provider; model = retry.model; }
    }

    logger.info({ simId, entries: entries.length, dropped: dropped.length }, 'Guidance draft generated');

    return {
      entries, mdUrl, sourceHash, provider, model,
      confidence: plan.confidence ?? 0.6, language,
      droppedCount: dropped.length,
      warnings: dropped.map(d => `dropped ${d.id}: ${d.reason}`),
    };
  }

  /** Step B — synthesize audio for enabled cues, assemble guidance.js, inject into entry HTML. */
  async publishGuidance(opts: {
    simId: string; projectId: string;
    entries: GuidanceEntryStored[]; language?: string;
    existing?: GuidanceEntryStored[] | null;
    entryKey?: string;   // authoritative entry-file storage key (from the simulation row)
    onEvent?: OnEvent; signal?: AbortSignal;
  }): Promise<GuidancePublishResult> {
    const { simId, projectId, onEvent } = opts;
    const language = opts.language || 'en';
    const prefix = `simulations/${projectId}/${simId}`;

    const enabled = opts.entries.filter(e => e.enabled);
    if (enabled.length === 0) throw new Error('No enabled guidance cues to publish');

    // Reuse audio for unchanged narration to avoid re-billing TTS.
    const prior = new Map((opts.existing ?? []).map(e => [e.id, e]));
    const voice = await resolveGuidanceVoice(language);

    onEvent?.('status', { status: 'Synthesizing narration audio…', type: 'progress' });
    const published: GuidanceEntryStored[] = [];
    for (const e of opts.entries) {
      if (!e.enabled) { published.push({ ...e, audioUrl: null }); continue; }
      // Defensive: never bake an unsafe/broken predicate into guidance.js.
      if (e.trigger.kind === 'config') {
        const reason = scanPredicate(e.trigger.predicateBody);
        if (reason) {
          logger.warn({ simId, id: e.id, reason }, 'Disabling guidance cue with unsafe predicate at publish');
          published.push({ ...e, enabled: false, audioUrl: null, warnings: [...e.warnings, `disabled at publish: ${reason}`] });
          continue;
        }
      }
      const prev = prior.get(e.id);
      if (prev && prev.audioUrl && prev.narration === e.narration) {
        published.push({ ...e, audioUrl: prev.audioUrl });
        continue;
      }
      const buf = await this.tts.synthesize(e.narration, voice);
      const textHash = createHash('sha256').update(e.narration).digest('hex').slice(0, 8);
      const key = `${prefix}/guidance/${language}/${e.id}.${textHash}.mp3`;
      await this.storage.uploadFile(key, buf, 'audio/mpeg');
      published.push({ ...e, audioUrl: this.storage.getSimPublicUrl(key) });
    }

    // Assemble + inject under the per-sim lock (read-modify-write of index.html).
    onEvent?.('status', { status: 'Building guidance overlay…', type: 'progress' });
    const guidanceJs = wrapGuidanceCombined(published);
    const guidanceHash = computeGuidanceHash(guidanceJs);
    const guidanceKey = `${prefix}/guidance.js`;

    await withGuidanceLock(guidanceKey, async () => {
      await this.storage.uploadFile(guidanceKey, Buffer.from(guidanceJs, 'utf-8'), 'application/javascript');

      // Locate the entry HTML: prefer the authoritative entry_file (a storage key),
      // else fall back to the same heuristic the bridge uses.
      const allKeys = await this.storage.listObjects(prefix);
      const isGenerated = (k: string) => /\/(bridge|guidance)\.js$/.test(k) || /section_[^/]+\.(html|js)$/.test(k);
      const entryKey =
        (opts.entryKey && !opts.entryKey.startsWith('http') ? opts.entryKey : undefined) ??
        allKeys.find(k => /\/(index|main)\.(html|htm)$/.test(k)) ??
        allKeys.find(k => (k.endsWith('.html') || k.endsWith('.htm')) && !isGenerated(k));
      if (!entryKey) throw new Error('No HTML entry file found in simulation');

      // guidance.js lives at the prefix root; the entry HTML may be nested in a
      // sub-directory, so compute the correct relative path with ../ as needed
      // (mirrors the bridge's relative-path computation).
      const entryDir = entryKey.substring(0, entryKey.lastIndexOf('/'));
      const relativeDepth = entryDir === prefix
        ? 0
        : entryDir.slice(prefix.length).split('/').filter(Boolean).length;
      const relPath = (relativeDepth > 0 ? '../'.repeat(relativeDepth) : './') + 'guidance.js';

      const rawHtml = (await this.storage.readObject(entryKey)).toString('utf-8');
      const updatedHtml = injectGuidanceScriptTag(rawHtml, relPath, guidanceHash);
      await this.storage.uploadFile(entryKey, Buffer.from(updatedHtml, 'utf-8'), 'text/html; charset=utf-8');
    });

    logger.info({ simId, published: published.filter(e => e.enabled).length }, 'Guidance published');
    return { entries: published, guidanceHash, language };
  }
}
