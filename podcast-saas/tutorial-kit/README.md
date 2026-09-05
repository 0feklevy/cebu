# Tutorial Kit — the default "Welcome" playlist, and how to regenerate it

Everything that produces the product's built-in tutorial/demo experience lives HERE, so that
when the interface changes, updating the films / captures / seeded playlist is **re-running
scripts**, not archaeology. (Owner direction 2026-09-05: "work smart — document everything so
the videos and the default tutorial project can be updated to a new UI on request.")

## What ships to users
A seeded **"Welcome to Flow Video" PLAYLIST** per user (dark-gated, migration 085) — v3 grammar
(owner reset): sims are never footage; they open as MID-ROLL LIVE WINDOWS on the film itself
(real sim mounts on top at second X, film + narration continue under, auto-return at second Y).
Window times live in each script's WINDOW MAP line and `seeding/layout-v3.json` (keep in sync):
1. **The demo project** (the user's own editable clone): `Film 1 · TEASER ~58s` with live
   windows Kinesin [4,12] · Solar System [25,33] · Murmuration [45,52] → choice doors at end;
   ambient sting on A2.
2. **Film 2 · TUTORIAL "Make Yours"** ~1:23, its OWN project, window Solar System [51,63] ·
3. **Film 3 · "Drop In Anything"** ~51s (retitled from "The Heavy Simulation"), window
   Kinesin [32,44] · 4. **Film 4 · "Viewer Superpowers"** ~57s, window Orbit Lab [3,15] ·
5. **Film 5 · "One Link, Three Doors"** ~45s, no windows — shared public projects, watch-only.
The films are the ad AND the proof: the viewer's hand is on the sim while the narration sells.

## Layout
| path | contents | regenerate by |
|---|---|---|
| `CREATIVE-BRIEF.md` | positioning, owner directions, narrative arcs, constraints | editing (source of intent) |
| `PRODUCTION-PLAN.md` | the run board: gates, decisions, pipeline state | maintained during production |
| `CHECKLIST.md` | task-tracker audit of every requirement | re-run the task-tracker agent |
| `scripts/SCRIPT-{1..5}-*.md` | narration (verbatim TTS input) + shot lists with REAL UI anchors | edit text → re-run narration + captures + assembly |
| `sims/murmuration/` | Murmuration 3D (multi-file classic-script package, ours) | edit; `sims/murmuration-smoke.mjs` verifies |
| `sims/orbit-lab/` | Orbit Lab — classical mechanics + force vectors (multi-file) | edit; `sims/orbit-smoke.mjs` verifies |
| `sims/solar-system/` | realistic three.js solar system (procedural textures) | edit; `sims/solar-smoke.mjs` verifies |
| `sims/wave-lab/` | spare (owner: too niche to seed) | — |
| `narration/` | `parse-scripts.mjs` (scripts→lines.json) · `run-narration.sh` (product TTS + SPEND.md) · `make-scratch-vo.sh` (timing-only VO) | narration changes |
| `music/` | `synthesize.mjs` — 5 original beds + sting, −32 LUFS, license-clean by construction · MANIFEST.md | taste changes |
| `overlay/` | infographic rig (`index.html` + `render-overlay.mjs`, product palette, Bricolage OFL) + per-film cue sheets in `scenes/` (cues ANCHOR to script scenes) | design changes |
| `captures/` | `capture-all.mjs` (shot modules in `shots/`, persistent logged-in chrome profile) · staging scripts · `props/` · recorded `footage/` | **re-run after any UI change** |
| `assembly/` | `assemble-film.mjs <n>` — VO-timed timeline, concat, mix, overlay composite → `out/film<n>.mp4` + QC stills · `edl/film<n>.json` scene→shot maps | after captures/narration change |
| `seeding/` | DESIGN.md · `build-template.mjs` (authors the template via real APIs → TEMPLATE.json) · `run-backend-seeded.sh` + `e2e-seed-check.mjs` | product feature (migration 085) ships in backend |

## The regeneration contract (what "update to the new UI" means)
1. **Captures are scripted, never manual.** Every scene names its UI anchors; each shot is one
   module in `captures/shots/` recorded by `capture-all.mjs` into `captures/out/MANIFEST.json`.
   After a UI change: fix the ONE shot file that broke, re-run it (`--only <shot-id>`), done.
2. **Narration is decoupled from pixels.** `narration/lines.json` derives from the scripts;
   films re-time themselves around real VO durations (`assembly` computes the timeline, and the
   overlay cues re-anchor automatically). UI changes usually need zero narration change.
3. **Assembly is a build.** `node assembly/assemble-film.mjs <n>` (add `--scratch` before the
   real TTS exists). Deterministic; safe to re-run per film.
4. **The seeded playlist updates by republishing the template.** Re-run
   `seeding/build-template.mjs` (or just re-upload a film into the template project); NEW users
   clone the updated template immediately. Existing clones keep their copy — a feature: their
   edits are theirs.

## Hard rules (verified product facts — the scripts carry the full honesty list)
- Sims are uploaded packages; the AI writes the **bridge** ("This moment" → Generate with AI).
  Never say "generate a simulation with AI".
- Project creation is a plain insert — no AI content at creation.
- Exported MP4s show sims as poster stills; interactivity lives at the shared link.
- Captions/VTT come from the VIDEO PIPELINE (Groq STT on upload), not from TTS — upload the
  assembled films through the normal video path and Tap-to-ask works on the tutorial itself.
- **Licensing:** kinesin/dynein appears in FILM pixels only (owner permission 2026-09-05);
  everything seeded is license-clean and ours (`sims/`, `music/`, generated images).
- Brand: spoken name "Flow Video"; the UI renders `PUBLIC_BRAND_NAME`. Owner to unify.

## Current status (2026-09-05, overnight run)
- [x] 5 scripts through the critics-panel gates (G1-pre, G1-post CLEAR, films 3-5 panel)
- [x] 3 seeded sims built + smoke-verified (60fps, contract, proofs); wave-lab shelved
- [x] Music beds + overlay rig + capture engine + assembly pipeline (film 1 proven end-to-end)
- [x] Seeding: migration 085 + share-mode duplication + WelcomeSeedService + admin toggle + tests
- [~] Capture campaign: kinesin + murmuration-3D footage in; editor/viewer shots + template
  build running as agents; films 2-5 assemble on their EDLs as shots land
- [ ] REAL narration TTS — **blocked on owner**: local ElevenLabs credential is a key-ID, not an
  `sk_` key (both env and admin keystore). One command re-renders when fixed:
  `narration/run-narration.sh --force` then re-run assembly per film.
- [ ] Spanish dub + in-film voice-answer audio — same key blocker.
- Open (owner): brand-name unification; music taste veto; scene-3 ANAM-vs-podcast staging auto-
  resolves at capture (both pre-scripted).
