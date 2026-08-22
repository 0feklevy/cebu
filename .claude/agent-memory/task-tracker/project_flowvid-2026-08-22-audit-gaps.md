---
name: flowvid-2026-08-22-audit-gaps
description: concrete unwired/incomplete items found auditing DECISIONS.md's 2026-08-22 work queue — check these are still true before re-reporting them
metadata:
  type: project
---

Full task-tracker audit of `.claude/review/DECISIONS.md`'s 🟡 work queue, `git log`/`gh pr list`,
and code/tests, run 2026-08-22 against branch `test/webkit-failure-dump` (HEAD `b693182`, tip of
`main` at the time). Findings not yet reflected in `DECISIONS.md` itself:

- **`job-queue-014` is unwired.** `typecheck:test` (backend-api) exists but nothing in
  `.github/workflows/*.yml` or `deploy/scripts/release-verify.sh` calls it. 140 type errors already
  present across 29 test files as a result. Fix: add `pnpm --filter backend-api typecheck:test` (or
  equivalent) to CI, then clear the accumulated errors.
- **`job-queue-015` / half of `backend-008` are still open**, despite being marked "ride along"
  closed by the job-queue-013 PR. `corpus.controller.ts:139,171` still calls
  `builder.ingest(...).catch(log)` in-process, fire-and-forget, never through pg-boss.
  `jobs/corpus.ingest.ts` (Trigger.dev `task()`) and `jobs/video.transcode.ts` are dead, unimported
  code (this is also `observability-011`, separately still open). Only the stuck-row *reaper*
  (`observability-002`, `corpusRecovery.ts`) actually shipped — that's a different finding.
- **Observability "silent-failure paths" cluster is ~half done**, not all-open as the 🟡 section
  implies: `observability-003/004/006/007/008` are fixed and wired (correlation id, firebase-auth
  failure reasons, pipeline-stats health metrics, `fetchWithRetry` logging, `/health` worker+queue
  status). Still genuinely open: `observability-005` (`runVideoTranscode.ts` still raw
  `console.log`/`console.error`), `observability-009` (`LLMService.ts:714` logs 800 raw chars, no
  redaction), `observability-010` (`lib/sse.ts` still dead, only archive + a type-only import
  reference it), `observability-011`.
- **a11y ("ui-ux-*") cluster is mostly already done**, not open backlog: `ui-ux-003/004/005/007/009`
  shipped in commit `384a782` (2026-08-19), 29 passing a11y tests today
  (`client-web/__tests__/{podcastStudioOverlayA11y,confirmDialogA11y,a11yOperableControls}.test.tsx`,
  `admin-web/__tests__/adminControlsA11y.test.tsx`). `ui-ux-006` (editor timeline has no keyboard
  alternative) is the one still open, and deliberately so — the same commit says doing it partially
  would be worse than not.
- **Crop D-16 / WAVE 4 "blocked at the first step" is stale.** 13 real hand-labelled clips already
  exist (`backend-api/scripts/crop-eval/labels/`) and a field eval already ran and is marked
  quotable (`results/field-v1@v1.1.json`) — it's what surfaced the CROP_ALGO=v2 no-op finding
  elsewhere in the same doc. Real progress exists; it's short of the 20–50 clip target, not absent.
- **`media-009`** (tmpfs/memory bound on captured frame bytes, `containerRunArgs.ts`) — confirmed
  genuinely untouched, zero references anywhere in code.
- **D-14** (avatar budget async observer rebuild) — confirmed genuinely untouched, `"D-14"` has no
  code hits; `AVATAR_BUDGET_MODE` stays `shadow` in `.env.example`.
- **D-01b follow-ups** — confirmed genuinely untouched: `timeline_markers.at_sec` (schema.ts:781)
  is still absolute-only with no anchor column; no drift-review panel component found anywhere in
  `client-web/components`.
- **Production storage census** — `deploy/scripts/storage-census.sql` exists (read-only, safe) but
  there is no evidence it has been run against production (no output file, no DECISIONS.md mention
  of results) — this step is OWNER-BLOCKED (needs prod DB access), not a code gap.
- Three repo variables (`SMOKE_PUBLIC_PATH`, `SMOKE_PLAYLIST_PATH`, `SMOKE_ADMIN_PREVIEW_PATH`)
  confirmed still unset via `gh api repos/0feklevy/cebu/actions/variables` — OWNER-BLOCKED, matches
  DECISIONS.md.

See [[reverify-live-state-before-flagging-stale]] for the general pattern this instance confirms.
