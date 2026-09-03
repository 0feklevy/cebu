---
name: flowvid-2026-09-03-deploy-retention-and-listener-inbox-audit
description: task-tracker audit of NEXT-PHASE-2026-09-03.md §2 (#174 deploy retention/disk guard) and §3 (#175 listener inbox) — both closed clean, PRs merged to main
metadata:
  type: project
---

Audited against `.claude/review/NEXT-PHASE-2026-09-03.md`. Both items verified DONE at merge time,
with only one real gap found (and fixed live during the audit, see below).

**§2 (#174, deploy retention + disk guard) — fully DONE, no gaps.** `retain_app_images` /
`require_free_disk_gb` in `podcast-saas/deploy/scripts/_lib.sh`, wired into both `deploy-images.sh`
(guard block + success block) and `deploy.sh`; `retain-images.sh` by-hand script; `vm.disk-low` in
`ops/release/src/commands.ts:279` HIGH<3GB/WARNING<8GB; README paragraph; the shell test
(`deploy/scripts/__tests__/lib.test.sh`, 18 checks, all pass) wired into `ci.yml`'s `static-audits`
job. The plan's remote-sync no-disk-check decision is real and pinned by
`remote-sync.test.ts:78` (`expect(REMOTE_SYNC_SCRIPT).not.toMatch(/\bdocker\b/)`) — not a gap, a
deliberate boundary the plan itself documents correctly. Minor, non-blocking: no unit test asserts
the `vm.disk-low` HIGH/WARNING threshold values themselves (only a healthy 14GB fixture exists in
`ops/release/src/__tests__/integration.test.ts`) — not required by the plan's own Tests section,
just an inferred gap worth a two-line test if anyone revisits this file.

**§3 (#175, listener inbox) — DONE after a live fix mid-audit.** Migration 083, routes, client
(`ListenerInboxDialog`, header badge, car-mode `AudioEditionPlayer` markers+sheet), types, and the
`?before=` cursor (a `created_at` keyset, functionally equivalent to the plan's `?limit=&cursor=`
wording — self-describing, fine) were all correctly implemented and wired. One real regression: the
new mount-time `listCreatorReplies` fetch in `AudioEditionPlayer.tsx` raced the pre-existing
`raiseHand.test.tsx`'s shared mocked `fetch`, breaking 2 of its assertions — caught this via
`gh pr checks 175` showing "Release verification gate" FAIL, confirmed by local repro. Fixed live by
commit `b01932f` (scoped `vi.mock` for `listCreatorReplies` in that test file) while this audit was
still running; CI went green (17m44s) and PR #175 merged. Full detail and the general "audit finds
live-red, owner/agent fixes within minutes" pattern in [[reverify-live-state-before-flagging-stale]].

Final state verified: `git merge-base --is-ancestor b01932f origin/main` → true; both #174 and #175
show `state: MERGED` via `gh pr view`. DECISIONS.md lines for both (`#174`, `#175`) match the shipped
code exactly, written before this audit and not contradicted by anything found.
