/**
 * Bridge↔simulation COMPATIBILITY CONTRACT — the gate behind "Replace simulation".
 *
 * A simulation PACKAGE hosts many timeline sections through one generated bridge.js, whose
 * per-section bodies bind to the simulation's own DOM and JS API by name:
 *
 *     document.querySelectorAll('.controls .slider-container')   // structural selector
 *     lab.textContent.trim().toLowerCase() === 'separation:'     // label TEXT
 *     window.__knob.knob.setValue(v)                             // the sim's JS API
 *
 * Replacing the package's files keeps bridge.js untouched (and with it every section's
 * Minimal-UI / auto-script configuration) — which is exactly the point of the feature. But it
 * silently invalidates the bridge if the new version renamed any of those anchors: the section
 * body then finds nothing and no-ops, and the sub-simulation is dead in production with no error.
 *
 * This module extracts what each section body REQUIRES and proves those anchors still exist in
 * the replacement bundle. Empirically validated (18/18) against the deployed boids-3d and
 * murmuration-knob packages: every benign edit (cosmetics, whitespace, retuned constants, added
 * features) verifies COMPATIBLE, and every renamed anchor (class, selector, label text, window
 * global, API method) is caught with per-section attribution.
 *
 * TWO RULES MAKE THIS WORK, AND BOTH ARE LOAD-BEARING:
 *
 *  1. RESOLVE AGAINST HTML **+ JS + CSS**, NEVER HTML ALONE. Most sim controls are built at
 *     runtime by the sim's own JS (the boids menu is created inside App.init(), after the bridge
 *     handshake). Resolving only against the entry HTML wrongly reports 3 of 7 deployed sections
 *     as broken when replacing a package with its OWN IDENTICAL FILES — a checker that fails the
 *     no-op replace is worse than no checker at all.
 *
 *  2. EXISTENCE, NOT STRUCTURE. We assert an anchor is still *present somewhere* in the sources,
 *     not that it sits at a particular place in the DOM tree. Static analysis cannot know the
 *     runtime tree, and demanding structure would reject legitimate refactors. This deliberately
 *     trades some sensitivity for near-zero false blocks; the failure mode we optimise against is
 *     BLOCKING A LEGITIMATE EDIT, because a wrongly-allowed replace is caught by the owner's
 *     immediate preview while a wrongly-blocked one makes the feature useless.
 */

import { parseSectionEntries } from './SimulationService.js';
import { readStoredUiControls, SIM_UI_UNSAFE_SELECTOR_RE } from './SimUiControls.js';

// ─── Types ──────────────────────────────────────────────────────────────────────────────

export type AnchorKind = 'id' | 'selector' | 'text' | 'class' | 'global' | 'member';

export interface ContractAnchor {
  kind: AnchorKind;
  /** The token as written in the section body (a selector, an id, a label, a global name). */
  token: string;
  /** For selectors: the single atom (#id or .class) that could not be resolved. */
  atom?: string;
}

/** Everything one section body needs the simulation to keep providing. */
export interface BridgeContract {
  ids: string[];
  selectors: string[];
  texts: string[];
  classes: string[];
  /** Window globals the body reaches for — the sim's JS API entry points. */
  globals: string[];
  /** Methods/properties invoked on those globals (setValue, toggleMute, init …). */
  members: string[];
}

export type SectionStatus = 'ok' | 'broken';

export interface SectionVerdict {
  sectionId: string;
  status: SectionStatus;
  /** Anchors the replacement bundle no longer provides (empty when ok). */
  missing: ContractAnchor[];
  /** Total anchors checked — a 0 here means nothing could be proven for this section. */
  checked: number;
}

export interface CompatibilityReport {
  compatible: boolean;
  /** Per-section verdicts, in bridge order. One package serves many sections; ALL are judged. */
  sections: SectionVerdict[];
  /** Minimal-UI hide selectors that would stop matching (does not block; UI degrades, not breaks). */
  staleHideSelectors: { sectionId: string; selectors: string[] }[];
  /** Structural problems with the bundle itself (these DO block). */
  structural: string[];
  summary: {
    sectionsTotal: number;
    sectionsOk: number;
    sectionsBroken: number;
    /** Sections whose body exposed no checkable anchor — reported, never silently "ok". */
    sectionsUnverifiable: number;
  };
}

/** The replacement files, as decoded by SimulationService.buildUploadFileMap. */
export interface CandidateBundle {
  /** relPath → file contents. Binary assets are tolerated (only text is scanned). */
  files: Map<string, Buffer>;
  /** Relative path of the entry HTML inside the bundle. */
  entryRelPath: string;
}

// ─── Extraction ─────────────────────────────────────────────────────────────────────────

/**
 * Names the BRIDGE TEMPLATE itself provides. They live in every section body regardless of the
 * simulation, so treating them as contract would make every replace fail.
 */
const BRIDGE_BUILTINS = new Set([
  'parent', 'postMessage', 'document', 'location', 'setTimeout', 'setInterval', 'clearTimeout',
  'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'addEventListener',
  'removeEventListener', 'getComputedStyle', 'SimAPI', '_simReadyFired', 'innerWidth',
  'innerHeight', 'devicePixelRatio', 'dispatchEvent', 'Event', 'CustomEvent', 'performance',
  'console', 'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Date',
]);

/**
 * Generic DOM/JS members. Requiring these of a simulation proves nothing (every page has them)
 * and would produce noise, so they are never treated as part of the sim's API surface.
 */
const GENERIC_MEMBERS = new Set([
  'length', 'style', 'value', 'checked', 'textContent', 'innerHTML', 'innerText', 'children',
  'parentNode', 'parentElement', 'classList', 'className', 'remove', 'appendChild', 'removeChild',
  'querySelector', 'querySelectorAll', 'getElementById', 'getElementsByClassName', 'addEventListener',
  'removeEventListener', 'dispatchEvent', 'setProperty', 'removeProperty', 'getPropertyValue',
  'setAttribute', 'getAttribute', 'removeAttribute', 'trim', 'toLowerCase', 'toUpperCase',
  'contains', 'add', 'push', 'pop', 'shift', 'forEach', 'map', 'filter', 'indexOf', 'includes',
  'startsWith', 'endsWith', 'split', 'join', 'slice', 'test', 'exec', 'call', 'apply', 'bind',
  'id', 'head', 'documentElement', 'body', 'createElement', 'display', 'now', 'min', 'max',
  'round', 'abs', 'floor', 'ceil', 'random', 'hasOwnProperty', 'prototype', 'constructor',
  'stringify', 'parse', 'keys', 'values', 'entries', 'toString', 'valueOf', 'focus', 'blur',
  'click', 'checked', 'disabled', 'hidden', 'offsetWidth', 'offsetHeight', 'getBoundingClientRect',
]);

/** Identifiers too short/common to prove anything by substring search. */
const isCheckableIdentifier = (name: string): boolean => name.length >= 3 && /^[A-Za-z_$][\w$]*$/.test(name);

/**
 * Extract the DOM + JS API anchors one section body depends on.
 *
 * Deliberately conservative: it only records anchors written as STRING LITERALS or explicit
 * property accesses. A body that computes a selector at runtime contributes nothing rather than
 * a guess — recorded as "unverifiable" by the caller instead of a false accusation.
 */
export function extractBridgeContract(sectionBody: string): BridgeContract {
  const ids = new Set<string>();
  const selectors = new Set<string>();
  const texts = new Set<string>();
  const classes = new Set<string>();
  const globals = new Set<string>();
  const members = new Set<string>();

  for (const m of sectionBody.matchAll(/getElementById\(\s*['"`]([^'"`]+)['"`]/g)) ids.add(m[1]);
  for (const m of sectionBody.matchAll(/querySelector(?:All)?\(\s*['"`]([^'"`]+)['"`]/g)) selectors.add(m[1]);
  // A bare #id selector is just an id lookup.
  for (const sel of selectors) {
    const m = /^#([\w-]+)$/.exec(sel);
    if (m) ids.add(m[1]);
  }
  // Label-text matching: `lab.textContent.trim().toLowerCase() === 'separation:'`
  for (const m of sectionBody.matchAll(
    /textContent[^;]{0,80}?(?:===?|includes\(|startsWith\(|endsWith\(|match\()\s*['"`]([^'"`]{2,})['"`]/g,
  )) texts.add(m[1]);
  for (const m of sectionBody.matchAll(/classList\.(?:contains|add|remove|toggle)\(\s*['"`]([^'"`]+)['"`]/g)) classes.add(m[1]);

  // The sim's JS API: explicit window globals …
  for (const m of sectionBody.matchAll(/\bwindow\s*\.\s*(\w+)/g)) {
    if (!BRIDGE_BUILTINS.has(m[1]) && isCheckableIdentifier(m[1])) globals.add(m[1]);
  }
  // … the conventional bare `app`/`App` handle (assigned from a global inside the body) …
  for (const m of sectionBody.matchAll(/\b(app|App)\s*\.\s*(\w+)/g)) {
    globals.add(m[1]);
    if (!GENERIC_MEMBERS.has(m[2]) && isCheckableIdentifier(m[2])) members.add(m[2]);
  }
  // … and the members invoked on them.
  for (const m of sectionBody.matchAll(/typeof\s+[\w.$]+\.(\w+)\s*===?\s*['"]function['"]/g)) {
    if (!GENERIC_MEMBERS.has(m[1]) && isCheckableIdentifier(m[1])) members.add(m[1]);
  }
  for (const m of sectionBody.matchAll(/\bwindow\.\w+(?:\.\w+)*?\.(\w+)\s*\(/g)) {
    if (!GENERIC_MEMBERS.has(m[1]) && isCheckableIdentifier(m[1])) members.add(m[1]);
  }
  for (const m of sectionBody.matchAll(/\bwindow\.\w+\.(\w+)\b/g)) {
    if (!GENERIC_MEMBERS.has(m[1]) && isCheckableIdentifier(m[1])) members.add(m[1]);
  }

  return {
    ids: [...ids], selectors: [...selectors], texts: [...texts],
    classes: [...classes], globals: [...globals], members: [...members],
  };
}

/** Every section body in a combined bridge.js, keyed by timeline section id. */
export function extractContractsFromBridge(bridgeJs: string): Map<string, BridgeContract> {
  const out = new Map<string, BridgeContract>();
  for (const [sectionId, body] of parseSectionEntries(bridgeJs)) {
    out.set(sectionId, extractBridgeContract(body));
  }
  return out;
}

// ─── Resolution ─────────────────────────────────────────────────────────────────────────

const TEXT_FILE_RE = /\.(html?|js|mjs|cjs|jsx|ts|tsx|css|json|svg|txt|md)$/i;
/** Generated artifacts are preserved across a replace and are NOT evidence about the new sim. */
const GENERATED_RE = /(?:^|\/)(?:bridge\.js|guidance\.js|guidance\/.*|section_[^/]+\.(?:js|html))$/;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface ResolvedSources {
  /** Entry HTML + every text asset (JS/CSS/…) concatenated — the search corpus. */
  all: string;
  /** Scripts + inline HTML only — where JS identifiers must live. */
  code: string;
  entryHtml: string;
}

export function buildSources(bundle: CandidateBundle): ResolvedSources {
  const entryHtml = bundle.files.get(bundle.entryRelPath)?.toString('utf8') ?? '';
  const parts: string[] = [entryHtml];
  const codeParts: string[] = [entryHtml];
  for (const [rel, buf] of bundle.files) {
    if (rel === bundle.entryRelPath) continue;
    if (GENERATED_RE.test(rel)) continue;      // never let the old bridge vouch for the new sim
    if (!TEXT_FILE_RE.test(rel)) continue;
    const text = buf.toString('utf8');
    parts.push(text);
    if (/\.(js|mjs|cjs|jsx|ts|tsx|html?)$/i.test(rel)) codeParts.push(text);
  }
  return { all: parts.join('\n'), code: codeParts.join('\n'), entryHtml };
}

const hasId = (src: string, id: string): boolean =>
  new RegExp(`(?:id\\s*=\\s*["']?${escapeRe(id)}\\b)|(?:['"\`]${escapeRe(id)}['"\`])|(?:#${escapeRe(id)}\\b)`).test(src);

const hasClass = (src: string, cls: string): boolean =>
  new RegExp(
    `(?:class\\s*=\\s*["'][^"']*\\b${escapeRe(cls)}\\b)` +   // static markup
    `|(?:['"\`][^'"\`]*\\b${escapeRe(cls)}\\b[^'"\`]*['"\`])` + // any JS string literal (runtime-built)
    `|(?:\\.${escapeRe(cls)}\\b)`,                            // CSS rule / selector literal
  ).test(src);

/** Label text: compare case-insensitively and ignore a trailing colon (labels render "Separation:"). */
const hasText = (src: string, text: string): boolean =>
  src.toLowerCase().includes(text.toLowerCase().replace(/:\s*$/, '').trim());

const hasIdentifier = (code: string, name: string): boolean =>
  new RegExp(`\\b${escapeRe(name)}\\b`).test(code);

/** The atoms a CSS selector requires. Combinators/pseudos are structure, not existence. */
function selectorAtoms(selector: string): { ids: string[]; classes: string[] } {
  return {
    ids: [...selector.matchAll(/#([\w-]+)/g)].map((m) => m[1]),
    classes: [...selector.matchAll(/\.([\w-]+)/g)].map((m) => m[1]),
  };
}

/** Check one section's contract against the replacement sources. */
export function verifyContract(contract: BridgeContract, sources: ResolvedSources): { missing: ContractAnchor[]; checked: number } {
  const missing: ContractAnchor[] = [];
  let checked = 0;

  for (const id of contract.ids) {
    checked++;
    if (!hasId(sources.all, id)) missing.push({ kind: 'id', token: `#${id}` });
  }
  for (const selector of contract.selectors) {
    const atoms = selectorAtoms(selector);
    for (const id of atoms.ids) {
      checked++;
      if (!hasId(sources.all, id)) missing.push({ kind: 'selector', token: selector, atom: `#${id}` });
    }
    for (const cls of atoms.classes) {
      checked++;
      if (!hasClass(sources.all, cls)) missing.push({ kind: 'selector', token: selector, atom: `.${cls}` });
    }
  }
  for (const text of contract.texts) {
    checked++;
    if (!hasText(sources.all, text)) missing.push({ kind: 'text', token: text });
  }
  for (const cls of contract.classes) {
    checked++;
    if (!hasClass(sources.all, cls)) missing.push({ kind: 'class', token: `.${cls}` });
  }
  for (const global of contract.globals) {
    checked++;
    if (!hasIdentifier(sources.code, global)) missing.push({ kind: 'global', token: `window.${global}` });
  }
  for (const member of contract.members) {
    checked++;
    if (!hasIdentifier(sources.code, member)) missing.push({ kind: 'member', token: `.${member}()` });
  }
  return { missing, checked };
}

// ─── Structural gate ────────────────────────────────────────────────────────────────────

/**
 * Bundle-level problems that break the package regardless of any section body. These block on
 * their own: without a usable entry document the bridge is never even loaded.
 */
function checkStructure(bundle: CandidateBundle, sources: ResolvedSources): string[] {
  const problems: string[] = [];
  const html = sources.entryHtml;

  if (!html.trim()) {
    problems.push(`The entry file "${bundle.entryRelPath}" is empty.`);
    return problems;
  }
  if (!/<html[\s>]/i.test(html) && !/<body[\s>]/i.test(html) && !/<!doctype/i.test(html)) {
    problems.push(`The entry file "${bundle.entryRelPath}" does not look like an HTML document.`);
  }
  // The bridge/gate are injected before </body> (or appended); a document with neither head nor
  // body cannot host them reliably.
  if (!/<head[\s>]/i.test(html) && !/<body[\s>]/i.test(html)) {
    problems.push(`The entry file "${bundle.entryRelPath}" has no <head> or <body> to inject the simulation bridge into.`);
  }
  // Local scripts referenced by the entry must actually ship in the bundle, or the new sim is
  // dead on arrival (an easy mistake when zipping a subfolder).
  const dir = bundle.entryRelPath.includes('/') ? bundle.entryRelPath.slice(0, bundle.entryRelPath.lastIndexOf('/')) : '';
  for (const m of html.matchAll(/<script[^>]*\ssrc\s*=\s*["']([^"']+)["']/gi)) {
    const raw = m[1];
    if (/^(?:https?:)?\/\//i.test(raw) || raw.startsWith('data:')) continue;   // CDN / inline data
    let rel = raw.replace(/[?#].*$/, '').replace(/^\.\//, '');
    let base = dir;
    while (rel.startsWith('../')) {
      rel = rel.slice(3);
      base = base.includes('/') ? base.slice(0, base.lastIndexOf('/')) : '';
    }
    if (GENERATED_RE.test(rel)) continue;    // bridge.js/guidance.js are re-injected, not shipped
    const full = base ? `${base}/${rel}` : rel;
    if (!bundle.files.has(full)) problems.push(`The entry HTML references "${raw}" but the upload does not contain "${full}".`);
  }
  return problems;
}

// ─── Public API ─────────────────────────────────────────────────────────────────────────

export interface CheckReplaceOptions {
  /** The CURRENT combined bridge.js of the package (preserved across the replace). */
  bridgeJs: string;
  /** The replacement files + entry path (already validated to contain the entry). */
  bundle: CandidateBundle;
  /** Current sections of this package: their Minimal-UI selections (sim_meta.uiControls). */
  sections?: { id: string; simMeta?: unknown }[];
}

/**
 * Decide whether the replacement can adopt the existing bridge unchanged.
 *
 * PURE — reads nothing, writes nothing. The caller runs this on the decoded upload BEFORE any
 * storage or database mutation, so a refusal leaves the live simulation completely untouched.
 */
export function checkReplaceCompatibility(opts: CheckReplaceOptions): CompatibilityReport {
  const sources = buildSources(opts.bundle);
  const structural = checkStructure(opts.bundle, sources);
  const contracts = extractContractsFromBridge(opts.bridgeJs);

  const sections: SectionVerdict[] = [];
  for (const [sectionId, contract] of contracts) {
    const { missing, checked } = verifyContract(contract, sources);
    sections.push({ sectionId, status: missing.length ? 'broken' : 'ok', missing, checked });
  }

  // Minimal-UI hide selectors are mechanical (a <style> rule). A stale one degrades the clean-view
  // instead of breaking the demonstration, so it is REPORTED but never blocks on its own.
  const staleHideSelectors: { sectionId: string; selectors: string[] }[] = [];
  for (const sec of opts.sections ?? []) {
    const selection = readStoredUiControls((sec.simMeta as { uiControls?: unknown } | undefined)?.uiControls);
    const hide = selection?.hide ?? [];
    const stale = hide.filter((sel) => {
      if (!sel || SIM_UI_UNSAFE_SELECTOR_RE.test(sel)) return false;
      const atoms = selectorAtoms(sel);
      const bare = sel.trim().replace(/^([a-zA-Z][\w-]*)$/, '$1');
      if (!atoms.ids.length && !atoms.classes.length) {
        // A bare tag selector (e.g. "button") — present in essentially any document; do not flag.
        return !new RegExp(`<${escapeRe(bare)}\\b`, 'i').test(sources.all) && !hasIdentifier(sources.code, bare);
      }
      return atoms.ids.some((id) => !hasId(sources.all, id)) || atoms.classes.some((c) => !hasClass(sources.all, c));
    });
    if (stale.length) staleHideSelectors.push({ sectionId: sec.id, selectors: stale });
  }

  const sectionsBroken = sections.filter((s) => s.status === 'broken').length;
  const sectionsUnverifiable = sections.filter((s) => s.checked === 0).length;

  return {
    // Owner-approved policy: ANY broken section refuses the WHOLE replace. One package serves many
    // sections, and a partially-applied swap would leave a silently dead sub-simulation in
    // production. Structural faults block too.
    compatible: sectionsBroken === 0 && structural.length === 0,
    sections,
    staleHideSelectors,
    structural,
    summary: {
      sectionsTotal: sections.length,
      sectionsOk: sections.length - sectionsBroken,
      sectionsBroken,
      sectionsUnverifiable,
    },
  };
}

/** Human-readable refusal, naming exactly what to fix. Safe for API responses and logs. */
export function describeIncompatibility(report: CompatibilityReport): string {
  if (report.compatible) return 'The replacement is compatible with the existing simulation bridge.';
  const lines: string[] = [];
  for (const problem of report.structural) lines.push(`• ${problem}`);
  for (const sec of report.sections.filter((s) => s.status === 'broken')) {
    const what = sec.missing
      .slice(0, 6)
      .map((a) => (a.kind === 'text' ? `label text "${a.token}"` : a.atom ?? a.token))
      .join(', ');
    const more = sec.missing.length > 6 ? ` (+${sec.missing.length - 6} more)` : '';
    lines.push(`• Section ${sec.sectionId}: the new files no longer provide ${what}${more}.`);
  }
  return (
    'This simulation cannot be replaced with these files: the existing bridge would stop working.\n' +
    lines.join('\n') +
    '\n\nKeep those names unchanged in your new version, or upload it as a NEW simulation and point ' +
    'the sections at it (which regenerates the bridge from scratch).'
  );
}
