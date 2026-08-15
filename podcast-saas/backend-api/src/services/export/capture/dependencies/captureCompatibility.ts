/**
 * CAPTURE-COMPATIBILITY VALIDATION — the answer to "will this package render offline?", asked at
 * PUBLISH time instead of months later during an export.
 *
 * The v0.1.26 incident's real cost was not that three.js was missing. It was that nothing ever
 * asked. A package referencing a CDN published green, served fine in the viewer (which has a
 * network), and only failed when an export finally tried to render it inside `--network none` —
 * as a dead black canvas with no explanation. Generation guidance can ask models not to do this;
 * only a validator can make it impossible to ship unnoticed.
 *
 * The verdict is deliberately three-valued rather than a boolean, because "this package cannot
 * render offline" and "this package will render, with a substituted font" are different products
 * decisions and collapsing them would either block harmless packages or ship broken ones.
 */

import {
  externalJsImports,
  isExternalUrl,
  planCaptureDependencies,
  scanTags,
  type ExternalReference,
  type TrustedDependencyDescriptor,
} from 'shared/sim/captureDependencies';

export type CaptureCompatibility =
  /** Renders offline from its own bytes plus trusted pinned packs. */
  | 'compatible'
  /** Renders, but a non-boot external reference was dropped (e.g. a remote icon font). */
  | 'compatible-with-substitutions'
  /** Cannot render offline: a boot-critical reference nothing trusted satisfies. */
  | 'incompatible';

export interface CaptureCompatibilityReport {
  verdict: CaptureCompatibility;
  /** Human-readable, specific, and safe to show an author. */
  reasons: string[];
  /** Trusted packs this package would need at capture time. */
  requiredPacks: string[];
  /** Every external reference found, classified. */
  external: ExternalReference[];
  /** Package-relative paths the entry references that do NOT exist in the package. */
  missingLocalRefs: string[];
}

/** A package as the validator sees it: paths plus bytes, package-root-relative. */
export interface ValidatablePackage {
  entryPath: string;
  files: ReadonlyMap<string, Buffer>;
}

/** Resolve a package-relative reference from a document, rejecting anything that escapes the root. */
export function resolvePackageRef(fromDocument: string, ref: string): string | null {
  if (!ref || isExternalUrl(ref) || ref.startsWith('data:') || ref.startsWith('#')) return null;
  const base = fromDocument.includes('/') ? fromDocument.slice(0, fromDocument.lastIndexOf('/')) : '';
  const raw = ref.split('?')[0]!.split('#')[0]!;
  const segments = (raw.startsWith('/') ? raw.slice(1) : `${base ? `${base}/` : ''}${raw}`).split('/');
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      // Escaping the package root is not a missing file, it is an invalid package.
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.length > 0 ? out.join('/') : null;
}

/**
 * Validate one package for offline capture.
 *
 * Checks, in the order an author would want them: the entry exists; its LOCAL references exist;
 * its EXTERNAL references are either satisfiable from a trusted pack or non-boot. A package that
 * fails is told exactly which reference and why, never "capture failed".
 */
export function validateCaptureCompatibility(
  pkg: ValidatablePackage,
  registry: readonly TrustedDependencyDescriptor[],
): CaptureCompatibilityReport {
  const reasons: string[] = [];
  const missingLocalRefs: string[] = [];
  /** References that resolve outside the package root — an invalid package, not a missing file. */
  let escapingRefs = 0;

  const entryBytes = pkg.files.get(pkg.entryPath);
  if (!entryBytes) {
    return {
      verdict: 'incompatible',
      reasons: [`entry document ${pkg.entryPath} is not in the package`],
      requiredPacks: [],
      external: [],
      missingLocalRefs: [],
    };
  }

  const html = entryBytes.toString('utf8');
  let closure;
  try {
    closure = planCaptureDependencies(html, registry);
  } catch (err) {
    return {
      verdict: 'incompatible',
      reasons: [`entry document is malformed: ${err instanceof Error ? err.message : String(err)}`],
      requiredPacks: [],
      external: [],
      missingLocalRefs: [],
    };
  }

  // Local references the entry declares must actually exist — a missing `./src/main.js` is the
  // same dead canvas as a missing CDN module, and just as invisible until export.
  for (const tag of scanTags(html, new Set(['script', 'link']))) {
    const ref = tag.name === 'script' ? tag.attrs.src : tag.attrs.href;
    if (!ref) continue;
    if (tag.name === 'link') {
      const rel = (tag.attrs.rel ?? '').toLowerCase();
      if (!rel.includes('stylesheet') && !rel.includes('modulepreload') && !rel.includes('preload')) continue;
    }
    const resolved = resolvePackageRef(pkg.entryPath, ref);
    if (resolved === null) {
      if (!isExternalUrl(ref) && !ref.startsWith('data:') && !ref.startsWith('#') && ref.includes('..')) {
        escapingRefs += 1;
        reasons.push(`reference ${JSON.stringify(ref)} escapes the package root`);
      }
      continue;
    }
    if (!pkg.files.has(resolved)) missingLocalRefs.push(resolved);
  }

  // An import map governs BARE specifiers only. A module naming an absolute URL directly
  // bypasses it, so the HTML scan alone would call such a package compatible — and it would die
  // inside --network none exactly as v0.1.26 did.
  const jsExternals: ExternalReference[] = [];
  for (const [path, bytes] of pkg.files) {
    if (!/\.m?js$/i.test(path)) continue;
    for (const ref of externalJsImports(bytes.toString('utf8'))) {
      if (registry.some((d) => d.satisfies.some((b) => ref.raw.startsWith(b)))) continue;
      jsExternals.push(ref);
      reasons.push(
        `${path} imports ${ref.raw} directly; an import map cannot redirect an absolute URL and the ` +
          'capture container has no network access',
      );
    }
  }

  for (const ref of closure.unresolved) {
    if (ref.criticality === 'boot') {
      reasons.push(
        `${ref.kind} ${ref.raw} is required to boot and no trusted dependency pack provides it — ` +
          'the capture container has no network access',
      );
    } else if (ref.criticality === 'visual') {
      reasons.push(
        `${ref.kind} ${ref.raw} is external; capture substitutes a local fallback, so the exported ` +
          'video may differ slightly from the live viewer',
      );
    }
  }
  for (const missing of missingLocalRefs) {
    reasons.push(`referenced package file is missing: ${missing}`);
  }

  const verdict: CaptureCompatibility =
    !closure.bootComplete || missingLocalRefs.length > 0 || escapingRefs > 0 || jsExternals.length > 0
      ? 'incompatible'
      : closure.unresolved.some((r) => r.criticality === 'visual')
        ? 'compatible-with-substitutions'
        : 'compatible';

  return {
    verdict,
    reasons,
    requiredPacks: closure.packs.map((p) => `${p.name}@${p.version}`),
    external: [...closure.resolved.map((r) => ({
      kind: 'importmap' as const,
      raw: r.entry.target,
      origin: null,
      criticality: 'boot' as const,
    })), ...closure.unresolved, ...jsExternals],
    missingLocalRefs,
  };
}
