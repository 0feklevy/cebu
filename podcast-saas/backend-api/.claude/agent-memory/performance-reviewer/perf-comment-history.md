---
name: perf-comment-history
description: FlowVid code comments cite prior performance fixes as "perf-NNN" — grep for these before filing a new finding to avoid re-flagging an already-fixed pattern or missing a precedent fix.
metadata:
  type: project
---

The FlowVid backend and client-web code carry inline comments referencing numbered performance
fixes from past review cycles, e.g. `perf-001` (whole-decoded-stream buffering removed from
`services/crop/ffmpegExtract.ts`, replaced with `streamRgbFrames`'s one-frame-at-a-time streaming),
`perf-004` (`controllers/admin/v1/users.controller.ts`'s `/usage` endpoint: moved from streaming
every `token_usage` row into JS and summing, to grouped SQL aggregates), `perf-009` (removed a
buffering frame-extractor variant), `perf-011` (ffmpeg audio-decode spawn-failure handling in
`ffmpegExtract.ts`), `perf-014` (`TimelinePanel.tsx`'s `ClipFilmstrip`: gated video-frame decoding
behind `IntersectionObserver` so off-screen filmstrips on a long timeline don't all decode on
mount).

**Why:** these comments are the fastest way to find out whether a pattern you are about to flag as
new has already been fixed once in a sibling file (e.g. 2026-08-15's run found `billing.controller.ts`
doing the exact unbounded-`findMany`-plus-JS-aggregation pattern `perf-004` fixed in
`users.controller.ts` — the `perf-004` comment is what made that precedent easy to cite as evidence
instead of just asserting "SQL aggregation is better").

**How to apply:** early in a review pass, `grep -rn "perf-0" podcast-saas/backend-api/src
podcast-saas/client-web/components` to build a mental list of already-applied fixes. When a
suspected finding matches one of these patterns, (a) check whether the fixed version exists
elsewhere in the codebase — if so, cite it as both evidence and as the fix's known-good precedent,
and (b) do not re-file the *already-fixed* location as a new finding.
