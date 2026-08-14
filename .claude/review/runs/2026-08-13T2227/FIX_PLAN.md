# Fix Plan — run `2026-08-13T2227`

Ordered by (severity × confidence × inverse effort). **Nothing here has been applied.**
`review-fixer` acts on this file only after you approve it, on branch
`review/fixes-2026-08-13T2227`, one change at a time, re-verifying after each and reverting anything
that regresses.

**Every item below carries a CONFIRMED verdict from an independent verifier that tried to refute
it.** The 10 findings that were downgraded and the 4 that were refuted are deliberately absent —
see `REPORT.md`.

Baseline to preserve: backend suite **125/128 files, 2185 tests green**; `client-web` and
`admin-web` typecheck clean.

---

## Lane A — safe to automate

### A1 · `billing-001` — guard `markFailed` against out-of-order webhooks
- **File:** `podcast-saas/backend-api/src/services/billing/BillingService.ts:226` (and the PI-id
  fallback at `:235`)
- **Change:** add a status term —
  `and(eq(billing_transactions.id, opts.transactionId), eq(billing_transactions.status, 'pending'))`.
- **Risk:** low. A genuine pending→failed transition still works; only succeeded→failed is refused.
- **Test:** **required.** `services/billing/__tests__` has only `grantFromSession.test.ts` and no
  ordering coverage. Apply `payment_intent.payment_failed` to an already-`succeeded` row; assert the
  row is unchanged.

### A2 · `backend-002` — consume the detached recovery promise
- **File:** `podcast-saas/backend-api/src/controllers/v1/simulations.controller.ts:230` and `:438`
- **Change:** add a trailing `.catch(err => logger.error({ err }, '…'))` to the recovery write.
  Optionally also register a `process.on('unhandledRejection')` handler — there is none anywhere in
  the repo.
- **Why it is urgent despite being small:** `generateBridgeScript` queries the DB itself
  (`SimulationService.ts:2727`), so **one** DB fault rejects both the outer promise and the recovery
  write. Node 22's default terminates the process. Single fault, not a coincidence.
- **Risk:** none — it only adds a handler.
- **Test:** optional.

### A3 · `config-deploy-003` — stop using `DATABASE_URL` as an HMAC key
- **File:** `podcast-saas/backend-api/src/services/avatar/memoryToken.ts:19-21`
- **Change:** return `process.env.AVATAR_MEMORY_SECRET`; **throw** when absent and
  `NODE_ENV === 'production'`. Keep a clearly-named dev default. Add the variable to
  `podcast-saas/.env.example` with a note that it must be identical across instances.
- **Risk:** **deployment-affecting.** Production will now fail fast without the new variable — set it
  before the next deploy. Existing tokens stop verifying; the 12 h TTL means one re-mint on the next
  memory GET.
- **⚠️ Requires an ops action before deploy.**

### A4 · `media-001` — probe for an audio stream before emitting a mix window
- **File:** `podcast-saas/backend-api/src/services/export/exportPlan.ts:233`
- **Change:** ffprobe each main video's stream layout (or persist `has_audio` at ingest) and skip the
  audio window for silent sources; if no source has audio, the existing `anullsrc` branch already
  handles it. Separately, make `ExportGateError` classify as **terminal** rather than
  `unknown`/retryable in `ProjectExportService.ts:100-118`, so a doomed export stops retrying.
- **Risk:** low. The repo's own plan document already measured this failure
  (`md-files/LINEAR-VIDEO-EXPORT-PLAN.md:682`).
- **Test:** **required.** Export a project whose main video has no audio track.

### A5 · `config-deploy-004` — fix or delete `podcast-saas/CLAUDE.md`
- **Change:** rewrite against `podcast-saas/deploy/`, or reduce to a pointer at
  `.claude/reference/stack.md` and `podcast-saas/deploy/README.md`.
- **Risk:** none to runtime. High value — it misleads every human and every agent that reads it.
- **Needs a human decision:** rewrite versus pointer. Default to the pointer.

### A6 · `observability-001` — distinguish auth failures
- **File:** `podcast-saas/backend-api/src/middleware/firebase-auth.ts:89` (both middlewares)
- **Change:** log at `warn` for token-shaped errors and `error` for everything else; give the
  non-token branch a distinct `error_type` instead of reusing `'connection_error'`.
- **Risk:** low. Do **not** change the 401 status or leak detail to the client.
- **Note:** the finding's original `verify` step was wrong — breaking `FIREBASE_PROJECT_ID` fails
  loudly at boot. The silent path is expired/revoked keys, clock skew, partitions, and DB errors in
  the upsert.

### A7 · `database-001` / `database-002` — parse Postgres `int8`
- **Files:** `podcast-saas/backend-api/src/db/index.ts:28`,
  `services/usage/RateLimitService.ts:19`, `controllers/admin/v1/users.controller.ts:24`
- **Change:** cast at the two call sites (preferred), or register an int8 type parser globally.
  **`RateLimitService` is the one that matters** — the LLM-spend gate compares a string to a number
  and holds only by JS coercion.
- **Risk:** moderate for the global parser (it changes every `count`/`sum` shape at once); low for
  call-site casts.
- **Test:** **required** for the rate-limit gate.

---

## Lane B — needs a human decision, do not auto-apply

### B1 · `simulation-001` + `simulation-002` — the replace path *(fix as a pair)*
Both CONFIRMED. The gate reads the legacy bridge path, so it returns `compatible: true` with
`sectionsTotal: 0` for exactly the revisioned sims that `processReplace` then fails to update —
and it is reachable read-only today via `?dry_run=true`, which reports a **false clean bill of
health**. Fixing either alone leaves a misleading half-state.
`processReplace` must create a new revision and flip `active_revision_entry_key` (matching
`seed-sim-pool-synthetic.ts:222`, the only other writer); the gate must read
`revisions/<id>/package/bridge.js` when an active revision exists and treat an empty bridge as
**unverifiable**, never compatible.
**Risk: high.** It touches the revision pointer, which migration 050's CHECK constraint ties to
`active_revision_id`. This is a designed change with its own review, not a fix.

### B2 · `perf-001` — stream instead of buffering in export assembly
CONFIRMED, but the verifier corrected the shape of the fix: `streamObject` is **not** on the
`StorageService` interface (`StorageService.ts:86` declares only `readObject`) and exists on
`R2StorageAdapter` alone — the production Supabase adapter and the local adapter have none. So this
is an interface addition plus two implementations, not a one-line swap. Also note the loop is
sequential, so peak heap is one object, not N. **Effort is L, not M.**

### B3 · `job-queue-001` — CAS claim + bounded recovery
CONFIRMED. Needs a claim/lease on `video_generate`, an age cutoff in `recoverStuckVideoGenerations`,
and idempotency in `downloadAndStore`. A unique index over `timeline_sections` would help — **but
that is a migration, and migrations are out of scope for the fixer.** Also address the separate
hazard the verifier found: rows lacking `external_task_id` are marked `failed` at `:242-246`, which
can fail a job another worker is actively running.

### B4 · `job-queue-002` — reconcile durability with the deployment
CONFIRMED. Either extend `PGBOSS_JOB_NAMES` to the heavy jobs, or correct
`deploy/docker-compose.yml` and its comments so the deployment stops advertising a worker that
handles jobs it never receives. **Architecture decision, human call.**

### B5 · `security-001` — invite claiming
CONFIRMED. Requires `email_verified` at **three** sites (`firebase-auth.ts:77`,
`collabAccess.ts:28-33`, `:118-123`) plus an `expires_at` and single-use token on the invite row —
**and the latter is a migration.** Split: the `email_verified` checks are Lane A once you have
decided the UX for an unverified invitee; the schema change is a human task.

---

## Lane C — settle before touching

- **`config-deploy-014`** — run
  `docker run --rm <ffmpeg-n8.1-image> ffmpeg -filter_complex_script /dev/null -f null -`
  against the pinned image. Exit 0 with a warning → P3 hygiene. Non-zero → **P0, every podcast render
  breaks on the next deploy.** The pin landed 3 commits ago and has never run podcast renders in
  production. Do this before the next deploy regardless of anything else in this plan.
- **`dependency-001`** — confirm the `adm-zip` advisory and its affected range before changing the
  pin. Version (0.5.17) and reachability (three upload paths) are confirmed; the advisory is not.

---

## Explicitly out of scope for the fixer

- **Anything requiring a migration.** Describe it, hand it to a human. This runner needs the new file
  added to a hardcoded list in `db/migrate.ts`, which is easy to get half-right.
- **`migrate.ts:49`** — the runner recording a rolled-back migration as applied. Do not automate a
  change to the migration runner.
- **The nine unreviewed service directories** (`podcast/`, `course/`, `avatar/`, `ingestion/`,
  `project/`, `seo/`, `secrets/`, `security/`, `video-generation/`). Ownership is now assigned in
  `stack.md`, but they need an actual review pass first.
- **The backend↔frontend contract surface.** `types-contracts-reviewer` never delivered. Run it
  before trusting anything about `shared/src/generated/`.

---

## After the fixer runs

`FIX_RESULTS.md` must record applied / deferred / reverted, plus baseline-versus-final typecheck,
test, and lint per package. Nothing is committed or pushed unless you say so.
