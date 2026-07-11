// Ported from darwin-avatar/server/visual/visualService.ts
// Classifies a message into the best visual (equation / chart / diagram /
// simulation / image), checking the Library first and generating + storing on miss.
import { MODELS } from './models.js';
import {
  findVisual, findRelevantLibraryVisual, isDuplicateVisual, incrementUseCount, insertVisual, getVisual,
  storeSimulationHtml, type AvatarVisualRow,
} from './libraryService.js';
import { detectVisualIntent, extractTopic, isFallbackTypeAllowed, type VisualIntent } from './visualIntent.js';
import { getStorageAdapter } from '../storage/getStorageAdapter.js';
import { getOpenAIClient, isGenerationPaused, recordChatUsage } from '../llm/systemAi.js';
import { logger } from '../../lib/logger.js';

export interface ChartDataset {
  label: string;
  data: number[];
  backgroundColor?: string | string[];
  borderColor?: string;
}

export type VisualResult =
  | { type: 'equation'; latex: string; caption: string }
  | { type: 'chart'; chartType: 'bar' | 'line' | 'pie'; title: string; labels: string[]; datasets: ChartDataset[]; caption: string }
  | { type: 'diagram'; html: string; caption: string }
  | { type: 'simulation'; html: string; caption: string; simulationUrl?: string }
  | { type: 'image'; dallePrompt: string; imageType: 'realistic' | 'diagram'; caption: string }
  | { type: 'image_ready'; imageUrl: string; imageType: 'realistic' | 'diagram'; caption: string }
  | { type: 'none' };

export type VisualResultWithBank = VisualResult & {
  _fromBank?: boolean;
  bankId?: string;
  _intentRequestedType?: string | null;
};

const BLANK: VisualResult = { type: 'none' };

const CLASSIFY_PROMPT = `You are a visual content advisor for an educational avatar conversation app. Decide the BEST visual type for the current message.

Respond ONLY with valid JSON — no markdown:
{"type": string, "caption": string, ...type-specific fields}

══ STEP 0 — USER INTENT OVERRIDE (check FIRST) ══
If the user EXPLICITLY asked for a specific visual type, use it UNCONDITIONALLY:
  • "chart" / "graph" / "plot" / "compare" / "show data" / "how many" / "statistics" → type: "chart"
  • "simulation" / "interactive" / "simulate" / "play with" / "demonstrate" → type: "simulation"
  • "equation" / "formula" / "the math" / "show the formula" → type: "equation"
  • "diagram" / "draw" / "show the structure" / "flowchart" → type: "diagram"
Only fall through to the priority list when the user made NO explicit request.

══ PRIORITY LIST ══
1. "image" — USE BY DEFAULT. Any place, organism, event, object, scene, invention, or phenomenon → image.
2. "chart" — comparing numbers (with actual numbers).
3. "equation" — a specific named formula is the point.
4. "diagram" — structure/flow needing spatial layout.
5. "simulation" — concepts needing interactive sliders.
6. "none" — greetings, opinions, meta-questions.

Type-specific required fields:
- image: {"dallePrompt": "detailed prompt (max 900 chars, no human faces, no text)", "imageType": "realistic"|"diagram", "caption": "1-2 sentences"}
- chart: {"chartType": "bar"|"line"|"pie", "title": "string", "labels": ["string"], "datasets": [{"label":"string","data":[numbers],"backgroundColor":["#color1","#color2"]}], "caption": "1-2 sentences"}
- equation: {"latex": "LaTeX WITHOUT $$ delimiters. Double ALL backslashes for JSON: \\\\frac not \\frac.", "caption": "1-2 sentences"}
- diagram: {"mermaidCode": "valid Mermaid.js definition ONLY. flowchart TD for hierarchies, graph LR for cause-effect. Max 12 nodes.", "caption": "1-2 sentences"}
- simulation: {"simTopic": "brief 3-5 word description", "caption": "1-2 sentences"}
- none: {}

caption: Present tense. Describe what is shown and why it matters. Do not mention character names.
For chart colors use: "#4fc3f7","#81c784","#ffb74d","#f06292","#ce93d8"`;

function buildMermaidHtml(mermaidCode: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: #0d1117; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 16px; }
.mermaid svg { max-width: 100% !important; height: auto !important; }
</style></head><body>
<div class="mermaid">${mermaidCode}</div>
<script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
<script>mermaid.initialize({startOnLoad:true,theme:'dark',themeVariables:{background:'#0d1117',primaryColor:'#4fc3f7',primaryTextColor:'#e0e0e0',lineColor:'#81c784',edgeLabelBackground:'#1a2332',tertiaryColor:'#1a2332'}});</script>
</body></html>`;
}

function buildSimPrompt(topic: string, characterId: string): string {
  const charContext: Record<string, string> = {
    darwin:     'Charles Darwin — natural selection, evolution, finch beak variation, adaptation',
    einstein:   'Albert Einstein — special/general relativity, spacetime, E=mc², photoelectric effect, wave-particle duality',
    napoleon:   'Napoleon Bonaparte — military tactics, troop formations, artillery arcs, siege geometry',
    archimedes: 'Archimedes — lever/fulcrum, buoyancy/displacement, parabolic mirrors, gear ratios',
  };
  const ctx = charContext[characterId] ?? 'a historical scientist';
  return `You are generating a clean, interactive science simulation that fills the FULL browser viewport.

Topic: "${topic}"
Character context: ${ctx}

VISUAL STYLE: white background (#ffffff), canvas #f8fafc, labeled axes with #94a3b8 lines, solid fills (Blue #2563eb, Green #16a34a, Red #dc2626, Amber #d97706, Purple #7c3aed), text #111827, NO gradients/glow/shadows. Legend top-right if multiple series.

LAYOUT: page fills 100vw × 100vh, no scrollbars. Flex column: <canvas id="c"> on top (flex:1), controls strip ~90px at bottom. Resize canvas.width/height from clientWidth/clientHeight on load and resize.

JAVASCRIPT: requestAnimationFrame 60fps, real physics equations, dt from performance.now(), 2-3 labeled range sliders with live value readouts + a Play/Pause button, a reset() function.

CSS (inline <style>): *,*::before,*::after{box-sizing:border-box;margin:0;padding:0} html,body{width:100%;height:100%;overflow:hidden;background:#fff;font-family:system-ui,sans-serif} #app{display:flex;flex-direction:column;width:100vw;height:100vh} #c{display:block;width:100%;flex:1;min-height:0;border-bottom:1px solid #e2e8f0;background:#f8fafc} .controls{display:flex;align-items:center;gap:18px;padding:10px 20px;flex-wrap:wrap;background:#fff;flex-shrink:0;height:90px} input[type=range]{width:120px;accent-color:#2563eb} button{padding:6px 18px;border-radius:6px;border:1px solid #2563eb;background:#2563eb;color:#fff;cursor:pointer}

HANDSHAKE (copy exactly): at the very end of <script>, after starting the loop:
  window.parent?.postMessage({ type: 'SIM_READY' }, '*');
  window.addEventListener('message', e => { if (e.data?.type === 'stopScript') cancelAnimationFrame(rafId); });

OUTPUT: ONLY the complete HTML file. Start with <!DOCTYPE html>, end with </html>. No markdown, no code fences.`;
}

function repairLatexBackslashes(raw: string): string {
  return raw
    .replace(/\f([a-zA-Z])/g, '\\f$1')
    .replace(/\t([a-zA-Z])/g, '\\t$1')
    // eslint-disable-next-line no-control-regex -- intentional: repair a LaTeX \b that was decoded into a backspace control char
    .replace(/\x08([a-zA-Z])/g, '\\b$1');
}

function buildBankResult(cached: AvatarVisualRow, intent: VisualIntent): VisualResultWithBank {
  const base = { _fromBank: true as const, bankId: cached.id, _intentRequestedType: intent.requestedType };

  if (cached.visual_type === 'image' && cached.image_url) {
    const spec = (cached.visual_spec ?? {}) as { imageType?: string };
    return {
      type: 'image_ready',
      imageUrl: cached.image_url,
      imageType: spec.imageType === 'diagram' ? 'diagram' : 'realistic',
      caption: cached.caption ?? '',
      ...base,
    } as unknown as VisualResultWithBank;
  }

  if (cached.visual_type === 'simulation') {
    if (cached.sim_entry_url) {
      return { type: 'simulation', html: '', simulationUrl: cached.sim_entry_url, caption: cached.caption ?? '', ...base } as unknown as VisualResultWithBank;
    }
    const spec = cached.visual_spec as Record<string, unknown> | null;
    if (spec?.html) return { ...spec, ...base } as unknown as VisualResultWithBank;
    return { ...BLANK, ...base };
  }

  if (cached.visual_spec) {
    const spec = cached.visual_spec as Record<string, unknown>;
    if (!spec.type) return { ...BLANK, ...base };
    if (spec.type === 'diagram' && !spec.html) return { ...BLANK, ...base };
    return { ...spec, ...base } as unknown as VisualResultWithBank;
  }
  return { ...BLANK, ...base };
}

export interface AnalyzeVisualOpts {
  projectId?: string | null;
  adminContext?: boolean;
  createdBy?: string | null;
}

export async function analyzeVisual(
  message: string,
  characterId: string,
  context?: string,
  options?: AnalyzeVisualOpts,
): Promise<VisualResultWithBank> {
  const intent = detectVisualIntent(message);
  const projectId = options?.projectId ?? null;

  // Viewer-driven generation honors the platform pause switch (soft-skip: the
  // Library lookups below still work; only fresh generation is disabled).
  const openai = (await isGenerationPaused()) ? null : await getOpenAIClient();
  if (!openai) return { ...BLANK, _intentRequestedType: intent.requestedType } as VisualResultWithBank;

  const topic = extractTopic(message, context);
  const storeKey = (intent.explicit && topic) ? topic.slice(0, 300) : (context ?? message).slice(0, 300);

  // Step 1a: type-first bank lookup for explicit requests
  if (intent.explicit && intent.requestedType) {
    const typedHit = await findVisual({ lookupKey: topic, visualType: intent.requestedType, characterId, projectId }).catch(() => null);
    if (typedHit) {
      const bankResult = buildBankResult(typedHit, intent);
      if (bankResult.type !== 'none') {
        incrementUseCount(typedHit.id).catch(() => {});
        return bankResult;
      }
    }
  }

  // Step 1b: generic bank lookup
  const genericKey = intent.explicit ? topic.slice(0, 300) : (context ?? message).slice(0, 300);
  const cached = await findVisual({ lookupKey: genericKey, characterId, projectId }).catch(() => null);
  if (cached) {
    const hitType = cached.visual_type ?? 'unknown';
    if (isFallbackTypeAllowed(intent.requestedType, hitType)) {
      const bankResult = buildBankResult(cached, intent);
      if (bankResult.type !== 'none') {
        incrementUseCount(cached.id).catch(() => {});
        return bankResult;
      }
    }
  }

  // Step 1c: context-relevance match — prefer existing Library visuals (basic
  // first, then extended) over generating something new, when they fit the topic.
  const relevant = await findRelevantLibraryVisual({
    message,
    context,
    projectId,
    visualType: intent.explicit && intent.requestedType ? intent.requestedType : undefined,
  }).catch(() => null);
  if (relevant) {
    const bankResult = buildBankResult(relevant, intent);
    if (bankResult.type !== 'none') {
      incrementUseCount(relevant.id).catch(() => {});
      logger.info({ id: relevant.id, scope: relevant.scope, type: relevant.visual_type }, '[AvatarVisual] using Library visual (preferred over generation)');
      return bankResult;
    }
  }

  // Step 2: classify
  let classification: Record<string, unknown>;
  try {
    const classifyResp = await openai.chat.completions.create({
      model: MODELS.visualClassify,
      response_format: { type: 'json_object' },
      max_tokens: 600,
      temperature: 0.3,
      messages: [
        { role: 'system', content: CLASSIFY_PROMPT },
        { role: 'user', content: `Character: ${characterId}\nMessage: "${message}"\nContext: ${context ?? 'none'}` },
      ],
    });
    await recordChatUsage({
      userId: options?.createdBy ?? null,
      projectId,
      model: MODELS.visualClassify,
      task: 'avatar_visual_classify',
      usage: classifyResp.usage,
    });
    classification = JSON.parse(classifyResp.choices[0]?.message?.content ?? '{}');
  } catch {
    return { ...BLANK, _intentRequestedType: intent.requestedType } as VisualResultWithBank;
  }

  const rawType = (classification.type as string) || 'none';
  let resolvedType = rawType;
  if (!isFallbackTypeAllowed(intent.requestedType, rawType)) {
    if (intent.requestedType === 'simulation') {
      resolvedType = 'simulation';
      classification.simTopic ??= topic || message.slice(0, 80);
      classification.caption ??= `Interactive simulation: ${topic || message.slice(0, 60)}`;
    } else {
      return { ...BLANK, _intentRequestedType: intent.requestedType } as VisualResultWithBank;
    }
  }
  if (!resolvedType || resolvedType === 'none') {
    return { ...BLANK, _intentRequestedType: intent.requestedType } as VisualResultWithBank;
  }

  // Step 3: simulations — generate HTML
  if (resolvedType === 'simulation') {
    const simTopic = (classification.simTopic as string) ?? (topic || message.slice(0, 100));
    const caption = (classification.caption as string) ?? '';
    try {
      const simResp = await openai.chat.completions.create({
        model: MODELS.simulationCode,
        max_tokens: 6000,
        temperature: 0.4,
        messages: [{ role: 'user', content: buildSimPrompt(simTopic, characterId) }],
      });
      await recordChatUsage({
        userId: options?.createdBy ?? null,
        projectId,
        model: MODELS.simulationCode,
        task: 'avatar_sim_generate',
        usage: simResp.usage,
      });
      const choice = simResp.choices[0];
      if (choice?.finish_reason === 'length') return { ...BLANK, _intentRequestedType: intent.requestedType } as VisualResultWithBank;
      let html = choice?.message?.content ?? '';
      html = html.replace(/^```html?\n?/i, '').replace(/\n?```$/i, '').trim();
      if ((!html.startsWith('<!DOCTYPE') && !html.startsWith('<html')) || !html.includes('</html>')) {
        return { ...BLANK, _intentRequestedType: intent.requestedType } as VisualResultWithBank;
      }
      const result: VisualResult = { type: 'simulation', html, caption };

      // Background: persist to the GLOBAL extended library (project_id = null) so
      // every viewer of every video can reuse it.
      if (!options?.adminContext) {
        isDuplicateVisual(storeKey, 'simulation', characterId, null).then(async (dup) => {
          if (dup) return;
          try {
            const stored = await storeSimulationHtml(html, null);
            await insertVisual({
              projectId: null, scope: 'extended', source: 'generated', characterId,
              visualType: 'simulation', lookupKey: storeKey, caption,
              simStoragePrefix: stored.prefix, simEntryUrl: stored.url,
              visualSpec: { type: 'simulation', caption, simTopic },
            });
          } catch (err) { logger.warn({ err }, '[AvatarVisual] sim store failed'); }
        }).catch(() => {});
      }
      return { ...result, _intentRequestedType: intent.requestedType } as VisualResultWithBank;
    } catch (err) {
      logger.warn({ err: (err as Error).message }, '[AvatarVisual] simulation generation failed');
      return { ...BLANK, _intentRequestedType: intent.requestedType } as VisualResultWithBank;
    }
  }

  // Step 4: fast-render visuals
  if (resolvedType === 'equation') {
    const latex = repairLatexBackslashes((classification.latex as string) ?? '');
    if (!latex) return { ...BLANK, _intentRequestedType: intent.requestedType } as VisualResultWithBank;
    const result: VisualResult = { type: 'equation', latex, caption: (classification.caption as string) ?? '' };
    storeFast(latex, 'equation', characterId, result.caption, result);
    return { ...result, _intentRequestedType: intent.requestedType } as VisualResultWithBank;
  }

  if (resolvedType === 'chart') {
    const result: VisualResult = {
      type: 'chart',
      chartType: (classification.chartType as 'bar' | 'line' | 'pie') ?? 'bar',
      title: (classification.title as string) ?? '',
      labels: (classification.labels as string[]) ?? [],
      datasets: (classification.datasets as ChartDataset[]) ?? [],
      caption: (classification.caption as string) ?? '',
    };
    if (!result.labels.length) return { ...BLANK, _intentRequestedType: intent.requestedType } as VisualResultWithBank;
    storeFast(`${result.title} ${result.labels.join(' ')}`, 'chart', characterId, result.caption, result);
    return { ...result, _intentRequestedType: intent.requestedType } as VisualResultWithBank;
  }

  if (resolvedType === 'diagram') {
    const mermaidCode = ((classification.mermaidCode as string) ?? '').trim();
    if (!mermaidCode) return { ...BLANK, _intentRequestedType: intent.requestedType } as VisualResultWithBank;
    const caption = (classification.caption as string) ?? '';
    const result: VisualResult = { type: 'diagram', html: buildMermaidHtml(mermaidCode), caption };
    storeFast(`${mermaidCode.slice(0, 200)} ${caption.slice(0, 100)}`, 'diagram', characterId, caption, result);
    return { ...result, _intentRequestedType: intent.requestedType } as VisualResultWithBank;
  }

  if (resolvedType === 'image') {
    return {
      type: 'image',
      dallePrompt: (classification.dallePrompt as string) ?? '',
      imageType: (classification.imageType as 'realistic' | 'diagram') ?? 'realistic',
      caption: (classification.caption as string) ?? '',
      _intentRequestedType: intent.requestedType,
    } as unknown as VisualResultWithBank;
  }

  return { ...BLANK, _intentRequestedType: intent.requestedType } as VisualResultWithBank;
}

// Dedup + store a fast-render visual to the GLOBAL extended library (project_id =
// null) so it is reusable across every viewer and video. Fire-and-forget.
function storeFast(
  key: string, type: string, characterId: string,
  caption: string, result: VisualResult,
): void {
  isDuplicateVisual(key, type, characterId, null).then((dup) => {
    if (dup) return;
    insertVisual({
      projectId: null, scope: 'extended', source: 'generated', characterId,
      visualType: type, lookupKey: key,
      caption, altText: caption.split('.')[0] ?? '',
      visualSpec: result as unknown as Record<string, unknown>,
    }).catch(() => {});
  }).catch(() => {});
}

// Generate a standalone simulation and save it to the library (editor/admin Create).
export async function generateLibrarySimulation(params: {
  prompt: string;
  characterId: string;
  caption?: string;
  projectId?: string | null;
  createdBy?: string | null;
  scope?: 'basic' | 'extended';
}): Promise<{ row: AvatarVisualRow; simulationUrl: string } | null> {
  const openai = await getOpenAIClient();
  if (!openai) throw new Error('OpenAI API key is not configured');
  const topic = params.prompt.trim();
  const caption = (params.caption || topic).trim();
  const simResp = await openai.chat.completions.create({
    model: MODELS.simulationCode,
    max_tokens: 9000,
    temperature: 0.5,
    messages: [{ role: 'user', content: buildSimPrompt(topic, params.characterId) }],
  });
  await recordChatUsage({
    userId: params.createdBy ?? null,
    projectId: params.projectId ?? null,
    model: MODELS.simulationCode,
    task: 'avatar_sim_generate',
    usage: simResp.usage,
  });
  let html = simResp.choices[0]?.message?.content ?? '';
  html = html.replace(/^```html?\n?/i, '').replace(/\n?```$/i, '').trim();
  if ((!html.startsWith('<!DOCTYPE') && !html.startsWith('<html')) || !html.includes('</html>')) {
    throw new Error('Model returned invalid simulation HTML — try again');
  }
  // Library-generated sims are scoped to the project that created them (each project has its
  // own Extended Library) — was global, which leaked visuals across projects.
  const stored = await storeSimulationHtml(html, null);
  const row = await insertVisual({
    projectId: params.projectId ?? null, scope: 'extended', source: 'generated',
    characterId: params.characterId, visualType: 'simulation', lookupKey: caption, caption,
    simStoragePrefix: stored.prefix, simEntryUrl: stored.url,
    visualSpec: { type: 'simulation', caption, simTopic: topic }, createdBy: params.createdBy,
  });
  if (!row) throw new Error('Failed to save simulation to library');
  return { row, simulationUrl: stored.url };
}

// AI-refine an existing single-file simulation in the Library and overwrite it
// in place. Ported from darwin's POST /api/admin/simulation/edit.
export async function editLibrarySimulation(visualId: string, instructions: string): Promise<{ simulationUrl: string }> {
  const openai = await getOpenAIClient();
  if (!openai) throw new Error('OpenAI API key is not configured');
  const row = await getVisual(visualId);
  if (!row || row.visual_type !== 'simulation' || !row.sim_storage_prefix) {
    throw new Error('Editable single-file simulation not found');
  }
  const storage = getStorageAdapter();
  const key = `${row.sim_storage_prefix}/index.html`;
  const html = (await storage.readObject(key)).toString('utf-8');

  const resp = await openai.chat.completions.create({
    model: MODELS.simulationEdit,
    max_tokens: 16000,
    temperature: 0.3,
    messages: [
      { role: 'system', content: 'You are an expert HTML/JavaScript simulation developer. Return ONLY raw HTML — no markdown fences, no explanation. The response must start immediately with <!DOCTYPE html>. Fix any crash-causing bugs you notice (e.g. ctx.arc() with negative radius → guard with Math.max(0, r), NaN values, divide-by-zero). Keep the SIM_READY postMessage and stopScript listener. Never truncate.' },
      { role: 'user', content: `EXISTING SIMULATION HTML:\n${html.slice(0, 25000)}\n\nMODIFICATION INSTRUCTIONS:\n${instructions}\n\nGenerate the complete improved HTML. Keep all existing features unless explicitly asked to remove them. Maintain a dark or clean background, the SIM_READY postMessage, and the stopScript listener.` },
    ],
  });
  await recordChatUsage({
    userId: null,
    projectId: row.project_id ?? null,
    model: MODELS.simulationEdit,
    task: 'avatar_sim_edit',
    usage: resp.usage,
  });
  let newHtml = resp.choices[0]?.message?.content ?? '';
  newHtml = newHtml.replace(/^```html?\n?/i, '').replace(/\n?```\s*$/i, '').trim();
  const startIdx = newHtml.search(/<!DOCTYPE\s+html/i) !== -1 ? newHtml.search(/<!DOCTYPE\s+html/i) : newHtml.search(/<html[\s>]/i);
  if (startIdx > 0) newHtml = newHtml.slice(startIdx);
  if (!newHtml.startsWith('<!DOCTYPE') && !newHtml.toLowerCase().startsWith('<html')) {
    throw new Error('Model returned invalid HTML — try again');
  }
  await storage.uploadFile(key, Buffer.from(newHtml, 'utf-8'), 'text/html; charset=utf-8');
  return { simulationUrl: row.sim_entry_url ?? storage.getSimPublicUrl(key) };
}
