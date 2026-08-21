/**
 * THE REVIEW QUEUE, AGAINST A REAL DATABASE — the service, its real SQL, and the real constraints.
 *
 * Two things here can only fail at runtime and would pass any mock:
 *
 *   • THE UPSERT INFERS A PARTIAL INDEX. `uniq_placement_impact_open` is
 *     `UNIQUE (section_id, reason) WHERE resolved_at IS NULL`, and Postgres will not match an
 *     `ON CONFLICT (section_id, reason)` to it unless the statement repeats the predicate. Get that
 *     wrong and every insert raises "no unique or exclusion constraint matching the ON CONFLICT
 *     specification" — from a background job, into a swallowed catch, forever silent.
 *   • THE SERVICE MUST NOT WRITE TO `timeline_sections`. That is the whole ruling. Asserted here by
 *     reading every placement column back after a run that finds impacts, so it holds whatever the
 *     implementation becomes.
 *
 * The db module is mocked to a drizzle-over-PGlite instance, so the code under test is the shipped
 * code and the SQL it emits is executed by an actual Postgres.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../../../db/schema.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'db', 'migrations');
const ALL = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{3}_[^.]+\.sql$/.test(f)).sort();

let pg: PGlite;
const holder: { db: unknown } = { db: null };

vi.mock('../../../db/index.js', () => ({ get db() { return holder.db; } }));
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { recordHostMediaImpacts, resolveOpenReviewsForSections } =
  await import('../placementImpact.js');

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pg.query<T>(sql, params)).rows;
}
async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await rows<T>(sql, params);
  if (!r[0]) throw new Error(`expected a row from: ${sql}`);
  return r[0];
}

let projectId: string;
let hostId: string;
let sourceId: string;

beforeEach(async () => {
  pg = new PGlite();
  for (const f of ALL) await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
  holder.db = drizzle(pg, { schema });

  const org = await one<{ id: string }>(`INSERT INTO orgs (name) VALUES ('O') RETURNING id`);
  const user = await one<{ id: string }>(
    `INSERT INTO users (firebase_uid, email) VALUES ('uid-imp', 'e@test') RETURNING id`);
  const project = await one<{ id: string }>(
    `INSERT INTO projects (org_id, created_by, title) VALUES ($1,$2,'P') RETURNING id`,
    [org.id, user.id]);
  projectId = project.id;

  // The host, already carrying its NEW (replaced, shorter) duration — the service is called after
  // the probe has written it, exactly as the transcode job calls it.
  const host = await one<{ id: string }>(
    `INSERT INTO video_files (project_id, filename, file_size, storage_key, status, duration_sec)
     VALUES ($1,'intro.mp4',10,$2,'ready',12) RETURNING id`, [projectId, `videos/${projectId}/intro.mp4`]);
  hostId = host.id;

  // A SECOND main video after it. Not scenery: the last segment of a project has a legal post-roll
  // tail, so an anchor past the end of a one-video project is still in range by design. The fault
  // being tested only exists at an INTERIOR seam, where the instant past the host belongs to the
  // next video.
  await one<{ id: string }>(
    `INSERT INTO video_files (project_id, filename, file_size, storage_key, status, duration_sec)
     VALUES ($1,'body.mp4',10,$2,'ready',40) RETURNING id`, [projectId, `videos/${projectId}/body.mp4`]);
  const src = await one<{ id: string }>(
    `INSERT INTO video_files (project_id, filename, file_size, storage_key, status, is_broll, duration_sec)
     VALUES ($1,'gen.mp4',10,$2,'ready',true,20) RETURNING id`, [projectId, `videos/${projectId}/gen.mp4`]);
  sourceId = src.id;
});
afterEach(async () => { await pg.close(); });

/** A b-roll anchored 20s into a host that is now 12s long. */
async function anchoredTooLate(): Promise<string> {
  const r = await one<{ id: string }>(
    `INSERT INTO timeline_sections (project_id, video_file_id, start_sec, end_sec, type, track,
                                    global_offset_sec, placement_mode, anchor_video_file_id,
                                    anchor_offset_sec)
     VALUES ($1,$2,0,6,'broll','broll',20,'segment',$3,20) RETURNING id`,
    [projectId, sourceId, hostId]);
  return r.id;
}

const runReplace = () => recordHostMediaImpacts({
  projectId, hostVideoFileId: hostId, afterDurationSec: 12, beforeDurationSec: 30,
  kind: 'media_replace',
});

describe('recordHostMediaImpacts', () => {
  it('opens one review for an anchor the replacement left outside its host', async () => {
    const sectionId = await anchoredTooLate();
    const impacts = await runReplace();
    expect(impacts.map((i) => i.reason)).toEqual(['anchor_out_of_range']);

    const review = await one<Record<string, unknown>>(
      `SELECT * FROM placement_impact_reviews WHERE section_id=$1`, [sectionId]);
    expect(review.reason).toBe('anchor_out_of_range');
    expect(review.change_kind).toBe('media_replace');
    expect(Number(review.host_duration_before_sec)).toBe(30);
    expect(Number(review.host_duration_after_sec)).toBe(12);
    expect(Number(review.anchor_offset_sec)).toBe(20);
    expect(review.resolved_at).toBeNull();
  });

  it('WRITES NOTHING to the section — the ruling, asserted as data', async () => {
    const sectionId = await anchoredTooLate();
    const before = await one(
      `SELECT start_sec, end_sec, global_offset_sec, placement_mode, anchor_video_file_id,
              anchor_offset_sec FROM timeline_sections WHERE id=$1`, [sectionId]);
    await runReplace();
    expect(await one(
      `SELECT start_sec, end_sec, global_offset_sec, placement_mode, anchor_video_file_id,
              anchor_offset_sec FROM timeline_sections WHERE id=$1`, [sectionId])).toEqual(before);
  });

  it('is idempotent: a re-driven job REFRESHES the open item instead of appending one', async () => {
    // The partial-index inference lives or dies here. A mock cannot tell you whether Postgres
    // matched the index; this runs the statement twice against a real one.
    await anchoredTooLate();
    await runReplace();
    await runReplace();
    await runReplace();
    expect(await rows(`SELECT id FROM placement_impact_reviews`)).toHaveLength(1);
  });

  it('re-opens after the author resolved it, because a second replace is a second decision', async () => {
    const sectionId = await anchoredTooLate();
    await runReplace();
    await resolveOpenReviewsForSections([sectionId], 'accepted');
    await runReplace();

    const all = await rows<{ resolution: string | null }>(
      `SELECT resolution FROM placement_impact_reviews WHERE section_id=$1 ORDER BY detected_at`,
      [sectionId]);
    expect(all.map((r) => r.resolution)).toEqual(['accepted', null]);
  });

  it('files the window fault and the anchor fault as separate decisions', async () => {
    // One row that is both anchored into the replaced host AND sourced from it: two different
    // things are wrong with it, and an author told only "this is broken" cannot fix both.
    await one<{ id: string }>(
      `INSERT INTO timeline_sections (project_id, video_file_id, start_sec, end_sec, type, track,
                                      global_offset_sec, placement_mode, anchor_video_file_id,
                                      anchor_offset_sec)
       VALUES ($1,$2,0,25,'broll','broll',20,'segment',$2,20) RETURNING id`, [projectId, hostId]);
    await runReplace();
    const reasons = await rows<{ reason: string }>(
      `SELECT reason FROM placement_impact_reviews ORDER BY reason`);
    expect(reasons.map((r) => r.reason))
      .toEqual(['anchor_out_of_range', 'source_window_out_of_range']);
  });

  it('opens nothing when the change hurt no row — the normal outcome of a correction', async () => {
    await one<{ id: string }>(
      `INSERT INTO timeline_sections (project_id, video_file_id, start_sec, end_sec, type, track,
                                      global_offset_sec, placement_mode, anchor_video_file_id,
                                      anchor_offset_sec)
       VALUES ($1,$2,0,6,'broll','broll',5,'segment',$3,5) RETURNING id`,
      [projectId, sourceId, hostId]);
    await recordHostMediaImpacts({
      projectId, hostVideoFileId: hostId, afterDurationSec: 12, beforeDurationSec: 12.04,
      kind: 'duration_correction',
    });
    expect(await rows(`SELECT id FROM placement_impact_reviews`)).toEqual([]);
  });

  it('leaves an audio cutaway alone — its window is in the AUDIO file, not in this video', async () => {
    // The regression that motivated the `track` predicate on the deleted clamp, now a property of
    // the shared planner rather than of one WHERE clause.
    const audio = await one<{ id: string }>(
      `INSERT INTO audio_files (project_id, filename, storage_key, url, duration_sec)
       VALUES ($1,'bed.mp3',$2,$3,60) RETURNING id`,
      [projectId, `audio/${projectId}/bed.mp3`, `https://example.test/bed.mp3`]);
    await one<{ id: string }>(
      `INSERT INTO timeline_sections (project_id, video_file_id, clip_source_audio_id, start_sec,
                                      end_sec, type, track, global_offset_sec)
       VALUES ($1,$2,$3,0,60,'audio','audio',0) RETURNING id`, [projectId, hostId, audio.id]);
    await runReplace();
    expect(await rows(`SELECT id FROM placement_impact_reviews`)).toEqual([]);
  });
});
