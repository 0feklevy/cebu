# Round 3 — pre-assembly critique: trailer editor + script doctor

Read-only pass, 2026-09-05. Judged against CREATIVE-DIRECTION-v3, `scripts/SCRIPT-1..5*.md` (v3.1),
`narration/lines.json`, the Andrew +12% per-line durations in `narration/EDGE-VOICE-NOTE.md`
(the "current voice-over": f1 58.4 s · f2 84.1 · f3 51.7 · f4 58.7 · f5 45.0), `assembly/edl/film1..5.json`,
`assembly/assemble-film.mjs`, `overlay/scenes/*.json` + `overlay/index.html`, `music/MANIFEST.md`,
`seeding/layout-v3.json`, `seeding/proof/*.png`, and — because an `in` offset is only judgeable against
the picture — frame sheets (one frame per 2 s) of every capture the EDLs reference, read against
`captures/out/beats/*.json`. Word landings below are computed from the edited clip lengths and the
pause table (lead 80 ms, tail 200 ms, ~0.17–0.27 s/word), so they are ±0.15 s.

---

## Verdict

1. **The words are trailer-grade; the cut, as EDL'd, is not alive.** Short claims, real imperatives, brand last, one window every ~20 s — the scripts are ~80% there. But the teaser's frame 0 is a black loading spinner, its beat 1 is a *paused* player with a ▶ overlay, and ~35 of 44 VIDEO cuts start on a white/black page-load frame, a paused poster, or a segment that does not contain the gesture the beat names.
2. **Two mechanical facts break the "stage" before any taste question:** the assembler never mixes the viewer's question (film 4 beat 5 goes silent — `lines.filter(role==='narrator')`), and the music has no riser, no hit, gates hard at window edges, and the teaser bed's 4 s crest lands two seconds *after* the window has already muted it.
3. **The windows leave time where it counts** (F1 solar: 3.3 s after "I'll wait"; F3: 3.3 s after "scrub it") **but not everywhere:** F4's Orbit Lab window is 80% talk, and F1's murmuration payoff "…That was you." is spoken at t+3.8 — before the W4 ghost gesture has finished.
4. **The film 2/3 thesis beats (write → flip → flip → hit) cannot sync to the picture as captured:** two clicks take 1.7 s, typing starts under the wrong sentence, both flips happen 2.1 s apart with Generate on their heels, and the panel is 22% of the frame with no punch-in in the assembler.
5. **Fix order:** the open (window → 4 s, a plate that moves) → the `in` table + listed reshoots → viewer audio + music stems → window word budgets → brand landings. With the first three, this is Apple/Linear-pace; without them it is v2 with better sentences.

---

## MUST-FIX (ranked — each changes whether the film feels alive)

### M1 · Film 1, beats 1–2 — the open
**Problem.** Window at 0:02 leaves 0.9 s between "video." (ends ~1.1 s) and the mount — no TURN, no trap. The plate `f4-s1-public-page` is a black spinner at 0 s and a **paused** player (▶ overlay, "0:00 / 4:45") for all of 2–28 s: "This looks like a video" over a video that visibly isn't playing. `bed-teaser` rises for 4 s and crests at 0:04 — two seconds after the assembler has already muted it for the window.
**Fix.** Kinesin window **[4,12]** (as CREATIVE-DIRECTION §9/H6 already says; sync `layout-v3.json` + the script WINDOW MAP). Script row 1 → `0:00–0:04 · VIDEO · "This looks like a video."` with two shots: 0.0–2.5 `captures/props/lesson-waves.mp4` full-bleed, moving (the fallback the EDL already names — an ordinary lesson IS the trap); 2.5 hard cut to a 2.0× punch (crop, never zoom-out); VO in at 1.5; 3.0 section marker + chip pulse (product layer); 4.0 window. Beats 4 and 5 → **4 s each** (VO 3.26 / 2.98 fit) so the film stays 58 s and windows 2–3 stay at [25,33] [45,52]. Reshoot `f4-s1-public-page` actually **playing** (the recorder's `start()` never started playback) before it is used anywhere — it is under seven beats across the five films.

### M2 · All films — `in` offsets were guessed, not read from the beat clocks
**Problem.** Every capture opens on 1–5 s of white/black load; `in` values of 0/1/2/3/4 land inside it. Editor offsets are 10–15 s early: `f2-s4-this-moment` at 0 / 3 / 7.5 shows idle editor, while editor-open is 12.0, typing 13.9–20.9, flips 20.9–23.0, Generate 23.0. `f3-s2` at 8–14 misses the drop at 15.1 entirely.
**Fix.** Apply Appendix A (`in` = first relevant mark − 0.4 s). Add the Z6 guard to `assemble-film.mjs` (any part whose first frame has <5% luminance variance fails the build) so this class cannot recur.

### M3 · Film 4, beat 5 — the exchange is silent
**Problem.** `assemble-film.mjs` filters `role === 'narrator'`; the viewer line (`f4-s5-viewer`, 2.39 s) is never a `voFile`, so the ∅ beat is 6 s of music bed at full level and no question. The script's "DEAD SILENT" is also unimplemented — the duck only fires inside LIVE-WINDOW beats.
**Fix.** Mix role `viewer` clips (place at slot start + 0.4 s); add `silence: true` on the EDL cut so the bed cuts 22–28 s; the answer audio drops into the same cut when the ElevenLabs key lands.

### M4 · All films — music has no stage
**Problem.** The bed is stepped to −30 dB at window edges (`volume=eval=frame`) — no 1.2 s riser, no hit, re-entry mid-bar; a 1.2 s fade-out means the beds' "hard button endings" are never heard (bed-teaser is 62.4 s, the film 58.4); no hit exists for "Generate" (F2 b7, F3 b4) or the count (F4 "One:/Two:/Three:/Four:"); and the assembler looks for `music/bed-*.wav` while the beds live in `music/synth-v2/` — the build fails before any of this is audible.
**Fix.** Render/copy beds to `music/`; author `riser-1200ms.wav` + `hit-300ms.wav` (M4/M5); riser at window.end − 1.2, hit at window.end and at each Generate click and the end-card landing; F4 hit at each number (beat start + 0.08); trim each bed so its button lands on the spoken brand (not a fade); F4 silence for 22–28 (see M3).

### M5 · Live windows — word budget and payoff timing
Rule: ≤35–45% narrated, ≥1.5 s air after every imperative, no line that presupposes what the viewer did.
- **F4 b2–3 Orbit Lab (12.75 s, 10.2 s narrated = 80%).** "let go" lands t+3.7, "Watch gravity fight for it" t+4.7 — before a human has launched. New s2: **"One: touch. Grab empty space… drag… let go."** New s3 (t+7): **"Miss? Throw another."** Cut "Every simulation section is this alive." (beat 10 says it). → 45%.
- **F1 b9 murmuration (7 s).** "…That was you." at t+3.8 is a lie for the non-toucher and early for the toucher. New s9: **"Last one. Steer the flock… then hit Scatter."** New s10 (slot 6 → 6.5 s): **"That was you. — The doors below are live. Touch it. Ask it. Steer it. — Flow Video."** — the return line now pays off the touch.
- **F2 b8–9 solar (12 s, 7.0 s = 59%).** "Tap a planet. Speed up time." are 0.4 s apart. New s9: **"Tap a planet. … Speed up time. … Only your buttons."** → 51%.
- **F1 b2 kinesin.** Three verbs for one control (chip "Touch the motor" / VO "Grab the motor… spin it" / direction "Drag the motor"). New s2: **"It isn't. Go on — touch it. … Drag the motor."** Chip: **Drag the motor**. → 40%, 4.8 s of air.
- **F3 b6.** "And here's what your viewers get." is a caption (N2). New s6: **"Your viewers' side. Go on — scrub it."** Chip **Scrub the cycle** (layout has "Your package, live" — not a verb on a control).

### M6 · Film 1, beat 8 — the montage words drift off their shots
**Problem.** Computed landings over five 1.8 s shots: "and a simulation" spills onto the V1-mark shot (1.8–3.6), "Tell the AI what viewers touch" starts 0.5 s before the card, **"One link." (4.8–5.3 s) lands on the prompt card**, "That's a Flow Video." on the Generate shot, and the share sheet (7.2–9.0) plays mute. And none of `montage-1..5` exist — all five fall back to shots whose `in` is 0 (white frames).
**Fix.** Split row 8 so the assembler places each line on its shot: **8a** `0:36–0:39.6` "Want one? Drop in footage — and a simulation." (drop → mark) · **8b** `0:39.6–0:43.2` "Tell the AI what viewers touch." (card + prompt → Generate; the hit lands in the silence) · **8c** `0:43.2–0:45` "One link. That's a Flow Video." (share sheet; `padAfter: 0.2`). Sub-cut `in`s until the montage is shot: Appendix A.

### M7 · Film 2, beats 5–7 (and Film 3 b3–4) — the thesis beat cannot sync as captured
**Problem.** In `f2-s4`: Simulation click 12.8, package 13.7, typing 13.9–20.9, both flips 20.9–23.0, Generate 23.0. Beat 5's 6.88 s sentence has two events; beat 6's typing must be in sync with the spoken prompt (C6) but starts under beat 5; beat 7 needs ~2.5 s per flip and a breath before Generate — the capture gives 2.1 s for both and no breath. The card label is still "This moment".
**Fix (at the reshoot RESHOOT-v3 already requires).** After package-picked hold 4.0 s with the caret in "1 · Describe it" → type at 12 chars/s → hold 1.5 → flip Simple UI → hold 2.0 → flip Auto Script → hold 2.5 → Generate. Then `in` = editor-open − 0.4 (b5), prompt-start (b6), prompt-typed + 1.0 (b7). Cut b5 to what two gestures carry: **"Pick Simulation. Choose your package. Then, in plain words — what's this moment for?"** (14 words vs 19). Same pacing rule for the F3 reshoot (both flips + Generate; only Simple UI flips in `f3-s3` today).

### M8 · Subject mismatches — the narration is untrue on screen
- **F3 b1** "trapped in a folder": no Finder capture exists; the EDL shows the app Home (with a "Sign in" button). Shoot 5 s of Finder with `screencapture -v` (folder → Compress → zip → drag begins); slot 6 → 4.
- **F3 b2** "Zip it. Drop it.": drop at 15.1 s of `f3-s2`, outside 8–14; the shot is 70% black (empty preview) for 30 s. Sub-cuts `[in 14.3, 2.5 s]` + `[in 26.8, 2.5 s]`; slot 6 → 5; 2.0× punch on the Library column.
- **F3 b3** "Drag across the timeline… tell it": `f3-s3-simple-ui` has no drag, no type pick, no prompt typing — it opens an existing section. Reshoot on the kinesin project: drag V1 → Simulation → package → type "Let viewers scrub the walking cycle and switch motors" (VERBATIM rule).
- **F4 b8** "the frame chases your speaker": `f5-s5-phone` 6–8 s is the v2 "Flow Video." title card on white, letterboxed 390×844 into 16:9 (Z5). Needs the real Smart Crop vertical render; composite phone + laptop, no bars. Same capture wrecks **F5 b6** (paused poster → logo).
- **F4 b4–6** ask: `f1-s3-ask-surface` is a paused poster to 16 s, "Connecting…" to 20 s, then an error card ("The avatar is temporarily unavailable") — beat 6 "From this lesson. Not the internet." plays over the error. Cannot ship until the ask ruling reshoot lands.
- **F2 b2–3 continuity:** on camera the zip is `murmuration.zip` (then a second drop named "Orbit Lab"); beat 5 picks "Solar System". "That zip? Just a folder somebody built." points at the wrong package. Reshoot `f2-s2b` with **one** drop: lesson-waves.mp4 + solar-system.zip + image + audio (one zip per drop is the product limit — fine).
- **F1 b5 / F4 b7** doors: the overlay shows v2 titles ("The Heavy Simulation") — reshoot on the v3 template; F1 `in` 0 → 30 meanwhile.

### M9 · Punch-ins do not exist in the assembler
Eleven ON SCREEN notes say "punch-in 2.0×"; the editor-flow panels (Library, the Generate mini model card, the share sheet) are 20–25% of the frame → ~12 px type at 1080p (Z4 floor is 22). Add `zoom: {x, y, scale}` per (sub-)cut in `assemble-film.mjs` (crop+scale, 400 ms ease-in, hold, **cut** out — Z2). Without it films 2, 3 and 5 are wallpaper of an unreadable UI.

### M10 · End cards — the brand does not land on the last word
- **F1:** `f1-logo-outro` anchorOffset 2.4 → **3.0**: letters rise inside the 720 ms breath after "Steer it. —" and the dot pops on "Video." (spoken 4.32–4.71).
- **F2 / F5:** the card's printed "Flow Video." fades in at +1.5–2.2 s; spoken at 4.3–4.9 (F2) and 3.5–4.0 (F5). Add a `brandAt` prop: F2 **3.9**, F5 **3.1**, F4 **0.5** (relative to card t0).
- **F3:** brand is mid-sentence ("Flow Video puts it on stage") — N1 wants it last. New s8: **"Whatever you've built… drop it in. Put it on stage. — Flow Video."** The overlay line reads "Drop yours in." while the script says "Drop in anything." — keep the script's (E4 lists it).
- **F4:** end card is 3 s (E1 says ≥5). Beat 11 → 5 s, recovered from b8 6→5, b6 3→2.5, b7 7→6.5 (VO 4.07 / 1.91 / 5.55 all fit).
- **F5 b1** `in` 1 = a white frame under "It's built." → **6.0** (the finished timeline with its section blocks is exactly the shot).

---

## SHOULD

- **S1 Return beats speak on frame 0.** VO is `adelay`'d to scene start, so after every window the words hit at the same instant as the riser resolve and the cut. Add `voDelay: 0.4` on F1 b3/b7/b10, F2 b10, F3 b8, F4 b4: hit, picture, then words.
- **S2 F1 b7** is one 3.37 s shot (R1 ≤3.0 in the teaser): punch on the lit marker 1.5 s → wide. Line: **"See? Your viewers fly… you keep teaching."** — "They" has no antecedent for a viewer who just flew to Mars.
- **S3 F2 opener** has three plans: script (empty editor, static), EDL reshoot note ("solar window in the DEMO project" = sim footage, banned by the script's own grammar), direction H6 (hand dropping the zip at 0.0). Pick: b1 = `f2-s2a` `in 5.2` (New-project dialog with "Tour the Solar System" being typed — motion at frame 0) → editor lands; b2 → **"Now drop everything in at once — footage, images, audio, and a whole simulation, as one zip."** (also fixes the +0.6 s overrun).
- **S4 F2 b4** slot 8 → **5** (VO 4.53; the drag is 1.4 s, Edit Section opens 2.1 s later; at 8 s the assembler loops the 15.9 s capture's tail — a replaying drag).
- **S5 F5 b2–4.** Rows are hovered ~1 s apart in `f2-s8-share` (~43/44/45 s) while the narration names them over ~6 s: four sub-cuts `[8.5 Create link → sheet] [42.6 Video] [43.6 Podcast] [44.6 Library]` — or reshoot hovers at 1.8 s each. b3 `in` 14 → **10.0** (slug typed → "Publish at this address" at 14.1) + a 2.5 s public-page load sub-cut (no such capture exists yet). b4 slot 7 → 5 (VO 3.22).
- **S6 Chips are not verbs on controls** (W2): "Touch the motor" → **Drag the motor**; "Fly to a planet" → **Tap a planet**; "It's live — touch it" → **Tap a planet**; "Your package, live" → **Scrub the cycle**; "Launch a planet" ✓. The murmuration proof shows the product's guidance caption ("…Tap to startle it.") while the narrator says Scatter — two instructions (W7): caption off, chip **Hit Scatter**.
- **S7 F1 kinesin window UI:** the Simple UI shows a "Teaching playback" speed slider and a panel header reading **"ASSET PROOF"** — in the first five seconds of the teaser. Regenerate the demo section so the visible control is "Cycle position"; rename the package's panel header.
- **S8 Music grid.** Beds are 108/98/104/112/100 BPM against M1's 120/100/108/108/96; bed-teaser's 4-bar lifts (every 8.9 s) never coincide with a return (12/33/52) and its "half-bar breath + slam" at ~31–32 s falls inside the muted second window. Re-render at the M1 tempos with window edges on bar lines (even seconds at 120).
- **S9 F4 four-grid** stagger 0.55 → **0.78** (plates pop 0.3–0.6 s ahead of "Touch. Ask. Choose. Their way."); the script wants the grid on four REAL captures — needs a 2×2 composite the assembler cannot do yet.
- **S10 F1 b3** "inside an ad": the Welcome playlist plays to people who just signed up. **"You're driving a molecular machine inside a video. This is Flow Video."** — truer, and it closes the loop with line 1.
- **S11 F2 b10** overrun (+0.3): **"Hit Create link. One link, the whole experience: video… a podcast that answers voice questions… your library."** — the ellipses are the cursor cues for the three rows.

## NICE

- End-card ▼ bounces forever (`sin²`) — E3 wants two pulses then steady.
- Chroma end-line 84 px → 112–120, chevron 76 → 96 (T2; the overlay predates the direction).
- "Sign in" is visible top-left of the Home shots (anonymous capture profile) — if F2 b1 or F3 b1 use them, hide it.
- F5 b2 "your whole library, browsable" is a mouthful at pace → **"your whole library — browse it."**
- `narration/audio/` is empty and `assembly/work/*/timeline.json` are the v2 derivations (79.9 s, scenes 3a/3b/3c) — regenerate before anyone reads them as current.
- W12 risk, not a fix: kinesin is cleared for the LOCAL build only; if the public teaser ships, the hook window becomes murmuration and every "motor" line above moves to F3.

---

## What already works

- **The architecture:** three windows of 8/8/7 at ~20 s cadence, 40% live, one 12 s window in the niche films, none in F5 — right, and the seeded mid-roll mechanism is real (proof frames mount the actual sims).
- **The window register:** "Go on — touch it", "Tap any planet. Go ahead… I'll wait.", "Done. …That's not a preview. Touch it.", "Go on — scrub it." — imperatives with scripted air; F1 solar leaves 3.3 s after "I'll wait", F3 leaves 3.3 s after "scrub it".
- **The voice:** Andrew +12% at 143–172 wpm with 380–450 ms native gaps — the dead air the owner heard in v2 is out of the voice and now lives only in the slots (fixable by timing, above).
- **The close:** "Touch it. Ask it. Steer it. — Flow Video." with the 720 ms brand breath; end lines that are consequences ("The doors below are live." / "Change one word." / "Four powers. One link." / "Ship yours.") and real deep-link buttons.
- **F5 b5** "Everyone… link-holders… or just you." — the pauses are the cursor cues; the three-mode toggle is exactly the right shot.
- **F4's count** and the ∅ exchange beat are the strongest structural idea in the set — once mixed and silenced (M3).
- **Honesty:** real network shaping, the one-zip-per-drop limit, title pinning, "dubbed" not "same voice" — all logged in DISCREPANCIES.md. These films will survive a skeptic.
- **The kit's spine:** derived timeline = max(slot, VO+0.5) with overlay cues re-timed off it, sub-cut `sources`, and the beds (original, −27 LUFS, a real kick; "a 4-second rise that crests exactly at 0:04" is *precisely* right for a 4 s window — M1 makes the film match the bed).

---

## Appendix A — what each EDL `in` actually shows (from frame sheets + beat clocks)

`→` = corrected `in` for the CURRENT capture; "reshoot" = listed in RESHOOT-v3.md unless marked **(add)**.

| film·beat | EDL source · `in` | what is on screen there | fix |
|---|---|---|---|
| F1 b1 | f4-s1-public-page · 0 | black spinner, then a paused player (▶) | lesson-waves.mp4 full-bleed + punch (M1); reshoot f4-s1 playing **(add)** |
| F1 b3 | f1-s3-return → fb f4-s1 · 2 | paused poster | reshoot |
| F1 b4 | f1-s3-ask-surface · 0 | white, then paused poster; capture ends in an avatar error | reshoot |
| F1 b5 | f4-s4-branching · 0 | white | → 30 (doors 28–36; v2 titles → reshoot **(add)**) |
| F1 b7 | f1-s7-return → fb f4-s1 · 5 | paused poster | reshoot |
| F1 b8.1 | montage-1 → fb f2-s2b · 0 | white | → 7.8 |
| F1 b8.2 | montage-2 → fb f2-s3 · 0 | white; then the AUTO-RENAMED title + a reload flash | → 9.8 |
| F1 b8.3 | montage-3 → fb f2-s4 · 0 | white / black preview | → 14.0 (typing) |
| F1 b8.4 | montage-4 → fb f2-s4 · 7.5 | idle editor | → 21.4 (flips → Generate 23.0) |
| F1 b8.5 | montage-5 → fb f2-s8 · 0 | white | → 14.0 (published sheet, rows visible) |
| F1 b10 | f1-s7-zoomout · 0 | white; paused v2 player; no doors | reshoot; → 20 meanwhile |
| F2 b1 | f2-s1-pullback → fb f4-s1 · 0 | black spinner | decide opener (S3): f2-s2a → 5.2 |
| F2 b2.1 | f2-s2a · 0 | white | → 5.2 (dialog + typing) |
| F2 b2.2 | f2-s2b · 0 | white | → 7.6 (drop at 8.6); reshoot with solar zip **(add)** |
| F2 b3 | f2-s2b · 8 | drop → cards → *second* drop "Orbit Lab" | after reshoot → cards − 0.5 |
| F2 b4 | f2-s3-mark-section · 0 | white, wrong title, reload | → 9.6; slot 8 → 5 |
| F2 b5 | f2-s4-this-moment · 0 | white / idle | → 11.6 (editor-open 12.0) |
| F2 b6 | f2-s4 · 3 | idle editor | → 13.9 (typing 13.9–20.9) |
| F2 b7 | f2-s4 · 7.5 | idle editor | → 20.6, or 3 sub-cuts 20.6 / 21.7 / 22.6 |
| F2 b10 | f2-s8-share · 0 | white, then the library-share workaround dialog | sub-cuts [8.6, 3.5 s] + [42.6, 3.85 s] |
| F2 b11 | f2-s9-zoomout → fb f4-s1 · 0 | public page (wrong subject) | reshoot |
| F3 b1 | f3-s2-heavy-drop · 1 | white → app Home ("Sign in") | Finder screen recording **(add)** |
| F3 b2 | f3-s2 · 8 | empty editor; the drop (15.1) is outside 8–14 | [14.3, 2.5] + [26.8, 2.5] |
| F3 b3 | f3-s3-simple-ui · 0 | white; no drag / no typing exists in this capture | reshoot drag + type **(add)** |
| F3 b4 | f3-s3 · 14 | Preview → Run collapse (flip was 9.1–11.0; Auto Script never flipped) | reshoot; → 8.8 meanwhile |
| F3 b5 | f3-s4-iteration · 0 | white | [9.3, 4.4 s typing → Generate] + [43.6, 2.2 s Last generation] |
| F3 b8 | f4-s1 · 4 | paused poster for 0.6 s before the opaque card | → 10 (trivial) |
| F4 b1 | f4-s1 · 2 | paused poster, 6 s static | reshoot playing, 3 shots (H6) |
| F4 b4 / b5 / b6 | f1-s3-ask-surface · 6 / 12 / 18 | poster / poster→"Connecting…" / "Connecting…"→**error card** | reshoot |
| F4 b7 | f4-s4-branching · 29 | doors overlay ✓ (v2 titles) | reshoot **(add)**; ok meanwhile |
| F4 b8 | f5-s5-phone · 6 | v2 "Flow Video." title on white; letterboxed | real Smart Crop render **(add)** |
| F4 b9 | f5-s5-phone · 12 | kinesin footage on a phone | reshoot (dub menu + CC) |
| F4 b10 | f4-s1 · 10 | paused poster under the grid | reshoot; grid on 4 real captures |
| F5 b1 | f2-s8-share · 1 | white | → 6.0 |
| F5 b2 | f2-s8 · 4 | idle editor + library-share dialog | [8.5] [42.6] [43.6] [44.6] |
| F5 b3 | f2-s8 · 14 | published state (no typing, no publish click) | → 10.0 + public-page load sub-cut **(add)** |
| F5 b4 | f5-s4-collab-access → fb f2-s8 · 0 | white | reshoot; slot 7 → 5 |
| F5 b5 | fb f2-s8 · 8 | Create link (wrong subject) | reshoot |
| F5 b6 | f5-s5-phone · 4 | paused poster → v2 logo; letterboxed | reshoot v3 + laptop/phone composite |

## Appendix B — live-window narration budget (current voice)

| window | length | narrated | % | first imperative | air after last word | note |
|---|---|---|---|---|---|---|
| F1 b2 kinesin | 8 | 3.98 | 50% | "touch it" t+0.9 | 4.0 s | fine once the verb is unified (M5) |
| F1 b6 solar | 8 | 4.64 | 58% | "Tap any planet" t+1.9 | 3.3 s | works — "I'll wait" then real wait |
| F1 b9 murmuration | 7 | 4.25 | 61% | "Steer the flock" t+0.9 | 2.75 s | "That was you" at t+3.8 — move to the return (M5) |
| F2 b8–9 solar | 12 | 7.04 | 59% | "Touch it" t+2.0 | 1.5 s | two imperatives 0.4 s apart (M5) |
| F3 b6–7 kinesin | 12 | 5.90 | 49% | "scrub it" t+2.0 | 2.8 s | fine; s6 opener is a caption (M5) |
| F4 b2–3 orbit | 12.75 | 10.2 | **80%** | "Grab empty space" t+1.35 | 2.0 s | the one wall of narration (M5) |
