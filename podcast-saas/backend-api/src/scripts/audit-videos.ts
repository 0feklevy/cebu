/**
 * Read-only inventory of broken / orphaned video_files rows.
 *
 *   pnpm --filter backend-api videos:audit
 *
 * Lists (NEVER deletes) videos that failed transcode, lost their media, or whose project
 * is gone — so a human can decide what to re-upload (via the Library Replace ↻) or remove.
 * Deletion is intentionally out of scope: this script only reports.
 */
import { db } from '../db/index.js';
import { video_files, projects } from '../db/schema.js';
import { eq, or, isNull } from 'drizzle-orm';

type Row = {
  id: string;
  filename: string | null;
  status: string;
  hls_status: string;
  hls_error: string | null;
  storage_key: string | null;
  created_at: Date | null;
  project_title: string | null;
};

function fmt(r: Row): string {
  const when = r.created_at instanceof Date ? r.created_at.toISOString().slice(0, 10) : '';
  const err = r.hls_error ? `\n      err: ${String(r.hls_error).slice(0, 140)}` : '';
  return `  • ${r.id}  [${r.status}/${r.hls_status}]  "${(r.filename ?? '').slice(0, 44)}"  proj="${(r.project_title ?? '∅').slice(0, 32)}"  ${when}${err}`;
}

async function main(): Promise<void> {
  const rows: Row[] = await db
    .select({
      id: video_files.id,
      filename: video_files.filename,
      status: video_files.status,
      hls_status: video_files.hls_status,
      hls_error: video_files.hls_error,
      storage_key: video_files.storage_key,
      created_at: video_files.created_at,
      project_title: projects.title,
    })
    .from(video_files)
    .leftJoin(projects, eq(video_files.project_id, projects.id))
    .where(or(eq(video_files.status, 'failed'), eq(video_files.hls_status, 'failed'), isNull(video_files.storage_key)));

  const all = await db.select({ hls_status: video_files.hls_status, status: video_files.status }).from(video_files);
  const tally = (key: 'hls_status' | 'status'): Record<string, number> =>
    all.reduce((m, r) => { m[r[key]] = (m[r[key]] ?? 0) + 1; return m; }, {} as Record<string, number>);
  console.log(`Total video_files: ${all.length}`);
  console.log(`  by status:     ${JSON.stringify(tally('status'))}`);
  console.log(`  by hls_status: ${JSON.stringify(tally('hls_status'))}`);

  const orphaned = rows.filter((r) => !r.project_title);                       // project deleted
  const noMedia = rows.filter((r) => r.project_title && !r.storage_key);       // row but no object
  const failed = rows.filter((r) => r.project_title && r.storage_key);         // transcode/status failed

  console.log(`\n=== Video audit (READ-ONLY) — ${rows.length} flagged ===\n`);
  console.log(`A. Transcode/status FAILED — re-uploadable via Library Replace ↻ (recommended, non-destructive): ${failed.length}`);
  failed.forEach((r) => console.log(fmt(r)));
  console.log(`\nB. No media (storage_key NULL) — never finished uploading: ${noMedia.length}`);
  noMedia.forEach((r) => console.log(fmt(r)));
  console.log(`\nC. Orphaned (parent project gone) — safe to delete: ${orphaned.length}`);
  orphaned.forEach((r) => console.log(fmt(r)));
  console.log(`\nNothing was deleted. Review and tell me which (if any) to remove.\n`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
