# Film 2 — TUTORIAL · "Make Yours" · v3 (owner reset) · target ~1:23 · American English

v3 after the owner rejected v2: faster, rhythmic, zero lecture. Its OWN project now (not the
teaser's timeline). Five build beats, one live proof, one CTA — nothing else. The demo's thesis
for creators, on camera with rhythm: **the sims have buttons; in Generate mini model you WRITE
what to change, FLIP Simple UI + Auto Script, hit Generate — and the LIVE window proves it.**
(Product rename applied: the section card formerly "This moment" is now **Generate mini model**,
no star on the card title; "1 · Describe it", both toggles, and **✦ Generate with AI** unchanged.)

THE GRAMMAR: sims never appear as footage — the built sim appears ONCE, as a mid-roll LIVE
WINDOW (real interactive sim on top, film + narration continue under, auto-return). VIDEO beats
are narration + fast REAL UI captures.

WINDOW MAP: solarSystem [51,63] → sync layout-v3.json (tutorial.windows).

Voice: same narrator as the teaser, a half-notch calmer but still moving — a friend who's done
this a hundred times. ~150 wpm bursts; "…" and " — " are performed pauses. ~174 words → ~70s
spoken inside 83s.
Music: warm confident groove (~96 BPM, original bed) under the build; thins to pads while the
prompt is typed (beat 6); CUTS at the window open; riser on return; soft hit on "Generate."

| # | t | KIND | NARRATION (verbatim TTS input) | ON SCREEN |
|---|---|---|---|---|
| 1 | 0:00–0:06 | VIDEO | Remember the solar system? You're about to build it — start to share. No code. Watch. | Cold open on the editor, timeline empty and waiting. Anchor: `/projects/[id]/editor`. (Line lands whether or not they touched the teaser's window.) |
| 2 | 0:06–0:13 | VIDEO | New project… and drop everything in at once — footage, images, audio, and a whole simulation, as one zip. | One multi-file drag onto **Library**; overlay "Drop to add to the Library · Videos · simulation .zip · images · audio — sorted automatically". |
| 3 | 0:13–0:19 | VIDEO | It sorts itself. That zip? Someone's folder — or one already in your Library. No code. | Toast "Added …"; Library populates; the simulation package card lands last, distinct. It STAYS in the Library — a sim is never dragged onto a track; it gets attached in the section editor (beat 5). |
| 4 | 0:19–0:27 | VIDEO | Find the moment your video should come alive… and drag across it. That's a section. | Timeline: cursor DRAGS across **V1** over the clip → section block appears (badge `SIM`) → **Edit Section** opens. |
| 5 | 0:27–0:35 | VIDEO | Pick Simulation. Choose your package. Then, in plain words — what's this moment for? | **Edit Section** → type **Simulation** → dropdown picks the **Solar System** package → the **Generate mini model** card fills frame; cursor lands in **1 · Describe it**. |
| 6 | 0:35–0:43 | VIDEO | Give viewers the planets — let them speed up time and fly to any world. | The prompt TYPED IN SYNC with the narration, VERBATIM the seeded section's stored prompt (= layout-v3 tutorial prompt), typed exactly: "Give viewers the planets — let them speed up time and fly to any world" — no trailing period (capture rule: word-for-word, so beat 11's claim stays literally true). Typing breathes; music thins. |
| 7 | 0:43–0:51 | VIDEO | Two switches. Simple UI — only your buttons. Auto Script — it performs for the ones who only watch. …Generate. | **Simple UI** ("Hides irrelevant controls") flipped ON — click. **Auto Script** ("Animates demonstration") flipped ON — click. Punch pause… **✦ Generate with AI**. Generation runs. The flip-flip-hit is the film's drum fill. |
| 8 | 0:51–0:57 | LIVE-WINDOW solarSystem | Done. …That's not a preview. Tap a planet. | WINDOW OPENS t=51 (label chip "Tap a planet"): the EXACT sim just generated mounts on top of the film, minimal UI. Music out; room tone; the viewer's hand takes over. |
| 9 | 0:57–1:03 | LIVE-WINDOW solarSystem (cont.) | Now speed up time. Your viewers get exactly this — nothing in their way. | Fly-to on tap; time-speed slider; only the chosen buttons exist. AUTO-RETURN t=63 — riser, back to the film. |
| 10 | 1:03–1:10 | VIDEO | Hit Create link. That one link is the whole thing — the video, an audio edition, your library. | **Create link** → **Share this video** sheet → the three rows: Video `/slug` · Podcast `/slug/audio` (**Create podcast**) · Library `/slug/library`; cursor taps each as named. |
| 11 | 1:10–1:17 | VIDEO | This project? Already yours. The solar system below sits on your timeline right now. | Zoom out, meta shot: THIS project's own editor timeline — the film block + the Solar System section block, pulsing. |
| 12 | 1:17–1:23 | VIDEO | Change one word of the prompt. Hit Generate… and watch it obey. — Flow Video. | End card: **"Change one word."** Primary button **"Edit this section"** (deep-link to the Solar System section's Generate mini model card); secondary, small: "New project". |

Beat discipline: 12 beats, none over 8s. Five build beats (create → drop → mark → describe+flip+
generate → share) + one live proof + one CTA. The thesis beat (5–7) is write → flip → flip → hit.

HONESTY RULES (non-negotiable): never claim AI generates the video/script at project creation
(it doesn't); never claim sims are generated from a prompt (they're uploaded packages — the AI
writes the bridge and the mini model around YOUR files); never promise interactive sims inside an
exported MP4 (they export as stills — interactivity lives at the shared link); the S6 prompt is
VERBATIM the seeded section's stored prompt; the CTA names only actions verified in the seeded
clone (prompt edit → Generate, sim swap); the only drag on the timeline is the one that MARKS a
section (beat 4) — simulations are added to the Library and attached from the section editor's
package selector, never dragged onto a track (verified 2026-09-05). Collaborators/Access belong
to film 5 (and live in Video settings, not the share sheet); film 4 owns the viewer powers.
