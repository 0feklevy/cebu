# Priority 8 — rollout, kill switches, and device validation

This is the operational half of Priority 8. It states what can be turned off, in what order things
should be enabled, and — importantly — what has **not** been validated and cannot be claimed.

## 1. What actually shipped, and what is inert

| Capability | State on merge | How it turns on |
|---|---|---|
| Transition measurement (`SimRuntimeClient` marks) | **Active** | Always on. In-memory only; nothing leaves the browser. |
| RUM collection | **Inert** | `admin_settings.rum_sample_rate` (default `0`), or `SIM_RUM_SAMPLE_RATE`. |
| RUM ingestion endpoint | **Registered, unused** | Always registered — see §2. |
| Prepare budgets in the player config | **Emitted** | Always emitted; absent for un-canaried packages. |
| Occurrence planner / predictive admission | **Library only** | Not yet wired into `useProjectPlayer`. |
| rVFC boundary sentinel | **Library only** | Not yet wired into `useProjectPlayer`. |
| Adaptive quality | **Library only** | Not yet wired. |
| Package weight analysis | **Library only** | Not yet called at publication. |

The last four are deliberately not wired. They are pure, tested modules with no caller, which means
merging this branch changes viewer behaviour in exactly two ways: transition timings are recorded in
memory, and the player config carries two new fields. Everything else is opt-in work for a follow-up
change that can be reviewed on its own.

**This is the honest reading of "shipped": the mechanisms exist and are proven in isolation; the
integration that would make them affect a viewer has not been written or tested.**

## 2. Why the RUM route is always registered

Gating the *route* on the sample rate would mean flipping the switch requires a deploy, which is the
property the switch exists to avoid. The route is registered unconditionally and is inert because no
client sends to it until `sim_rum_sample_rate > 0` reaches the player config.

## 3. Kill switches

| Switch | Scope | Effect when off | Requires deploy? |
|---|---|---|---|
| `admin_settings.rum_sample_rate = 0` | All viewers | No RUM events are recorded or sent | No |
| `SIM_RUM_SAMPLE_RATE` env | Per instance | Overrides the column, including to 0 | Restart only |
| `admin_settings.sim_pool_mode = 'single'` | All viewers | Existing pool kill switch, unchanged | No |
| Migration 051 rollback | Everything RUM | Column absent → resolver returns 0 | No |

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
- **`requestVideoFrameCallback` support in the field is unknown.** There is no browserslist config
  and no analytics in this repo, so the fraction of viewers that would get the frame-accurate
  boundary path rather than the timer fallback cannot be stated. Step 4 answers this.
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
- What fraction of sessions have rVFC?
- Which packages are heaviest, and does weight correlate with the measured p90?

## 7. Rollback

Every piece reverses independently:

- RUM: set the sample rate to 0. Instant, no deploy.
- Migration 051: run the rollback file. Safe at any time — the resolver treats the missing column
  as 0.
- Migration 050: run the rollback file. **Read its header first.** Any simulation already activated
  onto a revision reverts to whatever its legacy mutable prefix last held, which is a data-visible
  regression rather than a crash if a newer package was only ever published as a revision.
- The unwired modules: nothing to roll back — they have no callers.
