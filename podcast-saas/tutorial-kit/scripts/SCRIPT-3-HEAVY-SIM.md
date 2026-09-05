# Film 3 — NICHE · "Drop In Anything" · v3 (owner reset; retitled from "The Heavy Simulation") · target ~51s · American English
(File kept as SCRIPT-3-HEAVY-SIM.md for pipeline references; the FILM is retitled.)

v3 after the owner killed the old angle: "what's the POINT? The user doesn't care about that
data — he cares what to DO in practice." So: zero tech specs, zero megabytes, zero engineering
flex. The job in one line: **you already have interactive content — here's exactly what you do
with it.** Zip → drop → write what viewers should do → flip both switches → Generate → a LIVE
window proves it. Practical. Confident. The owner's thesis beat on camera: the sim has BUTTONS,
and in **Generate mini model** you WRITE the change and FLIP Simple UI + Auto Script.
(Rename applied: the card is **Generate mini model** — "1 · Describe it", both toggles, and
**✦ Generate with AI** unchanged.)

THE GRAMMAR: the package never appears as footage — it appears ONCE, as a mid-roll LIVE WINDOW
(real sim on top, film + narration continue underneath, auto-return). VIDEO beats are narration
+ fast REAL UI captures.

WINDOW MAP: kinesin [32,44] → sync layout-v3.json (niche key "heavy").

Voice: same narrator — builder-to-builder, quick and sure. ~150 wpm bursts; "…" and " — " are
performed pauses. 98 words → ~39s spoken inside 51s.
Music: confident minimal beat (original bed); CUTS at the window open; riser on return; tag
sting under the end card.

| # | t | KIND | NARRATION (verbatim TTS input) | ON SCREEN |
|---|---|---|---|---|
| 1 | 0:00–0:06 | VIDEO | You built something interactive… and it's trapped in a folder. | Finder, one plain folder of files — somebody's real project (html, css, js, models). No size callouts, no file-count flex. It just sits there. |
| 2 | 0:06–0:12 | VIDEO | Free it. Zip it. Drop it. That's the entire import. | The zip dragged onto **Library** → whole-Library drop highlight → upload → the package card appears. Anchors: Library drop overlay; package card. |
| 3 | 0:12–0:19 | VIDEO | Mark its moment. Open Generate mini model — and tell it, plain words, what your viewers should do here. | Drag across **V1** → **Edit Section** → type **Simulation** → the package → **Generate mini model** card; typed fast in **1 · Describe it**, VERBATIM the stored prompt: "Let viewers scrub the walking cycle and switch motors". |
| 4 | 0:19–0:26 | VIDEO | Flip Simple UI — big clean buttons, only yours. Flip Auto Script — it demos itself. …Generate. | **Simple UI** ON — click. **Auto Script** ON — click. Punch pause… **✦ Generate with AI**. The full control panel collapses to the two chosen controls in the panel preview. Flip-flip-hit rhythm. |
| 5 | 0:26–0:32 | VIDEO | Second thoughts? Type them. Bigger timeline… hide that toggle. It remembers — and rewires. | A follow-up instruction typed into the SAME **Generate mini model** box → **✦ Generate with AI** → the **Last generation** card refreshes (the AI reloads the saved conversation server-side — verified). |
| 6 | 0:32–0:38 | LIVE-WINDOW kinesin | And here's what your viewers get. Go on — scrub it. | WINDOW OPENS t=32 (label chip "Your package, live"): the REAL sim mounts on top of the film, minimal UI — scrub + motor switch only. Music out. Their hand on your work. |
| 7 | 0:38–0:44 | LIVE-WINDOW kinesin (cont.) | That's your work — live, center stage, mid-video. | Scrub drags the walking cycle; motor switch flips. AUTO-RETURN t=44 — riser. |
| 8 | 0:44–0:51 | VIDEO | Whatever you've built… drop it in. Flow Video puts it on stage. | End card: **"Drop in anything."** Button: **"Add a simulation"**. |

Beat discipline: 8 beats, none over 7s. The spine is do-this: zip → drop → write → flip → flip →
generate → touch the proof.

HONESTY RULES (non-negotiable): no weight/size/performance claims anywhere — no megabytes, no
frame rates, no "no spinners" talk (the present-gating invariant still holds; it just isn't this
film's story); the S3 prompt is VERBATIM the section's stored prompt; the follow-up-instruction
claim matches the shipped conversation-memory behavior (Last generation card). KINESIN: embedded
in the LOCAL review build by owner instruction (2026-09-05); PUBLIC seeding still requires the
CGTrader license clearance (see kinesin STATUS.md).
