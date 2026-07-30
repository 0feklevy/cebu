// ── Minimal-UI control picker: shared contract + helpers ──────────────────────
// Mirrors md-files/sim-ui-controls-plan.md ("Shared contract"). The backend half
// (scanner endpoint, stream ui_controls param, sim_meta.uiControls persistence,
// wrap hideSelectors, gate v2 listSimControls) is built against the SAME shapes —
// keep these types in lockstep with the plan, not with current backend behavior.

export type SimUiControlKind = 'button' | 'slider' | 'toggle' | 'select' | 'input' | 'other';

export interface SimUiControl {
  selector: string;
  kind: SimUiControlKind;
  label: string;
  /** Scan METADATA (runtime gate v3): the control exists but is display:none until the
   *  sim's own menus are opened (e.g. an "Advanced Mode" disclosure). Used only to group
   *  picker rows; IGNORED by selectionsEqual — hidden-flag drift must never count as a
   *  selection change. Absent/false = visible (absent preferred — saves payload bytes). */
  hidden?: boolean;
}

/** Persisted server-side in sim_meta.uiControls; sent to generation as ?ui_controls=<JSON>. */
export interface SimUiSelection {
  controls: SimUiControl[];
  show: string[];   // selectors that STAY VISIBLE in Minimal UI
  hide: string[];   // selectors hidden mechanically (wrap template hideSelectors)
}

/**
 * startScript runtime params (parent → sim bridge). `hideSelectors` is applied by the
 * wrap template while `simpleUi` is on; old bridges ignore it harmlessly.
 */
export interface SimStartScriptParams {
  simpleUi: boolean;
  autoScript: boolean;
  hideSelectors?: string[];
}

/** Detection cap shared with the backend scanner (plan: "Cap 100"). */
export const MAX_UI_CONTROLS = 100;
/** Caps mirrored from the backend (SimUiControls.ts) — enforced client-side too, so an
 *  oversized payload surfaces as a clear inline error instead of a pre-SSE HTTP 400
 *  that EventSource can only report as a generic connection failure. */
export const SIM_UI_SELECTOR_MAX_CHARS = 300;
export const SIM_UI_LABEL_MAX_CHARS = 200;
export const SIM_UI_CONTROLS_PARAM_MAX_CHARS = 8192;

/** Selectors containing { } < or backslash are rejected across the whole pipeline
 *  (scanners, backend schema, wrap templates) — no style/markup breakouts. `>` stays
 *  allowed: the runtime scanner emits child-combinator paths (`#panel > button:…`) and
 *  a bare combinator cannot escape the selector position of a style rule. */
const UNSAFE_SELECTOR_RE = /[{}<\\]/;

const KINDS: readonly string[] = ['button', 'slider', 'toggle', 'select', 'input', 'other'];

/**
 * Validate an untrusted controls payload (runtime `simControlsList` postMessage or the
 * static ui-controls endpoint) into a clean, deduped SimUiControl[]. Returns null when
 * the payload is not a list or yields no usable controls.
 */
export function sanitizeControls(raw: unknown): SimUiControl[] | null {
  if (!Array.isArray(raw)) return null;
  const out: SimUiControl[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (out.length >= MAX_UI_CONTROLS) break;
    if (!item || typeof item !== 'object') continue;
    const { selector, kind, label, hidden } =
      item as { selector?: unknown; kind?: unknown; label?: unknown; hidden?: unknown };
    if (typeof selector !== 'string' || !selector.trim()) continue;
    const sel = selector.trim();
    // Backend caps: a selector over 300 chars would fail SimUiSelectionSchema, and
    // { } < > \ selectors are dropped by the wrap templates anyway — never emit either.
    if (sel.length > SIM_UI_SELECTOR_MAX_CHARS || UNSAFE_SELECTOR_RE.test(sel)) continue;
    if (seen.has(sel)) continue;
    seen.add(sel);
    const rawLabel = typeof label === 'string' && label.trim() ? label.trim() : sel;
    const clean: SimUiControl = {
      selector: sel,
      kind: typeof kind === 'string' && KINDS.includes(kind) ? (kind as SimUiControlKind) : 'other',
      label: rawLabel.slice(0, SIM_UI_LABEL_MAX_CHARS),
    };
    // Truthy → true; false/absent → key OMITTED (canonical "visible", keeps payloads lean).
    if (hidden) clean.hidden = true;
    out.push(clean);
  }
  return out.length > 0 ? out : null;
}

/**
 * Build the normalized selection sent to generation and persisted in sim_meta.uiControls.
 * show = checked selectors, hide = unchecked selectors — both sorted; controls deduped by
 * selector. Selectors in checkedSelectors that are not in `controls` are ignored (stale
 * picks from a previous scan must not leak into the contract).
 */
export function normalizeSelection(controls: SimUiControl[], checkedSelectors: Set<string>): SimUiSelection {
  const deduped: SimUiControl[] = [];
  const seen = new Set<string>();
  for (const c of controls) {
    if (seen.has(c.selector)) continue;
    seen.add(c.selector);
    deduped.push(c);
  }
  const show: string[] = [];
  const hide: string[] = [];
  for (const c of deduped) {
    (checkedSelectors.has(c.selector) ? show : hide).push(c.selector);
  }
  show.sort();
  hide.sort();
  return { controls: deduped, show, hide };
}

function eqSorted(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

/**
 * Normalized deep-equality of two selections; absent == absent. Compares the semantic
 * selection (sorted show + hide selector sets) — control labels/order/kinds and the
 * `hidden` scan-metadata flag may drift between scans of the same sim and must not
 * count as a change.
 */
export function selectionsEqual(a?: SimUiSelection | null, b?: SimUiSelection | null): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return eqSorted(a.show, b.show) && eqSorted(a.hide, b.hide);
}

/**
 * Merge a static (HTML-parse) scan with a runtime (live DOM) scan.
 * Runtime wins on selector collision (so its `hidden` flag survives — the static scan
 * cannot know visibility); otherwise union, runtime order first.
 */
export function mergeScans(
  staticControls: SimUiControl[] | null | undefined,
  runtimeControls: SimUiControl[] | null | undefined,
): SimUiControl[] {
  const out: SimUiControl[] = [];
  const seen = new Set<string>();
  for (const c of runtimeControls ?? []) {
    if (seen.has(c.selector)) continue;
    seen.add(c.selector);
    out.push(c);
  }
  for (const c of staticControls ?? []) {
    if (seen.has(c.selector)) continue;
    seen.add(c.selector);
    out.push(c);
  }
  return out.slice(0, MAX_UI_CONTROLS);
}

const KIND_LABELS: Record<SimUiControlKind, string> = {
  button: 'Button',
  slider: 'Slider',
  toggle: 'Toggle',
  select: 'Select',
  input:  'Input',
  other:  'Other',
};

/** Human label for the kind chip in the Advanced picker UI. */
export function kindLabel(kind: SimUiControlKind): string {
  return KIND_LABELS[kind] ?? 'Other';
}

/**
 * Safely read a stored selection out of a section's sim_meta (jsonb — uiControls is not
 * declared on the generated SimMeta type yet; the backend persists it at generation time).
 * Returns null when absent or malformed.
 */
export function getStoredSelection(simMeta: unknown): SimUiSelection | null {
  if (!simMeta || typeof simMeta !== 'object') return null;
  const raw = (simMeta as { uiControls?: unknown }).uiControls;
  if (!raw || typeof raw !== 'object') return null;
  const { controls, show, hide } = raw as { controls?: unknown; show?: unknown; hide?: unknown };
  const strArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.length > 0) : [];
  const selection: SimUiSelection = {
    controls: sanitizeControls(controls) ?? [],
    show: strArr(show),
    hide: strArr(hide),
  };
  if (selection.controls.length === 0 && selection.show.length === 0 && selection.hide.length === 0) return null;
  return selection;
}
