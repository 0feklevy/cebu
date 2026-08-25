---
name: flowvid-sweeper-wiring-pattern
description: "FlowVid recurring false-green shape: a background sweeper/GC gets fully implemented and unit-tested against a real DB, then never gets a caller added to server.ts's startup block"
metadata:
  type: project
---

Second confirmed instance of the same shape, 2026-08-25 (first was `RevisionService.gc()`, see
[[supabase-storage-leak-map]] in the user's global memory). `backend-api/src/services/storage/
blobSweeper.ts` implements `sweepOrphanBlobs`/`sweepOrphanBlobsOnStartup` — two-pass mark-then-
delete, grace period, real-DB tested in `blobSweeper.realdb.test.ts`, even pre-registered in
`deleteChokepoint.ratchet.test.ts`'s allow-list as the one caller permitted to bypass the blob
delete refusal. It is never called from `server.ts`, `worker.ts`, or any script.

`server.ts`'s startup block (~line 555-592) enumerates its sweeps by hand, one per migration that
needed one, each with a comment explaining which failure mode it closes (RUM retention, HLS
retention, duplication, export, HLS recovery, corpus ingestion, revision GC — seven, numbered in
the comments themselves as "the first" through "the seventh"). A missing eighth entry for the blob
sweeper is invisible unless you count the numbered comments and check the count.

**How to check fast next time:** `grep -n "^  start.*Sweep()\|sweepOrphanBlobsOnStartup" server.ts`
and diff the sweeper files that exist against the sweeps that are actually invoked at startup —
don't trust that "the feature has a sweeper" means "the sweeper runs".

**Why it recurs:** the sweeper is usually built in the SAME PR as the feature it protects, gets a
real test, and reads as done. Wiring it into the boot sequence is a separate, easy-to-forget step
that no test catches, because the unit test imports the function directly. Cross-reference
[[flowvid-release-tag-vs-main-gap]] — same "exists but unreachable" shape, one level up.
