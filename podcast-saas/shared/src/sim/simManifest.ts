/**
 * The canonical package manifest (Priority 7.3) — the single description of one immutable revision.
 *
 * WHY A MANIFEST AND NOT A DIRECTORY LISTING
 * A listing answers "what objects exist under this prefix". That is not the question. The question
 * is "is what is being served internally consistent" — does the entry HTML load the bridge these
 * bytes were built with, does every referenced asset exist, is each one served with the content type
 * it was stored as. A listing cannot answer any of those, and every incident this pipeline has had
 * in that family (old HTML with new JS, a bridge whose `?v=` pointed at bytes that had moved on)
 * was a consistency failure that a listing would have called healthy.
 *
 * HASHES ARE OF FINAL BYTES, ALWAYS
 * `hash` is the SHA-256 of the exact bytes stored at `path` — after every rewrite, injection and
 * transform. Not the source, not the LLM input, not the pre-injection HTML. Those other hashes are
 * useful and are kept, but under names that cannot be confused with this one: a manifest whose
 * hashes describe an earlier form of the file proves nothing about what a viewer receives, while
 * looking exactly like proof.
 *
 * VALIDATION IS PART OF THE TYPE, NOT A SEPARATE STEP
 * `validateManifest` is exhaustive and returns every problem rather than the first, because a
 * publication gate that reports one fault at a time turns a bad package into N round trips.
 */

import { sha256Hex } from './sha256.js';
import type { SimAspectProfile, SimQualityProfile } from './simIdentity.js';

/** Bumped when the manifest SHAPE changes incompatibly. Readers refuse an unknown version. */
export const SIM_MANIFEST_VERSION = 1 as const;

export type SimFileRole =
  /** The document the iframe loads. */
  | 'entry'
  /** Generated runtime: bridge.js, guidance.js. Never authored by the customer. */
  | 'runtime'
  /** Customer-supplied package content. */
  | 'asset'
  /** Captured poster renditions. */
  | 'poster'
  /** Canary evidence retained with the revision. */
  | 'canary';

export interface SimManifestFile {
  /** Normalized, prefix-relative POSIX path. Never absolute, never containing `.` or `..`. */
  path: string;
  role: SimFileRole;
  /** SHA-256 of the FINAL stored bytes, lowercase hex, 64 chars. */
  hash: string;
  bytes: number;
  contentType: string;
  /**
   * The `Cache-Control` this object is served with. Immutable revision paths never change, so
   * `immutable` is correct for everything EXCEPT anything that resolves a pointer — and no such
   * object lives inside a revision, which is the reason the layout is safe to cache this hard.
   */
  cacheControl: string;
}

export interface SimManifestVariant {
  /** Section id — the `?section=` the player dispatches on. */
  variantKey: string;
  /** Config hashes this variant has been prepared/captured for. */
  configHashes: string[];
}

export interface SimManifestPoster {
  identity: string;
  variantKey: string;
  configHash: string;
  aspectProfile: SimAspectProfile;
  qualityProfile: SimQualityProfile;
  /** Paths into `files`, one per rendition. */
  paths: string[];
}

export interface SimManifest {
  manifestVersion: typeof SIM_MANIFEST_VERSION;
  simulationId: string;
  projectId: string;
  revisionId: string;
  revisionNumber: number;

  /** Wire protocol the generated bridge speaks. */
  bridgeProtocolVersion: number;
  /** Version of the emitted child runtime source. */
  runtimeProtocolVersion: number;

  /** Prefix-relative path of the document the iframe loads. */
  entry: string;
  /** Prefix-relative paths of the generated runtime files. */
  runtime: string[];

  files: SimManifestFile[];
  variants: SimManifestVariant[];
  posters: SimManifestPoster[];
  qualityProfiles: SimQualityProfile[];

  /** Absolute URLs the package loads from outside the revision. Recorded, never fetched by us. */
  externalDependencies: string[];

  /**
   * Hashes of the INPUTS that produced generated files — deliberately separate from `files[].hash`.
   * Mixing them is how a manifest ends up proving something about a source nobody serves.
   */
  generatedFrom: {
    /** Hash of the LLM prompt/source context that produced the section bodies, when known. */
    llmInputHash?: string;
    /** Hash of the customer's uploaded bundle before any injection. */
    uploadHash?: string;
  };

  canary: {
    classification: string | null;
    ranAt: string | null;
    engine: string | null;
  };

  createdAt: string;
  createdBy: string | null;
}

// ─── Path normalisation ───────────────────────────────────────────────────────────────────────

/**
 * Normalise a manifest path, or return null when it is not representable.
 *
 * Rejects rather than repairs. A path containing `..` is not a path with a mistake in it — it is a
 * path whose author expected to escape the prefix, and silently flattening it would store the
 * object somewhere the author did not intend while reporting success.
 */
export function normalizeManifestPath(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  if (raw.includes('\0') || raw.includes('\\')) return null;
  const trimmed = raw.replace(/^\/+/, '');
  if (trimmed.length === 0) return null;
  const parts = trimmed.split('/');
  for (const p of parts) {
    if (p.length === 0) return null;      // empty segment: '//' or a trailing slash
    if (p === '.' || p === '..') return null;
  }
  return parts.join('/');
}

/**
 * The key a case-insensitive store would collide on.
 *
 * Object stores are case-SENSITIVE, but the caches, CDNs and filesystems in front of them are not
 * uniformly so. Two files differing only in case therefore serve unpredictably, and which one wins
 * can differ between environments — a class of bug that presents as "it works on staging".
 */
export const caseFoldKey = (path: string): string => path.toLowerCase();

// ─── Validation ───────────────────────────────────────────────────────────────────────────────

export type ManifestProblemCode =
  | 'unknown-manifest-version'
  | 'bad-path'
  | 'duplicate-path'
  | 'case-collision'
  | 'bad-hash'
  | 'bad-size'
  | 'missing-entry'
  | 'entry-not-html'
  | 'missing-runtime-file'
  | 'unreferenced-role'
  | 'missing-asset-reference'
  | 'content-type-mismatch'
  | 'poster-path-missing'
  | 'no-variants'
  | 'duplicate-variant';

export interface ManifestProblem {
  code: ManifestProblemCode;
  detail: string;
}

const HEX64 = /^[0-9a-f]{64}$/;

/** Extension → the content type this pipeline stores it as. Mismatches are a publication fault. */
const EXPECTED_CONTENT_TYPE: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  js: 'application/javascript',
  mjs: 'application/javascript',
  cjs: 'application/javascript',
  css: 'text/css',
  json: 'application/json',
  map: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  mp3: 'audio/mpeg',
  md: 'text/markdown; charset=utf-8',
};

const extOf = (path: string): string => {
  const i = path.lastIndexOf('.');
  return i === -1 ? '' : path.slice(i + 1).toLowerCase();
};

/**
 * Every problem with a manifest, in one pass.
 *
 * `referencedPaths` is what the entry HTML and the runtime actually load, extracted by the caller
 * (it needs the bytes, which this module deliberately does not take). Passing an empty set skips
 * the reference checks rather than reporting everything as unreferenced — a caller that cannot
 * extract references must not be told its package is broken.
 */
export function validateManifest(
  manifest: SimManifest,
  referencedPaths: ReadonlySet<string> = new Set(),
): ManifestProblem[] {
  const problems: ManifestProblem[] = [];
  const push = (code: ManifestProblemCode, detail: string): void => { problems.push({ code, detail }); };

  if (manifest.manifestVersion !== SIM_MANIFEST_VERSION) {
    push('unknown-manifest-version', String(manifest.manifestVersion));
    return problems;   // nothing below can be trusted about a shape we do not know
  }

  const byPath = new Map<string, SimManifestFile>();
  const byFold = new Map<string, string>();

  for (const f of manifest.files) {
    const norm = normalizeManifestPath(f.path);
    if (norm === null || norm !== f.path) {
      push('bad-path', `${JSON.stringify(f.path)} is not a normalized, prefix-relative path`);
      continue;
    }
    if (byPath.has(norm)) { push('duplicate-path', norm); continue; }
    const fold = caseFoldKey(norm);
    const clash = byFold.get(fold);
    if (clash !== undefined && clash !== norm) {
      push('case-collision', `${norm} collides with ${clash} on a case-insensitive store`);
    }
    byFold.set(fold, norm);
    byPath.set(norm, f);

    if (!HEX64.test(f.hash)) push('bad-hash', `${norm}: ${f.hash}`);
    if (!Number.isInteger(f.bytes) || f.bytes < 0) push('bad-size', `${norm}: ${f.bytes}`);

    const expected = EXPECTED_CONTENT_TYPE[extOf(norm)];
    if (expected && f.contentType !== expected) {
      push('content-type-mismatch', `${norm}: stored as ${f.contentType}, expected ${expected}`);
    }
  }

  const entry = normalizeManifestPath(manifest.entry);
  if (!entry || !byPath.has(entry)) {
    push('missing-entry', `entry ${JSON.stringify(manifest.entry)} is not in files[]`);
  } else if (!/\.html?$/i.test(entry)) {
    push('entry-not-html', entry);
  } else if (byPath.get(entry)!.role !== 'entry') {
    push('unreferenced-role', `${entry} is the entry but its role is ${byPath.get(entry)!.role}`);
  }

  for (const r of manifest.runtime) {
    const norm = normalizeManifestPath(r);
    if (!norm || !byPath.has(norm)) { push('missing-runtime-file', r); continue; }
    if (byPath.get(norm)!.role !== 'runtime') {
      push('unreferenced-role', `${norm} is listed as runtime but its role is ${byPath.get(norm)!.role}`);
    }
  }

  for (const ref of referencedPaths) {
    const norm = normalizeManifestPath(ref);
    if (!norm) { push('bad-path', `referenced: ${JSON.stringify(ref)}`); continue; }
    if (!byPath.has(norm)) push('missing-asset-reference', `${norm} is loaded but not in files[]`);
  }

  for (const p of manifest.posters) {
    for (const path of p.paths) {
      const norm = normalizeManifestPath(path);
      if (!norm || !byPath.has(norm)) push('poster-path-missing', `${p.identity}: ${path}`);
    }
  }

  if (manifest.variants.length === 0) push('no-variants', 'a package with no variants serves nothing');
  const seenVariant = new Set<string>();
  for (const v of manifest.variants) {
    if (seenVariant.has(v.variantKey)) push('duplicate-variant', v.variantKey);
    seenVariant.add(v.variantKey);
  }

  return problems;
}

export const manifestIsValid = (m: SimManifest, refs?: ReadonlySet<string>): boolean =>
  validateManifest(m, refs).length === 0;

// ─── Manifest hash ────────────────────────────────────────────────────────────────────────────

/**
 * A hash over the manifest's MEANING, not its JSON text.
 *
 * Key order, whitespace and the order of `files[]` must not change it — otherwise re-serialising an
 * unchanged revision mints a new identity, and "did anything change" becomes unanswerable. So the
 * canonical form sorts every list and emits only the fields that describe what is served.
 *
 * `createdAt`/`createdBy` are excluded on purpose: two byte-identical revisions published a minute
 * apart are the same package, and a hash that says otherwise cannot be used to detect a no-op
 * republish.
 */
export function canonicalizeManifest(m: SimManifest): string {
  const files = [...m.files]
    .map((f) => `${f.path} ${f.role} ${f.hash} ${f.bytes} ${f.contentType} ${f.cacheControl}`)
    .sort();
  const variants = [...m.variants]
    .map((v) => `${v.variantKey} ${[...v.configHashes].sort().join(',')}`)
    .sort();
  const posters = [...m.posters]
    .map((p) => `${p.identity} ${[...p.paths].sort().join(',')}`)
    .sort();

  return [
    `v:${m.manifestVersion}`,
    `sim:${m.simulationId}`,
    `rev:${m.revisionId}`,
    `n:${m.revisionNumber}`,
    `bridge:${m.bridgeProtocolVersion}`,
    `runtime:${m.runtimeProtocolVersion}`,
    `entry:${m.entry}`,
    `rt:[${[...m.runtime].sort().join(',')}]`,
    `q:[${[...m.qualityProfiles].sort().join(',')}]`,
    `ext:[${[...m.externalDependencies].sort().join(',')}]`,
    `files:[${files.join('|')}]`,
    `variants:[${variants.join('|')}]`,
    `posters:[${posters.join('|')}]`,
  ].join('\n');
}

export const computeManifestHash = (m: SimManifest): string => sha256Hex(canonicalizeManifest(m));
