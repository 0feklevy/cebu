/**
 * RE-TRANSCODING A VIDEO MUST NOT TRUNCATE THE MUSIC PLAYING OVER IT.
 *
 * `video_file_id` does not mean the same thing on every track, and the cut-to-fit clamp assumed it
 * did. On `main` and `broll` rows it is the media whose in/out points `start_sec`/`end_sec`
 * address. On an `audio` cutaway it is only the HOST the cutaway hangs from — the row's start/end
 * are offsets into the AUDIO file, and the client posts the first main video as the host whatever
 * its length.
 *
 * So a 60-second music bed dropped onto a 12-second first video was silently rewritten to end at
 * 12 the moment that video was replaced or re-transcoded, in the player and in the exported MP4,
 * with the original length gone from the row. Found by a cross-subsystem hunt; no single-domain
 * reviewer could see it, because it needs the audio controller, the transcode job and the export
 * planner in one head.
 *
 * Real Postgres (PGlite), the real predicate, not a mock of it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const JOB_SRC = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../runVideoTranscode.ts'),
  'utf-8',
);

let db: PGlite;

/** The shipped clamp, transcribed. Kept in one place so the test cannot drift from intent. */
const CLAMP = `
  UPDATE timeline_sections
     SET end_sec   = LEAST(end_sec,   $1),
         start_sec = LEAST(start_sec, $1)
   WHERE video_file_id = $2
     AND end_sec > $1
     AND track IN ('main','broll')
`;

beforeEach(async () => {
  db = new PGlite();
  await db.query(`CREATE TABLE timeline_sections (
    id text PRIMARY KEY, video_file_id text, track text NOT NULL DEFAULT 'main',
    start_sec double precision, end_sec double precision
  )`);
  await db.query(`INSERT INTO timeline_sections VALUES
    ('sec-audio','vid-main-1','audio', 0, 60),
    ('sec-clip', 'vid-main-1','broll', 0, 40),
    ('sec-main', 'vid-main-1','main',  0, 40)`);
});

const endOf = async (id: string) => {
  const r = await db.query<{ end_sec: number }>('SELECT end_sec FROM timeline_sections WHERE id=$1', [id]);
  return r.rows[0].end_sec;
};

describe('cut-to-fit clamps media, not hosts', () => {
  it('leaves a 60s audio cutaway alone when its 12s host is re-transcoded', async () => {
    await db.query(CLAMP, [12, 'vid-main-1']);
    expect(await endOf('sec-audio')).toBe(60);
  });

  it('still clamps a b-roll clip that genuinely points past the new end', async () => {
    await db.query(CLAMP, [12, 'vid-main-1']);
    expect(await endOf('sec-clip')).toBe(12);
  });

  it('still clamps a main-track section', async () => {
    await db.query(CLAMP, [12, 'vid-main-1']);
    expect(await endOf('sec-main')).toBe(12);
  });

  it('touches nothing when the new duration is longer than every row', async () => {
    await db.query(CLAMP, [999, 'vid-main-1']);
    expect(await endOf('sec-audio')).toBe(60);
    expect(await endOf('sec-clip')).toBe(40);
    expect(await endOf('sec-main')).toBe(40);
  });

  it('the UNSCOPED predicate destroys the cutaway — the bug, kept as the contrast case', async () => {
    // Without `track IN ('main','broll')` the same statement rewrites the music bed to 12s.
    await db.query(`UPDATE timeline_sections SET end_sec = LEAST(end_sec, $1)
                     WHERE video_file_id = $2 AND end_sec > $1`, [12, 'vid-main-1']);
    expect(await endOf('sec-audio')).toBe(12);
  });

  it('the shipped clamp still carries the track predicate', () => {
    // The cases above run TRANSCRIBED SQL against real Postgres — they prove the predicate is
    // necessary (see the contrast case) but they cannot notice it being deleted from the job,
    // because drizzle builds that statement and this suite does not call it. A mutation check
    // caught exactly that gap. This closes it.
    const code = JOB_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).toMatch(/inArray\(\s*timeline_sections\.track,\s*\['main',\s*'broll'\]\s*\)/);
  });
});
