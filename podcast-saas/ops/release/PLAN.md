# FlowVid Release Autopilot — Implementation Plan

Deterministic, non-AI release system. GitHub Actions + a small TypeScript engine
(`ops/release`) + thin shell adapters for OS/SSH/Docker. No model is called at release
time. The production VM never compiles the application on the normal release path.

## Established facts (inspection, 2026-07-16)

| Area | Fact |
|---|---|
| Git root | `cebu/` — workflows must live at `cebu/.github/workflows/` (GitHub requirement; app root is `cebu/podcast-saas/`) |
| Package manager | pnpm 11 / lockfile v9; **no `packageManager` pin** → pin it for determinism |
| Node | engines `>=22`; Docker images `node:22-bookworm-slim` → CI uses Node 22 |
| Images today | Built ON the VM (`compose build`), tagged `podcast-saas/<svc>:<git-short-sha>`; worker reuses the backend image |
| Rollback today | `rollback.sh <version>` re-points `APP_VERSION` at a retained local tag — no rebuild; state in `deploy/.deploy-state` |
| Migrations | Ordered `.sql` list **hardcoded in `src/db/migrate.ts`** (drift auditable), applied via `dist/db/migrate.js`; tracking table `schema_migrations` |
| Backend image | Contains compiled `dist/scripts/**` → report-only DB audits can run on the VM; `DATABASE_URL` never leaves the VM |
| Release gate | `pnpm release:verify` (frozen install → typecheck → non-interactive lint → tests → prod builds with explicit URLs → bundle scan; isolates `.env.local` with trap-restore) — preserved as-is and reused in CI |
| CSP | Built by pure `shared/src/csp.ts` in both `next.config.ts` (fail-closed `resolvePublicUrl`); fix commit `255d06f` exists on the branch; **production v0.1.1 does NOT have it** → live CSP audit must flag it |
| Certbot | Renewal-loop entrypoint; one-off runs MUST use `compose run --rm --entrypoint certbot certbot …` (already fixed in `init-ssl.sh`; add regression check) |
| Known URL columns | `projects.thumbnail_url`, `image_files.original_url`, `audio_files.url`, `playlists.banner_url`, `avatar_visuals.image_url`, `avatar_visuals.sim_entry_url`, `simulations.entry_file`, `timeline_sections.simulation_url`, `corpora.storage_url`, `branch_edges.thumbnail_url`; backups in `_url_backfill_backup` |

## Architecture

```
cebu/.github/workflows/
  ci.yml                     PRs + main: frozen install, typecheck, lint, tests,
                             prod builds + bundle scan, migration audit, secret scan
  release.yml                workflow_dispatch(bump, deploy, backfill_policy)
  rollback.yml               workflow_dispatch(version) — digest-resolved rollback
  production-audit.yml       manual + daily schedule — read-only audit

cebu/podcast-saas/ops/release/          pnpm workspace package "ops-release"
  src/
    cli.ts            subcommand entry (plan | preflight | secret-scan | migration-audit |
                      csp-audit | db-url-audit | asset-audit | image-manifest | severity-gate |
                      state | report | dry-run)
    config.ts         single source of truth: domains, image repos, service names,
                      thresholds, required CSP origins, known URL columns, policies
    semver.ts         SemVer parse/compare/bump + next-tag calc + existing-tag rejection
    hosts.ts          loopback / RFC1918 / *.localhost / 0.0.0.0 / ::1 / docker-service
                      host detection (shared by every audit)
    severity.ts       CRITICAL/HIGH/WARNING findings + release policy evaluation
    state-machine.ts  explicit release states + legal transitions + persisted state.json
    report.ts         release-report.{md,json} assembly
    redact.ts         secret masking for anything that enters a report/summary
    preflight.ts      source verification (on origin/main, clean, tag free, pins present)
    secret-scan.ts    tracked-path denylist + content patterns (git ls-files based)
    migration-audit.ts new files vs base ref, order, checksums, destructive SQL classes,
                      transaction behavior, migrate.ts-list drift
    database-url-audit.ts consumes VM backfill JSON (report mode) → findings vs policy
    csp-audit.ts      semantic CSP parsing; static (from shared/src/csp.ts inputs) and
                      live (fetch header) modes; per-directive requirements
    asset-audit.ts    consumes Playwright audit JSON + optional HEAD checks → findings
    image-manifest.ts immutable digest manifest build/validate/compare
    remote-deploy.ts  Executor interface + SSH adapter (swap for SSM later without
                      touching release logic)
    gha.ts            GitHub Actions outputs/summary helpers (masked)
  src/__tests__/      unit + integration (mocked SSH/manifests/reports) + dry-run e2e

cebu/podcast-saas/deploy/scripts/
  deploy-images.sh    VM: GHCR login → pull by digest → verify → retag to
                      podcast-saas/<svc>:<version> → migrate → recreate → health-gate →
                      auto-rollback. NEVER builds.
  production-audit.sh VM: container health, internal /health, worker liveness,
                      DB URL audit (report-only JSON). Read-only.
```

### Deliberate deviations from the suggested layout

1. **Workflows live at `cebu/.github/`, not `podcast-saas/.github/`** — GitHub only reads
   workflows from the repo root. Jobs set `working-directory: podcast-saas`.
2. **`ops/release` is a pnpm workspace package** — so `pnpm -r typecheck|lint|test`
   (already the release gate) covers the release system itself; the autopilot self-tests
   on every release.
3. **VM keeps the existing compose/state machinery.** `deploy-images.sh` pulls GHCR
   images by digest, verifies, then retags locally to `podcast-saas/<svc>:<version>`.
   The proven `rollback.sh`, `.deploy-state`, and compose file keep working unchanged;
   the only change on the VM is *where images come from*. `deploy.sh` (source build)
   remains as the documented emergency fallback only.
4. **DB-touching audits execute on the VM** via the compiled scripts already inside the
   backend image (report-only), returning JSON over SSH. `DATABASE_URL` and all app
   secrets never enter GitHub.
5. **Playwright production suite stays in `client-web/e2e/`** (extends the existing
   `production-smoke.spec.ts` instead of a new harness package).

## Release flow (merge → release)

```
merge to main
  └─ ci.yml (must be green)
release.yml dispatch(bump, deploy, backfill_policy)
  PLANNED           plan: verify dispatched ref is origin/main HEAD, compute next semver,
                    reject existing tag, emit plan.json
  SOURCE_VERIFIED   preflight + secret-scan + migration-audit (static)
  TESTED            release-verify gate (frozen install → … → bundle scan) on the runner
  IMAGES_BUILT      buildx (gha cache) backend/client-web/admin-web
  IMAGES_PUBLISHED  push ghcr.io/0feklevy/cebu/{backend,client-web,admin-web}
                    tags: vX.Y.Z + sha-<full-sha>; record immutable digests; manifest.json
  MIGRATIONS_PLANNED annotated tag vX.Y.Z pushed + draft GitHub Release + release plan
                    to job summary
  AWAITING_APPROVAL GitHub Environment "production" manual approval (deploy=true only)
  DEPLOYING         ssh → deploy-images.sh --manifest … (pull digests, verify, retag)
  MIGRATED          migrate.js on VM (old images still serving)
  SERVICES_RECREATED compose up -d (no build)
  HEALTHY           health-check.sh + endpoint probes
  BROWSER_VERIFIED  Playwright production suite from the runner (CSP, localhost, assets)
  RELEASED          publish GitHub Release; final report
  FAILED/ROLLED_BACK any CRITICAL → ssh rollback.sh to previous version → re-verify →
                    report ROLLED_BACK
```

Concurrency: `group: production-deploy` (one release at a time). Rollback workflow uses
the same group and the same environment approval.

## Dependency graph (implementation order)

```
(1) plan doc (this file)
(2) workspace scaffold + packageManager pin ──┐
(3) core engine: semver, hosts, severity,     │  unit tests from day one
    state-machine, redact, report, config  ◄──┘
(4) audits: preflight, secret-scan, migration-audit   (depends on 3)
(5) csp-audit, image-manifest, remote-deploy, gha     (depends on 3)
(6) backfill contract upgrade (backend-api) + database-url-audit + asset-audit
                                                      (depends on 3; touches backend-api)
(7) VM scripts: deploy-images.sh, production-audit.sh (depends on 5,6 shapes)
(8) Playwright production-audit suite + JSON reporter (depends on 6 shapes)
(9) ci.yml                                            (depends on 2–4)
(10) release.yml + rollback.yml + production-audit.yml (depends on 5–9)
(11) cli dry-run + integration tests + sample reports  (depends on all)
(12) Claude Code subagents + skill (read-only explainers; no runtime role)
(13) deliverables doc (settings, secrets by name, runbooks)
```

## Security invariants

- No `.env*`, PEM, or secret value is read, printed, committed, or uploaded as an artifact.
- Workflow default permissions `contents: read`; `packages: write` only on the image job;
  `contents: write` only on the tag/release job; production secrets environment-scoped.
- Secrets never enter Docker build args/labels/history or browser bundles
  (`NEXT_PUBLIC_*` are explicitly supplied, validated, and fail closed).
- Reports pass through `redact.ts`; no `set -x` around secret material; GHCR token is
  piped via stdin to `docker login --password-stdin` on the VM and logged out after.
