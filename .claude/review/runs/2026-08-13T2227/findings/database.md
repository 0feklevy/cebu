# Database findings — `database-reviewer`

Engine: **PostgreSQL** (`drizzle-orm/postgres-js`, `pg-core`). Scope: full codebase audit.

## Headline check: the migration runner is CLEAN

The assigned highest-value check — `db/migrate.ts`'s hardcoded ordered list vs the migrations
directory — **found no drift**. Recording the negative result explicitly, with method, so a later
run does not have to redo it:

- `podcast-saas/backend-api/src/db/migrations/` holds **71** `.sql` files: **58** forward
  migrations (`001_initial.sql` … `058_project_exports.sql`), **12** `*.rollback.sql` companions,
  and `phase2-schema.sql`.
- `podcast-saas/backend-api/src/db/migrate.ts:25` lists exactly those **58** forward migrations.
  Set difference in both directions is empty — no file silently never runs, and no listed file is
  missing from disk.
- Runner order is byte-identical to filename sort order, so no ordering violation.
- `phase2-schema.sql` is **entirely commented-out** documentation of Phase-2 tables (107 lines, no
  executable statement) and is correctly excluded. `ops/release/src/migration-audit.ts` already
  models it as an intentional exclusion via its `excluded` input, so the release audit agrees.

Two other whole-class checks also came back clean and are worth recording:

- **No `CREATE INDEX CONCURRENTLY` anywhere.** The only matches for `concurrently` in the
  migrations tree are two English prose comments (`056_project_duplication.sql:48`,
  `058_project_exports.sql:69`). Given the runner wraps each file in one implicit transaction this
  would have been a CRITICAL; it does not occur.
- **No schema↔migration column drift.** Every column declared in `schema.ts` (53 `pgTable`s) is
  created by some migration. I diffed the two mechanically, then hand-verified the parser's 30
  candidate misses (`share_enabled_at`, `hls_master_key`, `crop_key`, `guidance_status`,
  `sim_script`, `clip_in_sec`, `banner_storage_key`, `elevenlabs_model`, `podcast_effort`, …) —
  all were multi-column `ALTER TABLE … ADD COLUMN a, ADD COLUMN b` statements my regex under-read,
  not real drift.
- **No `update`/`delete` without a `where`.** I scanned every `db|tx.update(`/`.delete(` call site
  in `backend-api/src`. The single hit was `ProjectDuplicationService.ts:1872`, a **false
  positive**: it carries `.where(sql\`… IN (SELECT … LIMIT n)\`)`, a deliberately bounded UPDATE.
- **No `timestamp` without time zone.** All 0 of them; every column is `timestamptz`.
- Migration DDL is uniformly expand/contract-safe: no `DROP TABLE`, no `DROP COLUMN`, no
  `ADD COLUMN NOT NULL` without a `DEFAULT`. The only `DROP`s are
  `DROP CONSTRAINT IF EXISTS` immediately followed by a re-`ADD` (the idempotent CHECK pattern).

The findings below are what the sweep did turn up.

---

### [P2] `count(*)` is returned uncast, so `/api/admin/v1/usage`'s sibling users endpoint sends `total` as a JSON string
- id: database-001
- location: podcast-saas/backend-api/src/controllers/admin/v1/users.controller.ts:24
- category: data-integrity
- confidence: high
- status: confirmed
- what: `db.select({ count: sql<number>\`count(*)\` }).from(users)` has no `::int` cast, and the
  value is sent straight to the client at line 26 as `total`.
- why: `count(*)` is `bigint` (int8) in Postgres. `podcast-saas/backend-api/src/db/index.ts:28-33`
  constructs `postgres({...})` with **no `types` override**, so postgres-js applies its default
  int8 handling and returns the value as a **string** — JS numbers cannot hold int64 exactly, so
  this is the driver behaving correctly. The response is therefore `{"total":"137",...}` while
  `podcast-saas/shared/src/generated/admin-v1.ts:219` declares
  `listUsers(...): Promise<{ users: User[]; total: number; page: number; limit: number }>`. The
  `sql<number>` annotation makes TypeScript agree with the wrong side, so nothing catches it at
  compile time. Any consumer doing `total + 1` gets `"1371"`, and `Math.ceil(total / limit)` only
  works by coercion accident.
- evidence: Read `users.controller.ts:9-28` (uncast, returned at :26) and `db/index.ts:1-38` (no
  `types`/`parsers` config). This is the outlier, not the norm — the same repo casts everywhere
  else: `controllers/admin/v1/pipeline-stats.controller.ts:26-44` uses `count(*)::int` /
  `sum(...)::int` / `::float8` on ten queries, `controllers/admin/v1/avatar.controller.ts:53-58`
  and `114` use `count(*)::int`, `controllers/v1/podcast.controller.ts:139` uses `count(*)::int`.
  Strongest evidence that this is a known hazard: `services/project/ProjectDuplicationService.ts:1568-1570`
  types its own counter `Promise<{ n: number | string }[]>` and defensively wraps it —
  `const n = Number(row?.n ?? 0);`. Grep for `sql<number>` aggregates without `::` returns only
  6 sites repo-wide; this is one of two that are live and unguarded.
  No admin-web caller of `listUsers` exists today, which is why it has not yet produced a visible
  bug — that is what keeps it P2 rather than P1.
- fix: change line 24 to ``sql<number>`count(*)::int` ``, matching every other aggregate in the
  admin controllers. `int4` is safe here — it is a user count.
- verify: `pnpm -C podcast-saas --filter backend-api typecheck` stays clean; assert in a test that
  `typeof body.total === 'number'` on `GET /api/admin/v1/users`.
- cross: @types-contracts
- effort: S

### [P2] The token-budget gate compares a string to a number and only works because JS coerces it
- id: database-002
- location: podcast-saas/backend-api/src/services/usage/RateLimitService.ts:19
- category: data-integrity
- confidence: high
- status: confirmed
- what: Both budget queries select ``sql<number>`coalesce(sum(input_tokens + output_tokens), 0)` ``
  with no cast (lines 19 and 24), then compare the result numerically at lines 31 and 34.
- why: Same root cause as database-001 — `sum(integer)` is `bigint` in Postgres, and
  `coalesce(bigint, integer)` is still `bigint`, so postgres-js hands back a **string**. The
  comparisons `(weekly?.total ?? 0) >= wLimit` and the monthly equivalent survive today only
  because JS `>=` coerces a numeric string to a number. Two things break that: `?? 0` never fires
  (the string `"0"` is not nullish, so a zero-usage user takes the string path too), and the moment
  anyone sums, adds, or JSON-returns this value it silently concatenates instead of adding. This is
  the rate limiter for LLM spend, so a coercion that stops holding fails **open**.
- evidence: Read the whole file (41 lines) — no `Number()` anywhere, and the values flow directly
  into the two comparisons. `db/index.ts:28-33` confirms no int8 type parser is registered. The
  same module's sibling admin endpoint 30 lines away (`controllers/admin/v1/users.controller.ts:67-69`)
  casts the identical aggregate `coalesce(sum(input_tokens),0)::int`, so the codebase already knows
  the rule and this call site missed it.
- fix: coerce at the read site rather than in SQL — `const weeklyTotal = Number(weekly?.total ?? 0);`
  and likewise for monthly, then compare those. Prefer this over an `::int` cast: a heavy account's
  30-day token sum can plausibly exceed `int4`, and `::int` would then throw a 22003 numeric
  overflow inside the rate limiter. `Number()` is exact to 2^53, far beyond any real token total.
- verify: unit-test `checkTokenBudget` against a seeded `token_usage` row set where the sum exceeds
  the limit, asserting `allowed === false`; it should pass before and after, with the assertion
  `typeof` check newly passing.
- effort: S

### [P2] `migrate.ts` marks a migration applied after Postgres rolled the entire file back
- id: database-003
- location: podcast-saas/backend-api/src/db/migrate.ts:49
- category: data-integrity
- confidence: high
- status: confirmed
- what: When a file errors with `42701` / `42P07` / `23505`, the runner logs and falls through to
  `INSERT INTO schema_migrations` at line 58, recording the file as applied.
- why: Postgres runs each multi-statement `sql.unsafe(...)` file as one implicit transaction, so
  **any** error aborts and rolls back the whole file — including statements that were genuinely
  new. The runner then writes the tracking row anyway, so the migration can never be retried: the
  next boot sees the filename in `schema_migrations` and skips it. The app then runs against a
  schema missing that DDL, with no failed exit code and no retry path. The trigger is realistic —
  one non-idempotent statement in an otherwise-new file (a bare `CREATE INDEX` or `ADD COLUMN`
  without `IF NOT EXISTS`) against an environment where that one object already exists.
- evidence: Read `migrate.ts:38-59`. The `catch` at line 40 does not re-throw for those three
  codes; control reaches line 58 unconditionally afterwards. The failure mode is not hypothetical
  to this team — lines 44-48 are a comment describing exactly this scenario and asking a human to
  "verify no NEW statements in this file were dropped", which is an operator instruction standing
  in for a code guarantee. It is P2 rather than P1 because it does emit `logger.error` (line 50),
  so alerting can catch it, and every current migration is written idempotently.
- fix: do not insert the tracking row on the swallowed-error path. Either re-throw and let the
  operator make the file idempotent, or (preserving the current intent) re-run the file's
  statements individually so genuinely-new DDL still lands, and only then record it. The minimal
  safe change is to move the `INSERT INTO schema_migrations` into the success path and let the
  three codes abort the run.
- verify: add a test that feeds the runner a two-statement file whose first statement collides and
  whose second is new, then asserts the new object exists **or** the run exited non-zero — never
  "recorded as applied and object absent".
- cross: @release-auditor
- effort: M

### [P2] Project and playlist deletes clean up `collaborators` in a second, untransacted statement
- id: database-004
- location: podcast-saas/backend-api/src/controllers/v1/projects.controller.ts:436
- category: data-integrity
- confidence: high
- status: confirmed
- what: The parent row is deleted at line 436 and the polymorphic `collaborators` invites are
  deleted at lines 438-440 as a separate top-level statement, with no enclosing `db.transaction`.
- why: `collaborators` is polymorphic (`content_type` + `content_id`) and has **no FK to projects
  or playlists** — confirmed at `podcast-saas/backend-api/src/db/schema.ts:745-759`, where the only
  `references()` are to `users.id`. The code comment on line 437 says so explicitly. So the cascade
  cannot help: if the process dies, the connection drops, or the second statement errors after the
  first committed, the invite rows survive with no parent and nothing will ever collect them. There
  is no sweeper for this table. Impact is orphan accumulation and a misleading collaborator list,
  not an auth hole — `content_id` is a random uuid, so a future row cannot inherit stale grants.
- evidence: Read `projects.controller.ts:414-461` — the two deletes are sequential `await`s at the
  handler's top level, not inside a transaction; `db.transaction` does not appear anywhere in this
  file. Identical shape at `podcast-saas/backend-api/src/controllers/v1/playlists.controller.ts:467-471`
  (verified by reading lines 463-472). The repo uses `db.transaction` correctly in 15 other places
  including `services/billing/BillingService.ts:205` and `controllers/v1/playlists.controller.ts:509`,
  so this is an omission at two sites rather than a missing pattern.
- fix: wrap both statements in `await db.transaction(async (tx) => { ... })` in each handler,
  using `tx.delete(...)` for both. Keep the storage GC outside the transaction — it is
  best-effort and must not hold the write open.
- verify: `pnpm -C podcast-saas --filter backend-api test`; add a test that deletes a project with
  two collaborator invites and asserts zero remaining `collaborators` rows for that `content_id`.
- effort: S

### [P3] `schema.ts` omits `onDelete` on five FKs the migrations declare `ON DELETE CASCADE`
- id: database-005
- location: podcast-saas/backend-api/src/db/schema.ts:202
- category: maintainability
- confidence: high
- status: confirmed
- what: `corpora` (:202), `scripts` (:220), `audio_renders` (:341), `scenes` (:358) and
  `camera_plans` (:382) declare `.references(() => projects.id)` with no `{ onDelete: 'cascade' }`,
  while the SQL that actually built those constraints specifies `ON DELETE CASCADE`.
- why: The live database is correct — this is a lie in the model, not a broken constraint. It
  matters because the Drizzle schema is the input a future `drizzle-kit generate` would diff
  against: run it today and it would propose dropping the cascade on five tables, which would turn
  every project delete into a 23503 foreign-key violation. That is precisely the outage migration
  035 was written to fix (`035_project_delete_cascade.sql:1-8` describes it as "the UI swallowed as
  'delete does nothing'"), so the repo has already paid for this class once.
- evidence: `migrations/001_initial.sql:87` (corpora) and `:102` (scripts) both read
  `project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE`;
  `migrations/002_audio_scenes.sql:30`, `:48`, `:70` do the same for `audio_renders`, `scenes`,
  `camera_plans`. Grepping `references(() => projects.id` without `onDelete` in `schema.ts`
  returns exactly these five of 28 total project FKs; the other 23 carry an explicit rule.
- fix: add `, { onDelete: 'cascade' }` to those five `.references()` calls so the model matches the
  deployed constraints. Pure annotation — the runner never generates DDL from `schema.ts`, so no
  migration is needed and nothing changes at runtime.
- verify: `pnpm -C podcast-saas --filter backend-api typecheck`.
- effort: S

### [P3] `idx_token_usage_user_id` is a redundant prefix of `idx_token_usage_user_occurred`
- id: database-006
- location: podcast-saas/backend-api/src/db/migrations/001_initial.sql:207
- category: perf
- confidence: high
- status: confirmed
- what: `CREATE INDEX idx_token_usage_user_id ON token_usage(user_id)` is fully covered by
  `CREATE INDEX IF NOT EXISTS idx_token_usage_user_occurred ON token_usage (user_id, occurred_at)`
  added later in `migrations/046_token_usage_cost_precision.sql:11`.
- why: A single-column index on `user_id` can serve no query the `(user_id, occurred_at)` composite
  cannot, since `user_id` is its leading column. It is pure write amplification on the table that
  grows fastest — one row per LLM call — and `token_usage` is on the hot path of every generation
  (`services/llm/LLMService.ts:146`, `services/llm/systemAi.ts:77`). Keeping it costs an extra
  index maintenance write per insert forever. P3 and not P2 because the cost is small per row and
  invisible until volume is high.
- evidence: Both indexes confirmed present and never dropped — grep for `idx_token_usage` across
  the forward migrations returns only `001_initial.sql:207`, `001_initial.sql:208`, and
  `046_token_usage_cost_precision.sql:11`. `schema.ts:322-325` declares only the composite,
  documenting it as "Hot path: the rolling-24h generation-cap count".
- fix: add a new migration `059_drop_redundant_token_usage_index.sql` containing
  `DROP INDEX IF EXISTS idx_token_usage_user_id;`, and add its filename to the array in
  `db/migrate.ts:25` — the list is hardcoded, so a file added without that edit never runs.
  Dropping an index is expand/contract-safe: the previous image's queries keep working on the
  composite. Note `idx_token_usage_occurred_at` (`001_initial.sql:208`) is **not** redundant —
  it serves the admin date-range rollups at `controllers/admin/v1/users.controller.ts:65` that
  filter on `occurred_at` alone.
- verify: `EXPLAIN` is out of scope for this agent (no database connection); confirm by review that
  no query filters `token_usage` on `user_id` without also being served by the composite.
- effort: S
