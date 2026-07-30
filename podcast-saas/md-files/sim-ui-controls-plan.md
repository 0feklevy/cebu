# Minimal-UI Control Picker — Plan

**Goal:** when generating an AI sim section with Minimal UI, let the user see exactly which
controls the sim has (detected automatically, **no AI**), pick what stays visible vs hidden
behind an **Advanced** disclosure under the Prompt, and feed that selection to generation as
a precise, token-cheap contract — with hiding done **mechanically** (not by the LLM).

## Shared contract

```ts
type SimUiControlKind = 'button' | 'slider' | 'toggle' | 'select' | 'input' | 'other';
interface SimUiControl   { selector: string; kind: SimUiControlKind; label: string }
interface SimUiSelection { controls: SimUiControl[]; show: string[]; hide: string[] }  // selectors
```

- Persisted server-side in `sim_meta.uiControls` (jsonb — no migration) at generation time.
- postMessage: parent→sim `{type:'listSimControls'}`; sim→parent `{type:'simControlsList', controls}`.
- Runtime param: `startScript.params.hideSelectors?: string[]` — applied by the **wrap template**
  (a `<style id="__simHideUi">` with `display:none !important` rules while `simpleUi` is on;
  removed on stopScript). Old bridges ignore the param harmlessly.
- Player config: each `segments[].simulations[]` entry gains `ui_hide?: string[]`
  (from `sim_meta.uiControls.hide`).

## Detection (two layers, no AI)

1. **Static (always available):** `GET /projects/:id/simulations/:simId/ui-controls` — parses the
   stored entry HTML for `button/input/select/[role=button|slider|switch]`, labels from
   aria-label / `<label for>` / text / title / placeholder / name / id; stable selectors
   (#id → [name] → nth-of-type path). Cap 100.
2. **Runtime (exact, catches JS-built panels):** the injected rAF-gate template (bump to
   `sim-raf-gate v2`) answers `listSimControls` by scanning the live DOM for visible interactive
   elements. The existing `sims:reinject-gates` ops script retrofits uploaded sims.
   The editor prefers runtime scan when its preview iframe is live; falls back to static.

## Generation integration (token-smart)

- Stream endpoint accepts `ui_controls=<JSON>` (zod-validated, ≤8 KB). When present:
  - Persist to `sim_meta.uiControls`; **canReuse** additionally compares the normalized
    selection (both-absent = equal) so a changed selection regenerates.
  - Prompt gains ONE compact block: KEEP-VISIBLE list + HIDE list with a note that hiding is
    mechanical (`hideSelectors`) — the LLM must not write hide-code nor touch the KEEP list.
  - No selection ⇒ zero prompt overhead (current behavior untouched).
- planVersion 6 → 7 (traceability; canReuse governed by `supportsRuntimeParams`, unaffected).

## Editor UX (SectionEditor, under the Prompt)

- Subtle `Advanced · UI controls` chevron button. Expanded panel: scan source note + Rescan,
  rows of `[checkbox] [kind chip] label` (checked = stays visible in Minimal UI), All/None,
  hint "Applies on Generate". Untouched panel ⇒ "let the AI decide" (no param sent).
- Restores from `sim_meta.uiControls` on open; live-previews hides by sending current
  `hideSelectors` to the preview iframe.

## Split

- **Backend agent:** scanner service + endpoint + stream param + prompt block + canReuse +
  sim_meta persist + wrap `hideSelectors` + gate v2 `listSimControls` + buildPlayerConfig
  `ui_hide` + tests.
- **Frontend agent:** SectionEditor Advanced panel + runtime/static scan plumbing +
  generate-call param + preview passthrough + viewer/editor `hideSelectors` param sites + types.
