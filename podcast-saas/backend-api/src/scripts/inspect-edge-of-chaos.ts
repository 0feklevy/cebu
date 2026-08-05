/** READ-ONLY: dump the timeline facts needed to diagnose the end-of-video sim bug. */
import { ilike } from 'drizzle-orm';
import { db } from '../db/index.js';

async function main(): Promise<void> {
  const projects = await db.query.projects.findMany({
    where: (p) => ilike(p.title, '%Edge of Chaos%'),
    columns: { id: true, title: true },
  });
  for (const p of projects) {
    console.log(`PROJECT ${p.id} :: ${p.title}`);
    const videos = await db.query.video_files.findMany({
      where: (v, { eq }) => eq(v.project_id, p.id),
      columns: { id: true, duration_sec: true, is_broll: true, filename: true },
    });
    for (const v of videos) console.log(`  video ${v.id} broll=${v.is_broll} duration=${v.duration_sec} ${v.filename}`);
    const sections = await db.query.timeline_sections.findMany({
      where: (s, { eq }) => eq(s.project_id, p.id),
      columns: {
        id: true, video_file_id: true, track: true, type: true, label: true,
        start_sec: true, end_sec: true, simple_ui: true, auto_script: true,
        simulation_id: true, simulation_url: true, sim_script: true, sim_meta: true,
      },
    });
    for (const s of sections) {
      const meta = s.sim_meta as { uiControls?: { hide?: string[] } } | null;
      console.log(
        `  section ${s.id} [${s.track}/${s.type}] "${s.label}" ${s.start_sec}->${s.end_sec}`
        + ` simple_ui=${s.simple_ui} auto=${s.auto_script} sim=${s.simulation_id ?? '-'}`
        + ` hide=${meta?.uiControls?.hide?.length ?? 0} script=${s.sim_script ?? "-"}`
        + ` url=${s.simulation_url ? s.simulation_url.slice(-60) : '-'}`,
      );
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
