---
name: storage-volume-audit-context
description: Decisions already made about FlowVid storage/DB volume waste — what was ruled out as a merge, and where the census script lives
metadata:
  type: project
---

A storage/DB volume-waste audit ran on 2026-08-19. An external reviewer had already done a
read-only census of the LOCAL dev DB and found only ~8.4KB of duplicate plan JSON.

**Accepted decisions — do not re-propose these:**
- **No normalization of plan JSON.** The duplication is negligible.
- Ruled OUT as automatic merges: cross-project media dedupe (duplication copies bytes *on
  purpose*, for delete/permission independence — see the header comment of
  `services/project/ProjectDuplicationService.ts`), simulation revisions by `manifest_hash`
  (rollback history is a real use; only `RevisionService.gc` applies), `avatar_visuals` by
  lookup_key/filename/URL/size (no byte hash exists), podcast clips/chunks by "not in the
  current mix", and conversation/RUM retention (already bounded; further TTL is a
  privacy/product call).

**Why:** the product deliberately trades storage for isolation and rollback safety. Dedupe
proposals keep being raised and keep being wrong for that reason.

**How to apply:** when asked about storage waste, go after *unreferenced* bytes (writers with
no deleter, delete paths that drop the ledger row before collecting its keys) rather than
*duplicate* bytes. The census script the owner runs lives at
`scratchpad/storage-audit/census.sql` in the audit session's scratchpad — regenerate it rather
than assuming the path survived.

Related: [[no-invented-prod-numbers]]
