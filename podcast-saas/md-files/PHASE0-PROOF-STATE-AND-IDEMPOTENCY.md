# Phase 0 — the non-public proof state, and idempotency / lease / sectionVersion

**Status:** proposed. Settles ADR §6 exit criteria **4** ("a non-public proof state exists") and
**7** ("idempotency states, lease recovery and the `sectionVersion` fence are designed before the
endpoint is written").
**Date:** 2026-08-25 · **Branch read:** `fix/share-library-row` @ `626167c` (no schema changes on
this branch: `git diff --stat main...HEAD -- backend-api/src/db` is empty).
**Method:** static read only. No database was contacted, no migration run, no `drizzle-kit`.
**Path convention:** paths are relative to `podcast-saas/`, matching `ADR-ACTION-RECORDING-SEMANTICS.md`.
**Reads:** `ADR-ACTION-RECORDING-SEMANTICS.md` D7/D8/D9 · `.claude/review/RESEARCH-ACTION-RECORDING-2026-08-25.md` §9 / §15.

---

## 0. Ground truth, re-measured (do not quote these; re-measure)

| Fact | Value now | Command |
|---|---|---|
| Engine | PostgreSQL, `drizzle-orm/postgres-js`, `pg-core` | — |
| `pgTable` declarations | **61** | `grep -c 'pgTable(' backend-api/src/db/schema.ts` |
| `.sql` files on disk | **113** = 79 forward + 33 `.rollback.sql` + `phase2-schema.sql` | `ls backend-api/src/db/migrations/*.sql \| wc -l` |
| Runner list (`migrate.ts:66`, exported `MIGRATION_FILES` at `:69`) | **79** entries | — |
| Runner drift | **none.** Forward-file set == runner set, both directions; runner order == filename sort | set-diff, run 2026-08-25 |
| Highest migration | `080_sim_files.sql`. **`074` does not exist** — the number is skipped | `ls .../migrations/ \| grep 074` → empty |
| **Next migration number** | **`081`** | — |
| Rollback siblings | the convention for recent work: 075–080 each have a `.rollback.sql` (incl. `079_saved_bridges.rollback.sql`) | — |

Two maintenance facts the build must respect:

1. **`backend-api/src/scripts/check-db.ts:20` holds a SECOND hardcoded copy of the list**, shadowing
   the name `MIGRATION_FILES` with a local literal rather than importing `db/migrate.ts:69`. The two
   agree today (diffed, byte-identical order). **Nothing asserts that they agree** —
   `db/__tests__/migrationRunner.test.ts:404-426` only checks `migrate.ts` against itself and against
   the release engine's extraction regex. Every new migration must be added in **both** files.
2. `.claude/reference/stack.md` §4 is stale at this stamp (it says 62 forward / 79 total / 52 tables;
   actual is 79 / 113 / 61). Route that to `fleet-maintainer`; it does not change any decision below.

---

# ITEM 1 — a non-public proof state

## 1.1 What the code actually does today

```
validate()                 activate()
  validating ──────────────► canary_passed ──────────► active
RevisionService.ts:469      RevisionService.ts:710-721
```

- `shared/src/sim/simRevision.ts:27-51` — eight statuses. `:53-55` `SIM_REVISION_STATUSES`.
  `:66-75` `TRANSITIONS`. `:77-79` `canTransition`. `:86` `isServable` — already `status === 'active'`
  and nothing else.
- `backend-api/src/services/simulation/revisionIdentity.ts:46-49` — `NEVER_PUBLISHED_STATUSES =
  {draft, uploading, validating, failed}`; `:51-53` `isRevisionStatusPublic(status)` returns
  `status === null || !NEVER_PUBLISHED_STATUSES.has(status)`.
- `backend-api/src/controllers/sim-public.controller.ts:152` reads the facts, `:160` is the gate:
  `if (revision.verified && !isRevisionStatusPublic(revision.status)) return 404`.

Two consequences, both by **omission from a deny-list**, not by an affirmative decision:

- **`canary_passed` is publicly served.** Pinned by tests at
  `backend-api/src/services/simulation/__tests__/revisionIdentity.test.ts:188` and
  `backend-api/src/controllers/__tests__/sim-public.revisionStatus.test.ts:109-116`.
- **An UNKNOWN status is publicly served.** `!deny.has('anything_new')` is `true`. This is the
  decisive fact for the rollout order in §1.6.

`retired` and `rolled_back` are also publicly reachable, and deliberately so
(`revisionIdentity.ts:36-45`, `mustRetainBytes` at `simRevision.ts:82-84`). **Rollback is therefore
not revocation.** Moving `simulations.active_revision_id` changes what the player *resolves*; it does
not 404 a URL somebody already holds. Any recorded action plan published by mistake stays fetchable
at its revision URL until `RevisionService.gc()` reclaims it — and gc **retains** those statuses, so
for `retired`/`rolled_back` the answer is "never, while the keep-floor holds"
(`RevisionService.ts:125` `GC_MIN_KEEP = 2`). This sentence belongs in the runbook verbatim, as D8 says.

## 1.2 `sim_revisions.status` — what it is (answered, not assumed)

`text`, **not** a Postgres enum, **not** free text:

```sql
-- backend-api/src/db/migrations/050_sim_revisions.sql:41-43
status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
  'draft','uploading','validating','canary_passed','active','retired','failed','rolled_back'
)),
```

Drizzle sees only `text('status').notNull().default('draft')` (`db/schema.ts:578`) — the CHECK is
invisible to the ORM and is the only thing enforcing the vocabulary. It is enforced: `migration050.test.ts:369`
asserts an unknown status is rejected with SQLSTATE `23514`.

**So: any NEW status value requires a migration** that drops and re-adds that CHECK. Being `text +
CHECK` rather than a real enum is a gift here — `ALTER TYPE ... ADD VALUE` could not run inside this
runner's explicit transaction, whereas `DROP CONSTRAINT` / `ADD CONSTRAINT` can. Two other constraints
mention statuses and must be re-read before any edit: `050:81-83`
(`activated_at IS NOT NULL` for `active|retired|rolled_back`) and `050:105-107`
(`uniq_sim_revisions_active`, the partial unique index — Postgres has partial indexes; this one is
load-bearing for the demote-before-promote order).

## 1.3 The canary does **not** need `canary_passed` to be public — the stated justification is false

The comment at `revisionIdentity.ts:44-45` ("`canary_passed` is served too: the pre-activation canary
drives the real document over this route"), the test comment at `revisionIdentity.test.ts:186-188`, and
the framing in the research report §15.5 all assert this. **It is not what the harness does.**

- `client-web/playwright.canary.config.ts:6-9` — "does not boot the application, does not need a
  client-web server, and does not touch the network — the package bytes are served by an in-process
  fixture server and addressed on the API origin through route interception".
- `client-web/e2e/sim-canary.spec.ts:1710-1725` — `await page.route(`${API_ORIGIN}/**`, …)`
  intercepts **every** request to the API origin and fulfils it from `localOrigin`, a `node:http`
  server started at `:311-340` that reads `FIXTURE_DIR = ../../.sim-fixture` (`:153`).
- `:306` `localPathFor()` maps **only** `/__canary/harness.html` and `/sim-public/__e2e/<pkg>/…`.
  Anything else is fulfilled as `404 not part of the staged package`. A real revision key
  (`simulations/<p>/<s>/revisions/<uuid>/…`) is unreachable by this harness **by construction**, even
  with `CANARY_PACKAGE` pointed at a real package name.
- Bytes come from `backend-api/src/scripts/gen-sim-fixture.ts`, on local disk. No request reaches
  `sim-public.controller.ts`, no request reaches object storage.

**Therefore `canary_passed` can be withdrawn from public serving with no effect on the existing
canary.** This removes the only stated obstacle to option (c) and materially changes the options below.
Three comments become false and must be corrected in the same change: `revisionIdentity.ts:36-47`,
`revisionIdentity.test.ts:10-13`, and the header of `sim-public.revisionStatus.test.ts:10-13`.

*(Residual check owed before merge, not a blocker: `grep -rn "getSimPublicUrl" backend-api/src` and
confirm no caller composes a public URL from a revision that is not yet `active`. `uploadSectionBridge`
composes `sectionUrl` at `SimulationService.ts:3405` from `draft.id` **before** `activate()` at
`:3410`, but the URL is only returned to the caller inside the persist hook that runs in the
activation transaction — i.e. it escapes only on success. Confirm, do not assume.)*

## 1.4 The three options, honestly

### (a) Add `proof_pending` / `proof_passed`, non-public; move canary into an internal harness

**Files touched**
| File | Edit |
|---|---|
| `shared/src/sim/simRevision.ts:27-51` | two new members on `SimRevisionStatus` + doc |
| `…:53-55` | `SIM_REVISION_STATUSES` gains both |
| `…:66-75` | TRANSITIONS, see below |
| `backend-api/src/services/simulation/RevisionService.ts:116` | `ACTIVATABLE_FROM` gains `'proof_passed'` |
| `…:413-487` | `validate()` takes `proofRequired: boolean`; target status becomes `proof_pending` when set (`:469`) |
| `…:583-605` | `recordCanary`'s `inArray(status, ['uploading','validating','canary_passed'])` at `:596-601` gains both |
| `…:959-969` | `staleDrafts`' `inArray(['draft','uploading','validating'])` gains both, or an in-proof row is invisible to the stuck-row report forever |
| new | `markProofPassed(simId, revId)` = `transition(…, 'proof_pending', 'proof_passed', {…})` |
| `backend-api/src/services/simulation/SimulationService.ts:3398`, `:3425` | both pass the literal `'canary_passed'` as `markFailed`'s `from` — must become the actual pre-activation status |
| `backend-api/src/db/migrations/081_*.sql` + `.rollback.sql` | CHECK widen/narrow |
| `backend-api/src/db/migrate.ts:66` **and** `backend-api/src/scripts/check-db.ts:20` | register the file in both |

**TRANSITIONS edits** — additive, so the existing non-recording publication paths
(`generateBridgeScript`, `applyMinimalUiOnly`, `replaceIntoRevision`) keep working unchanged:

```ts
validating:     ['canary_passed', 'proof_pending', 'failed'],  // was ['canary_passed','failed']
proof_pending:  ['proof_passed', 'failed'],                    // new
proof_passed:   ['active', 'failed'],                          // new
canary_passed:  ['active', 'failed'],                          // UNCHANGED — legacy rows and the
                                                               // migration publish into this state
```

**Migration** — required. See §1.7 for DDL.

**Tests that break**
- `shared/src/sim/__tests__/simRevision.test.ts:45-50, :52-54, :84-88` — all three iterate
  `SIM_REVISION_STATUSES` and keep passing (every new status has a TRANSITIONS entry, `failed` stays
  terminal, `isServable` stays `=== 'active'`). No edit needed, which is the point of those loops.
- `backend-api/src/db/__tests__/migration050.test.ts:363` — enumerates
  `['draft','uploading','validating','canary_passed','failed']` as the statuses allowed a NULL
  `activated_at`. Must gain both new values. `:369` (unknown status rejected) keeps passing.
- `revisionIdentity.test.ts:181-195` — needs two new rows in the "withholds" `it.each`.
- `sim-public.revisionStatus.test.ts:83-131` — same.

**Canary impact:** none, per §1.3. There is no "move canary into an internal harness" work item,
because the canary is already an isolated harness that never touches the public route.

**Cost:** a migration, a widened vocabulary, two coordinated hardcoded lists, and a rolling-deploy
hazard (§1.6). **Benefit:** the row can finally distinguish *"bytes verified"* from *"replay proven in
a browser"* — which is exactly the distinction `sim_meta.runtimeValidated` publishes as a claim
(report §15.3), and exactly the distinction `simRevision.ts:33-42` already admits `canary_passed`
cannot make ("the name is historical; treating it as a canary gate would activate unproven bytes").

### (b) Hold the row in `validating` until proof completes

**Files touched:** fewer on paper — no migration, no shared type change.

**Why it is wrong here.** `validate()` (`RevisionService.ts:413-487`) does four things in one
call: verifies stored bytes, runs capture-compatibility, **writes `manifest.json`**, and transitions
`validating → canary_passed` *while setting `manifest_hash`, `entry_path`, and the protocol versions*
(`:454-484`). To hold at `validating` you must split that, and then:

- The promote CAS at `:710-721` requires `inArray(status, ACTIVATABLE_FROM)` **and**
  `isNotNull(manifest_hash)` **and** `isNotNull(entry_path)`. Adding `'validating'` to
  `ACTIVATABLE_FROM` collapses the comment's own guarantee at `:711-713` — "an unvalidated revision
  is unactivatable even by a caller that skipped `validate()`" — into "unactivatable only if
  `manifest_hash` happens to be NULL". The status stops carrying meaning; one column does all the work.
- `staleDrafts` (`:959-969`) reaps `validating` by age. A revision legitimately mid-proof becomes
  indistinguishable from a wedged upload, and `gc()` will collect it after `GC_MIN_AGE_MS`
  (`:134`, 1h) because `mustRetainBytes('validating')` is false. Under (a) that same gc behaviour is
  a *feature* — it is the TTL for unapplied candidates (ADR M3) — because the status still says why
  the row exists.
- The audit question after an incident ("was this revision proven, or merely byte-verified?") becomes
  unanswerable from the row.

**Verdict: reject.** It buys the absence of a migration and pays with a state machine that no longer
distinguishes two genuinely different states — the exact defect `canary_passed`'s own doc comment
records as a historical mistake.

### (c) Invert `isRevisionStatusPublic` to an explicit ALLOW-list

**Files touched:** `backend-api/src/services/simulation/revisionIdentity.ts:36-53` only.

```ts
/** Statuses whose bytes the revision pointer HAS named. Everything else is withheld, including
 *  a status this image has never heard of. */
const PUBLICLY_SERVED_STATUSES: ReadonlySet<string> = new Set(['active', 'retired', 'rolled_back']);

export function isRevisionStatusPublic(status: string | null): boolean {
  return status === null || PUBLICLY_SERVED_STATUSES.has(status);
}
```

`status === null` must stay `true`: it is the legacy-package case (no `sim_revisions` row) and also
the database-fault case (`revisionIdentity.ts:140-152` returns `UNVERIFIED` on error, deliberately
leaving the gate open rather than 404-ing every simulation on a blip).

**Migration:** **none.** Pure code.

**Tests that break** — exactly two files, four assertions:
- `revisionIdentity.test.ts:182-189` — `canary_passed` moves from the "serves" `it.each` to the
  "withholds" one. Add a case asserting an unknown status (`'proof_pending'`, `'zzz'`) is withheld —
  that assertion is the whole point of the inversion and does not exist today.
- `sim-public.revisionStatus.test.ts:83-116` — same move, plus the header comment at `:10-13`.

**Canary impact:** none (§1.3).

**What it delivers:** `validating` **and** `canary_passed` become non-public, so a candidate can be
staged, byte-verified and replay-proven while unreachable. **ADR §6 exit criterion 4 is satisfied by
this change alone**, with no migration.

## 1.5 Recommendation

**Ship (c) now, in Phase 0. Ship (a) in Phase 2, as its own migration. Reject (b).**

Reasoning, in order of weight:

1. **(c) is the only one that makes the gate fail *closed*.** Today an unrecognised status is served.
   Under (a)-without-(c), the instant migration 081 widens the CHECK, a `proof_pending` row is
   publicly readable by any image that has not yet been replaced — see §1.6. (c) is not merely a
   tidier spelling of the same rule; it is the rule that makes (a) safe to ship at all.
2. **(c) costs one function and four test assertions, and needs no migration.** It satisfies exit
   criterion 4 by itself. Phase 0 should not be blocked on a DDL change it does not need.
3. **(a) is still worth doing**, because `runtimeValidated` (report §15.3) is a claim the artifact
   publishes, and `canary_passed` provably cannot back it — `simRevision.ts:33-42` says so in the
   type's own doc, and `validate()` reaches that status on byte verification alone. But that is a
   Phase-2 need, not a Phase-0 one.
4. **(b) trades a migration for a state machine that lies.** Reject.

**Say it plainly for the runbook:** after (c), `draft`, `uploading`, `validating`, `canary_passed`,
`failed` and every future/unknown status are 404. `active`, `retired`, `rolled_back` and legacy
keys with no revision row remain public. **`retired` and `rolled_back` stay reachable, so rollback
moves the pointer and does not revoke a URL.** Revocation is `RevisionService.gc()`
(`revisionGcSweep.ts`, every 6h, keep-floor 2, 1h age grace) — or nothing.

## 1.6 Rollout order — this is the part that bites

Policy is expand/contract: the **previous image is the rollback target and must keep working**.

- Release **N**: ship (c). Code only. The previous image's deny-list behaviour is a *superset* of
  public — i.e. the old image serves `canary_passed`, the new one does not. Rolling back re-exposes
  it, which is today's behaviour, so the rollback is safe.
- Release **N+1** (or later): ship (a) — migration 081 + the shared type + `RevisionService`. Now
  every image that can be rolled *back* to already withholds unknown statuses, so a `proof_pending`
  row is never publicly readable during the window.

**If (a) shipped first or alone, this is the concrete failure:** old image, new row.
`isRevisionStatusPublic('proof_pending')` → `!deny.has('proof_pending')` → `true` → the unproven
candidate's entry HTML and every asset are served from `/sim-public/*` to anonymous callers. That is
precisely the leak `simulation-007` closed, reopened by a status the old deny-list has never heard of.

Two further old-image notes for (a), neither blocking:
- `canTransition('proof_pending', x)` in an old image is `TRANSITIONS['proof_pending'].includes(x)` →
  **TypeError on `undefined`**. Only `RevisionService.transition()` (`:250-273`) calls it, and only
  the new image ever passes a proof status as `from`. Acceptable; state it in the release note.
- `mustRetainBytes('proof_pending')` is `false` in both images, so an old image's gc sweep would
  collect an in-proof candidate after the 1h age grace. That is the intended TTL, not a defect — but
  it means **proof must complete well inside `GC_MIN_AGE_MS`**, which is an input to ADR measurement M1.

## 1.7 Migration DDL for (a) — `081_sim_revision_proof_states.sql`

House style: `IF NOT EXISTS`, `DO $$ … EXCEPTION WHEN duplicate_object`, comment-heavy, one explicit
transaction supplied by the runner (do **not** write `BEGIN`/`COMMIT`; `migrate.ts` wraps the file).
**No `CONCURRENTLY`** — `migrationRunner.test.ts:395-401` scans every `.sql` for it and the runner
would fail with 25001 anyway.

```sql
-- 081: two non-public statuses between byte-verification and activation.
--
-- WHY A NEW STATUS AND NOT A BOOLEAN. `canary_passed` is reached by validate() on byte verification
-- alone (RevisionService.ts:469) and the legacy migration publishes straight into it, so it cannot
-- mean "replay-proven" without changing what it means for every existing row. See the doc comment
-- on SimRevisionStatus in shared/src/sim/simRevision.ts:33-42, which already says this.
--
-- ORDERING PREREQUISITE: the image that serves /sim-public/* must ALREADY use the allow-list form
-- of isRevisionStatusPublic (release N). An image on the deny-list form serves an unknown status
-- publicly, which would make a proof_pending candidate world-readable during the deploy window.
--
-- The status column is TEXT + CHECK, not an enum, which is what makes this widening possible inside
-- the runner's transaction at all: ALTER TYPE ... ADD VALUE cannot run in a transaction block.
ALTER TABLE sim_revisions DROP CONSTRAINT IF EXISTS sim_revisions_status_check;
ALTER TABLE sim_revisions ADD CONSTRAINT sim_revisions_status_check CHECK (status IN (
  'draft', 'uploading', 'validating', 'canary_passed',
  'proof_pending', 'proof_passed',
  'active', 'retired', 'failed', 'rolled_back'
));

-- sim_revisions_activated_at_chk (050:81-83) needs NO edit: it constrains only
-- ('active','retired','rolled_back'), and neither new status is in that set — a proof-state row
-- correctly has a NULL activated_at.

-- The stale-row scan (RevisionService.staleDrafts) and the reaper (gc) both filter on status.
-- idx_sim_revisions_status_created (050:116-117) already covers (status, created_at); no new index.
COMMENT ON COLUMN sim_revisions.status IS
  'SimRevisionStatus. proof_pending/proof_passed are NON-PUBLIC: isRevisionStatusPublic allows only active/retired/rolled_back.';
```

```sql
-- 081 rollback. NARROWS the CHECK, so it FAILS if any row still holds a proof status — deliberately.
-- Silently rewriting those rows to 'failed' would destroy the record of why bytes were staged.
-- Drain first:  SELECT id, simulation_id FROM sim_revisions WHERE status IN ('proof_pending','proof_passed');
ALTER TABLE sim_revisions DROP CONSTRAINT IF EXISTS sim_revisions_status_check;
ALTER TABLE sim_revisions ADD CONSTRAINT sim_revisions_status_check CHECK (status IN (
  'draft', 'uploading', 'validating', 'canary_passed',
  'active', 'retired', 'failed', 'rolled_back'
));
```

**Constraint-name caveat:** `050:41-43` declares the CHECK **inline on the column**, so Postgres
auto-names it `sim_revisions_status_check`. 050 is the only file that creates the table, so that name
is right — but the `DROP CONSTRAINT IF EXISTS` is what makes the migration safe if it ever were not,
and the migration test must assert the constraint exists **by name and by behaviour** after the
forward step (insert `'proof_pending'` succeeds, insert `'published'` still raises `23514`).

## 1.8 What must be TESTED — Item 1

| # | Test | Where |
|---|---|---|
| T1.1 | `isRevisionStatusPublic` withholds `draft/uploading/validating/canary_passed/failed` | `revisionIdentity.test.ts` (edit `:181-195`) |
| T1.2 | **withholds a status this build has never heard of** (`'zzz'`, `'proof_pending'`) — the assertion the deny-list form cannot make | new, same file |
| T1.3 | allows `active/retired/rolled_back` and `null` | edit `:188` |
| T1.4 | route returns **404 before any storage read** for a `canary_passed` entry HTML, and **without** calling `getPublicUrl` for a binary asset | `sim-public.revisionStatus.test.ts` (move `canary_passed` from `:109` to `:84`) |
| T1.5 | *(a)* migration 081 forward is idempotent, accepts both new values, still rejects `'published'` with `23514`, and leaves `sim_revisions_activated_at_chk` accepting a NULL `activated_at` for both | `db/__tests__/migration081.test.ts`, modelled on `migration050.test.ts:352-371` |
| T1.6 | *(a)* rollback **fails loudly** while a proof-status row exists | same file |
| T1.7 | *(a)* `ACTIVATABLE_FROM` promotes from `proof_passed` and **refuses** `proof_pending`; the promote CAS still refuses a NULL `manifest_hash` | `revisionService.test.ts` |
| T1.8 | *(a)* `staleDrafts` reports a wedged `proof_pending` row; `gc()` collects one past `GC_MIN_AGE_MS` and never collects an `active`/`retired` one | `revisionService.test.ts` |
| T1.9 | **regression guard for §1.3:** the canary harness issues zero requests that leave the fixture server — assert `page.route` intercepts every `API_ORIGIN` request and that `localPathFor` returns null (→404) for a `simulations/**/revisions/**` key | `client-web/e2e/sim-canary.spec.ts` |
| T1.10 | `MIGRATION_FILES` in `migrate.ts:69` and the literal in `check-db.ts:20` are equal | new test — this drift is currently unguarded |

---

# ITEM 2 — idempotency, lease recovery, and the `sectionVersion` fence

## 2.1 Why the in-process lock is not sufficient for two workers

`SimulationService.withBridgeLock` (`SimulationService.ts:2439-2449`) is a
`Map<string, Promise<void>>` field on the instance (`:2423`). Four independent reasons it cannot be
the concurrency control for Apply — the first two are already documented in the codebase:

1. **It is per-instance, not per-process.** `RevisionService.ts:12-16`: *"`SimulationService.withBridgeLock`
   is per-instance, and three call sites each construct their own `SimulationService` with its own
   empty lock map — so it does not actually serialise anything across the cluster."*
   `SimulationService.ts:2413-2422` says the same from the other side: *"Correctness no longer depends
   on this … The lock is kept as a UX nicety for the common single-process deployment."*
2. **There are two processes by design.** `backend-api/src/worker.ts` is a dedicated worker
   entrypoint, and the deployment is docker-compose + systemd, i.e. scalable. Two Node processes share
   no `Map`.
3. **The real cross-process guarantee is a CAS, and a CAS is not idempotent.** Safety comes from
   `expectedActiveRevisionId` — read once at `SimulationService.ts:3218-3232`, asserted three times
   inside one transaction at `RevisionService.ts:694-707` (demote), `:710-721` (promote),
   `:723-771` (pointer, using `IS NOT DISTINCT FROM` so first activation with a NULL incumbent works)
   — backed cluster-wide by the partial unique index `uniq_sim_revisions_active` (`050:105-107`),
   whose 23505 is mapped to `RevisionConflict` at `:648-654`. A loser gets a **conflict**, which is
   correct for "publish", and **wrong for "retry my Apply"**: the client must get its original
   answer back, not a 409 for work that already succeeded.
4. **The lock protects the wrong object.** It serialises *publications of one simulation*. Apply
   needs to serialise *one idempotency key*: two workers holding the same `Idempotency-Key` must not
   both compile, both stage bytes, and both attempt activation. Nothing in `withBridgeLock` is keyed
   on the request. Only a database uniqueness constraint plus a lease can do that.

**What Apply reuses unchanged:** the `onActivated(tx)` hook (`RevisionService.ts:625-637`, invoked at
`:780`, contract documented at `SimulationService.ts:125-134`). It runs **inside** the activation
transaction, **after** every CAS has held, and a throw from it rolls back demote + promote + pointer
together. `sections.controller.ts:1005-1019` already uses it to write `timeline_sections` atomically
with the pointer flip. **The recordings row's terminal state must be written in that same hook** — see
§2.6.

## 2.2 Is there a `sectionVersion` on `timeline_sections`? **No.**

`db/schema.ts:723-798`, full column list:
`id, project_id, video_file_id, start_sec, end_sec, type, label, notes, sort_order, simulation_url,
simulation_id, sim_script, sim_prompt, simple_ui, auto_script, track, global_offset_sec, sim_meta,
clip_source_video_id, clip_in_sec, broll_volume, clip_source_image_id, camera_movement,
clip_source_audio_id, anchor_video_file_id, anchor_offset_sec, placement_mode, created_at`.

**No `version`. No `updated_at`. No optimistic-concurrency column of any kind.** (Note also that the
long comment at `:783-795` describes a `generation_job_id` column and a partial unique index — the
**column is not in the Drizzle table**; like `uniq_sim_revisions_active`, it exists only in the
migration. Do not assume schema.ts is the whole table.)

Report §15.3 specifies `section_version bigint not null` **on the recordings table** and never says
where the section's own version comes from. That gap is this document's job.

### Three ways to get the fence

| | Mechanism | Migration | Failure mode |
|---|---|---|---|
| (i) | app bumps `section_version` in every UPDATE | column | **9 `update(timeline_sections)` call sites across 5 files** (`sections.controller.ts`, `simulations.controller.ts`, `video.controller.ts`, `bridgePresets.controller.ts`, `scripts/classify-orphan-sim-rows.ts`). One missed writer makes the fence silently pass when the section did change. Silent. |
| (ii) | `BEFORE UPDATE` trigger bumps it | column + trigger | Cannot be missed — fires for every writer including one-shot scripts and future code. **No migration in this repo currently uses `CREATE TRIGGER` or `CREATE OR REPLACE FUNCTION`** (verified by grep over all 113 files) — this would be the first, and it is invisible in `schema.ts`. |
| (iii) | no column; fence on the prior **values** (`simulation_url`, `sim_meta`) in the UPDATE predicate | none | Depends on `jsonb` round-tripping identically through Drizzle — and `db/jsonb.ts:3-11` documents exactly how that goes wrong (postgres-js re-encodes a jsonb-cast parameter, Drizzle's codec pre-stringifies, and you get a doubly-encoded jsonb *string*). A fence that mis-compares is worse than no fence. |

**Recommendation: (ii).** A trigger is a new mechanism for this codebase and must be called out in
review — but the alternative is an invariant enforced by remembering to do it at nine call sites, and
the cost of forgetting is a recorded plan published over a section that moved underneath it. Pay the
novelty cost once, in one place, and add the mutation test at T2.9. Reject (iii) on the `db/jsonb.ts`
evidence; reject (i) on the call-site count.

Postgres detail that matters and would be wrong on another engine: **`ADD COLUMN … bigint NOT NULL
DEFAULT 1` on a populated table does not rewrite the table** — since PG 11 the default is stored in
`pg_attribute.attmissingval`, so this is a catalogue-only change taking a brief ACCESS EXCLUSIVE lock.
No batching, no maintenance window, no separate backfill. (A MySQL reflex would schedule one; do not.)

## 2.3 Existing idempotency patterns in this codebase — what to reuse and what not to

| Pattern | Where | Reuse? |
|---|---|---|
| `jobs.idempotency_key text UNIQUE` | `db/schema.ts:359` | **Shape only, and not the scope.** It is *globally* unique. §15.3 wants `unique(project_id, idempotency_key)`, which is right: a client-generated key must not be able to collide across tenants, and a global unique lets one project's key deny another's. |
| result-keyed idempotency: `timeline_sections.generation_job_id` + partial unique index | migration `062_broll_idempotency.sql`; described at `db/schema.ts:783-795` | **Yes, as precedent for the partial unique index** (Postgres has them; Drizzle's builder does not, so it lives in the migration only — same note as `uniq_sim_revisions_active`). |
| request-keyed, in-process: `startIdempotencyKey` / `withStartIdempotency` | `backend-api/src/services/avatar/startIdempotency.ts` | **Reuse the key derivation idea, not the storage.** It hashes `(projectId, callerId, clientKey)` with sha256 and never stores the raw key — do the same for `idempotency_key`/`request_hash`. But it is a `Map` with a 35s window and **it deletes the entry on failure so a retry really retries** — the opposite of the terminal-response replay Apply needs, and it has the same single-process weakness as §2.1. |
| content-hash idempotency | `runCropAnalysis` (`crop_source_hash`), `video_dubs` | Same-inputs-no-work. Complementary to, not a substitute for, a request key. |

**There is no durable request-idempotency table in this repo.** `sim_action_recordings` is new ground.

## 2.4 The state table

States, and the **only** legal predecessor of each. Enforced by a conditional `UPDATE … WHERE
status = $from` — the same construction as `RevisionService.transition` (`:250-273`), which is what
makes it a compare-and-set rather than a hope.

| From | To | Written by | Guard on the UPDATE |
|---|---|---|---|
| — | `received` | the request handler | `INSERT … ON CONFLICT (project_id, idempotency_key) DO NOTHING`; zero rows ⇒ this is a retry, go to §2.5 |
| `received` | `compiling` | lease holder | `status='received' AND lease_owner=$me` |
| `compiling` | `staged` | lease holder | `status='compiling' AND lease_owner=$me`, sets `plan`, `plan_hash`, `artifact_hash` |
| `staged` | `proving` | lease holder | `status='staged' AND lease_owner=$me` |
| `proving` | `activating` | lease holder | `status='proving' AND lease_owner=$me`, sets `proof_artifact_hash` |
| `activating` | `applied` | **inside `onActivated(tx)`** | `status='activating' AND lease_owner=$me`; sets `published_revision_id`, `applied_at`, `response_http_status`, `response_json` |
| any non-terminal | `failed` | lease holder or the lease reaper | sets `failure_code`, `response_http_status`, `response_json` |

Terminal = `applied | failed`. Nothing leaves a terminal state — the row is the stored answer.

**Lease.** `lease_owner text`, `lease_expires_at timestamptz`, `attempt_count integer`. Claim/renew is
one CAS:

```sql
UPDATE sim_action_recordings
   SET lease_owner = $me, lease_expires_at = now() + interval '90 seconds',
       attempt_count = attempt_count + 1, updated_at = now()
 WHERE id = $1
   AND status NOT IN ('applied','failed')
   AND (lease_owner IS NULL OR lease_owner = $me OR lease_expires_at < now())
   AND request_hash = $2 AND source_revision_id = $3 AND section_version = $4
RETURNING *;
```

Zero rows ⇒ somebody else holds a live lease, or the fence moved. Report §15.2's rule — *"another
worker may resume only the same command, source fence, and artifact hash"* — is those last three
predicates, and they belong **in the SQL**, not in a service-layer `if`.

**`lease_owner` must be the pg-boss job id, not the process id.** If Apply degrades to `202` +
background job (report §15.1 step 8, gated on ADR measurement M1), a redelivery to the *same worker
process* would otherwise present the same owner and walk straight past the "or `lease_owner = $me`"
clause into a half-finished state it did not create.

## 2.5 Retry semantics — what the endpoint returns

| Row state on retry | Response |
|---|---|
| no row | claim it, build |
| terminal (`applied`/`failed`), same `request_hash` | **replay `response_http_status` + `response_json` verbatim.** Never reconstruct from live `sim_meta` — the section may have been republished since |
| non-terminal, live lease | `202` + status URL, or bounded wait. **Never start a second build** |
| non-terminal, expired lease, fences match | resume: re-claim per §2.4 |
| non-terminal, expired lease, fences moved | `409 publication_conflict` and mark the row `failed`. V1 does not rebase (ADR D7, §15.2) |
| any state, **different** `request_hash` | `409 idempotency_conflict` |

## 2.6 The atomicity requirement — the one thing that must not be split

`activating → applied` **must** be written inside `onActivated(tx)`, in the same transaction as the
revision CAS and the `timeline_sections` update. If it were a statement after `activate()` resolves,
a crash in that window leaves a live revision, a section pointing at it, and a recording row still
`activating` — and the retry, seeing a non-terminal row, rebuilds and republishes. The section would
get a second identical revision and the client would get a fabricated response. This is the same
failure `replaceIntoRevision` already avoids by moving the terminal `status='ready'` into the hook
(`SimulationService.ts:2700-2706` explains it; `:2836-2841` does it).

So the hook does three writes in one transaction:
1. `timeline_sections` — the conditional update carrying the `section_version` fence;
2. `sim_action_recordings` — `applied`, `published_revision_id`, stored response;
3. whatever `sim_meta` provenance the section needs.

Any of them affecting zero rows ⇒ **throw**, which rolls the whole activation back.

The section update is where the fence is spent:

```sql
UPDATE timeline_sections
   SET simulation_url = $url, sim_meta = $meta::jsonb
 WHERE id = $sectionId AND project_id = $projectId
   AND simulation_id = $simulationId
   AND section_version = $observedVersion   -- the fence; the trigger bumps it on success
RETURNING id, section_version;
```

## 2.7 Migrations

Two files, in this order. Numbers are whatever is next **at merge** — `081` and `082` today; re-derive
before opening the PR, and register each in **`migrate.ts:66` and `check-db.ts:20`**, with a
`.rollback.sql` sibling (the convention through 080), in the same commit.

### `081_timeline_section_version.sql`

```sql
-- 081: optimistic-concurrency fence for timeline_sections.
--
-- WHY IT DID NOT EXIST. Nothing needed it: every prior writer of this row was the last word on it.
-- A recorded action plan is different — it is compiled against a snapshot of the section, proven
-- against those exact bytes, and activated some seconds later. Between the snapshot and the
-- activation the section can be re-generated, re-pointed at a different simulation, or deleted.
-- Publishing a proven plan onto a section that moved is the one failure the proof cannot catch.
--
-- ADD COLUMN ... NOT NULL DEFAULT does NOT rewrite the table on Postgres 11+ (the default lives in
-- pg_attribute.attmissingval), so this is catalogue-only: no batching, no backfill, brief lock.
ALTER TABLE timeline_sections
  ADD COLUMN IF NOT EXISTS section_version BIGINT NOT NULL DEFAULT 1;

-- BUMPED BY A TRIGGER, NOT BY THE APPLICATION.
-- There are nine `update(timeline_sections)` call sites across five files, plus one-shot scripts.
-- A fence maintained by remembering to maintain it at nine places is a fence that silently passes
-- the one time somebody forgets, and the symptom is a published plan bound to a section that moved.
-- Always bumps: a BEFORE UPDATE trigger fires after the statement's WHERE has already selected the
-- row, so a `WHERE section_version = $expected` compare-and-set still reads the OLD value.
CREATE OR REPLACE FUNCTION timeline_sections_bump_version() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  NEW.section_version := OLD.section_version + 1;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_timeline_sections_bump_version ON timeline_sections;
CREATE TRIGGER trg_timeline_sections_bump_version
  BEFORE UPDATE ON timeline_sections
  FOR EACH ROW EXECUTE FUNCTION timeline_sections_bump_version();

COMMENT ON COLUMN timeline_sections.section_version IS
  'Optimistic-concurrency fence. Bumped by trg_timeline_sections_bump_version on EVERY update; never written by the application.';
```

```sql
-- 081 rollback. EXPAND/CONTRACT: the previous image never reads section_version, so dropping it is
-- safe for the app — but a recorded-plan Apply in flight loses its fence mid-request.
DROP TRIGGER IF EXISTS trg_timeline_sections_bump_version ON timeline_sections;
DROP FUNCTION IF EXISTS timeline_sections_bump_version();
ALTER TABLE timeline_sections DROP COLUMN IF EXISTS section_version;
```

**Expand/contract check for 081:** the previous image issues `UPDATE timeline_sections SET …` with no
mention of the new column. The trigger bumps it anyway; the column has a default; nothing breaks.
Safe as a rollback target.

### `082_sim_action_recordings.sql`

```sql
-- 082: the durable record of one Apply — request identity, compiled plan, lease, and the stored
-- terminal response that a retry replays verbatim.
--
-- NOT sim_meta. sim_meta is compact provenance carried by the published section; this table is the
-- REQUEST's lifecycle, including rows that never publish. Mixing them would put failed attempts in
-- the artifact.
--
-- WHAT THIS TABLE CANNOT DO. A CHECK constraint sees only NEW, never OLD, so it cannot enforce a
-- state TRANSITION. Every constraint below is a per-row invariant. Transitions are enforced by
-- conditional UPDATE predicates (`WHERE status = $from AND lease_owner = $me`), exactly as
-- RevisionService.transition does at RevisionService.ts:250-273.
CREATE TABLE IF NOT EXISTS sim_action_recordings (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  project_id            uuid NOT NULL REFERENCES projects(id)          ON DELETE CASCADE,
  section_id            uuid NOT NULL REFERENCES timeline_sections(id) ON DELETE CASCADE,
  simulation_id         uuid NOT NULL REFERENCES simulations(id)       ON DELETE CASCADE,
  created_by            uuid NOT NULL REFERENCES users(id)             ON DELETE CASCADE,

  -- ── FENCES, captured at snapshot time ────────────────────────────────────────────────────────
  -- NO FK on source_revision_id, deliberately. RevisionService.gc() DELETES sim_revisions rows
  -- (RevisionService.ts:895-905), and a NOT NULL FK here would make the reaper fail on any
  -- simulation that ever had a recording. This is a historical fact about a request, not a live
  -- reference: it must outlive the row it names, the same reasoning saved_bridges gives for
  -- copying a bridge body instead of pointing at it (079_saved_bridges.sql).
  source_revision_id    uuid NOT NULL,
  source_package_hash   text NOT NULL,
  section_version       bigint NOT NULL,

  -- ── IDENTITY ─────────────────────────────────────────────────────────────────────────────────
  -- Scoped to the project, NOT globally unique like jobs.idempotency_key (schema.ts:359): a
  -- client-generated key that is globally unique lets one tenant deny another's key.
  idempotency_key       text NOT NULL,
  -- sha256 of the canonical command (route ids + canonicalized recording). Claimed BEFORE compile,
  -- because plan_hash does not exist yet at that point. Same key with a different hash ⇒ 409.
  request_hash          text NOT NULL,

  -- ── PAYLOAD ──────────────────────────────────────────────────────────────────────────────────
  schema_version        integer NOT NULL,
  compiler_version      text NOT NULL,
  execution_kind        text NOT NULL,
  -- Typed, normalized IR only — never rrweb, never HTML. Validated by the Zod schema in
  -- shared/src/sim/actionRecording.ts on the way in AND on the way out; a jsonb column is a
  -- storage format, not a type. Both are stored so editing loads semantic SOURCE and a
  -- recompilation never reverse-engineers the artifact.
  source_recording      jsonb NOT NULL,
  recording_hash        text NOT NULL,
  plan                  jsonb,
  plan_hash             text,

  -- ── LIFECYCLE ────────────────────────────────────────────────────────────────────────────────
  status                text NOT NULL DEFAULT 'received',
  lease_owner           text,
  lease_expires_at      timestamptz,
  attempt_count         integer NOT NULL DEFAULT 0,

  -- ── OUTCOME ──────────────────────────────────────────────────────────────────────────────────
  -- SET NULL, not CASCADE: gc reclaiming the revision must not erase the audit record of the apply.
  published_revision_id uuid REFERENCES sim_revisions(id) ON DELETE SET NULL,
  bridge_hash           text,
  artifact_hash         text,
  proof_artifact_hash   text,
  failure_code          text,
  -- The stored answer. A retry of a terminal row replays THESE, never a reconstruction from live
  -- sim_meta — which may describe a later publication.
  response_http_status  integer,
  response_json         jsonb,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  applied_at            timestamptz
);

DO $$ BEGIN
  ALTER TABLE sim_action_recordings ADD CONSTRAINT sim_action_recordings_status_chk
    CHECK (status IN ('received','compiling','staged','proving','activating','applied','failed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE sim_action_recordings ADD CONSTRAINT sim_action_recordings_execution_kind_chk
    CHECK (execution_kind IN ('final-state','timeline'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A row past compile HAS a plan; a row before it does not. Per-row, so a CHECK can hold it.
DO $$ BEGIN
  ALTER TABLE sim_action_recordings ADD CONSTRAINT sim_action_recordings_plan_chk
    CHECK (
      (status IN ('received','compiling') AND plan IS NULL AND plan_hash IS NULL)
      OR (status = 'failed')
      OR (plan IS NOT NULL AND plan_hash IS NOT NULL)
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A terminal row IS its stored response. Without this, a crash between activation and the response
-- write leaves a row a retry cannot replay — and the retry would rebuild and republish.
DO $$ BEGIN
  ALTER TABLE sim_action_recordings ADD CONSTRAINT sim_action_recordings_terminal_chk
    CHECK (
      status NOT IN ('applied','failed')
      OR (response_http_status IS NOT NULL AND response_json IS NOT NULL)
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE sim_action_recordings ADD CONSTRAINT sim_action_recordings_applied_chk
    CHECK (status <> 'applied' OR (published_revision_id IS NOT NULL AND applied_at IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Indexes ────────────────────────────────────────────────────────────────────────────────────
-- THE idempotency guarantee. Scoped, not global. This is what makes two workers safe, per §15.2 —
-- not the in-process lock (SimulationService.ts:2439), which is per-instance.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_sim_action_recordings_project_key
  ON sim_action_recordings(project_id, idempotency_key);

-- The editor's list for one section.
CREATE INDEX IF NOT EXISTS idx_sim_action_recordings_section_created
  ON sim_action_recordings(section_id, created_at DESC);

-- LEASE RECOVERY. PARTIAL — Postgres supports it, and a total index here would be almost entirely
-- terminal rows that recovery never scans. Drizzle's index builder has no WHERE clause, so like
-- uniq_sim_revisions_active (050:105-107) this index lives in the migration ONLY. Declaring it in
-- schema.ts would silently create a total index.
CREATE INDEX IF NOT EXISTS idx_sim_action_recordings_expired_lease
  ON sim_action_recordings(lease_expires_at)
  WHERE status NOT IN ('applied','failed');

-- TTL sweep for unapplied drafts (ADR M3).
CREATE INDEX IF NOT EXISTS idx_sim_action_recordings_status_updated
  ON sim_action_recordings(status, updated_at);
```

```sql
-- 082 rollback. A leaf table like saved_bridges: nothing references it, so there is no ordering to
-- respect. Dropping it DESTROYS the source recordings — the semantic IR exists only here, having
-- been stored precisely so an edit never has to reverse-engineer the compiled artifact. Published
-- sections keep their bytes, their sim_meta and their revisions; what is lost is the ability to
-- re-edit or re-compile them. Dump before running if any recording has been applied.
DROP INDEX IF EXISTS idx_sim_action_recordings_status_updated;
DROP INDEX IF EXISTS idx_sim_action_recordings_expired_lease;
DROP INDEX IF EXISTS idx_sim_action_recordings_section_created;
DROP INDEX IF EXISTS uniq_sim_action_recordings_project_key;
DROP TABLE IF EXISTS sim_action_recordings;
```

## 2.8 What must be TESTED — Item 2

Migration tests follow `db/__tests__/migration050.test.ts` / `migration062.test.ts` (real engine,
forward + idempotent re-run + rollback).

| # | Test |
|---|---|
| T2.1 | `uniq_sim_action_recordings_project_key` rejects a second row with the same `(project_id, idempotency_key)` (`23505`), and **accepts** the same key under a different project |
| T2.2 | every CHECK: unknown `status` → `23514`; `applied` without `published_revision_id`/`applied_at` → `23514`; `applied`/`failed` without a stored response → `23514`; `staged` with a NULL `plan` → `23514` |
| T2.3 | the lease CAS: two concurrent claimers, exactly one wins; the loser gets zero rows; after `lease_expires_at` passes, the loser wins and `attempt_count` is 2 |
| T2.4 | the lease CAS refuses to resume when `request_hash`, `source_revision_id` or `section_version` differs — one test per fence, each proving it **alone** blocks resumption |
| T2.5 | `idx_sim_action_recordings_expired_lease` is created **partial** — assert `indexdef` matches `/WHERE .*status/`, the same assertion `migration050.test.ts:264` makes for `uniq_sim_revisions_active` |
| T2.6 | `gc()` can still delete a `sim_revisions` row that a recording names via `source_revision_id` (proves the missing FK is deliberate), while `published_revision_id` goes NULL and the row survives |
| T2.7 | deleting the project cascades the recordings; deleting the section cascades; deleting the **user** cascades (matches `saved_bridges`) |
| T2.8 | 081 forward is idempotent; existing rows all get `section_version = 1`; the column is `NOT NULL` |
| T2.9 | **the trigger, mutation-checked:** an `UPDATE` issued by a statement that never mentions `section_version` still bumps it; an `UPDATE` that sets an unrelated column bumps it; an `INSERT` starts at 1; two sequential updates give 3. Then delete the trigger and prove the suite goes red |
| T2.10 | the fenced section UPDATE affects **zero** rows when `section_version` moved, and the enclosing `activate()` therefore rolls back — assert the revision is **not** active and the section is unchanged (extends `bridgePublication.test.ts`) |
| T2.11 | terminal-state atomicity: make `onActivated` write `applied` and then force the transaction to abort; assert the recording row is still `activating` and no revision is active — i.e. the two really are one transaction |
| T2.12 | retry matrix (§2.5), one test per row, including: retry of an `applied` row returns the **stored** `response_json` byte-for-byte after `sim_meta` has been changed by a later publication |
| T2.13 | same `Idempotency-Key`, different body ⇒ `409 idempotency_conflict`, and **no** second compile (spy on the compiler) |
| T2.14 | `source_recording` and `plan` round-trip through `jsonb` without double-encoding — the failure `db/jsonb.ts:3-11` documents. Assert `jsonb_typeof(source_recording) = 'object'` after a real service write, not after a hand-written SQL insert |
| T2.15 | `migrate.ts:69` and `check-db.ts:20` list both new files, in sorted position (see T1.10) |

---

## 3. Where the report's §9 / §15 is contradicted by the code

Flagged as instructed. Each is a correction to the report, not a new opinion.

1. **§15.5 and D8's rationale: "`canary_passed` is publicly served [because] the pre-activation canary
   drives the real document over the public route."** The premise about the canary is **false** —
   `client-web/e2e/sim-canary.spec.ts:1710-1725` intercepts every request to the API origin and
   fulfils it from a local fixture server (`:311-340`, `:306`), and `playwright.canary.config.ts:6-9`
   states it does not touch the network. The conclusion (`canary_passed` is public) is true, but by
   omission from a deny-list (`revisionIdentity.ts:46-53`), not by this requirement. **This makes
   option (c) cheaper than the report assumes and is why §1.5 recommends it.** The same false claim
   is in `revisionIdentity.ts:44-45` and in two test headers; fix all four together.
2. **§15.3: "checks for state transitions".** A Postgres `CHECK` sees only `NEW`, never `OLD`, so it
   **cannot** express a transition. Only per-row invariants are expressible (§2.7). Transitions must
   be conditional `UPDATE` predicates, as `RevisionService.transition` (`:250-273`) already does.
3. **§15.3 assumes `section_version` exists.** It does not — `timeline_sections`
   (`db/schema.ts:723-798`) has no version and no `updated_at`. The report specifies the fence on the
   *recordings* table without specifying where the value comes from. §2.2 closes that.
4. **§15.3: `source_revision_id uuid not null` with an implied reference.** A real FK would break
   `RevisionService.gc()`, which DELETEs `sim_revisions` rows (`:895-905`) and now has a production
   caller (`revisionGcSweep.ts` ← `server.ts:64`). Store it FK-free; §2.7 explains why in the DDL.
5. **§15.3: `created_by uuid not null`.** Correct for this table (Apply is always an authenticated
   user) — but note it diverges from `sim_revisions.created_by`, which is `TEXT` with **no** FK on
   purpose (`050:65-66`: "the actor may be a script"). The precedent to follow is `saved_bridges`
   (`079`): `uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE`.
6. **§15.2: "cross-worker safety relies on database uniqueness, a lease, and revision CAS, not an
   in-memory lock."** Correct, and the codebase agrees in writing (`RevisionService.ts:12-22`,
   `SimulationService.ts:2413-2422`) — but the report does not say that the **terminal response must
   be written inside `onActivated(tx)`**. Without that, a crash between activation and the response
   write produces a non-terminal row over a published revision, and the retry republishes (§2.6).
7. **§15.1 step 8 (`202` + background job).** The queue is pg-boss with at-least-once delivery
   (`queue/pgBossDriver.ts:151`). `lease_owner` must therefore be the **job id**, not the process id,
   or a redelivery to the same worker walks past its own lease (§2.4).
8. **ADR §6 criterion 4 ("a non-public proof state exists") is satisfiable without a migration.**
   Option (c) alone makes both `validating` and `canary_passed` non-public. The report presents the
   choice as "add states **or** hold in validating"; the third option is cheapest, strictly safest,
   and is the prerequisite for the other two.

## 4. Decision summary

| Question | Answer |
|---|---|
| Non-public proof state — which option? | **(c) now**, allow-list inversion, code-only, no migration. **(a) in Phase 2** as its own migration. **(b) rejected.** |
| Does the canary block (c)? | **No.** It never touches the public route (§1.3). |
| Is `sim_revisions.status` an enum? | No — `text` + inline `CHECK` (`050:41-43`). New values need a migration, but not `ALTER TYPE`. |
| Is rollback revocation? | **No.** `retired` and `rolled_back` stay publicly reachable. Runbook line, verbatim. |
| Does `sectionVersion` exist? | **No.** Add `timeline_sections.section_version bigint NOT NULL DEFAULT 1` + a `BEFORE UPDATE` trigger. No table rewrite on PG 11+. |
| Is the in-process lock enough for two workers? | **No** — per-instance, two processes, and a CAS conflict is not an idempotent reply (§2.1). |
| Existing idempotency to reuse? | Key derivation from `startIdempotency.ts`; partial-unique-index precedent from `062`. **No durable request-idempotency table exists.** |
| Next migration number | **081**, then 082. Register each in `migrate.ts:66` **and** `check-db.ts:20`, with a `.rollback.sql` sibling. |
