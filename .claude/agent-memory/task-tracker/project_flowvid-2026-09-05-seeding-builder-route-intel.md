---
name: flowvid-2026-09-05-seeding-builder-route-intel
description: Pre-build route-intel checklist for tutorial-kit/seeding/build-template.mjs (feat/welcome-tutorial-kit) — real API shapes confirmed, plus load-bearing traps found before any code was written
metadata:
  type: project
---

2026-09-05: built the requirements checklist for `tutorial-kit/seeding/build-template.mjs` +
`run-build-template.sh` (not yet implemented — only `seeding/DESIGN.md` exists) before any code was
written, per `podcast-saas/tutorial-kit/CHECKLIST.md`'s own priority action #7. Full route intel and
the atomic checklist were returned as chat text, not a report file (this session's instructions).
Re-derive the full checklist from the task text if needed; this memory is the load-bearing traps.

**Trap 1 — title auto-overwrite, applies to ALL 4 seeded projects.** `POST /api/v1/projects` only
ever writes `topic` (`backend-api/src/controllers/v1/projects.controller.ts:130`) — `title` starts
null regardless of what's sent (`name` is silently ignored). A queued post-transcode job
(`generateVideoMetadata.ts:113-127`) auto-fills title **only if currently empty**. So the builder
MUST `PATCH /api/v1/projects/:id {title}` explicitly or the branded titles ("Welcome to Flow Video"
etc.) get silently replaced by AI-generated slop. Already independently documented once in this repo:
`tutorial-kit/captures/out/DISCREPANCIES.md` f2-s2a→s3 entry — same bug class, different call site.

**Trap 2 — sim-section poster capture is NOT a fire-and-forget endpoint call.**
`storeCapturedPoster` (`simulations.controller.ts:112-140`) 400s unless the POST body carries real
`renditions:[{size,format:'png',dataUrl}]` at the EXACT pixel dims in `POSTER_SIZES[aspect]`
(`shared/src/sim/posterIdentity.ts:52-60`, e.g. wide: 1280×720+640×360). Per
`.claude/review/DECISIONS.md:68`, the in-app "banner sweep" auto-capture is still broken (CONNECT
postMessage never reaches the sweep frame); the section-editor's own 1.5s-after-preview-load capture
IS confirmed fixed (`DECISIONS.md:67,205`). Realistic options: drive the real section-editor page in
Playwright and let that fixed path fire, or self-render PNGs at the exact sizes and POST them. A bare
POST with no renditions will not silently succeed — check for an actual stored poster, not just a 2xx.

**Trap 3 — playlists have no `visibility` field at all.** PATCH schema
(`playlists.controller.ts:338-351`) only has `title/description/autoplay/show_sidebar/allow_shuffle/
banner_*`. "Public" for a playlist = `POST /api/v1/playlists/:id/share` (share_token), an asymmetry
with projects' explicit `visibility` enum (`projects.controller.ts:214`).

**Ambiguity, not yet resolved by the spec text — flag before building:** does "skip+note when
missing" (niche films 3/4/5) skip the WHOLE niche project or just its video-upload substep? Matters
because AS OF THIS AUDIT none of films 2-5 have rendered assembly output (`assembly/out/` has only
`film1.SCRATCH.mp4`; `assembly/edl/film2-5.json` landed same-day but nothing rendered yet) — if the
reading is "skip whole project," a run today cannot produce the playlist's required "4 projects."

**Branching (A.7) is a real multi-step feature, not a single POST**: `branch/choice-points` requires
an existing `sequence_id` (from `branch/sequences` + `branch/assign`), realistically needing ≥2 videos
in different sequences to mean anything. The demo project as specced has 1-2 videos on ONE timeline —
strong chance this legitimately falls to the spec's own "note as manual step" escape hatch; that would
be a correct read of infeasibility, not a shortfall, IF the reasoning is documented in TEMPLATE.json.

Full confirmed-real endpoint table (project/video/section/sim/image/audio/permalink/share/playlist/
branch/audio-edition/player-config) is in the chat response of this session, not repeated here —
re-derive via the same controller files if this memory outlives the checklist text.

See [[flowvid-2026-09-05-tutorial-video-readiness-audit]] (the wider flagship task this descends
from) and [[flowvid-2026-09-05-solar-system-sim-baseline]] (confirms the solar-system sim package and
Playwright/kinesin resolution path this build script also depends on).
