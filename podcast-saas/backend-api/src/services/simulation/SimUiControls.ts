/**
 * Minimal-UI control picker — shared contract + static control scanner.
 *
 * Two detection layers (no AI — see md-files/sim-ui-controls-plan.md):
 *   1. STATIC (this module): parse the stored entry HTML for interactive controls.
 *      Served by GET /projects/:id/simulations/:simId/ui-controls.
 *   2. RUNTIME (exact): the head rAF-gate v2 answers {type:'listSimControls'} by scanning
 *      the LIVE DOM (SimulationService RAF_GATE_TEMPLATE). The editor prefers the runtime
 *      scan when its preview iframe is live and falls back to this static scan.
 *
 * The user's selection (SimUiSelection) is persisted in sim_meta.uiControls at generation
 * time; hiding is applied MECHANICALLY by the wrap templates via params.hideSelectors —
 * never by LLM-written code.
 *
 * Keep the kind/label derivation here in sync with the runtime scanner inside
 * RAF_GATE_TEMPLATE (it must stay self-contained, so the tiny logic is duplicated there).
 * Selector strategies deliberately DIFFER: both emit #id / [name="…"] first, but only the
 * runtime scanner may fall back to structural (child-combinator nth-of-type) paths — it
 * sees the live DOM; this static regex scan cannot build a reliable structural path and
 * emits unambiguous selectors only.
 */
import { z } from 'zod';

// ── Shared contract ───────────────────────────────────────────────────────────

export type SimUiControlKind = 'button' | 'slider' | 'toggle' | 'select' | 'input' | 'other';

export interface SimUiControl {
  selector: string;
  kind:     SimUiControlKind;
  label:    string;
  /** Scan METADATA (runtime scanner, gate v3): the control exists but is display:none until
   *  the sim's own menus are opened (e.g. an "Advanced Mode" disclosure). Persisted so the
   *  picker can group such rows; IGNORED by selection equality — a drifting hidden flag must
   *  never bust canReuse. Absent/false = visible. */
  hidden?:  boolean;
}

/** The user's Minimal-UI selection: the scanned control list plus which selectors stay
 *  visible (`show`) vs are hidden mechanically (`hide`) while simpleUi is on. */
export interface SimUiSelection {
  controls: SimUiControl[];
  show:     string[];
  hide:     string[];
}

export const SIM_UI_CONTROLS_MAX             = 100;
export const SIM_UI_SELECTOR_MAX_CHARS       = 300;
export const SIM_UI_LABEL_MAX_CHARS          = 200;
export const SIM_UI_CONTROLS_PARAM_MAX_CHARS = 8192;

/** Selectors containing { } < or backslash could break out of the __simHideUi style
 *  rules the wrap templates build ({ } escape the rule block, < can close the style
 *  element on re-parse, backslash smuggles CSS escapes). The templates drop such
 *  selectors at apply time; the scanners never emit them; and this schema rejects them
 *  at the API boundary so they can never persist into sim_meta either. Keep all four
 *  sites in sync (FE sanitizeControls, both scanners, wrap templates, this schema).
 *  `>` is deliberately ALLOWED: the runtime scanner emits unambiguous child-combinator
 *  paths (`#panel > button:nth-of-type(1)`) and a combinator cannot escape the selector
 *  position of a CSS rule. */
export const SIM_UI_UNSAFE_SELECTOR_RE = /[{}<\\]/;

const SelectorSchema = z.string().min(1).max(SIM_UI_SELECTOR_MAX_CHARS)
  .refine(s => !SIM_UI_UNSAFE_SELECTOR_RE.test(s), { message: 'selector contains forbidden characters ({ } < or backslash)' });

export const SimUiControlSchema = z.object({
  selector: SelectorSchema,
  kind:     z.enum(['button', 'slider', 'toggle', 'select', 'input', 'other']),
  label:    z.string().max(SIM_UI_LABEL_MAX_CHARS),
  // Scan metadata (see SimUiControl.hidden). Optional — adds a few bytes per hidden control
  // inside the ≤8 KB ui_controls param, which the budget comfortably absorbs.
  hidden:   z.boolean().optional(),
});

export const SimUiSelectionSchema = z.object({
  controls: z.array(SimUiControlSchema).max(SIM_UI_CONTROLS_MAX),
  show:     z.array(SelectorSchema).max(SIM_UI_CONTROLS_MAX),
  hide:     z.array(SelectorSchema).max(SIM_UI_CONTROLS_MAX),
});

// ── Normalization + equality (canReuse) ───────────────────────────────────────

/** Deterministic form for persistence and comparison: show/hide sorted, control objects
 *  rebuilt with a fixed key order (`hidden` kept only when true — false/absent both mean
 *  visible and are normalized to the key being ABSENT). Selectors are deliberately NOT
 *  filtered against `controls` — the client owns coherence; an unknown selector is a
 *  harmless no-op CSS rule at runtime. */
export function normalizeSimUiSelection(sel: SimUiSelection): SimUiSelection {
  return {
    controls: sel.controls.map(c => {
      const out: SimUiControl = { selector: c.selector, kind: c.kind, label: c.label };
      if (c.hidden === true) out.hidden = true;
      return out;
    }),
    show:     [...sel.show].sort(),
    hide:     [...sel.hide].sort(),
  };
}

function sortedSelectorsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

/** Selection equality for canReuse: both-absent = equal; a presence mismatch (selection
 *  added or removed) is NOT equal, so the bridge regenerates. Compares ONLY the sorted
 *  show + hide selector sets — the semantic selection, matching the FE contract
 *  (client selectionsEqual). `controls` is scan metadata: labels/kinds/order — and the
 *  v3 `hidden` flag — drift between scans of the same sim and must NOT force a spurious
 *  regeneration. The controls array is still persisted alongside the selection (for
 *  restore + the prompt block). */
export function simUiSelectionsEqual(
  a: SimUiSelection | undefined,
  b: SimUiSelection | undefined,
): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return sortedSelectorsEqual(a.show, b.show) && sortedSelectorsEqual(a.hide, b.hide);
}

/** Safe read of sim_meta.uiControls (jsonb, untyped): normalized selection or undefined
 *  when absent/malformed — malformed stored data must never wedge canReuse. */
export function readStoredUiControls(value: unknown): SimUiSelection | undefined {
  if (value == null) return undefined;
  const parsed = SimUiSelectionSchema.safeParse(value);
  return parsed.success ? normalizeSimUiSelection(parsed.data) : undefined;
}

// ── Generation prompt block ───────────────────────────────────────────────────

/** ONE compact, token-cheap block appended to the generation user prompt when a selection
 *  with show/hide entries exists. No selection ⇒ '' (zero prompt overhead).
 *
 *  Deliberately LEAN (owner direction 2026-07-30, "reduce tokens to the ai"): only the
 *  KEEP-VISIBLE controls are listed (label + kind + selector — the few controls a
 *  minimal UI keeps). Hidden controls are summarized as a COUNT, never itemized: their
 *  selectors already live in the source files in the system prompt, and hiding is
 *  mechanical (params.hideSelectors) — repeating up to 100 structural selectors here
 *  only burned prompt tokens. */
export function buildUiControlsPromptBlock(sel: SimUiSelection | undefined): string {
  if (!sel || (sel.show.length === 0 && sel.hide.length === 0)) return '';
  const bySelector = new Map(sel.controls.map(c => [c.selector, c]));
  const lines: string[] = ['MINIMAL-UI CONTRACT (user-selected, authoritative):'];
  if (sel.show.length > 0) {
    lines.push('KEEP VISIBLE (the only controls the user sees while simpleUi is on):');
    for (const s of sel.show) {
      const c = bySelector.get(s);
      lines.push(`- ${c?.label ?? s} (${c?.kind ?? 'other'}) \`${s}\``);
    }
    lines.push(
      `All ${sel.hide.length} other scanned control(s) are hidden mechanically at runtime via ` +
      'params.hideSelectors — do NOT write code that hides or shows any controls; never hide ' +
      'the KEEP-VISIBLE controls; avoid showcasing hidden controls in the demo (prefer the ' +
      "sim's functions/APIs when their behavior is needed); when simpleUi is off all controls " +
      'stay untouched.',
    );
  } else {
    lines.push(
      `ALL ${sel.hide.length} scanned UI control(s) are hidden mechanically at runtime while ` +
      'simpleUi is on — the user wants a chrome-free view. Do NOT write code that hides or ' +
      "shows any controls; drive the simulation through its functions/APIs instead of its UI " +
      'where possible; when simpleUi is off all controls stay untouched.',
    );
  }
  return lines.join('\n');
}

// ── Static scanner ────────────────────────────────────────────────────────────

// System-injected blocks must never contribute controls. These are LOCAL copies of the
// strip patterns — keep in sync with SimulationService (RAF_GATE_BLOCK_RE, the inline-bridge
// cleanup regexes, and the SIM_BRIDGE/SIM_GUIDANCE script-tag markers). A static import of
// stripRafGate would make SimulationService⇄SimUiControls circular (SimulationService imports
// the prompt-block builder from here) — the codebase avoids static service cycles (see the
// lazy GuidanceService import in SimulationService.processReplace).
const INJECTED_BLOCK_RES: RegExp[] = [
  /\n?<!-- sim-raf-gate v\d+ -->[\s\S]*?<!-- \/sim-raf-gate -->/g,
  /<!-- SIM_BRIDGE_SCRIPT_START -->[\s\S]*?<!-- SIM_BRIDGE_SCRIPT_END -->/g,
  /<!-- SIM_GUIDANCE_SCRIPT_START -->[\s\S]*?<!-- SIM_GUIDANCE_SCRIPT_END -->/g,
  /<script[^>]*>\s*\/\* sim-bridge[\s\S]*?<\/script>/gi,
  /<script[^>]*>\s*;?\s*\(function[\s\S]*?sim-bridge v[12][\s\S]*?<\/script>/gi,
];

/** Read one attribute from a raw attribute string — robust to attribute order and
 *  double-/single-/un-quoted values. */
function attrValue(attrs: string, name: string): string | undefined {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
  const m = re.exec(attrs);
  const v = m ? (m[1] ?? m[2] ?? m[3]) : undefined;
  const trimmed = v?.trim();
  return trimmed ? trimmed : undefined;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripInnerTags(s: string): string {
  return s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Prettify an id/name into words: dashes/underscores/camelCase → Title Case. */
export function prettifyIdentifier(raw: string): string {
  return raw
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/(^|\s)\S/g, c => c.toUpperCase());
}

/** Kind mapping — mirrored inline in the rAF-gate runtime scanner. */
function kindFor(tag: string, type: string | undefined, role: string | undefined): SimUiControlKind {
  const t = (type ?? '').toLowerCase();
  const r = (role ?? '').toLowerCase();
  if (tag === 'input') {
    if (t === 'range') return 'slider';
    if (t === 'checkbox' || t === 'radio') return 'toggle';
    if (t === 'button' || t === 'submit' || t === 'reset') return 'button';
  }
  if (r === 'slider') return 'slider';
  if (r === 'switch') return 'toggle';
  if (tag === 'button' || r === 'button' || tag === 'a') return 'button';
  if (tag === 'select') return 'select';
  if (tag === 'input' || tag === 'textarea') return 'input';
  return 'other';
}

const CANDIDATE_TAGS = new Set(['button', 'input', 'select', 'textarea']);
// <a> counts as a button only when it is styled as one (btn/button class token).
const BUTTONISH_CLASS_RE = /(?:^|[\s_-])(?:btn|button)(?:$|[\s_-])/i;

/**
 * Dependency-free static scan of an entry HTML for interactive controls.
 *
 * Extracted: <button>, <input> (all types except hidden), <select>, <textarea>,
 * elements with role="button"|"slider"|"switch", and <a> with a button-ish class.
 * Label preference: aria-label → <label for> → wrapping <label> text (the label's own
 * words minus embedded controls — covers `<label><input type=checkbox> Own wings</label>`)
 * → text content (buttons) → title → placeholder → name → id (prettified).
 *
 * Selectors: ONLY unambiguous ones — #id or [name="…"]. Regex parsing cannot see the
 * real DOM tree, so a static structural path (nth-of-type) can collapse distinct
 * sibling controls into one row or match nothing at all; unnamed controls are therefore
 * DROPPED here — the runtime scan (rAF-gate v2, which walks the live DOM and emits
 * unambiguous child-combinator paths) covers them. Selectors containing { } < or
 * backslash are dropped too (SIM_UI_UNSAFE_SELECTOR_RE — wrap templates reject them).
 * Deduped by selector, capped at SIM_UI_CONTROLS_MAX. System-injected gate/bridge
 * blocks — and all other scripts/styles/comments — are stripped first so injected
 * system code and JS template strings can never contribute phantom controls.
 */
export function scanSimUiControls(html: string): SimUiControl[] {
  let src = html;
  for (const re of INJECTED_BLOCK_RES) src = src.replace(re, '');
  src = src
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  const controls: SimUiControl[] = [];
  const seen = new Set<string>();

  // Wrapped-label pass: `<label …>TEXT…<input …>…</label>` (text before OR after the
  // control) labels the FIRST #id/[name] control inside the label. The label's own text is
  // what remains after removing embedded control markup — mirrors the runtime ladder's
  // closest('label')-minus-own-subtree rung. First label wins per selector.
  const wrappedLabels = new Map<string, string>();
  {
    const labelBlockRe = /<label\b(?:"[^"]*"|'[^']*'|[^"'>])*>([\s\S]*?)<\/label\s*>/gi;
    const innerCtrlRe = /<(input|select|textarea|button)\b((?:"[^"]*"|'[^']*'|[^"'>])*)>/i;
    let lb: RegExpExecArray | null;
    while ((lb = labelBlockRe.exec(src)) !== null) {
      const inner = lb[1];
      const cm = innerCtrlRe.exec(inner);
      if (!cm) continue;
      const cid   = attrValue(cm[2] ?? '', 'id');
      const cname = attrValue(cm[2] ?? '', 'name');
      const sel = cid ? `#${cid}` : cname ? `[name="${cname}"]` : null;
      if (!sel || wrappedLabels.has(sel)) continue;
      const text = stripInnerTags(
        inner
          // Content-bearing controls go entirely (a <select>'s options are not label text)…
          .replace(/<(select|button|textarea)\b[\s\S]*?<\/\1\s*>/gi, ' ')
          // …void <input> tags too, so only the label's own words remain.
          .replace(/<input\b(?:"[^"]*"|'[^']*'|[^"'>])*>/gi, ' '),
      ).replace(/\s*:$/, '').trim();
      if (text) wrappedLabels.set(sel, text);
    }
  }

  const openTagRe = /<([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^"'>])*)>/g;
  let m: RegExpExecArray | null;
  while ((m = openTagRe.exec(src)) !== null && controls.length < SIM_UI_CONTROLS_MAX) {
    const tag = m[1].toLowerCase();
    const attrs = m[2] ?? '';

    const role = attrValue(attrs, 'role')?.toLowerCase();
    const type = attrValue(attrs, 'type')?.toLowerCase();
    const cls  = attrValue(attrs, 'class');

    const isCandidate =
      CANDIDATE_TAGS.has(tag) ||
      role === 'button' || role === 'slider' || role === 'switch' ||
      (tag === 'a' && !!cls && BUTTONISH_CLASS_RE.test(cls));
    if (!isCandidate) continue;
    if (tag === 'input' && type === 'hidden') continue;

    const id   = attrValue(attrs, 'id');
    const name = attrValue(attrs, 'name');
    // Unambiguous selectors only — unnamed controls are the runtime scanner's job.
    const selector = id ? `#${id}` : name ? `[name="${name}"]` : null;
    if (!selector) continue;
    if (selector.length > SIM_UI_SELECTOR_MAX_CHARS || SIM_UI_UNSAFE_SELECTOR_RE.test(selector)) continue;
    if (seen.has(selector)) continue;

    const kind = kindFor(tag, type, role);

    let label = attrValue(attrs, 'aria-label');
    if (!label && id) {
      const labelRe = new RegExp(
        `<label\\b[^>]*\\bfor\\s*=\\s*["']?${escapeRegExp(id)}["']?[^>]*>([\\s\\S]*?)</label>`, 'i',
      );
      const text = stripInnerTags(labelRe.exec(src)?.[1] ?? '');
      if (text) label = text;
    }
    if (!label) label = wrappedLabels.get(selector);   // wrapping <label>…<input…>…</label>
    if (!label && kind === 'button' && tag !== 'input') {
      // Element text content — buttons only (a <select>'s text would be all its options).
      const closeRe = new RegExp(`</${tag}\\s*>`, 'ig');
      closeRe.lastIndex = openTagRe.lastIndex;
      const closeM = closeRe.exec(src);
      if (closeM) {
        const text = stripInnerTags(src.slice(openTagRe.lastIndex, closeM.index));
        if (text) label = text;
      }
    }
    if (!label) label = attrValue(attrs, 'title');
    if (!label) label = attrValue(attrs, 'placeholder');
    if (!label && name) label = prettifyIdentifier(name);
    if (!label && id)   label = prettifyIdentifier(id);
    if (!label)         label = prettifyIdentifier(tag);

    seen.add(selector);
    controls.push({ selector, kind, label: label.slice(0, SIM_UI_LABEL_MAX_CHARS) });
  }

  return controls;
}
