/**
 * CAPTURE PREPARATION — turn a stored package into an offline-capturable copy.
 *
 * This is the step between "the package bytes as storage holds them" and "the input mount the
 * network-less container serves". It does exactly two things, and it does them to the COPY:
 *
 *   1. materialise the trusted dependency closure into `__flowvid_vendor/<name>/<version>/…`;
 *   2. rewrite the capture copy's entry HTML — import map retargeted at that tree, and
 *      unsatisfiable external stylesheets neutralised so the captured layout is deterministic.
 *
 * THE STORED PACKAGE IS NEVER MUTATED. No storage write, no DB write, no republish: the same
 * bytes serve the viewer before and after an export. The export plan's frozen `servedSimUrl`
 * remains the sole identity — nothing here re-resolves a pointer, so a republish mid-export cannot
 * change what a running job captures.
 *
 * The provider stays free of any per-library knowledge: which packs exist and what they satisfy is
 * registry data, so adding a supported dependency never edits this file (or the provider).
 */

import {
  planCaptureDependencies,
  rewriteEntryHtmlForCapture,
  type CaptureDependencyClosure,
  type ExternalReference,
} from 'shared/sim/captureDependencies';

import { loadTrustedRegistry, type TrustedDependencyRegistry } from './trustedRegistry.js';

/** One staged file: package-root-relative path plus bytes. Matches the boundary's input shape. */
export interface PreparedFile {
  path: string;
  content: Buffer;
}

export interface OfflinePreparation {
  /** The package files to stage, vendor tree included and entry HTML rewritten. */
  files: PreparedFile[];
  /** Which import-map specifiers were retargeted, for the capture log. */
  rewrittenSpecifiers: string[];
  /** External stylesheets removed from the capture copy (never from storage). */
  neutralisedUrls: string[];
  /** Packs materialised, as `name@version`. */
  vendoredPacks: string[];
  /** Total bytes the vendor tree added. */
  vendoredBytes: number;
  /** External references nothing satisfied — the reason a package may be capture-incompatible. */
  unresolved: ExternalReference[];
  /** False when a BOOT-critical external reference remains: the capture cannot succeed. */
  bootComplete: boolean;
}

/** A package whose boot-critical dependencies cannot be satisfied offline. Classified, not generic. */
export class ExternalDependencyBlocked extends Error {
  readonly code = 'EXTERNAL_DEPENDENCY_BLOCKED' as const;
  constructor(
    message: string,
    readonly unresolved: readonly ExternalReference[],
  ) {
    super(message);
    this.name = 'ExternalDependencyBlocked';
  }
}

const isHtml = (path: string): boolean => /\.html?$/i.test(path);

/**
 * Prepare `files` (a package as stored) for offline capture of `entryPath`.
 *
 * Throws `ExternalDependencyBlocked` when a boot-critical reference cannot be satisfied — that is
 * a package the capture CANNOT render, and saying so here (with the exact URLs) is the difference
 * between an actionable failure and the dead canvas this whole change exists to end.
 */
export async function prepareOfflinePackage(
  files: readonly PreparedFile[],
  entryPath: string,
  opts: { registry?: TrustedDependencyRegistry } = {},
): Promise<OfflinePreparation> {
  const registry = opts.registry ?? (await loadTrustedRegistry());
  const entry = files.find((f) => f.path === entryPath);
  if (!entry) throw new Error(`offline preparation: entry ${entryPath} is not among the ${files.length} package files`);

  const html = entry.content.toString('utf8');
  const closure: CaptureDependencyClosure = planCaptureDependencies(html, registry.descriptors());

  if (!closure.bootComplete) {
    const blocking = closure.unresolved.filter((r) => r.criticality === 'boot');
    throw new ExternalDependencyBlocked(
      `simulation package requires ${blocking.length} external dependenc(ies) that no trusted pack satisfies, ` +
        'and the capture container has no network by design: ' +
        blocking.map((r) => `${r.kind} ${r.raw}`).slice(0, 5).join('; '),
      blocking,
    );
  }

  const vendored: PreparedFile[] = [];
  for (const descriptor of closure.packs) {
    vendored.push(...(await registry.materialise(descriptor)));
  }

  const { html: rewritten, rewrittenSpecifiers, neutralisedUrls } = rewriteEntryHtmlForCapture(html, closure, {
    neutraliseUnresolvedVisualRefs: true,
  });

  const out = files.map((f) =>
    f.path === entryPath ? { path: f.path, content: Buffer.from(rewritten, 'utf8') } : f,
  );
  // Any OTHER html in the package gets the same import-map treatment: a package may ship more than
  // one document, and a half-rewritten package would boot differently depending on which one ran.
  for (let i = 0; i < out.length; i++) {
    const f = out[i]!;
    if (f.path === entryPath || !isHtml(f.path)) continue;
    const other = f.content.toString('utf8');
    let otherClosure: CaptureDependencyClosure;
    try {
      otherClosure = planCaptureDependencies(other, registry.descriptors());
    } catch {
      continue; // a malformed secondary document is not the entry's problem; leave it verbatim
    }
    if (otherClosure.resolved.length === 0 && otherClosure.unresolved.length === 0) continue;
    const r = rewriteEntryHtmlForCapture(other, otherClosure, { neutraliseUnresolvedVisualRefs: true });
    out[i] = { path: f.path, content: Buffer.from(r.html, 'utf8') };
  }

  return {
    files: [...out, ...vendored],
    rewrittenSpecifiers,
    neutralisedUrls,
    vendoredPacks: closure.packs.map((p) => `${p.name}@${p.version}`),
    vendoredBytes: vendored.reduce((n, f) => n + f.content.byteLength, 0),
    unresolved: closure.unresolved,
    bootComplete: closure.bootComplete,
  };
}
