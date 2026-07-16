# FlowVid Release Autopilot — Operator Guide

Deterministic, non-AI release system for the FlowVid repository
(`github.com/0feklevy/cebu`, app root `podcast-saas/`). A normal release requires **no
local terminal commands and no AI model**: merge to main → run the *Release FlowVid*
workflow → pick a bump → review the plan → approve the `production` environment →
receive `release-report.{md,json}`.

Companion documents: [PLAN.md](./PLAN.md) (architecture + dependency graph),
[samples/](./samples/) (a successful report and the Firebase-CSP failure report).

---

## 1. Architecture summary

- **`.github/workflows/`** (repo root — GitHub requirement)
  - `ci.yml` — PRs + main: `pnpm release:verify` (frozen install → typecheck →
    non-interactive lint → tests → prod builds with explicit URLs → bundle localhost
    scan) + secret scan + migration audit + Dockerfile checks + incident regressions.
  - `release.yml` — the release pipeline (details in §3).
  - `rollback.yml` — digest-resolved restore of any previous GHCR release.
  - `production-audit.yml` — manual + daily read-only audit; red on CRITICAL.
- **`podcast-saas/ops/release/`** — the TypeScript decision engine (`release-cli`):
  semver, preflight, secret scan, migration audit, semantic CSP audit, image-digest
  manifest, VM/browser/DB-URL audits, severity gate, state machine, report assembly,
  SSH adapter. 135 unit/integration tests; runs inside `pnpm -r test`, so the release
  gate self-tests on every release.
- **`podcast-saas/deploy/scripts/`** — VM-side thin shell:
  - `deploy-images.sh` — pull exact `repo@sha256:…` from GHCR, verify, retag to
    `podcast-saas/<svc>:<version>`, migrate, `compose up --no-build`, health-gate,
    auto-rollback. **The VM never compiles on this path.**
  - `production-audit.sh` — read-only JSON snapshot (containers, /health, worker,
    certs, DB-URL audit).
  - `run-backfill.sh` — policy-gated URL repair (report/apply) with JSON output.
  - `deploy.sh` — the OLD build-on-VM path, kept ONLY as a documented emergency
    fallback (§16).
- **State machine** — `PLANNED → SOURCE_VERIFIED → TESTED → IMAGES_BUILT →
  IMAGES_PUBLISHED → MIGRATIONS_PLANNED → AWAITING_APPROVAL → DEPLOYING → MIGRATED →
  SERVICES_RECREATED → HEALTHY → BROWSER_VERIFIED → RELEASED`, with `FAILED →
  ROLLED_BACK`. Persisted as `state.json` in the run artifacts; non-idempotent stages
  (publish images, migrate, publish release) refuse silent reruns.
- **Claude Code support** (`.claude/agents/release-auditor|migration-auditor|
  incident-reporter.md`, `.claude/skills/release-audit/`) — read-only explainers over
  the JSON reports. They have **no role at release time** and cannot deploy, approve,
  read secrets, apply migrations/backfills, or bypass checks.

## 2. Threat model (what the system defends against)

| Threat | Defense |
| --- | --- |
| Secrets committed / printed / uploaded | Path+content secret scan on tracked files (CRITICAL, blocks); report redaction (credential shapes, URL creds, secret-named keys); env files never read; no env artifacts; GHCR token via stdin only; no `set -x` near secrets |
| Wrong code released | Releases only from `origin/main` HEAD, clean tree, immutable tags (never moved/reused), preflight fails closed |
| Supply-chain drift between build and deploy | Images pinned by sha256 digest end-to-end; VM re-verifies `RepoDigests` before retagging; foreign registries/namespaces and `latest` tags rejected |
| Dev config in prod bundles (the v0.1.1 incident) | `.env.local` isolation with trap-restore, fail-closed `resolvePublicUrl`, bundle localhost scan, CI builds from clean checkouts with explicit public URLs |
| Browser-visible localhost / private / docker hosts | Host classifier used in bundle scan, CSP audit, DB-URL audit, and live browser audit; any occurrence post-deploy is CRITICAL → rollback |
| CSP regressions (frame-src vs frame-ancestors) | Semantic per-directive audit (static + live) with exact required origins (self, api, Stripe, Firebase auth); wildcards/http/localhost rejected; browser-level `securitypolicyviolation` capture |
| Destructive / drifting migrations | Static audit: new files vs base tag, checksums (history rewrites CRITICAL), runner-list drift CRITICAL, destructive HIGH (needs `approve_high`), `CONCURRENTLY` CRITICAL (runner-incompatible) |
| Unsafe data repairs | Safe-backfill contract: dry-run plan, per-row backup with run-id, would-null/missing-asset/threshold blocks, report-only default, post-apply convergence check |
| False-green health checks | Release success requires the Playwright browser suite + audits to pass; HTTP 200 alone can never conclude a release |
| Failed deploys | VM health-gate with automatic rollback to retained previous images; post-deploy CRITICAL → automatic rollback from the workflow; single-flight concurrency |
| Compromised PR / fork | Workflows: `contents: read` default; `packages: write` only on the image job; `contents: write` only on tag/publish jobs; production secrets environment-scoped behind required reviewers; release only via `workflow_dispatch` on main |

## 3. Exact workflow: merge → release

1. Merge your PR into `main` (CI must be green).
2. GitHub → **Actions → Release FlowVid → Run workflow** on `main`.
3. Inputs: `bump` = patch/minor/major; `deploy` = true; `backfill_policy` =
   report-only (default) / allow-safe / require-approval; `approve_high` only when a
   reviewed destructive migration or unsafe backfill must proceed.
4. Pipeline (automatic): plan (next semver; tag-collision rejected) → preflight +
   secret scan + migration audit + pre-build gate → `release:verify` → three buildx
   builds on GitHub runners (gha cache) pushed to GHCR as `vX.Y.Z` + `sha-<sha>` →
   digests recorded into the manifest → annotated tag pushed + **draft** GitHub
   release → **release plan appears in the job summary**.
5. Review the plan (digests, migration plan, backfill policy), then approve the
   **production** environment on the `deploy` job.
6. Deploy: VM checkout pinned to the release SHA → `deploy-images.sh` (pull by
   digest, verify, retag, migrate, recreate, health-gate) → policy-gated backfill →
   VM/endpoint/CSP/browser verification → post-deploy gate.
7. On success the GitHub release is published; `release-report.{md,json}` is uploaded
   as the `release-report` artifact and summarized in the job summary. On CRITICAL
   failure the workflow rolls production back automatically and reports `ROLLED_BACK`.

## 4. GitHub repository settings to configure manually

1. **Actions → General**: Workflow permissions = *Read repository contents* (jobs
   escalate per-job); allow GitHub Actions to create pull requests: off.
2. **Environments**:
   - `production` — **Required reviewers**: you (and any co-approver). This is the
     production approval gate.
   - `production-audit` — no protection rules (the daily audit must not wait on a
     human). Holds the same read-only SSH secrets.
3. **Branch protection** on `main`: require the CI checks (Release verification gate,
   Static audits) before merge; forbid force pushes.
4. **Packages**: after the first release, set the three GHCR packages
   (`cebu/backend`, `cebu/client-web`, `cebu/admin-web`) to private (they inherit repo
   visibility on first push) and ensure the PAT below has read access.
5. **Tag protection** (optional but recommended): protect `v*` tags.
6. Delete the stray local/remote tag decision (§18, discovery D2) before the first run
   if you want the next release to be numbered differently.

## 5. Secrets and variables (names only)

**Environment `production` — secrets** (also copy the first three into
`production-audit`):
- `PRODUCTION_SSH_KEY` — private key of a dedicated deploy keypair for `ubuntu@44.225.68.155`
- `PRODUCTION_SSH_KNOWN_HOSTS` — the `ssh-keyscan -H 44.225.68.155` output (pins the host key)
- `GHCR_PULL_TOKEN` — fine-grained/classic PAT with **read:packages only** (used by the VM to pull)
- `SMOKE_ADMIN_EMAIL`, `SMOKE_ADMIN_PASSWORD` — optional least-privileged smoke account

**Repository (or environment) variables** (all public values, not secrets):
- `PRODUCTION_SSH_HOST` (44.225.68.155), `PRODUCTION_SSH_USER` (ubuntu),
  `PRODUCTION_REPO_DIR` (e.g. `/home/ubuntu/cebu`)
- `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`,
  `NEXT_PUBLIC_FIREBASE_PROJECT_ID`, `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`,
  `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`, `NEXT_PUBLIC_FIREBASE_APP_ID`
- `PUBLIC_BRAND_NAME`
- Optional smoke paths: `SMOKE_PUBLIC_PATH`, `SMOKE_PLAYLIST_PATH`, `SMOKE_ADMIN_PREVIEW_PATH`

**Never** stored in GitHub: `DATABASE_URL`, Supabase/Stripe/Firebase-admin/AI keys —
they stay in the VM's existing `.env` files; DB-touching audits run ON the VM.

## 6. GitHub permissions used

- Workflow default: `contents: read`.
- `release.yml/build-images`: `packages: write` (image push via `GITHUB_TOKEN`).
- `release.yml/release-plan` and `publish`: `contents: write` (annotated tag, draft →
  published release).
- `rollback.yml/resolve`: `packages: read`.
- Everything else: `contents: read` only. No other scopes anywhere.

## 7. How production approval works

The `deploy` job (and rollback's `rollback` job) targets the **`production`
environment**. GitHub pauses the job until a required reviewer approves it in the run
UI. Everything before approval is reversible (images and a draft release exist; the
VM is untouched). `concurrency: production-deploy` guarantees a single production
mutation at a time; a second release queues.

## 8. How rollback works

- **Automatic** — two layers: `deploy-images.sh` health-gates on the VM and rolls back
  to `PREVIOUS_VERSION` (retained local images) if services don't come up; the
  workflow's post-deploy gate rolls back on any CRITICAL browser/CSP/health finding
  and re-verifies health. Final state: `ROLLED_BACK` with a rollback section in the report.
- **Manual** — Actions → *Rollback FlowVid* → enter a version tag (e.g. `v0.1.2`) →
  digests resolved and verified from GHCR → production approval → digest-pinned
  restore of backend+worker+client-web+admin-web coherently (`--skip-migrations`) →
  full health + browser suite → rollback report.
- **Never**: automatic database schema rollback. Migrations are expand/contract so
  previous images run on the newer schema; manual reversals live in
  `backend-api/src/db/migrations/*.rollback.sql`.
- Pre-autopilot versions (built on the VM, e.g. short-sha tags) are restorable only
  via `./deploy/scripts/rollback.sh <short-sha>` on the VM while those local images
  are retained; GHCR-era versions are restorable forever.

## 9. How migrations and backfills are approved

**Migrations** — the audit runs in CI and in the release plan job. Findings:
additive → pass; lock-risk/data-modifying → WARNING (reported); destructive or
previous-image-breaking → HIGH (release blocks unless `approve_high=true`);
runner drift, history rewrite, out-of-order, `CONCURRENTLY` → CRITICAL (always
blocks). The reviewed migration plan (files, checksums, statements, tables,
transaction behavior) is part of the release-plan summary you approve. Applying
happens on the VM before containers swap; a failure aborts with the old version
still serving.

**Backfills** — `backfill_policy` input: `report-only` (default; dry-run JSON only),
`allow-safe` (apply only when the plan rewrites-only, nothing nulled, no missing
assets, under the row threshold — the VM script exits 2 otherwise), `require-approval`
(applies only when `approve_high=true` too, passing `--approve-unsafe`). Every apply
writes per-row backups with a run-id into `_url_backfill_backup` and re-counts
afterwards to prove convergence.

## 10. Running a dry-run locally

```bash
cd podcast-saas
pnpm install
# Offline end-to-end: real plan/secret-scan/migration-audit + fixtures; no secrets,
# no production access, no tags, no pushes. Exit 0 + report files on success.
pnpm --filter ops-release release-cli dry-run --out-dir /tmp/flowvid-dryrun
open /tmp/flowvid-dryrun/release-report.md

# Read-only live checks (GET requests only):
pnpm --filter ops-release release-cli csp-audit --app client-web
pnpm --filter ops-release release-cli endpoint-audit

# The full application gate (what CI and the release run):
pnpm release:verify
```

## 11. Triggering the first release from the GitHub UI

1. Configure §4 settings + §5 secrets/variables; push this branch and merge to main.
2. One-time on the VM: verify `git remote` can fetch (it already does), and that
   `deploy/.env` + root `.env` exist (they do — the running system uses them).
3. Actions → **Release FlowVid** → *Run workflow* → branch `main`, `bump: patch`,
   `deploy: true`, `backfill_policy: report-only` → *Run*.
4. Watch `plan`/`verify`/`build-images` complete; read the release plan summary.
5. Approve the **production** deployment when prompted.
6. Download `release-report` from the run artifacts.

Note on numbering: tags `v0.1.1` **and `v0.1.2`** already exist on origin (v0.1.2 was
hand-tagged at the CSP fix but never released). The autopilot never reuses or moves
tags, so the first autopilot release will be **v0.1.3** — unless you first delete the
unreleased tag (`git push origin :refs/tags/v0.1.2 && git tag -d v0.1.2`), which is
your call, not the autopilot's.

## 12. Reports

Every attempt produces `release-report.md` + `release-report.json`
(schema `flowvid.release-report/v1`): run id, requested inputs, version, SHA, actor,
timestamps, per-stage durations (derived from the state history), source
verification, test/lint counts, image tags + digests, previous release, migration
plan, backfill plan/counts, deployment + service health, endpoint statuses,
Playwright results, CSP/asset/DB-URL findings, rollback status, severity counts,
gate reasons, first failing command/test, sanitized log locations, and remediation.
Concise summary → job summary; full files → artifacts. All content passes redaction;
no secrets or env dumps can appear.

See [samples/release-report.success.md](./samples/release-report.success.md) and
[samples/release-report.failed-firebase-csp.md](./samples/release-report.failed-firebase-csp.md)
(the v0.1.1 incident: endpoints all HTTP-200 — the old false-green — while the
browser CSP verification fails CRITICAL and the run ends `ROLLED_BACK`).

## 13. Severity policy

- **CRITICAL** (always blocks; post-deploy also rolls back): secret exposure, digest
  mismatch/foreign image, migration failure or runner-incompatible SQL, backend or
  public app down, browser using localhost/private hosts, CSP blocking a core flow
  (Firebase auth, Stripe, sims), auth broken, mixed content, failed rollback,
  missing/expired certificate, failed browser suite.
- **HIGH** (blocks unless `approve_high`): broken thumbnails/banners/sims/video,
  worker down, unexpected 5xx, page errors, would-null backfills, missing assets,
  threshold breaches, likely-destructive migrations, cert < 7 days, weakened
  frame-ancestors, required-resource 4xx.
- **WARNING** (reported; blocks only with `--block-on-warning`): lint warnings,
  console errors, failed optional requests, stale service workers, cert < 21 days,
  low disk, certbot paused.

## 14. Limitations (current, known)

1. **SSH transport** until the SSM/OIDC migration (§15); the key is environment-scoped
   and host-key-pinned, but it is still a long-lived credential.
2. **CI does not run Playwright against a production-like stack** (needs DB +
   storage); browser verification runs post-deploy and in the daily audit instead.
3. Test-count extraction in the release report is a best-effort parse of vitest
   output (suite-level totals; failures still hard-fail the gate itself).
4. `production-audit.sh` DB-URL audit needs an image with `--json` support (>= this
   branch); on older deployed images it reports `urlBackfill: null` + WARNING.
5. Rollback targets predating the autopilot exist only as VM-local images.
6. The severity gate cannot distinguish a *flaky* production browser test from a real
   failure beyond Playwright's own retries (2 in CI); a persistent flake blocks
   releases — by design, fix the flake.
7. GHCR-era assumption: repository namespace is hardcoded to `ghcr.io/0feklevy/cebu`
   in `ops/release/src/config.ts` (single source of truth; change it there).

## 15. Migration plan: SSH → AWS SSM/OIDC (phase two)

All release logic talks to the `Executor` interface (`ops/release/src/remote-deploy.ts`);
SSH is one implementation. To migrate:

1. Attach an instance profile to the EC2 VM with `AmazonSSMManagedInstanceCore`;
   verify the SSM agent (default on Ubuntu AMIs) is online.
2. Create an IAM OIDC identity provider for `token.actions.githubusercontent.com` and
   a role trusting `repo:0feklevy/cebu:environment:production` (and a read-only
   variant for `production-audit`), allowing `ssm:SendCommand`/`ssm:GetCommandInvocation`
   on that instance only.
3. Implement `SsmExecutor implements Executor` (~60 lines: SendCommand +
   GetCommandInvocation polling; stdin envelope becomes an SSM parameter file written
   to a 0600 temp path and deleted).
4. In the workflows: replace the write-SSH-key step with
   `aws-actions/configure-aws-credentials` (`permissions: id-token: write` on those
   jobs) and pass `--transport ssm` to the remote commands.
5. Delete `PRODUCTION_SSH_KEY`/`PRODUCTION_SSH_KNOWN_HOSTS` secrets; drop port 22 from
   the security group. No changes to release logic, VM scripts, or reports.

## 16. Emergency manual fallback (not the default)

If GitHub or GHCR is down and production must change NOW: SSH to the VM and use the
old source-build path — `cd cebu/podcast-saas/deploy/scripts && ./deploy.sh <ref>`
(slow: builds on the 908 MB VM) or `./rollback.sh <version>` for any retained local
version. Both keep their health gates. Afterwards, re-align the autopilot by running
a normal release so GHCR and the tags catch up.
