// Film 1 · Scene 4 (and F4 beats 4-6) — the ask surface on the DEMO's public share page, shot as
// the product ACTUALLY is (owner steer 2026-09-05, after the scripts were rewritten to match):
// the "Ask!" control opens the live avatar surface and the microphone goes live. There is no typed
// question and no suggestion chips — `AskAvatarButton` → `AvatarPopup` → `AvatarConversation` is a
// mic-only Anam call (Mute / Interrupt / Leave at AvatarConversation.tsx:587-595).
//
// The mic is REAL in the recording: the context runs Chrome's fake capture device with the
// microphone permission pre-granted, so the product's own mic path runs and the control renders
// live/unmuted rather than blocked. Nothing about the product is stubbed.
//
// If the local stack cannot mint an avatar session, the shot STOPS at the opened surface with the
// mic live and reports partial — the "temporarily unavailable" card is never filmed (the run polls
// for the ⚠ status and ends 0.35 s before it).
import { settle, openShare, startPlayback, totalOf, scrubTo, glideTo, easeMove, drift, presentedSim, readTemplate, V3_VIEWPORT } from '../shot-utils.mjs';

export default {
  id: 'f1-s3-ask-surface',
  film: 1,
  scene: '3',
  kind: 'viewer',
  duration: 10,
  viewport: V3_VIEWPORT,
  cursor: true,
  contextOptions: {
    args: ['--use-angle=metal', '--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-capture', '--use-fake-device-for-media-capture'],
    permissions: ['microphone'],
  },
  async run(page, api) {
    const T = readTemplate();
    await openShare(page, T.demo.shareUrl);
    // Seek to the film-only stretch BETWEEN the two windows first, then roll: the ask beat must
    // play over the film, not over a live window (and a click inside a window pauses everything).
    const total = (await totalOf(page)) ?? 79;
    await scrubTo(page, 19, total);
    await startPlayback(page);
    await settle(page, 1200);
    if (await presentedSim(page)) throw new Error('a live window is presented over the ask beat — reseek to a film-only stretch');

    await easeMove(page, 1100, 560, { ms: 500 });       // wake the controls, cursor in frame
    api.mark('start');
    // Real pre-roll on the playing film. The local stack refuses an avatar session in about a
    // second, so without this the whole shot is the click — and the beat the narration needs is
    // "you can ask at any moment", which only reads if the moment is on screen first.
    await drift(page, [[1000, 520], [1180, 600]], { ms: 1700, pause: 350 });
    api.mark('film');
    const ask = page.getByRole('button', { name: 'Ask the avatar about this video' });
    await ask.waitFor({ state: 'visible', timeout: 15000 });   // the pill hides while the controls are idle
    await glideTo(page, ask, { pause: 700, ms: 800 });         // the hover also keeps the controls awake
    api.mark('ask-hover');
    // Click the ELEMENT, forced: a raw mouse press at the remembered position misses if the
    // controls fade between the hover and the press, and the panel then never opens (two takes).
    const panel = page.locator('.avatar-popup-panel');
    let opened = false;
    for (let attempt = 0; attempt < 3 && !opened; attempt++) {
      await ask.click({ force: true, timeout: 5000 }).catch(() => {});
      if (attempt === 0) api.mark('click');
      opened = await panel.waitFor({ timeout: 6000 }).then(() => true).catch(() => false);
      if (!opened) await easeMove(page, 1200, 600, { ms: 300 });        // wake the controls and retry
    }
    if (!opened) throw new Error('the Ask panel never opened after three clicks');
    api.mark('panel-open');

    // Hold on the live surface. Stop the instant a failure screen appears.
    let errorAt = null, connected = false, micLive = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 9000) {
      const st = await page.evaluate(() => {
        const btns = [...document.querySelectorAll('.avatar-btn')].map((b) => b.textContent?.trim() ?? '');
        return {
          err: !!document.querySelector('.avatar-popup-status p')?.textContent?.includes('⚠'),
          live: !!document.querySelector('#anam-avatar-video'),
          mic: btns.some((t) => /^Mute$/i.test(t)),        // unmuted mic control = the mic is open
        };
      });
      if (st.live && !connected) { connected = true; api.mark('avatar-live'); }
      if (st.mic && !micLive) { micLive = true; api.mark('mic-live'); }
      if (st.err) { errorAt = api.mark('error'); break; }
      if (connected && micLive && Date.now() - t0 > 6500) break;
      await page.waitForTimeout(80);
    }
    // Park the cursor by the mic control so the "speak to it" beat has somewhere to look.
    if (micLive && !errorAt) {
      const mute = page.locator('.avatar-btn--control').first();
      await glideTo(page, mute, { pause: 900, ms: 700 }).catch(() => {});
      api.mark('mic-control');
    }
    const end = errorAt != null ? errorAt - 0.35 : api.mark('end');
    await settle(page, 300);

    const note = errorAt != null
      ? `PARTIAL: the avatar surface opened${micLive ? ' with the mic live' : ''} but the local stack refused the session at +${(errorAt - api.marks['panel-open']).toFixed(1)}s; cut 0.35 s before the failure card, which is NOT on camera`
      : connected
        ? `avatar session connected, mic live — the real voice surface${micLive ? '' : ' (mic control not seen)'}`
        : `PARTIAL: surface open${micLive ? ' with the mic live' : ''}, no avatar stream within the hold`;
    return { trim: { from: 'start', to: end, padBefore: 0.2 }, note };
  },
};
