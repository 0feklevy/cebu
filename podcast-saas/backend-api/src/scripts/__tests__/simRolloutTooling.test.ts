/**
 * Adversarial tests for the simulation rollout tooling: backup-sim-packages.ts (backup / verify /
 * restore) and the pure decision helpers of rebuild-sim-bridges.ts.
 *
 * Everything runs against in-memory fakes for storage and the filesystem — no database, no
 * storage adapter, no disk. The scripts guard their `main()` behind a direct-invocation check and
 * import db/storage lazily, so importing them here executes nothing.
 *
 * The properties under test are the ones a rollback actually depends on:
 *   1  every failure produces a non-zero exit code
 *   2  a partial backup can never be reported as successful
 *   3  an existing backup is never silently overwritten
 *   4  the rollback set covers every file a rebuild can rewrite (bridge.js, entry HTML, guidance.js)
 *   5  the manifest carries a hash AND a size per file
 *   6  restore reads back what it wrote and hash-compares it
 *   7  restore recovers the exact original bytes
 *   8  restore touches nothing outside the manifest
 *   9  backup and restore both have a no-write mode, plus a standalone verify mode
 *  10  logs name every affected package and file
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import {
  MANIFEST_VERSION,
  buildBackupManifest,
  checkManifestEntry,
  contentTypeForRole,
  decideOverwrite,
  inspectBackupTarget,
  loadManifest,
  planPackageFiles,
  planRestore,
  runBackup,
  runRestore,
  runVerify,
  parseArgs,
  sha256,
  verifyManifest,
  type BackupFs,
  type BackupManifest,
  type BackupStorage,
  type ManifestEntry,
  type PlannedPackage,
} from '../backup-sim-packages.js';

import {
  bridgeRelPathFor,
  decideRebuildAction,
  detectConflicts,
} from '../rebuild-sim-bridges.js';

// ── Fakes ─────────────────────────────────────────────────────────────────────

const DIR = '/backups/sim-2026-08-02';
const PREFIX = 'simulations/proj-1/sim-a';
const BRIDGE_KEY = `${PREFIX}/bridge.js`;
const ENTRY_KEY = `${PREFIX}/index.html`;
const GUIDANCE_KEY = `${PREFIX}/guidance.js`;

const BRIDGE_BYTES = Buffer.from('/* sim-bridge v2 */\n@@SIM_BRIDGE:main@@\nconsole.log(1);\n');
const ENTRY_BYTES = Buffer.from(
  '<html><head></head><body>' +
  '<!-- SIM_BRIDGE_SCRIPT_START -->\n<script src="./bridge.js?v=abc123"></script>\n<!-- SIM_BRIDGE_SCRIPT_END -->' +
  '<!-- SIM_GUIDANCE_SCRIPT_START -->\n<script src="./guidance.js?v=g00d"></script>\n<!-- SIM_GUIDANCE_SCRIPT_END -->' +
  '</body></html>',
);
const GUIDANCE_BYTES = Buffer.from('/* guidance v1 */\nvar cues = [];\n');

interface MemFs extends BackupFs {
  map: Map<string, Buffer>;
  writes: string[];
  renames: [string, string][];
}

function memFs(seed: Record<string, Buffer | string> = {}): MemFs {
  const map = new Map<string, Buffer>();
  for (const [k, v] of Object.entries(seed)) map.set(k, Buffer.isBuffer(v) ? v : Buffer.from(v));
  const writes: string[] = [];
  const renames: [string, string][] = [];
  return {
    map, writes, renames,
    exists: (p) => map.has(p) || [...map.keys()].some((k) => k.startsWith(`${p}/`)),
    listDir: (p) => {
      const out = new Set<string>();
      for (const k of map.keys()) if (k.startsWith(`${p}/`)) out.add(k.slice(p.length + 1).split('/')[0]);
      return [...out];
    },
    mkdirp: () => { /* directories are implicit in the map */ },
    writeFile: (p, d) => { writes.push(p); map.set(p, Buffer.isBuffer(d) ? d : Buffer.from(d)); },
    readFile: (p) => {
      const b = map.get(p);
      if (!b) throw new Error(`ENOENT: no such file or directory, open '${p}'`);
      return b;
    },
    rename: (a, b) => {
      const v = map.get(a);
      if (!v) throw new Error(`ENOENT: rename '${a}'`);
      map.delete(a); map.set(b, v); renames.push([a, b]);
    },
  };
}

interface MemStorage extends BackupStorage {
  objects: Map<string, Buffer>;
  uploads: string[];
  /** Keys whose readObject always throws. */
  unreadable: Set<string>;
  /** Keys whose uploadFile always throws. */
  unwritable: Set<string>;
  /** Keys whose uploadFile silently succeeds without changing the stored bytes. */
  swallow: Set<string>;
  contentTypes: Map<string, string>;
}

function memStorage(seed: Record<string, Buffer> = {}): MemStorage {
  const objects = new Map<string, Buffer>(Object.entries(seed));
  const s: MemStorage = {
    objects,
    uploads: [],
    unreadable: new Set(),
    unwritable: new Set(),
    swallow: new Set(),
    contentTypes: new Map(),
    async readObject(key) {
      if (s.unreadable.has(key)) throw new Error(`403 Forbidden: ${key}`);
      const b = objects.get(key);
      if (!b) throw new Error(`404 Not Found: ${key}`);
      return b;
    },
    async uploadFile(key, data, contentType) {
      if (s.unwritable.has(key)) throw new Error(`503 upload rejected: ${key}`);
      s.uploads.push(key);
      s.contentTypes.set(key, contentType);
      if (!s.swallow.has(key)) objects.set(key, data);
      return key;
    },
  };
  return s;
}

function collector(): { log: (l: string) => void; lines: string[]; text: () => string } {
  const lines: string[] = [];
  return { lines, log: (l) => lines.push(l), text: () => lines.join('\n') };
}

const PKG: PlannedPackage = { simId: 'sim-a', name: 'Boids 3D', storagePrefix: PREFIX, entryRel: 'index.html' };

const liveStorage = (): MemStorage => memStorage({
  [BRIDGE_KEY]: BRIDGE_BYTES,
  [ENTRY_KEY]: ENTRY_BYTES,
  [GUIDANCE_KEY]: GUIDANCE_BYTES,
});

/** Take a real backup into a fresh mem-fs and hand back everything the next step needs. */
async function takeBackup(storage: MemStorage = liveStorage(), packages: PlannedPackage[] = [PKG]) {
  const fs = memFs();
  const out = collector();
  const code = await runBackup({
    dir: DIR, packages, storage, fs, force: false, dryRun: false,
    log: out.log, err: out.log, now: () => '2026-08-02T00:00:00.000Z',
  });
  return { fs, out, code, storage };
}

function manifestOf(fs: MemFs): BackupManifest {
  return JSON.parse(fs.readFile(join(DIR, 'manifest.json')).toString('utf-8')) as BackupManifest;
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

describe('planPackageFiles — property 4: the rollback set covers every file a rebuild can rewrite', () => {
  it('captures bridge.js, the entry HTML, and guidance.js', () => {
    const files = planPackageFiles(PREFIX, 'index.html');
    expect(files.map((f) => f.key)).toEqual([BRIDGE_KEY, ENTRY_KEY, GUIDANCE_KEY]);
  });

  it('marks bridge.js and the entry HTML required, guidance.js optional', () => {
    const files = planPackageFiles(PREFIX, 'index.html');
    expect(files.filter((f) => f.required).map((f) => f.role)).toEqual(['bridge', 'entry']);
    expect(files.find((f) => f.role === 'guidance')!.required).toBe(false);
  });

  it('handles a nested entry file and an underivable one', () => {
    expect(planPackageFiles(PREFIX, 'dist/index.html').map((f) => f.key)).toContain(`${PREFIX}/dist/index.html`);
    expect(planPackageFiles(PREFIX, null).map((f) => f.role)).toEqual(['bridge', 'guidance']);
  });
});

describe('contentTypeForRole — a restore must not change how the object is served', () => {
  it('mirrors what rebuild-sim-bridges.ts and the generation path upload', () => {
    expect(contentTypeForRole('entry')).toBe('text/html; charset=utf-8');
    expect(contentTypeForRole('bridge')).toBe('application/javascript');
    expect(contentTypeForRole('guidance')).toBe('application/javascript');
  });
});

describe('decideOverwrite / inspectBackupTarget — property 3: never silently overwrite a backup', () => {
  it('allows a genuinely empty target', () => {
    expect(inspectBackupTarget(memFs(), DIR)).toBe('empty');
    expect(decideOverwrite('empty', false).allowed).toBe(true);
  });

  it('refuses a directory that already holds a manifest', () => {
    const fs = memFs({ [join(DIR, 'manifest.json')]: '{}' });
    expect(inspectBackupTarget(fs, DIR)).toBe('has-manifest');
    const d = decideOverwrite('has-manifest', false);
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/refusing to overwrite/i);
  });

  it('refuses a NON-EMPTY directory with no manifest — that is an interrupted backup, not an empty slot', () => {
    const fs = memFs({ [join(DIR, BRIDGE_KEY)]: BRIDGE_BYTES });
    expect(inspectBackupTarget(fs, DIR)).toBe('non-empty');
    expect(decideOverwrite('non-empty', false).allowed).toBe(false);
  });

  it('refuses a directory holding a FAILED backup', () => {
    const fs = memFs({ [join(DIR, 'manifest.incomplete.json')]: '{}' });
    expect(inspectBackupTarget(fs, DIR)).toBe('has-incomplete-manifest');
    expect(decideOverwrite('has-incomplete-manifest', false).allowed).toBe(false);
  });

  it('--force overrides, but always says out loud what it is destroying', () => {
    const d = decideOverwrite('has-manifest', true);
    expect(d.allowed).toBe(true);
    expect(d.reason).toMatch(/--force/);
  });
});

describe('buildBackupManifest — properties 2 + 5: hashes, sizes, and an honest complete flag', () => {
  const entry: ManifestEntry = {
    simId: 'sim-a', name: 'Boids 3D', role: 'bridge', key: BRIDGE_KEY, local: BRIDGE_KEY,
    bytes: BRIDGE_BYTES.length, sha256: sha256(BRIDGE_BYTES),
  };

  it('is complete only when nothing was unreadable AND something was captured', () => {
    expect(buildBackupManifest({ at: 'x', entries: [entry], unreadable: [], skipped: [] }).complete).toBe(true);
  });

  it('is INCOMPLETE when any required file was unreadable', () => {
    const m = buildBackupManifest({
      at: 'x', entries: [entry], skipped: [],
      unreadable: [{ simId: 'sim-b', name: 'B', role: 'entry', key: 'p/index.html', reason: '403' }],
    });
    expect(m.complete).toBe(false);
  });

  it('is INCOMPLETE when it captured nothing — an empty rollback set is not a backup', () => {
    expect(buildBackupManifest({ at: 'x', entries: [], unreadable: [], skipped: [] }).complete).toBe(false);
  });

  it('carries a full sha256 AND a byte count per file', () => {
    const m = buildBackupManifest({ at: 'x', entries: [entry], unreadable: [], skipped: [] });
    expect(m.version).toBe(MANIFEST_VERSION);
    expect(m.entries[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(m.entries[0].bytes).toBe(BRIDGE_BYTES.length);
  });
});

describe('checkManifestEntry — property 8: a manifest is untrusted input', () => {
  const base: ManifestEntry = {
    simId: 's', name: 'n', role: 'bridge', key: BRIDGE_KEY, local: BRIDGE_KEY,
    bytes: 1, sha256: 'a'.repeat(64),
  };

  it('accepts a well-formed entry', () => {
    expect(checkManifestEntry(base)).toBeNull();
  });

  it.each([
    ['path traversal in the key', { key: `../../../etc/passwd/bridge.js`, local: `../../../etc/passwd/bridge.js` }],
    ['absolute key', { key: '/etc/bridge.js', local: '/etc/bridge.js' }],
    ['local path diverging from the storage key', { local: '../../../elsewhere/bridge.js' }],
    ['backslash smuggling', { key: 'p\\..\\bridge.js', local: 'p\\..\\bridge.js' }],
    ['role/suffix mismatch (bridge role, arbitrary key)', { key: 'p/anything.js', local: 'p/anything.js' }],
    ['missing hash', { sha256: '' }],
    ['truncated hash', { sha256: 'abc' }],
    ['negative size', { bytes: -1 }],
  ])('rejects %s', (_label, patch) => {
    expect(checkManifestEntry({ ...base, ...patch } as ManifestEntry)).not.toBeNull();
  });

  it('rejects an entry role pointing at a non-HTML key and a guidance role pointing elsewhere', () => {
    expect(checkManifestEntry({ ...base, role: 'entry', key: 'p/x.js', local: 'p/x.js' })).not.toBeNull();
    expect(checkManifestEntry({ ...base, role: 'guidance', key: 'p/other.js', local: 'p/other.js' })).not.toBeNull();
    expect(checkManifestEntry({ ...base, role: 'entry', key: 'p/index.html', local: 'p/index.html' })).toBeNull();
  });
});

describe('verifyManifest — property 5/6: hash + size checked against the bytes on disk', () => {
  it('passes a clean backup', () => {
    const m = buildBackupManifest({
      at: 'x', unreadable: [], skipped: [],
      entries: [{ simId: 's', name: 'n', role: 'bridge', key: BRIDGE_KEY, local: BRIDGE_KEY, bytes: BRIDGE_BYTES.length, sha256: sha256(BRIDGE_BYTES) }],
    });
    const r = verifyManifest(m, () => BRIDGE_BYTES);
    expect(r).toMatchObject({ ok: true, checked: 1 });
  });

  it('detects a HASH MISMATCH (file edited/corrupted after the backup)', () => {
    const m = buildBackupManifest({
      at: 'x', unreadable: [], skipped: [],
      entries: [{ simId: 's', name: 'n', role: 'bridge', key: BRIDGE_KEY, local: BRIDGE_KEY, bytes: BRIDGE_BYTES.length, sha256: sha256(Buffer.from('other')) }],
    });
    const r = verifyManifest(m, () => BRIDGE_BYTES);
    expect(r.ok).toBe(false);
    expect(r.problems.join()).toMatch(/HASH MISMATCH/);
  });

  it('detects a truncated file via the size check', () => {
    const m = buildBackupManifest({
      at: 'x', unreadable: [], skipped: [],
      entries: [{ simId: 's', name: 'n', role: 'bridge', key: BRIDGE_KEY, local: BRIDGE_KEY, bytes: 999, sha256: sha256(BRIDGE_BYTES) }],
    });
    expect(verifyManifest(m, () => BRIDGE_BYTES).problems.join()).toMatch(/size mismatch/);
  });

  it('detects a file missing from the backup directory', () => {
    const m = buildBackupManifest({
      at: 'x', unreadable: [], skipped: [],
      entries: [{ simId: 's', name: 'n', role: 'bridge', key: BRIDGE_KEY, local: BRIDGE_KEY, bytes: 1, sha256: 'a'.repeat(64) }],
    });
    const r = verifyManifest(m, () => { throw new Error('ENOENT'); });
    expect(r.ok).toBe(false);
    expect(r.problems.join()).toMatch(/missing from the backup/);
  });

  it('refuses a manifest the backup itself marked INCOMPLETE', () => {
    const m = buildBackupManifest({
      at: 'x', skipped: [],
      unreadable: [{ simId: 'b', name: 'B', role: 'entry', key: 'p/index.html', reason: '403' }],
      entries: [{ simId: 's', name: 'n', role: 'bridge', key: BRIDGE_KEY, local: BRIDGE_KEY, bytes: BRIDGE_BYTES.length, sha256: sha256(BRIDGE_BYTES) }],
    });
    expect(verifyManifest(m, () => BRIDGE_BYTES).problems.join()).toMatch(/INCOMPLETE/);
  });

  it('refuses a legacy v1 manifest that recorded byte counts but no hashes', () => {
    const legacy = { at: 'x', entries: [{ simId: 's', name: 'n', key: BRIDGE_KEY, local: BRIDGE_KEY, bytes: 10 }] } as unknown as BackupManifest;
    const r = verifyManifest(legacy, () => BRIDGE_BYTES);
    expect(r.ok).toBe(false);
    expect(r.problems.join()).toMatch(/cannot be verified|version/i);
  });

  it('refuses an empty manifest and a duplicated key', () => {
    expect(verifyManifest(buildBackupManifest({ at: 'x', entries: [], unreadable: [], skipped: [] }), () => BRIDGE_BYTES).ok).toBe(false);
    const dup: ManifestEntry = { simId: 's', name: 'n', role: 'bridge', key: BRIDGE_KEY, local: BRIDGE_KEY, bytes: BRIDGE_BYTES.length, sha256: sha256(BRIDGE_BYTES) };
    const r = verifyManifest(buildBackupManifest({ at: 'x', entries: [dup, { ...dup }], unreadable: [], skipped: [] }), () => BRIDGE_BYTES);
    expect(r.problems.join()).toMatch(/duplicated/);
  });
});

describe('planRestore — ordering and rejection', () => {
  const mk = (role: ManifestEntry['role'], key: string): ManifestEntry =>
    ({ simId: 's', name: 'n', role, key, local: key, bytes: 1, sha256: 'a'.repeat(64) });

  it('writes guidance.js, then bridge.js, then the entry HTML that references both hashes', () => {
    const plan = planRestore(buildBackupManifest({
      at: 'x', unreadable: [], skipped: [],
      entries: [mk('entry', ENTRY_KEY), mk('bridge', BRIDGE_KEY), mk('guidance', GUIDANCE_KEY)],
    }));
    expect(plan.problems).toEqual([]);
    expect(plan.items.map((i) => i.role)).toEqual(['guidance', 'bridge', 'entry']);
  });

  it('drops unsafe entries into problems instead of into the write plan', () => {
    const plan = planRestore(buildBackupManifest({
      at: 'x', unreadable: [], skipped: [],
      entries: [mk('bridge', BRIDGE_KEY), mk('bridge', '../../etc/bridge.js')],
    }));
    expect(plan.items).toHaveLength(1);
    expect(plan.problems).toHaveLength(1);
  });
});

// ── runBackup ─────────────────────────────────────────────────────────────────

describe('runBackup — happy path', () => {
  it('exits 0, captures all three roles, and writes a v2 manifest with hash + size per file', async () => {
    const { fs, code, out } = await takeBackup();
    expect(code).toBe(0);
    const m = manifestOf(fs);
    expect(m.version).toBe(MANIFEST_VERSION);
    expect(m.complete).toBe(true);
    expect(m.entries.map((e) => e.role).sort()).toEqual(['bridge', 'entry', 'guidance']);
    for (const e of m.entries) {
      expect(e.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(e.bytes).toBeGreaterThan(0);
      expect(sha256(fs.readFile(join(DIR, e.local)))).toBe(e.sha256);
    }
    // property 10 — the log names the package and every key it touched
    expect(out.text()).toContain('Boids 3D');
    for (const k of [BRIDGE_KEY, ENTRY_KEY, GUIDANCE_KEY]) expect(out.text()).toContain(k);
  });

  it('writes the manifest atomically (tmp file renamed into place, never a half-written manifest.json)', async () => {
    const { fs } = await takeBackup();
    expect(fs.renames).toHaveLength(1);
    const [from, to] = fs.renames[0];
    expect(from).toBe(join(DIR, 'manifest.json.tmp'));
    expect(to).toBe(join(DIR, 'manifest.json'));
    expect(fs.exists(from)).toBe(false);
  });

  it('is idempotent: two runs of the same inputs into fresh directories produce identical manifests', async () => {
    const a = await takeBackup();
    const b = await takeBackup();
    expect(manifestOf(b.fs)).toEqual(manifestOf(a.fs));
  });
});

describe('runBackup — property 4: guidance.js', () => {
  it('captures guidance.js so the restored entry HTML and its guidance.js?v= hash stay consistent', async () => {
    const { fs } = await takeBackup();
    expect(fs.exists(join(DIR, GUIDANCE_KEY))).toBe(true);
    expect(fs.readFile(join(DIR, GUIDANCE_KEY))).toEqual(GUIDANCE_BYTES);
  });

  it('treats a package with no guidance.js as normal, not as a failure', async () => {
    const storage = memStorage({ [BRIDGE_KEY]: BRIDGE_BYTES, [ENTRY_KEY]: ENTRY_BYTES });
    const { code, fs, out } = await takeBackup(storage);
    expect(code).toBe(0);
    expect(manifestOf(fs).entries.map((e) => e.role).sort()).toEqual(['bridge', 'entry']);
    expect(out.text()).toMatch(/absent.*guidance\.js/);
  });
});

describe('runBackup — properties 1 + 2: failures exit non-zero and are never called successful', () => {
  it('exits 1 and refuses to write manifest.json when a required key is unreadable', async () => {
    const storage = liveStorage();
    storage.unreadable.add(ENTRY_KEY);
    const { code, fs, out } = await takeBackup(storage);
    expect(code).toBe(1);
    // The failed run must not leave the artefact restore looks for.
    expect(fs.exists(join(DIR, 'manifest.json'))).toBe(false);
    expect(fs.exists(join(DIR, 'manifest.incomplete.json'))).toBe(true);
    const m = JSON.parse(fs.readFile(join(DIR, 'manifest.incomplete.json')).toString()) as BackupManifest;
    expect(m.complete).toBe(false);
    expect(m.unreadable[0].key).toBe(ENTRY_KEY);
    // property 10 — the operator is told exactly which package and file
    expect(out.text()).toContain('UNREADABLE');
    expect(out.text()).toContain(ENTRY_KEY);
    expect(out.text()).toMatch(/Do NOT run rebuild --apply/);
  });

  it('exits 1 when it captured nothing at all instead of reporting "backed up 0 files"', async () => {
    const { code, out } = await takeBackup(memStorage(), []);
    expect(code).toBe(1);
    expect(out.text()).toMatch(/captured 0 files/);
  });

  it('exits 1 when the local copy does not read back as the bytes downloaded (silent short write)', async () => {
    const fs = memFs();
    const corrupting: BackupFs = { ...fs, readFile: (p) => (p.endsWith('bridge.js') ? Buffer.from('truncated') : fs.readFile(p)) };
    const out = collector();
    const code = await runBackup({
      dir: DIR, packages: [PKG], storage: liveStorage(), fs: corrupting,
      force: false, dryRun: false, log: out.log, err: out.log,
    });
    expect(code).toBe(1);
    expect(out.text()).toMatch(/WRITE-VERIFY MISMATCH/);
  });

  it('records a package whose entry file cannot be derived instead of pretending it was covered', async () => {
    const storage = memStorage({ [BRIDGE_KEY]: BRIDGE_BYTES });
    const fs = memFs();
    const out = collector();
    const code = await runBackup({
      dir: DIR, packages: [{ ...PKG, entryRel: null }], storage, fs,
      force: false, dryRun: false, log: out.log, err: out.log,
    });
    expect(code).toBe(0); // rebuild skips these too, so it is not a rollout blocker…
    expect(manifestOf(fs).skipped[0]).toMatchObject({ simId: 'sim-a' }); // …but it is recorded
    expect(out.text()).toMatch(/cannot derive entry file/);
  });
});

describe('runBackup — property 3: refusing to overwrite an existing backup', () => {
  it('exits 1 and writes NOTHING when the directory already holds a backup', async () => {
    const first = await takeBackup();
    const out = collector();
    const before = new Map(first.fs.map);
    const code = await runBackup({
      dir: DIR, packages: [PKG], storage: liveStorage(), fs: first.fs,
      force: false, dryRun: false, log: out.log, err: out.log,
    });
    expect(code).toBe(1);
    expect(out.text()).toMatch(/refusing to overwrite/);
    expect(first.fs.map).toEqual(before);
  });

  it('also refuses a directory left non-empty by an interrupted backup (no manifest present)', async () => {
    const fs = memFs({ [join(DIR, BRIDGE_KEY)]: BRIDGE_BYTES });
    const out = collector();
    const code = await runBackup({
      dir: DIR, packages: [PKG], storage: liveStorage(), fs,
      force: false, dryRun: false, log: out.log, err: out.log,
    });
    expect(code).toBe(1);
    expect(fs.writes).toHaveLength(0);
  });

  it('allows --force but announces the overwrite', async () => {
    const first = await takeBackup();
    const out = collector();
    const code = await runBackup({
      dir: DIR, packages: [PKG], storage: liveStorage(), fs: first.fs,
      force: true, dryRun: false, log: out.log, err: out.log,
    });
    expect(code).toBe(0);
    expect(out.text()).toMatch(/--force: overwriting/);
  });
});

describe('runBackup — property 9: --dry-run', () => {
  it('reads and hashes everything but writes nothing at all', async () => {
    const fs = memFs();
    const out = collector();
    const code = await runBackup({
      dir: DIR, packages: [PKG], storage: liveStorage(), fs,
      force: false, dryRun: true, log: out.log, err: out.log,
    });
    expect(code).toBe(0);
    expect(fs.writes).toHaveLength(0);
    expect(fs.map.size).toBe(0);
    expect(out.text()).toMatch(/DRY RUN/);
    expect(out.text()).toContain(BRIDGE_KEY);
  });

  it('still exits 1 on an unreadable required key, so the rehearsal is a real pre-flight', async () => {
    const storage = liveStorage();
    storage.unreadable.add(BRIDGE_KEY);
    const fs = memFs();
    const out = collector();
    const code = await runBackup({
      dir: DIR, packages: [PKG], storage, fs, force: false, dryRun: true, log: out.log, err: out.log,
    });
    expect(code).toBe(1);
    expect(fs.writes).toHaveLength(0);
  });
});

// ── runRestore ────────────────────────────────────────────────────────────────

describe('runRestore — properties 6 + 7: exact bytes back, verified by read-back', () => {
  it('restores the exact original bridge.js, entry HTML and guidance.js after a rebuild overwrote them', async () => {
    const { fs } = await takeBackup();
    // Simulate rebuild --apply clobbering the package in place.
    const live = liveStorage();
    live.objects.set(BRIDGE_KEY, Buffer.from('/* sim-bridge v3 REBUILT */'));
    live.objects.set(ENTRY_KEY, Buffer.from('<html>rebuilt, guidance tag rewritten</html>'));

    const out = collector();
    const code = await runRestore({ dir: DIR, storage: live, fs, dryRun: false, log: out.log, err: out.log });

    expect(code).toBe(0);
    expect(live.objects.get(BRIDGE_KEY)).toEqual(BRIDGE_BYTES);
    expect(live.objects.get(ENTRY_KEY)).toEqual(ENTRY_BYTES);
    expect(live.objects.get(GUIDANCE_KEY)).toEqual(GUIDANCE_BYTES);
    expect(out.text()).toMatch(/restored\+verified/);
  });

  it('re-uploads with the same content types the generation path uses', async () => {
    const { fs } = await takeBackup();
    const live = liveStorage();
    live.objects.set(BRIDGE_KEY, Buffer.from('clobbered'));
    await runRestore({ dir: DIR, storage: live, fs, dryRun: false, log: () => {}, err: () => {} });
    expect(live.contentTypes.get(ENTRY_KEY)).toBe('text/html; charset=utf-8');
    expect(live.contentTypes.get(BRIDGE_KEY)).toBe('application/javascript');
  });

  it('exits 1 when storage accepts the upload but the bytes did not change (read-back mismatch)', async () => {
    const { fs } = await takeBackup();
    const live = liveStorage();
    live.objects.set(BRIDGE_KEY, Buffer.from('/* stale rebuilt bridge */'));
    live.swallow.add(BRIDGE_KEY); // upload resolves, object never changes
    const out = collector();
    const code = await runRestore({ dir: DIR, storage: live, fs, dryRun: false, log: out.log, err: out.log });
    expect(code).toBe(1);
    expect(out.text()).toMatch(/READ-BACK MISMATCH/);
    expect(out.text()).toContain(BRIDGE_KEY);
  });

  it('is idempotent — restoring twice leaves identical bytes and exits 0 both times', async () => {
    const { fs } = await takeBackup();
    const live = liveStorage();
    live.objects.set(BRIDGE_KEY, Buffer.from('clobbered'));
    const first = await runRestore({ dir: DIR, storage: live, fs, dryRun: false, log: () => {}, err: () => {} });
    const snapshot = new Map(live.objects);
    const second = await runRestore({ dir: DIR, storage: live, fs, dryRun: false, log: () => {}, err: () => {} });
    expect([first, second]).toEqual([0, 0]);
    expect(live.objects).toEqual(snapshot);
  });
});

describe('runRestore — property 8: nothing outside the manifest is touched', () => {
  it('leaves unrelated objects in the same bucket byte-identical', async () => {
    const { fs } = await takeBackup();
    const live = liveStorage();
    const OTHER = `${PREFIX}/assets/data.json`;
    const OTHER_SIM = 'simulations/proj-1/sim-b/bridge.js';
    live.objects.set(OTHER, Buffer.from('{"user":"asset"}'));
    live.objects.set(OTHER_SIM, Buffer.from('other package'));

    await runRestore({ dir: DIR, storage: live, fs, dryRun: false, log: () => {}, err: () => {} });

    expect(live.objects.get(OTHER)).toEqual(Buffer.from('{"user":"asset"}'));
    expect(live.objects.get(OTHER_SIM)).toEqual(Buffer.from('other package'));
    expect(live.uploads.sort()).toEqual([BRIDGE_KEY, ENTRY_KEY, GUIDANCE_KEY].sort());
  });

  it('uploads nothing when the manifest smuggles a key outside the package', async () => {
    const { fs } = await takeBackup();
    const m = manifestOf(fs);
    m.entries.push({ simId: 'x', name: 'evil', role: 'bridge', key: '../../../etc/bridge.js', local: '../../../etc/bridge.js', bytes: 1, sha256: 'a'.repeat(64) });
    fs.writeFile(join(DIR, 'manifest.json'), JSON.stringify(m));
    const live = liveStorage();
    const out = collector();
    const code = await runRestore({ dir: DIR, storage: live, fs, dryRun: false, log: out.log, err: out.log });
    expect(code).toBe(1);
    expect(live.uploads).toHaveLength(0);
  });
});

describe('runRestore — properties 1 + 2: pre-flight refuses damaged backups before writing anything', () => {
  it('exits 1 when there is no manifest', async () => {
    const out = collector();
    const live = liveStorage();
    const code = await runRestore({ dir: DIR, storage: live, fs: memFs(), dryRun: false, log: out.log, err: out.log });
    expect(code).toBe(1);
    expect(live.uploads).toHaveLength(0);
    expect(out.text()).toMatch(/no manifest\.json/);
  });

  it('points at manifest.incomplete.json rather than letting the operator hunt for it', async () => {
    const storage = liveStorage();
    storage.unreadable.add(ENTRY_KEY);
    const { fs } = await takeBackup(storage);
    const out = collector();
    const code = await runRestore({ dir: DIR, storage: liveStorage(), fs, dryRun: false, log: out.log, err: out.log });
    expect(code).toBe(1);
    expect(out.text()).toMatch(/manifest\.incomplete\.json IS present/);
  });

  it('exits 1 on a manifest truncated by an interrupted backup', async () => {
    const { fs } = await takeBackup();
    const raw = fs.readFile(join(DIR, 'manifest.json')).toString();
    fs.writeFile(join(DIR, 'manifest.json'), raw.slice(0, Math.floor(raw.length / 2)));
    const live = liveStorage();
    const out = collector();
    const code = await runRestore({ dir: DIR, storage: live, fs, dryRun: false, log: out.log, err: out.log });
    expect(code).toBe(1);
    expect(live.uploads).toHaveLength(0);
    expect(out.text()).toMatch(/not valid JSON/);
  });

  it('exits 1 and uploads NOTHING when one backed-up file is missing (interrupted backup)', async () => {
    const { fs } = await takeBackup();
    fs.map.delete(join(DIR, ENTRY_KEY));
    const live = liveStorage();
    live.objects.set(BRIDGE_KEY, Buffer.from('clobbered'));
    const out = collector();
    const code = await runRestore({ dir: DIR, storage: live, fs, dryRun: false, log: out.log, err: out.log });
    expect(code).toBe(1);
    expect(live.uploads).toHaveLength(0);
    // the half-rolled-back state was never created
    expect(live.objects.get(BRIDGE_KEY)).toEqual(Buffer.from('clobbered'));
    expect(out.text()).toMatch(/NOTHING was uploaded/);
  });

  it('exits 1 and uploads NOTHING on a hash mismatch between the manifest and the file on disk', async () => {
    const { fs } = await takeBackup();
    // Same byte count, different bytes — only the hash can catch this; the size check cannot.
    fs.writeFile(join(DIR, BRIDGE_KEY), Buffer.alloc(BRIDGE_BYTES.length, 0x58));
    const live = liveStorage();
    const out = collector();
    const code = await runRestore({ dir: DIR, storage: live, fs, dryRun: false, log: out.log, err: out.log });
    expect(code).toBe(1);
    expect(live.uploads).toHaveLength(0);
    expect(out.text()).toMatch(/HASH MISMATCH/);
  });
});

describe('runRestore — an interrupted restore is reported, never rounded up to success', () => {
  it('exits 1, keeps going past the failure, and names the package left across two generations', async () => {
    const { fs } = await takeBackup();
    const live = liveStorage();
    live.objects.set(BRIDGE_KEY, Buffer.from('clobbered'));
    live.objects.set(ENTRY_KEY, Buffer.from('clobbered html'));
    live.unwritable.add(ENTRY_KEY); // the entry upload dies mid-restore

    const out = collector();
    const code = await runRestore({ dir: DIR, storage: live, fs, dryRun: false, log: out.log, err: out.log });

    expect(code).toBe(1);
    expect(out.text()).toMatch(/UPLOAD FAILED/);
    expect(out.text()).toMatch(/PARTIALLY restored packages/);
    expect(out.text()).toContain('sim-a');
    // the files that COULD be restored still were, so a re-run has less to do
    expect(live.objects.get(BRIDGE_KEY)).toEqual(BRIDGE_BYTES);
    expect(live.objects.get(ENTRY_KEY)).toEqual(Buffer.from('clobbered html'));
  });

  it('a re-run after the transient failure clears it and exits 0', async () => {
    const { fs } = await takeBackup();
    const live = liveStorage();
    live.objects.set(ENTRY_KEY, Buffer.from('clobbered html'));
    live.unwritable.add(ENTRY_KEY);
    expect(await runRestore({ dir: DIR, storage: live, fs, dryRun: false, log: () => {}, err: () => {} })).toBe(1);
    live.unwritable.delete(ENTRY_KEY);
    expect(await runRestore({ dir: DIR, storage: live, fs, dryRun: false, log: () => {}, err: () => {} })).toBe(0);
    expect(live.objects.get(ENTRY_KEY)).toEqual(ENTRY_BYTES);
  });
});

describe('runRestore — property 9: --dry-run', () => {
  it('pre-flights every byte and uploads nothing', async () => {
    const { fs } = await takeBackup();
    const live = liveStorage();
    live.objects.set(BRIDGE_KEY, Buffer.from('clobbered'));
    const out = collector();
    const code = await runRestore({ dir: DIR, storage: live, fs, dryRun: true, log: out.log, err: out.log });
    expect(code).toBe(0);
    expect(live.uploads).toHaveLength(0);
    expect(live.objects.get(BRIDGE_KEY)).toEqual(Buffer.from('clobbered'));
    expect(out.text()).toMatch(/would restore/);
  });

  it('exits 1 without uploading when the dry run finds a damaged backup', async () => {
    const { fs } = await takeBackup();
    fs.map.delete(join(DIR, BRIDGE_KEY));
    const live = liveStorage();
    const code = await runRestore({ dir: DIR, storage: live, fs, dryRun: true, log: () => {}, err: () => {} });
    expect(code).toBe(1);
    expect(live.uploads).toHaveLength(0);
  });
});

// ── runVerify ─────────────────────────────────────────────────────────────────

describe('runVerify — property 9: verification-only mode', () => {
  it('exits 0 on a clean backup, writes nothing, and needs no storage at all', async () => {
    const { fs } = await takeBackup();
    const before = new Map(fs.map);
    const out = collector();
    const code = await runVerify({ dir: DIR, fs, log: out.log, err: out.log });
    expect(code).toBe(0);
    expect(fs.map).toEqual(before);
    expect(out.text()).toMatch(/3 file\(s\) match their manifest hashes/);
    // property 10 — every file is named
    for (const k of [BRIDGE_KEY, ENTRY_KEY, GUIDANCE_KEY]) expect(out.text()).toContain(k);
  });

  it('exits 1 when the backup no longer matches its own hashes', async () => {
    const { fs } = await takeBackup();
    fs.writeFile(join(DIR, ENTRY_KEY), Buffer.from('edited by hand'));
    const out = collector();
    expect(await runVerify({ dir: DIR, fs, log: out.log, err: out.log })).toBe(1);
    expect(out.text()).toMatch(/NOT restorable/);
  });

  it('--live reports drift after a rebuild as information, not as failure', async () => {
    const { fs } = await takeBackup();
    const live = liveStorage();
    live.objects.set(BRIDGE_KEY, Buffer.from('rebuilt'));
    const out = collector();
    const code = await runVerify({ dir: DIR, fs, storage: live, log: out.log, err: out.log });
    expect(code).toBe(0);
    expect(out.text()).toMatch(/DIFFERS/);
    expect(out.text()).toMatch(/1 differ/);
  });

  it('--live exits 1 when a backed-up key cannot be read from storage at all', async () => {
    const { fs } = await takeBackup();
    const live = liveStorage();
    live.unreadable.add(ENTRY_KEY);
    const out = collector();
    expect(await runVerify({ dir: DIR, fs, storage: live, log: out.log, err: out.log })).toBe(1);
    expect(out.text()).toMatch(/UNREADABLE/);
  });

  it('confirms a completed rollback by showing every key matching the backup again', async () => {
    const { fs } = await takeBackup();
    const live = liveStorage();
    live.objects.set(BRIDGE_KEY, Buffer.from('rebuilt'));
    await runRestore({ dir: DIR, storage: live, fs, dryRun: false, log: () => {}, err: () => {} });
    const out = collector();
    expect(await runVerify({ dir: DIR, fs, storage: live, log: out.log, err: out.log })).toBe(0);
    expect(out.text()).toMatch(/3 match the backup, 0 differ/);
  });
});

// ── CLI surface ───────────────────────────────────────────────────────────────

describe('parseArgs / loadManifest', () => {
  it('separates the mode and directory from the flags in any order', () => {
    expect(parseArgs(['backup', './b', '--dry-run'])).toEqual({ mode: 'backup', dir: './b', force: false, dryRun: true, live: false });
    expect(parseArgs(['--force', 'restore', './b'])).toEqual({ mode: 'restore', dir: './b', force: true, dryRun: false, live: false });
    expect(parseArgs(['verify', './b', '--live'])).toEqual({ mode: 'verify', dir: './b', force: false, dryRun: false, live: true });
    expect(parseArgs([]).mode).toBeUndefined();
  });

  it('reports a missing manifest rather than throwing', () => {
    expect(loadManifest(memFs(), DIR).problem).toMatch(/no manifest\.json/);
  });
});

// ── rebuild-sim-bridges pure helpers ──────────────────────────────────────────

describe('rebuild-sim-bridges — decideRebuildAction', () => {
  it('skips only when BOTH the bridge and the entry HTML are already current', () => {
    expect(decideRebuildAction({ bridgeJs: 'a', combined: 'a', rawHtml: 'h', updatedHtml: 'h' })).toBe('unchanged');
  });

  it('repairs a partially applied package (new bridge landed, entry upload failed)', () => {
    expect(decideRebuildAction({ bridgeJs: 'a', combined: 'a', rawHtml: 'old', updatedHtml: 'new' })).toBe('update');
  });

  it('updates when the bridge is stale even though the HTML happens to match', () => {
    expect(decideRebuildAction({ bridgeJs: 'old', combined: 'new', rawHtml: 'h', updatedHtml: 'h' })).toBe('update');
  });
});

describe('rebuild-sim-bridges — detectConflicts (optimistic concurrency)', () => {
  it('passes when neither file moved under the rebuild', () => {
    expect(detectConflicts({ expectedBridge: 'b', currentBridge: 'b', expectedHtml: 'h', currentHtml: 'h' })).toEqual([]);
  });

  it('flags a user generation that landed on bridge.js mid-run', () => {
    expect(detectConflicts({ expectedBridge: 'b', currentBridge: 'b2', expectedHtml: 'h', currentHtml: 'h' }).join()).toMatch(/bridge\.js changed/);
  });

  it('flags a guidance publish that rewrote the SAME entry HTML mid-run', () => {
    const c = detectConflicts({ expectedBridge: 'b', currentBridge: 'b', expectedHtml: 'h', currentHtml: 'h+guidance' });
    expect(c.join()).toMatch(/entry HTML changed/);
  });

  it('reports both when a package moved on every axis', () => {
    expect(detectConflicts({ expectedBridge: 'b', currentBridge: 'x', expectedHtml: 'h', currentHtml: 'y' })).toHaveLength(2);
  });
});

describe('rebuild-sim-bridges — bridgeRelPathFor', () => {
  it('uses ./bridge.js for an entry at the prefix root', () => {
    expect(bridgeRelPathFor(`${PREFIX}/index.html`, PREFIX)).toBe('./bridge.js');
  });

  it('climbs one level per nested directory', () => {
    expect(bridgeRelPathFor(`${PREFIX}/dist/index.html`, PREFIX)).toBe('../bridge.js');
    expect(bridgeRelPathFor(`${PREFIX}/a/b/index.html`, PREFIX)).toBe('../../bridge.js');
  });
});

// ── End-to-end rollback ───────────────────────────────────────────────────────

describe('end-to-end: backup → rebuild clobbers the package → restore → verify', () => {
  it('returns the package to the exact pre-rebuild bytes and proves it', async () => {
    const live = liveStorage();
    const originals = new Map(live.objects);

    // 1. dry-run pre-flight writes nothing
    const dryFs = memFs();
    expect(await runBackup({ dir: DIR, packages: [PKG], storage: live, fs: dryFs, force: false, dryRun: true, log: () => {}, err: () => {} })).toBe(0);
    expect(dryFs.map.size).toBe(0);

    // 2. real backup
    const fs = memFs();
    expect(await runBackup({ dir: DIR, packages: [PKG], storage: live, fs, force: false, dryRun: false, log: () => {}, err: () => {} })).toBe(0);

    // 3. rebuild --apply overwrites bridge.js AND the entry HTML that carries the guidance tag
    live.objects.set(BRIDGE_KEY, Buffer.from('/* sim-bridge v3 */ rebuilt'));
    live.objects.set(ENTRY_KEY, Buffer.from('<html>rebuilt without the guidance tag</html>'));
    expect(live.objects.get(ENTRY_KEY)).not.toEqual(originals.get(ENTRY_KEY));

    // 4. rollback, then independently verify against live storage
    expect(await runRestore({ dir: DIR, storage: live, fs, dryRun: false, log: () => {}, err: () => {} })).toBe(0);
    expect(await runVerify({ dir: DIR, fs, storage: live, log: () => {}, err: () => {} })).toBe(0);

    for (const key of [BRIDGE_KEY, ENTRY_KEY, GUIDANCE_KEY]) {
      expect(createHash('sha256').update(live.objects.get(key)!).digest('hex'))
        .toBe(createHash('sha256').update(originals.get(key)!).digest('hex'));
    }
  });
});
