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
| `sim_posters` table, `package_class` / `canary_report` / `canary_at` columns | migration 049 adds them; all nullable, no backfill, nothing reads a null as anything but "unproven" |
| `SimPresentationLayers` | rendered only when the active package is `managed-presentable` **and** the runtime reports a live modern transport |
| poster storage | no posters exist until a canary captures them |

A package with `package_class = NULL` — which is every package in production right now — takes
exactly the v2 path it takes today.

---

## Stage 0 — merge, change nothing

Apply migration 049. It is additive: one new table, three nullable columns, `ADD COLUMN IF NOT
EXISTS` throughout.

```bash
pnpm --filter backend-api db:migrate
pnpm --filter backend-api db:check
```

**Rollback:** `backend-api/src/db/migrations/049_sim_posters.rollback.sql` drops the table and the
three columns. Nothing references them yet, so the rollback is unconditional.

**Verify:** the viewer behaves identically. `package_class` is null for every row, so
`enableModern` declines for every package and `SimTransport` is never opened.

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
# → e2e-results/sim-canary.json  +  e2e-results/posters/<identity>/{standard,compact}.png
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
`packageRevision` is derived from the simulation id plus the bridge hash in the section URL, which
means a regenerated bridge automatically invalidates its posters and its canary verdict — correct
behaviour, achieved by derivation rather than by publication. When real revisions land, only
`derivePackageRevision` and `posterStoragePath` change; every consumer already treats the value as
opaque.

Physical iPhone and Android validation remains untested — no device access. WebKit is the closest
available proxy and is run on every gate. This stays a prerequisite for a broad rollout.
