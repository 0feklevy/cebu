// Film 5 · Scenes 4-5 — Collaborators invite + Access mode, on the capture profile's Welcome clone.
// PRODUCT REALITY: both live in the project SETTINGS panel (ProjectSettingsPanel.tsx:837/863,
// anchors settings-access / settings-collab), not in the "Share this video" sheet (which only has
// Public page / Private link). An email is typed and Invite is HOVERED, never pressed; then the
// Access select is switched Private → Unlisted → Public (real visibility changes on the user's own
// clone, restored to Private off camera afterwards). Access switch lands at ≥8 s (EDL in: 8). ~12 s.
import { settle, openEditor, glideClick, glideTo, easeMove, V3_VIEWPORT, WELCOME_CLONE } from '../shot-utils.mjs';

const EMAIL = 'teammate@example.com';

export default {
  id: 'f5-s4-collab-access',
  film: 5,
  scene: '4',
  kind: 'editor-flow',
  duration: 12,
  viewport: V3_VIEWPORT,
  cursor: true,
  async run(page, api) {
    await openEditor(page, api, WELCOME_CLONE);
    await settle(page);

    await easeMove(page, 900, 300, { ms: 400 });
    api.mark('start');
    const settings = page.locator('header').getByRole('button', { name: 'Settings', exact: true });
    await glideClick(page, settings, { pauseBefore: 500, pauseAfter: 300 });
    const collab = page.locator('[data-tour="settings-collab"]');
    await collab.waitFor({ timeout: 15000 });
    await collab.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await settle(page, 900);
    api.mark('settings-open');                          // (a)

    // The invite input renders only once the collaborators list has loaded (CollaboratorsSection
    // isOwner). If that request fails the card reads "Failed to fetch" — an error state that must
    // not be on camera: the shot then carries only the Access beat and says so.
    const email = page.locator('input[type="email"]').first();
    const collabLoaded = await email.waitFor({ timeout: 12000 }).then(() => true).catch(() => false);
    let collabNote = 'collaborators invite typed, Invite hovered (not sent)';
    if (collabLoaded) {
      await glideClick(page, email, { pauseBefore: 400, pauseAfter: 200, ms: 800 });
      api.mark('typing');
      await api.typeSlow(page, EMAIL, 14);
      await settle(page, 400);
      const invite = collab.getByRole('button', { name: /^Invite$/ });
      await glideTo(page, invite, { pause: 900, ms: 600 });   // hover only — nothing is sent
      api.mark('invite-hover');                           // (b)
    } else {
      const err = await collab.textContent().catch(() => '');
      collabNote = `COLLABORATORS UNAVAILABLE: card read "${(err ?? '').replace(/\s+/g, ' ').slice(0, 120)}" — invite beat not captured`;
      api.mark('collab-unavailable');
    }

    const access = page.locator('[data-tour="settings-access"]');
    await access.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await settle(page, 700);
    const sel = access.locator('select');
    await glideTo(page, sel, { pause: 600, ms: 800 });
    api.mark('access');                                 // (c) the Access control
    await sel.selectOption('unlisted');
    api.mark('unlisted');
    await settle(page, 1300);
    await sel.selectOption('public');
    api.mark('public');
    await settle(page, 1700);
    api.mark('end');

    // Off camera: leave the clone as found.
    await settle(page, 600);
    await sel.selectOption('private').catch(() => {});
    await settle(page, 800);
    return { trim: { from: collabLoaded ? 'start' : 'access', to: 'end', padBefore: collabLoaded ? 0.3 : 1.2 }, note: collabNote };
  },
};
