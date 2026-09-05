// Film 2 · Scene 3 — the video sits on V1; a pointer drag across the clip marks a section;
// "Edit Section" opens. Waits off-screen-ish (editor idle + one reload) for HLS to be ready,
// polling the API with the capture profile's own sniffed token.
import { settle, readStage2, beatClock, dismissTour, tokenSniffer, trackRects, dragMouse, pollUntil, ensureTitle, clearSections } from '../shot-utils.mjs';

export default {
  id: 'f2-s3-mark-section',
  film: 2,
  scene: '3',
  kind: 'editor-flow',
  duration: 20,
  async run(page, api) {
    const beat = beatClock(this.id);
    const { tourProjectId } = readStage2();
    if (!tourProjectId) throw new Error('run f2-s2a first: no tourProjectId in STAGE2.json');

    const getTok = tokenSniffer(page); // must attach before goto
    await page.goto(`${api.APP}/projects/${tourProjectId}/editor`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-tour="library"]').waitFor({ timeout: 30000 });
    await dismissTour(page);
    const tok = await getTok();
    if (!tok) throw new Error('no Bearer token sniffed from the page');

    // Wait for the dropped video to be processed enough that the V1 clip renders.
    await pollUntil(async () => {
      const res = await fetch(`${api.API}/api/v1/projects/${tourProjectId}/videos`, {
        headers: { Authorization: `Bearer ${tok}` },
      });
      if (!res.ok) return false;
      const body = await res.json();
      const rows = Array.isArray(body) ? body : body.videos ?? [];
      const v = rows.find((r) => /lesson-waves/i.test(r.filename ?? r.name ?? '')) ?? rows[0];
      return v && (v.hls_status === 'ready' || (v.duration_sec ?? 0) > 0);
    }, { timeoutMs: 360000, intervalMs: 5000, label: 'lesson-waves HLS/duration' });

    // Off-camera prep: pin the typed title back (the auto-metadata job renames an empty title
    // from video content — see DISCREPANCIES.md) and clear stale sections so re-runs stay clean.
    await ensureTitle(api, tok, tourProjectId, 'Tour the Solar System');
    await clearSections(api, tok, tourProjectId);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('[data-tour="library"]').waitFor({ timeout: 30000 });
    await dismissTour(page);

    // V1 clip block on camera (ClipFilmstrip inside the crosshair track).
    await pollUntil(async () => (await trackRects(page))?.clip, { timeoutMs: 60000, intervalMs: 2000, label: 'V1 clip block' });
    await settle(page);
    beat.mark('v1-ready');

    // Drag across the clip by WIDTH FRACTIONS (the timeline zoom is fit-to-width, not a fixed
    // px/s): 15% → 60% of a 24.4s clip ≈ 3.7s → 14.7s, under the 15s visual-section cap.
    const { clip } = await trackRects(page);
    const y = clip.y + clip.h / 2;
    await dragMouse(page, clip.x + clip.w * 0.15, y, clip.x + clip.w * 0.60, y);
    beat.mark('dragged');

    // The section block appears and the section editor opens (TimelinePanel.tsx:1074-1079 → 2423).
    await page.getByText('Edit Section', { exact: true }).waitFor({ timeout: 10000 });
    await settle(page, 2000);
    beat.mark('editor-open');
    await settle(page, 1500);
    beat.flush();
  },
};
