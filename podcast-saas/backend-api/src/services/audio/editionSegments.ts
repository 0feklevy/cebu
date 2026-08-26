/**
 * WHICH rows of a project are edition material — asked once, so two callers cannot disagree.
 *
 * There are two places that need this answer, and until 2026-08-26 they asked different
 * questions. The controller's pre-flight selected every `video_files` row of the project; the
 * job's `loadInputs` selected only the non-b-roll ones. A project whose only footage is b-roll
 * therefore passed the gate (rows exist → 202 accepted) and was then refused asynchronously by
 * the worker, which is exactly the "watch a job refuse itself two minutes later" failure the
 * pre-flight was added to prevent. The gate and the worker have to ask the SAME question or the
 * gate is not a gate.
 *
 * B-roll is excluded because an edition is the narration track: b-roll carries no narration, and
 * splicing it in would put silence — or someone else's audio bed — into the listener's episode.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { video_files } from '../../db/schema.js';
import type { EditionSegment } from './audioEdition.js';

/**
 * The project's segments, in play order, in the shape the edition rules take.
 *
 * `captionsVtt` is loaded because the builder concatenates it; the pre-flight ignores the field.
 * One query serving both is the point — a second, narrower query is how the two drifted apart.
 */
export async function loadEditionSegments(projectId: string): Promise<EditionSegment[]> {
  const rows = await db.query.video_files.findMany({
    where: and(eq(video_files.project_id, projectId), eq(video_files.is_broll, false)),
    // Callback form, not `asc(...)` at module scope: the relational builder supplies the helpers
    // at call time, which keeps this query constructible under the suites that mock `drizzle-orm`.
    orderBy: (v, { asc }) => [asc(v.sequence_order), asc(v.created_at)],
  });
  return rows.map((v) => ({
    audioKey: v.storage_key ?? '',
    durationMs: Math.round((v.duration_sec ?? 0) * 1000),
    captionsVtt: v.captions_vtt,
  }));
}
