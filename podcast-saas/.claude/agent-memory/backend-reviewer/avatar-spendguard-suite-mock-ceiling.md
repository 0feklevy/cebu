---
name: avatar-spendguard-suite-mock-ceiling
description: avatarSpendGuard.test.ts mocks the mint, the transcript and the enrich call, so any "the start endpoint survives X" test added to that file is decorative — put mint-path tests in the anamService suites instead
metadata:
  type: reference
---

`podcast-saas/backend-api/src/controllers/v1/__tests__/avatarSpendGuard.test.ts` boots the real
Fastify routes but stubs everything downstream of authorization:

- `getSessionToken` → `vi.fn()` resolving `{ token: 'tok-1', … }` (mock at ~:70, wired ~:80, default
  ~:136). **The whole mint — `buildPersonaConfig`, every `cfg?.x?.trim()`, the vendor fetch — never
  runs.**
- `getProjectTranscript` → `vi.fn(async () => null)` (~:66), so `withTranscriptKnowledge` returns
  at its first line and never touches `cfg.knowledge`.
- `enrichAvatarConfigFromAnam` → identity `vi.fn` (~:80), and the caller wraps it in `.catch`.

Consequence: an end-to-end test in this file can only prove *authorization, metering, body
validation and status plumbing*. It cannot prove anything about what the start handler does with
the config's VALUES. Measured, not assumed: the six-case "a poisoned avatar_config is a config
problem, never a 500" block added by PR #127 passes **unchanged against a checkout that has no
sanitizer at all** — I ran the PR's own file against the pre-fix tree.

**How to apply.** When someone claims a controller-seam behaviour is "covered by an E2E test in the
spend-guard suite", check which of the three stubs above stands between the assertion and the code.
Two ways to make such a test load-bearing: assert on the argument handed to the mock
(`spend.getSessionToken.mock.calls.at(-1)![1]`), or put the test in
`services/avatar/__tests__/` where `getSessionToken` is real and only `globalThis.fetch` is stubbed
(that is where PR #127's five mint tests live, and those DO die when the sanitizer is removed).

Technique that produced this: copy the test blob out of the PR sha, rewrite its relative specifiers
to absolute worktree paths with `sed`, and run it with an out-of-tree vitest config whose `include`
points at the scratchpad. Needs no edit to the repo and no checkout — see
[[review-the-pr-sha-not-the-worktree]].

Related: [[anam-start-path-latency]]
