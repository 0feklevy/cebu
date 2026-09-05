---
name: flowvid-2026-09-05-solar-system-sim-baseline
description: START-of-task baseline for the solar-system 3D sim package (tutorial-kit/sims/solar-system/, branch feat/welcome-tutorial-kit) — confirmed zero prior work, ~97-item checklist built, vendor-source preconditions verified ready for the completion-time re-check
metadata:
  type: project
---

2026-09-05: built the START checklist for a new sim package requested as part of the larger
overnight "Welcome playlist" production run (owner directive logged in
`podcast-saas/tutorial-kit/PRODUCTION-PLAN.md` lines 39-47, "OWNER STEER 3" — Solar System 3D is
the flagship embed, final seeded lineup of 3 sims alongside Murmuration and Orbit Lab; Wave Lab was
demoted to spare). That plan doc is the ONLY place in the repo that mentions solar system before
this task — `podcast-saas/tutorial-kit/CHECKLIST.md` (the master per-item checklist for the whole
run) does not yet have a section for it.

**Confirmed genuinely zero implementation at baseline** (re-verify with the same commands rather
than trusting this note is still current): `test -e podcast-saas/tutorial-kit/sims/solar-system` →
NO; `rg -il "solar-system|SolarSim" /Users/ofeklevy/cebu` excl. node_modules → zero hits repo-wide;
`git log --all --oneline -- podcast-saas/tutorial-kit/sims/solar-system` → zero commits; no
`proof-solar-*.png`, no `solar-smoke.mjs`.

**Preconditions verified READY (so a future session doesn't re-derive them):**
- Vendor source: `/Users/ofeklevy/Desktop/Kinesin and Dynin/3d-kinesin/node_modules/three/build/
  three.module.js` is exactly **three@0.185.1** (matches the task's pinned version) and its
  `node_modules/three/LICENSE` is the plain MIT text — safe under `podcast-saas/CLAUDE.md` §8
  (commercial-use-license-only rule). The npm-pack fallback the task allows should not be needed.
- Playwright infra: same kinesin `node_modules` has `playwright@1.62.1`; the exact
  `createRequire(.../3d-kinesin/package.json)` + `channel:'chrome'` pattern is proven working
  TODAY, not just present — `tutorial-kit/sims/orbit-smoke.mjs` uses it and its
  `proof-orbit-1/2.png` exist with real byte counts.
- **Real gotcha for whoever writes `solar-smoke.mjs`**: orbit-lab and murmuration use classic
  non-module `<script src>` tags, so their smoke tests load via a bare `file://` URL. Solar-system
  is explicitly ES-modules-with-relative-imports, and Chromium refuses to load `type="module"`
  scripts over `file://` (CORS-like restriction) — this is almost certainly *why* the task spec
  requires a tiny local `http://127.0.0.1` server instead of reusing the `file://` pattern. Don't
  let a future session "simplify" it back to `file://` and then be confused why modules fail to load.
- Design-language reference read in full: `tutorial-kit/sims/orbit-lab/styles.css` — dark glass
  panel is `--panel:#141b2acc` + `backdrop-filter:blur(10px)` + `border:1px solid #ffffff14` +
  `border-radius:14px`. "Matches orbit-lab" should be checked against these literal values, not by
  eye.

**Ambiguities flagged in the checklist (task text doesn't fully specify), with the reading I
audited against:**
- Texture size tiers "<=1024 (Earth/Jupiter) / 512 (rest)" — read "rest" as every other procedural
  texture including Sun and Moon.
- Sphere segment tiers "~48 big / ~24 small" — read "big" as Sun/Jupiter/Saturn, "small" as the
  other five bodies + Moon; not stated in the task, worth a one-line confirmation if it matters at
  review time.
- `tour.js` is explicitly "possibly" — treated the FILE as optional, the tour FEATURE (button +
  `tour()` API + 4-5 stop eased flight) as hard-required regardless of which file it lives in.
- Exact proof-screenshot filenames aren't given (task says `proof-solar-*.png`, needs 3 vs.
  orbit-lab's 2) — no fixed naming to check against, just that 3 files exist with the 3 specified
  visual contents.

**Orphaned decoy memory directory found, not this task's concern to fix but worth knowing about:**
`podcast-saas/backend-api/.claude/agent-memory/task-tracker/` is a SEPARATE, stale, non-symlinked
agent-memory root (only 1 file, last touched 2026-08-25) distinct from this repo's canonical
`.claude/agent-memory/task-tracker/` (this file's own location, 15+ files, actively maintained). A
`welcome-tutorial-kit-master-checklist.md` and `music-beds-checklist.md` for THIS SAME overnight
run were written there by an earlier session instead of here — likely that session's cwd made a
relative `.claude/agent-memory` path resolve under `backend-api/`. Worth checking BOTH locations
for this production run's history until someone consolidates them; do not assume the canonical
dir's 15 files are the complete picture for `feat/welcome-tutorial-kit` specifically.

See [[kinesin-dynein-flowvid-integration]] (the vendor source project's separate licensing gate on
its own GLB assets — irrelevant here since only `three.module.js` itself is being vendored, not any
kinesin-authored asset) and [[flowvid-2026-09-05-tutorial-video-readiness-audit]] (the wider
flagship-video task this playlist work descends from).
