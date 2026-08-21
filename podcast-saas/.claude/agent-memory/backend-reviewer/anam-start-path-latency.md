---
name: anam-start-path-latency
description: The "Anam avatar comes up VERY VERY slowly" investigation (run 2026-08-15T2109) — root cause ranked, and the measurement technique that produced real numbers without touching the vendor API
metadata:
  type: project
---

User-reported production complaint, investigated 2026-08-16 in run
`.claude/review/runs/2026-08-15T2109/findings/anam-backend.md` (ids `anam-backend-001..014`).

**Root cause, ranked #1:** `controllers/v1/avatar.controller.ts:197` discards the pre-baked
per-video Anam `personaId` whenever the project has a caption transcript but no `knowledgeToolId`.
That converts a 1-round-trip stateful mint (118-byte body) into a 2–6-round-trip ephemeral mint
carrying a ~30 KB inline persona, on every single avatar open. Introduced by commit **b06feb4**
(2026-07-30, "avatar video knowledge + live Anam defaults") — which is the "when did it get slow"
anchor if the complaint recurs.

**Why:** the persona is already created at save time by `PUT /avatar/config` →
`upsertVideoPersona`. Line 197 makes that precomputation pointless.

**Measurement technique that worked** (reusable, and it produced numbers rather than opinions):
run `services/avatar/anamService.ts` under `tsx` with `globalThis.fetch` stubbed to record each
URL/method/body-size and sleep a fixed `SIM_RTT_MS`. Wall-time ÷ RTT gives the *depth* of the
sequential waterfall, which is the number that matters and is independent of the vendor's real
latency. Same stubbing style as `services/avatar/__tests__/anamStaleFallback.test.ts:12`. Never
calls the real Anam API and needs no key. **Gotcha:** `ANAM_*` values must be set as real process
env vars — `ANAM_ENV`/`PERSONA_MAP` (`anamService.ts:12,30`) snapshot `process.env` at import, so
mutating `ANAM_ENV` in code silently skips the base-persona branch.

**How to apply:** if avatar latency is raised again, check whether 001 was actually fixed before
re-investigating; then re-run the harness rather than reasoning about the waterfall from source.
An escalation that the slowness is an accumulating concurrency-slot leak was investigated and
**refuted** — see [[anam-session-semantics]].
