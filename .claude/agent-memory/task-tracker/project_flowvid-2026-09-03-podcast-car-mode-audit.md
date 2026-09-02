---
name: flowvid-2026-09-03-podcast-car-mode-audit
description: PR #167 (podcast car mode, §4) audit — two real CI-breaking gaps found by running the full local test suite, both fixed and merged to main within ~40 minutes, live during the same audit session
metadata:
  type: project
---

Audited 2026-09-03 against `.claude/review/NIGHT-RUN-2026-09-03.md` §4 "Podcast — hands-free car
mode." Started against PR #167 (`feat/podcast-car-mode`) at commit `324e0715070d8a273efcd8b1338eb0d90f16fc9f`.
Almost everything in §4 was genuinely implemented and unit-tested at that commit — the voiceLoop
reducer, the backend STT→ask→TTS chain, the `editions/` media-access scope, the shared contract —
but running the FULL local `backend-api` test suite (not just the four new test files the commit
message pointed at) surfaced two real regressions in pre-existing repo-wide safety gates:

1. **Unbounded ElevenLabs spend** — `VoiceQuestionService.ts` called `GuidanceTTSService.synthesize`
   directly, bypassing the spend-ceiling check that lives in `GuidanceService.ts` (the only other
   caller). Caught by `ceilingCoverage.test.ts`.
2. **Silent-log no-op** — the voice-question route's catch block used `request.log.warn(...)`,
   which is a no-op under this app's `logger: false` Fastify config (observability-001 class bug).
   Caught by `serverLoggingIsNotANoop.test.ts`.

**Resolution, confirmed live during the same audit session (not from a commit message — read the
diffs directly):**
- `d26b86e` "fix(podcast): the spoken answer consults the ElevenLabs ceiling first, and the route
  logs through pino" (2026-09-03 01:40) — adds `evaluateSpendCeiling({provider:'elevenlabs'})`
  before `synthesize` in `VoiceQuestionService.ts`, registers it in `ELEVENLABS_SPENDERS`, switches
  `request.log.warn` to the real `logger.warn`. Tested (`voiceQuestionService.test.ts` refusal case
  added, `ceilingCoverage.test.ts` updated).
- `47843ab` "fix(podcast): the 30 s utterance ceiling holds on the server, editions access is
  tested, and dev copies the VAD assets" (2026-09-03 01:44) — its own commit message says "Three
  follow-ups from the task-tracker audit of §4," and fixes exactly the three lower-priority gaps
  this audit had also found independently: server-side duration enforcement (client only truncated
  at 30s; 2MB of 16kHz mono is ~65s, so a non-browser caller could double the spend — now refused
  server-side on `heard.durationSec`), a direct test for `mediaAccess.ts`'s `editions/` branch
  (previously only `mediaToken.ts`'s key-parsing was tested, not the access-resolution code path),
  and `dev.sh` now runs `copy-vad-assets.mjs` (previously only `build` did, so a fresh checkout's
  `pnpm dev` 404'd on `/vad/*`).
- PR #167 merged to `main` at `2026-09-02T23:03:20Z` (merge commit `7b3da50`), all CI green
  including "Release verification gate" (16m59s) on the second run
  (`33691832056`, after the first run `33690372343` — the one still `IN_PROGRESS` when this audit's
  local test run found the two defects — was cancelled by the follow-up push).

**Still open on `main` as of the merge (not addressed by either follow-up commit):**
- `components/audio/CarModePlayer.tsx` and `components/audio/vad.ts`, named in the plan's "Files
  (central)" list, were never created — functionality folded into `AudioEditionPlayer.tsx` /
  `useVoiceLoop.ts` instead. Not a functional gap, a plan-vs-actual file-structure deviation.
- No controller/route-level test exists for `POST /api/v1/public/audio/:slug/voice-question` (rate
  limit, 2MB bound, 413/502 mapping, `artwork_url` on the public GET) — `grep -rln voice-question
  backend-api/src --include=*.test.ts` still empty on the merged tree. `VoiceQuestionService.ts`
  itself is well tested; the Fastify wiring around it is not.
- `?t=` deep-link position, named in §4's UI "Keeps" list, was never implemented before or after
  this commit — the plan's premise was inaccurate, not a regression.

**How to apply / confirms [[reverify-live-state-before-flagging-stale]]:** this repo's owner (or a
concurrent agent) reacts to a task-tracker audit's findings in near-real-time and pushes fix
commits to the SAME open PR while the audit is still running — the second fix commit's own message
literally cites "the task-tracker audit of §4." A finding is not stale-checked once at the start of
an audit; re-check `gh pr view <n> --json state,mergedAt,headRefOid` and re-fetch `origin/main`
again right before finalizing a report, even if (especially if) the audit's own local reproduction
of a failure was rock solid — the code can and does move under you within the same session, twice
in this case (`324e071` → PR merged with 2 fix commits → main moved 4 more merges past that, and
the LOCAL checkout itself hopped to an unrelated `fix/audit-followups` branch mid-session, exactly
the pattern already documented in [[reverify-live-state-before-flagging-stale]]).
