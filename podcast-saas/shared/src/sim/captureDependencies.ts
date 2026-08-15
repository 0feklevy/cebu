/**
 * OFFLINE DEPENDENCY CLOSURE — the pure half.
 *
 * THE INCIDENT (v0.1.26). Package-root staging was fixed, the bridge loaded, SIM_READY fired — and
 * every capture still failed the rendering gate with "every sampled canvas frame is uniform
 * (dead/black canvas)" and an EMPTY renderer string. The production packages declare an import map
 * pointing at a CDN:
 *
 *   { "imports": { "three": "https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js",
 *                  "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/" } }
 *
 * and their entry module is `import * as THREE from 'three'`. The capture child runs with
 * `--network none` — correctly, and that is not negotiable — so the module graph never resolved,
 * the app never booted, no WebGL context was ever created, and the canvas stayed exactly as the
 * document left it. The gate was right; the package was unreachable.
 *
 * THE RULE THIS ESTABLISHES: a capture-compatible simulation renders from its own immutable bytes
 * plus TRUSTED PINNED dependencies, with zero outbound network. Nothing is fetched at capture
 * time — the trusted side materialises the dependency closure into the staged copy BEFORE the
 * container starts, and rewrites the capture copy's import map to point at it.
 *
 * WHAT LIVES HERE: only decisions that are pure functions of bytes — parsing the import map,
 * classifying external references, planning the rewrite. Reading vendor packs off disk, verifying
 * their hashes and staging files are the trusted side's job (`trustedDependencies.ts`), and the
 * ORIGINAL STORED PACKAGE IS NEVER MUTATED: every transform here applies to the capture copy.
 */

/** Where an external reference was found, and what its absence would cost. */
export type ExternalRefKind =
  /** An import-map entry — resolves bare specifiers, so its absence breaks the module graph. */
  | 'importmap'
  /** `<script src>` — classic or module. */
  | 'script'
  /** `<link rel=stylesheet>` and friends. */
  | 'stylesheet'
  /** `<link rel=preconnect|dns-prefetch>` — a hint; nothing depends on it. */
  | 'hint'
  /** A bare/absolute specifier inside JS that the import map does not cover. */
  | 'module-specifier';

/**
 * How badly the capture needs this reference. The distinction is the difference between "the app
 * cannot boot" and "an icon font renders as text", and it decides whether a package is
 * capture-compatible at all.
 */
export type ExternalRefCriticality =
  /** The module graph cannot execute without it. */
  | 'boot'
  /** The app boots, but the captured pixels differ from what a viewer sees. */
  | 'visual'
  /** Neither — a hint, a telemetry beacon, a resource nothing awaits. */
  | 'cosmetic';

export interface ExternalReference {
  kind: ExternalRefKind;
  /** The verbatim URL or specifier as it appears in the package. */
  raw: string;
  /** Origin (`https://cdn.jsdelivr.net`) when `raw` is an absolute URL, else null. */
  origin: string | null;
  criticality: ExternalRefCriticality;
}

/** One import-map entry: exact specifier or (trailing-slash) prefix. */
export interface ImportMapEntry {
  specifier: string;
  target: string;
  isPrefix: boolean;
}

/** A trusted, pinned dependency identity. Bytes live beside the descriptor, never fetched at runtime. */
export interface TrustedDependencyDescriptor {
  provider: string;
  name: string;
  version: string;
  /** Absolute URL prefixes this pack is the trusted local equivalent of. */
  satisfies: string[];
  /** Exact import-map specifier → pack-relative file (`three` → `build/three.module.js`). */
  exact: Record<string, string>;
  /** Prefix import-map specifier → pack-relative directory (`three/addons/` → `examples/jsm/`). */
  prefix: Record<string, string>;
  /** Every vendored file, pack-relative, with its integrity. */
  files: Record<string, { bytes: number; sha256: string }>;
}

/** The directory, at the staged package ROOT, that vendored dependencies are materialised into. */
export const VENDOR_DIR = '__flowvid_vendor';

/** Where one pack's files land inside the staged package. */
export function vendorPrefixFor(dep: Pick<TrustedDependencyDescriptor, 'name' | 'version'>): string {
  return `${VENDOR_DIR}/${dep.name}/${dep.version}/`;
}

// ── Import-map extraction (real JSON, not a regex guess) ────────────────────────────────────────

/** `<script type="importmap">` and its JSON body, located by tag scan and parsed as JSON. */
export interface ParsedImportMap {
  /** Byte offsets of the JSON body inside the HTML, so a rewrite can splice it back precisely. */
  start: number;
  end: number;
  entries: ImportMapEntry[];
  /** Every other top-level member (`scopes`, `integrity`, …), preserved through the rewrite. */
  rest: Record<string, unknown>;
}

/** Byte spans of HTML comments, so a commented-out example map cannot be mistaken for the real one. */
function commentSpans(html: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let i = 0;
  for (;;) {
    const open = html.indexOf('<!--', i);
    if (open === -1) break;
    const close = html.indexOf('-->', open + 4);
    const end = close === -1 ? html.length : close + 3;
    spans.push([open, end]);
    i = end;
  }
  return spans;
}

/**
 * Find and parse the document's import map. Returns null when there is none, and THROWS when there
 * is one that is not valid JSON — a malformed import map is a broken package, and silently
 * treating it as absent would strand the very specifiers the capture must rewrite.
 */
export function parseImportMaps(html: string): ParsedImportMap[] {
  const inComment = commentSpans(html);
  const tags = scanTags(html, new Set(['script'])).filter(
    (t) => (t.attrs.type ?? '').toLowerCase() === 'importmap' &&
           !inComment.some(([a, b]) => t.start >= a && t.start < b),
  );
  return tags.map((tag) => {
    const start = tag.end;
    const end = html.indexOf('</script>', start);
    if (end === -1) throw new Error('import map: unterminated <script type="importmap"> block');
    const body = html.slice(start, end);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (err) {
      throw new Error(`import map: body is not valid JSON — ${err instanceof Error ? err.message : String(err)}`);
    }
    const imports = (parsed as { imports?: unknown } | null)?.imports;
    if (imports !== undefined && (typeof imports !== 'object' || imports === null || Array.isArray(imports))) {
      throw new Error('import map: "imports" must be an object');
    }
    const entries: ImportMapEntry[] = Object.entries((imports ?? {}) as Record<string, unknown>)
      .filter(([, target]) => typeof target === 'string')
      .map(([specifier, target]) => ({
        specifier,
        target: target as string,
        isPrefix: specifier.endsWith('/'),
      }));
    const rest = { ...(parsed as Record<string, unknown>) };
    delete rest.imports;
    return { start, end, entries, rest };
  });
}

export function parseImportMap(html: string): ParsedImportMap | null {
  return parseImportMaps(html)[0] ?? null;
}

/** Absolute `http(s)` URL? (Protocol-relative `//host/x` counts — it is external too.) */
export function isExternalUrl(raw: string): boolean {
  return /^https?:\/\//i.test(raw) || raw.startsWith('//');
}

function originOf(raw: string): string | null {
  try {
    return new URL(raw.startsWith('//') ? `https:${raw}` : raw).origin;
  } catch {
    return null;
  }
}

// ── HTML reference scan ─────────────────────────────────────────────────────────────────────────

/** The tags that can declare a resource the document will actually go and fetch. */
const HTML_REF_TAGS: ReadonlySet<string> = new Set(['script', 'link']);

/** One scanned start tag: its name, attributes, and the exact byte span it occupies. */
export interface ScannedTag {
  name: string;
  attrs: Record<string, string>;
  start: number;
  end: number;
}

/**
 * Scan start tags with a real (small) tokenizer rather than a regex.
 *
 * A regex of the shape `<link([^>]*)>` is WRONG on valid HTML and this is not theoretical: an
 * attribute value may legally contain `>` (`href="…?a=-->"`), and a browser — which tracks quoting
 * — reads one tag where the regex reads a truncated one. The consequence here would be an external
 * stylesheet the scan fails to see and therefore fails to neutralise, so whether a remote font
 * loaded would silently decide the captured layout. Quoting is the whole job, so it is done
 * properly: attribute values are consumed to their closing quote, and only an UNQUOTED `>` ends
 * the tag.
 */
export function scanTags(html: string, names: ReadonlySet<string>): ScannedTag[] {
  const out: ScannedTag[] = [];
  for (let i = 0; i < html.length; i++) {
    if (html[i] !== '<') continue;
    let j = i + 1;
    if (html[j] === '/') j++; // an end tag still has to be consumed, or its attrs confuse the scan
    let name = '';
    while (j < html.length && /[a-zA-Z0-9-]/.test(html[j]!)) name += html[j++]!;
    name = name.toLowerCase();
    if (name.length === 0) continue; // '<' that begins no tag (a comment, a stray '<' in text)
    const wanted = names.has(name);
    // Attributes are parsed for EVERY tag, matched or not: the scan must know where this tag ENDS
    // so a '<' inside its quoted attribute value cannot be mistaken for the next tag.
    const attrs: Record<string, string> = {};
    while (j < html.length) {
      while (j < html.length && /\s/.test(html[j]!)) j++;
      if (j >= html.length) break;
      if (html[j] === '>') { j++; break; }
      if (html[j] === '/' && html[j + 1] === '>') { j += 2; break; }
      let attrName = '';
      while (j < html.length && !/[\s=/>]/.test(html[j]!)) attrName += html[j++]!;
      while (j < html.length && /\s/.test(html[j]!)) j++;
      let value = '';
      if (html[j] === '=') {
        j++;
        while (j < html.length && /\s/.test(html[j]!)) j++;
        const quote = html[j];
        if (quote === '"' || quote === "'") {
          j++;
          while (j < html.length && html[j] !== quote) value += html[j++]!;
          j++; // closing quote
        } else {
          while (j < html.length && !/[\s>]/.test(html[j]!)) value += html[j++]!;
        }
      }
      if (attrName) attrs[attrName.toLowerCase()] = value.trim();
    }
    if (wanted) out.push({ name, attrs, start: i, end: j });
    i = j - 1;
  }
  return out;
}

/**
 * Every EXTERNAL reference the HTML declares, classified.
 *
 * Deliberately narrow: `<script src>` and `<link href>` are where a document declares resources it
 * will actually go and get, plus the import map (handled separately, since it is JSON). This scan
 * is a static approximation and says so — a URL a script computes at runtime cannot be seen from
 * here, which is exactly why the capture ALSO audits real requests at runtime and fails on any
 * that leave loopback.
 */
export function scanHtmlExternalRefs(html: string): ExternalReference[] {
  const refs: ExternalReference[] = [];
  for (const { name: tag, attrs } of scanTags(html, HTML_REF_TAGS)) {
    if (tag === 'script') {
      const src = attrs.src;
      if (src && isExternalUrl(src)) {
        refs.push({ kind: 'script', raw: src, origin: originOf(src), criticality: 'boot' });
      }
      continue;
    }
    const href = attrs.href;
    if (!href || !isExternalUrl(href)) continue;
    const rel = (attrs.rel ?? '').toLowerCase();
    if (rel.includes('preconnect') || rel.includes('dns-prefetch')) {
      refs.push({ kind: 'hint', raw: href, origin: originOf(href), criticality: 'cosmetic' });
    } else if (rel.includes('stylesheet')) {
      // A stylesheet is render-blocking: the page waits for it, and with no network that wait ends
      // in an error rather than a style. It changes pixels, but it cannot stop the module graph.
      refs.push({ kind: 'stylesheet', raw: href, origin: originOf(href), criticality: 'visual' });
    } else if (rel.includes('modulepreload')) {
      // A module preload names a module the graph will import anyway — treat it as boot-critical.
      refs.push({ kind: 'script', raw: href, origin: originOf(href), criticality: 'boot' });
    } else if (rel.includes('preload')) {
      // A plain preload is a HINT that duplicates a real reference (a font the stylesheet also
      // names). Refusing a package for it would reject an ordinary Google-Fonts preload whose
      // stylesheet the closure already handles as a substitution.
      refs.push({ kind: 'stylesheet', raw: href, origin: originOf(href), criticality: 'visual' });
    }
  }
  return refs;
}

/** Import-map targets that point off-origin — the boot-critical class this incident was made of. */
export function externalImportMapRefs(map: ParsedImportMap | null): ExternalReference[] {
  if (!map) return [];
  return map.entries
    .filter((e) => isExternalUrl(e.target))
    .map((e) => ({
      kind: 'importmap' as const,
      raw: e.target,
      origin: originOf(e.target),
      criticality: 'boot' as const,
    }));
}

// ── Planning the offline rewrite ────────────────────────────────────────────────────────────────

export interface DependencyResolution {
  /** The pack that satisfies this entry. */
  descriptor: TrustedDependencyDescriptor;
  entry: ImportMapEntry;
  /** The import-map target the capture copy will use — root-absolute, so entry depth cannot matter. */
  localTarget: string;
}

export interface CaptureDependencyClosure {
  /** Entries that a trusted pack satisfies, with their rewritten targets. */
  resolved: DependencyResolution[];
  /** External references nothing in the registry satisfies. */
  unresolved: ExternalReference[];
  /** Distinct packs to materialise into the staged package. */
  packs: TrustedDependencyDescriptor[];
  /** True when no BOOT-critical reference is left unsatisfied. */
  bootComplete: boolean;
}

/** Does `descriptor` claim this absolute URL? (Prefix match on a declared `satisfies` origin+path.) */
function packSatisfies(descriptor: TrustedDependencyDescriptor, url: string): boolean {
  return descriptor.satisfies.some((base) => url.startsWith(base));
}

/**
 * Map one import-map entry onto a trusted pack.
 *
 * Exact and prefix entries are handled by their own rules, because the import-maps spec treats them
 * differently and getting it wrong is silent: a prefix key MUST keep its trailing slash on both
 * sides, and an exact key must resolve to a file.
 */
function resolveEntry(
  entry: ImportMapEntry,
  registry: readonly TrustedDependencyDescriptor[],
): DependencyResolution | null {
  if (!isExternalUrl(entry.target)) return null;
  for (const descriptor of registry) {
    if (!packSatisfies(descriptor, entry.target)) continue;
    const base = descriptor.satisfies.find((b) => entry.target.startsWith(b))!;
    const packRelative = entry.target.slice(base.length);
    const prefix = vendorPrefixFor(descriptor);

    if (entry.isPrefix) {
      // `three/addons/` → `examples/jsm/`: the remainder must name a directory the pack declares.
      const known = Object.values(descriptor.prefix).some((dir) => dir === packRelative);
      if (!known && packRelative !== '') continue;
      return { descriptor, entry, localTarget: `/${prefix}${packRelative}` };
    }
    // Exact: the remainder must be a file the pack actually vendored.
    if (!descriptor.files[packRelative]) continue;
    return { descriptor, entry, localTarget: `/${prefix}${packRelative}` };
  }
  return null;
}

/**
 * Plan the offline closure for one package's entry document.
 *
 * Nothing is fetched and nothing is written here — the result says which packs must be staged, what
 * the capture copy's import map becomes, and precisely which external references remain
 * unsatisfied so the caller can refuse (or degrade) with a reason instead of a dead canvas.
 */
export function planCaptureDependencies(
  html: string,
  registry: readonly TrustedDependencyDescriptor[],
): CaptureDependencyClosure {
  const maps = parseImportMaps(html);
  const resolved: DependencyResolution[] = [];
  const unresolved: ExternalReference[] = [];

  // Iterate the ENTRIES, not the deduplicated refs: two specifiers may share one CDN target
  // (`three` and `three-core`), and resolving only the first left the other pointing at the CDN
  // while the closure still reported bootComplete.
  for (const entry of maps.flatMap((m) => m.entries)) {
    if (!isExternalUrl(entry.target)) continue;
    const hit = resolveEntry(entry, registry);
    if (hit) resolved.push(hit);
    else {
      unresolved.push({
        kind: 'importmap',
        raw: entry.target,
        origin: null,
        criticality: 'boot',
      });
    }
  }
  for (const ref of scanHtmlExternalRefs(html)) {
    if (ref.criticality === 'cosmetic') continue; // hints resolve to nothing and block nothing
    unresolved.push(ref);
  }

  const packs = [...new Map(resolved.map((r) => [`${r.descriptor.name}@${r.descriptor.version}`, r.descriptor])).values()];
  return {
    resolved,
    unresolved,
    packs,
    bootComplete: !unresolved.some((r) => r.criticality === 'boot'),
  };
}

// ── Rewriting the CAPTURE COPY ──────────────────────────────────────────────────────────────────

export interface RewriteOptions {
  /**
   * Neutralise external stylesheets/hints the closure could not satisfy. They are not boot-blocking,
   * but with no network each one is a render-blocking request that ends in an error, and whether a
   * remote font arrived would otherwise decide the captured layout. Removing them makes the capture
   * DETERMINISTIC — the local fallback renders, every time, identically.
   */
  neutraliseUnresolvedVisualRefs?: boolean;
}

export interface RewriteResult {
  html: string;
  /** What changed, for the capture log. */
  rewrittenSpecifiers: string[];
  neutralisedUrls: string[];
}

/**
 * Produce the CAPTURE COPY of an entry document: import map retargeted at the staged vendor tree,
 * unsatisfiable external visual refs neutralised. The stored package is untouched — this operates
 * on a string the caller obtained from storage and will write only into the capture input mount.
 */
export function rewriteEntryHtmlForCapture(
  html: string,
  closure: CaptureDependencyClosure,
  options: RewriteOptions = {},
): RewriteResult {
  let out = html;
  const rewrittenSpecifiers: string[] = [];
  const neutralisedUrls: string[] = [];

  const allMaps = parseImportMaps(out);
  for (const map of [...allMaps].reverse()) {
    if (closure.resolved.length === 0) break;
    const byTarget = new Map(closure.resolved.map((r) => [r.entry.specifier, r]));
    const imports: Record<string, string> = {};
    for (const entry of map.entries) {
      const hit = byTarget.get(entry.specifier);
      if (hit) {
        imports[entry.specifier] = hit.localTarget;
        rewrittenSpecifiers.push(`${entry.specifier} -> ${hit.localTarget}`);
      } else {
        imports[entry.specifier] = entry.target;
      }
    }
    const body = `\n${JSON.stringify({ ...map.rest, imports }, null, 2)}\n`;
    out = out.slice(0, map.start) + body + out.slice(map.end);
  }

  if (options.neutraliseUnresolvedVisualRefs) {
    // Splice by the SCANNED byte span, right-to-left so earlier offsets stay valid. Removing by
    // regex would inherit the truncation bug the tokenizer exists to avoid, and would rebuild the
    // untrusted URL into a pattern.
    const targets = new Set(
      closure.unresolved.filter((r) => r.kind === 'stylesheet').map((r) => r.raw),
    );
    const stale = scanTags(out, HTML_REF_TAGS).filter(
      (t) => t.name === 'link' && t.attrs.href !== undefined && targets.has(t.attrs.href),
    );
    for (const tag of [...stale].reverse()) {
      // REMOVED, not commented out. The URL is untrusted package content: wrapping it in an HTML
      // comment would let an href containing `-->` break out of that comment and inject markup
      // into the document the capture renders. The marker is fixed text only; the actual URL
      // travels to the (sanitised) capture log via `neutralisedUrls`.
      out = out.slice(0, tag.start) + '<!-- flowvid-capture: external stylesheet removed for offline capture -->' + out.slice(tag.end);
      neutralisedUrls.push(tag.attrs.href as string);
    }
  }

  return { html: out, rewrittenSpecifiers, neutralisedUrls };
}

// ── JavaScript module specifiers ────────────────────────────────────────────────────────────────

/**
 * Extract every module specifier from JavaScript, with a real LEXER rather than a pattern match.
 *
 * WHY A LEXER: an import map only governs BARE specifiers. A module may name an absolute URL
 * directly — `import * as THREE from 'https://cdn.jsdelivr.net/…'` — which bypasses the map
 * entirely, so a validator that reads only the HTML would call such a package capture-compatible
 * and it would die inside `--network none` exactly as v0.1.26 did. Finding those specifiers means
 * knowing which quotes are code and which are text: `// import 'https://evil'` is a comment,
 * `` `import 'x'` `` is a template, and `/'/` is a regex. A pattern match cannot tell them apart;
 * this walks the source and skips each construct properly.
 *
 * HONEST LIMIT, stated rather than hidden: a specifier a program COMPUTES (`import(base + name)`)
 * is not statically knowable, by anyone. That is precisely why the capture also audits real
 * requests at runtime and reports any that leave loopback — static analysis narrows the problem,
 * the runtime audit closes it.
 */
export function scanJsModuleSpecifiers(source: string): string[] {
  const found: string[] = [];
  const n = source.length;
  /** Was the last significant token a value? Then `/` divides; otherwise it starts a regex. */
  let prevSignificant = '';

  const readString = (i: number, quote: string): number => {
    let j = i + 1;
    let value = '';
    while (j < n) {
      const c = source[j]!;
      if (c === '\\') { j += 2; value += 'x'; continue; }
      if (c === quote) break;
      value += c;
      j++;
    }
    // Look BACKWARD past whitespace for the construct that owns this string.
    let k = i - 1;
    while (k >= 0 && /\s/.test(source[k]!)) k--;
    const before = source.slice(Math.max(0, k - 11), k + 1);
    if (/\b(?:from|import)$/.test(before) || /\bimport\s*\($/.test(`${before}(`) || before.endsWith('import(')) {
      found.push(value);
    }
    return j + 1;
  };

  for (let i = 0; i < n; i++) {
    const c = source[i]!;
    const next = source[i + 1];
    if (c === '/' && next === '/') { while (i < n && source[i] !== '\n') i++; continue; }
    if (c === '/' && next === '*') { const e = source.indexOf('*/', i + 2); i = e === -1 ? n : e + 1; continue; }
    if (c === '/' && !/[\w)\]]/.test(prevSignificant)) {
      // Regex literal — skip to its unescaped closing slash so `/'/` cannot open a fake string.
      let j = i + 1;
      let inClass = false;
      while (j < n) {
        const d = source[j]!;
        if (d === '\\') { j += 2; continue; }
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) break;
        else if (d === '\n') break;
        j++;
      }
      i = j;
      prevSignificant = '/';
      continue;
    }
    if (c === '`') {
      // Template literal: skip it, but keep scanning `${…}` because code lives there.
      let j = i + 1;
      while (j < n) {
        const d = source[j]!;
        if (d === '\\') { j += 2; continue; }
        if (d === '`') break;
        if (d === '$' && source[j + 1] === '{') {
          let depth = 1;
          j += 2;
          const start = j;
          while (j < n && depth > 0) {
            if (source[j] === '{') depth++;
            else if (source[j] === '}') depth--;
            j++;
          }
          for (const spec of scanJsModuleSpecifiers(source.slice(start, j - 1))) found.push(spec);
          continue;
        }
        j++;
      }
      i = j;
      prevSignificant = '`';
      continue;
    }
    if (c === '"' || c === "'") { i = readString(i, c) - 1; prevSignificant = '"'; continue; }
    if (!/\s/.test(c)) prevSignificant = c;
  }
  return found;
}

/** External (absolute) module specifiers a JS file imports — those the import map cannot govern. */
export function externalJsImports(source: string): ExternalReference[] {
  return scanJsModuleSpecifiers(source)
    .filter((spec) => isExternalUrl(spec))
    .map((spec) => ({
      kind: 'module-specifier' as const,
      raw: spec,
      origin: originOf(spec),
      // A direct URL import is part of the module graph: without it the graph does not execute.
      criticality: 'boot' as const,
    }));
}
