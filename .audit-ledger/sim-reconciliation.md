# Simulation revision reconciliation — identification queries

**Status: READ-ONLY. Nothing here has been run. Nothing here mutates.**

Every statement below is a `SELECT`. There is no `UPDATE`, no `DELETE`, no backfill and no
promotion script in this document, deliberately — see [What must NOT be
done](#what-must-not-be-done-yet).

## Why this exists

`fix/night-audit-2026-08-15` makes two mutable-prefix writers refuse when a simulation has an
`active_revision_id`:

* `POST …/simulations/:simId/replace` → `409 SIM_REVISION_WRITE_UNSUPPORTED` (audit simulation-001)
* `GET …/simulations/:simId/publish-guidance/stream` → named SSE `error` event, same code
  (audit simulation-002)

**Those refusals stop the bleeding. They repair nothing.** Every write that already happened is
still sitting in `simulations/<project>/<sim>/…` — a prefix no reader resolves once the pointer is
set — and the database rows that recorded those writes as successful still say so. Two distinct
populations came out of that window, and they need different remedies, so they are identified
separately.

A note on what the database can and cannot answer: **`simulations` has no `updated_at` column**, and
neither does `timeline_sections`. There is therefore no DB-only way to date a replace. Population B's
queries produce a *candidate set* plus the exact storage keys an operator must then inspect; the
timestamp comparison itself has to come from object metadata. That limitation is stated here rather
than papered over with a query that looks authoritative and is not.

---

## Population A — revisioned sims marked guidance-ready whose active manifest has no guidance

**The claim being tested:** the row says `guidance_status = 'ready'` and hands the editor a
`guidanceHash`, while the package the player actually loads contains no `guidance.js` at all. The
audio was synthesized (and billed), `guidance.js` was assembled, the entry HTML was re-injected —
all into the legacy prefix. The viewer loads the revision and plays nothing.

### A1 — candidate set (DB only)

```sql
-- Every revisioned simulation whose row advertises published guidance.
-- The manifest check that CONFIRMS the defect is step A4; this is the set to check.
SELECT
  s.id                                   AS simulation_id,
  s.project_id,
  s.name,
  s.storage_prefix,
  s.guidance_status,
  s.guidance_meta ->> 'guidanceHash'     AS row_guidance_hash,
  s.guidance_meta ->> 'publishedAt'      AS row_published_at,
  s.guidance_meta ->> 'language'         AS row_language,
  jsonb_array_length(COALESCE(s.guidance, '[]'::jsonb))                       AS cue_count,
  (SELECT count(*) FROM jsonb_array_elements(COALESCE(s.guidance, '[]'::jsonb)) e
    WHERE (e ->> 'enabled')::boolean)                                         AS enabled_cue_count,
  r.id                                   AS active_revision_id,
  r.revision_number,
  r.activated_at,
  r.entry_path,
  -- The two objects an operator must compare. Composed here so the follow-up is mechanical.
  s.storage_prefix || '/revisions/' || r.id::text || '/manifest.json'         AS active_manifest_key,
  s.storage_prefix || '/guidance.js'                                         AS legacy_guidance_key,
  s.storage_prefix || '/guidance/'                                           AS legacy_audio_prefix
FROM simulations s
JOIN sim_revisions r ON r.id = s.active_revision_id
WHERE s.active_revision_id IS NOT NULL
  AND s.guidance_status = 'ready'
ORDER BY r.activated_at DESC NULLS LAST, s.project_id, s.name;
```

### A2 — the subset where the publish provably post-dates the fork (DB only, no storage needed)

`guidance_meta.publishedAt` is written by the publish endpoint at the moment it declares success.
If that instant is **after** the active revision was activated, the publish wrote into the legacy
prefix while the revision was already live — no storage inspection required to know it landed
nowhere.

```sql
SELECT
  s.id AS simulation_id, s.project_id, s.name,
  (s.guidance_meta ->> 'publishedAt')::timestamptz AS published_at,
  r.id AS active_revision_id, r.activated_at,
  (s.guidance_meta ->> 'publishedAt')::timestamptz - r.activated_at AS published_after_activation
FROM simulations s
JOIN sim_revisions r ON r.id = s.active_revision_id
WHERE s.active_revision_id IS NOT NULL
  AND s.guidance_status = 'ready'
  AND r.activated_at IS NOT NULL
  -- Guard the cast: guidance_meta is free-form jsonb written by application code, and a malformed
  -- value would abort the whole SELECT rather than skip one row.
  AND s.guidance_meta ->> 'publishedAt' ~ '^\d{4}-\d{2}-\d{2}T'
  AND (s.guidance_meta ->> 'publishedAt')::timestamptz > r.activated_at
ORDER BY published_after_activation DESC;
```

> A row **absent** from A2 but present in A1 is not cleared. `publishedAt` was only ever written by
> the publish path, so a package migrated to revisions *after* a legitimate legacy publish has an
> older timestamp and a manifest that still may or may not carry the guidance across. A2 proves
> guilt; only A4 proves innocence.

### A3 — the blast radius in the player (DB only)

Publish appends `?g=<guidanceHash>` to every section's `simulation_url` to bust the iframe cache.
Those query params are still on the rows, so the sections are asking for a cache-bust of a file the
revision does not contain.

```sql
SELECT
  ts.id AS section_id, ts.project_id, ts.label,
  ts.simulation_url,
  s.id AS simulation_id, s.guidance_status,
  s.guidance_meta ->> 'guidanceHash' AS row_guidance_hash,
  -- The `g` param actually embedded in the URL, for comparison with the row's hash.
  substring(ts.simulation_url FROM '[?&]g=([^&]+)') AS url_guidance_hash
FROM timeline_sections ts
JOIN simulations s ON s.id = ts.simulation_id
WHERE s.active_revision_id IS NOT NULL
  AND ts.simulation_url IS NOT NULL
  AND ts.simulation_url ~ '[?&]g='
ORDER BY ts.project_id, ts.sort_order NULLS LAST;
```

### A4 — the confirming read (storage, still read-only)

For each `active_manifest_key` from A1, `GET` the object and evaluate:

1. `manifest.runtime[]` contains an entry matching `(^|/)guidance\.js$` — **and**
2. `manifest.files[]` contains that same path with `role: "runtime"`.

Neither present ⇒ **confirmed member of Population A**: the row claims published guidance and the
served package has none.

Two supporting reads, both optional and both read-only:

* `HEAD <legacy_guidance_key>` — a `guidance.js` under the mutable prefix whose `Last-Modified` is
  after `activated_at` is the orphaned artifact itself.
* `LIST <legacy_audio_prefix>` — the cue `.mp3` objects. Their count and `Last-Modified` bound how
  much TTS spend produced nothing audible, which is the number to put in the incident note.

---

## Population B — legacy sources replaced after the active revision forked

**The claim being tested:** a `POST …/replace` succeeded (202, row back to `ready`) *after* the
simulation was already serving from a revision. The customer's new files, the re-injected entry
HTML and the recomputed `bridge_functions` all went to the mutable prefix. The player kept serving
the old revision. From the editor everything looks current; from production nothing changed.

### B1 — candidate set (DB only)

Every revisioned simulation is a candidate, because nothing but replace/publish writes to the
mutable prefix once the pointer is set. The value of this query is the composed storage keys.

```sql
SELECT
  s.id AS simulation_id, s.project_id, s.name,
  s.storage_prefix,
  s.entry_file,
  s.bridge_hash                          AS row_bridge_hash,
  s.status,
  r.id AS active_revision_id, r.revision_number, r.status AS revision_status,
  r.activated_at, r.entry_path, r.manifest_hash,
  s.storage_prefix || '/revisions/' || r.id::text || '/manifest.json' AS active_manifest_key,
  s.storage_prefix || '/bridge.js'                                   AS legacy_bridge_key
FROM simulations s
JOIN sim_revisions r ON r.id = s.active_revision_id
WHERE s.active_revision_id IS NOT NULL
ORDER BY r.activated_at DESC NULLS LAST, s.project_id, s.name;
```

### B2 — the one divergence the database CAN see on its own

`processReplace` rewrites `simulations.entry_file`; the active revision's `entry_path` is frozen at
publication. When the two disagree, the row and the served package are describing different
packages — which is a replace (or a rename) that never reached the revision.

```sql
-- The derivation is written ONCE, in the CTE, and both the projection and the predicate read it.
-- Writing it twice is how the SELECT and the WHERE come to disagree — and here the disagreement
-- would have been silent and one-directional: rows whose entry_file is a legacy full URL would
-- derive NULL in the predicate, `NULL IS DISTINCT FROM <path>` is TRUE, and every one of them
-- would be reported as diverged when nothing about them had changed.
WITH resolved AS (
  SELECT
    s.id AS simulation_id, s.project_id, s.name,
    s.entry_file, s.storage_prefix,
    r.id AS active_revision_id, r.entry_path, r.activated_at,
    -- entry_file is a storage key on new rows and a full public URL on old ones; both are reduced
    -- to a prefix-relative path before comparison.
    CASE
      WHEN split_part(s.entry_file, '?', 1) LIKE s.storage_prefix || '/%'
        THEN substr(split_part(s.entry_file, '?', 1), length(s.storage_prefix) + 2)
      WHEN strpos(split_part(s.entry_file, '?', 1), '/' || s.storage_prefix || '/') > 0
        THEN substr(
               split_part(s.entry_file, '?', 1),
               strpos(split_part(s.entry_file, '?', 1), '/' || s.storage_prefix || '/')
                 + length(s.storage_prefix) + 2
             )
      ELSE NULL
    END AS row_entry_rel,
    -- Customer bytes are nested under `package/` inside a revision; strip it before comparing.
    regexp_replace(r.entry_path, '^package/', '') AS revision_entry_rel
  FROM simulations s
  JOIN sim_revisions r ON r.id = s.active_revision_id
  WHERE s.active_revision_id IS NOT NULL
    AND r.entry_path IS NOT NULL
)
SELECT *
FROM resolved
WHERE row_entry_rel IS NOT NULL          -- an underivable entry_file is a SEPARATE finding, not this one
  AND row_entry_rel IS DISTINCT FROM revision_entry_rel
ORDER BY project_id, name;

-- The rows deliberately excluded above, reported separately rather than silently folded in.
WITH resolved AS ( /* … same CTE … */ )
SELECT simulation_id, project_id, name, entry_file, storage_prefix
FROM resolved
WHERE row_entry_rel IS NULL;
```

> `LIKE s.storage_prefix || '/%'` treats the prefix as a LIKE pattern. Storage prefixes are
> `simulations/<uuid>/<uuid>` and contain no `%` or `_`, so this is safe today; if that ever stops
> being true, the comparison silently widens. Worth an `ESCAPE`-clause rewrite before this is run
> against a prefix scheme anyone has changed.

### B3 — the timestamp comparison (storage; the DB cannot do this)

For each row from B1, `LIST` the objects under `<storage_prefix>/` and **exclude the system-owned
subtrees** `revisions/` and `posters/` (`SYSTEM_OWNED_SEGMENTS` in `shared/sim/simRevision.ts`).
Any remaining object whose `Last-Modified` is **after** `r.activated_at` is legacy-prefix bytes
written while the revision was live:

| Key shape | What a post-`activated_at` mtime means |
|---|---|
| `<prefix>/<entry>.html`, `<prefix>/**/*.{js,css,…}` | a **replace** landed here (Population B proper) |
| `<prefix>/bridge.js` | bridge regeneration or a replace's re-injection |
| `<prefix>/guidance.js`, `<prefix>/guidance/**` | a **publish** landed here (cross-check with A2) |

Record, per simulation: the newest post-fork mtime, the object count, and total bytes. That triple
is what a remediation plan needs in order to be sized; none of it can be inferred from the database.

---

## What must NOT be done yet

**Do not auto-promote the legacy bytes into a new revision.** It is the obvious move and it is
wrong, for two independent reasons:

1. **The active bridge may have diverged.** A revisioned package's bridge is
   `<prefix>/revisions/<active>/package/bridge.js`. `<prefix>/bridge.js` is a stale copy that
   generation and publication stopped maintaining. Promoting the legacy tree would take the
   customer's newest source files *and* whatever bridge happens to sit beside them — which may bind
   selectors and globals the live sections no longer use, or miss ones they do.
2. **The check that would have caught that was reading the wrong file.** Until this branch, the
   replace-compatibility gate read `<prefix>/bridge.js` for revisioned packages too (audit
   simulation-003, fixed in `replaceCompatibilitySource.ts`). So *every* "compatible" verdict
   recorded against a revisioned simulation was computed from the stale copy. There is no archived
   verdict on these packages that can be trusted as evidence for a promotion.

Nor should the rows simply be corrected to match the served bytes — resetting
`guidance_status` to `'none'` would silently discard a draft the customer edited and paid to
synthesize. Population A rows hold real work.

The reconciliation these queries feed is a **separate piece of work**, and it depends on the
revision-aware replace/guidance path (derive → draft → validate → CAS-activate with
`expectedActiveRevisionId`) which is planned on top of PR #31's `RevisionService.validate`. Once that
exists, each identified simulation can be *re-published* through it — same inputs, correct
destination, validated bytes — instead of having its old bytes promoted unchecked. Until then these
queries exist to size the problem and to name the affected customers, not to fix them.

## What these queries do not establish

* **They do not prove a customer was harmed.** A simulation in Population B whose replace was a
  no-op edit is indistinguishable here from one whose replace was a rewrite.
* **They cannot see deleted evidence.** `processReplace` deletes stale legacy keys; a replaced-then-
  replaced-again package shows only the most recent mtime.
* **A1 is a superset.** A package migrated to revisions after a legitimate publish may carry its
  guidance across correctly; only the A4 manifest read separates those.
* **They say nothing about revisions that were never activated.** `sim_revisions` rows in `draft` /
  `uploading` / `validating` are out of scope here and are handled by `RevisionService.staleDrafts`.
