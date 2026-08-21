---
name: media-review-method
description: How to review FlowVid's export/transcode code effectively - its doc comments confess live bugs, and the default-green test suite proves graph text rather than encoder behaviour
metadata:
  type: project
---

Two calibration facts for reviewing `podcast-saas/backend-api/src/services/export/**` and
`services/video/**`.

**1. The module header comments are a findings source, not decoration.** This codebase documents
measured failures inline and sometimes names live bugs in *sibling* modules that were never fixed.
`ffmpegGraph.ts`'s header called out "a live bug in HLSTranscoder.buildTierArgs" (the missing
anamorphic `setsar` squaring) — still present at commit 2d187e3, filed as `media-002` in run
`2026-08-15T2109`. Read every file's header block before its code and treat "measured", "the
v0.1.2x incident", and "PENDING" as pointers.

**Why:** the authors fix the module they are writing and leave a note about the neighbour they are
not. Those notes age into real defects.

**How to apply:** grep the export/video trees for `live bug`, `PENDING`, `VERIFIED-IN-CONTAINER`,
`documented gap`, and `not implemented` before doing anything else — each one is a candidate finding
with the author's own evidence attached.

**2. The default-green suite proves TEXT, not encoding.** `pnpm -C podcast-saas --filter backend-api
test` is green (2278 passed / 18 skipped, ~210 s). The 18 skips are the only tests that run a real
encoder: `export/__tests__/linearAssembler.realEncode.test.ts` (`EXPORT_REAL_ENCODE=1`) and
`video/__tests__/hlsTranscoder.realEncode.test.ts` (`HLS_REAL_ENCODE=1`). Everything else asserts
filtergraph strings or fakes ffmpeg at the spawn boundary.

**Why:** "the tests pass" is not evidence that a filter chain produces correct pixels, so a green
run must never down-rank a graph-shape finding.

**How to apply:** when judging a filtergraph claim, check whether an opt-in real-encode case covers
it. If not, say so in `evidence` — that absence is itself part of the argument.

Related: [[export-capture-architecture]]
