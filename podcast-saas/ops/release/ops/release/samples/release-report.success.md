# Release report — v0.1.3

| Field | Value |
| --- | --- |
| Run ID | rel-9917244101-1 |
| Final state | RELEASED |
| Requested bump | patch |
| Deploy requested | true |
| Backfill policy | allow-safe |
| Version | v0.1.3 |
| Previous release | v0.1.2 |
| Git SHA | 255d06fd9b195dde0a0c2f97f8adcf0d66c2733e |
| Actor | 0feklevy |
| Workflow run | https://github.com/0feklevy/cebu/actions/runs/9917244101 |
| Started | 2026-07-20T09:00:00Z |
| Ended | 2026-07-20T09:41:30Z |

## Stages
| Stage | Status | Duration |
| --- | --- | --- |
| PLANNED → SOURCE_VERIFIED | success | 0.5s |
| SOURCE_VERIFIED → TESTED | success | 0.5s |
| TESTED → IMAGES_BUILT | success | 0.5s |
| IMAGES_BUILT → IMAGES_PUBLISHED | success | 0.5s |
| IMAGES_PUBLISHED → MIGRATIONS_PLANNED | success | 0.5s |
| MIGRATIONS_PLANNED → AWAITING_APPROVAL | success | 0.5s |
| AWAITING_APPROVAL → DEPLOYING | success | 0.5s |
| DEPLOYING → MIGRATED | success | 0.5s |
| MIGRATED → SERVICES_RECREATED | success | 0.5s |
| SERVICES_RECREATED → HEALTHY | success | 0.5s |
| HEALTHY → BROWSER_VERIFIED | success | 0.5s |
| BROWSER_VERIFIED → RELEASED | success | 0.5s |

## Verdict
- Blocked: **no**
- Findings: 0 critical / 0 high / 0 warning

## Findings
None. ✅

## Tests
| Suite | Total | Passed | Failed | Skipped |
| --- | --- | --- | --- | --- |
| vitest (all workspaces) | 687 | 687 | 0 | 0 |

## Images (immutable digests)
| Service | Repository | Tag | Digest |
| --- | --- | --- | --- |
| backend | ghcr.io/0feklevy/cebu/backend | v0.1.3 | sha256:1111111111111111111111111111111111111111111111111111111111111111 |
| client-web | ghcr.io/0feklevy/cebu/client-web | v0.1.3 | sha256:2222222222222222222222222222222222222222222222222222222222222222 |
| admin-web | ghcr.io/0feklevy/cebu/admin-web | v0.1.3 | sha256:3333333333333333333333333333333333333333333333333333333333333333 |

## Migration plan
```json
{
  "summary": {
    "newCount": 1,
    "destructiveCount": 0,
    "runnerListCount": 47,
    "diskCount": 47
  },
  "newMigrations": [
    {
      "name": "047_release_autopilot_marker.sql",
      "checksum": "9d5c…",
      "statements": 1,
      "classes": [],
      "tables": [
        "app_meta"
      ],
      "transactional": true
    }
  ]
}
```

## Deployment

| Endpoint | URL | HTTP | OK |
| --- | --- | --- | --- |
| app | https://flowvidco.com | 200 | ✅ |
| api-health | https://api.flowvidco.com/health | 200 | ✅ |
| admin | https://admin.flowvidco.com | 200 | ✅ |

## Browser verification (Playwright)
- 7 passed / 0 failed / 2 skipped
