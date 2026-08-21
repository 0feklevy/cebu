---
name: reference-doc-staleness
description: Two files in .claude/reference/ are known-stale in specific ways — fiji.md's FlowVid storage claims and worker-queue-extraction-plan.md's status line
metadata:
  type: reference
---

Two knowledge-base files under `/Users/ofeklevy/cebu/.claude/reference/` describe FlowVid state that
has since changed. Verified against source on 2026-08-16.

**1. `fiji.md` §"Why podcast-saas hits problems fiji doesn't" (~lines 96-104) is stale.**
It claims FlowVid has raw `path.join` traversal (P0-2), an unauthenticated `PUT /local-storage/upload/*`
(P0-1), and a `startsWith('hls/')` prefix-as-public-check. All three have been fixed:
`backend-api/src/server.ts` rejects traversal before the public-prefix branch, routes
`videos/`/`hls/`/`exports/` through `authorizeMediaRequest`, and applies `safeLocalPath` at every
disk read. `getStorageAdapter.ts` fail-closes against local disk in production.
`services/storage/StorageService.ts` is already a full single adapter contract with presigned
upload/download and S3 multipart.

**Why:** repeating the KB's P0 claims produces a wrong, embarrassing "critical finding" about code
that is already hardened — and the KB's own header warns that drift in the knowledge base is a bug
class with an owner (`fleet-maintainer`).

**How to apply:** before citing any fiji.md claim *about FlowVid* (as opposed to about fiji), open
the FlowVid file and confirm. fiji.md is authoritative on fiji only, and even then only as
`(from KB, unverified)` while the fiji checkout is absent. Report the drift as a `fleet` finding.

**2. `worker-queue-extraction-plan.md` status line ("Phase A + B shipped … Phases C-D not started")
is wrong in both directions.**
Phase D *is* shipped — `deploy/docker-compose.yml` runs a separate `worker` service on
`node dist/worker.js`. Phase C is *not* — `backend-api/src/queue/pgBoss.ts` lists only 3 of the 11
job names in `queue/types.ts`, so the other 8 (including `transcode` and the podcast render jobs)
still run inline in the API container.

**Why:** the plan was written when the deploy target was a single-app managed host; the target is now
a Docker Compose VM, which invalidates the plan's central constraint but not its pg-boss choice.

**How to apply:** treat that document as design rationale, not as status. Read
`queue/pgBoss.ts` + `deploy/docker-compose.yml` for what is actually deployed.

See [[flowvid-host-and-fleet-context]] for the host constraints that shape any recommendation here.
