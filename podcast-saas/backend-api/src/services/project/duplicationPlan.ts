/**
 * The vocabulary of a project duplication: what a plan IS, and the pure rewrites it depends on.
 *
 * Everything here is a pure function of its arguments — no database, no storage, no clock. That is
 * deliberate: the dry run is the test oracle for the whole feature, and an oracle that needs a
 * database to answer "what would this copy?" is not much of an oracle.
 *
 * THE ONE IDEA
 * A duplication is a map. Every row that gets a new identity contributes `oldId → newId`, and every
 * object that gets copied contributes `oldKey → newKey`. Once both maps exist, copying is
 * mechanical: insert each row with its ids looked up, rewrite each key column by lookup, and assert
 * afterwards that nothing resolved to something outside the new project.
 *
 * The maps are built BEFORE anything is written, which is what makes "bytes first, rows last"
 * possible at all: the destination storage keys contain ids that do not yet exist in any table.
 */

import { randomUUID } from 'node:crypto';
import { isUnderPrefix, reroot } from '../storage/prefixScope.js';

/** old id → new id. */
export type IdMap = ReadonlyMap<string, string>;

/**
 * One unit of byte copying the plan commits to.
 *
 * `package-root` is `prefix` minus the two subtrees a simulation's prefix shares with the system
 * (`revisions/` and `posters/`). It is a separate KIND rather than a prefix copy with an exclusion
 * list because the plan carries two copies rooted at the same simulation prefix — the whole active
 * revision tree, and the customer bundle around it — and `mapStorageKey` has to be able to tell
 * which one a given key belongs to.
 */
export interface StorageCopy {
  /** `object` = exactly this key; `prefix` = it and everything under `key + '/'`. */
  kind: 'object' | 'prefix' | 'package-root';
  from: string;
  to: string;
  /** Which part of the matrix asked for it — surfaced verbatim by the dry run. */
  reason: string;
  /**
   * Source prefixes INSIDE `from` that this copy must not carry (`prefix` copies only).
   *
   * The one user is a video's HLS tree, which holds retired-but-unswept run trees alongside the
   * live one. Those are named by `hls_retired_runs` rows, and those rows are correctly not copied —
   * so a copied retired tree would be referenced by no column and named by no retirement row, which
   * makes it unreapable for the lifetime of the deployment while inflating `objects_total`.
   *
   * Recorded on the plan rather than filtered at copy time so the dry run — the stored answer to
   * "what did this copy?" — says what was left behind and why.
   */
  exclude?: readonly string[];
}

/** Does an exclusion list keep this key out of a copy? */
export function isExcludedFromCopy(key: string, copy: StorageCopy): boolean {
  return (copy.exclude ?? []).some((p) => isUnderPrefix(key, p));
}

/** Subtrees of a simulation prefix owned by the system, not by the customer's bundle. */
export const PACKAGE_ROOT_EXCLUDED_SUBDIRS: readonly string[] = ['revisions', 'posters'];

/**
 * What a duplication WOULD do. Serialisable, so it is also what gets stored on the job row and
 * what an operator reads months later to answer "what did this actually copy?".
 */
export interface DuplicationPlan {
  sourceProjectId: string;
  targetProjectId: string;
  /** Every new identity minted, keyed by the id it replaces. */
  idMap: Record<string, string>;
  /** table → rows that will be inserted. */
  rowCounts: Record<string, number>;
  /**
   * table → source rows deliberately left behind, with the reason.
   *
   * `rows: null` means NOT COUNTED, which is a different fact from `rows: 0` and has to stay
   * distinguishable: `sim_rum_events` is keyed by package revision and has no project dimension to
   * count along, and a table that is not migrated yet cannot be counted either. Reporting either as
   * 0 would make the stored plan — the thing an operator reads to answer "what did this copy?" —
   * assert something nobody measured.
   */
  excluded: Record<string, { rows: number | null; why: string }>;
  storage: StorageCopy[];
  /**
   * A FLOOR on the bytes this will add, not a total: it sums the sizes the database already knows
   * (`video_files.file_size`), and says nothing about the HLS ladders, simulation packages and
   * posters that are copied by prefix. Naming it honestly matters because the quota guard compares
   * against it — under-counting means the guard under-refuses, which is the safe direction for a
   * guard that has no real plan-limit system behind it.
   */
  estimatedBytes: number;
  /**
   * Objects the storage layer cannot copy AT ALL, found before anything is written.
   *
   * NOT the 5 GiB single-`CopyObject` ceiling — the S3-family adapters cross that themselves by
   * re-issuing the copy as ranged `UploadPartCopy` parts, so a 6 or 10 GB master (which
   * `MAX_UPLOAD_BYTES` freely admits) is copyable and is deliberately absent from this list. The
   * ceiling here is what that fallback can address: 10,000 parts × a fixed 256 MiB, i.e.
   * `MULTIPART_COPY_MAX_BYTES` = 2.5 TiB. R2 requires uniform part sizes, so there is no "use
   * bigger parts" escape past it, and no retry can invent one.
   *
   * Only sizes the database already knows are checked (`video_files.file_size`), which is exactly
   * the set of objects that could ever approach it: every other key a project owns is an HLS
   * segment, a package file, a poster or an image, all of them orders of magnitude below.
   *
   * Expected to be empty on any shipped configuration — see `ProjectDuplicationService.oversizeRefusal`.
   */
  oversize: Array<{ key: string; bytes: number; what: string }>;
  /** Anything the plan had to decide for itself, or could not carry over. */
  warnings: string[];
}

// ── Identity ──────────────────────────────────────────────────────────────────────────────────

/** A mutable id map under construction. */
export class IdAllocator {
  private readonly map = new Map<string, string>();

  /** The new id for `oldId`, minting one on first ask. Stable within an allocator. */
  next(oldId: string): string {
    const existing = this.map.get(oldId);
    if (existing) return existing;
    const fresh = randomUUID();
    this.map.set(oldId, fresh);
    return fresh;
  }

  /** The new id for `oldId`, or undefined if it was never allocated. */
  get(oldId: string | null | undefined): string | undefined {
    return oldId ? this.map.get(oldId) : undefined;
  }

  /**
   * Remap a nullable foreign key that MUST stay inside the project.
   *
   * Throws rather than passing the original through, because passing it through is precisely the
   * defect this whole module exists to prevent: a copied row silently pointing at the original's
   * data. A null stays null — an absent reference is not an escaping one.
   */
  requireInternal(oldId: string | null | undefined, what: string): string | null {
    if (oldId === null || oldId === undefined) return null;
    const mapped = this.map.get(oldId);
    if (!mapped) {
      throw new Error(`duplication: ${what} references ${oldId}, which is not part of the copy`);
    }
    return mapped;
  }

  snapshot(): IdMap {
    return new Map(this.map);
  }

  toJSON(): Record<string, string> {
    return Object.fromEntries(this.map);
  }
}

// ── Storage keys ──────────────────────────────────────────────────────────────────────────────

/**
 * Where a storage key lands, given the copies the plan committed to — or null when the plan does
 * not copy it.
 *
 * Resolution is by LOOKUP against the plan, never by re-deriving the destination from the key's
 * shape. Two derivations of one destination is the same class of bug as two derivations of one
 * revision id: they agree until one of them is taught about a new key shape, and then a column
 * points at bytes that were never written.
 *
 * MOST SPECIFIC WINS, in three passes. An exact object copy beats everything — a poster's
 * destination path changes shape (its identity changes with the revision), so it must not be
 * re-rooted by the package copy that happens to contain it. A `prefix` copy — a revision tree —
 * beats the `package-root` copy of the simulation prefix that encloses it, for the same reason.
 */
export function mapStorageKey(key: string | null | undefined, copies: readonly StorageCopy[]): string | null {
  if (!key) return null;
  for (const c of copies) {
    if (c.kind === 'object' && c.from === key) return c.to;
  }
  for (const c of copies) {
    // An excluded subtree is NOT copied, so no destination exists to point a column at. Answering
    // otherwise would hand back a key nothing was ever written to.
    if (c.kind === 'prefix' && isUnderPrefix(key, c.from) && !isExcludedFromCopy(key, c)) {
      return reroot(key, c.from, c.to);
    }
  }
  for (const c of copies) {
    if (c.kind === 'package-root' && isUnderPrefix(key, c.from)) return reroot(key, c.from, c.to);
  }
  return null;
}

/**
 * Rewrite a key by substituting remapped ids into its PATH SEGMENTS.
 *
 * Used at plan time to derive destinations for the key shapes the product mints —
 * `videos/{projectId}/{uuid}.mp4`, `crop/{videoFileId}.json`, `hls/{videoFileId}/…`,
 * `simulations/{projectId}/{simulationId}/…`, `captions/{projectId}/{videoFileId}/{uuid}.vtt`.
 *
 * Substitution is per segment (and per segment STEM, for `{id}.json`), never a substring replace
 * over the whole string: a substring replace would happily rewrite the middle of an unrelated
 * filename that merely contains an id, and would do it silently.
 *
 * Returns null when the key embeds no remapped id at all — the caller must then mint a destination
 * explicitly rather than copy an object onto itself.
 */
export function rewriteKeyByIds(key: string, idMap: IdMap): string | null {
  let changed = false;
  const out = key.split('/').map((seg) => {
    const direct = idMap.get(seg);
    if (direct !== undefined) {
      changed = true;
      return direct;
    }
    const dot = seg.indexOf('.');
    if (dot > 0) {
      const mapped = idMap.get(seg.slice(0, dot));
      if (mapped !== undefined) {
        changed = true;
        return `${mapped}${seg.slice(dot)}`;
      }
    }
    return seg;
  });
  return changed ? out.join('/') : null;
}

/**
 * A destination for a key whose shape encodes no id we remap (the avatar library's
 * `simulations/avatar/{uuid}` prefixes and its image keys): keep the directory, mint a new
 * basename. The extension is preserved because content type is inferred from it on some paths.
 */
export function freshSiblingKey(key: string, newId: string = randomUUID()): string {
  const slash = key.lastIndexOf('/');
  const dir = slash >= 0 ? key.slice(0, slash + 1) : '';
  const base = slash >= 0 ? key.slice(slash + 1) : key;
  const dot = base.indexOf('.');
  return `${dir}${newId}${dot > 0 ? base.slice(dot) : ''}`;
}

// ── URLs that shadow keys ─────────────────────────────────────────────────────────────────────

/**
 * The public URL for `newKey`, given the URL that was minted for `oldKey`.
 *
 * By suffix substitution on the stored URL rather than by re-deriving through the adapter, because
 * the stored URL records which base the object was published under at the time — R2's public host,
 * Supabase's proxy, or a dev origin — and re-deriving would rewrite every copied row onto whatever
 * base happens to be configured now. Returns null when the URL does not end in the old key, which
 * is the caller's signal to fall back to the adapter rather than to guess.
 */
export function rebaseUrl(url: string | null | undefined, oldKey: string, newKey: string): string | null {
  if (!url) return null;
  const q = url.indexOf('?');
  const path = q >= 0 ? url.slice(0, q) : url;
  const query = q >= 0 ? url.slice(q) : '';
  if (!path.endsWith(oldKey)) return null;
  return `${path.slice(0, path.length - oldKey.length)}${newKey}${query}`;
}

/**
 * Re-root a URL whose path ENDS in a storage key the plan copies — or null when it does not.
 *
 * For the URLs that shadow a key COLUMN, `rebaseUrl` is the right tool: the key is known, so the
 * rewrite is a suffix substitution with nothing to guess. This is for the other kind — a URL stored
 * with no shadow column at all (`avatar_config.avatarCircles.faces[].imageUrl`,
 * `simulations.guidance_meta.mdUrl`, a legacy `timeline_sections.simulation_url`) — where the key
 * has to be RECOVERED from the URL first.
 *
 * The recovery is by SEGMENT SUFFIX, longest first, and the decision of which copy owns the
 * recovered key is delegated to `mapStorageKey` so it inherits the three-pass most-specific-wins
 * rule. That matters: the naive version — scan the copies in plan order and substring-replace the
 * first `from` that appears anywhere in the URL — is the exact rule `rewriteKeyByIds`'s doc argues
 * against. It can match mid-segment (`.../simulations/{p}/{s}extra/…`), and when a revision tree and
 * the package root that encloses it are both in the plan it rewrites through whichever happens to
 * come first rather than through the more specific one.
 *
 * The host is preserved (only the path tail is replaced) because the stored URL records which base
 * the object was published under, exactly as `rebaseUrl` does and for the same reason.
 */
export function rerootUrlThroughCopies(url: string, copies: readonly StorageCopy[]): string | null {
  const q = url.indexOf('?');
  const path = q >= 0 ? url.slice(0, q) : url;
  const query = q >= 0 ? url.slice(q) : '';
  const segments = path.split('/');
  // Longest suffix first: `simulations/{p}/{s}/revisions/{r}/index.html` must be offered whole,
  // before the shorter tails that would resolve against the wrong copy or not at all.
  for (let i = 0; i < segments.length; i++) {
    const candidate = segments.slice(i).join('/');
    if (candidate === '') continue;
    const mapped = mapStorageKey(candidate, copies);
    if (mapped !== null) {
      return `${path.slice(0, path.length - candidate.length)}${mapped}${query}`;
    }
  }
  return null;
}

/**
 * Remap the `?section=` parameter of a stored `simulation_url`.
 *
 * NOT cosmetic, and not named in the copy matrix. `variantKeyFor` reads this parameter as the
 * poster/pool VARIANT KEY, and the viewer's simulation pool dispatches on it. Left alone, every
 * section of the copy would announce the ORIGINAL's section id: two projects would collide on one
 * variant identity, the copy's posters would be captured under the original's key, and
 * `sections.controller`'s `urlIsOwn` check (`simulation_url.includes('section=' + section.id)`)
 * would answer "no" for every section of the copy — so the editor would regenerate every bridge
 * script it should have reused.
 *
 * THE OTHER HALF OF THIS IS IN THE BYTES, and neither half works alone. The generated `bridge.js`
 * keys `__SECTIONS__` by section id and `startScript` resolves against it, so remapping the
 * parameter without re-keying the bridge asks the copy's package for a section it has never heard
 * of — `SCRIPT_MISSING`, in every simulation section. `ProjectDuplicationService.
 * retargetCopiedPackages` re-keys the bridge for exactly that reason; changing either of these two
 * without the other reintroduces one of the two defects.
 */
export function rewriteSectionParam(url: string, idMap: IdMap): string {
  const q = url.indexOf('?');
  if (q < 0) return url;
  const params = new URLSearchParams(url.slice(q + 1));
  const section = params.get('section');
  if (!section) return url;
  const mapped = idMap.get(section);
  if (!mapped) return url;
  params.set('section', mapped);
  return `${url.slice(0, q)}?${params.toString()}`;
}

// ── Status resets ─────────────────────────────────────────────────────────────────────────────

/**
 * ONE RULE, one table: a status that asserts a JOB IS RUNNING becomes the status of a thing no job
 * has touched, because the copy has no job.
 *
 * WHY IT IS A TABLE AND NOT A FUNCTION PER PIPELINE. It was two functions — `projects.status` and
 * `projects.metadata_status` — and the four CHILD columns that need exactly the same treatment
 * (`video_files.hls_status`, `.crop_status`, `.captions_status`, `simulations.status`,
 * `corpora.ingestion_status`) were copied verbatim, because nothing connected them to the rule one
 * level up. A copy of a project mid-transcode therefore span forever on a job that does not exist,
 * and the next backend boot — `recoverStuckSimulations` / `recoverStuckHlsTranscodes` /
 * `recoverStuckCrops`, all of which match on `processing` — flipped the copy's simulation to
 * `failed — please re-upload`. A third hand-written rule is how that happens again.
 *
 * WHAT IS *NOT* RESET, and this is the deliberate half. `ready`, `draft`, `script_ready`,
 * `approved`, `none` describe DATA, and the data behind them is copied: a byte-for-byte clone of a
 * finished project that presents itself as an empty draft misdescribes itself, and these columns
 * are exactly what the tiles read.
 */
const IN_FLIGHT_RESETS = {
  /**
   * `failed` is in here and is not in flight: it is a fact about a RUN, and that run did not happen
   * to the copy. The other three are live-job claims.
   */
  project: { inFlight: ['ingesting', 'scripting', 'generating', 'failed'], reset: 'draft' },
  /** The thumbnail-metadata pipeline: only `processing` is a live job. */
  metadata: { inFlight: ['processing'], reset: 'none' },
  /** The HLS ladder. `pending` is the enum's own "no transcode has run", which is the copy's truth. */
  hls: { inFlight: ['processing'], reset: 'pending' },
  /** Smart crop. `none` is "never analysed". */
  crop: { inFlight: ['processing'], reset: 'none' },
  /** Auto captions. `none` is "never generated". */
  captions: { inFlight: ['processing'], reset: 'none' },
  /**
   * A simulation package has no "not ingested yet" state — the row cannot exist without bytes — so
   * the honest answer for a package captured MID-INGEST is the terminal one, with a reason the user
   * can act on. It is where the copy ended up anyway, at the next boot, via a message about a
   * process restart that never happened to it.
   */
  simulation: { inFlight: ['processing'], reset: 'failed' },
  /** Corpus ingestion. `pending` is the enum's default: nothing has read this file yet. */
  corpus: { inFlight: ['processing'], reset: 'pending' },
} as const satisfies Record<string, { inFlight: readonly string[]; reset: string }>;

/** Which pipeline's rule to apply. */
export type DuplicatedStatusKind = keyof typeof IN_FLIGHT_RESETS;

/** The status a copy carries, given the source's. */
export function duplicatedStatus(kind: DuplicatedStatusKind, status: string): string {
  const rule = IN_FLIGHT_RESETS[kind];
  return (rule.inFlight as readonly string[]).includes(status) ? rule.reset : status;
}

/** Was this status reset — i.e. does the copy need the job's leftovers cleared with it? */
export function statusWasReset(kind: DuplicatedStatusKind, status: string): boolean {
  return duplicatedStatus(kind, status) !== status;
}

export function duplicatedProjectStatus(status: string): string {
  return duplicatedStatus('project', status);
}

export function duplicatedMetadataStatus(status: string): string {
  return duplicatedStatus('metadata', status);
}

/**
 * The copy's title. `(copy)` rather than `Copy of …` so duplicates of duplicates read as a chain
 * and still sort next to their source in an alphabetical list.
 */
export function duplicatedTitle(title: string | null): string {
  const base = (title ?? '').trim();
  return base.length > 0 ? `${base} (copy)` : 'Untitled (copy)';
}
