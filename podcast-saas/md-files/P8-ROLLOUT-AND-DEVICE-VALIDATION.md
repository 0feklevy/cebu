# Priority 8 — rollout, kill switches, and device validation

This is the operational half of Priority 8. It states what can be turned off, in what order things
should be enabled, and — importantly — what has **not** been validated and cannot be claimed.

## 1. What actually shipped, and what is inert

| Capability | State on merge | How it turns on |
|---|---|---|
| Transition measurement (`SimRuntimeClient` marks) | **Active** | Always on. In-memory only; nothing leaves the browser. |
| RUM collection | **Inert** | `admin_settings.rum_sample_rate` (default `0`), or `SIM_RUM_SAMPLE_RATE`. |
| RUM ingestion endpoint | **Registered, refuses writes** | Always registered — see §2. Ingestion is gated on the same rate, so at 0 nothing is stored even by a hostile caller. |
| RUM retention sweep | **Running** | Started at boot; hourly, `unref`'d. |
| Prepare budgets in the player config | **Emitted for newly canaried packages** | Derived when a canary verdict is recorded. Absent for every package canaried BEFORE this change — the column is only populated going forward, so existing packages need a re-canary to gain one. |
| Occurrence planner / predictive admission | **Wired, OFF** | `admin_settings.sim_scheduler_mode = 'predictive'` (default `'off'`). |
| rVFC boundary sentinel | **Wired, OFF** | `admin_settings.sim_boundary_sentinel = true` (default `false`). |
| Adaptive quality | **Wired, OFF** | `admin_settings.sim_adaptive_quality = true` (default `false`). |
| Package weight analysis | **Active** | Recorded at publication; advisory, never blocks. |

The first three reach a real viewer only when their switch is turned on, and **migration 052 defaults
every one of them to today's behaviour** — so applying it changes nothing for anybody. With all
switches at their defaults, merging this branch changes viewer behaviour in exactly two ways:
transition timings are recorded in memory, and the player config carries the new fields.

**What "wired" is allowed to mean here:** each call site emits its own evidence, and an e2e test
asserts on that evidence with the switch on (`P8a`–`P8e` in `viewer-e2e.spec.ts`). Deleting any one
call site turns its test red — verified by mutation, one mutation per call site, all five killed.
That is the difference between this and the previous state of this document, when these were tested
libraries that nothing called.

**Still true:** proven on desktop Chromium, Firefox and WebKit only. See §5.

## 2. Why the RUM route is always registered

Gating the *route* on the sample rate would mean flipping the switch requires a deploy, which is the
property the switch exists to avoid. So the route is registered unconditionally — and **ingestion
checks the same rate before storing anything**.

Both halves are needed. "No honest client sends at rate 0" is not the same as "nothing is stored":
the endpoint is unauthenticated with a wildcard CORS origin, so without the server-side gate any
caller could persist rows on every deployment (all of which sit at 0) and poison the per-package
percentiles the rest of Priority 8 is built to consume. The route is additionally rate-limited per
IP.

## 3. Kill switches

| Switch | Scope | Effect when off | Requires deploy? |
|---|---|---|---|
| `admin_settings.rum_sample_rate = 0` | All viewers | No RUM events are recorded or sent | No |
| `SIM_RUM_SAMPLE_RATE` env | Per instance | Overrides the column, including to 0 | Restart only |
| `admin_settings.sim_pool_mode = 'single'` | All viewers | Existing pool kill switch, unchanged | No |
| Migration 051 rollback | Everything RUM | Column absent → resolver returns 0 | **Yes — see below** |

Every layer fails **closed**. An unparseable env var is 0, a missing column is 0, a database error is
0. There is no path that enables collection by accident.

`admin_settings.rum_retention_days` is bounded `[1, 365]` at the DDL. Zero would silently disable
retention and let the table grow without bound; no upper bound would let one careless `UPDATE` turn a
30-day dataset into a permanent one.

## 4. Suggested enablement order

Each step is independently reversible and observable before the next.

1. **Apply 050 and 051.** Both are strictly additive. Every simulation gets
   `active_revision_id = NULL`, which is precisely the state `packageRevisionFor` falls back for, so
   identity, posters and canary verdicts are unchanged. Nothing serves differently.
2. **Raise `rum_sample_rate` to 0.01** for a day. Confirm rows arrive, confirm the reaper runs,
   confirm no client-side errors. One percent of sessions is enough to detect a broken transport and
   too few to matter if it is.
3. **Raise to 0.05–0.10.** Enough volume for per-package percentiles. Leave it here.
4. **Read the data before building on it.** Specifically: is same-package switching slow enough to
   justify the protocol work that was deliberately dropped, and what fraction of sessions actually
   have `requestVideoFrameCallback`? Both are currently unknown — see §6.
5. **Publish one simulation as a revision** with `migrate-sim-revisions.ts`. It never activates.
6. **Canary and re-capture posters** for the new identity, then activate that one simulation.
   Activation changes the identity axis, and every existing `sim_posters` row is keyed on the old
   value with no fallback in the lookup — so activating first would leave that package posterless.
7. **Verify rollback on that one simulation** before widening.

## 5. Device validation — what has and has not been tested

**Tested:** Chromium, Firefox and WebKit via Playwright on macOS arm64, `workers=1`, `retries=0`,
`deviceScaleFactor` pinned to 1.

**NOT tested, and not claimable:**

- **No physical device has run any of this.** Desktop WebKit is not Safari on iOS: it differs in
  media autoplay policy, memory pressure behaviour, WebGL context-loss frequency, and background-tab
  throttling. Every one of those is directly relevant to the sim pool, and none is exercised here.
- **`requestVideoFrameCallback` support in the field is unknown** — but it is now *measurable* rather
  than requiring a separate study. The sentinel reports which mechanism armed (`boundary-armed`,
  `mode` = `rvfc` / `timeout` / `none`), so enabling the sentinel on a sample answers it directly.
  Nothing has been enabled, so the fraction is still unstated.
- **The WebKit build is frozen** on this host: Playwright reports it no longer receives updates on
  `mac14-arm64`. So WebKit results describe a *pinned* engine, not current Safari.
- **No low-memory device** has been exercised. `deviceMemory <= 4` already changes pool tier and
  destroy grace, and that branch is only unit-tested.

A real device matrix needs, at minimum: a recent iPhone (Safari), a mid-range Android (Chrome), and
one device with `deviceMemory <= 4`. Until then, mobile behaviour is inferred, not measured.

## 6. Questions this work makes answerable but has not answered

These were unanswerable before because nothing was measured. They are still unanswered, because
answering them requires field data that only step 3 produces.

- What is the p90 transition total, by pool tier and device bucket?
- Is same-package switching slow enough to justify a new child protocol? (The design dropped that
  work pending exactly this number; re-open only above roughly 150 ms.)
- What fraction of sessions have rVFC? (Now instrumented — see §5 — but not yet collected.)
- Which packages are heaviest, and does weight correlate with the measured p90?

## 7. Rollback

Every piece reverses independently:

- RUM: set the sample rate to 0. Instant, no deploy.
- Migration 051: **deploy first, then run the rollback file.** The RUM resolvers tolerate the
  missing columns, but four other call sites read `admin_settings` with no explicit `columns` list
  (`rate-limit.ts`, `platform.controller.ts` — which is public and unauthenticated —
  `settings.controller.ts`, `llm-config.controller.ts`). Drizzle selects every column declared in
  `schema.ts` for those, so dropping the columns under an image that still declares them raises
  `42703` on each. The rollback file's own header states this order.
- Migration 050: run the rollback file. **Read its header first.** Any simulation already activated
  onto a revision reverts to whatever its legacy mutable prefix last held, which is a data-visible
  regression rather than a crash if a newer package was only ever published as a revision.
- Migration 052: set `sim_scheduler_mode = 'off'`, `sim_adaptive_quality = false`,
  `sim_boundary_sentinel = false`. Instant, no deploy — which is the whole reason each one is a
  column rather than a constant. Dropping the columns needs the same deploy-first ordering as 051.
