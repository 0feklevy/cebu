# Simulation & video pipeline: audit remediation, smooth editor simulations, Duplicate Project

Branch `feat/sim-audit-remediation`. Base `origin/main`. Merges clean, no conflicts.

This lands the validated findings of `md-files/SIMULATION-VIDEO-PIPELINE-DEEP-AUDIT.md`, makes
simulations play in the **editor** the way they already play in preview and publish, and adds
**Duplicate Project**.

---

## 1. Why the audit had to be re-verified before anything was written

The audit was **78 commits stale** and the ref it compared against had been rebased away. Before
touching code, five parallel verification passes re-established what was actually true at HEAD.
That changed the work materially:

- **P0.4 was not a build job.** `RevisionService` already existed with atomic publication, CAS
  activation and verified rollback — but **zero production callers**. It became a rewiring job.
- **P2.2 is unlandable here.** Three.js, import maps and package HTML do not exist in this repo.
- **`posterOnlyMode` was dead code.** The presentation policy already had the state; the browser
  floor needed the missing *trigger*, not a new surface.

Reimplementing any of those would have been pure waste, and two of them would have been duplicate
machinery competing with the real thing.

---

## 2. Editor simulations

The editor showed a stutter on every section entry: enter, wait, watch it boot. Preview and publish
did not.

**The cause was residency, not paint timing.** The editor had no pool, so every section entry was a
cold document load. The fix is residency first; the cover is only what remains for the genuinely
cold case. `EditorSimPool` reuses the viewer's pool rather than re-deriving it — residency is keyed
by **package** (`packageKeyOf`), not by section URL, so two sections of one package share one
document and the second entry is a script dispatch instead of a load. It holds the `warm` lease, so
a preview or timeline view still outranks it. Intentional editor invalidation is preserved: a
republish still drops the document, because in the editor that is the point.

---

## 3. The defects found by attacking the work, not by writing it

Every one of these was found by adversarial review *after* the feature was "done", and each was
reproduced before being fixed.

### Re-entry destroyed the frame it had just built (critical)

Re-entering a package past its grace window called `dispose()` and rebuilt — but `dispose()` settles
the eviction promise, so `dropPooled`'s continuation ran as a microtask **after** the new runtime
existed and removed it. The package was left with no iframe and no way back.

Fixed by **identity**, not timing: `removePooled` takes the runtime instance the eviction was raised
for and no-ops unless that instance is still resident. Any future path that swaps a runtime
mid-eviction is now safe without knowing this hazard exists.

### An iframe `load` during the grace wedged the eviction forever

`handleFrameLoad` bumped `generation`, which stranded both generation-guarded eviction callbacks.
The iframe and its WebGL context leaked, the frame became un-evictable, and the `single` kill switch
silently stopped working. Every `generation++` is now `bumpGeneration(cause)`, which settles an
in-flight eviction as `forced` first — the bump *is* what stranded them, so the settle is bound to
the bump rather than added as a third thing a call site must remember.

### A reveal outlived its player and built a client nothing would dispose

The reveal's double-`rAF` could fire after unmount and construct a fresh `SimRuntimeClient` for a
dead React tree — a client the cleanup had already run past. This was also the cause of a
long-standing `viewerLayerGating` flake that had been dismissed as environmental. **Three attempts
were made to patch that test; all were reverted.** The test was reporting a real bug. It is
unmodified here, and the suite now runs clean 10×.

### A duplicated project's simulations ran nothing

The generated bridge keys its dispatch map by **section id**. Duplication mints new section ids and
rewrites `?section=` to them, but copies package bytes verbatim. Every simulation section in a copy
therefore asked the bridge for a key it had never heard of → `SCRIPT_MISSING` → the video played
straight through with no simulation. The copy was exactly the empty shell the feature exists to
avoid. The existing test asserted the remap while its fixture package had no real section map, so it
could not see the break.

### A 6 GB master could not be duplicated

Uploads are admitted to 10 GB; S3 `CopyObject` refuses a single object over 5 GiB. This was
initially closed with a *refusal*; that was rejected. Both S3-family adapters now cross the wall
with a ranged `UploadPartCopy`, reusing the multipart flow the browser upload path already ships.
Parts are uniformly sized with only the last one short, because **R2 rejects anything else**; a
failed part aborts the upload so a failure cannot leave billed orphans; and the fallback triggers
only on the oversize classification, so an ordinary object still costs one round trip and no HEAD.

---

## 4. Duplicate Project

A real copy: timeline sections and ordering, video files and the entire HLS ladder, simulations with
their active revision tree and configuration, scripts, captions, avatars and avatar-circle faces,
images and B-roll, markers, branching graph, SEO and settings.

**Independence is enforced, not assumed.** `assertNoEscapingReferences` runs as the last statement
*inside* the commit transaction, so a copy that still names one of the original's objects rolls back
instead of being written. The suite proves it the way that actually matters: duplicate, then
**delete the original** (retirement sweep included), then assert the copy still resolves everything
it names.

Four hazards found by walking the schema rather than the brief: three unmapped clip-source foreign
keys; `?section=` being the poster and pool **variant key**, so a copy that kept it would share the
original's pool identity; `sim_posters` needing re-keying; and `branch_edges.dest_project_id` being
self-referential, so a naive copy links the duplicate's branches back into the original.

Pointers hidden in JSONB rather than key-shaped columns are the recurring trap here — avatar-circle
face URLs in `avatar_config`, `guidance_meta.mdUrl`, and guidance audio URLs. That class has now
recurred three times, which is why the escape assertion scans JSONB text rather than only columns.

---

## 5. Operability

The admin PATCH had accepted the six simulation kill switches since each landed, but `AdminSettings`
never declared them and the console rendered none — so reaching one meant a direct UPDATE against
production. They are now on `/feature-flags`, and `.env.example` documents the three-tier
resolution, including two details worth not rediscovering: setting one in the environment **pins**
it so the console silently stops winning, and `rum_retention_days` deliberately has no env override
so a redeploy cannot quietly change a retention period.

`sim_transition_coordinator` ships **OFF** (migration 054's default). That is deliberate — P0.1 is
the riskiest change here and is meant to canary — but it does mean P0.1 is inactive until switched
on. Note also that turning it off does **not** revert the sibling viewer changes in the same
commits; those have no switch.

---

## 6. Migrations

055 `simulations.bridge_ack_capable`, 056 `project_duplications`, 057
`simulations.requires_import_maps`. Each has a rollback that reverses it, and all are registered in
`migrate.ts` and asserted by `check-db.ts`.

055 and 057 are **projections** of facts that live on the revision, in
`sim_revisions.metadata.bridgeCapabilities`. They get columns because `buildPlayerConfig` resolves a
simulation's identity from `simulations` alone with a narrow column list and no join — so the
hottest read path never pulls `canary_report`-sized JSONB — and the editor's bootstrap reads already
select a narrow projection off the same row.

Both are nullable because both are genuinely three-state, and the third state is the point:
**NULL = UNKNOWN, and unknown is never treated as the risky answer.** An unknown bridge is not
assumed silent; an unknown entry document is not assumed to need import maps. Applying these changes
nothing for any existing viewer — every existing row reads NULL, and NULL is the state that leaves a
package exactly as it renders today. `sims:backfill-ack` fills the record in from published bytes,
and the pointer flip keeps it true on republish and rollback.

---

## 7. Verification

Full 9-step `deploy/scripts/release-verify.sh`, uncontended, exit 0:

| Workspace | Files | Tests |
|---|---|---|
| shared | 23 | 877 |
| client-web | 50 | 1295 |
| backend-api | 99 (+1 skipped) | 1745 (+5 skipped) |
| ops/release | 21 | 237 |
| admin-web | 2 | 34 |
| **Total** | **195** | **4188** |

Typecheck clean in all workspaces; eslint **0 errors** (pre-existing warnings only); both production
builds succeed; bundle scan finds no loopback/internal hosts.

Playwright, self-contained fixture servers, Chromium + Firefox + WebKit:

| Suite | Tests |
|---|---|
| `sim-transitions` | 36 |
| `sim-leak` | 36 |
| `sim-protocol` | 48 |
| `sim-transport` | 27 |
| `rebuilt-packages` | 12 |
| `sim-canary` | 11 (chromium) |

`sim-leak` reports **0 leaked** across intervals, listeners, abort controllers, object URLs and 256
GL textures — the suite that matters most given the iframe/WebGL leak fixed here.

`sim-transitions` includes a deliberate control (`4b`) that asserts the *old* ordering **does** flash
Full UI mid-fade, so a green run proves the suite discriminates rather than merely passing.

### What was not verified

- **No physical-device testing was performed.** iOS/Safari behaviour is covered by WebKit in
  Playwright and by unit tests over the capability floor; that is not the same as a real device, and
  P0.8's poster path in particular deserves one before wide rollout.
- The `viewer-e2e` and default Playwright configs require a running app; results are recorded
  separately below.
- Mutation testing was applied per-fix by the implementing agent, not as a whole-repo campaign.

---

## 8. Risks

**Measured.** `sim_transition_coordinator` ships off, so P0.1 is inactive until enabled. P0.8 is
inert for every package published before this branch until `sims:backfill-ack` runs, because
`requires_import_maps` is NULL and unknown is never treated as "requires".

**Assumed, not measured.** The editor residency change alters memory behaviour on low-end devices in
a direction unit tests cannot show. Duplicate Project's storage copy has been tested against fakes
and the real range arithmetic, but not against a real >5 GiB object in S3/R2.

---

## 9. Rollback

Each migration has a reversing rollback. 055/057 are additive nullable columns: dropping them
returns every package to UNKNOWN, which is the render-as-today state. 056 drops
`project_duplications` and disables the feature. Deploy the image before dropping the columns —
`buildPlayerConfig` names them explicitly, so an image that still selects a dropped column degrades
the revision pointer for every simulation in a project.
