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

### The whole installed base blanked for 3 seconds (caught by the pre-existing real-viewer E2E)

P0.5's bounded hold reused the 3-second slow-body allowance for the UNKNOWN-capability case — a
different question entirely ("does this bridge acknowledge at all?"). Since migration 055 ships
with no backfill, every already-published package is UNKNOWN, so every one of them showed nothing
for three full seconds on its first activation. `viewer-e2e` test 13 — which predates this branch —
failed on all three engines. The unknown case now has its own 600 ms probe (a bridge that acks does
so one frame after the body returns), a proven bridge keeps the full allowance, and the distinction
is pinned by mutations in **both** directions. The unit test that had encoded the 3-second hold was
written by the same round that introduced the defect — the pre-existing E2E was the authority.

### The low-end tier unmounted the cover the coordinator was holding (caught by CI's 2-core runner)

The pool tier is derived from `hardwareConcurrency`: `'all'` above 4 cores — no eviction rule at
all — and `'window'` at or below. Every developer machine ran `'all'`; CI ran `'window'`, and there
the planner dropped the element the coordinator was holding as its cover at T0 of every coordinated
exit, because `deactivateSim` released the residency ref unconditionally while the rendered key
beside it had already learned to survive the hold. Two owners of one fact, disagreeing during a
hold. Fixing it exposed a second defect the old bug had been masking by accident: with the ref
alive, the *next* video tick re-entered the exit branch, was refused a second handoff, and fell
through to the flag-off uncover — dropping the cover a tick after T0 at **every** tier. A handoff
in flight now owns its exit. The test suite also no longer reads the host's real core count
(`vitest.setup.ts` pins it, with `SIM_TEST_CORES` for explicit low-end probing), and an explicit
2-core regression proves both the hold and that the window tier still reclaims the frame after the
commit. Flag-off behaviour is byte-identical at every tier.

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

## 7. Three adversarial rounds, and what each one found

Every round ran **after** the previous one's work was complete and its suite was green. That is the
point: none of these were reachable by reading the diff of a feature you just wrote.

| Round | Scope | Found |
|---|---|---|
| 1 | the feature work | 1 CRITICAL, 6 HIGH, 8 MED |
| 2 | **the round-1 fixes** (12 agents, every HIGH put to an independent skeptic) | 4 MUST-FIX, 7 SHOULD-FIX |
| 3 | mutation-testing round 2's own fixes | **2 surviving mutations** |

Round 1's CRITICAL was that a duplicated project's simulations ran nothing. **Two of round 2's four
must-fixes were regressions round 1 had introduced** — a corpus filename containing `#` breaking
ingestion that previously worked, and the coordinated exit dropping its own cover. A third was a fix
that had turned a silent cross-project pointer into a hard, unrecoverable failure.

Round 3 mattered most for a fix that had shipped with **no test at all**: duplicating mid-transcode
copied `hls_status`/`crop_status`/`captions_status`/`simulations.status`/`corpora.ingestion_status`
verbatim, so the copy spun on `processing` forever and the next backend boot swept its simulation to
`failed — please re-upload`. The fix was correct and completely unverified; mutating it revealed
that, and `(o)` now pins all five columns, asserts the original is left mid-job untouched, and
asserts a terminal status is *not* rewritten so "reset everything" cannot pass either.

Round 2 also correctly **refuted** two reported findings, and one reviewer's own claim ("this can
404") was struck because the collector it depends on has no production caller. Findings were
dropped, not just added.

## 8. Verification

Full 9-step `deploy/scripts/release-verify.sh`, uncontended, exit 0:

| Workspace | Files | Tests |
|---|---|---|
| shared | 23 | 877 |
| client-web | 54 | 1355 |
| backend-api | 104 (+1 skipped) | 1838 (+5 skipped) |
| ops/release | 21 | 237 |
| admin-web | 2 | 34 |
| **Total** | **204** | **4341** |

Typecheck clean in all four workspaces; eslint **0 errors** (45 backend / 84 client pre-existing
warnings, unchanged from the baseline); both production builds succeed; bundle scan finds no
loopback or internal hosts in either browser bundle.

Playwright, self-contained fixture servers, Chromium + Firefox + WebKit — **170 tests**:

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

`sim-transitions` includes a deliberate control (`4b`) asserting the *old* ordering **does** flash
Full UI mid-fade, so a green run proves the suite discriminates rather than merely passing.

**The real-viewer suite** (`viewer-e2e`, 114 tests × Chromium/Firefox/WebKit, against a live dev
server): **114/114 passed.** This is the only suite that runs the actual Next.js route, the real
React viewer and the real `useProjectPlayer` — the harness suites above replay the orderings the
player is *supposed* to emit, and by construction cannot fail when the player itself regresses. It
is also the suite that caught the installed-base 3-second blank (§3) after every other suite was
green — which is the concrete argument for never treating the harness suites as sufficient.

### Contention is not signal

Three separate runs during this work reported failures that were not defects: 8, then 17, then a
57-minute Playwright run. Every one was CPU starvation — the 17-failure run was **11 PGlite hook
timeouts and zero assertion failures**. All pass uncontended. Any future red run on this repo should
be classified by error *kind* before being believed.

### What was NOT verified — do not read the above as covering it

- **No physical-device testing was performed.** iOS/Safari is covered by WebKit in Playwright and by
  unit tests over the capability floor. That is not a real device, and P0.8's poster path deserves
  one before wide rollout.
- **Nothing was executed against real R2 or Supabase.** The storage layer is verified against fakes
  and against the real range arithmetic; no duplication has copied a real >5 GiB object.
- **No security or authorization lens ran** over the new duplication endpoints, the admin kill-switch
  PATCH fields, or the RUM ingestion route.
- **Migrations were reviewed for content, not for ordering** or behaviour on a partially migrated
  deployment.
- **14 MED/LOW findings from round 2 were never put to a skeptic.** Of the three that were, all came
  back materially changed — assume a similar error rate in the unchallenged set.
- Mutation testing was per-fix, not a whole-repo campaign.
- `viewer-e2e` runs against the **dev** server by design (the production build refuses a loopback
  API origin, and the suite's hermeticity policy requires one); the production bundle itself is
  exercised by the build + bundle-scan steps, not by this suite.

---

## 9. Master-spec completeness

The 26 audit findings plus the two added requirements, adjudicated from the code rather than from
commit messages.

**Delivered and ON by default:** P0.2, P0.3, P0.4, P0.5, P0.6, P0.7, P1.1, P1.2, P1.7 — plus both
added requirements (**Duplicate Project** and **editor simulation smoothness**).

**Built but inactive by default** — the mechanism is real and tested; a flag or a data backfill
gates it: P0.1 (`sim_transition_coordinator` off), P0.8 (column NULL until the backfill runs),
P1.3 (flag off *and* tier-gated off mobile), P1.5 (`rum_sample_rate` 0), P1.6 (flag off, and the v3
path is unreachable for any package the current assembler produces), P1.4's presentation half.

**Deliberately out of scope, correctly:** P2.1 (already on the base), P2.2 / P2.4 / P2.5
(package-side; Three.js, import maps and package HTML do not exist in this repo), P3.1–P3.4
(research).

**Genuinely not done, and not previously declared:** P2.3, P2.6 — both "only after measurement" in
the audit itself, and no measurement exists yet — and P1.5's second half, the physical-device
release matrix. `release-verify.sh` runs no Playwright and no device job.

The honest one-line summary: **the P0 line is real and on; the P1 line is largely built and off.**

---

## 10. Risks

**Measured.** `sim_transition_coordinator` ships off, so P0.1 is inactive until enabled — and turning
it off does *not* revert the sibling viewer changes in the same commits, which have no switch. P0.8
is inert for every package published before this branch until `pnpm sims:backfill-ack -- --apply`
runs, because `requires_import_maps` is NULL and unknown is never treated as "requires"; no admin
surface reports how many rows remain NULL. No RUM is collected until an operator raises
`rum_sample_rate` above 0.

**Assumed, not measured.** The editor residency change alters memory behaviour on low-end devices in
a direction unit tests cannot show. The storage copy has never moved a real multi-gigabyte object.
Predictive admission (P1.3) is tier-gated off phones and tablets — the population whose cold entries
the audit actually measured — so it cannot help there even once enabled.

**Product decisions embedded here, which a reviewer should confirm rather than inherit.** A duplicate
does **not** carry the original's collaborators, share token, permalink slug, publish state or view
counts: the copy belongs to whoever clicked it, and inheriting a published slug would be a defect. If
collaborators should follow the copy, that is a deliberate change, not a bug fix.

---

## 11. Rollback

Each migration has a reversing rollback. 055/057 are additive nullable columns: dropping them
returns every package to UNKNOWN, which is the render-as-today state. 056 drops
`project_duplications` and disables the feature. Deploy the image before dropping the columns —
`buildPlayerConfig` names them explicitly, so an image that still selects a dropped column degrades
the revision pointer for every simulation in a project.
