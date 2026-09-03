/**
 * Storage reconciliation — the DB-vs-bucket diff the census could only describe (owner ruling
 * 2026-09-03, priority 4; `deploy/scripts/storage-census.sql` section G).
 *
 * The bucket census found ~10.3 GiB in 3,200 objects; the SQL census found candidates it could not
 * settle from rows alone: exports without a master, `sections/` under finished exports, captions
 * stored twice, avatar objects that outlive their project. Settling them needs both sides in one
 * place — every object under a prefix, and every key or prefix the database still names — and a
 * rule per family for what "orphan", "dangling" and "redundant" mean there.
 *
 * This module is the PURE half: given the objects and the references, it classifies. It never
 * lists, never heads, never deletes. The CLI (`scripts/storage-reconcile.ts`) gathers the inputs,
 * prints the classification, and — only with `--apply --delete=<family> --older-than=<age>` —
 * removes orphans and redundant objects older than the grace, through the guarded delete
 * chokepoint, never for `blobs/` (the blob sweeper's), never for `hls/` (the HLS retention's).
 */

export interface BucketObject {
  key: string;
  size: number | null;
  /** ISO timestamp, or null when the store did not say. */
  lastModified: string | null;
}

export interface FamilyRefs {
  /** Exact keys the database names. */
  keys: ReadonlySet<string>;
  /** Prefixes the database names (everything under them is referenced). */
  prefixes: ReadonlySet<string>;
}

export type Verdict = 'referenced' | 'orphan' | 'redundant';

export interface Classified extends BucketObject {
  verdict: Verdict;
  /** Why, in one phrase — what the report shows beside the key. */
  reason: string;
}

export interface FamilyReport {
  family: string;
  prefix: string;
  objects: number;
  bytes: number;
  referenced: Classified[];
  orphans: Classified[];
  redundant: Classified[];
  /** Database keys with no object behind them. */
  dangling: string[];
}

/** A family's own rule, applied to an object the references do not name outright. */
export type RedundancyRule = (obj: BucketObject, refs: FamilyRefs) => string | null;

const norm = (p: string): string => (p.endsWith('/') ? p : p + '/');

export function isUnderAny(key: string, prefixes: ReadonlySet<string>): boolean {
  for (const p of prefixes) if (key.startsWith(norm(p))) return true;
  return false;
}

/**
 * Classify one family. `referenced` when the DB names the key or a prefix over it; otherwise the
 * family rule may call it `redundant` (referenced, but no longer needed — e.g. a finished export's
 * `sections/`); otherwise `orphan`. Dangling = DB keys with no object.
 */
export function reconcileFamily(
  family: string,
  prefix: string,
  objects: readonly BucketObject[],
  refs: FamilyRefs,
  redundancy: RedundancyRule = () => null,
): FamilyReport {
  const referenced: Classified[] = [];
  const orphans: Classified[] = [];
  const redundant: Classified[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  for (const obj of objects) {
    seen.add(obj.key);
    bytes += obj.size ?? 0;
    const why = redundancy(obj, refs);
    if (why) { redundant.push({ ...obj, verdict: 'redundant', reason: why }); continue; }
    if (refs.keys.has(obj.key)) { referenced.push({ ...obj, verdict: 'referenced', reason: 'named by a row' }); continue; }
    if (isUnderAny(obj.key, refs.prefixes)) { referenced.push({ ...obj, verdict: 'referenced', reason: 'under a prefix a row names' }); continue; }
    orphans.push({ ...obj, verdict: 'orphan', reason: 'no row names it' });
  }
  const dangling = [...refs.keys].filter((k) => k.startsWith(norm(prefix)) && !seen.has(k)).sort();
  return { family, prefix, objects: objects.length, bytes, referenced, orphans, redundant, dangling };
}

/** Objects older than `olderThanMs` as of `now` — the only ones an apply may touch. */
export function olderThan(objects: readonly BucketObject[], olderThanMs: number, now = Date.now()): BucketObject[] {
  return objects.filter((o) => o.lastModified !== null && now - Date.parse(o.lastModified) >= olderThanMs);
}

/** `7d`, `36h`, `90m` → milliseconds; anything else is refused. */
export function parseAge(text: string): number {
  const m = /^(\d+)([dhm])$/.exec(text.trim());
  if (!m) throw new Error(`age must look like 7d, 36h or 90m — got '${text}'`);
  const n = Number(m[1]);
  return m[2] === 'd' ? n * 86_400_000 : m[2] === 'h' ? n * 3_600_000 : n * 60_000;
}

// ── Family rules ─────────────────────────────────────────────────────────────

/**
 * exports/{projectId}/{exportId}/sections/*.mp4 under an export that is READY with a master is
 * redundant: the master exists and the service already deletes sections on success — these are the
 * ones a crash left behind. `readyWithMaster` is the set of `exports/{pid}/{eid}` prefixes.
 */
export function exportSectionsRule(readyWithMaster: ReadonlySet<string>): RedundancyRule {
  return (obj) => {
    const m = /^(exports\/[^/]+\/[^/]+)\/sections\//.exec(obj.key);
    return m && readyWithMaster.has(m[1]!) ? 'sections/ of a finished export whose master exists' : null;
  };
}

/** captions/{projectId}/{videoId}/*.vtt for a video whose captions live INLINE (captions_vtt set). */
export function inlineCaptionsRule(videosWithInlineCaptions: ReadonlySet<string>): RedundancyRule {
  return (obj) => {
    const m = /^captions\/[^/]+\/([^/]+)\//.exec(obj.key);
    return m && videosWithInlineCaptions.has(m[1]!) ? 'a stored VTT for a video whose captions are inline' : null;
  };
}

/** thumbnails/{projectId}/* other than the CURRENT thumbnail_key: every writer minted a fresh uuid. */
export function supersededRule(what: string): RedundancyRule {
  return (obj, refs) => (refs.keys.has(obj.key) ? null : isUnderAny(obj.key, refs.prefixes) ? `a superseded ${what}` : null);
}

/** Families that are never an apply target, whatever the flags: another sweeper owns them. */
export const NEVER_DELETE_PREFIXES = ['blobs/', 'hls/', 'editions/', 'videos/'] as const;

export function deletable(family: string, prefix: string): boolean {
  return !NEVER_DELETE_PREFIXES.some((p) => prefix.startsWith(p)) && family !== 'multipart';
}
