# Priorities 4–6 — staged rollout and rollback

Nothing in this branch changes how any package currently behaves in production. Every new path is
reachable only after an explicit, reversible step below. This document is the sequence, and the way
back from each step.

---

## What is already inert on merge

| Change | Why it is inert |
|---|---|
| v3 protocol modules (`shared/src/sim/*`) | pure code; nothing imports them on a path a legacy package can reach |
| `SimTransport` | only opened by `enableModern`, which refuses any class below `managed-presentable` |
| v3 child runtime in generated bridges | emitted only when `wrapBridgeCombined` is called with `{ runtimeV3: true }` — the production generation path. Stored packages are untouched until regenerated. It runs *beside* the v2 listener, never instead of it |
| `sim_posters` table, `bridge_hash` / `package_class` / `canary_report` / `canary_at` columns | migration 049 adds them; all nullable, no backfill, nothing reads a null as anything but "unproven". Inert in *behaviour* — but see Stage 0: the schema must exist before the image runs |
| `SimPresentationLayers` | rendered only when the active package is `managed-presentable` **and** the runtime reports a live modern transport |
| poster storage | no posters exist until a canary captures them |

A package with `package_class = NULL` — which is every package in production right now — takes
exactly the v2 path it takes today.

---

## Stage 0 — apply migration 049 **before** the new image serves traffic

This is the one ordering constraint in the whole rollout, and it is not optional.

Migration 049 is additive — one new table (`sim_posters`), four nullable columns on `simulations`
(`bridge_hash`, `package_class`, `canary_report`, `canary_at`), `CREATE TABLE IF NOT EXISTS` /
`ADD COLUMN IF NOT EXISTS` throughout — so applying it to the *old* image's database is a no-op for
the old image. The reverse is not true. `backend-api/src/db/schema.ts` in this branch declares all
four columns and the `sim_posters` table, and Drizzle emits **every declared column** in a full-row
select. An image built from this branch, pointed at a database where 049 has not been applied,
fails every `db.query.simulations` read — about twenty call sites, including `buildPlayerConfig`,
the player's hottest path.

**Symptom if the order is broken:** PostgreSQL `42703` (`undefined_column`),
`column simulations.bridge_hash does not exist` (or `package_class` / `canary_report` /
`canary_at`), surfacing as a 500 on essentially every project and viewer endpoint. `sim_posters`
reads fail separately with `42P01` (`undefined_table`). `buildPlayerConfig` and the `bridge_hash`
write in `SimulationService.uploadSectionBridge` each catch their own version of this, so those two
paths degrade rather than 500 — but they are the only two. The full-row reads in the simulations,
sections, editor-state and projects controllers do not, and none of this is a safety net to deploy
against on purpose.

```bash
pnpm --filter backend-api db:migrate    # applies 049 (registered in src/db/migrate.ts)
pnpm --filter backend-api db:check
```

Note that preview and production share one database (see `CLAUDE.md`), so this runs **once** and
both environments see it. Run it before the preview deploy, not between preview and publish.

**Proof it is safe:** `backend-api/src/db/__tests__/migration049.test.ts` replays the real
migrations 001–048 into an in-process Postgres (PGlite), then applies the real 049 file on top and
asserts: it applies cleanly, it is idempotent, a pre-existing `simulations` row survives with the
four new columns NULL, the real Drizzle query shapes (full-row `findMany`, the narrowed
`columns: { id, package_class, bridge_hash }` form, and the `sim_posters` read) all succeed
afterwards — and that those same queries raise `42703`/`42P01` *before* it. That last group is the
regression test for this ordering hazard. It touches no shared database.

**Rollback:** `backend-api/src/db/migrations/049_sim_posters.rollback.sql` drops the table and the
four columns, then delete the tracker row:

```bash
psql "$DATABASE_URL" -f backend-api/src/db/migrations/049_sim_posters.rollback.sql
psql "$DATABASE_URL" -c "DELETE FROM schema_migrations WHERE filename = '049_sim_posters.sql'"
```

The rollback is reversible (the test proves the round-trip restores the exact pre-049 catalog and
that re-applying works), but it is **not unconditional**: it is only safe once the image running
against this database no longer declares those columns. Roll the image back first, then the
migration — the same ordering as Stage 0, in reverse.

**Verify:** the viewer behaves identically. `package_class` is null for every row, so
`enableModern` declines for every package and `SimTransport` is never opened.

---

## Before Stage 1 — what a regenerated package can actually reach today

A regenerated package carries the v3 runtime and can be canaried, but it will classify
**`managed-partial`**, not `managed-presentable`. That is correct behaviour, not a bug: the
generation prompt emits cleanup-closure section bodies, the child wraps them as legacy, and a
package whose bodies cannot suspend or render on demand must not claim it can.

The practical consequence: **Stages 1–3 below will not turn on the v3 reveal path for a customer
package.** They will embed the runtime, produce an honest verdict, and leave the package on v2.

To reach `managed-presentable`, the generator must emit `ManagedSectionLifecycle` bodies — objects
with `present(ctx)` that call `ctx.markPresented()` and allocate through `ctx.scope` — instead of
returning a cleanup function. That is the next piece of work and is **not** part of Priorities 4–6.
Until it exists, treat Stages 1–3 as exercising the publication machinery, not as enabling the
feature.

---

## Stage 1 — regenerate ONE package's bridge

Pick a low-traffic simulation. Regenerating its bridge embeds the v3 child runtime.

```bash
# The existing Priority 1 tooling proves the transform preserves every section body byte-for-byte.
tsx backend-api/src/scripts/prove-sim-rebuild.ts --sim <simulationId>
tsx backend-api/src/scripts/backup-sim-packages.ts --sim <simulationId>   # writes the rollback manifest
```

Then trigger a normal bridge regeneration for that simulation through the product (editing and
saving any of its sections regenerates `bridge.js`).

**What changes:** the stored `bridge.js` grows by the v3 runtime. The v2 listener, the section
bodies, the rAF gate and `SIM_READY` are unchanged, so the package still behaves identically to a
player that never offers a port — which is every player, because the package is still unclassified.

**Rollback:** restore the package from the backup manifest
(`backend-api/src/scripts/backup-sim-packages.ts verify` then the restore path documented in
`SIM-REBUILD-ROLLOUT.md`).

**Verify:** the section still plays. `curl` the served `bridge.js` and confirm it contains
`@@SIM_RUNTIME_V3_START@@` and still contains `dispatch: 'dynamic'`.

---

## Stage 2 — canary that package

```bash
# Real browser, every variant and required configuration.
cd client-web
npx playwright test --config=playwright.canary.config.ts --retries=0
# → e2e-results/sim-canary.json  +  e2e-results/sim-canary-posters/<identity>/{standard,compact}.png
```

Then inspect the verdict **without writing anything**:

```bash
tsx backend-api/src/scripts/sim-canary-publish.ts \
  --report client-web/e2e-results/sim-canary.json --sim <simulationId>
```

Exit codes:

| Code | Meaning |
|---|---|
| 0 | plan printed (dry run) or applied |
| 2 | bad arguments |
| 3 | report unreadable |
| 4 | **report incomplete** — the run observed nothing; re-run, do not record a class |
| 5 | **stamped classification is not supported by the report's own steps** |
| 6 | simulation not found |
| 7 | **would grant the modern path but posters are missing** |
| 8 | write failed |

Codes 4, 5 and 7 are refusals, not errors to work around. In particular 7: a modern package's
failure policy offers `poster-only` as its *first* recovery action, so granting the modern path
without the poster publishes a promise the runtime cannot keep.

**Rollback:** nothing was written. Re-running is free.

---

## Stage 3 — publish the verdict

```bash
tsx backend-api/src/scripts/sim-canary-publish.ts \
  --report client-web/e2e-results/sim-canary.json --sim <simulationId> --apply
```

Writes, in this order: poster objects → poster rows → `package_class` / `canary_report` /
`canary_at`. Objects precede rows because a row referencing bytes that do not exist renders a broken
cover, while bytes with no row are merely invisible until the next sweep.

**This is the step that changes player behaviour.** If the verdict is `managed-presentable`, the
next viewer session for that package will:

- offer a `MessageChannel` bootstrap and complete the v3 handshake;
- drive `PREPARE_SECTION` → `SECTION_APPLIED` → `PRESENT_SECTION` → `SECTION_PRESENTED`;
- reveal only on an identity-matched `SECTION_PRESENTED`, with **no force path**;
- render through `SimPresentationLayers`, showing the poster while the incoming frame is unproven.

Any other verdict leaves the package on v2.

**Rollback — instant, one statement, no deploy:**

```sql
UPDATE simulations SET package_class = NULL WHERE id = '<simulationId>';
```

The next player session sees an unproven package and takes the v2 path. Posters and the canary
report stay on file and are re-usable; nothing has to be deleted to roll back.

---

## Stage 4 — widen

Repeat stages 1–3 per package. There is no global switch, and that is deliberate: the classification
is per package because the guarantee is per package. A package that regresses is rolled back on its
own without touching any other.

Watch these telemetry events (they already flow through `simTelemetry`):

| Event | Meaning | Action if frequent |
|---|---|---|
| `transport-legacy-no-answer` | a supposedly-modern package did not adopt the port | roll that package back to v2 |
| `modern-reveal-refused` | the invariant refused a reveal — includes the exact `refusal` | investigate; refusal is correct behaviour, frequency is the signal |
| `modern-failure` | bounded failure, with `kind` and `breakerOpen` | roll back if the breaker is opening for real users |
| `envelope-rejected` | a message failed validation, with the exact reason | a healthy package should produce none |
| `modern-presented-without-frame` | a child claimed a presentation with zero frames | roll back that package immediately — it is misreporting |

---

## Poster maintenance

```bash
# What exists in storage that no live configuration references any more.
tsx backend-api/src/scripts/sim-canary-publish.ts --report <r> --sim <id> --apply --prune
```

`--prune` runs `PosterService.invalidate` for the *new* revision, and only after the new verdict is
durable — pruning first would leave a live section resolving to a poster whose bytes were already
deleted. `cleanupOrphans` refuses an empty `liveKeys` set unless explicitly told to allow it,
because an empty set is indistinguishable from a caller that failed to load its sections.

---

## What is NOT part of this rollout

Immutable package revisions, atomic publication and rollback pointers are Priority 7. Until then
`packageRevision` is derived from the simulation id plus **`simulations.bridge_hash`**, written on
every bridge regeneration. The section URL's `?v=` parameter is a fallback only, for rows written
before that column existed — deriving from it per-section was wrong and is fixed: regenerating one
section rewrites the shared bridge but stamps the new hash onto only that section's URL, which split
a single package into two identities and re-opened the transport mid-session.

Posters invalidate by derivation (their identity carries the revision), but **the canary verdict is
cleared explicitly**: the same write that records a new `bridge_hash` nulls `package_class`,
`canary_report` and `canary_at`, because a verdict is a statement about specific bytes and
derivation never touched that column. An idempotent regeneration producing an identical hash keeps
its verdict. When real revisions land, only `derivePackageRevision` and `posterStoragePath` change;
every consumer already treats the value as opaque.

Physical iPhone and Android validation remains untested — no device access. WebKit is the closest
available proxy and is run on every gate. This stays a prerequisite for a broad rollout.
