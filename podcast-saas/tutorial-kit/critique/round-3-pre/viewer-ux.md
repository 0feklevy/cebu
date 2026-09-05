# Viewer UX critique — "Welcome to Flow Video" (round 3, pre-assembly)

First-time-user read of the live local pages, 2026-09-05 ~16:00–16:15, as (a) a cold viewer who
opens the shared link on a laptop and (b) a creator who then gets their own copy. Method: the public
share pages on http://localhost:3000 opened in a fresh headless Chrome (Playwright, chromium
`channel: 'chrome'`, 1440×900 and 390×844), started via the player's own play gate, muted, seeked to
3 s, screenshotted at the requested marks plus finer marks around each window open, the end of the
film, and the doors. Every claim below is either a screenshot (paths at the end), a DOM dump
(iframe computed opacity / pointer-events / inert, visible text nodes with font size and rect), or a
cited source line. Nothing in the product or the kit was edited.

Two caveats that bound the verdict:

- **The seeded masters are still the v2 cut.** The demo plays `film1.mp4` (79.9 s, end line "The
  flock below is live.", nested screen-recordings of the player) and the tutorial plays
  `film2.SCRATCH.mp4` (133 s, a different project called "Tour the Solar System"/"Understanding
  Waves"). The v3 films are not assembled yet, so the film FRAMES I saw are v2; the windows, the
  chip, the return, the doors and the phone behaviour are the live product and stand regardless.
- **The window-invitation chip landed in the working tree while I was testing.** My first desktop
  pass (16:03) shows no chip; every pass from 16:08 does (`SimInviteChip.tsx`, uncommitted, plus a
  9-line change in `HLSPlayerShell.tsx` and 55 lines in `viewer.css`, branch
  `feat/welcome-tutorial-kit`). The critique below judges the chip as it exists now, uncommitted.

---

## Verdict (5 lines)

1. The turn works: at 4 s the frame becomes a full-bleed, already-moving 3D sim over the still-playing film, and it hands back on time — a cold viewer feels *something* changed. What they do not get is **what to do**: the new chip is a 15 px grey pill at the bottom centre that names an object with no visible handle ("Touch the motor" over a speed slider, "Fly to a planet" over 4-px planets and a "Focus" dropdown, "Steer the flock" while the narrator says "find the scatter button").
2. A viewer who does nothing is fine mechanically (Auto Script performs, auto-return fires, narration never stops) but is **lied to** three times — "That was you", "There you go", "You're driving a molecular machine" — because no return line has a no-touch reading and the promised ghost gesture (W4) does not exist.
3. Live share is right on paper (23/58 s = 40 %) but the seeded times ([4,15]/[25,36]/[45,52] = 29 s) would be 50 % on a 58 s master, and three files disagree about when windows open; the first window at 2 s (script) is before a viewer has decided to watch — 4 s (as seeded) is the better open.
4. The doors are legible and obviously clickable, but they **only appear after the video has fully ended** — a guard in `useProjectPlayer.ts:2996` mis-fires for every mid-roll section, so the 6 s lead-in never shows them — and they render in the middle of the frame while the end card says "below" and its ▼ points at nothing.
5. The creator path is clear in the script; the shot that will lose a creator is the three-action beat 5 ("Pick Simulation. Choose your package. Open Generate mini model") played over an un-zoomed editor whose panel text is 11–13 px, with a card that on screen still says "This moment".

---

## MUST-FIX (ranked)

### 1. The invitation names a target the viewer cannot find — chip copy, anchor, size, ring
**Where.** `client-web/components/viewer/SimInviteChip.tsx` (uncommitted), `viewer.css:452–505`,
mount at `HLSPlayerShell.tsx:635–639` (`label={state.badgeText}` = the section label from
`seeding/layout-v3.json`). Screens: `demo2-t4.5.png`, `demo2-t27.png`, `demo2-t47.png`,
`demo-mobile-t06.png`.

**What I saw.** The chip appears with the reveal (good), 15 px/600 white on a 72 % black pill,
bottom-centre, ~116 px above the bottom edge, a 12 px dot with a ring that pulses twice, hides on
first pointer-down or after 4.5 s (`SIM_INVITE_HOLD_MS`). It is ~700 px away from the only visible
control on all three demo windows (the sim panel is top-right). The ring is on the chip's own dot,
not on anything touchable. And the words do not match what is on screen:

| window | chip (label) | narration (v3 script) | what is actually visible / touchable |
|---|---|---|---|
| kinesin | "Touch the motor" | "Grab the motor… spin it" | a panel with **"ASSET PROOF / Walking cycle / Teaching playback 1.0×"** — a speed slider, no scrub, no hint that dragging the canvas orbits; a "…ing the dynein assembly… 66 %" loader line bottom-left at open |
| solar | "Fly to a planet" | "Tap any planet. Go ahead… I'll wait." | "Time lapse" slider + **"Focus: Overview"** dropdown; planets are 3–5 px dots (Mercury–Mars) with 13 px labels; the sim's own hint "Drag to orbit · tap a planet to visit it" exists in the package (`#hud`, generated index.html:390) but `main.js:176` fades it 9 s after boot — and the pool boots frames long before the window opens, so it is gone before anyone sees it |
| murmuration | "Steer the flock" | "Steer the flock… find the scatter button. …That was you." | the best of the three: a "Scatter" button and a hint bar "Move your pointer — the flock follows. Tap to startle it." — but that is now **two** text elements with **two** different verbs plus a third from the narrator |
| orbit lab (F4) | "Launch a planet" | "Grab empty space… drag… let go." | nothing at all: black star field, no panel, no hint (`powers-t07.png`) |
| tutorial | "It's live — touch it" | "Tap a planet. Speed up time." | names no object |
| heavy (F3) | "Your package, live" | "Go on — scrub it." | a caption, not a command |

Answer to Q1: a first-timer understands *that* something changed (full-bleed swap, motion) within
~0.5 s; they do **not** understand *that they may touch it* (nothing on screen has ever been
touchable in a video; the only button-shaped object is the purple "Ask!") and they do not learn
*what* to do inside 2 s, because the one instruction is 15 px, far from the control, and often
contradicts the visible control. The narration carries it for sound-on viewers; sound-off viewers
have 4.5 s of small text.

**Exact fix (smallest change that makes a cold viewer act within 2 s).**

Copy — one imperative verb + the object that is visibly on screen, ≤3 words, sentence case; put it
in `layout-v3.json` `label` so nothing else changes:

- kinesin → **"Drag the slider"** if the Simple UI keeps a scrub (see #4), else **"Drag to spin"**
- solar → **"Tap Jupiter"** (the one planet big enough to hit; the sim already raycasts taps, `main.js:115–119`)
- murmuration → **"Hit Scatter"** (the narrator already says it; the button is the only button)
- orbit lab → **"Drag to launch"**
- tutorial → **"Tap a planet"**; heavy → **"Scrub the cycle"**

Anchor — the chip sits within 24 px of the thing it names, ring ON that thing (W2). Two anchor modes
are enough: `control` (the sim's first Simple-UI control; the bridge already knows the panel's
first control — pass its bounding box up, or fall back to the panel's top-left) and `canvas` (the
gesture target — centre of frame for kinesin/orbit lab, or a planet's projected position for solar).
Until the bridge exposes anchors, a static per-package anchor in the section config is fine.

Size — `font-size: clamp(18px, 2.4vw, 44px)` (→ 34 px at 1440, 44 px at 1080p per W3, 18 px on a
phone), `font-weight: 600`, solid ink pill (`background: #0b0e16`, not 72 % alpha), ring 96–128 px /
3 px stroke around the control, brand accent, two pulses (already two — keep).

Timing — appear at reveal+300 ms (now: at reveal, fine); **hold until first pointer-down, capped at
3.0 s, then the ghost gesture (see #2), then re-pulse once and hide** (W4). Never re-arm for the same
activation (already correct). Suppress the sim's own hint bar while the chip is up (murmuration), or
let the chip *be* the hint: one text element at a time (W7).

### 2. The no-touch path is a lie — no ghost gesture, and every return line assumes they touched
**Where.** SCRIPT-1 beats 3, 7, 9 (`scripts/SCRIPT-1-TEASER.md`), W4 in `CREATIVE-DIRECTION-v3.md`;
product: nothing in `useProjectPlayer.ts` performs a gesture or a cursor. Screens: `demo2-t10.png`
(chip gone at 10 s, nothing else asks), `demo-t12.png`, `tutorial-t66.png`.

**What I saw.** If the viewer does nothing, Auto Script runs the sim (kinesin slider 1.0×→1.25×→0.25×,
Time lapse 5→32 d/s, Focus→Sun, Orbit Lab launches planets) and the window closes exactly at
`end_sec` (iframe opacity 1→0, pointer-events auto→none, inert restored — verified in the dumps).
So the film still makes sense (Q2, first half: yes). But the return lines do not: "You're driving a
molecular machine inside an ad", "There you go. They fly…", "…That was you." are false for the
viewer who watched — and on a laptop with the cursor parked, I would expect that to be most of them
in the first window (they have not yet been told the video is touchable). The tutorial's beat 1
explicitly hedges ("lands whether or not they touched") — the teaser should too.

**Exact fix.** (a) Implement W4's ghost gesture: at t+3.0 s with no pointer-down, the Auto Script
performs the chip's gesture once with a drawn cursor (a 28 px ring-cursor sprite the player owns,
not the OS cursor), so the sim visibly answers a touch even when nobody touched; the chip re-pulses
once with it. (b) Rewrite the three return lines so both readings are true: beat 3 "That's a
molecular machine — live, inside an ad. This is Flow Video."; beat 7 "There you go. Planets fly…
you keep teaching."; beat 9 "…Your hand, or theirs. Live." (or drop "That was you" and keep the
scatter burst as the proof).

### 3. The doors never appear during the lead-in, and the end card points at nothing
**Where.** `client-web/components/viewer/useProjectPlayer.ts:2984–3004` (lead-in reveal) and
`:2996–2999`:

```ts
const hasPostRollSections = !!segmentsRef.current[idx]?.simulations.some((s) =>
  s.type === 'simulation' && !!s.simulation_url &&
  seg.duration >= s.start_sec - SECTION_BOUNDARY_EPSILON_SEC,
);
```

`seg.duration >= s.start_sec` is true for **every** section that starts before the film ends — i.e.
every mid-roll window — so `hasPostRollSections` is true for the demo and the 6 s lead-in reveal
(`lead_in_sec: 6`, `build-template.mjs:1092`) never fires. Screens: `demo-end-t74.png`,
`demo-end-t77.png` (end card playing, no doors), `demo-end-end-plus-3.3s.png` (doors only once
`video.ended`).

**What I saw.** Doors arrive on a frozen last frame, centred, as a 3+1 grid ("Watch again" orphaned
on a second row), over the still-visible "Flow Video." lockup and "…flock below is live." bleeding
through between the cards. The card says "The doors below are live" and the ▼ points down into the
controls bar. Q4: the cards themselves are legible (46 px prompt, 25 px labels, bordered dark cards,
cyan hover, `cursor: pointer`, first card receives focus) and obviously clickable — but the three
choices are film titles with no description, and "One Link, Three Doors" as a door label inside a
doors UI reads as a joke the viewer is not in on.

**Exact fix.** (a) Compare the section's END to the segment: `seg.duration <= s.end_sec +
SECTION_BOUNDARY_EPSILON_SEC` (a post-roll section is one that outlives the film). (b) Then the doors
can arrive during the 6 s end card as designed — place them in the lower third so "below" and the ▼
are honest (`.viewer-choice-overlay { align-items: flex-end }` for this layout, or change the line
to "Pick a door." and drop the ▼). (c) Give each edge the one-line `description` the component
already renders (`ChoiceOverlay.tsx:58`): "Drop In Anything — bring your own simulation",
"Viewer Superpowers — touch, ask, choose, anywhere", "Share it — one link, three doors" (rename the
label), and move "Watch again" to the footer as a text button so the grid is 3 doors, not 3+1
(`grid-template-columns: repeat(3, 1fr)` above 900 px).

### 4. The Simple-UI control set contradicts the ask (seeding/prompt + one sim timer)
**Where.** `seeding/layout-v3.json` prompts; the generated mini-models
(`TEMPLATE.json` demo windows); `sims/solar-system/js/main.js:176`. Screens: `demo2-t4.5.png`,
`demo2-t27.png`, `tutorial-t56.png` (the full-UI preview inside the film shows the hint line the
live window lacks).

**What I saw.** Kinesin's prompt asks for "scrub the walking cycle and orbit the camera"; the
generated Simple UI kept **Teaching playback** (speed) and dropped **Cycle position** (the scrub),
and the panel eyebrow reads "ASSET PROOF". Solar kept "Time lapse" + "Focus" (a dropdown fly-to)
and the tap hint is dead on arrival (9 s boot timer). Murmuration is right (Cohesion, Speed,
Scatter) but the film's ask (Scatter) is not the chip.

**Exact fix.** Regenerate kinesin with "Let viewers scrub the walking cycle — keep the Cycle
position slider, hide Teaching playback and the ASSET PROOF header"; start the solar `#hud` fade
from `SECTION_PRESENTED`/first paint-visible instead of boot (or let the player's chip replace it);
set every window's `label` to the FIRST control per W8 (table in #1). Verify with the proof
screenshots that the named control is on screen at t+0.3 s.

---

## SHOULD

- **"Ask!" out-competes the invitation.** During every window the only saturated, button-shaped
  element is the purple "Ask!" pill (91×42, bottom-right); the chip is a grey pill. A cold viewer
  told "touch it" will press the one button they see, and on this stack it opens an avatar popup
  that fails ("The avatar couldn't start right now…", `AvatarPopup.tsx:182`). Dim "Ask!" to 40 %
  and drop its label to the icon while the chip is up (first 3–5 s of a window); on phones it also
  covers the right end of the only slider (`demo-mobile-t06.png`).
- **Three sources of truth for window times disagree.** Script + layout say kinesin [2,10], solar
  [25,33]; the seeded sections are [4,15], [25,36] (`TEMPLATE.json` `requested`). Tutorial: layout
  [51,63] vs seeded [58,70]. Whichever film is assembled, one of them is wrong; with the seeded times
  the v3 beat-3 return line plays *inside* the still-open kinesin window (10–15 s). Make the seeder
  read `layout-v3.json` only and fail loudly on drift.
- **No countdown, no early exit (W5/W6 not built).** Nothing tells the viewer the film is coming
  back; the amber progress band is the only cue and it leaves with the controls bar ~1.5 s after
  the open (`demo2-t4.5.png` vs `demo2-t06.png`). Add the 3 px top-edge bar shrinking to
  `end_sec`, and "Keep watching →" (14 px, top-right) after the first touch.
- **Two text elements at once inside murmuration** (chip + the sim's hint bar) and dev labels in the
  kinesin panel ("ASSET PROOF", "…ing the dynein assembly… 66 %" at open). Hide sim-internal hints
  and loaders while a window is presented; strip the eyebrow from the package.
- **Landing frame (v2 master).** The poster is a screen-recording of the player *inside* the player
  ("0:00 / 4:45" chrome, the full kinesin control panel) — reads as a bug before play. The v3 cut's
  H1 open ("public page playing, cursor drifting") fixes this; verify the poster is drawn from the
  new frame 0 (`demo-00-landing.png`).
- **Creator path (Q5) — the beat that will confuse.** From SCRIPT-2 and the SCRATCH frames: beat 5
  packs three UI actions ("Pick Simulation. Choose your package. Open Generate mini model") into 8 s
  over a native-scale editor whose panel text is 11–13 px at 1440 wide (`tutorial-t56.png`,
  `tutorial-beats-t48.png`); the card on screen is still titled **"This moment"** while the narrator
  says "Generate mini model" (T6). Punch 2× on the card and re-capture after the rename. The
  drop-a-zip beat (2–3) needs the package card to land as a distinct, held shot — in the SCRATCH cut
  the Library is empty at 14 s. The flip-flip-hit (beat 7) is the clearest beat and should carry the
  rhythm; the one word to protect is "Simple UI" (the toggle) vs the direction's "Simple UI is
  mandatory" — the UI prints "Simple UI · Hides irrelevant controls", so the narration is right.
- **Tutorial window label** "It's live — touch it" → "Tap a planet" (names the object; matches the
  narration).
- **Balance (Q3).** Keep three windows; open the first at 4 s not 2 s (the viewer has to *decide* to
  watch before being asked to act — R6's 2.5 s of calm is the minimum); 8/8/7 s is enough for one
  touch, not exploration, which is right for an ad *if* #2's ghost gesture exists. Do not exceed 40 %.

## NICE

- Route the top-left "Home" (hover-only, `href="/"`) somewhere useful on public pages — it lands a
  cold viewer in the studio. A "Made with Flow Video → make yours" chip after the doors is worth more.
- Murmuration copy says "pointer" ("Your pointer draws it in") — on touch say "finger"; the phone
  version has no pointer.
- Solar planets are 3–5 px targets at 1440 px wide; give `system.hitMeshes` ≥44 px invisible hit
  spheres (the raycast is already there).
- Kinesin exit shows a translucent grey rectangle top-centre for a frame at the boundary
  (`demo2-t15.png`) — probably a sim tooltip; check it is not the exit poster.
- The bottom-left "N" badge in every screenshot is the Next.js dev-tools portal (`NEXTJS-PORTAL`),
  not the product; it does cover the murmuration hint bar in local review — ignore for shipping,
  but do not judge hint placement from local screenshots.
- Doors hold forever (behavior `pause`, no `timeout_sec`) — fine for an end-of-ad choice, but with
  the lead-in fixed consider a 10 s default to "Watch again" only if analytics show abandonment.

## Accessibility / mobile (one sentence each)

- Phone (390×844): the poster is a ~220 px letterboxed strip in a black page, then each window
  jumps to full-screen portrait — a strong turn, but the kinesin Simple-UI panel takes the bottom
  third and the chip lands on its title while "Ask!" covers the slider's right end
  (`demo-mobile-t06.png`).
- Touch: no hover means no "Home" and no controls-on-hover; the chip is the only cue, so the
  hold-until-touch rule in #1 matters more here.
- Sound-off (autoplay-muted contexts, N3): the chip is the entire argument for 4.5 s at 15 px;
  nothing else on screen says "touch" — the ghost gesture is the sound-off pass.
- Screen readers: the chip is `role="status" aria-live="polite"` (good) and the doors move focus to
  the first card (good); the sim iframes go `inert` when hidden (good) — but there is no announced
  cue that the visible iframe is interactive, and the "Ask!" `title` still says "Ask the avatar".
- Reduced motion: the chip and ring animations are disabled (`viewer.css:502–505`), which also
  removes the only attention cue — keep the ring static-visible instead of `opacity: 0`.
- Captions: `.viewer-caption-overlay` sits at bottom 104 px with controls visible and the chip at
  ~116 px — they will overlap for CC-on viewers during the first 1.5 s of a window; give the chip
  a 12 px lift while a caption is active.
- Contrast: 15 px white on 72 % black over a bright solar disc is fine, but the "Fly to a planet"
  pill over the Sun's glow at 1440 loses its edge — the solid ink pill in #1 fixes it.

## What already works

- The mechanism: full-bleed live sim over the film, 0.2 s crossfade, sim already moving at reveal
  (Auto Script), film audio/narration never interrupted, auto-return exactly on `end_sec` for all
  three windows and for the tutorial/powers windows; all three demo frames prewarmed and swapped by
  opacity; no "Go back to video" in mid-roll (only post-roll sets `showResumeBtn`).
- The new chip's semantics: once per activation, hides on first pointer-down, `pointer-events:
  none`, two pulses not endless, aria-live, reduced-motion respected. Everything in #1 is copy,
  anchor and size — the plumbing is right.
- The doors: real `<button>`s, hover state, pointer cursor, focus management, "Watch again", full-
  width stacking on phones (`demo-mobile-end-plus-33.3s.png`), and `pause` behavior that never
  stalls into black.
- Murmuration's Simple UI (Cohesion, Speed, Scatter) is the model for the others: ≤2 controls + 1
  button, the button is the ask.
- The progress bar marks every window in amber before play — the one place the page admits it is
  more than a video.

## Screenshots (this run)

Desktop demo, first pass (pre-chip, 16:03):
- /private/tmp/claude-501/-Users-ofeklevy-cebu/a73f907b-73b7-4f6a-a3ed-0b50392e8a2f/scratchpad/ux-critique/demo-00-landing.png
- /private/tmp/claude-501/-Users-ofeklevy-cebu/a73f907b-73b7-4f6a-a3ed-0b50392e8a2f/scratchpad/ux-critique/demo-t06.png
- /private/tmp/claude-501/-Users-ofeklevy-cebu/a73f907b-73b7-4f6a-a3ed-0b50392e8a2f/scratchpad/ux-critique/demo-t12.png
- /private/tmp/claude-501/-Users-ofeklevy-cebu/a73f907b-73b7-4f6a-a3ed-0b50392e8a2f/scratchpad/ux-critique/demo-t16.png
- /private/tmp/claude-501/-Users-ofeklevy-cebu/a73f907b-73b7-4f6a-a3ed-0b50392e8a2f/scratchpad/ux-critique/demo-t27.png
- /private/tmp/claude-501/-Users-ofeklevy-cebu/a73f907b-73b7-4f6a-a3ed-0b50392e8a2f/scratchpad/ux-critique/demo-t30.png
- /private/tmp/claude-501/-Users-ofeklevy-cebu/a73f907b-73b7-4f6a-a3ed-0b50392e8a2f/scratchpad/ux-critique/demo-t47.png

Desktop demo, fine-grained pass (with the uncommitted chip, 16:10):
- /private/tmp/claude-501/-Users-ofeklevy-cebu/a73f907b-73b7-4f6a-a3ed-0b50392e8a2f/scratchpad/ux-critique/demo2-00-landing.png
- /private/tmp/claude-501/-Users-ofeklevy-cebu/a73f907b-73b7-4f6a-a3ed-0b50392e8a2f/scratchpad/ux-critique/demo2-t4.5.png
- /private/tmp/claude-501/-Users-ofeklevy-cebu/a73f907b-73b7-4f6a-a3ed-0b50392e8a2f/scratchpad/ux-critique/demo2-t05.png
- /private/tmp/claude-501/-Users-ofeklevy-cebu/a73f907b-73b7-4f6a-a3ed-0b50392e8a2f/scratchpad/ux-critique/demo2-t06.png
- /private/tmp/claude-501/-Users-ofeklevy-cebu/a73f907b-73b7-4f6a-a3ed-0b50392e8a2f/scratchpad/ux-critique/demo2-t08.png
- /private/tmp/claude-501/-Users-ofeklevy-cebu/a73f907b-73b7-4f6a-a3ed-0b50392e8a2f/scratchpad/ux-critique/demo2-t10.png
- /private/tmp/claude-501/-Users-ofeklevy-cebu/a73f907b-73b7-4f6a-a3ed-0b50392e8a2f/scratchpad/ux-critique/demo2-t13.png
- /private/tmp/claude-501/-Users-ofeklevy-cebu/a73f907b-73b7-4f6a-a3ed-0b50392e8a2f/scratchpad/ux-critique/demo2-t15.png
- /private/tmp/claude-501/-Users-ofeklevy-cebu/a73f907b-73b7-4f6a-a3ed-0b50392e8a2f/scratchpad/ux-critique/demo2-t25.5.png
- /private/tmp/claude-501/-Users-ofeklevy-cebu/a73f907b-73b7-4f6a-a3ed-0b50392e8a2f/scratchpad/ux-critique/demo2-t27.png
- /private/tmp/claude-501/-Users-ofeklevy-cebu/a73f907b-73b7-4f6a-a3ed-0b50392e8a2f/scratchpad/ux-critique/demo2-t36.5.png
- /private/tmp/claude-501/-Users-ofeklevy-cebu/a73f907b-73b7-4f6a-a3ed-0b50392e8a2f/scratchpad/ux-critique/demo2-t45.5.png
- /private/tmp/claude-501/-Users-ofeklevy-cebu/a73f907b-73b7-4f6a-a3ed-0b50392e8a2f/scratchpad/ux-critique/demo2-t47.png
- /private/tmp/claude-501/-Users-ofeklevy-cebu/a73f907b-73b7-4f6a-a3ed-0b50392e8a2f/scratchpad/ux-critique/demo2-t50.png

End of the demo / doors (desktop):
- /private/tmp/claude-501/-Users-ofeklevy-cebu/a73f907b-73b7-4f6a-a3ed-0b50392e8a2f/scratchpad/ux-critique/demo-end-00-landing.png
- /private/tmp/claude-501/-Users-ofeklevy-cebu/a73f907b-73b7-4f6a-a3ed-0b50392e8a2f/scratchpad/ux-critique/demo-end-t74.png
- /private/tmp/claude-501/-Users-ofeklevy-cebu/a73f907b-73b7-4f6a-a3ed-0b50392e8a2f/scratchpad/ux-critique/demo-end-t77.png
- /private/tmp/claude-501/-Users-ofeklevy-cebu/a73f907b-73b7-4f6a-a3ed-0b50392e8a2f/scratchpad/ux-critique/demo-end-end-plus-3.3s.png
- /private/tmp/claude-501/-Users-ofeklevy-cebu/a73f907b-73b7-4f6a-a3ed-0b50392e8a2f/scratchpad/ux-critique/demo-end-end-plus-6.3s.png
- /private/tmp/claude-501/-Users-ofeklevy-cebu/a73f907b-73b7-4f6a-a3ed-0b50392e8a2f/scratchpad/ux-critique/demo-end-end-plus-10.4s.png
- /private/tmp/claude-501/-Users-ofeklevy-cebu/a73f907b-73b7-4f6a-a3ed-0b50392e8a2f/scratchpad/ux-critique/demo-end-end-door-hover.png

Phone viewport (390×844, touch), demo + doors:
- /private/tmp/claude-501/-Users-ofeklevy-cebu/a73f907b-73b7-4f6a-a3ed-0b50392e8a2f/scratchpad/ux-critique/demo-mobile-00-landing.png
- /private/tmp/claude-501/-Users-ofeklevy-cebu/a73f907b-73b7-4f6a-a3ed-0b50392e8a2f/scratchpad/ux-critique/demo-mobile-t06.png
- /private/tmp/claude-501/-Users-ofeklevy-cebu/a73f907b-73b7-4f6a-a3ed-0b50392e8a2f/scratchpad/ux-critique/demo-mobile-t12.png
- /private/tmp/claude-501/-Users-ofeklevy-cebu/a73f907b-73b7-4f6a-a3ed-0b50392e8a2f/scratchpad/ux-critique/demo-mobile-t47.png
- /private/tmp/claude-501/-Users-ofeklevy-cebu/a73f907b-73b7-4f6a-a3ed-0b50392e8a2f/scratchpad/ux-critique/demo-mobile-end-plus-33.3s.png
- /private/tmp/claude-501/-Users-ofeklevy-cebu/a73f907b-73b7-4f6a-a3ed-0b50392e8a2f/scratchpad/ux-critique/demo-mobile-end-plus-36.4s.png
- /private/tmp/claude-501/-Users-ofeklevy-cebu/a73f907b-73b7-4f6a-a3ed-0b50392e8a2f/scratchpad/ux-critique/demo-mobile-end-plus-40.5s.png
- /private/tmp/claude-501/-Users-ofeklevy-cebu/a73f907b-73b7-4f6a-a3ed-0b50392e8a2f/scratchpad/ux-critique/demo-mobile-end-door-hover.png

Tutorial ("Make Yours"), window at 58–70 s and build beats:
- /private/tmp/claude-501/-Users-ofeklevy-cebu/a73f907b-73b7-4f6a-a3ed-0b50392e8a2f/scratchpad/ux-critique/tutorial-00-landing.png
- /private/tmp/claude-501/-Users-ofeklevy-cebu/a73f907b-73b7-4f6a-a3ed-0b50392e8a2f/scratchpad/ux-critique/tutorial-t56.png
- /private/tmp/claude-501/-Users-ofeklevy-cebu/a73f907b-73b7-4f6a-a3ed-0b50392e8a2f/scratchpad/ux-critique/tutorial-t60.png
- /private/tmp/claude-501/-Users-ofeklevy-cebu/a73f907b-73b7-4f6a-a3ed-0b50392e8a2f/scratchpad/ux-critique/tutorial-t66.png
- /private/tmp/claude-501/-Users-ofeklevy-cebu/a73f907b-73b7-4f6a-a3ed-0b50392e8a2f/scratchpad/ux-critique/tutorial-t72.png
- /private/tmp/claude-501/-Users-ofeklevy-cebu/a73f907b-73b7-4f6a-a3ed-0b50392e8a2f/scratchpad/ux-critique/tutorial-beats-00-landing.png
- /private/tmp/claude-501/-Users-ofeklevy-cebu/a73f907b-73b7-4f6a-a3ed-0b50392e8a2f/scratchpad/ux-critique/tutorial-beats-t06.png
- /private/tmp/claude-501/-Users-ofeklevy-cebu/a73f907b-73b7-4f6a-a3ed-0b50392e8a2f/scratchpad/ux-critique/tutorial-beats-t14.png
- /private/tmp/claude-501/-Users-ofeklevy-cebu/a73f907b-73b7-4f6a-a3ed-0b50392e8a2f/scratchpad/ux-critique/tutorial-beats-t22.png
- /private/tmp/claude-501/-Users-ofeklevy-cebu/a73f907b-73b7-4f6a-a3ed-0b50392e8a2f/scratchpad/ux-critique/tutorial-beats-t30.png
- /private/tmp/claude-501/-Users-ofeklevy-cebu/a73f907b-73b7-4f6a-a3ed-0b50392e8a2f/scratchpad/ux-critique/tutorial-beats-t40.png
- /private/tmp/claude-501/-Users-ofeklevy-cebu/a73f907b-73b7-4f6a-a3ed-0b50392e8a2f/scratchpad/ux-critique/tutorial-beats-t48.png

Viewer Superpowers (Orbit Lab window 6–18 s, pre-chip):
- /private/tmp/claude-501/-Users-ofeklevy-cebu/a73f907b-73b7-4f6a-a3ed-0b50392e8a2f/scratchpad/ux-critique/powers-00-landing.png
- /private/tmp/claude-501/-Users-ofeklevy-cebu/a73f907b-73b7-4f6a-a3ed-0b50392e8a2f/scratchpad/ux-critique/powers-t07.png
- /private/tmp/claude-501/-Users-ofeklevy-cebu/a73f907b-73b7-4f6a-a3ed-0b50392e8a2f/scratchpad/ux-critique/powers-t12.png
- /private/tmp/claude-501/-Users-ofeklevy-cebu/a73f907b-73b7-4f6a-a3ed-0b50392e8a2f/scratchpad/ux-critique/powers-t19.png

DOM dumps (iframe opacity/pointer-events/inert, visible text + font sizes, buttons, running
animations per timestamp) sit beside the PNGs as `*-dump.json`; the capture script is `shoot.cjs`
in the same directory (read-only against the public pages; no product or kit file touched).
