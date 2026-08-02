# Stored-bridge rebuild — executable rollout package

Everything below has been rehearsed against the real database and real storage **in read-only
mode**. The one step that writes to shared storage (`rebuild-sim-bridges.ts --apply`) has **not**
been run: it must happen in a window coordinated with the player deploy, and it is not safe to
fire from a development machine while generation traffic may be in flight. This document is the
exact command sequence, with the verification and the rollback.

---

## 0. What is actually being rebuilt — verified inventory

Run `npx tsx --env-file=../.env src/scripts/inventory-sim-packages.ts` from `backend-api/` to
regenerate this. It reads the **stored bytes**, not just the database rows.

| package | sim id | entry | bridge.js | sections | timeline rows | rebuildable |
|---|---|---|---|---|---|---|
| `boids-3d` | `49d20194…` | ✅ 17594 b | ✅ 23850 b | **5** | 8 | ✅ |
| `murmuration-knob` | `40ab5c21…` | ✅ 16914 b | ✅ 11042 b | **2** | 3 | ✅ |
| `pluck-boids` | `a1ee064e…` | ✅ 17594 b | ✅ 7874 b | **1** | 2 | ✅ |
| `example` | `29271763…` | ✅ 23359 b | ❌ **404** | 0 | 1 | ❌ regenerate |
| `ising-kid-simu-complete` | `aeb08ce1…` | ❌ **404** | ❌ **404** | 0 | 3 | ❌ obsolete |
| `ising-kid-part2` | `52713ac2…` | ❌ **404** | ❌ **404** | 0 | 3 | ❌ obsolete |

**Only three of the six "ready" simulations can be rebuilt.** The other three have no bridge in
storage at all — two have no entry HTML either, so they cannot render today and are not made worse
or better by this rollout. Do not treat "3 of 6" as a partial failure; it is the true inventory.

Verified live: **0 of 6 currently carry the hardened bridge** (`ackCapable=false` on every row), so
none of the bridge-side fixes reach existing content until this runs.

---

## 1. Pre-flight (read-only, safe any time)

```bash
cd backend-api

# 1a. Inventory — confirm the table above still matches reality.
npx tsx --env-file=../.env src/scripts/inventory-sim-packages.ts --json /tmp/inv.json

# 1b. Preservation proof — runs the exact rebuild transform in memory and diffs every
#     section body before/after. Exits non-zero if ANY body would change.
npx tsx --env-file=../.env src/scripts/prove-sim-rebuild.ts \
  --json /tmp/preservation.json --dump-dir /tmp/rebuilt-packages

# 1c. Dry run of the real tool — writes nothing.
npx tsx --env-file=../.env src/scripts/rebuild-sim-bridges.ts
```

**Expected 1b result (this is the proof, reproduce it before applying):** 3/3 packages PROVEN.
All **8 section bodies byte-identical** — not merely equal after whitespace normalisation. Zero
sections added, removed or renamed. Rebuild is **idempotent** (a second pass is a byte-for-byte
no-op, so a re-run after a partial failure cannot accumulate changes). Entry keeps gate v4 and its
bridge tag hash matches the bytes that would be written. Each package gains all six hardened
capabilities: `SCRIPT_APPLIED`, `SCRIPT_MISSING`, `SCRIPT_ERROR`, `pauseScript`, `simDemoTimer`,
`_sysRaf`.

## 2. Real-browser validation of the rebuilt artefacts (before any write)

Serves the **rebuilt** entry + bridge from `--dump-dir` while proxying every other asset to the
live backend, so the actual WebGL scenes run against the new bridge.

```bash
cd client-web
REBUILT_DIR=/tmp/rebuilt-packages npx playwright test --config=playwright.rebuilt.config.ts
```

Asserts, per package and per section: the document boots (`SIM_READY`), the rebuilt bridge
**acknowledges** (`SCRIPT_APPLIED` — the capability the rebuild exists to add), an unknown section
reports `SCRIPT_MISSING` instead of silently running another body, A→B→A repeats five times
without error on multi-section packages, and `pauseScript` is answered without tearing the section
down. Zero page errors.

## 3. Take the rollback point (REQUIRED — this is the only undo)

Storage has no versioning and the rebuild overwrites in place.

```bash
cd backend-api
STAMP=$(date +%Y%m%d-%H%M%S)

# Rehearse first.
npx tsx --env-file=../.env src/scripts/backup-sim-packages.ts backup ./sim-backup-$STAMP --dry-run

# Then take it for real. Exits NON-ZERO if anything was unreadable; a failed run writes
# manifest.incomplete.json, never manifest.json, so it can never be mistaken for a rollback point.
npx tsx --env-file=../.env src/scripts/backup-sim-packages.ts backup ./sim-backup-$STAMP
echo "backup exit: $?"     # MUST be 0

# Independent verification: hashes on disk, and drift vs storage.
npx tsx --env-file=../.env src/scripts/backup-sim-packages.ts verify ./sim-backup-$STAMP --live
```

The backup captures, per package: `bridge.js`, the entry HTML, **and `guidance.js` when present**.
guidance.js is in the set because the entry HTML the rebuild rewrites is the same file that carries
the `guidance.js?v=<hash>` tag — restoring the HTML alone would leave that tag describing bytes
that are no longer there.

Keep `./sim-backup-$STAMP` somewhere durable before step 4.

## 4. Apply

```bash
cd backend-api
npx tsx --env-file=../.env src/scripts/rebuild-sim-bridges.ts --apply
echo "rebuild exit: $?"    # MUST be 0 — non-zero means the rollout is INCOMPLETE
```

The tool re-reads **both** files immediately before writing and refuses the package on drift
(`CONFLICT`), because the live generation and guidance-publish paths do the same read-modify-write
under in-process locks that a separate process cannot join. A conflict is not an error to force
through — it means a user generation or guidance publish landed mid-run. Re-run.

**Prefer a window with generation traffic stopped.** The conflict check narrows the race; it does
not eliminate it.

## 5. Verify after writing

```bash
cd backend-api
# Inventory again: the three rebuilt packages must now report ack/missing/pause/demoTimer = true.
npx tsx --env-file=../.env src/scripts/inventory-sim-packages.ts

# Fetch through the REAL serving path and confirm the new bridge is what users receive.
npx tsx --env-file=../.env src/scripts/prove-sim-rebuild.ts   # must report 0 capabilities gained now
```

Then re-run step 2's browser validation against the live URLs, and smoke the viewer on a project
that uses `boids-3d` (5 sections — the widest dispatch surface).

## 6. Rollback

```bash
cd backend-api
# Rehearse: pre-flights every byte, uploads nothing.
npx tsx --env-file=../.env src/scripts/backup-sim-packages.ts restore ./sim-backup-$STAMP --dry-run

# Roll back for real. Every restored object is READ BACK and hash-compared before success.
npx tsx --env-file=../.env src/scripts/backup-sim-packages.ts restore ./sim-backup-$STAMP
echo "restore exit: $?"    # MUST be 0
```

Restore order is guidance → bridge → entry, so an interruption never leaves the entry HTML
pointing at a hash that is not there. A manifest whose `complete` flag is false is refused.

**Rollback criteria — restore immediately if, after step 4:** any package fails step 5's
capability check; the viewer shows a wrong sub-simulation for any section; a package errors in the
browser check; or the rebuild exited non-zero. Do not continue to later packages after an
unexplained failure.

---

## Orphaned timeline rows — classified, none repaired

`npx tsx --env-file=../.env src/scripts/classify-orphan-sim-rows.ts`

Nine timeline rows have a `simulation_url` with no `?section=` identity, so the bridge falls back
to the package default and they render a different variation than intended.

| class | rows | disposition |
|---|---|---|
| **obsolete** | 6 (`ising-kid-simu-complete` ×3, `ising-kid-part2` ×3) | package has neither entry nor bridge in storage — nothing can render with or without a key |
| **requires-author-review** | 2 (`5c96b6b3…` → `pluck-boids`, `a7765242…` → `boids-3d`) | a bridge exists, but no stored content records which variation the row meant |
| **requires-regeneration** | 1 (`baccb89b…` → `example`) | entry exists, `bridge.js` absent — no section bodies to point at |

**Zero rows are provably repairable, so zero rows were modified.** The tool only repairs the one
case where the intended key is evidence rather than inference — the row's own id appearing as a
section id in that package's bridge — and prints the exact rollback `UPDATE` before touching
anything. None of the nine qualify. None of them block the three-package rebuild.
