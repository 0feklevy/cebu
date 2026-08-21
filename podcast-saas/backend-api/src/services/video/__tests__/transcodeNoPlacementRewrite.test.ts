/**
 * A TRANSCODE MAY NOT REWRITE A PLACEMENT. (D-01b; replaces cutToFitScope.test.ts.)
 *
 * The job used to end every successful run with a "cut-to-fit" clamp:
 *
 *     UPDATE timeline_sections SET end_sec = LEAST(end_sec, $new), start_sec = LEAST(start_sec, $new)
 *      WHERE video_file_id = $video AND end_sec > $new AND track IN ('main','broll')
 *
 * The `track` predicate was itself a repair: without it the same statement had been rewriting
 * 60-second music beds to the length of the 12-second video under them, in the player and in the
 * exported MP4, permanently. That fix was correct and did not go far enough — the remaining rows
 * were the same defect waiting for a shorter replacement, because the statement's real problem is
 * not WHICH rows it picked but that a background job was silently overwriting authored values with
 * no copy of the previous number and nothing shown to the author.
 *
 * The ruling replaces it with two things, and this file is the seam between them:
 *   • the job records an IMPACT REVIEW and writes nothing (`placementImpact.ts`, tested against a
 *     real database in migration069.test.ts and as pure logic in shared/timeline/hostChange);
 *   • the export planner caps an over-long window to the media it can actually reach, at read time,
 *     on a copy (`capToSource`, below).
 *
 * WHAT EACH TEST HERE IS WORTH. The first case runs the DELETED statement against real Postgres:
 * it is the evidence for why it is gone, and it stays because "we removed a clamp" is not a claim
 * anyone can check later without seeing what the clamp did. The second reads the job's SOURCE, and
 * that is a weak instrument — it proves the statement is not written there, not that no write
 * happens — so it is scoped narrowly to "this file does not UPDATE timeline_sections" and the real
 * behavioural coverage lives in the two suites named above.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capToSource } from '../../export/exportPlan.js';

const JOB_SRC = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../runVideoTranscode.ts'),
  'utf-8',
);

/** The statement that was removed. Kept verbatim so the contrast case cannot drift from it. */
const DELETED_CLAMP = `
  UPDATE timeline_sections
     SET end_sec   = LEAST(end_sec,   $1),
         start_sec = LEAST(start_sec, $1)
   WHERE video_file_id = $2
     AND end_sec > $1
     AND track IN ('main','broll')
`;

let db: PGlite;

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

describe('the clamp that was removed, and what it cost', () => {
  it('destroyed the authored window of every row it matched — irreversibly', async () => {
    // A 40-second b-roll and a 40-second chapter over a video replaced with a 12-second file. The
    // author's numbers are gone: nothing anywhere records that they were ever 40.
    await db.query(DELETED_CLAMP, [12, 'vid-main-1']);
    expect(await endOf('sec-clip')).toBe(12);
    expect(await endOf('sec-main')).toBe(12);
  });

  it('spared the music bed only because of a predicate someone had to remember', async () => {
    // With the `track` predicate the cutaway survives…
    await db.query(DELETED_CLAMP, [12, 'vid-main-1']);
    expect(await endOf('sec-audio')).toBe(60);

    // …and without it, the same statement truncates it. The correctness of the whole thing rested
    // on one WHERE clause staying correct as lanes were added, which is the argument for not having
    // the statement at all.
    await db.query(`UPDATE timeline_sections SET end_sec = LEAST(end_sec, $1)
                     WHERE video_file_id = $2 AND end_sec > $1`, [12, 'vid-main-1']);
    expect(await endOf('sec-audio')).toBe(12);
  });

  it('is no longer in the transcode job — which writes to no placement column at all', () => {
    // A SOURCE-TEXT check, and deliberately a narrow one: it can prove the statement is not written
    // in this file and nothing more. It is here because the file is the one place the clamp could
    // plausibly come back to, and its return would otherwise be invisible until an author lost a
    // window. The behavioural half — that a shortened host produces a REVIEW instead of an edit —
    // is asserted in migration069.test.ts and hostChange.test.ts against real data.
    const code = JOB_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/update\s*\(\s*timeline_sections\s*\)/i);
    expect(code).not.toMatch(/\bLEAST\s*\(/i);
    // And it hands the decision to the queue instead.
    expect(code).toMatch(/recordHostMediaImpacts\s*\(/);
  });
});

describe('capToSource — the read-time cap that made removing the clamp safe (D-01f)', () => {
  it('shortens an over-long out-point to the media that exists, and says by how much', () => {
    expect(capToSource(40, 12)).toEqual({ outSec: 12, shortenedBy: 28 });
  });

  it('touches a window that fits, and one that ends exactly on the last frame, not at all', () => {
    expect(capToSource(12, 40)).toEqual({ outSec: 12, shortenedBy: 0 });
    expect(capToSource(12, 12)).toEqual({ outSec: 12, shortenedBy: 0 });
  });

  it('invents nothing when the duration is unknown', () => {
    // The old code produced a "30-second source" out of nowhere for un-probed media. Exporting what
    // was authored and meeting the real file is the honest answer.
    for (const unknown of [null, undefined, 0, -1, Number.NaN]) {
      expect(capToSource(40, unknown)).toEqual({ outSec: 40, shortenedBy: 0 });
    }
  });

  it('returns a NEW value and mutates nothing — the difference from the clamp, in one line', () => {
    const authored = { end_sec: 40 };
    capToSource(authored.end_sec, 12);
    expect(authored.end_sec).toBe(40);
  });
});
