# Film 1 — TEASER · "Touch This Video" · v3 (owner reset) · target ~58s · American English

v3 after the owner rejected v2 wholesale: "rhythmic, gripping — not stuck and boring; don't
CAPTURE simulations, EMBED them — live, on the timeline, at the right times, as part of the ad."

THE GRAMMAR (verified in product; times below feed `seeding/layout-v3.json` and are authoritative):
mid-roll **LIVE WINDOWS** — at second X the REAL interactive sim mounts ON TOP of the film while
video + narration keep playing underneath; at second Y it auto-returns. The viewer can genuinely
touch it during the window. **Sims never appear as footage. Only as live windows.** VIDEO beats
are narration + fast REAL UI captures only.

WINDOW MAP: kinesin [2,15] · solarSystem [25,36] · murmuration [45,52] → sync layout-v3.json.

Voice: US trailer confidence with a grin — quick, warm, talking WITH your hands full. ~150 wpm
in bursts; every "…" and " — " is a performed pause (TTS gets this text verbatim; no bracketed
directions). ~112 words → ~45s spoken inside 58s.
Music: driving modern-trailer pulse (~112 BPM, original bed), ducked under VO — and it CUTS DEAD
the instant a window opens (room tone; the sim carries the moment), riser into each auto-return,
final hit lands with "Flow Video."

| # | t | KIND | NARRATION (verbatim TTS input; ∅ = silent) | ON SCREEN |
|---|---|---|---|---|
| 1 | 0:00–0:02 | VIDEO | This looks like a video. | Dead-ordinary frame: a shared video playing on its public page (`/slug`) — play bar ticking, cursor drifting. Calm. A trap. |
| 2 | 0:02–0:10 | LIVE-WINDOW kinesin | It isn't. Go on — touch it. Grab the motor… spin it. | WINDOW OPENS t=2 (label chip "Touch the motor"): the REAL Kinesin 3D sim mounts on top, Simple UI (cycle scrub + orbit only); film + music keep rolling underneath, music cut to room tone. The viewer's own hand drives it; for a viewer who doesn't touch, Auto Script keeps the motor walking and slowly orbits (never a frozen molecule). |
| 3 | 0:10–0:15 | LIVE-WINDOW kinesin (cont.) | You're driving a molecular machine inside an ad. This is Flow Video. | Scrub drags the walking cycle; orbit swings the camera. AUTO-RETURN t=15 — riser, film swells back. |
| 4 | 0:15–0:20 | VIDEO | Questions? Ask out loud. It answers from this lesson. | REAL ask surface: mic waveform pulses, question chip, answer caption chips render. Chips-only staging (no timed audio exchange here — film 4 owns the clean listen). Anchors: ask surface per capture ruling (ANAM avatar plan-of-record / podcast Tap-to-ask fallback). |
| 5 | 0:20–0:25 | VIDEO | And when the story forks… your viewers steer. | **Follow user decisions** branch in the real viewer: Cards overlay slides in, cursor picks, timeline visibly jumps down that path. |
| 6 | 0:25–0:31 | LIVE-WINDOW solarSystem | Round two — a solar system. Tap any planet. Go ahead… I'll wait. | WINDOW OPENS t=25 (chip "Fly to a planet"): real Solar System 3D, Simple UI (time speed + tap-a-planet fly-to). Music out. The wait is scripted air — let them tap. |
| 7 | 0:31–0:36 | LIVE-WINDOW solarSystem (cont.) | There you go. They fly… you keep teaching. | Camera sweeps to Mars on the viewer's tap (auto-tour covers a no-touch viewer). AUTO-RETURN t=36. |
| 8 | 0:36–0:45 | VIDEO | Want one? Drop in footage — and a simulation. Tell the AI what viewers touch. One link. That's a Flow Video. | Creator montage, 9s, five REAL shots ≈1.8s each, legible at 360p: files drop on **Library** ("sorted automatically" overlay) → section marked on **V1** → **Generate mini model** card: prompt typed + both toggles flipped → **✦ Generate with AI** → **Share this video** sheet (**Public page**). |
| 9 | 0:45–0:52 | LIVE-WINDOW murmuration | Last one. Steer the flock… find the scatter button. …That was you. | WINDOW OPENS t=45 (chip "Steer the flock"): real Murmuration 3D — the flock bends to the viewer's pointer; **Scatter** button prominent; burst → reform. AUTO-RETURN t=52. |
| 10 | 0:52–0:58 | VIDEO | The doors below are live. — Touch it. Ask it. Steer it. — Flow Video. | Zoom out INSIDE the product: this film sits on a Flow Video timeline; the **choice doors** section below glows, ▼ pulse. Logo lockup + end card: **"The doors below are live."** Auto-advance into the doors. |

Beat discipline: 10 beats, none longer than 9s, nothing static past 8s. Brand spoken 3× (beats
3, 8, 10 — last word of the film). First live window by second 2. Creator montage 9s (≤10 rule).

Capture-contingency:
- Beat 4 ask staging ruled at capture time (ANAM key on the local stack → avatar; else podcast
  Tap-to-ask reframed honestly). Both pre-scripted; chips render either way; no faked latency.
- Windows are the product's real mid-roll windows — configured, not composited. If a window's
  open/close needs retiming at assembly, retime layout-v3.json and this map TOGETHER.

HARD RULES (non-negotiable): no feature named that isn't captured; export-stills caveat is NOT
teaser material; "Flow Video" spoken 3×, the UI shows its own brand; sims appear ONLY as live
windows — zero sim footage in VIDEO beats; every seeded asset license-clean. KINESIN: embedded in
the LOCAL review build by owner instruction (2026-09-05); PUBLIC seeding still requires the
CGTrader license clearance (see kinesin STATUS.md).
