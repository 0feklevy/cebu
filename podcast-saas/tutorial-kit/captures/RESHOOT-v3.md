# Reshoot list — v3 (after the owner's reset + product UI changes)

Shot on the v3 template with the capture profile (`captures/chrome-profile`, ONE session at a time —
`pgrep -fl chrome-profile` must be empty first). Status as of **2026-09-05 22:15**.

## Status

| shot id | needed by | status | file · duration |
|---|---|---|---|
| f1-s1-ordinary-video | F1 b1 ("This looks like a video.") | **done** — the DOORS share page playing plainly; chrome in frame throughout, play head 27.4→36.9 s | 9.52 s · 1600×900 |
| f2-s4-this-moment | F1 b8 · F2 b6-8 · F3 b3-4 | **done** — tour project, Solar System picked on camera, verbatim prompt, both switches, generation ran | 31.2 s · 1600×900 |
| f3-s3-simple-ui | F3 b3-5 | **done** — kinesin package, verbatim prompt, editor's pacing | 26.12 s |
| f3-s4-iteration | F3 b3-5 | **done** — opens on the previous prompt with both toggles on, follow-up replaces it | 15.76 s |
| f1-s3-ask-surface | F1 b4 · F4 b4-6 | **partial** — the real voice surface opens; the local stack refuses the session ~0.6 s later, so the panel is on screen ~0.3 s. Cut before the failure card. Needs avatar credentials for a fuller beat | 7.2 s |
| f1-s7-zoomout | F1 b10 | **done** — the profile's own Welcome clone, 4 SIM blocks, pull-back 1.7→1.0 | 8.44 s |
| f2-s1-pullback | F2 b1 | **done** — solar window verified BY IDENTITY, film playing, pull-back 1.35→1.0 | 7.12 s |
| f2-s9-zoomout | F2 b13-14 | **done** — tour project's card open (verbatim prompt, both switches), live sim (Saturn → Uranus) | 8.56 s |
| f5-s4-collab-access | F5 b4-5 | **done** — Settings → Collaborators (Invite hovered, never sent) → Access Private→Unlisted→Public, restored to Private | 12.84 s |
| f5-s5-phone | F4 b8-9 · F5 b6 | **done** — 390×844, flock tapped, "Resume video →", CC on at 14.5 s. Audio-language beat has NO true shot (no dub exists) | 17.48 s |
| montage sub-cuts ×5 | F1 b8 | **done** — drop / mark / card / generate / share, ≈2.1-2.7 s each | see `montage-*` |
| f1-s3-return | F1 b3 | **done** — cut keyed to the window's own exit | 11.0 s |
| f1-s7-return | F1 b7 | **done** — same, solar window | 18.32 s |
| f4-s1-public-page | F4 b1 · beds in F3/F4/F5 · fallback for b1 | **done** — re-shot on the DOORS page playing, 22.8→44.9 s of its master, chrome in frame throughout | 22.04 s |
| **live-window plates ×4** | replaces `assembly/plates/under-window.mp4` | **done** — real simulation footage, full-frame 1920×1080, moving throughout | see below |

## Live-window plates (new, 2026-09-05)

`assembly/plates/under-window.mp4` is a 20 s black plate, and the EDLs use it for every LIVE-WINDOW
beat (film1 scenes 2/6/9, film2, film3, film4) — about 23 s of film 1 is therefore pure black
whenever the film is watched as a FILE rather than inside the product. Replacements, each recorded
full-frame on the package's own public URL, driven through the simulation's own controls:

| plate | length | motion | replaces the window in |
|---|---|---|---|
| `plate-kinesin.webm` | 16.40 s | camera orbit + Cycle-position swept both ways (the motor walks) | film1 sc2 · film3 |
| `plate-solar.webm` | 11.56 s | time-lapse pushed up, camera flown to Jupiter and back out | film1 sc6 · film2 |
| `plate-murmuration.webm` | 12.64 s | pointer swept through the flock, Scatter, re-form | film1 sc9 |
| `plate-orbitlab.webm` | 17.60 s | two planets launched by drag, falling into orbit | film4 sc2-3 |

`node check-plates.mjs` is the acceptance gate: duration ≥ window+2 s, mean luma ≥ 6 at four points
(nothing may open black), and mean frame-to-frame difference ≥ 0.8 across the clip (nothing may be
static). Current: luma 21-59, motion 0.9-12.5, all pass.

**Two follow-ups for whoever wires these in:** `assemble-film.mjs:238` excludes `under-window` from
its own dark-frame guard — that exemption should go once real plates are in, so the guard can see
them; and each sim's own control card is visible in its plate (it is part of the simulation a viewer
sees in the window, not product chrome), including the kinesin package's "ASSET PROOF" header, which
may want hiding if the plate is ever shown full-frame in a film.

## Capture conventions (v3, this session)

- `viewport` / `videoSize` / `contextOptions` per shot. v3 editor/viewer shots are **1600×900**;
  the phone shot is 390×844 (device scale 3); plates are **1920×1080**.
- `cursor: true` draws an in-page pointer — Chromium's screencast records no OS cursor, so every
  earlier "cursor motion" note was invisible in the file.
- The Next.js dev indicator is hidden on every page the driver opens.
- `run()` returns `{ trim }` or `{ cuts }`; the driver re-encodes frame-accurately to
  `out/<id>.webm`, so there is no dead time at the start and one take can yield five sub-cuts.
- `api.mark(name)` → beats, rebased to seconds-from-file-start, written to BOTH `MANIFEST.json`
  and `out/beats/<id>.json` for the edit's `in` offsets.
- Card pacing lives in `CARD_PACING`: 4 s hold → ~12 chars/s → 1.5 s → Minimal UI → 2.0 s →
  Auto script → 2.5 s → Generate → ≥2 s on the generating state.
- The recorder writes 25 fps; `assemble-film.mjs` normalises with `fps=30`.

### Rules the takes themselves taught (2026-09-05) — do not re-learn these

1. **`recordVideo.size` must equal the viewport.** Recording 780×1688 for a 390×844 phone pads the
   frame grey with the page in the corner; it does not upscale.
2. **A "ghosted editor" in a viewer shot is the FILM, not a broken recording.** These films are
   screen recordings *of this product*: `assembly/out/film1.mp4` at 55 s is the editor, captioned
   "The doors below are live". Two shots were re-shot and an engine theory written before anyone
   checked the master. Check the master first.
3. **A failed attempt must never erase the take it replaces.** The manifest write is additive on
   failure (`lastError`, `lastAttemptAt`, `staleAfterFailedReshoot`); a validated recording clears
   them. One blanked entry took three beats out of film 1's assembly.
4. **Name the window you mean.** `waitSimPresentedMatching(page, simId)` asserts the package by id
   and that the film is rolling — seeking into a window does not always swap the presented layer.
5. **Presence is not visibility.** The viewer fades a PARENT layer, so every sim iframe keeps
   `opacity: 1` on itself forever; test effective visibility (`checkVisibility` + multiplied
   ancestor opacity) or a shot waits forever for a window that is long gone. The same mistake in a
   text check ("FORMING THE SOLAR SYSTEM…" left in the DOM) filed a good take as a dead preview.
6. **Start playback with SPACE, not a click on the play button.** A normal Playwright click on it
   times out — the control is visible, enabled and topmost, but the bar never satisfies the
   stability check — and the film silently stays paused. A click on the FRAME is worse: inside a
   live window it pauses the film and hands control to the sim ("Resume video →").
7. **"An ordinary shared video" has exactly one home: the DOORS project.** It is the only seeded
   project with no simulation sections, so its page is a plain video throughout — the demo's page
   cannot supply that beat, because the demo project IS film 1 and every moment of it plays inside
   one of its own live windows. Pick the stretch from the master, not by guessing:
   `node assembly/scan-luma.mjs <shotId|path>`; `film5.SCRATCH.mp4` is an editor recording around
   12 s and a full-frame Wave Lab ripple from ~22 s to ~42 s (luma ~87), which is what the two
   doors shots use.
8. **A still shot loses the page chrome after 2.5 s.** The viewer hides its controls 2500 ms after
   the last pointer activity (`useProjectPlayer.ts:914`) and there is NO hover exemption — parking
   the pointer on the bar does not help. `holdWithChrome()` nudges the pointer one pixel every
   1.8 s, which is invisible (no cursor is drawn and the screencast records no OS pointer) and
   keeps the bar, the Ask! pill and the clock in frame for the whole take.
9. **A measurement that did not happen is a failure, not a pass.** `check-plates.mjs` first
   reported "all plates pass" while measuring nothing: ffmpeg's `metadata=print` writes at info
   level to STDERR, and `-v error` plus an stdout-only read returned null for every sample, which
   `Math.min` of an empty list then turned into a pass.

Not shots (product-side): the LIVE-WINDOW beats are the product's mid-roll sections — configured by
`seeding/layout-v3.json`, never composited. Music ducks to room tone inside windows.
