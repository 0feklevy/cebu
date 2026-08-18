# Deterministic evidence — run 2026-08-15T2109

Measured by the orchestrator directly, not by an agent. Commit `2d187e3` (main).
Every number here was produced by running the command shown.

## 1. The suite is green

| Check | Result |
|---|---|
| `pnpm -r typecheck` | **PASS** (exit 0), all six packages |
| `pnpm -r lint` | **PASS** (exit 0), 45 warnings in `backend-api` (unused vars, stale `eslint-disable`) |
| `pnpm -r test` | **PASS** (exit 0) |

Test counts by package:

| Package | Files | Tests |
|---|---|---|
| backend-api | 133 passed, 3 skipped | 2278 passed, 18 skipped |
| client-web | 57 | 1389 |
| ops/release | — | 340 |
| admin-web | 2 | 34 |
| shared, ops/ship | green | — |

Backend wall time 162s (1275s of test time across workers).

## 2. Playwright — every locally-runnable suite passes, and none of them run in CI

Ran with `--project=chromium` after `npx playwright install chromium` (the cache held
build 1234; `@playwright/test@1.60.0` wants 1223 — an environment mismatch, not a repo defect).

| Config | Result |
|---|---|
| `playwright.sim.config.ts` (sim-transitions) | **12 passed** (12.6s) |
| `playwright.transport.config.ts` | **9 passed** (12.8s) |
| `playwright.protocol.config.ts` | **16 passed** (1.1m) |
| `playwright.canary.config.ts` | **11 passed** (34.9s) |
| `playwright.rebuilt.config.ts` | **4 passed** (25.8s) |
| `playwright.leak.config.ts` | **12 passed** (47.2s) |

**64 E2E tests, all green, on one engine.** These suites are healthy and substantial —
`sim-protocol.spec.ts` is 111KB, `sim-leak.spec.ts` 99KB, `viewer-e2e.spec.ts` 96KB.

**None of them is invoked by any workflow.** Grepping `.github/workflows/**` for every config
name returns hits only for `playwright.production.config.ts`
(`ci.yml` does not run Playwright at all; `production-audit.yml:170,229`, `release.yml:436` and
`rollback.yml:166` all use the production config). The other seven configs appear only in
`md-files/*.md` as manual commands. A change that breaks the sim bridge, the transport handshake,
or the leak envelope is caught by no pipeline.

## 3. The default Playwright config points at production and collects everything

`client-web/playwright.config.ts` sets `testDir: './e2e'` with **no `testMatch`** and
`baseURL: process.env.SMOKE_BASE_URL ?? 'https://flowvidco.com'`.

```
$ npx playwright test --list
Total: 363 tests in 11 files
```

`client-web/package.json:12` defines `"test:smoke": "playwright test"` — the bare form. So
`pnpm --filter client-web test:smoke` aims 363 tests across 3 engines at the live site.

The team already knows this shape is dangerous: `playwright.production.config.ts` carries a
`testMatch` plus a comment explaining exactly this hazard, and
`ops/release/src/__tests__/audit-workflow-contract.test.ts:182` asserts that no *workflow* runs the
bare command. The guard covers CI. It does not cover the package script a developer would type.

## 4. Coverage: 54% — but the metric excludes the code that matters most

`pnpm --filter backend-api test:coverage` reports:

```
All files | 54 % stmts | 46.43 % branch | 55.04 % funcs | 55.82 % lines
```

That number describes **`src/services/**` only**. `backend-api/vitest.config.ts:48-49`:

```ts
coverage: {
  provider: 'v8',
  include: ['src/services/**/*.ts'],
  exclude: ['src/db/**'],
}
```

Not measured at all — 64 non-test source files:

| Excluded | Files | What lives there |
|---|---|---|
| `src/controllers/**` | 37 | every v1 + admin route, including `stripe-webhook.controller.ts` |
| `src/queue/**` | 7 | pg-boss driver, inline driver, registry, `startWorker` |
| `src/db/**` | 6 | explicitly excluded — including the migration runner |
| `src/lib/**` | 4 | `sse.ts`, `fetchWithRetry.ts`, logger |
| `src/middleware/**` | 3 | `firebase-auth`, `firebase-admin-required`, `rate-limit` — the whole authn/authz layer |
| `src/jobs/**` | 3 | `corpus.ingest`, `video.generate`, `video.transcode` |
| `src/config/**` | 2 | `trustProxy`, `publicOrigins` |
| `src/server.ts`, `src/worker.ts` | 2 | bootstrap + local-storage serving |

Overriding `coverage.exclude` also drops vitest's defaults, so at least one test directory is
counted as source: the table has a row `services/storage/__tests__ | 95.65 | 50 | 100 | 100`.

**You cannot tell from this report whether auth is tested.** That is the finding — not the 54%.

### Worst-covered service directories (within the measured scope)

| Directory | % stmts | Note |
|---|---|---|
| `services/security` | **0** | one file: `assertPublicHost.ts`, the SSRF guard — **no test file references it** |
| `services/usage` | 6.66 | usage metering |
| `services/audio` | 11.76 | |
| `services/billing` | **13.33** | money path |
| `services/secrets` | 19.14 | |
| `services/avatar` | 20.92 | |
| `services/podcast` | 28.61 | |
| `services/crop` | 38.80 | |

Zero-coverage files that read as authorization helpers: `collabAccess.ts`, `podcastAccess.ts`.

`services/security/assertPublicHost.ts` is called from exactly one place —
`services/ingestion/WebIngester.ts:8` — and that call site hands the URL to Firecrawl/Jina
rather than fetching it itself. Whether the process's own user-URL fetches are guarded is
`security-reviewer`'s call; the measurable fact is that the guard has no tests.

## 5. Release-engine static audits

| Audit | Result |
|---|---|
| `release-cli secret-scan` | 816 files scanned, **0 findings** |
| `release-cli migration-audit --base-ref v0.1.26` | 0 new files, 12 findings — **all INFO**, all `migrations.rollback-helper`. No runner drift. |
| `release-cli coverage-report` | Not runnable locally: every surface needs `SMOKE_*` production inputs. It refuses cleanly rather than guessing — correct behaviour. |

The `stack.md` claim that all forward migrations are present in the hardcoded runner list
**re-verified clean** on `main` at `2d187e3`.

## 6. Structural measurements

Largest non-test source files:

| Lines | File |
|---|---|
| **4042** | `podcast-saas/client-web/components/viewer/useProjectPlayer.ts` |
| 3368 | `podcast-saas/backend-api/src/services/simulation/SimulationService.ts` |
| 3145 | `podcast-saas/client-web/components/SectionEditor.tsx` |
| 2460 | `podcast-saas/client-web/lib/sim/SimRuntimeClient.ts` |
| 2292 | `podcast-saas/client-web/components/TimelinePanel.tsx` |
| 2271 | `podcast-saas/backend-api/src/services/project/ProjectDuplicationService.ts` |
| 1667 | `podcast-saas/shared/src/generated/client-v1.ts` (hand-maintained) |
| 1453 | `podcast-saas/backend-api/src/db/schema.ts` |

`useProjectPlayer.ts` is a **single exported hook**: 26 `useRef`, 16 `useCallback`, 7 `useEffect`,
**0 `useState`, 0 `useMemo`**, 478 declared functions, and a four-interface public surface
(`ProjectPlayerRefs` / `State` / `Actions` / `Options`, lines 110/126/201/304).
All-refs-no-state is a deliberate choice for a frame-accurate player, but it means this is an
imperative state machine wearing a hook's clothes, and it is the largest single structural
liability in the frontend.

## 7. Working-tree hygiene

`podcast-saas/backend-api/src/services/export/capture/localCaptureProvider.ts` — 330 lines,
implements `SimCaptureBackend`, exports `resolveLocalCaptureProvider()`, and is **untracked**.
Nothing in tracked code imports it, so it does not break CI. It is invisible to CI, to review,
and to the container image. Note that `capture/isolation/main.ts:71` loads its backend from
`EXPORT_CAPTURE_BACKEND_MODULE` at runtime, so a local `.env` *could* point at this file while
production could not — finish wiring it or delete it.

Also untracked at repo root: `claim-demo.sh`, `claim-demo-watch.sh`, `.claim-demo-watch-long.sh`,
`run-local-capture.sh`, `LOCAL-CAPTURE-README.md`.

## 8. `podcast-saas/CLAUDE.md` actively poisons agent context

`stack.md` already flags it as stale boilerplate. It is worse than inert: during this run the
file was auto-loaded into the orchestrator's context as project instructions, asserting managed
**MySQL**, `mysql2`, GoDaddy Node.js Hosting, `npm start`, and "monorepos are not supported" — for
a pnpm monorepo on Postgres deployed by Docker Compose. Any agent or human that trusts it reasons
about the wrong database. This is the exact failure mode `stack.md` was created to prevent, still
sitting in the filename that tooling loads by default.
