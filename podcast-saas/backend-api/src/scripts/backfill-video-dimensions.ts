/**
 * backfill-video-dimensions — fill `video_files.width/height` (migration 082) for rows that
 * predate it, so existing portrait projects stop being treated as landscape.
 *
 * Usage (dev machine):
 *   pnpm --filter backend-api videos:backfill-dimensions                # DRY RUN — reports only
 *   pnpm --filter backend-api videos:backfill-dimensions -- --apply     # writes width/height
 *
 * On the VM there is no Node or pnpm outside the container (see reinject-sim-gates.ts for the
 * lesson); run it inside the backend container, where the env is already set:
 *   docker compose exec backend pnpm --filter backend-api exec tsx src/scripts/backfill-video-dimensions.ts [--apply]
 *
 * What it does, per row with a storage key and NULL width: mint a short presigned download URL,
 * let ffprobe read the container header over HTTP (it needs the moov atom, not the whole file —
 * a few hundred KB for a faststart MP4), and store the DISPLAYED geometry exactly as the
 * transcode probe would (rotation tag + sample aspect applied, shared/src/video/orientation.ts).
 *
 * Idempotent: rows with a width are skipped, so a second run reports "all current". Rate-limited
 * by the same ffmpeg concurrency gate as every other probe. Never touches HLS, crops or captions:
 * a project whose orientation changes as a result needs a re-transcode to get the portrait ladder
 * (`POST /videos/:id/reprocess` or a replace); this script only makes the orientation KNOWN.
 *
 * Never reads a .env file itself — the package script supplies the env, or the container has it.
 */
import { and, isNull, isNotNull, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { video_files } from '../db/schema.js';
import { getStorageAdapter } from '../services/storage/getStorageAdapter.js';
import { probeMediaInfo } from '../services/video/HLSTranscoder.js';

const APPLY = process.argv.includes('--apply');
const LIMIT = Number(process.argv.find((a) => a.startsWith('--limit='))?.slice('--limit='.length) ?? '0') || 0;

async function main(): Promise<void> {
  const storage = getStorageAdapter();
  const rows = await db.query.video_files.findMany({
    where: and(isNull(video_files.width), isNotNull(video_files.storage_key)),
    columns: { id: true, project_id: true, filename: true, storage_key: true, is_broll: true },
  });
  const todo = LIMIT > 0 ? rows.slice(0, LIMIT) : rows;
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'}: ${rows.length} video(s) without geometry${LIMIT ? ` (processing ${todo.length})` : ''}`);

  let probed = 0, written = 0, failed = 0, portrait = 0;
  for (const v of todo) {
    try {
      const url = await storage.getPresignedDownloadUrl(v.storage_key!, 600);
      const info = await probeMediaInfo(url);
      if (!info.width || !info.height) {
        failed++;
        console.log(`  ? ${v.id} ${v.filename}: ffprobe reported no geometry`);
        continue;
      }
      probed++;
      if (info.orientation === 'portrait') portrait++;
      console.log(`  ${APPLY ? '✓' : '·'} ${v.id} ${v.filename}: ${info.width}×${info.height} (${info.orientation})${v.is_broll ? ' [b-roll]' : ''}`);
      if (APPLY) {
        await db.update(video_files)
          .set({ width: info.width, height: info.height })
          .where(and(eq(video_files.id, v.id), isNull(video_files.width)));
        written++;
      }
    } catch (err) {
      failed++;
      console.log(`  ✗ ${v.id} ${v.filename}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`done: probed ${probed}, ${APPLY ? `written ${written}` : 'written 0 (dry run)'}, failed ${failed}, portrait ${portrait}`);
  if (!APPLY && probed > 0) console.log('re-run with --apply to write these values');
  process.exit(failed > 0 && probed === 0 ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
