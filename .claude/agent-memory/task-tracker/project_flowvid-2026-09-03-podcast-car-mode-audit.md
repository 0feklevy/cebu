---
name: flowvid-2026-09-03-podcast-car-mode-audit
description: PR #167 (feat/podcast-car-mode, commit 324e071) audit against NIGHT-RUN-2026-09-03.md §4 — two real CI-breaking gaps found by running the full local test suite, plus a Files-list deviation
metadata:
  type: project
---

Audited 2026-09-03 against `.claude/review/NIGHT-RUN-2026-09-03.md` §4 "Podcast — hands-free car
mode" (open PR #167, `feat/podcast-car-mode`, commit `324e0715070d8a273efcd8b1338eb0d90f16fc9f`,
not yet merged to `main`). Almost everything in §4 is genuinely implemented and unit-tested — the
voiceLoop reducer, the backend STT→ask→TTS chain, the `editions/` media-access scope, the shared
contract — but running the FULL local test suite (not just the new test files) surfaced two real
regressions the new commit introduces in pre-existing repo-wide safety gates:

1. **Unbounded ElevenLabs spend.** `backend-api/src/services/audio/VoiceQuestionService.ts` calls
   `GuidanceTTSService.synthesize` directly. The spend-ceiling check (`evaluateSpendCeiling`) lives
   only inside `GuidanceService.ts:610` (the caller `GuidanceService.publishGuidance` uses), not
   inside `GuidanceTTSService.ts` itself — so `VoiceQuestionService` is a brand-new ElevenLabs
   spend path with NO ceiling check at all. Caught by
   `backend-api/src/services/usage/__tests__/ceilingCoverage.test.ts` (a repo-wide gate that lists
   every known ElevenLabs spender and fails when an unlisted caller is found) — this is exactly the
   class of bug that test was written to catch after the 2026-08-25 incident (see the test's own
   docstring), and it caught it correctly here. Fix: either call `evaluateSpendCeiling` inside
   `VoiceQuestionService` before `synthesize`, or add it to `ELEVENLABS_SPENDERS` /
   `BOUNDED_BY_CALLER` with a real justification (there is none yet — it is genuinely unbounded).

2. **Silent-log no-op.** `audioEdition.controller.ts:291` uses `request.log.warn(...)` in the
   voice-question route's catch block. This app builds Fastify with `logger: false`, so
   `request.log.*` is `abstract-logging`'s no-op — the call compiles, looks like logging, and
   emits nothing anywhere, ever (this is the exact observability-001 incident class). Caught by
   `serverLoggingIsNotANoop.test.ts`. Fix: `import { logger } from '../../lib/logger.js'` and use
   `logger.warn(...)` instead.

Both are genuine CI-breaking failures, confirmed by running `npx vitest run` in
`podcast-saas/backend-api` locally (4718 passed, 2 failed, out of 4741) — not import-graph noise,
not flaky. `pnpm -C podcast-saas -r test` is one of the 9 steps in `release:verify`, which is what
the PR's "Release verification gate" CI check runs, so this PR's gate should fail once it reaches
the test step (as of last check it was still IN_PROGRESS ~13 min in; see
[[reverify-live-state-before-flagging-stale]] for why a pending check is not a green light).

**Also found, lower severity:**
- The plan's "Files (central)" list named `components/audio/CarModePlayer.tsx` and
  `components/audio/vad.ts` as files this work would create. Neither exists anywhere in git
  history — the car-mode UI was built directly inside the rewritten `AudioEditionPlayer.tsx`, and
  VAD loading lives inline in `useVoiceLoop.ts`'s `ensureVad`. Not a functional gap (everything
  works), but a real plan-vs-actual file-structure deviation worth naming explicitly.
- The 30-second utterance cap (`VOICE_QUESTION_MAX_SECONDS`) is enforced ONLY client-side
  (`useVoiceLoop.ts` truncates before `SUBMIT`); the server bounds only by byte size
  (`VOICE_QUESTION_MAX_BYTES` = 2 MB), which the shared contract's own comment says permits up to
  ~65 s of 16 kHz mono audio — roughly double the stated "≤30 s" design line in §4's backend
  bullet. A non-JS client could send up to ~65 s and be accepted.
- No controller-level test exists for the new `/api/v1/public/audio/:slug/voice-question` route at
  all (its 6/min rate limit, the 2 MB bound, the 413/502 error mapping, `artwork_url` on the public
  GET) — `VoiceQuestionService` itself is well tested, but the route wiring around it is not,
  matching the [[tests-that-read-source-are-theatre]] pattern in reverse (untested wiring around a
  well-tested unit).
- `carModePlayer.test.tsx` never mocks/injects `useVoiceLoop` (no "fake loop" as the plan's Tests
  section named) and has no orientation-specific assertion — it only exercises the jsdom
  `unsupported` branch of the Ask button, not the listening/thinking/speaking states.

**How to apply:** when auditing a "tests exist and pass" claim in this repo, always run the FULL
package test suite (`npx vitest run` with no path filter), not just the new/named test files — the
two real defects here were both repo-wide ratchets in files the commit never touched
(`ceilingCoverage.test.ts`, `serverLoggingIsNotANoop.test.ts`), and would have been invisible to a
check that only ran the four new test files the commit message itself pointed at.
