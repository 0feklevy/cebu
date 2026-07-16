# Release report — v0.1.1

| Field | Value |
| --- | --- |
| Run ID | rel-9916000000-1 |
| Final state | ROLLED_BACK |
| Requested bump | patch |
| Deploy requested | true |
| Backfill policy | report-only |
| Version | v0.1.1 |
| Previous release | v0.1.0 |
| Git SHA | 56f5130f68204c13d29552b3c96b6648c45c7205 |
| Actor | 0feklevy |
| Workflow run | https://github.com/0feklevy/cebu/actions/runs/9916000000 |
| Started | 2026-07-15T21:00:00Z |
| Ended | 2026-07-15T21:52:10Z |

## Stages
| Stage | Status | Duration |
| --- | --- | --- |
| PLANNED → SOURCE_VERIFIED | success | 0.5s |
| SOURCE_VERIFIED → TESTED | success | 0.6s |
| TESTED → IMAGES_BUILT | success | 0.5s |
| IMAGES_BUILT → IMAGES_PUBLISHED | success | 0.5s |
| IMAGES_PUBLISHED → MIGRATIONS_PLANNED | success | 0.6s |
| MIGRATIONS_PLANNED → AWAITING_APPROVAL | success | 0.6s |
| AWAITING_APPROVAL → DEPLOYING | success | 0.6s |
| DEPLOYING → MIGRATED | success | 0.5s |
| MIGRATED → SERVICES_RECREATED | success | 0.5s |
| SERVICES_RECREATED → HEALTHY | success | 0.5s |
| HEALTHY → FAILED | failure | 0.5s |
| FAILED → ROLLED_BACK | success | 0.6s |

## Verdict
- Blocked: **YES** — **rollback required**
- Findings: 3 critical / 0 high / 0 warning
- 3 CRITICAL finding(s) — release policy always blocks on CRITICAL.

## Findings (most severe first)
|  | Severity | Area | Finding | Remediation |
| --- | --- | --- | --- | --- |
| 🟥 | CRITICAL | csp | client-web: frame-src does not allow https://cebu-1a10f.firebaseapp.com (the Firebase Auth iframe — sign-in breaks without it). — frame-src is: 'self' https://api.flowvidco.com https://js.stripe.com | Fix shared/src/csp.ts inputs (never widen with wildcards). |
| 🟥 | CRITICAL | csp | page https://flowvidco.com/#login: CSP violation. — frame-src blocked https://cebu-1a10f.firebaseapp.com/__/auth/iframe on https://flowvidco.com/ | — |
| 🟥 | CRITICAL | browser | 1 production browser test(s) failed. — audit: login entry point + Firebase auth iframe initiation | — |

## Images (immutable digests)
| Service | Repository | Tag | Digest |
| --- | --- | --- | --- |
| backend | ghcr.io/0feklevy/cebu/backend | v0.1.1 | sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa |
| client-web | ghcr.io/0feklevy/cebu/client-web | v0.1.1 | sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb |
| admin-web | ghcr.io/0feklevy/cebu/admin-web | v0.1.1 | sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc |

## Deployment

| Endpoint | URL | HTTP | OK |
| --- | --- | --- | --- |
| app | https://flowvidco.com | 200 | ✅ |
| api-health | https://api.flowvidco.com/health | 200 | ✅ |
| admin | https://admin.flowvidco.com | 200 | ✅ |

## Browser verification (Playwright)
- 6 passed / 1 failed / 2 skipped
- ❌ audit: login entry point + Firebase auth iframe initiation

## Rollback
- Target: v0.1.0
- Result: restored and healthy ✅

## First failure
- Test: `audit: login entry point + Firebase auth iframe initiation`

## Recommended remediation
1. Fix shared/src/csp.ts inputs (never widen with wildcards).
