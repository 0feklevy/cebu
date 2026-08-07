# Stored-bridge rebuild — executable rollout package

Everything below has been rehearsed against the real database and real storage **in read-only
mode**. The one step that writes to shared storage (`rebuild-sim-bridges.ts --apply`) has **not**
been run: it must happen in a window coordinated with the player deploy, and it is not safe to
fire from a development machine while generation traffic may be in flight. This document is the
exact command sequence, with the verification and the rollback.

**Every step is gated by its exit code, not by reading the output.** Each tool drains stdout/stderr
before exiting, so `… | tee rollout.log` cannot truncate the line that explains a failure. Check
`$?` after every command; a non-zero code means STOP.

| step | script | writes | exit 0 means |
|---|---|---|---|
| 1a | `inventory-sim-packages.ts` | nothing | (informational — always 0) |
| 1b | `prove-sim-rebuild.ts` | `--json` / `--dump-dir` only | every inventory-rebuildable package was **examined and proven** |
| 1c | `rebuild-sim-bridges.ts` (no flag) | nothing | no package failed the dry run |
| 3 | `backup-sim-packages.ts backup` | local disk | every required file captured **and** read back |
| 4 | `rebuild-sim-bridges.ts --apply` | **storage** | every package updated, no conflict |
| 5 | `verify-sim-rebuild.ts` | nothing | stored bytes hardened **and** served bytes agree |
| 6 | `backup-sim-packages.ts restore` | **storage** | every object restored and hash-verified |

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

"Rebuildable" has exactly one definition, shared by every tool below: **a combined bridge (parsed
`@@SIM_BRIDGE:` section bodies) plus an entry HTML that reads.** Step 1b cross-checks its proven set
against that inventory definition and step 5 scopes its verification to it, so a package that
silently drops out of the set fails the run instead of shrinking it.

Verified live: **0 of 6 currently carry the hardened bridge** (`ackCapable=false` on every row), so
none of the bridge-side fixes reach existing content until this runs.

---

## 1. Pre-flight (read-only, safe any time)

```bash
cd backend-api

# 1a. Inventory — confirm the table above still matches reality.
npx tsx --env-file=../.env src/scripts/inventory-sim-packages.ts --json /tmp/inv.json

# 1b. Preservation proof — runs the exact rebuild transform in memory and diffs every
#     section body before/after. PRE-APPLY ONLY (see the warning below).
npx tsx --env-file=../.env src/scripts/prove-sim-rebuild.ts \
  --json /tmp/preservation.json --dump-dir /tmp/rebuilt-packages
echo "proof exit: $?"      # MUST be 0

# 1c. Dry run of the real tool — writes nothing.
npx tsx --env-file=../.env src/scripts/rebuild-sim-bridges.ts
echo "dry-run exit: $?"    # MUST be 0
```

**Expected 1b result (this is the proof, reproduce it before applying):**

```
Accounting: 6 discovered = 3 checked (3 PROVEN, 0 failed) + 0 skipped + 3 unreadable + 0 errored.
Inventory says 3 package(s) are rebuildable; 3 of them are proven.
✅ 3/3 rebuildable package(s) PROVEN safe to rebuild.
```

The three unreadable rows are the three §0 packages whose `bridge.js` is a hard 404 — they are
named individually with their reason (a package with an underivable `entry_file` is reported under
`skipped` instead). They do **not** fail the gate, because the 1a inventory does not call them
rebuildable and step 4 will not write to them. Any *other* package appearing in those buckets does
fail the gate. **Confirm the three names match §0** before continuing: the count moving is the
signal that storage, credentials or the data changed.

All **8 section bodies byte-identical** — not merely equal after whitespace normalisation. Zero
sections added, removed or renamed. Rebuild is **idempotent** (a second pass is a byte-for-byte
no-op, so a re-run after a partial failure cannot accumulate changes). Entry keeps gate v4 and its
bridge tag hash matches the bytes that would be written. Each package gains the hardened
capabilities `SCRIPT_APPLIED`, `SCRIPT_MISSING`, `SCRIPT_ERROR`, `pauseScript`, `simDemoTimer`,
`_sysRaf`. (`ownPropGuard`/`hasOwnProperty` is asserted too but may already be present in a legacy
bridge, so it does not always appear in the *gained* list — losing it would still fail.)

**What makes 1b a gate and not a printout.** It exits non-zero if it proved **nothing**, if any
package was skipped, unreadable or threw, or if any package the 1a inventory calls rebuildable is
missing from the proven set — and it reads through the public `/sim-public` serving path when
`storage.readObject` fails, the same fallback 1a and 1c have. An outage or expired credentials
therefore produce a red run, never a green "0/0 packages PROVEN". The three skips in the expected
output are the three non-rebuildable packages from §0 and are named individually with their reason.

> ⚠️ **1b is the PRE-apply gate only. Do not re-run it after step 4.** "No capability gained" is a
> failure here — correct before the rollout (rebuilding for nothing is a pointless write to a
> versionless object) and wrong after it, because a successfully hardened package has nothing left
> to gain. Post-apply verification is step 5 (`verify-sim-rebuild.ts`), where *already hardened* is
> the success condition. The old runbook told you to re-run 1b at step 5; that turned every
> successful rollout into a red run and then sent you to §6's rollback criteria.

`--json` writes `{ at, gate, discovered, results, skipped, unreadable, failed }` — the gate object
is the machine-readable version of the accounting line. `--dump-dir` writes the rebuilt bytes of
every package whose transform completed, including ones that then failed the proof, so check the
exit code before trusting the dump in step 2.

## 2. Real-browser validation of the rebuilt artefacts (before any write)

Serves the **rebuilt** entry + bridge from `--dump-dir` while proxying every other asset to the
live backend, so the actual WebGL scenes run against the new bridge. Needs the backend up on
`SIM_BACKEND_ORIGIN` (default `http://localhost:8080`).

```bash
cd client-web
REBUILT_DIR=/tmp/rebuilt-packages npx playwright test --config=playwright.rebuilt.config.ts
```

Asserts, per package and per section: the document boots (`SIM_READY`), the rebuilt bridge
**acknowledges** (`SCRIPT_APPLIED` — the capability the rebuild exists to add), an unknown section
reports `SCRIPT_MISSING` instead of silently running another body, A→B→A repeats five times
without error on multi-section packages, and `pauseScript` is answered without tearing the section
down. Zero page errors. The suite **skips loudly** when `REBUILT_DIR` is unset — a skipped run is
not a pass.

## 3. Take the rollback point (REQUIRED — this is the only undo)

Storage has no versioning and the rebuild overwrites in place.

```bash
cd backend-api
export STAMP=$(date +%Y%m%d-%H%M%S)
export BACKUP_DIR=$(pwd)/sim-backup-$STAMP     # export: §6 needs it, possibly in another shell

# Rehearse first.
npx tsx --env-file=../.env src/scripts/backup-sim-packages.ts backup "$BACKUP_DIR" --dry-run

# Then take it for real. Exits NON-ZERO if anything was unreadable; a failed run writes
# manifest.incomplete.json, never manifest.json, so it can never be mistaken for a rollback point.
npx tsx --env-file=../.env src/scripts/backup-sim-packages.ts backup "$BACKUP_DIR"
echo "backup exit: $?"     # MUST be 0

# Independent verification: hashes on disk, and drift vs storage.
npx tsx --env-file=../.env src/scripts/backup-sim-packages.ts verify "$BACKUP_DIR" --live
echo "verify exit: $?"     # MUST be 0
```

The backup captures, per package: `bridge.js`, the entry HTML, **and `guidance.js` when present**.
guidance.js is in the set because the entry HTML the rebuild rewrites is the same file that carries
the `guidance.js?v=<hash>` tag — restoring the HTML alone would leave that tag describing bytes
that are no longer there.

`backup` refuses to write into a directory that already holds a backup, a failed backup, or any
files at all (pass `--force` only if the contents are certainly disposable) — re-running into the
same directory after step 4 would replace the pre-rebuild bytes with the post-rebuild ones and make
rollback permanently impossible.

`backup` covers rows with `status = 'ready'` — the same set step 4 writes to. Copy
`$BACKUP_DIR` somewhere durable before step 4, and **write the path down**.

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

A `CONFLICT` or `FAIL` counts as a failure and exits 1; `SKIP`/`UNCHANGED` do not. Re-running is
safe: the rebuild is idempotent, and it only reports `UNCHANGED` when **both** the bridge and the
entry HTML are already current, so a package left half-applied by an interrupted run is repaired
rather than declared healthy.

**Prefer a window with generation traffic stopped.** The conflict check narrows the race; it does
not eliminate it.

## 5. Verify after writing

```bash
cd backend-api

# 5a. Inventory again (informational): the three rebuilt packages must now report
#     ack/missing/pause/demoTimer = true.
npx tsx --env-file=../.env src/scripts/inventory-sim-packages.ts

# 5b. THE post-apply gate. Reads the STORED bytes and fetches the SAME objects through the real
#     /sim-public serving path, then compares them.
npx tsx --env-file=../.env src/scripts/verify-sim-rebuild.ts --json /tmp/verify.json
echo "verify exit: $?"     # MUST be 0
```

`verify-sim-rebuild.ts` is the inverse of step 1b — here *already hardened* is success. Per
rebuildable package it checks three things:

1. **stored** `bridge.js` carries `SCRIPT_APPLIED` / `SCRIPT_MISSING` / `SCRIPT_ERROR` /
   `pauseScript` / `simDemoTimer` / `_sysRaf`, and still parses into a non-empty section map;
2. **served** entry HTML and `bridge.js`, fetched through `storage.getSimPublicUrl()` (the real
   `/sim-public/*` proxy or public bucket URL a browser hits), are **byte-identical** to the stored
   objects — step 1b only ever called `storage.readObject`, so a stale proxy/CDN copy was invisible
   to it and completely visible to users;
3. the **served** entry's `bridge.js?v=<hash>` tag matches the hash of the **served** bridge bytes,
   which catches a fresh entry sitting in front of a cached old bridge. It also flags a *stored*
   tag/bridge mismatch, i.e. a package where the bridge upload landed and the entry upload did not.

It exits non-zero on any mismatch, any package it could not read or fetch, **and on zero packages
verified** — an empty verification is not a verification, exactly as in step 1b.

```bash
# 5c. Real-browser check of the bytes that are now live. Capture them to disk first — this is a
#     SECOND, throwaway capture; do NOT overwrite $BACKUP_DIR, it is the only rollback point.
cd backend-api
export POSTAPPLY_DIR=$(pwd)/sim-postapply-$STAMP
npx tsx --env-file=../.env src/scripts/backup-sim-packages.ts backup "$POSTAPPLY_DIR"

cd ../client-web
REBUILT_DIR="$POSTAPPLY_DIR" npx playwright test --config=playwright.rebuilt.config.ts
```

The capture directory has the same `simulations/<project>/<sim>/…` layout the step-2 suite
discovers, so this runs step 2's assertions against the **post-apply live bytes**.

Finally, smoke the viewer by hand on a project that uses `boids-3d` (5 sections — the widest
dispatch surface): open it, step through every section, and confirm each renders its own variation.

## 6. Rollback

```bash
cd backend-api
# Rehearse: pre-flights every byte, uploads nothing.
npx tsx --env-file=../.env src/scripts/backup-sim-packages.ts restore "$BACKUP_DIR" --dry-run
echo "dry-run exit: $?"    # MUST be 0 — if not, the backup is damaged; do NOT start the restore

# Roll back for real. Every restored object is READ BACK and hash-compared before success.
npx tsx --env-file=../.env src/scripts/backup-sim-packages.ts restore "$BACKUP_DIR"
echo "restore exit: $?"    # MUST be 0

# Confirm: every key matches the backup again.
npx tsx --env-file=../.env src/scripts/backup-sim-packages.ts verify "$BACKUP_DIR" --live
```

Restore order is guidance → bridge → entry, so an interruption never leaves the entry HTML
pointing at a hash that is not there. A manifest whose `complete` flag is false is refused, as is
one whose files no longer match their recorded hashes. A restore is idempotent — re-running after a
transient upload failure is the correct response to a partial rollback.

**Rollback criteria — restore immediately if, after step 4:**

* step 4 exited non-zero;
* **step 5b exited non-zero** (a package not hardened in storage, served bytes disagreeing with
  stored bytes, a stale served bridge, or zero packages verified);
* step 5c errors in the browser, or the viewer shows a wrong sub-simulation for any section.

Do not continue to later packages after an unexplained failure. Note that step 1b exiting non-zero
*after* step 4 is **not** a rollback criterion — it is the expected result of running the pre-apply
proof on an already-applied rollout. Use step 5b.

---

## Orphaned timeline rows — classified, none repaired

```bash
cd backend-api
npx tsx --env-file=../.env src/scripts/classify-orphan-sim-rows.ts --json /tmp/orphans.json
echo "classify exit: $?"   # 0 = every row classified; 1 = at least one UNRESOLVED row
```

Nine timeline rows have a `simulation_url` with no `?section=` identity, so the bridge falls back
to the package default and they render a different variation than intended.

| class | rows | disposition |
|---|---|---|
| **obsolete** | 6 (`ising-kid-simu-complete` ×3, `ising-kid-part2` ×3) | package has neither entry nor bridge in storage — nothing can render with or without a key |
| **requires-author-review** | 2 (`5c96b6b3…` → `pluck-boids`, `a7765242…` → `boids-3d`) | a bridge exists, but no stored content records which variation the row meant |
| **requires-regeneration** | 1 (`baccb89b…` → `example`) | entry exists, `bridge.js` absent — no section bodies to point at |

**Zero rows are provably repairable, so zero rows were modified.** The tool only repairs the one
case where the intended key is evidence rather than inference — the row's own id appearing as a
section id in that package's bridge. None of the nine qualify. None of them block the
three-package rebuild.

The report is read-only and writes `--json` **before** any database work, so the classification
survives even if a later `--apply` dies. It exits non-zero when a row lands in the `unresolved`
class (its `simulation_url` matches no known package prefix) — that is an unknown, not a clean
report.

### If a row ever does become repairable

```bash
cd backend-api
npx tsx --env-file=../.env src/scripts/classify-orphan-sim-rows.ts \
  --apply --manifest ./orphan-rollback-$STAMP.jsonl
echo "apply exit: $?"      # MUST be 0
```

Before the **first** `UPDATE`, `--apply` writes and fsyncs a rollback manifest, reads it back, and
refuses to touch the database unless every planned row is recorded in it with its original
`simulation_url`, the proposed one and the exact rollback SQL. `--manifest` is optional; the default
is `./orphan-repair-rollback-<utc-stamp>.jsonl` and the path is printed. The updates then run in a
database transaction when the driver provides one (it does today), so a failure on row 3 rolls rows
1-2 back and leaves the table untouched; without a transaction the run stops at the first failure
and every landed row has already been checkpointed to the manifest.

Recover the original values from the manifest (line 1 is the plan; later lines are append-only
per-row checkpoints that repeat the same SQL):

```bash
head -1 ./orphan-rollback-$STAMP.jsonl | jq -r '.rows[].rollbackSql'          # every planned row
grep '"status":"applied"' ./orphan-rollback-$STAMP.jsonl | jq -r '.rollbackSql'  # only rows that landed
```

The run exits non-zero if the manifest could not be committed, if any row failed, if the batch
rolled back, or if it applied only some of the plan — and the summary naming the modified rows is
flushed before exit, so a pipe cannot swallow it.
