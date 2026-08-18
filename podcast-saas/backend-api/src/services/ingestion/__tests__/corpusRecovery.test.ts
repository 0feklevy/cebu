/**
 * Corpus stuck-ingestion recovery against a REAL Postgres engine (observability-002).
 *
 * THE BUG THIS SUITE EXISTS FOR
 * `CorpusBuilder.ingest` sets `ingestion_status='processing'` and is the only thing that ever
 * moves it off again — in its own happy path or its own catch. A killed process runs neither, and
 * ingestion is fire-and-forget off the upload request, so a crash mid-ingest strands the row at
 * `processing` PERMANENTLY. There was no sweep, no watchdog and no boot pass for corpora at all:
 * the client polls that column and shows "Ingesting…" until someone edits the database by hand.
 *
 * The `created_at` clock is only sound because of a structural fact this suite also pins: every
 * corpus is ingested immediately after its row is inserted, so for a `processing` row "created N
 * ago" is "has been ingesting for N".
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import * as schema from '../../../db/schema.js';

const h = vi.hoisted(() => ({ dbRef: { current: null as unknown as Record<string, unknown> } }));

vi.mock('../../../db/index.js', () => ({
  db: new Proxy({} as Record<string, unknown>, {
    get: (_t, prop: string) => {
      const target = h.dbRef.current;
      const v = target[prop];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }),
}));
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  CORPUS_STALE_AFTER_MS,
  corpusStaleBefore,
  startCorpusIngestionSweep,
  sweepStuckCorpusIngestions,
} from '../corpusRecovery.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'db', 'migrations');

let pg: PGlite;
let projectId: string;

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pg.query<T>(sql, params)).rows;
}
async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await rows<T>(sql, params);
  if (!r[0]) throw new Error(`expected a row from: ${sql}`);
  return r[0];
}

interface CorpusRow { ingestion_status: string; error: string | null; extracted_md: string | null }
const corpusRow = (id: string): Promise<CorpusRow> =>
  one<CorpusRow>(`SELECT ingestion_status, error, extracted_md FROM corpora WHERE id=$1`, [id]);

/** A corpus row created `ageMs` ago in the given ingestion state. */
async function corpus(ageMs: number, status = 'processing'): Promise<string> {
  const r = await one<{ id: string }>(
    `INSERT INTO corpora (project_id, source_type, source_url, ingestion_status, created_at)
     VALUES ($1,'pdf','paper.pdf',$2,$3) RETURNING id`,
    [projectId, status, new Date(Date.now() - ageMs).toISOString()],
  );
  return r.id;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

beforeEach(async () => {
  pg = new PGlite();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => /^\d{3}_[^.]+\.sql$/.test(x)).sort()) {
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
  }
  h.dbRef.current = drizzle(pg, { schema }) as unknown as Record<string, unknown>;
  const org = await one<{ id: string }>(`INSERT INTO orgs (name) VALUES ('Org') RETURNING id`);
  const p = await one<{ id: string }>(
    `INSERT INTO projects (org_id, title) VALUES ($1,'P') RETURNING id`, [org.id]);
  projectId = p.id;
});

afterEach(async () => {
  await pg.close();
});

describe('sweepStuckCorpusIngestions', () => {
  it('clears a corpus a crash left at processing', async () => {
    // THE REPORTED CASE: before this, the row stayed `processing` for the life of the database.
    const stranded = await corpus(CORPUS_STALE_AFTER_MS + 60_000);

    const reaped = await sweepStuckCorpusIngestions();

    expect(reaped).toBe(1);
    const row = await corpusRow(stranded);
    expect(row.ingestion_status, 'nothing else in the codebase will ever move this row').toBe('failed');
    expect(row.error, 'the user needs to be told what to do about it').toMatch(/interrupted/i);
  });

  it('leaves an ingestion that could still be running alone', async () => {
    const live = await corpus(30_000);

    expect(await sweepStuckCorpusIngestions()).toBe(0);
    expect((await corpusRow(live)).ingestion_status).toBe('processing');
  });

  it('never touches pending, ready or already-failed rows', async () => {
    const old = CORPUS_STALE_AFTER_MS + 60_000;
    const pending = await corpus(old, 'pending');
    const ready = await corpus(old, 'ready');
    const failed = await corpus(old, 'failed');

    await sweepStuckCorpusIngestions();

    expect((await corpusRow(pending)).ingestion_status).toBe('pending');
    expect((await corpusRow(ready)).ingestion_status).toBe('ready');
    expect((await corpusRow(failed)).ingestion_status).toBe('failed');
  });

  it('does not discard what a partly-finished ingest already extracted', async () => {
    const stranded = await corpus(CORPUS_STALE_AFTER_MS + 60_000);
    await pg.query(`UPDATE corpora SET extracted_md='half a paper' WHERE id=$1`, [stranded]);

    await sweepStuckCorpusIngestions();

    expect((await corpusRow(stranded)).extracted_md).toBe('half a paper');
  });

  it('is idempotent across two instances sweeping at once', async () => {
    await corpus(CORPUS_STALE_AFTER_MS + 60_000);

    const [a, b] = await Promise.all([sweepStuckCorpusIngestions(), sweepStuckCorpusIngestions()]);

    expect(a + b, 'exactly one sweep may claim the row').toBe(1);
  });

  it('honours its per-pass bound', async () => {
    const old = CORPUS_STALE_AFTER_MS + 60_000;
    await corpus(old); await corpus(old); await corpus(old);

    expect(await sweepStuckCorpusIngestions(2)).toBe(2);
    expect(await sweepStuckCorpusIngestions(2)).toBe(1);
  });

  it('the window is far longer than any real extraction', () => {
    expect(CORPUS_STALE_AFTER_MS).toBeGreaterThanOrEqual(30 * 60_000);
    expect(corpusStaleBefore(new Date(9_000_000)).getTime()).toBe(9_000_000 - CORPUS_STALE_AFTER_MS);
  });
});

describe('startCorpusIngestionSweep', () => {
  it('runs a pass at start and keeps looking afterwards', async () => {
    const atBoot = await corpus(CORPUS_STALE_AFTER_MS + 60_000);
    const stop = startCorpusIngestionSweep(200);
    try {
      await sleep(150);
      expect((await corpusRow(atBoot)).ingestion_status, 'the boot kick must run a pass').toBe('failed');

      // Stranded AFTER the kick — only a repeating sweep can ever see this one.
      const later = await corpus(CORPUS_STALE_AFTER_MS + 60_000);
      await sleep(500);
      expect((await corpusRow(later)).ingestion_status).toBe('failed');
    } finally {
      stop();
    }
  });

  it('stops when told to', async () => {
    const stop = startCorpusIngestionSweep(200);
    await sleep(150);
    stop();
    const after = await corpus(CORPUS_STALE_AFTER_MS + 60_000);
    await sleep(500);

    expect((await corpusRow(after)).ingestion_status).toBe('processing');
  });
});
