# Film 4 — NICHE · "Viewer Superpowers" · v2 (G2 panel fixes + Orbit Lab) · target ~72s · American English
The viewer-side deep dive: everything a Flow Video lets the AUDIENCE do. This is the film that
sells the differentiator to a creator deciding whether interactivity is worth it.

| # | t | NARRATION (verbatim TTS input; ∅ = narrator silent) | ON SCREEN (capture spec + UI anchors) |
|---|---|---|---|
| 1 | 0:00–0:07 | Your viewers have powers here. Four of them. Count along. | A shared video playing on the public page (`/slug`), clean. |
| 2 | 0:07–0:17 | One: touch. Any simulation section is live. Launch a planet — watch the forces pull it into orbit. | Fingertip + cursor driving **Orbit Lab**: a drag launches a planet (the drag IS the velocity vector), gravity arrows bend the path, trails glow. |
| 3a | 0:17–0:22 | Two: ask. Out loud, mid-video. Listen. | The viewer opens the ask surface (avatar plan-of-record / podcast Tap-to-ask fallback — same ruling as Film 1 scene 3). Mic waveform pulses. |
| 3b | 0:22–0:33 | ∅ | REAL exchange, clean audio: "Why doesn't the moon crash into the earth?" → grounded spoken answer with caption chips. Cut on the natural answer start — no faked latency. |
| 3c | 0:33–0:40 | Grounded in this lesson. Not the internet. | Answer caption chips settle over the running sim. (Verified 2026-09-05: no creator-facing questions list exists in v0.7.0 — the rows are recorded but invisible; logged as a product gap. Scene stays viewer-side only.) |
| 4 | 0:40–0:50 | Three: choose. The story pauses, your viewer picks a path, and the video follows their decision. | **Follow user decisions** branch in the viewer: Cards overlay → pick → visible jump. |
| 5 | 0:50–1:02 | Four: watch it their way. Vertical on phones — the frame follows the speaker. Another language? Same video, same voice, dubbed. And captions ride along everywhere. | Smart-Crop vertical on a phone frame (real render) → viewer gear → **Audio language**: Original / Español, two dubbed words → CC toggle on, captions render. |
| 6 | 1:02–1:12 | Touch, ask, choose, their way. Give your viewers powers — they'll give you their attention. That's a Flow Video. | Four-up grid of the four powers (infographic layer over real captures). End card: **"Four powers. One link."** + down-playlist pointer: "Next: One Link, Three Doors" ▼ |

Word count ≈ 118 → ~47s spoken in ~72s (airy by design).
HONESTY: dub = Spanish only on the capture project (spend recorded); "same voice" claim verified
against the actual dub output before shipping — if the vendor voice drifts, the line becomes
"same video, dubbed." Scene 3c is capture-contingent (see VERIFY note).
