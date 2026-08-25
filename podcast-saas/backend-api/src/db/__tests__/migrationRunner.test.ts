/**
 * The migration runner itself, against a real Postgres engine (PGlite).
 *
 * The bug these exist to prevent (audit finding database-001): the old runner treated a
 * duplicate-object error as proof the file had already been applied. Postgres runs a
 * multi-statement file in one implicit transaction, so that error had already rolled the WHOLE
 * file back — including any genuinely-new DDL in it — and the runner then wrote the tracker row
 * anyway. The new statements were silently dropped and could never be retried, because the runner
 * believed it had run them. Reproduced on PGlite before the fix: the new table was absent, the
 * tracker row present, and the retry skipped the file.
 *
 * Fixtures are written to a TEMP directory, never to db/migrations — migration059.test.ts asserts
 * that every .sql file in that directory is registered with both runners, so a fixture dropped
 * there would fail an unrelated suite.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runMigrations,
  migrationChecksum,
  MIGRATION_FILES,
  MIGRATION_LOCK_KEY,
  type MigrationClient,
  type MigrationLogger,
} from '../migrate.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Silent logger — the runner logs loudly by design and the suite does not need the noise. */
const silent: MigrationLogger = { info() {}, warn() {}, error() {} };

let pg: PGlite;
let dir: string;

function client(db: PGlite = pg): MigrationClient {
  return {
    async query<T>(text: string, params: unknown[] = []): Promise<T[]> {
      return (await db.query<T>(text, params)).rows;
    },
    async exec(text: string): Promise<void> {
      await db.exec(text);
    },
  };
}

/** Write a fixture migration and return its filename. */
function write(file: string, sql: string): string {
  writeFileSync(join(dir, file), sql, 'utf-8');
  return file;
}

function run(files: string[], c: MigrationClient = client()) {
  return runMigrations({ client: c, migrationsDir: dir, files, logger: silent });
}

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pg.query<T>(sql, params)).rows;
}

/** Does a relation exist? The question every one of these tests actually asks. */
async function exists(table: string): Promise<boolean> {
  const [r] = await rows<{ x: string | null }>(`SELECT to_regclass($1) AS x`, [table]);
  return r.x !== null;
}

async function tracked(): Promise<string[]> {
  return (await rows<{ filename: string }>('SELECT filename FROM schema_migrations ORDER BY filename')).map(
    (r) => r.filename,
  );
}

beforeEach(async () => {
  pg = new PGlite();
  dir = mkdtempSync(join(tmpdir(), 'flowvid-migrate-'));
});

afterEach(async () => {
  await pg.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('migration runner — applying', () => {
  it('applies pending files in order and records each with a checksum', async () => {
    const a = write('001_alpha.sql', 'CREATE TABLE alpha (id int);');
    const b = write('002_beta.sql', 'CREATE TABLE beta (id int);');

    const summary = await run([a, b]);

    expect(summary.applied).toEqual([a, b]);
    expect(summary.skipped).toEqual([]);
    expect(await exists('alpha')).toBe(true);
    expect(await exists('beta')).toBe(true);
    expect(await tracked()).toEqual([a, b]);

    const recorded = await rows<{ filename: string; checksum: string }>(
      'SELECT filename, checksum FROM schema_migrations ORDER BY filename',
    );
    expect(recorded.map((r) => r.checksum)).toEqual([
      migrationChecksum('CREATE TABLE alpha (id int);'),
      migrationChecksum('CREATE TABLE beta (id int);'),
    ]);
  });

  it('is idempotent — a second run applies nothing and skips everything', async () => {
    const a = write('001_alpha.sql', 'CREATE TABLE alpha (id int);');
    await run([a]);

    const second = await run([a]);

    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual([a]);
    expect(await tracked()).toEqual([a]);
  });

  it('applies only the NEW file when an earlier one is already recorded', async () => {
    const a = write('001_alpha.sql', 'CREATE TABLE alpha (id int);');
    await run([a]);
    const b = write('002_beta.sql', 'CREATE TABLE beta (id int);');

    const summary = await run([a, b]);

    expect(summary).toMatchObject({ applied: [b], skipped: [a] });
    expect(await exists('beta')).toBe(true);
  });

  it('fails before applying anything when a listed file is missing from disk', async () => {
    const a = write('001_alpha.sql', 'CREATE TABLE alpha (id int);');

    await expect(run([a, '002_missing.sql'])).rejects.toThrow(/ENOENT|no such file/i);

    // Nothing applied — not even the file that precedes the missing one.
    expect(await exists('alpha')).toBe(false);
    expect(await tracked()).toEqual([]);
  });
});

describe('migration runner — a file that fails partway (database-001)', () => {
  // The exact shape of the original bug: one statement that collides with existing schema,
  // followed by genuinely-new DDL. The old runner swallowed the collision and marked it applied.
  const MIXED = 'CREATE TABLE widgets (id int);\nCREATE TABLE brand_new (id int);\n';

  it('rolls back BOTH the schema change and the tracker row', async () => {
    await pg.exec('CREATE TABLE widgets (id int);'); // applied outside the tracker
    const f = write('001_mixed.sql', MIXED);

    await expect(run([f])).rejects.toThrow();

    expect(await exists('brand_new')).toBe(false); // the genuinely-new DDL
    expect(await tracked()).toEqual([]); // and no claim that it ran
  });

  it('no longer tolerates duplicate-object errors (42P07) as "already applied"', async () => {
    await pg.exec('CREATE TABLE widgets (id int);');
    const f = write('001_mixed.sql', MIXED);

    await expect(run([f])).rejects.toMatchObject({ code: '42P07' });
  });

  it('RETRIES the file on the next run — the runner never claims it ran', async () => {
    await pg.exec('CREATE TABLE widgets (id int);');
    const f = write('001_mixed.sql', MIXED);
    await expect(run([f])).rejects.toThrow();

    // Repair the collision the way an operator would, then re-run. Nothing was recorded, so the
    // file is genuinely retried rather than skipped — the property the old runner destroyed.
    await pg.exec('DROP TABLE widgets;');
    const summary = await run([f]);

    expect(summary.applied).toEqual([f]);
    expect(await exists('brand_new')).toBe(true);
    expect(await tracked()).toEqual([f]);
  });

  it('keeps earlier files committed and stops before later ones', async () => {
    const a = write('001_alpha.sql', 'CREATE TABLE alpha (id int);');
    const bad = write('002_bad.sql', 'CREATE TABLE mid (id int);\nTHIS IS NOT SQL;\n');
    const c = write('003_gamma.sql', 'CREATE TABLE gamma (id int);');

    await expect(run([a, bad, c])).rejects.toThrow();

    expect(await exists('alpha')).toBe(true); // committed in its own transaction
    expect(await exists('mid')).toBe(false); // rolled back with its file
    expect(await exists('gamma')).toBe(false); // never reached
    expect(await tracked()).toEqual([a]);
  });

  it('leaves the session usable — a failure does not poison the next statement', async () => {
    const bad = write('001_bad.sql', 'THIS IS NOT SQL;');
    await expect(run([bad])).rejects.toThrow();

    // If ROLLBACK had not been issued, this would fail with 25P02 (transaction aborted).
    await expect(rows('SELECT 1 AS ok')).resolves.toEqual([{ ok: 1 }]);
  });
});

describe('migration runner — checksum drift', () => {
  it('detects an already-applied file that changed on disk, and names it', async () => {
    const a = write('001_alpha.sql', 'CREATE TABLE alpha (id int);');
    await run([a]);

    write('001_alpha.sql', 'CREATE TABLE alpha (id int, extra text);'); // edited after the fact

    await expect(run([a])).rejects.toThrow(/drift detected[\s\S]*001_alpha\.sql/i);
  });

  it('aborts BEFORE applying anything else, so a tampered history is never built on', async () => {
    const a = write('001_alpha.sql', 'CREATE TABLE alpha (id int);');
    await run([a]);
    write('001_alpha.sql', 'CREATE TABLE alpha (id int, extra text);');
    const b = write('002_beta.sql', 'CREATE TABLE beta (id int);');

    await expect(run([a, b])).rejects.toThrow(/drift detected/i);

    expect(await exists('beta')).toBe(false);
    expect(await tracked()).toEqual([a]);
  });

  it('tolerates whitespace-only line-ending differences (CRLF is not tampering)', async () => {
    const a = write('001_alpha.sql', 'CREATE TABLE alpha (id int);\nCREATE TABLE two (id int);\n');
    await run([a]);

    write('001_alpha.sql', 'CREATE TABLE alpha (id int);\r\nCREATE TABLE two (id int);\r\n');

    await expect(run([a])).resolves.toMatchObject({ skipped: [a] });
  });

  it('adopts a baseline for pre-checksum rows instead of failing every existing deployment', async () => {
    // A database migrated by the OLD runner: tracker table with no checksum column at all.
    await pg.exec(`CREATE TABLE schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await pg.exec(`INSERT INTO schema_migrations (filename) VALUES ('001_alpha.sql')`);
    await pg.exec('CREATE TABLE alpha (id int);');
    const a = write('001_alpha.sql', 'CREATE TABLE alpha (id int);');

    const first = await run([a]);

    expect(first.checksumAdopted).toEqual([a]);
    expect(first.applied).toEqual([]);
    const [row] = await rows<{ checksum: string }>('SELECT checksum FROM schema_migrations');
    expect(row.checksum).toBe(migrationChecksum('CREATE TABLE alpha (id int);'));

    // …and from that baseline forward, drift IS detected.
    write('001_alpha.sql', 'CREATE TABLE alpha (id int, extra text);');
    await expect(run([a])).rejects.toThrow(/drift detected/i);
  });
});

describe('migration runner — concurrent runners', () => {
  /** A FIFO mutex: what a real cross-session advisory lock provides, modelled in one process. */
  function createMutex() {
    let tail: Promise<void> = Promise.resolve();
    return {
      async acquire(): Promise<() => void> {
        let release!: () => void;
        const mine = new Promise<void>((res) => {
          release = res;
        });
        const prev = tail;
        tail = tail.then(() => mine);
        await prev;
        return release;
      },
    };
  }

  /**
   * PGlite is a single in-process session, so it cannot host two real sessions contending for a
   * Postgres advisory lock. This client keeps every statement on the one database but routes the
   * lock statements through a real mutex — so the runner's OWN serialization protocol is under
   * test: that it takes the lock before touching anything and holds it until it is done.
   */
  function lockedClient(name: string, mutex: ReturnType<typeof createMutex>, events: string[]): MigrationClient {
    let release: (() => void) | null = null;
    return {
      async query<T>(text: string, params: unknown[] = []): Promise<T[]> {
        return (await pg.query<T>(text, params)).rows;
      },
      async exec(text: string): Promise<void> {
        if (text.includes('pg_advisory_lock')) {
          release = await mutex.acquire();
          events.push(`${name}:lock`);
          return;
        }
        if (text.includes('pg_advisory_unlock')) {
          events.push(`${name}:unlock`);
          release?.();
          release = null;
          return;
        }
        events.push(`${name}:sql`);
        await pg.exec(text);
      },
    };
  }

  it('serializes two runners: the second waits, then finds the work already done', async () => {
    const a = write('001_alpha.sql', 'CREATE TABLE alpha (id int);');
    const b = write('002_beta.sql', 'CREATE TABLE beta (id int);');
    const mutex = createMutex();
    const events: string[] = [];

    const [first, second] = await Promise.all([
      run([a, b], lockedClient('A', mutex, events)),
      run([a, b], lockedClient('B', mutex, events)),
    ]);

    // Exactly one runner did the work; neither applied anything twice.
    expect(first.applied).toEqual([a, b]);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual([a, b]);
    expect(await tracked()).toEqual([a, b]);
    expect(await exists('alpha')).toBe(true);
    expect(await exists('beta')).toBe(true);

    // No interleaving: A's whole critical section precedes B taking the lock.
    const lockOrder = events.filter((e) => e.endsWith(':lock') || e.endsWith(':unlock'));
    expect(lockOrder).toEqual(['A:lock', 'A:unlock', 'B:lock', 'B:unlock']);
    expect(events.indexOf('B:lock')).toBeGreaterThan(events.lastIndexOf('A:sql'));
  });

  it('releases the lock even when the run fails, so the next runner is not deadlocked', async () => {
    const bad = write('001_bad.sql', 'THIS IS NOT SQL;');
    const mutex = createMutex();
    const events: string[] = [];

    await expect(run([bad], lockedClient('A', mutex, events))).rejects.toThrow();
    expect(events.filter((e) => e === 'A:unlock')).toEqual(['A:unlock']);

    // The lock is genuinely free: a second runner acquires it and completes.
    const ok = write('001_bad.sql', 'CREATE TABLE recovered (id int);');
    await expect(run([ok], lockedClient('B', mutex, events))).resolves.toMatchObject({ applied: [ok] });
  });

  it('takes a real Postgres advisory lock first and releases it last', async () => {
    const a = write('001_alpha.sql', 'CREATE TABLE alpha (id int);');
    const seen: string[] = [];
    const recording: MigrationClient = {
      async query<T>(text: string, params: unknown[] = []): Promise<T[]> {
        seen.push(text.trim());
        return (await pg.query<T>(text, params)).rows;
      },
      async exec(text: string): Promise<void> {
        seen.push(text.trim());
        await pg.exec(text);
      },
    };

    await run([a], recording);

    // Real statements against a real engine — pg_advisory_lock is not stubbed here.
    expect(seen[0]).toBe(`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY})`);
    expect(seen[seen.length - 1]).toBe(`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`);
    const [held] = await rows<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_locks WHERE locktype = 'advisory'`,
    );
    expect(held.n).toBe('0'); // released, not merely issued
  });
});

describe('migration runner — the CREATE INDEX CONCURRENTLY limitation', () => {
  // Wrapping every file in a transaction means CONCURRENTLY cannot be used. That is affordable
  // because no .sql file in this repo uses it, and these tests pin BOTH halves of that claim so
  // the trade-off is discovered deliberately rather than during a deploy.
  const CONCURRENT_INDEX =
    'CREATE TABLE idx_target (id int);\nCREATE INDEX CONCURRENTLY i_target ON idx_target (id);\n';

  it('rejects it with 25001 and records nothing — a loud failure, not a silent one', async () => {
    const f = write('001_cic.sql', CONCURRENT_INDEX);

    await expect(run([f])).rejects.toMatchObject({ code: '25001' });
    expect(await exists('idx_target')).toBe(false);
    expect(await tracked()).toEqual([]); // and it stays retryable
  });

  it('would still fail without an enclosing BEGIN, which is why there is no opt-out marker', async () => {
    // A multi-statement simple query is ONE implicit transaction in Postgres, so merely omitting
    // BEGIN does not buy CONCURRENTLY anything. Supporting it needs statement-by-statement
    // execution. This test is the evidence for that design note in migrate.ts.
    await expect(pg.exec(CONCURRENT_INDEX)).rejects.toMatchObject({ code: '25001' });
    // …whereas the very same statement succeeds when sent on its own.
    await pg.exec('CREATE TABLE solo (id int);');
    await expect(pg.query('CREATE INDEX CONCURRENTLY i_solo ON solo (id)')).resolves.toBeDefined();
  });

  it('no migration on disk uses CONCURRENTLY — the assumption the trade-off rests on', async () => {
    // Comments are stripped first: 056 and 058 both use the English word "concurrently" in prose,
    // and counting those as offenders would make this test cry wolf forever.
    const stripComments = (sql: string) => sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
    const migrationsDir = join(HERE, '..', 'migrations');
    const offenders = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .filter((f) => /\bCONCURRENTLY\b/i.test(stripComments(readFileSync(join(migrationsDir, f), 'utf-8'))));
    expect(offenders).toEqual([]);
  });
});

describe('migration runner — the hardcoded list contract', () => {
  it('stays extractable by the release engine regex', async () => {
    // ops/release/src/migration-audit.ts runnerListFromSource() parses this exact shape. If the
    // array stops matching, the release audit silently loses its only view of the runner.
    const source = readFileSync(join(HERE, '..', 'migrate.ts'), 'utf-8');
    const m = source.match(/const\s+migrations\s*=\s*\[([\s\S]*?)\]/);
    expect(m).not.toBeNull();
    const extracted = [...m![1].matchAll(/'([^']+\.sql)'/g)].map((x) => x[1]);

    expect(extracted).toEqual([...MIGRATION_FILES]);
    expect(extracted).toEqual([...extracted].sort());
    expect(extracted.length).toBeGreaterThan(0);
  });

  it('quotes no .sql filename outside that array', async () => {
    // migration059.test.ts scans the WHOLE file for quoted NNN_*.sql names and requires each to
    // exist on disk and to be in sorted order — a filename in a comment would fail that suite.
    const source = readFileSync(join(HERE, '..', 'migrate.ts'), 'utf-8');
    const all = [...source.matchAll(/'(\d{3}_[^']+\.sql)'/g)].map((x) => x[1]);
    expect(all).toEqual([...MIGRATION_FILES]);
  });

  it('scripts/check-db.ts holds an IDENTICAL list — the second copy nothing was guarding', () => {
    // `check-db.ts` declares its own `const MIGRATION_FILES = [...]` literal instead of importing
    // this one, shadowing the name. The two agree today, and until now nothing structural kept
    // them agreeing: the only guard was per-migration (each migration test asserting its OWN
    // filename appears in both files), so a migration whose author writes no such test drifts
    // silently — and `pnpm db:check` then reports a database as up to date while the runner
    // would still have work to do.
    const source = readFileSync(join(HERE, '..', '..', 'scripts', 'check-db.ts'), 'utf-8');
    const m = source.match(/const\s+MIGRATION_FILES\s*=\s*\[([\s\S]*?)\]/);
    expect(m, 'check-db.ts no longer declares a MIGRATION_FILES array').not.toBeNull();
    const theirs = [...m![1].matchAll(/'([^']+\.sql)'/g)].map((x) => x[1]);
    expect(theirs).toEqual([...MIGRATION_FILES]);
  });

  it('every forward .sql on disk is registered — an unregistered file never runs, silently', () => {
    // CLAUDE.md §5 names this as a thing that will mislead you. The failure is invisible: the
    // file exists, review sees it, and it simply never executes.
    const onDisk = readdirSync(join(HERE, '..', 'migrations'))
      .filter((f) => /^\d{3}_[^.]+\.sql$/.test(f))
      .sort();
    expect(onDisk).toEqual([...MIGRATION_FILES]);
  });
});
