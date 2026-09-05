# CREATIVE DIRECTION v3 — the five Flow Video films

Binding for: Film 1 teaser (~58 s, three mid-roll live windows) · Film 2 tutorial (~90 s, one
window) · Films 3/4/5 niche (45–55 s). Written 2026-09-05 after the owner rejected the v2 cut as
"stuck and boring" and asked for "far higher-quality, interactive films" built on references.
Scope: how the films LOOK, CUT and SOUND. Scripts (`scripts/SCRIPT-*.md` v3) own the words;
`seeding/layout-v3.json` owns the window times — both retime together with §9.

Every rule below carries a one-line source. "advids 7-sample" = advids.co's analysis of seven
launch films (Linear, Vercel, Framer, Raycast, Arc, Stripe, Supabase/Notion); treat its
percentages as a small-sample pattern, not a law. Anything I could not verify says so.

---

## 0. The thesis in one line

**A Flow Video ad is a machine the viewer is already operating by second four.** Every other
product film SHOWS a product; ours hands it over. So the grammar is not "trailer + demo" — it is
the heartbeat arc YouTube's own research favours over the TV arc: start high, unexpected shift,
multiple peaks, brand cues throughout, more story for those who want it
(https://www.thinkwithgoogle.com/_qs/documents/8472/ABCD_Complete_V7b_HR_1.pdf, p.3). The peaks
are the live windows. The film exists to get the viewer's hand onto the glass, three times.

---

## 1. Reference study — what the best short product films actually do

Fields per film: length · hook (first 3 s) · shot rhythm · how UI is shown · type/motion
restraint · music/narration · CTA shape · the one thing we steal.

### 1.1 Apple — iPhone 16 "Camera Control" spot (2024)
- **Length:** 30 s. **Hook:** a hand swipes the Camera Control button and the frame zooms on a
  white poodle — the gesture and its result are the first thing on screen; no setup.
- **Rhythm:** one feature, four gestures (zoom → Tone → Exposure → Ultra-wide), each a
  gesture-then-result pair; nothing is explained twice.
- **UI:** the real camera UI, full-bleed, the hand always in frame; the product IS the frame.
- **Type:** feature names as short supers; no paragraph ever appears. **Music:** "Push" (Skrillex,
  Hamdi, Taichu) carries the energy; the ad is music-led (voiceover use not verified from text
  sources). **CTA:** product name + Apple mark, nothing else.
- **Steal:** gesture → consequence as the atomic unit; the hand never leaves the frame.
- https://www.phonearena.com/news/new-iphone-ad-focuses-on-the-best-new-iphone-16-feature_id163412 ·
  https://www.ilounge.com/news/iphone/new-apple-ad-highlights-iphone-16-pro-camera-control

### 1.2 Apple — "Introducing Apple Vision Pro" (WWDC 2023 film)
- **Length:** long-form (~9 min; the category film, not a spot). **Hook:** "the era of spatial
  computing" — it establishes the new BEHAVIOUR and the interaction model (eyes, hands, voice)
  before any feature. **Sequencing:** broad promise → specific proofs.
- **Steal:** "Begin with the new behavior or category promise" — our promise is "you touch the
  video", and it must be the first thing proven, not the third.
- https://www.apple.com/newsroom/2023/06/introducing-apple-vision-pro/ ·
  https://tapvid.ai/blog/product-launch-video-examples (Vision Pro entry, film
  https://www.youtube.com/watch?v=mCuZngRpZa8)

### 1.3 Linear — launch reels and changelog films (2024–2026)
- **Length:** short reels (exact lengths not verified). **Hook:** spoken macro-bottleneck, then the
  dashboard at **2.4 s** (advids 7-sample); the 2026 "Introducing Linear Agent" film opens on the
  thesis "execution accelerates and judgment becomes the bottleneck".
- **Rhythm:** dense, rapid — but "a rapid reel still needs enough screen time for a viewer to
  verify what changed" (TapVid's critique). **UI:** current dark-mode UI; secondary sidebars thrown
  out of focus with depth-of-field blur; the fully assembled hero UI withheld until the halfway
  mark in teasers.
- **Type:** feature names in the UI's own casing ("Product Intelligence", "Triage Intelligence"),
  short declarative sentences; kinetic type is collision/action-synced, never decorative.
  **Music/VO:** ambient, feature-language over it. **CTA:** documentation/"learn how" — a link,
  not a slogan.
- **Steal:** name features exactly as the UI prints them; blur what doesn't matter instead of
  cropping it out; give a changed pixel ≥1.5 s to be verified.
- https://advids.co/blog/saas-product-launch-videos · https://advids.co/blog/saas-launch-teaser ·
  https://tapvid.ai/blog/product-launch-video-examples ·
  https://linear.app/changelog/2025-08-14-product-intelligence-technology-preview ·
  https://www.youtube.com/watch?v=mRql2VJ99gM

### 1.4 Figma — Config 2025 opening film (Relay) and "All the launches at Config 2025"
- **Opening film:** preceded by a one-minute ambient countdown scored on an "orchestra warming up"
  motif; frame rate dropped from 60 to **15 fps** to feel "tactile and handmade, not so smooth and
  slick"; glyphs thread, stack, loop and break out of containers; brief: "grounded in substance,
  and not just eye candy".
- **Launch reel:** ~**90 s**, screen recordings only, **no voiceover**, upbeat music — the
  interface sells itself. advids notes Figma's "kinetic typography collapse" and a "300% scale-in"
  triggered where the cursor intersects the UI.
- **Steal:** a film can have a TEXTURE decision (Figma chose 15 fps); ours is "real glass" — 60
  fps sims, 30 fps captures, zero synthetic gloss. And: a no-VO cut of the montage beat must work.
- https://www.figma.com/blog/how-we-shaped-the-visual-identity-for-config-2025/ ·
  https://blarevideo.com/feeds/blog/saas-product-launch-video (reel:
  https://www.youtube.com/watch?v=NHodnYFUT_I) · https://advids.co/blog/saas-product-intro

### 1.5 Vercel — launch films + the Ship livestream reactions
- **Hook:** **zero-second UI reveal** — the interface is the hook; "primary workflow solution within
  the first 6 seconds" (advids 7-sample). **UI:** full fidelity; text overlays isolated and static;
  cursor kinematics artificially smoothed.
- **Interactivity reference:** the Ship livestream added live emoji reactions — 340,157 reactions,
  29,253/min at peak — where "every single click immediately produces a response without having to
  wait for a round-trip".
- **Steal:** when the viewer touches, the response is instantaneous and visible; latency is the
  enemy of "it's live".
- https://advids.co/blog/saas-product-launch-videos · https://advids.co/blog/saas-launch-teaser ·
  https://liveblocks.io/blog/how-vercel-used-live-reactions-to-improve-engagement-on-their-vercel-ship-livestream

### 1.6 Raycast — v2 / Windows launches (2025–2026)
- **Hook:** teasers open on an abstract, non-UI cinematic beat (advids 7-sample); launch pages
  open on one line: "Same shortcut. New everything." / "Your computer, but faster."
- **UI:** captioned product shots, dark neutral ground, no device frames; cursor motion engineered
  smooth. **Type:** sentence case, numbered sections ("01/02/03"), minimal body. **CTA:** one word
  — "Download" — with a qualifier line under it. (Windows launch video exists; length not verified.)
- **Steal:** the four-word headline grammar and the single-verb CTA.
- https://www.raycast.com/new · https://www.raycast.com/blog/raycast-for-windows ·
  https://advids.co/blog/saas-launch-teaser

### 1.7 Arc / The Browser Company — release-note films (2023–2024)
- **Format:** the founder "talking directly to his webcam in what looks like his own bedroom",
  lighting "a bit off", deliberately vlog-like; ~5-minute format, fast editing, 3–4 videos a
  month. Teasers withhold the hero UI until halfway and "time-lapse blur" through setup steps.
- **Steal:** authenticity is a production value — real captures, real latency, real hands beat
  polish; and the time-lapse through setup (our "drop → sorted" beat) instead of watching a
  progress bar.
- https://newsletter.failory.com/p/lights-camera-arction ·
  https://strategybreakdowns.com/p/arc-release-notes · https://advids.co/blog/saas-launch-teaser

### 1.8 Notion — "Introducing Notion Calendar" (Jan 2024) and launch films
- **Hook:** blog opens "Time is our most precious resource."; films use a split-second title card
  then a hard cut into a blank workspace. **Structure:** "the interface remains central; the
  sequence follows one actual user workflow" — "keep each scene connected to that chain".
- **UI:** real UI plus illustrated characters; **zoom-through transitions** — finishing one task
  pulls the camera into the next module, bypassing menus; a "rapid, almost instant teleporting
  cursor" (the one thing NOT to copy). **CTA:** "Try it here now".
- **Steal:** one workflow chain per film; zoom-through instead of navigating.
- https://www.notion.com/blog/introducing-notion-calendar ·
  https://tapvid.ai/blog/product-launch-video-examples · https://advids.co/blog/saas-launch-teaser

### 1.9 Loom — Loom AI launch (2023–2024)
- **Hook:** a 5-second human-centric beat before the floating camera UI appears (advids).
  **Structure:** before/after — "show which steps remain, which become shorter, and which
  disappear"; "avoid claiming time savings unless you have a documented measurement".
  **Headline:** "Hit record and Loom AI will do the rest". **CTA:** "Try Loom AI for free".
- **Steal:** for the tutorial, the step that DISAPPEARS is the story (the AI wires the sim — no
  code) and it must be shown as an absence, not narrated as a claim.
- https://www.loom.com/ai · https://tapvid.ai/blog/product-launch-video-examples ·
  https://advids.co/blog/saas-product-intro

### 1.10 Descript — Underlord / Season 6 (2025)
- **Device:** a personality-led NAME as the memory device — "separate the memory device from the
  proof device": "the real editing actions, outputs, and limitations must still make the
  capability understandable". **CTA:** "Try Underlord".
- **Steal:** "Flow Video" (spoken 3×) is our memory device; the live window is the proof device;
  never let the brand line do the proof's job.
- https://www.descript.com/blog/article/descript-season-6-meet-underlord ·
  https://www.youtube.com/watch?v=YAdMaTPvqtA · https://tapvid.ai/blog/product-launch-video-examples

### 1.11 Duolingo — the 5-second Super Bowl spot (2024) and Video Call with Lily (Duocon 2024)
- **Length:** **5 s**. **Beat sheet:** Duo in a white frame, sheepish → his rear swells → a second
  Duo pops out on a custom notification sound (≈200 variations auditioned, blended with the app's
  own correct-answer chime) → type: "Do your Duolingo." Design rule: "the direction of the eyes
  guided you toward the type"; "each frame was something somebody could screengrab". Synchronised
  with 4 million push notifications ("Do your lesson, no butts") at air time.
- **Video Call with Lily:** the interactive-learning feature (real-time conversation with a
  character) — the product itself is the ad.
- **Steal:** surprise inside 3 s; the product's own sound as the sonic brand; the last moving thing
  in frame points at the words. Kahoot!: no citable spot surfaced (their growth is partnerships,
  not films — https://www.marketing-interactive.com/Kahoot-push-growth-branded-experiences), so the
  interactive-choice grammar reference below is Bandersnatch.
- https://www.figma.com/blog/the-anatomy-of-duolingos-super-bowl-ad/ ·
  https://www.infoq.com/news/2024/04/qcon-london-duolingo-super-bowl/ ·
  https://investors.duolingo.com/news-releases/news-release-details/duolingo-introduces-ai-powered-innovations-duocon-2024

### 1.12 Netflix — Black Mirror: Bandersnatch choice UI (the interactive-video grammar)
- Choice = **two text options + a horizontal bar that shrinks over 10 s**; a default is taken on
  timeout so the story never stalls. The team first tried a "completely non-verbal design with
  visual cues" — testing found it "baffling" — and settled on plain text in a letterbox. Decision
  points every 3–5 minutes: "long enough not to intrude, short enough that viewers don't feel the
  mechanic has been abandoned". Device-aware cues (underlines for remotes, none for touch).
- **Steal:** words beat icons for invitations; a visible timer is the promise the film returns;
  cadence — the mechanic must recur before it is forgotten.
- https://uxdesign.cc/how-did-the-ux-design-team-prepare-us-for-the-new-black-mirror-bandersnatch-interactive-film-aa3373145e79 ·
  https://en.wikipedia.org/wiki/Black_Mirror:_Bandersnatch

### 1.13 Interactive-video platforms' own demos — Genially · Vimeo · ThingLink · H5P
- **Genially:** "Pulsing icons appear automatically on the interactive elements and hotspots,
  showing the user where to click" — a toggle for when "your audience might not realize the
  content is clickable". https://genially.com/features/interactions-and-animations/
- **Vimeo Interactive:** hotspots, time triggers, branching; guidance: "Make choices obvious: use
  short labels and strong contrast… then give viewers plenty of time to notice and click through";
  "limit choices to two or three per scene". https://vimeo.com/features/interactive-video ·
  https://vimeo.com/blog/post/how-to-make-interactive-video
- **ThingLink:** time a tag "to appear exactly when a learner sees the relevant action on screen";
  learners "pause, explore… and then continue".
  https://www.thinglink.com/blog/how-to-make-an-interactive-video-without-any-coding/
- **H5P Interactive Video:** per-interaction **Pause** checkbox ("so that the video pauses when the
  interaction appears"); "the Label is a text displayed next to the interaction icon as a short
  description"; bookmarks on the seek bar. https://h5p.org/tutorial-interactive-video?page=5
- **Steal:** the cue sits ON the control and carries a label; it appears when the action is on
  screen; pausing is a choice per interaction — our windows keep the film running (that IS the
  differentiator), so the cue must be louder than a paused platform's.

### 1.14 Explorable explanations — Bret Victor · Bartosz Ciechanowski (the closest analog to "touch it while the narration continues")
- Victor: "the barrier to exploration here is extremely low — simply click and drag"; "the reader
  is not forced to interact"; "the reader is not transported off to a separate 'interactive'
  context. Instead, the reader simply nudges the examples that the author has already presented";
  "the author must guide the reader". http://worrydream.com/ExplorableExplanations/
- Ciechanowski's invitations are full sentences in the prose: "You can drag the device around to
  change your viewing angle, and you can use the slider to peek at what's going on inside"; "By
  dragging the slider you can try to wind it midair" — the slider sits directly beneath the
  figure; the demo is already animating before you touch it. https://ciechanow.ski/mechanical-watch/
- **Steal:** the window is a NUDGE of what the film already showed, never a context switch; the
  invitation is a sentence with a verb and an object, spoken by the narrator AND printed on the
  control; the sim must already be moving when the hand arrives.

### 1.15 Screen Studio — the cursor/zoom grammar of 2024–2026 product demos
- "Automatically zooms in on actions you perform" (a click triggers a zoom toward that button; a
  drag triggers a pan following it); cursor motion smoothed ("shaky and rapid movement… transformed
  into a smooth and beautiful glide"); cursor size adjustable after the fact; "if the cursor
  doesn't add value to your video, it can be automatically hidden"; the cursor "can return to its
  initial position near the end" for loops; motion blur so movement "looks more natural".
- https://screen.studio/ ·
  https://www.datastudios.org/post/screen-studio-auto-zoom-mechanism-mac-only-limits-and-pricing-explained

### 1.16 The numbers behind the rules
- Attention: "aim for two or more shots in the first five seconds"; "use tight framing on the
  subject"; "introduce your product or brand in the first five seconds"; "large-type supers" for
  mobile; CTAs "through text cards, simple animation or voiceover", "specific calls-to-action (Visit
  site, Sign up…)". https://www.thinkwithgoogle.com/_qs/documents/8472/ABCD_Complete_V7b_HR_1.pdf
- Hook rate = 3-second views ÷ impressions; below 25% "your first three seconds are failing";
  secondary reporting of Meta's 2025 creative guidance: strong hooks in the first three seconds
  "see up to 89% higher completion rates than ads that front-load branding".
  https://www.cometly.com/post/what-are-3-second-video-views ·
  https://adlibrary.com/posts/meta-ad-creative-best-practices
- Shot memory: scenes held ≥**1.5 s** were better recognised; the paper's recommendation is FEWER
  shots, not more (MacLachlan & Logan, J. Advertising Research).
  https://www.tandfonline.com/doi/abs/10.1080/00218499.1993.12466882
- Commercial ASL today ≈ 2–4 s. https://www.filmmakersacademy.com/glossary/average-shot-length-asl/
- Readability: ~0.3 s per word minimum on screen; ≥1.5 s gap between captions; two lines max; a
  line ≤68% of a 16:9 frame; keep text inside the central 90% vertically / 75% horizontally;
  160–180 wpm reading speed. https://www.clevercast.com/bbc-subtitling-guidelines/ ·
  https://subhero.io/blog/subtitle-standards-guide (min ~22 px at 1080p)
- Tempo: product demo 100–115 BPM; social spots 120–140; e-learning 60–80; "establishes mood within
  the first 2 seconds" (https://www.foximusic.com/blog/video-production-styles-music-guide/);
  energetic = 120–150, lower end for education, and "lower the track under speech… protect clarity
  first" (https://lesfm.net/blog/energetic-background-music/); "cut every 2–4 beats for dynamic
  content, or every 8+ beats for slower, cinematic pacing"
  (https://fastbizkit.com/blog/music-production-tempo-guide-en).
- Mix: music 15–20 dB under the voice, or VO peaking −6 dB with music from −20 dB; carve 2–4 kHz out
  of the bed. https://protunesone.com/blog/top-tips-for-balancing-voiceovers-with-background-music-in-videos/ ·
  https://omegafilminstitute.com/voice-over-mixing/
- End screens: YouTube's window is the last 5–20 s of a video; 15–20 s if people must click
  something. https://backlinko.com/hub/youtube/end-screen ·
  https://support.google.com/youtube/answer/6388789
- Mobile: UI text must be "large enough to be read on a smartphone screen".
  https://www.whatastory.agency/blog/saas-product-launch-video-strategy

---

## 2. Rhythm — shot length and how tension is built

- **R1 Max shot length in VIDEO beats: 3.0 s teaser / 3.5 s tutorial and niche. Floor 1.5 s.**
  Target ASL 2.2–2.6 s (teaser), 2.8–3.2 s (tutorial). The rejected v2 teaser measures 13 scene
  cuts in 79.9 s (ffmpeg `scene>0.3`) — ASL ≈ 5.7 s; film 4 ≈ 5.1 s. Commercial norm is 2–4 s and
  memory needs ≥1.5 s: cut faster, never shorter than 1.5 s.
  (https://www.filmmakersacademy.com/glossary/average-shot-length-asl/ ·
  https://www.tandfonline.com/doi/abs/10.1080/00218499.1993.12466882)
- **R2 A live window is a STAGE, not a shot.** Its internal rhythm comes from the sim + the
  narrator's imperatives (§4); the max-shot rule does not apply inside it. Windows count as the
  "peaks" of the heartbeat arc; VIDEO beats are the "builds" between peaks.
  (https://www.thinkwithgoogle.com/_qs/documents/8472/ABCD_Complete_V7b_HR_1.pdf)
- **R3 Every narrated sentence gets ≥2 visual events** — a cut, a punch-in (§6) or a UI state
  change that fills ≥40% of the frame. One capture held under one sentence is banned.
  (Linear/TapVid: enough time to verify the change — but a change must happen.)
- **R4 Never clone a frame.** `assemble-film.mjs` currently pads short footage with
  `tpad=stop_mode=clone`; the v2 contact sheet shows the same kinesin frame in 9 of 18 tiles. If a
  shot is short, cut to the next shot. Freeze-frames only as a deliberate 0.5 s "hit" before a
  window opens.
- **R5 Cut on the grid.** At 120 BPM a beat is 0.5 s: montage cuts on beats 2 or 4 (1.0/2.0 s
  after the previous cut, ±60 ms); a held UI shot ends by beat 8 (4.0 s) at the latest — that is
  the 3.5 s ceiling in practice. (https://fastbizkit.com/blog/music-production-tempo-guide-en)
- **R6 First five seconds: ≥3 shots or shot-equivalents** (ABCD says 2+; we owe the viewer a
  turn). The teaser's beat 1 ("dead-ordinary frame… calm… a trap") is allowed exactly 2.5 s of
  calm, and the calm must contain motion: play-bar ticking, the sim animating, a cursor entering.
  (https://www.thinkwithgoogle.com/_qs/documents/8472/ABCD_Complete_V7b_HR_1.pdf)
- **R7 Tension is built by withholding the hand, not by adding shots.** Pattern per window: 2 s of
  the sim moving on its own → the chip → the hand. The Arc/Linear teasers withhold the hero UI
  until halfway; we withhold the TOUCH by ~2 s each time, never longer.
  (https://advids.co/blog/saas-launch-teaser)
- **R8 Montage beat (teaser beat 8): five real shots at exactly 1.8 s = 9.0 s**, every shot a
  gesture-then-result pair (drop→sorted, drag→section, type→prompt, flip-flip→hit, click→sheet).
  Apple's Camera Control spot is four such pairs in 30 s.
  (https://www.phonearena.com/news/new-iphone-ad-focuses-on-the-best-new-iphone-16-feature_id163412)

## 3. The hook — what happens by second three (all five films)

- **H1 Frame 0.0 is already moving.** Zero-second cold open on the product with a gesture in
  progress (Vercel/Framer pattern), never a logo, never a title card, never a still. The v2 cut
  opened on "Flow Video." on white for ~3 s — the front-loaded-branding open that Meta's guidance
  says loses completion. (https://advids.co/blog/saas-product-launch-videos ·
  https://adlibrary.com/posts/meta-ad-creative-best-practices)
- **H2 ≤1.0 s: first cut or punch-in.** (ABCD "two or more shots in the first five seconds".)
- **H3 1.0–2.5 s: the spoken claim, ≤6 words**, e.g. "This looks like a video." The super, if any,
  is the same words or none — never a second sentence.
- **H4 3.0 s: the TURN — the frame does something a video cannot do.** The sim responds to the
  cursor; the chip pulses on the control. Duolingo's 5 s spot puts its surprise at ~2.5 s; ours
  lands at 3.0 s and the window opens at 4.0 s (Film 1). (https://www.figma.com/blog/the-anatomy-of-duolingos-super-bowl-ad/)
- **H5 ≤4.0 s: the product is visibly the product** (the player chrome, a real URL bar-less public
  page) — "introduce your product or brand in the first five seconds". The SPOKEN brand waits
  until beat 3 (memory device after proof device — Descript rule).
  (https://www.thinkwithgoogle.com/_qs/documents/8472/ABCD_Complete_V7b_HR_1.pdf ·
  https://tapvid.ai/blog/product-launch-video-examples)
- **H6 Per film, the first 3 s are:**
  - F1 teaser — 0.0 the public page playing, cursor drifting toward the sim (motion); 0.8 punch-in
    2.0× on the play bar ticking; 1.5 VO "This looks like a video."; 2.6 the walking cycle stutters
    under the cursor; 3.0 chip pulses "Drag the motor"; 4.0 WINDOW.
  - F2 tutorial — 0.0 a hand already dropping a zip onto Library (time-lapse feel, Arc rule); 1.0
    the Library sorts itself; 2.0 the `SIM` package card lands; VO "Remember the solar system?
    You're about to build it."
  - F3 drop-in — 0.0 the zip already sliding out of a Finder folder toward the Library (not the
    static folder); 1.2 cut to the drop highlight; 2.4 the package card. "Trapped in a folder" is
    said over the motion, not over a still.
  - F4 powers — 0.0 the public page, cursor approaching the sim section; 1.0 punch-in on the
    section marker on the progress bar; 2.2 cut back wide as the count starts; 6.0 WINDOW.
  - F5 doors — 0.0 the cursor already pressing **Create link**; 0.9 the sheet slides in; 2.0
    punch-in on the first row. "It's built. It's gorgeous. Ship it." sits on those three cuts.

## 4. Live windows — framing the invitation (the layer, and the product changes it needs)

The mechanism (verified): a window is the product's own mid-roll section — the real sim mounts on
top of the film, the film's video + narration keep playing underneath, and it auto-returns
(`seeding/layout-v3.json`; SCRIPT-1 "THE GRAMMAR"). What the player draws today is NOT an
invitation: the section label is a 12 px `text-xs` chip top-left, suppressed while the sim overlay
shows (`client-web/components/VideoPlayer.tsx:962`); the sim badge is a 12 px amber chip
bottom-right (`:968`); the exit control reads "Go back to video" (`viewer/HLSPlayerShell.tsx:666`);
the guidance caption is 17 px (`viewer/viewer.css:550`). Rules W1–W12 therefore bind the film AND
a small product feature — a **window-invitation layer** — which is required for v3.

- **W1 Count and length.** F1: three windows of **8 / 8 / 7 s** (not 11 / 11 / 7): live time ≤40%
  of runtime, a window every ~20 s. F2: one 12 s window. F3/F4: one 12 s window. F5: none.
  Bandersnatch spaces decisions "long enough not to intrude, short enough the mechanic isn't
  forgotten"; at 58 s that cadence is three. Retime `layout-v3.json` and the scripts' WINDOW MAP
  together (§9). (https://uxdesign.cc/how-did-the-ux-design-team-prepare-us-for-the-new-black-mirror-bandersnatch-interactive-film-aa3373145e79)
- **W2 The invitation is TEXT on ONE TARGET.** A chip with an imperative verb + object, ≤3 words
  ("Drag the motor" · "Tap Mars" · "Hit Scatter" · "Launch a planet"), anchored within 24 px of the
  control it names — never in a corner. One pulsing ring on that control (two pulses of 1.2 s,
  then still — an endless pulse is wallpaper). Nothing else on screen animates. Words, because
  Netflix's non-verbal cue design tested as "baffling"; the label ON the icon because that is how
  Genially and H5P mark clickability. (https://genially.com/features/interactions-and-animations/ ·
  https://h5p.org/tutorial-interactive-video?page=5)
- **W3 Size and contrast at 1080p.** Chip type 40–44 px semibold, chip contrast ≥7:1 on the sim
  (solid ink chip, not translucent), ring 96–128 px, 3 px stroke in the brand accent. Vimeo's rule
  is "short labels and strong contrast… plenty of time to notice"; a 12 px chip is a file name.
  (https://vimeo.com/blog/post/how-to-make-interactive-video)
- **W4 Timing.** Sim visibly moving at t+0.0 (it must already be alive when the hand arrives —
  Ciechanowski's demos animate before you touch); chip + ring at t+0.3 s; hold ≥2.5 s; fade on
  first pointer-down (the viewer took the invitation — get out of the way: "the reader simply
  nudges"). If no touch by t+3.0 s, the auto-script performs the gesture ONCE with a ghost cursor
  and the chip re-pulses once, then the window runs its auto-tour to the return. Never nag twice.
  (https://ciechanow.ski/mechanical-watch/ · http://worrydream.com/ExplorableExplanations/)
- **W5 The countdown bar.** A 3 px line along the window's top edge shrinking to the auto-return —
  the Bandersnatch promise that the film comes back — no numerals, no "returning in…". It doubles
  as the only motion allowed after the ring stops.
- **W6 Exit language.** In a scripted mid-roll window there is no "Go back to video" button (that
  verb is a retreat); the return is automatic and the bar says so. The optional early exit reads
  **"Keep watching →"**, 14 px, top-right, only after the first touch.
- **W7 One text element at a time.** Inside a window the film's narration is the guidance; the
  product's `.guidance-caption` and any film super stay OFF. Corollary (verified in code): a sim
  guidance track ducks the film's audio to 20% (`useProjectPlayer.ts:883`, `:1426`) — windows in
  films ship with sim guidance audio DISABLED so the narrator is never ducked by the sim.
- **W8 Simple UI is mandatory: ≤2 controls + 1 button per window**, and the chip names the FIRST
  control only (kinesin: scrub → orbit; solar: tap-a-planet → time speed; murmuration: pointer
  steer → Scatter; orbit lab: drag-to-launch → vectors). Two or three choices per scene is the
  interactive-video ceiling. (https://vimeo.com/blog/post/how-to-make-interactive-video)
- **W9 No device frame, no border, no "preview" label around a window.** Full-bleed on top of the
  film with the product's own 250 ms video→sim crossfade; the film underneath is heard, not seen.
  The reference films remove native borders 85% of the time (advids 7-sample) — a framed window
  reads as a picture of a sim, and the whole point is that it isn't.
  (https://advids.co/blog/saas-product-launch-videos)
- **W10 Narration inside windows is the guidance register.** Second person, imperatives ≤8 words,
  ≥1.5 s of scripted air after every imperative ("Tap Mars. … I'll wait."). The narrator never
  describes what the viewer is doing — they know; each line names the NEXT thing or the
  CONSEQUENCE ("Now watch gravity fight you for it."). ≤35% of any window is narrated.
- **W11 Music at the open/close** — see M4: bed cuts on the downbeat of the open; room tone + the
  sim's own sound; 1.2 s riser into the return; bed back on beat 1 with a hit.
- **W12 The first window must be shippable everywhere.** Kinesin is cleared for the LOCAL build
  only (CGTrader). If clearance is not in hand at ship, W1 of the teaser becomes Murmuration
  (pointer-steer + Scatter is the most instantly legible touch there is) and kinesin moves to F3.
  A public teaser whose hook window fails to mount is the one failure this direction cannot survive.

## 5. Cursor choreography (VIDEO beats)

- **C1 One cursor path per shot**, entering from where the last action ended; no idle drift, no
  wander to "find" the control. If the shot is about a result (toast, generated preview), the
  cursor is hidden — "if the cursor doesn't add value… hidden". (https://screen.studio/)
- **C2 Motion is eased, never linear, never teleported.** Cross-screen travel 350–600 ms,
  local travel 180–250 ms, ease-in-out; Playwright moves get ≥24 interpolation steps. Six of the
  seven reference teasers use "highly engineered, artificially smoothed cursor kinematics"; Notion's
  "teleporting cursor" is the counter-example. (https://advids.co/blog/saas-launch-teaser)
- **C3 Intent → click → result.** Pause 200–300 ms on the target before the click; 120 ms press
  state; hold ≥400 ms on the result before the cursor moves again (the ≥1.5 s memory floor applies
  to what the click produced).
- **C4 Cursor at 1.5× system size with a single 40 px click ring (300 ms, brand accent).** No
  trails, no sparkles, one ring per click. Screen Studio swaps in "high-resolution versions if you
  increase cursor size" — our captures record at 2× so the enlarged cursor stays crisp.
  (https://screen.studio/)
- **C5 Drags are beats — never cut mid-drag.** The V1 section drag and the Orbit Lab launch vector
  are the film's most physical moments; show the whole gesture, then cut on release.
- **C6 Type-along at ~12 chars/s in sync with the narration** (tutorial beat 7, F3 beat 3); the
  caret is that shot's cursor; the pointer is hidden while typing.
- **C7 Touch is a real finger, only in the phone beats** (Smart Crop, F5 beat 6): fingertip on a
  real vertical render, never a cursor skinned as a hand. "Open with people on screen" — the hand
  is the person in a film with no faces.
  (https://www.thinkwithgoogle.com/_qs/documents/8472/ABCD_Complete_V7b_HR_1.pdf)

## 6. Zoom and punch-in rules for UI captures

- **Z1 Two shot sizes only:** ESTABLISH (100%, ≤2.0 s, at most two per film — one at the start of a
  build, one as the meta zoom-out) and PUNCH (1.6–2.2× centred on the control). Four of seven
  reference films use "rapid ease-in micro-zooms for feature isolation"; Screen Studio zooms
  toward the click and pans with the drag. (https://advids.co/blog/saas-product-launch-videos ·
  https://www.datastudios.org/post/screen-studio-auto-zoom-mechanism-mac-only-limits-and-pricing-explained)
- **Z2 Punch in, cut out.** Ease-out cubic, 350–450 ms in; hold ≥1.5 s; never animate back out
  (zoom-out reads as retreat) — cut to the next shot, or ZOOM THROUGH into the next module when
  the next shot lives inside the current one (Notion). (https://advids.co/blog/saas-launch-teaser)
- **Z3 De-chrome.** No browser/OS chrome ever; the editor's own frame is the only frame. Panels
  that don't matter to the sentence get a 35% dim OR a 4 px blur (Linear's depth-of-field), never
  both; the panel that matters gets the light (Framer's spotlight at 100% fidelity).
  (https://advids.co/blog/saas-launch-teaser)
- **Z4 Legibility floor after the punch: smallest UI label ≥22 px at 1080p** (≈8 px at 360p, the
  phone case). If the control's label is smaller than that at 2.2×, don't show the label — show
  the gesture. (https://subhero.io/blog/subtitle-standards-guide ·
  https://www.whatastory.agency/blog/saas-product-launch-video-strategy)
- **Z5 No letterbox, ever.** The assembler's `mode: fit` pads with `0x0b0f17` bars; use crop-to-
  cover or reshoot at frame. A padded capture is the "picture of a screen" look the references
  spend effort removing.
- **Z6 Black and white frames are defects.** The v2 sheets contain a "Preparing video…" black
  editor frame and blank white frames; any frame with <5% luminance variance is a failed shot and
  blocks assembly.

## 7. Typography at 1080p and motion-graphics restraint

- **T1 One display family** (the overlay's Bricolage Grotesque, OFL) plus the product's own UI
  type; nothing else on screen, ever.
- **T2 Sizes (1080p):** hook/end-card statement 120–150 px (the existing 150 px lockup is right;
  the 84 px chroma end line is under-sized — raise to 112–120); window chip 40–44 px semibold;
  caption/feature chip 44–48 px semibold; button label 32 px; qualifier line 28 px minimum. The
  current 25 px `.co-chip` and 31 px `.chip` are ~8–10 px on a phone — retire them. ABCD:
  "large-type supers" for mobile.
  (https://www.thinkwithgoogle.com/_qs/documents/8472/ABCD_Complete_V7b_HR_1.pdf)
- **T3 ≤3 words per super; ≤1 text element on screen at a time** (the player chrome excepted).
  A super holds ≥1.2 s (0.3 s/word + read-in) and the next one waits ≥1.5 s.
  (https://www.clevercast.com/bbc-subtitling-guidelines/)
- **T4 Safe area:** central 90% vertical, 75% horizontal; nothing in the bottom 140 px (the
  player's control bar and the guidance-caption zone at `bottom:108px`); the end-card ▼ sits above
  that line. (https://www.clevercast.com/bbc-subtitling-guidelines/)
- **T5 Type moves once:** a 12 px rise + fade, 250 ms, on the beat. No bounce, no elastic, no
  per-letter kinetic — Figma's 15 fps handmade texture is THEIR brand choice; ours is restraint:
  kinetic means timing, not wiggling. The only reveal animation is the end-card lockup mask.
  (https://www.figma.com/blog/how-we-shaped-the-visual-identity-for-config-2025/)
- **T6 Sentence case; feature names exactly as the UI prints them** ("Generate mini model",
  "Simple UI", "Follow user decisions") — Linear's changelog discipline; a film that renames a
  control teaches the wrong word. (https://linear.app/changelog/2025-08-14-product-intelligence-technology-preview)
- **T7 Infographic layer budget per film:** hook super (optional) · window chips (product layer) ·
  ≤2 caption chips · end card. Anything else is cut. Figma's launch reel proves a 90 s film needs
  no VO and almost no type when the UI is the story. (https://blarevideo.com/feeds/blog/saas-product-launch-video)

## 8. Music, sound and where the narration sits

- **M1 BPM per film:** F1 **120** (grid = 0.5 s; cuts on 1.0/2.0 s) — the current `bed-teaser`
  is 100 BPM and the v3 script asks ~112: re-render at 120. F2 **100** (currently 92). F3/F4 **108**,
  F5 **96**. Product demos live at 100–115, spots at 120–140, education at the low end of
  "energetic" for "momentum without pressure". (https://www.foximusic.com/blog/video-production-styles-music-guide/ ·
  https://lesfm.net/blog/energetic-background-music/)
- **M2 The bed needs a pulse you can cut to.** A tick/kick on every beat and a hit on the 1 of
  every fourth bar; still no melody (VO clarity). The current beds are pads with a "barely-there
  pulse" — nothing lands, so no cut can land. (https://fastbizkit.com/blog/music-production-tempo-guide-en)
- **M3 Levels.** Bed at −27 LUFS integrated (not −32 — 13 dB under the VO is inside the guidance
  window but reads as absence), side-chain ducked a further 6 dB while the narrator speaks
  (attack 80 ms, release 400 ms — real ducking, not a fixed offset: "pull it down more when the
  voice is dense"); −3 dB at 2–4 kHz in the bed; VO to −19 LUFS, true peak −1.5.
  (https://lesfm.net/blog/energetic-background-music/ · https://omegafilminstitute.com/voice-over-mixing/)
- **M4 Windows.** Bed CUTS on the downbeat of the open (already the v3 rule — keep it); underneath:
  room tone at −45 LUFS plus the sim's own sound; **1.2 s riser** (noise sweep + pitch rise) into
  the return; return = bed re-enters on beat 1 with the hit. The riser and hit are two new stems
  `music/` does not yet have. Mood must be set "within the first 2 seconds" — the bed starts on
  frame 0 at full level, no fade-in. (https://www.foximusic.com/blog/video-production-styles-music-guide/)
- **M5 One sound, three jobs.** Author a single 300 ms hit and use it for window-open, "Generate"
  and the end-card landing; if the product acquires a UI sound, that sound replaces it. Duolingo
  blended the app's correct-answer chime into the ad's only sound effect — the product's sound is
  the sonic brand. (https://www.figma.com/blog/the-anatomy-of-duolingos-super-bowl-ad/)
- **N1 Narration:** 150–165 wpm in bursts; ≤6 words before the first cut; scripted air ≥1.5 s after
  every imperative; the narrator YIELDS for the ask exchange (F4 beat 5); "Flow Video" spoken 3×
  with the last word of the film (kept from v2/v3).
- **N2 The narrator never captions the picture.** Each line is a claim, a command, or a
  consequence. "That cursor? A viewer" (v2) is a caption; "Go on — touch it" (v3) is a command.
  Keep the v3 register; strike any line that starts "This is…" except the hook.
- **N3 Sound-off pass.** Every film must read with the audio muted: gestures, chips and the end
  card carry the argument (80% of B2B video is claimed to be watched on mute; whatever the true
  share, the seeded player autoplays muted in some contexts).
  (https://www.whatastory.agency/blog/saas-product-launch-video-strategy)

## 9. End-card grammar and the per-film skeletons

- **E1 Hold 6.0 s** (F1/F2), 5.0 s (F3–F5). Auto-advance is the CTA, so we don't need YouTube's
  15–20 s clickable window; we do need the ≥5 s minimum. (https://backlinko.com/hub/youtube/end-screen)
- **E2 Exactly three elements, stacked:** the LINE (≤4 words, 112–150 px), the LOCKUP, the
  POINTER (▼ or one button). No URL when the product is the page; no feature list, ever.
- **E3 Arrival order on the hit:** line at 0.0 · lockup +0.8 s · pointer +1.6 s, pulsing twice then
  steady; the spoken brand lands with the lockup (the last word of the film).
- **E4 The line is a consequence, not a slogan:** "The doors below are live." / "Change one word."
  / "Drop in anything." / "Four powers. One link." / "Ship yours." — all five v3 lines pass.
- **E5 Eyes guide to type.** The last moving thing must sit above-left of the line so the gaze
  falls onto the words; in the v2 teaser card the flock reforms BEHIND the text — move it above.
  (https://www.figma.com/blog/the-anatomy-of-duolingos-super-bowl-ad/)
- **E6 Buttons are real deep-links** (F2 "Edit this section", F3 "Add a simulation", F5 "Create
  link"), ≥64 px tall at 1080p, the product's own primary button style; specific verbs only.
  (https://www.thinkwithgoogle.com/_qs/documents/8472/ABCD_Complete_V7b_HR_1.pdf)
- **E7 Verify the auto-advance:** the ▼ is honest only if the seeded timeline moves within 2 s of
  the card ending — a QC step, not a design note.

### Skeletons (windows per W1; retime `seeding/layout-v3.json` + each script's WINDOW MAP together)

| film | runtime | windows (label → first control) | VIDEO beats / cuts | music | end card |
|---|---|---|---|---|---|
| F1 teaser | 58 s | kinesin **[4,12]** "Drag the motor" · solar **[24,32]** "Tap Mars" · murmuration **[44,51]** "Hit Scatter" | 35 s VIDEO, ≥15 cuts (ASL ≤2.4), montage 5×1.8 s | 120 BPM; cuts dead ×3; risers at 10.8 / 30.8 / 49.8 | 6 s "The doors below are live." |
| F2 tutorial | 90 s | solar **[52,64]** "Tap a planet" (beats 3+4 merge: −6 s) | 78 s VIDEO, ≥26 cuts (ASL ≤3.0); flip-flip-hit on beats 4-and-8 | 100 BPM; thins to pads during typing; cuts at 52 | 6 s "Change one word." + "Edit this section" |
| F3 drop-in | 51 s | kinesin **[32,44]** "Scrub the cycle" | 39 s VIDEO, ≥13 cuts | 108 BPM; cut at 32; riser 42.8 | 5 s "Drop in anything." + "Add a simulation" |
| F4 powers | 55 s | orbitLab **[6,18]** "Launch a planet" | 43 s VIDEO, ≥14 cuts; hit on each number; silence for the exchange | 108 BPM | 5 s "Four powers. One link." ▼ |
| F5 doors | 45 s | none (deliberate) | 45 s VIDEO, ≥15 cuts; a lift per door | 96 BPM | 5 s "Ship yours." + "Create link" |

## 10. Five "boring" anti-patterns the current cut exhibits

Evidence is the v2 assembly the owner watched (`assembly/out/film1.mp4` 79.9 s, `film2/4
.SCRATCH.mp4`, the contact sheets in `assembly/out/contact/`), plus what the v3 scripts still carry.

1. **One shot per sentence, padded with a frozen frame.** ffmpeg finds 13 cuts in the 79.9 s
   teaser (ASL ≈ 5.7 s; film 4 ≈ 5.1 s) against a 2–4 s commercial norm; the assembler holds one
   capture per narration line and clones the last frame when footage runs out (`tpad`), so the
   same kinesin still occupies 9 of 18 contact-sheet tiles. v3 keeps the structure (one ON SCREEN
   entry per beat, beats of 5–9 s). Fix: R1–R5. (https://www.filmmakersacademy.com/glossary/average-shot-length-asl/)
2. **A still, branded open.** v2 spent its first ~3 s on "Flow Video." over white, then a calm
   sim with no hand — the front-loaded branding that costs completion and the sub-two-shots-in-
   five-seconds open ABCD warns against; v3's "dead-ordinary frame… calm… a trap" still holds 4 s
   before anything turns. Fix: H1–H6. (https://adlibrary.com/posts/meta-ad-creative-best-practices ·
   https://www.thinkwithgoogle.com/_qs/documents/8472/ABCD_Complete_V7b_HR_1.pdf)
3. **Whole screens at native scale.** The editor is captured entire at 1920×1080 — 11 px panel
   text, unreadable at thumbnail size, letterboxed when the source is a different shape, black
   "Preparing video…" and blank white frames left in — with zero punch-ins, no de-chroming, no
   dim/blur. The references micro-zoom (57%), remove borders (85%) and blur what doesn't matter.
   Fix: Z1–Z6. (https://advids.co/blog/saas-product-launch-videos)
4. **Wallpaper music with nothing to cut to.** The beds are melody-less pads with a "barely-there"
   pulse at −32 LUFS and 92–104 BPM (the v3 script itself asks ~112); no riser or hit stems exist,
   so window opens/returns cannot be scored, and cuts fall wherever the VO ends rather than on a
   beat. Fix: M1–M5. (https://fastbizkit.com/blog/music-production-tempo-guide-en ·
   https://www.foximusic.com/blog/video-production-styles-music-guide/)
5. **The live window is never announced on screen.** The narrator says "Go on — touch it", but the
   player's only chrome is a 12 px label chip (hidden during the sim overlay), a 12 px amber badge,
   and a "Go back to video" button — no verb on the control, no pulse, no countdown, no target.
   Genially auto-pulses hotspots; H5P labels the icon; Netflix learned that wordless cues baffle
   and printed the choices with a 10 s bar. Fix: W2–W6 (a product feature, not an overlay).
   (https://genially.com/features/interactions-and-animations/ ·
   https://uxdesign.cc/how-did-the-ux-design-team-prepare-us-for-the-new-black-mirror-bandersnatch-interactive-film-aa3373145e79)

Watch-outs that are not yet defects: v3's windows total 29 of 58 s (50% live — W1 trims to 40%);
the ask beat is chips-only in the teaser (fine, but the chips must be 44 px, not the player's 17 px
caption); the cursor as captured is the OS default at 1× with no click affordance (C4).

## 11. What changes in the kit (so the rules are buildable, not aspirational)

- `assembly/assemble-film.mjs`: allow several sources per scene (sub-cuts on the beat grid);
  punch-ins via `crop`+`scale` with eased keyframes (or pre-rendered zoom plates); replace the fixed
  `volume` duck with `sidechaincompress` keyed off the VO bus; add riser/hit stems at window
  edges; reject any `tpad` clone and any frame with <5% luminance variance.
- `music/synthesize.mjs`: re-render beds at 120/100/108/108/96 BPM with a beat tick, bar-4 hits,
  −27 LUFS; add `riser-1200ms.wav` and `hit-300ms.wav`; carve 2–4 kHz.
- `captures/shots/*`: cursor 1.5×, ≥24-step eased moves, 250 ms pre-click dwell, click ring;
  record at 2×; crop-to-cover framing; no OS chrome; type-along at 12 chars/s.
- `overlay/index.html`: retire `.chip`/`.co-chip` (25–31 px); statement 112–150 px; chips 44 px;
  end-card arrival order per E3; flock above the line.
- Product (small, required): a **window-invitation layer** for mid-roll sections — 40–44 px verb
  chip anchored to the first control, two-pulse ring, 3 px countdown bar, "Keep watching →" after
  first touch, `sectionLabel`/badge suppressed while it shows; sim guidance audio off for windows
  used in films.

## 12. Acceptance checklist (measured at assembly, per film)

- [ ] `ffmpeg select='gt(scene,0.3)'` cut count ≥ (VIDEO seconds ÷ 3); no VIDEO shot > 3.0 s (F1)
      / 3.5 s (F2–F5); none < 1.5 s.
- [ ] ≥3 visual events before 5.0 s; motion in frame 0; no logo/title before the first window.
- [ ] Every cut within ±60 ms of a beat at the film's BPM; bed on from frame 0; cuts dead at each
      window open; riser present 1.2 s before each return.
- [ ] No `tpad` clone, no letterbox bars, no frame with <5% luminance variance.
- [ ] Window chip visible in a 360p contact sheet; chip appears ≤0.3 s after the sim is moving;
      fades on first pointer-down; countdown bar present; no "Go back to video" during windows.
- [ ] Smallest UI label after a punch-in ≥22 px at 1080p; ≤1 text element on screen at a time.
- [ ] Bed −27 LUFS, ducked −6 dB under VO; VO −19 LUFS / TP −1.5; sim guidance audio off.
- [ ] End card ≥5 s (6 s for F1/F2), three elements, brand spoken last, auto-advance within 2 s.
- [ ] Sound-off pass: the argument survives muted.
- [ ] Every claim on screen is captured product (honesty rules in the scripts remain in force).
