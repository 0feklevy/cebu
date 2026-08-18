/**
 * One-time migration: copy local-disk media (the R2-read-only fallback store) into the
 * configured cloud bucket, so media uploaded/transcoded before the storage switch keeps
 * playing once URLs point at the cloud.
 *
 *   Report:  pnpm --filter backend-api backfill:storage -- --target <adapter:bucket> --prefix videos/
 *   Apply:   pnpm --filter backend-api backfill:storage -- --target <adapter:bucket> --prefix videos/ --apply
 *
 * THIS TOOL HAS NO UNDO, AND NEITHER DOES THE BUCKET. It writes under keys IDENTICAL to the
 * ones live content is served from, and the object store has no versioning and no object lock
 * (RevisionService.ts:325, md-files/SIM-REBUILD-ROLLOUT.md:134). An overwrite with a stale
 * local copy is unrecoverable — there is no previous version to roll back to. The earlier
 * version of this script called itself "Safe" because it never *deletes*; overwriting a live
 * object in an unversioned bucket destroys exactly as much data as deleting it.
 *
 * So the shape is: nothing happens unless the operator asked for it, four separate ways.
 *
 *   --target <name>   the adapter+bucket the operator BELIEVES is configured. Resolved from
 *                     the environment and compared; a mismatch aborts before any write. This
 *                     is what stops a run with the wrong .env loaded from pouring a laptop's
 *                     local tree over the production bucket.
 *   --prefix <p>      required key scope, as a directory path (normalised to end with '/', so
 *                     it can never spill into a sibling tree). Nothing outside it is even
 *                     considered. There is no default and "" is rejected, because the
 *                     whole-bucket run is precisely the one that must never be reachable by
 *                     forgetting a flag.
 *   --limit <n>       count cap (default DEFAULT_BACKFILL_LIMIT). A plan bigger than the cap
 *                     REFUSES rather than uploading the first n — a silently truncated
 *                     migration is worse than one that did not start.
 *   --apply           the only flag that writes a byte. Without it this prints the plan,
 *                     naming every object it would OVERWRITE, and exits 0 having done nothing.
 *
 * The pure helpers and the dependency-injected `runBackfill` below are exported and unit-tested
 * (src/scripts/__tests__/backfillStorage.test.ts); the storage import loads lazily inside
 * main() so importing this module opens no client, and main() only runs on direct invocation.
 */
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/** Count cap applied when the operator does not choose one. */
export const DEFAULT_BACKFILL_LIMIT = 250;

// ── Arguments ────────────────────────────────────────────────────────────────

export interface BackfillArgs {
  apply: boolean;
  target: string;
  prefix: string;
  limit: number;
  /** Everything wrong with the invocation. Non-empty ⇒ the run refuses. */
  errors: string[];
}

export function parseBackfillArgs(argv: readonly string[]): BackfillArgs {
  const out: BackfillArgs = { apply: false, target: '', prefix: '', limit: DEFAULT_BACKFILL_LIMIT, errors: [] };
  let limitSeen: string | undefined;
  let prefixSeen = false;

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--target') out.target = argv[++i] ?? '';
    else if (a === '--prefix') { out.prefix = argv[++i] ?? ''; prefixSeen = true; }
    else if (a === '--limit') limitSeen = argv[++i];
    else out.errors.push(`unknown argument "${a}"`);
  }

  if (!out.target) out.errors.push('--target <adapter:bucket> is required — name the destination you expect, so a wrong .env aborts instead of writing');
  if (!prefixSeen || out.prefix === '') out.errors.push('--prefix <key-prefix> is required — there is no whole-bucket run');
  // A prefix is a DIRECTORY path, always normalised to end with '/'. Two reasons, both about
  // scope: the local walker descends a directory, so a partial segment ("vid") could never
  // produce the files a bare string-prefix filter would happily accept; and "videos" as a raw
  // string also matches a sibling "videos-old/" tree the operator never named.
  else if (!out.prefix.endsWith('/')) out.prefix = `${out.prefix}/`;
  if (limitSeen !== undefined) {
    const n = Number(limitSeen);
    if (!Number.isInteger(n) || n <= 0) out.errors.push(`--limit must be a positive integer (got "${limitSeen}")`);
    else out.limit = n;
  }
  return out;
}

// ── Planning ─────────────────────────────────────────────────────────────────

export interface LocalFile {
  /** Storage key, i.e. the path relative to the local base dir with '/' separators. */
  key: string;
  size: number;
}

/** `overwrite` is the destructive one: the bucket keeps no previous version to go back to. */
export type BackfillDisposition = 'create' | 'overwrite';

export interface BackfillCandidate extends LocalFile {
  disposition: BackfillDisposition;
}

export interface BackfillPlan {
  /** In-prefix files, sorted by key, truncated to the cap. */
  candidates: BackfillCandidate[];
  /** Files the walker found outside the requested prefix (never uploaded). */
  outOfPrefix: number;
  /** In-prefix files beyond the cap. Non-zero ⇒ apply refuses. */
  overLimit: number;
  creates: number;
  overwrites: number;
  bytes: number;
}

export function planBackfill(i: {
  files: readonly LocalFile[];
  existing: ReadonlySet<string>;
  prefix: string;
  limit: number;
}): BackfillPlan {
  const inPrefix = i.files.filter((f) => f.key.startsWith(i.prefix));
  // Sorted so two dry runs of the same tree produce byte-identical reports, and so the
  // cap always truncates the same tail rather than whatever order readdir happened to give.
  const sorted = [...inPrefix].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const candidates = sorted.slice(0, i.limit).map<BackfillCandidate>((f) => ({
    ...f,
    disposition: i.existing.has(f.key) ? 'overwrite' : 'create',
  }));
  return {
    candidates,
    outOfPrefix: i.files.length - inPrefix.length,
    overLimit: sorted.length - candidates.length,
    creates: candidates.filter((c) => c.disposition === 'create').length,
    overwrites: candidates.filter((c) => c.disposition === 'overwrite').length,
    bytes: candidates.reduce((n, c) => n + c.size, 0),
  };
}

export function contentTypeFor(key: string): string {
  const ext = key.includes('.') ? (key.split('.').pop()?.toLowerCase() ?? '') : '';
  const map: Record<string, string> = {
    m3u8: 'application/vnd.apple.mpegurl', ts: 'video/mp2t',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml',
    vtt: 'text/vtt', mp3: 'audio/mpeg', wav: 'audio/wav', json: 'application/json',
    html: 'text/html', css: 'text/css', js: 'application/javascript', wasm: 'application/wasm', pdf: 'application/pdf',
  };
  return map[ext] ?? 'application/octet-stream';
}

const mb = (n: number): string => `${(n / 1e6).toFixed(1)} MB`;

// ── Execution ────────────────────────────────────────────────────────────────

export interface BackfillDeps {
  /** Adapter + bucket actually resolved from the environment, e.g. "SupabaseStorageAdapter:media". */
  targetName: string;
  listLocalFiles(prefix: string): Promise<LocalFile[]>;
  /** Keys already present under the prefix. Throwing is fatal: see runBackfill. */
  listRemoteKeys(prefix: string): Promise<string[]>;
  upload(key: string, contentType: string, size: number): Promise<void>;
  log(line: string): void;
}

/**
 * Returns a process exit code. Zero writes happen on any path that does not reach the
 * `args.apply` branch, and that branch is guarded by every check above it.
 */
export async function runBackfill(args: BackfillArgs, deps: BackfillDeps): Promise<number> {
  if (args.errors.length > 0) {
    for (const e of args.errors) deps.log(`[backfill] ✗ ${e}`);
    deps.log('[backfill] usage: backfill-storage.ts --target <adapter:bucket> --prefix <key-prefix> [--limit n] [--apply]');
    return 2;
  }

  // The local disk is the SOURCE. Resolving it as the destination means the cloud
  // credentials are missing, and "copy local onto local" is never what was intended.
  if (deps.targetName.startsWith('LocalStorageAdapter')) {
    deps.log('[backfill] ✗ the resolved storage adapter is LocalStorageAdapter — that is the source of this copy, not a destination. Set cloud credentials first.');
    return 2;
  }
  if (args.target !== deps.targetName) {
    deps.log(`[backfill] ✗ target mismatch — you named "${args.target}", the loaded environment resolves to "${deps.targetName}". Refusing to write. Check which .env is loaded.`);
    return 2;
  }

  let existing: Set<string>;
  try {
    existing = new Set(await deps.listRemoteKeys(args.prefix));
  } catch (err) {
    // Without the remote listing the report cannot say which objects it would DESTROY.
    // A report that understates the damage is worse than no report, so this is fatal
    // even for a dry run.
    deps.log(`[backfill] ✗ could not list existing objects under "${args.prefix}": ${(err as Error).message?.slice(0, 160)}. Cannot tell new objects from overwrites; refusing.`);
    return 2;
  }

  const files = await deps.listLocalFiles(args.prefix);
  const plan = planBackfill({ files, existing, prefix: args.prefix, limit: args.limit });

  deps.log(`[backfill] target ${deps.targetName}  prefix "${args.prefix}"  cap ${args.limit}  mode ${args.apply ? 'APPLY' : 'REPORT'}`);
  deps.log(`[backfill] ${plan.candidates.length} file(s), ${mb(plan.bytes)} — ${plan.creates} new, ${plan.overwrites} OVERWRITE (unversioned bucket: no undo)`);
  if (plan.outOfPrefix > 0) deps.log(`[backfill] ${plan.outOfPrefix} local file(s) outside the prefix were ignored`);
  for (const c of plan.candidates) {
    deps.log(`[backfill]   ${c.disposition === 'overwrite' ? 'OVERWRITE' : 'create   '} ${c.key} (${mb(c.size)})`);
  }

  if (plan.candidates.length === 0) {
    // "0 files" reads as "the tree is empty" but is far more often "the prefix is wrong".
    // --prefix is walked as a directory path, so a partial segment (`vid` for `videos/`)
    // matches nothing at all — say so rather than let the operator read it as done.
    deps.log(`[backfill] no local file matched "${args.prefix}". --prefix is a directory path under the local media root, not a partial name — check the spelling before concluding there is nothing to copy.`);
  }

  if (plan.overLimit > 0) {
    deps.log(`[backfill] ✗ ${plan.candidates.length + plan.overLimit} file(s) match the prefix but the cap is ${args.limit}. Refusing — a half-migrated prefix is harder to reason about than an unstarted one. Narrow --prefix, or raise --limit deliberately.`);
    return 2;
  }

  if (!args.apply) {
    deps.log('[backfill] REPORT only — nothing was written. Read the OVERWRITE lines above, then re-run the same command with --apply.');
    return 0;
  }

  let count = 0, bytes = 0, failed = 0;
  for (const c of plan.candidates) {
    try {
      await deps.upload(c.key, contentTypeFor(c.key), c.size);
      count += 1; bytes += c.size;
      if (count % 25 === 0) deps.log(`[backfill]   ${count}/${plan.candidates.length} files, ${mb(bytes)} …`);
    } catch (err) {
      failed += 1;
      deps.log(`[backfill]   FAILED ${c.key}: ${(err as Error).message?.slice(0, 140)}`);
    }
  }
  deps.log(`[backfill] ${failed === 0 ? '✓' : '⚠'} done — ${count} file(s) (${mb(bytes)}) uploaded, ${failed} failed.`);
  return failed > 0 ? 1 : 0;
}

// ── CLI wiring ───────────────────────────────────────────────────────────────

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

/**
 * The destination the loaded environment actually resolves to. The bucket is read the same
 * way the adapters read it, so `--target` names a bucket rather than just a class — two
 * environments pointing the same adapter at different buckets must not compare equal.
 */
function resolveTargetName(adapterName: string): string {
  const bucket =
    adapterName === 'SupabaseStorageAdapter' ? (process.env.SUPABASE_STORAGE_BUCKET ?? 'media')
    : adapterName === 'R2StorageAdapter' ? (process.env.R2_BUCKET_NAME ?? 'podcast-saas')
    : '';
  return bucket ? `${adapterName}:${bucket}` : adapterName;
}

async function main(): Promise<number> {
  const args = parseBackfillArgs(process.argv.slice(2));
  const { LOCAL_STORAGE_BASE_DIR } = await import('../services/storage/localStoragePaths.js');
  const { getStorageAdapter } = await import('../services/storage/getStorageAdapter.js');
  const storage = getStorageAdapter();

  return runBackfill(args, {
    targetName: resolveTargetName(storage.constructor.name),
    async listLocalFiles(prefix) {
      const out: LocalFile[] = [];
      // Walk only the subtree the prefix names — a whole-tree walk of a media disk is slow
      // and would stat files the run can never touch.
      const root = join(LOCAL_STORAGE_BASE_DIR, ...prefix.split('/').filter(Boolean));
      for await (const file of walk(root)) {
        const key = relative(LOCAL_STORAGE_BASE_DIR, file).split(sep).join('/');
        out.push({ key, size: (await stat(file)).size });
      }
      return out;
    },
    listRemoteKeys: (prefix) => storage.listObjects(prefix),
    async upload(key, contentType, size) {
      await storage.uploadStream(key, createReadStream(join(LOCAL_STORAGE_BASE_DIR, ...key.split('/'))), contentType, size);
    },
    log: (line) => console.log(line),
  });
}

// Only run when invoked directly, so tests can import the helpers above without a migration.
if (process.argv[1] && process.argv[1].includes('backfill-storage')) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((e) => { console.error(e); process.exitCode = 1; });
}
