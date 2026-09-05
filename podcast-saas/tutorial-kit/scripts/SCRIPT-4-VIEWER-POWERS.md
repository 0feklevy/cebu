# Film 4 — NICHE · "Viewer Superpowers" · v3 (owner reset) · target ~57s · American English

v3 after the owner rejected v2: powers are SHOWN, not narrated — the first power is a LIVE
WINDOW the viewer uses while the film keeps talking; the rest are fast REAL UI. This is the film
that convinces a creator the interactivity is worth building.

THE GRAMMAR: sims never appear as footage — power one is a mid-roll LIVE WINDOW (real Orbit Lab
on top, film + narration underneath, auto-return). Everything else: REAL viewer-surface captures.

WINDOW MAP: orbitLab [6,18] → sync layout-v3.json (niche key "powers").

Voice: same narrator — count-along cadence, a hit on each number. ~150 wpm bursts; "…" and
" — " are performed pauses; ∅ = narrator fully silent. 100 words → ~40s spoken inside 57s
(includes the 6s clean exchange).
Music: pulse with a percussive hit ON each power number ("One:", "Two:", "Three:", "Four:");
DEAD SILENT during the ∅ exchange (beat 5) and inside the window after the first hit; resolves
under the close.

| # | t | KIND | NARRATION (verbatim TTS input; ∅ = silent) | ON SCREEN |
|---|---|---|---|---|
| 1 | 0:00–0:06 | VIDEO | Inside your video, your viewers get four powers. …Count along. | A shared video playing on the public page (`/slug`), clean and ordinary — for four more seconds. |
| 2 | 0:06–0:12 | LIVE-WINDOW orbitLab | One: touch. Grab space — drag… and let go. You just launched a planet. | WINDOW OPENS t=6 (label chip "Launch a planet"): REAL Orbit Lab on top — the drag IS the velocity vector; release launches. Music down to the pulse. |
| 3 | 0:12–0:18 | LIVE-WINDOW orbitLab (cont.) | Now watch gravity fight you for it. Every simulation section is this alive. | Force vectors bend the path, trails glow; a second launch if they're hooked. AUTO-RETURN t=18. |
| 4 | 0:18–0:22 | VIDEO | Two: ask. Out loud — mid-video. Listen. | The viewer opens the ask surface; mic waveform pulses. Staging per capture ruling: ANAM avatar plan-of-record / podcast Tap-to-ask fallback, framed honestly. |
| 5 | 0:22–0:28 | VIDEO | ∅ | REAL exchange, clean audio: "Why doesn't the moon crash into the earth?" → grounded spoken answer begins; caption chips render. Cut on the natural answer start — no faked latency. AUDIO PENDING the ElevenLabs key (owner action); scratch VO never ships. |
| 6 | 0:28–0:31 | VIDEO | From this lesson. Not the internet. | Answer chips settle over the running video. (Verified: no creator-facing questions list exists in v0.7.0 — scene stays viewer-side only.) |
| 7 | 0:31–0:38 | VIDEO | Three: choose. The story pauses… your viewer picks the road. The video follows. | **Follow user decisions** in the real viewer: Cards overlay → pick → the timeline visibly jumps down that path. |
| 8 | 0:38–0:44 | VIDEO | Four: their way. Phones stay vertical — the frame chases your speaker. | Smart-Crop vertical in a phone frame — a REAL vertical render, crop window tracking the speaker; caption chip "Smart Crop". |
| 9 | 0:44–0:49 | VIDEO | Another language? Same video, dubbed. And captions ride along everywhere. | Viewer gear → **Audio language**: Original / Español — two dubbed words play; CC toggle on, captions render. |
| 10 | 0:49–0:54 | VIDEO | Touch. Ask. Choose. Their way. Give your viewers powers — they'll give you attention. | Four-up grid of the four REAL captures (infographic layer, minimal). |
| 11 | 0:54–0:57 | VIDEO | That's a Flow Video. | End card: **"Four powers. One link."** + down-playlist pointer: "Next: One Link, Three Doors" ▼ |

Beat discipline: 11 beats, none over 7s; a number-hit every ~6–7s keeps the count driving.

Capture-contingency:
- Beat 4–5 staging ruled at capture time (ANAM key available → avatar conversation; else the
  podcast surface's Tap-to-ask, captured as the listen-anywhere edition, explicitly framed).
  The narration wording above is true in BOTH stagings.
- Beat 5's exchange audio records only after the real ElevenLabs key lands.

HONESTY RULES (non-negotiable): dub is Spanish-only on the capture project (spend recorded);
narration says "dubbed", never "same voice" (drop the claim unless the actual dub output is
verified to match); the ask answer is grounded in this lesson — never demo a general-web answer;
no creator-facing questions-inbox claim (the UI doesn't exist). Sims appear only as the live
window — zero sim footage.
