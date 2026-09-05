# FlowVid Tutorial Film — Creative Brief (v4 — after the owner's review, 2026-09-05 midday)

## OWNER VERDICT ON THE FIRST CUT (verbatim force): "stuck and boring"
The v2 films CAPTURED simulations as footage and piled interactive sections at the END of the
timeline. Rejected outright: "Why stick simulations at the end, and three of them? No point."
"Don't capture simulations — EMBED them at the relevant parts, at the right times, as part of the
ad." "The point of the sims: they have BUTTONS; in Generate mini model you write what to change and
flip Simple UI + Auto Script — show THAT." "The Heavy Simulation — what's the point? Users care what
to DO." "Scripts not marketing-strong. Pace, music, narration, embedding — all of it: improve."

## THE v3 GRAMMAR (verified in the product 2026-09-05): MID-ROLL LIVE WINDOWS
A section with start/end INSIDE the video presents the REAL interactive simulation on top while
the video AND narration keep playing underneath, then auto-returns to video at the window's end.
Films are therefore: short kinetic video (narration + real UI captures ONLY) + live windows at the
narrative beats — the narration speaks OVER the window and directs the viewer's hand. No sim
footage anywhere. One sim per beat, at its beat. Layout of record: seeding/layout-v3.json.
Product renames shipped with this round: "✦ This moment" → "Generate mini model" (no star);
header "?" moved right of Create link.


## STYLE REFERENCE (owner, 2026-09-05): ~/Downloads/welcome!.mp4
A ~56s product teaser from another app, sampled frame-by-frame. What we adopt:
1. **Animated brand-mark intro on a clean light ground** (~3s) — then straight into product.
2. **The body is REAL screen-recorded flows** at a calm confident pace with visible cursor
   choreography — polish through pacing, not heavy motion graphics.
3. Bright, warm, light-theme UI captures; our sims provide the cinematic dark CONTRAST beats
   (full-bleed murmuration/kinesin moments punctuating the light UI flow).
4. Total ~55–70s for the teaser. American-ad energy: short teaser beats, zero fluff, CTA close.
The infographic layer therefore stays MINIMAL: kinetic captions + the logo intro + the CTA card;
no wall-to-wall overlays.

## OWNER RESTRUCTURE v2 (2026-09-05 night): a PLAYLIST of five films
Owner directive: embed everything in a playlist — teaser first, then basic operations, then niche
films. The seeded artifact is the **"Welcome to Flow Video" playlist**:
  ① the DEMO PROJECT (teaser + tutorial on ONE timeline, live sections between them)
  ② Film 3 "The Heavy Simulation" · ③ Film 4 "Viewer Superpowers" · ④ Film 5 "One Link, Three Doors"
Demo-project timeline: [① TEASER ~70s] → [live sim: Murmuration, touch it NOW] → [② TUTORIAL
~2:10] → [live sim: Wave Lab] → [image infographic] → [choice section] · A2: ambient sting.
Scripts: scripts/SCRIPT-{1..5}-*.md (v2, post G1-pre panel).
- **① TEASER (the demo/trailer)** — pure marketing. The uniqueness: an interactive video you
  TOUCH — click the simulations, press buttons in the video, ask the avatar OUT LOUD mid-video;
  Smart Crop vertical as a flagged differentiator (your phone stays vertical — the video follows
  the speaker instead of cropping weirdly); dubbing/languages in one breath. Fast, confident.
- **② TUTORIAL (the follow-up, its own video section on the same timeline)** — deliberately
  basic and practical: edit a video; ADD SIMULATION SECTIONS — the heart: how to embed big,
  complex simulations in a polished, marketing-grade way, generate MINIMAL UI and AUTO SCRIPT
  for them; add more videos/images/audio (briefly); Settings: avatar, languages/dubbing (small
  mention), Share + Collaborators (briefly). Emphasis throughout: the viewer-activity uniqueness.

## Original demo simulations (license-clean, built for this — v2 lineup, owner steers of 09-05)
| sim | role | controls (static DOM ids for the scanner) | auto-script | why |
|---|---|---|---|---|
| **Murmuration 3D** (boids flock in a 3D volume) | teaser star + first touchable section | #cohesion #alignment #separation #speed sliders, #scatter button, #trails toggle, #reset | choreographed scatter→reform loop | organic wow; pointer attracts the flock in true 3D |
| **Solar System 3D** (three.js, procedural textures, Kepler ratios) | the sim BUILT on camera in tutorial S4 + its own section | #speed range, #focus select, #labels/#orbits toggles, #tour button, #reset | cinematic auto-tour | owner: realistic flagship embed example; tap a planet to fly to it |
| **Orbit Lab** (classical mechanics + live force vectors) | film 4 touch scene + third live section | #gravity #timescale ranges, #vectors #trails toggles, #preset select, #demo #reset buttons | nested demo orbits + comet | owner: force vectors; drag-to-launch with predicted path |
All: MULTI-FILE packages (owner: one-file reads low-quality) — index.html + styles.css + js/*,
zero/vendored deps, 60fps, touch-first, static controls in the initial DOM, clean `window.*Sim`
API + `__flowvidReadyForPresent`, self-contained dark aesthetic. (Wave Lab kept as spare only —
owner judged it too niche for seeding.) Music: original synthesized beds in `music/` (verified
-32 LUFS, license-clean by construction); the A2 sting is `music/sting-ambient.wav`.


## The one-line promise (first 15 seconds must land it)
**Your video stops being a video.** FlowVid turns source material into a narrated video whose
moments are ALIVE — the viewer touches a simulation, asks a question with their voice, chooses
the path. Made by AI, directed by you.

## Meta-concept (the whole trick)
The tutorial IS the product: it ships as a real FlowVid project seeded for every new user. The
film plays on the timeline; below it sit the same interactive sections it talks about. The final
line hands the wheel over: "This project is yours — everything you just watched is editable.
Try the simulation below." The narrated video → interactive walkthrough structure is the 2026
best-practice arc, and here the product does it natively.

## Hard constraints
- **Length ≤ 2:20** (research: 2–3 min ceiling; value stated inside 0:30).
- **English narration**, spoken register, no jargon; the owner says "Flow Video" aloud.
- **Every frame is REAL product** — screen captures of the live app (v0.7.0 UI), no mockups.
- **Infographic layer** on top: kinetic type, callout arrows, step numerals — built as an
  HTML/CSS animation page (1920×1080), recorded with Playwright video, composited with the
  captures; house palette (hsl tokens → hex snapshot), Heebo/JetBrains Mono won't fit English
  marketing — pick at build time.
- **License-clean demo sim only**: the kinesin GLB is CGTrader-gated for public distribution and
  a seeded-for-every-user project IS distribution. The demo project ships an ORIGINAL small sim
  (canvas physics — e.g. a wave/pendulum/boids toy, MIT-clean, built for this) — the film may
  still SHOW the kinesin sim as a capture ("what creators build") if the owner confirms even
  that; default: captures use the original demo sim too. FLAG TO OWNER.
- Narration audio through the product's own TTS path (owner's ElevenLabs key, spend recorded).

## OWNER DIRECTION (2026-09-05, overrides everything else in tone):
The film's single job is to make the viewer FEEL the uniqueness of an INTERACTIVE video —
"this is not another video": you actually CLICK the simulations, press the buttons, learn
actively, and ASK THE AVATAR in real time about what you're watching. That is the biggest
differentiator; the making-of/editor flow is supporting cast, not the lead.

## Narrative arc (5 beats, ~2:15) — interactivity-first
| t | beat | on screen | narration intent |
|---|---|---|---|
| 0:00–0:15 | HOOK — "TOUCH IT" | a lesson video plays… then the CURSOR ENTERS THE FRAME: taps the simulation — it responds; drags a slider — physics changes; presses a button IN the video | "Every video you've ever watched, you watched. This one, you TOUCH." |
| 0:15–0:45 | THE VIEWER'S POWERS (the thesis) | rapid-fire, all inside the playing video: ① touch & drive a live simulation ② press real buttons/choices (branching) ③ ASK the avatar out loud, mid-lesson — voice question → instant spoken answer grounded in THIS video | "Pause nothing. Ask anything. The lesson answers back." |
| 0:45–1:25 | HOW IT ANSWERS / ACTIVE LEARNING | one concrete learning scenario: a concept appears → viewer plays with the sim until it clicks → asks the avatar "wait, why does…?" → grounded answer → continues. Emphasis: understanding by DOING | active learning beats passive watching — shown, not claimed |
| 1:25–1:55 | AND YOU MADE IT IN MINUTES (creator beat) | compressed: New project → AI drafts → drop a simulation .zip into the Library → "This moment": tell the AI what viewers can touch → publish/share/access (NO pricing claims — Access says who watches) | the creator flow as a fast, confident montage |
| 1:55–2:15 | HANDOVER | zoom out: this very film sits on a FlowVid timeline; the sim section below glows | "This project is yours. The simulation below is live. Go on — touch it." |

## Production pipeline
1. Feature inventory + seeding map (agents, in flight) → lock script v1.
2. Narration script → owner-visible for a quick veto window → TTS via backend service.
3. Captures: Playwright, 1920×1080 @2x, the LOCAL stack on v0.7.0; scripted flows per shot list;
   screen RECORDINGS (playwright video) for motion shots, stills for infographic beats.
4. Infographic layer: one HTML animation timeline (scenes keyed to narration timecodes),
   recorded headless; ffmpeg: concat/overlay captures + layer + narration + music? (music: only
   if a license-clean track exists — else narration-only with sound design via TTS pacing).
5. Assemble MP4 (H.264, 1920×1080, AAC), QC pass (sync, legibility at 360p), upload as the
   template project's master video, HLS transcode, captions VTT from the narration script
   (word-timed — enables Tap-to-ask ON the tutorial itself!).
6. Demo project template: master video + original interactive sim section + 2 images + audio
   sting on A2; posters captured; permalink; then the seeding mechanism (per the seeding map)
   behind an env/admin flag, idempotent per user.
7. Device/browser sweep on the seeded project; ship.

## Open questions for the owner (non-blocking for drafting)
1. Say "Flow Video" aloud while the UI shows "Interactive Video Studio" (PUBLIC_BRAND_NAME)? Or
   set the brand name first?
2. Voice: the admin default voice (same as guidance) or a specific ElevenLabs voice id?
3. May the film SHOW the kinesin sim in captures (marketing use of a private proof), or keep
   everything to the license-clean demo sim? (Default: license-clean only.)
4. Music: none / provide a licensed track?
