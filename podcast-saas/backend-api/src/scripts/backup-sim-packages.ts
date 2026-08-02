/**
 * Backup / restore / verify the STORED (not served) rollback set of every ready simulation.
 * This is the rollback companion to rebuild-sim-bridges.ts, which has no backup of its own.
 *
 *   Backup (run BEFORE a rebuild --apply):
 *     tsx --env-file=../.env src/scripts/backup-sim-packages.ts backup ./sim-backup-<date>
 *   Rehearse a backup without writing anything:
 *     tsx --env-file=../.env src/scripts/backup-sim-packages.ts backup ./sim-backup-<date> --dry-run
 *   Verify a backup on disk against its own manifest hashes (writes nothing, touches no storage):
 *     tsx src/scripts/backup-sim-packages.ts verify ./sim-backup-<date>
 *   Verify the backup AND compare it against what is live in storage (still writes nothing):
 *     tsx --env-file=../.env src/scripts/backup-sim-packages.ts verify ./sim-backup-<date> --live
 *   Restore (rollback a rebuild):
 *     tsx --env-file=../.env src/scripts/backup-sim-packages.ts restore ./sim-backup-<date>
 *   Rehearse a restore (pre-flight every byte, upload nothing):
 *     tsx --env-file=../.env src/scripts/backup-sim-packages.ts restore ./sim-backup-<date> --dry-run
 *
 * It reads/writes the exact stored objects via the storage adapter (storage.readObject /
 * uploadFile), so a restore reproduces the pre-rebuild bytes byte-for-byte, and every restored
 * object is READ BACK and hash-compared before the run is called successful.
 *
 * Rollback set per package: bridge.js + the entry HTML (the two files rebuild-sim-bridges.ts
 * overwrites) + guidance.js when present. guidance.js is in the set because the entry HTML that
 * rebuild rewrites is the same file that carries the `guidance.js?v=<hash>` tag: restoring an old
 * entry HTML without the guidance.js it was minted against leaves the tag pointing at a hash that
 * no longer describes the bytes being served. Every user asset is left alone by both tools.
 *
 * Everything above `main()` is pure or dependency-injected so it can be unit-tested without any
 * database, storage or filesystem (see src/scripts/lib/__tests__/simRolloutTooling.test.ts). The
 * db/storage/SimulationService imports are deliberately loaded lazily INSIDE main() so importing
 * this module never opens a database client.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';

// ── Manifest shape ────────────────────────────────────────────────────────────

/** Manifest schema version. v1 recorded byte counts only and is not restorable (no hashes). */
export const MANIFEST_VERSION = 2;

export type FileRole = 'bridge' | 'entry' | 'guidance';

/** One package as the backup sees it — entry path already derived by the caller. */
export interface PlannedPackage {
  simId: string;
  name: string;
  storagePrefix: string;
  /** Entry HTML path relative to storagePrefix, or null when underivable. */
  entryRel: string | null;
}

export interface PlannedFile {
  role: FileRole;
  key: string;
  /** false ⇒ absence is normal (not every package has guidance) and is not a backup failure. */
  required: boolean;
}

export interface ManifestEntry {
  simId: string;
  name: string;
  role: FileRole;
  /** Storage key. Also the path of the file inside the backup directory. */
  key: string;
  local: string;
  bytes: number;
  /** Full sha256 of the captured bytes. Restore refuses on any mismatch. */
  sha256: string;
}

export interface UnreadableFile { simId: string; name: string; role: FileRole; key: string; reason: string }
export interface SkippedPackage { simId: string; name: string; reason: string }

export interface BackupManifest {
  version: number;
  at: string;
  /** false ⇒ a required file was not captured. A restore MUST refuse. */
  complete: boolean;
  entries: ManifestEntry[];
  unreadable: UnreadableFile[];
  skipped: SkippedPackage[];
}

// ── Injected ports (so the logic is testable without real storage/fs) ─────────

export interface BackupStorage {
  readObject(key: string): Promise<Buffer>;
  uploadFile(key: string, data: Buffer, contentType: string): Promise<unknown>;
}

export interface BackupFs {
  exists(path: string): boolean;
  /** Entry names in a directory; [] when the directory does not exist. */
  listDir(path: string): string[];
  mkdirp(path: string): void;
  writeFile(path: string, data: Buffer | string): void;
  readFile(path: string): Buffer;
  rename(from: string, to: string): void;
}

export type Log = (line: string) => void;

export const nodeBackupFs: BackupFs = {
  exists: (p) => existsSync(p),
  listDir: (p) => (existsSync(p) ? readdirSync(p) : []),
  mkdirp: (p) => { mkdirSync(p, { recursive: true }); },
  writeFile: (p, d) => { writeFileSync(p, d); },
  readFile: (p) => readFileSync(p),
  rename: (a, b) => { renameSync(a, b); },
};

// ── Pure helpers ──────────────────────────────────────────────────────────────

export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Content type each role must be re-uploaded with — identical to what the live generation path
 *  and rebuild-sim-bridges.ts write, so a restore never changes how the object is served.
 *  (Mirrors getSimulationContentType for .html/.js; kept local so this module imports no service.) */
export function contentTypeForRole(role: FileRole): string {
  return role === 'entry' ? 'text/html; charset=utf-8' : 'application/javascript';
}

/** The storage keys a byte-exact rollback of one package needs. */
export function planPackageFiles(storagePrefix: string, entryRel: string | null): PlannedFile[] {
  const files: PlannedFile[] = [{ role: 'bridge', key: `${storagePrefix}/bridge.js`, required: true }];
  if (entryRel) files.push({ role: 'entry', key: `${storagePrefix}/${entryRel}`, required: true });
  // Optional: most packages have no guidance. Captured because rebuild rewrites the entry HTML
  // that carries the guidance.js?v=<hash> tag — restoring the HTML alone would leave that tag
  // describing bytes that are no longer there.
  files.push({ role: 'guidance', key: `${storagePrefix}/guidance.js`, required: false });
  return files;
}

const SAFE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

/**
 * Guard for property "restore does not alter unrelated files": a manifest is just JSON on disk,
 * so every key it names is treated as untrusted. Returns a problem string, or null when the entry
 * is safe to read from the backup directory and write back to storage.
 */
export function checkManifestEntry(e: ManifestEntry): string | null {
  if (!e || typeof e.key !== 'string' || !e.key) return 'entry has no storage key';
  if (e.key !== e.local) return `${e.key}: local path "${e.local}" does not match the storage key`;
  if (e.key.includes('\\')) return `${e.key}: backslash in key`;
  if (e.key.includes('//')) return `${e.key}: empty path segment`;
  if (e.key.split('/').some((s) => s === '..' || s === '.')) return `${e.key}: path traversal segment`;
  if (!SAFE_KEY_RE.test(e.key)) return `${e.key}: key has characters outside [A-Za-z0-9._-/]`;
  if (e.role === 'bridge' && !e.key.endsWith('/bridge.js')) return `${e.key}: role "bridge" but not a bridge.js key`;
  if (e.role === 'guidance' && !e.key.endsWith('/guidance.js')) return `${e.key}: role "guidance" but not a guidance.js key`;
  if (e.role === 'entry' && !/\.(html?|xhtml)$/i.test(e.key)) return `${e.key}: role "entry" but not an HTML key`;
  if (e.role !== 'bridge' && e.role !== 'entry' && e.role !== 'guidance') return `${e.key}: unknown role "${String(e.role)}"`;
  if (typeof e.sha256 !== 'string' || !SHA256_RE.test(e.sha256)) return `${e.key}: missing or malformed sha256`;
  if (typeof e.bytes !== 'number' || e.bytes < 0) return `${e.key}: missing or negative byte count`;
  return null;
}

export function buildBackupManifest(input: {
  at: string;
  entries: ManifestEntry[];
  unreadable: UnreadableFile[];
  skipped: SkippedPackage[];
}): BackupManifest {
  return {
    version: MANIFEST_VERSION,
    at: input.at,
    // A run that captured nothing is NOT a successful backup — an empty rollback set restores
    // nothing while reading as a green "backed up 0 files".
    complete: input.unreadable.length === 0 && input.entries.length > 0,
    entries: input.entries,
    unreadable: input.unreadable,
    skipped: input.skipped,
  };
}

export interface VerifyResult { ok: boolean; checked: number; problems: string[] }

/**
 * Compare the bytes on disk against the manifest hashes. Writes nothing and touches no storage.
 * This is the whole of `verify` mode and the mandatory pre-flight of `restore`.
 */
export function verifyManifest(
  manifest: BackupManifest | null | undefined,
  readLocal: (local: string) => Buffer,
): VerifyResult {
  const problems: string[] = [];
  if (!manifest || typeof manifest !== 'object') return { ok: false, checked: 0, problems: ['manifest is not an object'] };
  if (manifest.version !== MANIFEST_VERSION) {
    problems.push(
      `manifest version ${String(manifest.version)} — this tool writes and restores v${MANIFEST_VERSION}. ` +
      'v1 backups recorded byte counts only (no hashes) and cannot be verified; re-take the backup.',
    );
    return { ok: false, checked: 0, problems };
  }
  if (manifest.complete === false) {
    problems.push('manifest is marked INCOMPLETE — the backup run did not capture every required file');
  }
  const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
  if (entries.length === 0) problems.push('manifest has no entries — nothing to restore');

  const seen = new Set<string>();
  let checked = 0;
  for (const e of entries) {
    const unsafe = checkManifestEntry(e);
    if (unsafe) { problems.push(unsafe); continue; }
    if (seen.has(e.key)) { problems.push(`${e.key}: duplicated in the manifest — which copy wins is undefined`); continue; }
    seen.add(e.key);

    let buf: Buffer;
    try { buf = readLocal(e.local); }
    catch (err) { problems.push(`${e.key}: file missing from the backup — ${(err as Error).message.slice(0, 100)}`); continue; }
    if (buf.length !== e.bytes) {
      problems.push(`${e.key}: size mismatch — manifest ${e.bytes}b, on disk ${buf.length}b`);
      continue;
    }
    const actual = sha256(buf);
    if (actual !== e.sha256) {
      problems.push(`${e.key}: HASH MISMATCH — manifest ${e.sha256.slice(0, 16)}…, on disk ${actual.slice(0, 16)}…`);
      continue;
    }
    checked++;
  }
  return { ok: problems.length === 0, checked, problems };
}

export interface RestorePlan { items: ManifestEntry[]; problems: string[] }

/** The ordered set of objects a restore will write. Only ever entries that passed the safety check. */
export function planRestore(manifest: BackupManifest | null | undefined): RestorePlan {
  const problems: string[] = [];
  const items: ManifestEntry[] = [];
  const entries = Array.isArray(manifest?.entries) ? manifest!.entries : [];
  const seen = new Set<string>();
  for (const e of entries) {
    const unsafe = checkManifestEntry(e);
    if (unsafe) { problems.push(unsafe); continue; }
    if (seen.has(e.key)) { problems.push(`${e.key}: duplicated in the manifest`); continue; }
    seen.add(e.key);
    items.push(e);
  }
  // bridge.js before the entry HTML, so a run interrupted between the two leaves the HTML still
  // pointing at the hash of the bridge that is already in place, never at one that is not there.
  const order: Record<FileRole, number> = { guidance: 0, bridge: 1, entry: 2 };
  items.sort((a, b) => (a.key === b.key ? 0 : order[a.role] - order[b.role]));
  return { items, problems };
}

export type TargetState = 'empty' | 'has-manifest' | 'has-incomplete-manifest' | 'non-empty';

export function inspectBackupTarget(fs: BackupFs, dir: string): TargetState {
  if (fs.exists(join(dir, 'manifest.json'))) return 'has-manifest';
  if (fs.exists(join(dir, 'manifest.incomplete.json'))) return 'has-incomplete-manifest';
  return fs.listDir(dir).length > 0 ? 'non-empty' : 'empty';
}

/**
 * Never overwrite an existing backup. Re-running into the same directory AFTER a rebuild --apply
 * (shell history, tab completion) would replace the only copy of the pre-rebuild bytes with the
 * post-rebuild ones and make rollback permanently impossible — silently. A directory that is
 * merely non-empty counts too: that is what a backup interrupted before the manifest looks like.
 */
export function decideOverwrite(state: TargetState, force: boolean): { allowed: boolean; reason: string } {
  if (state === 'empty') return { allowed: true, reason: '' };
  const what =
    state === 'has-manifest' ? 'a complete backup (manifest.json present)'
      : state === 'has-incomplete-manifest' ? 'a FAILED backup (manifest.incomplete.json present)'
        : 'files from an earlier, interrupted backup (no manifest, directory not empty)';
  if (force) return { allowed: true, reason: `--force: overwriting ${what}` };
  return {
    allowed: false,
    reason: `refusing to overwrite ${what}. Use a new directory, or pass --force if it is certainly disposable.`,
  };
}

// ── Backup ────────────────────────────────────────────────────────────────────

export interface BackupOptions {
  dir: string;
  packages: PlannedPackage[];
  storage: Pick<BackupStorage, 'readObject'>;
  fs: BackupFs;
  force: boolean;
  dryRun: boolean;
  log: Log;
  err?: Log;
  now?: () => string;
}

/** Returns the process exit code: 0 only when every required file was captured and verified. */
export async function runBackup(o: BackupOptions): Promise<number> {
  const err = o.err ?? o.log;
  const state = inspectBackupTarget(o.fs, o.dir);
  const decision = decideOverwrite(state, o.force);
  if (!decision.allowed) { err(`❌ ${decision.reason}`); return 1; }
  if (decision.reason) o.log(`⚠️  ${decision.reason}`);

  o.log(`\n=== Sim package backup (${o.dryRun ? 'DRY RUN — nothing will be written' : 'WRITING'}) — ${o.packages.length} package(s) → ${o.dir} ===\n`);

  const entries: ManifestEntry[] = [];
  const unreadable: UnreadableFile[] = [];
  const skipped: SkippedPackage[] = [];

  for (const pkg of o.packages) {
    o.log(`── ${pkg.name}  [${pkg.simId}]  prefix ${pkg.storagePrefix}`);
    if (!pkg.entryRel) {
      // rebuild-sim-bridges.ts derives the entry path the same way and SKIPs the package when it
      // cannot, so nothing will be rewritten here — recorded, not counted as a failure.
      const reason = 'cannot derive entry file from entry_file/storage_prefix (rebuild skips this package too)';
      skipped.push({ simId: pkg.simId, name: pkg.name, reason });
      o.log(`   ⚠️  ${reason}`);
    }
    for (const f of planPackageFiles(pkg.storagePrefix, pkg.entryRel)) {
      let buf: Buffer;
      try {
        buf = await o.storage.readObject(f.key);
      } catch (e) {
        const reason = (e as Error).message.slice(0, 120);
        if (f.required) {
          // NOT benign: rebuild --apply overwrites these keys in place in a bucket with no
          // versioning, and rebuild has a public-proxy read fallback this tool lacks — so it can
          // rewrite an object this run never captured. Any unreadable required key means the
          // backup is incomplete and the rollback would be partial.
          unreadable.push({ simId: pkg.simId, name: pkg.name, role: f.role, key: f.key, reason });
          o.log(`   ❌ UNREADABLE  ${f.role.padEnd(8)} ${f.key} — ${reason}`);
        } else {
          o.log(`   ·  absent      ${f.role.padEnd(8)} ${f.key} (normal — package has no guidance)`);
        }
        continue;
      }
      const hash = sha256(buf);
      const local = f.key;
      if (!o.dryRun) {
        const abs = join(o.dir, local);
        o.fs.mkdirp(dirname(abs));
        o.fs.writeFile(abs, buf);
        // Read back what we just wrote: a truncated/short write here is the difference between a
        // rollback and a corrupted package, and it is free to catch now instead of during an outage.
        let back: Buffer;
        try { back = o.fs.readFile(abs); }
        catch (e) {
          unreadable.push({ simId: pkg.simId, name: pkg.name, role: f.role, key: f.key, reason: `written but unreadable: ${(e as Error).message.slice(0, 80)}` });
          o.log(`   ❌ WRITE-VERIFY FAILED ${f.key}`);
          continue;
        }
        if (sha256(back) !== hash) {
          unreadable.push({ simId: pkg.simId, name: pkg.name, role: f.role, key: f.key, reason: 'local copy does not match the bytes read from storage' });
          o.log(`   ❌ WRITE-VERIFY MISMATCH ${f.key}`);
          continue;
        }
      }
      entries.push({ simId: pkg.simId, name: pkg.name, role: f.role, key: f.key, local, bytes: buf.length, sha256: hash });
      o.log(`   ${o.dryRun ? 'would save' : 'saved    '} ${f.role.padEnd(8)} ${String(buf.length).padStart(8)}b  sha:${hash.slice(0, 16)}  ${f.key}`);
    }
  }

  const manifest = buildBackupManifest({ at: (o.now ?? (() => new Date().toISOString()))(), entries, unreadable, skipped });

  if (!o.dryRun) {
    // A failed run must never leave a manifest.json: that file is what `restore` looks for and
    // what the overwrite guard trusts. Park it under a name restore will not load, so the evidence
    // survives while the directory still reads as "no usable backup here".
    const name = manifest.complete ? 'manifest.json' : 'manifest.incomplete.json';
    const finalPath = join(o.dir, name);
    const tmpPath = `${finalPath}.tmp`;
    o.fs.mkdirp(o.dir);
    // Write-then-rename: a crash mid-write leaves the .tmp, never a half-parsed manifest.json.
    o.fs.writeFile(tmpPath, JSON.stringify(manifest, null, 2) + '\n');
    o.fs.rename(tmpPath, finalPath);
    o.log(`\nmanifest → ${finalPath}`);
  }

  const byPkg = new Map<string, number>();
  for (const e of entries) byPkg.set(e.simId, (byPkg.get(e.simId) ?? 0) + 1);
  o.log(`\nPackages: ${o.packages.length} seen, ${byPkg.size} captured, ${skipped.length} without a derivable entry file.`);

  if (unreadable.length) {
    err(`\n❌ INCOMPLETE backup: ${entries.length} file(s) captured, ${unreadable.length} unreadable:`);
    for (const u of unreadable) err(`     ${u.name} [${u.simId}] ${u.role} ${u.key} — ${u.reason}`);
    err('Rollback would be PARTIAL. Do NOT run rebuild --apply until every required key reads.');
    return 1;
  }
  if (entries.length === 0) {
    err('\n❌ captured 0 files — an empty backup is not a backup. Check the status filter and storage credentials.');
    return 1;
  }
  o.log(`\n✅ ${o.dryRun ? 'DRY RUN: would back up' : 'backed up'} ${entries.length} file(s) for ${byPkg.size} simulation(s) → ${o.dir}`);
  return 0;
}

// ── Verify / restore ──────────────────────────────────────────────────────────

export interface LoadedManifest { manifest: BackupManifest | null; problem: string | null }

export function loadManifest(fs: BackupFs, dir: string): LoadedManifest {
  const path = join(dir, 'manifest.json');
  if (!fs.exists(path)) {
    const hint = fs.exists(join(dir, 'manifest.incomplete.json'))
      ? ' — a manifest.incomplete.json IS present: that backup FAILED and must not be restored from'
      : '';
    return { manifest: null, problem: `no manifest.json in ${dir}${hint}` };
  }
  try {
    return { manifest: JSON.parse(fs.readFile(path).toString('utf-8')) as BackupManifest, problem: null };
  } catch (e) {
    return { manifest: null, problem: `manifest.json is not valid JSON (interrupted backup?) — ${(e as Error).message.slice(0, 120)}` };
  }
}

export interface RestoreOptions {
  dir: string;
  storage: BackupStorage;
  fs: BackupFs;
  /** true ⇒ pre-flight and verify only; never calls uploadFile. */
  dryRun: boolean;
  log: Log;
  err?: Log;
}

/** Returns the process exit code. Nothing is uploaded unless every byte pre-flighted clean. */
export async function runRestore(o: RestoreOptions): Promise<number> {
  const err = o.err ?? o.log;
  const { manifest, problem } = loadManifest(o.fs, o.dir);
  if (problem || !manifest) { err(`❌ ${problem}`); return 1; }

  o.log(`\n=== Sim package restore (${o.dryRun ? 'DRY RUN — nothing will be uploaded' : 'WRITING TO STORAGE'}) — backup taken ${manifest.at} ===\n`);

  // Pre-flight EVERY file before uploading any. A missing/corrupt file discovered halfway through
  // leaves the package split across two generations — the worst state to debug a rollback from,
  // and precisely when the operator has the least room to improvise.
  const verified = verifyManifest(manifest, (local) => o.fs.readFile(join(o.dir, local)));
  if (!verified.ok) {
    err(`❌ backup failed verification — ${verified.problems.length} problem(s); NOTHING was uploaded:`);
    for (const p of verified.problems) err(`     ${p}`);
    return 1;
  }
  o.log(`pre-flight OK: ${verified.checked} file(s) match their manifest hashes.\n`);

  const plan = planRestore(manifest);
  if (plan.problems.length) {
    err(`❌ restore plan rejected — ${plan.problems.length} problem(s); NOTHING was uploaded:`);
    for (const p of plan.problems) err(`     ${p}`);
    return 1;
  }

  const failed: { key: string; reason: string }[] = [];
  const okBySim = new Map<string, number>();
  const totalBySim = new Map<string, number>();
  for (const it of plan.items) totalBySim.set(it.simId, (totalBySim.get(it.simId) ?? 0) + 1);

  for (const it of plan.items) {
    const label = `${it.name} [${it.simId}] ${it.role.padEnd(8)} ${it.key}`;
    if (o.dryRun) { o.log(`   would restore ${String(it.bytes).padStart(8)}b  sha:${it.sha256.slice(0, 16)}  ${label}`); continue; }
    const buf = o.fs.readFile(join(o.dir, it.local));
    try {
      await o.storage.uploadFile(it.key, buf, contentTypeForRole(it.role));
    } catch (e) {
      failed.push({ key: it.key, reason: `upload failed: ${(e as Error).message.slice(0, 120)}` });
      err(`   ❌ UPLOAD FAILED  ${label} — ${(e as Error).message.slice(0, 120)}`);
      continue;
    }
    // Read back and hash-compare. An upload that resolves is not proof the object landed: a
    // rollback that "succeeded" without the bytes actually changing is the failure mode this
    // whole tool exists to prevent.
    try {
      const back = await o.storage.readObject(it.key);
      const actual = sha256(back);
      if (actual !== it.sha256) {
        failed.push({ key: it.key, reason: `read-back MISMATCH — wrote sha:${it.sha256.slice(0, 16)}…, storage returned sha:${actual.slice(0, 16)}…` });
        err(`   ❌ READ-BACK MISMATCH ${label}`);
        continue;
      }
    } catch (e) {
      failed.push({ key: it.key, reason: `read-back failed: ${(e as Error).message.slice(0, 120)}` });
      err(`   ❌ READ-BACK FAILED  ${label} — ${(e as Error).message.slice(0, 120)}`);
      continue;
    }
    okBySim.set(it.simId, (okBySim.get(it.simId) ?? 0) + 1);
    o.log(`   restored+verified ${String(buf.length).padStart(8)}b  sha:${it.sha256.slice(0, 16)}  ${label}`);
  }

  if (o.dryRun) {
    o.log(`\n✅ DRY RUN: ${plan.items.length} file(s) across ${totalBySim.size} simulation(s) are complete and hash-clean; a real restore would upload them.`);
    return 0;
  }

  const split: string[] = [];
  for (const [simId, total] of totalBySim) {
    const done = okBySim.get(simId) ?? 0;
    if (done !== 0 && done !== total) split.push(`${simId} (${done}/${total} files restored)`);
  }
  if (failed.length) {
    err(`\n❌ restore INCOMPLETE — ${plan.items.length - failed.length}/${plan.items.length} file(s) restored, ${failed.length} failed:`);
    for (const f of failed) err(`     ${f.key} — ${f.reason}`);
    if (split.length) err(`   ⚠️  PARTIALLY restored packages (mixed generations, re-run the restore): ${split.join(', ')}`);
    return 1;
  }
  o.log(`\n✅ restored + verified ${plan.items.length} file(s) for ${totalBySim.size} simulation(s) from ${o.dir}`);
  return 0;
}

export interface VerifyOptions {
  dir: string;
  fs: BackupFs;
  /** When given, also compares each backed-up file against what is CURRENTLY live in storage. */
  storage?: Pick<BackupStorage, 'readObject'>;
  log: Log;
  err?: Log;
}

/** Read-only: compares the backup's bytes against its manifest hashes and, with --live, against
 *  storage. Writes nothing anywhere — safe to run at any point, including mid-incident. */
export async function runVerify(o: VerifyOptions): Promise<number> {
  const err = o.err ?? o.log;
  const { manifest, problem } = loadManifest(o.fs, o.dir);
  if (problem || !manifest) { err(`❌ ${problem}`); return 1; }

  o.log(`\n=== Sim package backup verification (read-only) — taken ${manifest.at} ===\n`);
  const verified = verifyManifest(manifest, (local) => o.fs.readFile(join(o.dir, local)));
  for (const e of manifest.entries ?? []) {
    o.log(`   ${e.name} [${e.simId}] ${e.role.padEnd(8)} ${String(e.bytes).padStart(8)}b  sha:${e.sha256?.slice?.(0, 16) ?? '—'}  ${e.key}`);
  }
  if (!verified.ok) {
    err(`\n❌ backup is NOT restorable — ${verified.problems.length} problem(s):`);
    for (const p of verified.problems) err(`     ${p}`);
    return 1;
  }
  o.log(`\n✅ ${verified.checked} file(s) match their manifest hashes.`);

  if (!o.storage) return 0;

  o.log('\n── live storage comparison (read-only) ──');
  let drift = 0, unreadable = 0;
  for (const e of manifest.entries) {
    try {
      const live = await o.storage.readObject(e.key);
      const same = sha256(live) === e.sha256;
      if (!same) drift++;
      o.log(`   ${same ? 'MATCHES backup ' : 'DIFFERS        '} ${e.role.padEnd(8)} ${e.key}${same ? '' : `  (live sha:${sha256(live).slice(0, 16)}…)`}`);
    } catch (e2) {
      unreadable++;
      err(`   UNREADABLE      ${e.role.padEnd(8)} ${e.key} — ${(e2 as Error).message.slice(0, 100)}`);
    }
  }
  o.log(`\nLive: ${manifest.entries.length - drift - unreadable} match the backup, ${drift} differ, ${unreadable} unreadable.`);
  // Drift is information, not failure — after a rebuild the live bytes SHOULD differ. Only a key
  // that cannot be read at all breaks the ability to reason about the rollback.
  return unreadable > 0 ? 1 : 0;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

export function parseArgs(argv: string[]): { mode: string | undefined; dir: string | undefined; force: boolean; dryRun: boolean; live: boolean } {
  const positional = argv.filter((a) => !a.startsWith('--'));
  return {
    mode: positional[0],
    dir: positional[1],
    force: argv.includes('--force'),
    dryRun: argv.includes('--dry-run'),
    live: argv.includes('--live'),
  };
}

const USAGE = [
  'usage: backup-sim-packages.ts <backup|restore|verify> <dir> [--dry-run] [--force] [--live]',
  '',
  '  backup  <dir>            capture bridge.js + entry HTML + guidance.js of every ready sim',
  '  backup  <dir> --dry-run  read + hash everything, write nothing',
  '  backup  <dir> --force    allow writing into a non-empty / already-used directory',
  '  verify  <dir>            re-hash the backup against its manifest (no storage, no writes)',
  '  verify  <dir> --live     ALSO report which keys currently differ in storage (still no writes)',
  '  restore <dir>            upload the backed-up bytes and read them back to verify',
  '  restore <dir> --dry-run  pre-flight every byte, upload nothing',
].join('\n');

async function main(): Promise<number> {
  const { mode, dir, force, dryRun, live } = parseArgs(process.argv.slice(2));
  if ((mode !== 'backup' && mode !== 'restore' && mode !== 'verify') || !dir) {
    console.error(USAGE);
    return 1;
  }
  const log: Log = (l) => console.log(l);
  const err: Log = (l) => console.error(l);

  // `verify` without --live needs neither storage nor the database — keep it usable when both are
  // unreachable, which is exactly when someone is checking whether a rollback is possible.
  if (mode === 'verify' && !live) return runVerify({ dir, fs: nodeBackupFs, log, err });

  const { getStorageAdapter } = await import('../services/storage/getStorageAdapter.js');
  const storage = getStorageAdapter();

  if (mode === 'verify') return runVerify({ dir, fs: nodeBackupFs, storage, log, err });
  if (mode === 'restore') return runRestore({ dir, storage, fs: nodeBackupFs, dryRun, log, err });

  const { db } = await import('../db/index.js');
  const { simulations } = await import('../db/schema.js');
  const { eq } = await import('drizzle-orm');
  const { deriveEntryRelPath } = await import('../services/simulation/SimulationService.js');

  const rows = await db.query.simulations.findMany({ where: eq(simulations.status, 'ready') });
  const packages: PlannedPackage[] = rows.map((sim) => ({
    simId: sim.id,
    name: sim.name,
    storagePrefix: sim.storage_prefix,
    entryRel: deriveEntryRelPath(sim.entry_file, sim.storage_prefix),
  }));
  return runBackup({ dir, packages, storage, fs: nodeBackupFs, force, dryRun, log, err });
}

/** process.exit() drops buffered stdout/stderr when they are pipes — which is exactly how a
 *  rollout runs this (`… | tee rollout.log`). Drain both before exiting so the diagnostic that
 *  explains a non-zero exit is never the thing that gets truncated. */
async function exitFlushed(code: number): Promise<never> {
  await Promise.all([
    new Promise<void>((r) => { process.stdout.write('', () => r()); }),
    new Promise<void>((r) => { process.stderr.write('', () => r()); }),
  ]);
  process.exit(code);
}

// Only run when invoked directly, so tests (and other scripts) can import the pure helpers above
// without executing a rollout.
if (process.argv[1] && process.argv[1].includes('backup-sim-packages')) {
  main()
    .then((code) => exitFlushed(code))
    .catch(async (e) => { console.error(e); await exitFlushed(1); });
}
