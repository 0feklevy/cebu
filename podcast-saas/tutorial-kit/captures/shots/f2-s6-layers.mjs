// Film 2 · Scene 6 — fast cuts: Show all layers → the Generate B-Roll prompt box → the sound
// card dragged onto A2 → the "Follow user decisions" modal with a decision point → close.
import { settle, readStage2, beatClock, dismissTour, tokenSniffer, trackRects, dragMouse, pollUntil } from '../shot-utils.mjs';

export default {
  id: 'f2-s6-layers',
  film: 2,
  scene: '6',
  kind: 'editor-flow',
  duration: 35,
  async run(page, api) {
    const beat = beatClock(this.id);
    const { tourProjectId } = readStage2();
    if (!tourProjectId) throw new Error('run f2-s2a first: no tourProjectId in STAGE2.json');

    const getTok = tokenSniffer(page); // attach before goto
    await page.goto(`${api.APP}/projects/${tourProjectId}/editor`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-tour="library"]').waitFor({ timeout: 30000 });
    await dismissTour(page);
    const tok = await getTok();

    // Off-camera prep: a previous take's audio cutaway would collide with this one — remove
    // ONLY audio sections (the generated sim section must survive for f2-s8 and the film).
    if (tok) {
      const res = await fetch(`${api.API}/api/v1/projects/${tourProjectId}/sections`, {
        headers: { Authorization: `Bearer ${tok}` },
      });
      if (res.ok) {
        const body = await res.json();
        const rows = Array.isArray(body) ? body : body.sections ?? [];
        for (const s of rows.filter((r) => r.type === 'audio')) {
          await fetch(`${api.API}/api/v1/projects/${tourProjectId}/sections/${s.id}`, {
            method: 'DELETE', headers: { Authorization: `Bearer ${tok}` },
          }).catch(() => {});
        }
      }
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('[data-tour="library"]').waitFor({ timeout: 30000 });
      await dismissTour(page);
    }

    await pollUntil(async () => (await trackRects(page))?.clip, { timeoutMs: 60000, intervalMs: 2000, label: 'V1 clip block' });
    await settle(page);
    beat.mark('editor');

    // ── Beat 1: Show all layers ──
    await page.getByRole('button', { name: /Show all layers/ }).click();
    await settle(page, 1200);
    beat.mark('layers-shown');

    // ── Beat 2: mark a stretch on V2 → the Generate B-Roll prompt box appears ──
    // Pixel positions come from the V1 clip's rect (the zoom is fit-to-width): 20%→70% of a
    // 24.4s clip ≈ 12s, comfortably over the 4s B-roll minimum (TimelinePanel.tsx:32).
    const t = await trackRects(page);
    if (!t?.v2) throw new Error('V2 track not found after Show all layers');
    if (!t?.clip) throw new Error('V1 clip rect not found');
    const vy = t.v2.y + t.v2.h / 2;
    await dragMouse(page, t.clip.x + t.clip.w * 0.2, vy, t.clip.x + t.clip.w * 0.7, vy, 10, 60);
    // The B-roll panel replaces the Library: prompt box ("Describe the shot…") on camera.
    await page.getByPlaceholder(/Describe the shot/).waitFor({ timeout: 10000 });
    beat.mark('broll-box');
    await settle(page, 4000);
    await page.locator('[aria-label="Close B-roll panel"]').click();
    await settle(page, 800);

    // ── Beat 3: drag the sound card onto A2 (HTML5 DnD, the product's own handlers) ──
    const dropped = await page.evaluate(async () => {
      const card = document.querySelector('div[title="Drag to A2 audio track to add a sound layer"]');
      const timeline = document.querySelector('[data-tour="timeline"]');
      const a2 = timeline && [...timeline.querySelectorAll('div')]
        .find((d) => d.style.cursor === 'copy' && d.style.height === '44px');
      if (!card || !a2) return false;
      const dt = new DataTransfer();
      const r = a2.getBoundingClientRect();
      const at = (el, extra = {}) => ({ bubbles: true, cancelable: true, dataTransfer: dt, ...extra });
      card.dispatchEvent(new DragEvent('dragstart', at(card)));
      const pos = { clientX: r.x + 120, clientY: r.y + r.height / 2 };
      a2.dispatchEvent(new DragEvent('dragenter', at(a2, pos)));
      a2.dispatchEvent(new DragEvent('dragover', at(a2, pos)));
      await new Promise((res) => setTimeout(res, 900)); // A2 highlight on camera
      a2.dispatchEvent(new DragEvent('drop', at(a2, pos)));
      card.dispatchEvent(new DragEvent('dragend', at(card)));
      return true;
    });
    if (!dropped) throw new Error('audio card or A2 lane not found for the drag');
    // The audio cutaway lands as a green labeled segment on A2 (TimelinePanel.tsx:2119-2151).
    await page.locator('[data-tour="timeline"]').getByText(/ambient-tone|^Audio$/).first().waitFor({ timeout: 15000 });
    beat.mark('audio-on-a2');
    await settle(page, 2500);

    // ── Beat 4: Follow user decisions — open, show a decision point, close ──
    await page.getByRole('button', { name: /Follow user decisions/ }).click();
    await page.locator('#branching-modal-title').waitFor({ timeout: 10000 });
    beat.mark('branching-open');
    await settle(page, 1200);
    // A fresh project opens on the empty state — walk the product's own two clicks to a
    // visible choice point: Create sequence, then Add decision point.
    const createSeq = page.getByRole('button', { name: /Create sequence/ }).first();
    try {
      await createSeq.waitFor({ state: 'visible', timeout: 2000 });
      await createSeq.click();
      await settle(page, 1500);
    } catch { /* sequences already exist */ }
    const addDecision = page.getByRole('button', { name: /Add decision point/ }).first();
    try {
      await addDecision.waitFor({ state: 'visible', timeout: 3000 });
      await addDecision.click();
      await settle(page, 2500); // one choice point on screen
      beat.mark('choice-point');
    } catch { /* modal layout without the button — the open modal itself is the beat */ }
    await settle(page, 1500);
    await page.locator('[role="dialog"] [aria-label="Close"], [aria-label="Close"]').first().click();
    await settle(page, 1200);
    beat.mark('closed');
    beat.flush();
  },
};
