# Overnight Production Plan — the Welcome playlist (run of 2026-09-05)

Owner directive (going to sleep, verbatim intent): run tests and critiques **until the product is
perfect** — a default demo project every user learns from; embed everything in a **playlist**
(teaser first, then basic operations, then more niche videos); use the product's own features
inside the example project; generate simulations / images / audio / music where needed
(commercial-use only), tasteful and never overwhelming; combine behind-the-scenes editor use with
the finished interactive film. Activate the task manager and the conductor. If tokens run out,
wait for the window to reset on an automatic timer.

## The deliverable (restructured per the playlist directive)

**One public playlist — "Welcome to Flow Video"** — seeded for every new user, containing:

| # | video | length | job |
|---|---|---|---|
| 1 | **Teaser — "Touch This Video"** | ~66s | pure marketing; ends by sending the hand to the LIVE sim section below |
| 2 | **Tutorial — the basics** | ~2:10 | edit a video, add sections, This-moment, publish/share |
| 3 | **Niche — "Embed a heavy simulation"** | ~75s | the heart: sim .zip → minimal UI → auto-script → poster |
| 4 | **Niche — "Viewer superpowers"** | ~70s | Tap-to-ask deep dive + branching + Smart Crop + dubbing |
| 5 | **Niche — "Share, collaborate, price"** | ~60s | distribution: permalink, collaborators, access, pricing |

Videos 1–2 live in the **demo PROJECT** (one timeline, live sim/image/audio sections between
them — the meta-concept). Videos 3–5 are their own small projects in the same playlist. The
playlist is the seeded artifact; the demo project is its first entry.

Demo-project section plan (tasteful, not overwhelming — 7 sections total):
V1: [teaser video] → [SIM: Murmuration 3D, touchable] → [tutorial video] → [SIM: Orbit Lab]
    → [IMAGE: "Anatomy of an interactive video" infographic] → [choice section: "What next?"]
A2: [generated ambient sting under the handover]

**OWNER STEER (2026-09-05 01:31, overrides sim lineup)**: seeded sims must be relatively SIMPLE,
visually beautiful, interesting. Wave Lab judged too niche/unclear — REMOVED from seeding and
scripts (file kept as spare). Kinesin remains film-captures-only (license).

**OWNER STEER 2 (01:47)**: sims are MULTI-FILE packages (single-html reads low-quality) — orbit-lab
split html+css+5js; murmuration agent re-briefed; solar system born multi-file.

**OWNER STEER 3 (02:05)**: add a REALISTIC 3D SOLAR SYSTEM as the flagship embed example.
Final seeded lineup (3 sims, distinct characters):
  1. **Murmuration 3D** (organic wonder — teaser handoff section)
  2. **Solar System 3D** (realistic three.js, procedural textures, Kepler ratios — the sim BUILT
     on camera in tutorial S4; This-moment prompt anchors to it)
  3. **Orbit Lab** (classical mechanics + force vectors — film 4's touch scene; built, 61fps,
     G1-verified proofs)
SCRIPT-2 S4/S5/S9 re-anchor to Solar System once its controls land (queued edit); Orbit Lab keeps
film 4 scene 2. Capture-prop project will be restaged as "Tour the Solar System" with the real
sim; "Standing Waves 101" stays as a background library prop only.

## Stage gates — the critics' panel (owner order: before AND after each stage)

Panel roles (temporary agents, US-audience calibrated): product-marketing director, PM/accuracy,
sales/conversion; narration director joins at the TTS gate; editing critic (frame stills) at the
assembly gate. Every verdict is split MUST-FIX (עיקר) vs NICE (תפל); only MUST-FIX blocks.

| gate | stage | status |
|---|---|---|
| G1-pre | scripts v1 | ✅ ran (3 critics) — verdicts below |
| G1-post | scripts v2 after fixes | pending |
| G2 | capture footage review (stills) | pending |
| G3 | narration takes (text-level + timing) | pending |
| G4 | assembled films (frame extraction QC) | pending |
| G5 | seeded project UX walkthrough + device sweep | pending |
| G6 | task-tracker completion audit + final panel | pending |

## G1-pre verdicts — convergent MUST-FIX list (scripts v2 must satisfy ALL)

From the marketing critic:
1. Pacing has zero air — cut ~30 words; scene 8 gets ≥10s; card must be readable.
2. Scene 3 audio pile-up — narrator YIELDS while the viewer's question + spoken answer play clean.
3. Brand spoken ≥3× (was 1×).
4. Close = triple-tap callback: "Touch it. Ask it. Steer it. Flow Video." Brand is the last word.
5. Kinesin hook is license-contingent — murmuration-led fallback pre-scripted. (Owner permitted
   kinesin in FILM captures 2026-09-05, so primary stays kinesin; fallback documented.)
6. Tutorial "in about two minutes" reads as build-time inflation — reword to viewing-time.
7. Tutorial S4 needs ~27s; S7 cut from seven settings cards to four.

From the sales critic:
8. Teaser CTA is a signup-page CTA — replace with the physical handoff DOWN the timeline:
   "Don't take my word for it. The next section is live. Scatter the flock." Auto-advance.
9. "Go ahead — touch it" at 0:07 invites touching a film — reword as deferred promise (the real
   touchable interrupt is the next SECTION; the film can't be an iframe).
10. Tutorial ends on "Edit this section / change one word" (low-friction aha), New project secondary.
11. Creator-burden anxiety: add "No code — simulations are packages you drop in; the one you just
    touched is already in your library." (And it WILL be — the seeding puts it there.)
12. Beat 1 compressed ≤4s; first touch moment by ~0:05.
13. Smart Crop + dubbing compressed to ~6s combined; reinvest in a second ask-the-avatar proof.

PM/accuracy critic: still running — its findings fold into v2 before G1-post.

## Autonomous decisions taken tonight (owner asleep; logged for morning review)

- **Voice**: the admin default guidance voice (same ElevenLabs path as production guidance);
  spend recorded per take. Swappable later — narration is a separate audio track by design.
- **Music**: NO third-party tracks. A minimal original ambient bed generated programmatically
  (offline-rendered oscillator pad, ours by construction → commercial-clean), mixed ≥12dB under
  narration; reference loudness matched (mean ≈ −23dB).
- **Images**: original on-brand infographics rendered from HTML → screenshot (license-clean).
- **Kinesin**: appears in FILM captures only (owner permission 2026-09-05); everything seeded is
  license-clean (Murmuration, Wave Lab, generated media).
- **Brand spoken aloud**: "Flow Video" (owner's earlier ruling).
- **Production ships to a PR + local verification.** Production deploy approval stays with the
  owner (standing rule) — the shipment will HOLD at the gate if started.

## Pipeline state (updated as the night progresses)

- [x] Reference transcribed (VibeYard 56s; 150wpm; triple-tap close; loudness −22.8dB mean)
- [x] G1-pre panel run (marketing + sales in; PM pending)
- [ ] Scripts v2 (teaser, tutorial) + NEW scripts 3–5 (niche) + G1-post panel
- [ ] Local stack up; demo assets staged (sims zipped, kinesin project alive)
- [ ] capture-all.mjs — every UI surface filmed per shot lists
- [ ] TTS narration all films + captions VTT (word-timed)
- [ ] Music bed + infographic layer + ffmpeg assembly ×5 films
- [ ] G4 frame QC panel; fixes; reassembly
- [ ] Demo project built via real APIs (sections, This-moment, choice, posters, permalink)
- [ ] Niche projects 3–5 + playlist assembly via API
- [ ] Seeding service (migration 085, dark-gated) + tests
- [ ] Device/browser sweep on the seeded playlist
- [ ] G6 completion audit (task-tracker) + final panel + ledger entries + PR
