# Film 4 — NICHE · "Viewer Superpowers" · v3 (owner reset) · target ~57s · American English

v3 after the owner rejected v2: powers are SHOWN, not narrated — the first power is a LIVE
WINDOW the viewer uses while the film keeps talking; the rest are fast REAL UI. This is the film
that convinces a creator the interactivity is worth building.

THE GRAMMAR: sims never appear as footage — power one is a mid-roll LIVE WINDOW (real Orbit Lab
on top, film + narration underneath, auto-return). Everything else: REAL viewer-surface captures.

WINDOW MAP: orbitLab [3,15] → sync layout-v3.json (niche key "powers").

Voice: same narrator — count-along cadence, a hit on each number. ~150 wpm bursts; "…" and
" — " are performed pauses; ∅ = narrator fully silent. ~80 words → ~32s spoken inside 57s
(includes the 6s clean exchange).
Music: pulse with a percussive hit ON each power number ("One:", "Two:", "Three:", "Four:");
DEAD SILENT during the ∅ exchange (beat 5) and inside the window after the first hit; resolves
under the close.

| # | t | KIND | NARRATION (verbatim TTS input; ∅ = silent) | ON SCREEN |
|---|---|---|---|---|
| 1 | 0:00–0:03 | VIDEO | Inside your video, your viewers get four powers. | A shared video playing on the public page (`/slug`), clean and ordinary — for three seconds. |
| 2 | 0:03–0:09 | LIVE-WINDOW orbitLab | One: touch. Grab empty space… drag… let go. — Watch gravity fight for it. | WINDOW OPENS t=3 (label chip "Drag to launch"): REAL Orbit Lab on top — the drag IS the velocity vector; release launches. Music down to the pulse. |
| 3 | 0:09–0:15 | LIVE-WINDOW orbitLab (cont.) | Miss? Throw another. | Force vectors bend the path, trails glow; a second launch if they're hooked. AUTO-RETURN t=15. |
| 4 | 0:15–0:19 | VIDEO | Two: ask. Out loud — mid-video. Listen. | **Ask!** on the public page opens the live avatar video call over the running video: the avatar appears, the viewer's mic goes live, call controls visible (mute / interrupt / leave). VOICE ONLY — no text box, no chips, no typed question anywhere in frame. |
| 5 | 0:19–0:25 | VIDEO | ∅ | REAL spoken exchange, clean audio, narrator silent: the viewer ASKS ALOUD into the live call — "Why doesn't the moon crash into the earth?" — and the avatar ANSWERS ALOUD, on camera, lips moving, while the video keeps playing. Nothing is typed and nothing is captioned in this beat. Cut on the natural answer start — no faked latency. AUDIO PENDING the ElevenLabs key (owner action); scratch VO never ships. |
| 6 | 0:25–0:28 | VIDEO | From this lesson. Not the internet. | The avatar is still speaking the answer aloud; the viewer lets it run, then leaves the call and the video plays on. No chips, no transcript. (Verified: no creator-facing questions list exists in v0.7.0 — scene stays viewer-side only.) |
| 7 | 0:28–0:35 | VIDEO | Three: choose. The story pauses… your viewer picks the road. The video follows. | **Follow user decisions** in the real viewer: Cards overlay → pick → the timeline visibly jumps down that path. |
| 8 | 0:35–0:41 | VIDEO | Four: anywhere. Phones stay vertical — the frame chases your speaker. | Smart-Crop vertical in a phone frame — a REAL vertical render, crop window tracking the speaker; our overlay label "Smart Crop" (infographic layer — not a product chip). |
| 9 | 0:41–0:46 | VIDEO | And captions ride along — every word, every screen. | Viewer **CC** toggle ON — captions render over the playing video, then the same captions on the phone frame. NO Audio-language menu: it renders only for a project that has dubs, and this one has none — never stage it. |
| 10 | 0:46–0:52 | VIDEO | Touch. Ask. Choose. Their way. Give your viewers powers — they'll give you attention. | Kinetic type over the ordinary playing public page: the four words hit in sequence with the music (infographic layer, minimal). NO sim recap tiles — the sim appeared once, as the live window. |
| 11 | 0:52–0:57 | VIDEO | That's a Flow Video. | End card: **"Four powers. One link."** + down-playlist pointer: "Next: One Link, Three Doors" ▼ |

Beat discipline: 11 beats, none over 7s; a number-hit every ~6–7s keeps the count driving.

Capture-contingency:
- Beats 4–6 are the avatar video call on the public page (`/slug`, **Ask!**) — the plan of record.
  If no ANAM key is on the capture stack, the fallback is the audio edition's tap-to-ask
  (`/slug/audio`), captured as the listen-anywhere edition and framed as such. BOTH are voice;
  the narration above is true either way. Neither may be staged with typing or chips.
- Beat 5's exchange audio records only after the real ElevenLabs key lands.

HONESTY RULES (non-negotiable): the ask surface is VOICE ONLY — a live avatar call with mute /
interrupt / leave; there is no text box, no suggested chips and no streamed text answer, so no
beat may show one (verified against the product 2026-09-05); the answer is grounded in this
lesson — never demo a general-web answer; no creator-facing questions-inbox claim (the UI doesn't
exist); NO language/dubbing claim in this film — the Audio-language menu is gated on the project
having dubs and the demo has none, so captions (CC) are the only "watch it your way" claim left;
Smart Crop vertical is a real render. Sims appear only as the live window — zero sim footage.
