/**
 * Making a COPIED simulation package's own bytes name the copy.
 *
 * THE INVARIANT THIS FILE EXISTS TO ENFORCE
 *   A duplicated package's published bytes name the COPY's ids — never the original's.
 *
 * Everything else about duplication is a row rewrite: allocate a new id, look it up, store it. A
 * simulation package is the one thing a project owns whose *content* encodes those ids, so a
 * verbatim byte copy is not a copy at all — it is a package that talks about a different project.
 * Three artefacts do it, each for its own reason:
 *
 *   • `bridge.js`   — `__SECTIONS__` is keyed by TIMELINE SECTION ID and `startScript(name)`
 *                     resolves against it. A copy carrying the original's keys answers
 *                     `SCRIPT_MISSING` for every section it is ever asked for. (See
 *                     `rewriteBridgeSectionIds`, which owns the marker grammar.)
 *   • `guidance.js` — every narration cue's `audioUrl` is baked in as a literal string pointing at
 *                     `simulations/{sourceProjectId}/…`. Those objects die with the original.
 *   • `manifest.json` — names the simulation, project, revision and every VARIANT KEY (again a
 *                     section id), and hashes the bytes above. It is what the NEXT publication of
 *                     the copy reads as its base.
 *
 * WHY REWRITE THE BYTES RATHER THAN LEAVE `?section=` ALONE
 * The alternative — copy bytes verbatim and skip the `?section=` remap so the original's ids keep
 * resolving — restores dispatch and breaks two other things that key on the SAME parameter:
 * `variantKeyFor` reads it as the poster/pool variant key (so the copy's posters, re-keyed onto the
 * copy's section ids at plan time, would never be looked up), and `sections.controller`'s `urlIsOwn`
 * test (`simulation_url.includes('section=' + section.id)`) would answer "no" for every copied
 * section, making the editor regenerate every bridge script it should have reused. Both axes —
 * dispatch AND identity — are satisfied only by the copy owning its ids everywhere, which means in
 * the bytes too.
 *
 * DIFFERENT BYTES ARE A DIFFERENT REVISION. Because the package genuinely changes, the copy's
 * `sim_revisions.manifest_hash` is RECOMPUTED from the rewritten manifest rather than inherited.
 * Inheriting it would assert byte identity that no longer holds — which is precisely the claim an
 * immutable-revision model rests on.
 *
 * Everything here is pure: no storage, no database, no clock. The I/O lives in
 * `ProjectDuplicationService.retargetCopiedPackages`.
 */

import { createHash } from 'node:crypto';
import { computeManifestHash, type SimManifest, type SimManifestFile } from 'shared/sim/simManifest';

/**
 * SHA-256 of raw bytes — `node:crypto`, for the reason `RevisionService.sha256Bytes` spells out:
 * `shared/sim/sha256.sha256Hex` takes a string and UTF-8 encodes it, which is lossy for binary. The
 * MANIFEST hash still goes through the shared pure-TS implementation (inside `computeManifestHash`),
 * because that one has to agree across backend, browser and bridge.
 */
const sha256Bytes = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

/** A URL rewriter: the copy's URL for a source URL, or null when the plan does not move it. */
export type UrlRewriter = (url: string) => string | null;

// ── guidance ──────────────────────────────────────────────────────────────────────────────────

/**
 * Re-root every `audioUrl` in a stored `simulations.guidance` document.
 *
 * `GuidanceEntry.audioUrl` is a full public URL under `simulations/{projectId}/{simId}/guidance/…`
 * with NO shadow key column, so the only thing that can move it is a rewriter over the plan's
 * copies. Left alone, deleting the original purges that prefix and the copy's narration 404s — and
 * `useProjectPlayer` plays it with a bare `new Audio(next.audioUrl)`, so there is no fallback and no
 * error anybody sees.
 *
 * Walks the document field by field (not a blanket text substitution) for the same reason
 * `rewriteAvatarConfig` does: `narration` is the author's prose and has no business being scanned
 * for storage keys. An entry this misses is caught by `assertNoEscapingReferences`.
 */
export function rewriteGuidanceAudioUrls(guidance: unknown, rewrite: UrlRewriter): unknown {
  if (!Array.isArray(guidance)) return guidance;
  let changed = false;
  const out = guidance.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    const e = entry as Record<string, unknown>;
    if (typeof e.audioUrl !== 'string') return entry;
    const moved = rewrite(e.audioUrl);
    if (moved === null || moved === e.audioUrl) return entry;
    changed = true;
    return { ...e, audioUrl: moved };
  });
  return changed ? out : guidance;
}

/**
 * Re-root every `audioUrl` baked into a generated `guidance.js` overlay.
 *
 * REWRITING THE DATABASE COLUMN IS NOT ENOUGH, and this is the half that actually fires the cue:
 * `wrapGuidanceCombined` serialises each entry's `audioUrl` into the overlay source, the overlay is
 * what the iframe loads, and `_fire` posts the URL it finds THERE. The column feeds the editor; the
 * overlay feeds the viewer.
 *
 * Matched as JSON string literals (`"audioUrl": "…"` and `audioUrl:"…"`, both spellings the
 * generator produces via `JSON.stringify`) rather than by re-generating the overlay: re-generating
 * would need the entries, the predicate bodies and today's template, and would replace a stored
 * artefact with a freshly-built one as a side effect of copying it.
 */
export function rewriteGuidanceOverlayUrls(source: string, rewrite: UrlRewriter): { source: string; changed: number } {
  let changed = 0;
  const out = source.replace(
    /("audioUrl"\s*:\s*")([^"\\]*)(")/g,
    (whole, head: string, url: string, tail: string) => {
      const moved = url ? rewrite(url) : null;
      if (moved === null || moved === url) return whole;
      changed += 1;
      // The rewritten URL is a storage URL, and storage keys contain no character JSON must escape
      // (`normalizeManifestPath` rejects backslashes outright); the guard keeps that a fact.
      if (/["\\]/.test(moved)) throw new Error(`guidance.js: refusing to bake an unescapable URL: ${moved}`);
      return `${head}${moved}${tail}`;
    },
  );
  return { source: out, changed };
}

// ── manifest ──────────────────────────────────────────────────────────────────────────────────

/** What the copy's revision is, as far as its manifest is concerned. */
export interface ManifestRetarget {
  simulationId: string;
  projectId: string;
  revisionId: string;
  revisionNumber: number;
  /** old section id → the copy's section id. Applied to EVERY `variantKey` the manifest holds. */
  sectionIds: ReadonlyMap<string, string>;
  /** manifest path → the bytes now stored there, for every file this duplication rewrote. */
  rewritten: ReadonlyMap<string, Buffer>;
}

/**
 * Is this parsed JSON shaped like a manifest we may rewrite?
 *
 * Narrow on purpose. A manifest of an unknown version, or one missing the fields the rewrite
 * touches, is left alone rather than half-updated: the copy then carries the original's manifest
 * (already the pre-existing behaviour) instead of one this code invented.
 */
export function isRetargetableManifest(value: unknown): value is SimManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const m = value as Partial<SimManifest>;
  return m.manifestVersion === 1
    && typeof m.simulationId === 'string'
    && typeof m.revisionId === 'string'
    && Array.isArray(m.files)
    && Array.isArray(m.variants);
}

/**
 * The copy's manifest, and the hash that describes it.
 *
 * `computeManifestHash` is the SAME function `RevisionService.validate` uses — reused rather than
 * re-derived, because a second hasher for one manifest is the defect its own doc argues against.
 * The hash lands on the copy's `sim_revisions.manifest_hash`, so the row and the bytes agree.
 *
 * EVERY `variantKey`, not only `variants[]`. A variant key IS a timeline section id, and the
 * manifest holds them in two places: `variants[]` and `posters[].variantKey`. Rewriting one and not
 * the other leaves a manifest that contradicts itself — the poster block would claim a capture for
 * a section the same document says the package does not have — and it leaves the SOURCE's section
 * ids inside the copy's published bytes, which is the one thing this file exists to prevent. A
 * poster entry's `identity` and `paths` are NOT touched here: both are derived from the package
 * revision, which changes by construction, and `planPosters` has already re-keyed the copy's
 * posters onto their own identities. (No publication path emits poster entries today, so this is
 * the latent half of the same rule rather than an observed break.)
 */
export function retargetManifest(
  manifest: SimManifest,
  to: ManifestRetarget,
): { manifest: SimManifest; manifestHash: string } {
  const files: SimManifestFile[] = manifest.files.map((f) => {
    const bytes = to.rewritten.get(f.path);
    if (!bytes) return f;
    // Hash of the FINAL stored bytes, which is what `SimManifestFile.hash` is defined to be.
    return { ...f, hash: sha256Bytes(bytes), bytes: bytes.length };
  });
  const next: SimManifest = {
    ...manifest,
    simulationId: to.simulationId,
    projectId: to.projectId,
    revisionId: to.revisionId,
    revisionNumber: to.revisionNumber,
    files,
    variants: manifest.variants.map((v) => ({
      ...v,
      variantKey: to.sectionIds.get(v.variantKey) ?? v.variantKey,
    })),
    posters: manifest.posters.map((p) => ({
      ...p,
      variantKey: to.sectionIds.get(p.variantKey) ?? p.variantKey,
    })),
  };
  return { manifest: next, manifestHash: computeManifestHash(next) };
}
