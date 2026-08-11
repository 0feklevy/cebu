# Simulation/Video Pipeline — Audit Remediation Plan

**Source audit:** `md-files/SIMULATION-VIDEO-PIPELINE-DEEP-AUDIT.md` (2026-08-07, audited at `31a6098`)
**Remediation branch:** `feat/sim-audit-remediation`, based on `7d8f9ee` (= `origin/feat/sim-immutable-revisions` tip)
**Plan date:** 2026-08-09

## 1. Base-selection rationale (Phase 0, step 1 — done)

The audit was taken at `31a6098`. Since then **78 commits** landed on origin (`31a6098..7d8f9ee`), and the
audit's comparison ref `1e06276` is **not an ancestor** of the current tip (history was rewritten). Those
commits are the "Priority 7–8" program:

| Already delivered on the base (do NOT re-implement) | Audit item it covers |
|---|---|
| `sim_revisions` migration 050, `RevisionService` (atomic publication, CAS activation, verified rollback), legacy→revision migration, replace-flow byte-preservation, VERIFIED-revision immutable caching | **P0.4** (core) |
| rVFC boundary sentinel behind default-off switch | **P2.1** |
| Occurrence planner + lab budgets + predictive admission behind default-off switches | **P1.3** (partial) |
| Adaptive quality with hysteresis (parent side) behind default-off switch | **P1.6** (parent side) |
| RUM migration 051 + ingestion + retention + client transport, sample-rate kill switch | **P1.5** (infra) |
| Package weight recorded at publication (P8.11) | scheduler input |
| Viewer fixes: poster on cold-seek onto sim, stall cue visibility, no eviction/kill-switch cut mid-fade, refused-activation present-bound fix | fragments of P0.1/P0.5 edges |

Consequence: every audit line reference is stale, and every "open" claim had to be re-verified against
`7d8f9ee` before implementation. That verification ran as five parallel read-only agents (results in §5).

## 2. Scope boundary — code vs. operations vs. product

**Landable as code on this branch (this plan's scope):**
P0.1, P0.2, P0.3, P0.5, P0.6, P0.7, P0.8 (detection+fallback half), P1.1, P1.2, P1.7, quick wins
(`?simpool` downgrade-only, thumbnail gating, SectionEditor timer deps), P2.2 (publication-side pinning,
if serving path is in-repo), plus any residual P0.4 gaps verification finds.

**Prepared but not executable from this desk (documented as follow-ups in the PR):**
- Re-transcoding the existing HLS library (operational rollout; new encoder affects future jobs only).
- Physical-device release matrix, field RUM enablement percentages, thermal soaks (P1.5 gates).
- Owner-gated visual tiers inside the flagship packages, sim-time policy (P1.6/P1.8): package sources
  live outside the repo (Desktop) per the audit; verification confirms. Requires lesson-owner approval anyway.
- iOS floor **product decision** (declare 16.4+ vs. publication-time import rewrite): we land capability
  detection + honest poster fallback either way; the decision memo goes in the PR body.
- P3.x experiments (worker/OffscreenCanvas, native-HLS cohort, asset broker, occurrence precompute):
  explicitly research; out of scope.

## 3. Non-negotiable invariants (from audit §19/§21)

1. **0 ms of invalid/uncovered pixels** in either transition direction — a deadline authorizes
   recovery/cover, never an unproven reveal.
2. **No unintended audio silence or overlap** — intentional mixes are named policies.
3. Kill switches only ever **downgrade** on the client; server config is authoritative.
4. Respect all 16 items in audit §21 "What NOT to change" (keep iframes, package identity, dual video
   elements, generation guards; no scientific-parameter quality tiers; no disposal on ordinary hide; …).
5. Every behavioral change ships behind a flag, default matching current behavior.

## 4. Lanes, ordering, and agent assignment

Lanes are file-disjoint where parallel; `useProjectPlayer.ts` is the serialization point.

```text
Lane A (backend video)  : P0.2 encode matrix + GOP + honest codec string + conformance gate
                          P0.3 old-run retention (retire_after + durable GC)
                          P1.7 immutable cache metadata on versioned HLS objects
                          [parallel-safe: backend-api/src/services/video + storage]

Lane B (viewer media)   : step 1 quick wins — P0.6 init/play race, P0.7 b-roll swap,
                          thumbnail gating, ?simpool downgrade-only
                          step 2 — P0.1 TransitionCoordinator: reducer owning
                          (intent, generation, outgoing validity, target mediaTime,
                          rVFC submission evidence, audio policy, cover, deadline);
                          applied to sim-exit, initial play, segment swap, b-roll;
                          rVFC-absent fallback = seeked + readyState>=2 + 2 visible rAF, labeled;
                          flag: default-off, server-authoritative
                          [strictly serial within lane: same files]

Lane C (v2 identity)    : P0.5 — ack-capability in revision/package metadata consumed before
                          first activation; ack-capable ⇒ require matching SCRIPT_APPLIED +
                          section-specific first-frame; unknown/legacy ⇒ hold cover, bounded
                          recovery, never generic reveal. Plus residual P0.4 gaps if verification
                          finds the live path still bypasses RevisionService.
                          [client lib/sim + backend generation metadata; coordinate with Lane B step 2
                          on SimRuntimeClient touchpoints — run after B step 1, alongside A]

Lane D (editor)         : P1.1 — activation generation token, complete/removed timer deps,
                          preview URL identity, SimulationLease provider
                          (preview-visible > timeline-visible > warm) consulted by every
                          activate/resume/warm path, fail-safe release on unmount
                          P1.2 — SET_UI_POLICY / SET_AUTOMATION_POLICY idempotent messages,
                          legacy restart fallback + telemetry
                          [client editor surfaces + shared protocol + generated templates;
                          file-disjoint from Lanes A/B]

Lane E (compat floor)   : P0.8 — importmap support detection + exact poster/recovery on
                          unsupported clients; decision memo for floor-vs-rewrite
                          [small, independent]

Lane F (bytes)          : P2.2 — pin one shared minified immutable Three build at
                          publication-rewrite time (if in-repo serving path confirms), canary field
                          [small, backend publication; after Lane C to avoid merge friction]
```

**Order of execution (revised after Phase-0 verification):**
- Wave 1 (parallel, disjoint files): **A** (backend video + settings exposure) ∥ **B1** (viewer quick wins
  + device-classification fix) ∥ **C-backend** (P0.4 rewiring through RevisionService) ∥ **D1** (editor
  P1.1 races + SimulationLease).
- Wave 2: **C-client** (P0.5 apply-gate + EVICT two-phase + import-map floor detection/poster) after B1
  frees `useProjectPlayer.ts`; **D2** (P1.2 SET_UI_POLICY protocol split) after C-backend frees
  `SimulationService.ts` and D1 frees `SectionEditor.tsx`.
- Wave 3: **B2** (P0.1 TransitionCoordinator, flag `sim_transition_coordinator`, migration 055) after
  C-client frees the client sim libs.
- Lane F narrowed: no Three.js exists in-repo (uploaded package bytes only) — pinned-minified-Three is a
  package/publication follow-up documented in the PR, not landable code here. Import-map floor detection
  absorbed into C-client.
- Serialization points: `useProjectPlayer.ts` (B1 → C-client → B2), `SimulationService.ts`
  (C-backend → D2), `SectionEditor.tsx` (D1 → D2). Migration numbers: A=053, C-backend=054 (only if
  unavoidable), B2=055.

## 5. Phase-0 verification results (per finding, at `7d8f9ee`)

> Populated from the five verification agents. Each implementation lane starts from these verdicts,
> not from the audit's stale line numbers.

### Backend video/HLS (agent V2 — complete)

- **[P0.2] OPEN.** `HLSTranscoder.ts` unchanged since audit. All tiers `-profile:v baseline -level 3.1`
  (`:195-196`); master hard-codes `avc1.42e01e` for every tier (`:226`, sole `avc1` in repo); zero
  keyframe/GOP controls (`-g/keyint_min/sc_threshold/force_key_frames` absent) though the repo's own
  e2e fixture encoder sets them (`client-web/e2e/viewer-e2e.spec.ts:113`). No post-encode conformance:
  only input-side `probeMediaDuration`. 1080p@Baseline3.1 is out of profile by frame size alone.
- **[P0.3] OPEN.** `runVideoTranscode.ts:125-127` fire-and-forget deletes the old run tree on the next
  microtask after the pointer flip; `previousHlsTreeToGc` is a safety filter, no time concept; no
  retention schema (only `sim_revisions.retired_at` exists, sim-only); no GC worker; R2 proxy miss path
  is redirect-then-404. Other whole-tree purgers: `video.controller.ts:507`, `projects.controller.ts:446`.
- **[P1.7] OPEN.** `uploadWithFallback(key, data, contentType)` forwards no cacheControl — but the
  adapters NOW accept a 4th `cacheControl` param (added by P7 commit `22e16a1`), and non-video callers
  already use it (PosterService etc.). `/hls-proxy/*` hard-codes `public, max-age=3600` (`server.ts:331-335`);
  `/hls-public/*` = segments 86400 / playlists no-cache (`server.ts:291-296`). Token-in-path fragments
  cache keys: `mintMediaToken` embeds second-granularity `exp`, and player config mints fresh URLs per
  fetch (7 call sites in `buildPlayerConfig.ts` + controllers). Commit `0398dec` immutable caching is
  sim-revision-only. Test note: `uploadWithFallback.test.ts` asserts the exact 3-arg call shape.

### Viewer handoff (agent V1 — complete)

- **[P0.1] OPEN.** Exit is ungated in both paths: `resumeFromSim` backToVideo branch
  (`useProjectPlayer.ts:2940-3020` — cover drop at `:3008`, then seek `:3014` + `safePlay` `:3016`) and
  the automatic `deactivateSim` (`:1037-1058`). The only rVFC in the codebase is `boundaryClock.ts`
  (entry-side sentinel). `SimPresentationLayers` mounts only while `state.simModern`, always
  `intent="sim"` (`HLSPlayerShell.tsx:526-556`), so `exit-to-video*` policy verdicts are unreachable.
  Audio: `deactivate()` mutes the sim immediately (`SimRuntimeClient.ts:1405-1424`); no audibility wait.
- **[P0.6] OPEN.** `await import('hls.js')` at `:2579` with no cancel/unmount guard (cleanup sets
  `unmountedRef` at `:2648`, after `destroy()` at `:2634` — in-flight import leaks an instance).
  `startPlayback` (`:2827`) sets `started` + `safePlay` with no readiness check; `safePlay` swallows
  rejection (`:182-184`); autoStart fires blind `setTimeout(start, 600)` (`:2848`).
- **[P0.7] OPEN.** `activateBrollClip` still does `detachMedia()`→`attachMedia()` (`:1497-1508`);
  hls.js is exactly 1.6.16; `transferMedia()` exists in the lib and is used nowhere; untouched since audit.
- **[THUMB] OPEN.** Poster removed on `!state.started` alone (`HLSPlayerShell.tsx:399`); play button same
  boolean (`:594`).
- **[KILLSW] OPEN.** `?simpool` is a two-way override (`:327-335`) — can upgrade server `single` to
  tier `all`. The P8 switches (`sim_scheduler_mode`, `sim_adaptive_quality`, `sim_boundary_sentinel`)
  have no URL override.
- **[SENTINEL] wired** behind `sim_boundary_sentinel` (default false; migration **052**), entry-side
  observation only — not a reveal gate. Next free migration number is 053.
- `useProjectPlayer.ts` is 3,065 lines; full section map captured in the V1 report (key anchors:
  runtime ownership 722-861, revealSim 919-950, deactivateSim 1030-1058, updateSimOverlay 1060-1420,
  b-roll 1422-1577, onTick 1892-2154, setup/cleanup 2568-2671, startPlayback 2827, resumeFromSim 2940-3059).

### Sim publication + v2 identity (agent V3 — complete)

- **[P0.4] OPEN (write path).** All P7 machinery exists and is tested (~75 cases), but
  `RevisionService.activate()` has **zero production callers** (only `rollback()` calls it). Live SSE path:
  `sections.controller.ts:544/:594 → runSseGeneration :479 → generateOrReuseSection :347` →
  `SimulationService.uploadSectionBridge` (`:2474`, called at `:2396`/`:2616`) = mutable RMW
  (read bridge `:2508` → upload `:2531` → DB `bridge_hash`+class-null `:2545` → read entry `:2576` →
  upload `:2585`); section row update is a separate bare UPDATE (`sections.controller.ts:461-468`);
  abort check at `:463` fires **after** all writes; locks still process-local (`:42`, `bridgeLocks :1946`).
  Read path IS wired (`buildPlayerConfig.ts:386-394` resolves the pointer). RevisionService design note:
  no lock by design — never-reused prefixes + CAS; concurrent publication = the loser's `activate()`
  fails with `RevisionConflict`. `RevisionMigration.ts` has the full-package copy helper (f7b8be1).
  Gotcha: both legacy verdict writers guard on `isNull(active_revision_id)`.
- **[P0.5] OPEN.** `simApplyGate.ts:47` still `reveal-now` when `lastScript === null`; no persisted
  ack-capability anywhere (`ackCapable` is in-session only, set on first SCRIPT_APPLIED at
  `SimRuntimeClient.ts:522`); `package_class` IS persisted+delivered (`useProjectPlayer.ts:1243`) but only
  consulted by the v3 path. Generated bodies still deliberately capped `managed-partial`
  (`SimulationService.ts:2514-2528`; `simFailurePolicy.ts:70`). c4cb1d6/cd9927e cover only the cold-seek
  branch (`:1356` guard) — a prepainted pooled document still reveals ungated.
  `simApplyGate.test.ts:55-57` currently pins the hole as expected behavior.
- **[EVICT] OPEN.** `dropPooled` (`useProjectPlayer.ts:814-828`) → `dispose()` → `teardownModern`
  sends RELEASE/DISPOSE then closes the port immediately (`SimRuntimeClient.ts:1238-1241`); the child DOES
  send `DISPOSED` (`simRuntimeChild.ts:936-942`) and `documentMachine.ts:114` models DISPOSING→EVICTED,
  but the parent has no DISPOSED handler. 8434df5 fixed victim selection (`poolResidency.ts`), not teardown.

### Editor (agent V4 — complete)

- **[P1.1a] OPEN.** Picker timer effect deps are literally `[uiUnchecked]` (`SectionEditor.tsx:629`)
  behind an eslint-disable whose justification is false; `stopPreview` (`:572-577`) neither cancels the
  timer nor re-runs the effect; `useSimRuntime` keeps ONE client across document changes, so the stale
  timer drives the NEW document with OLD script/params. Note: `transitionOrder.test.ts:305-330` forbids
  surface-private activation tokens — design the fix within that constraint.
- **[P1.1b] OPEN (both halves).** `simPreviewUrl = section.simulation_url ?? activeSim?.entry_file`
  (`:267`) — picker change doesn't change the mounted document; `applyDone` (`:724-738`) unconditionally
  activates on the current runtime, then the `key={simPreviewUrl}` remount auto-runs again via the
  handshake effect (`:590-598`) with DIFFERENT params (persisted vs live) — last writer wins.
- **[P1.1c] OPEN.** No lease anywhere; arbitration is one `sim-preview-active` CustomEvent
  (`SectionEditor.tsx:1109-1116` → `VideoPlayer.tsx:181-199`), gated on tab-open not run-state; two
  later effects resume/activate unconditionally (`VideoPlayer.tsx:169-175`, `:281-350` — activate `:334`,
  bare resume `:343`); preview never pauses video. Closest prior art: `TimelinePanel.tsx:185-202`
  filmstrip decode semaphore. `transitionOrder.test.ts:352-355` pins the CustomEvent pact tokens.
- **[P1.2] OPEN.** All three toggle paths run full `activate()`; generated v2 `startScript` sig-compare
  only dedups identical params (`SimulationService.ts:1419-1452`) — any real change tears down + reruns
  the body; NO `SET_UI_POLICY`-shaped message exists in any layer; UI policy lives only inside
  `PrepareSectionPayload.config`, so config change ⇒ new activation even on v3
  (`simRuntimeChild.ts:759-810` onPrepare releases + reruns). v2 has `pauseScript` but no resume.
  Wiring points for a new message: `runtimeProtocol.ts:57-104,388-402`, child dispatcher
  `simRuntimeChild.ts:1046` + accepted-type maps `:677/:681`, v2 bridge listener
  `SimulationService.ts:1454-1466`, bridge validator `:1575-1576`.
- Editor has ZERO behavioral test coverage (only the AST-shape `transitionOrder.test.ts`); no e2e opens
  the editor.

### Flags / pool / compat / test infra (agent V5 — complete)

- **Five runtime switches**, all env → `admin_settings` → default: `sim_pool_mode` (default adaptive),
  `sim_rum_sample_rate` (0), `sim_scheduler_mode` (off), `sim_adaptive_quality` (false),
  `sim_boundary_sentinel` (false). **None settable via admin API** — `UpdateSettingsSchema`
  (`settings.controller.ts:9-18`) omits all five (and `rum_retention_days`); flipping requires env or
  SQL. Predictive admission additionally requires pool tier `all` (`useProjectPlayer.ts:2058`).
- **[CLASSIFY] CONFIRMED.** `canWarmUnpaused()` (`simCapability.ts:12-21`) never reads
  `hardwareConcurrency`; unknown desktop → `all`, while `simUrl.ts:80-84` stamps the same device
  `lowend=1` at ≤4 cores. Third divergent predicate in `simLifecycle.ts:9-23`. P8 planner inherits the
  tier (capacity is a caller argument) — the misclassified device is exactly the one getting speculative
  preparation.
- **[DESCRIPTOR]** `SimPoolFrameSpec` still `{key, src, bootHide}`; revision/class/budgets travel on
  separate channels; package weight is advisory-only inside revision `metadata` JSON, no runtime reader.
  Two structurally different `SimOccurrence` types coexist (simPool.ts vs occurrencePlanner.ts).
- **[P0.8]** No import-map rewriting, no client `HTMLScriptElement.supports('importmap')` detection, no
  tracked HTML/fixtures with import maps, no Three.js hosted/pinned anywhere (sole jsdelivr ref is
  mermaid for avatars). Publication records `externalDependencies` (advisory, "recorded, never fetched")
  and actively REJECTS injecting external script tags (`SimulationService.ts:1597`). Presentation layer
  has poster reasons but nothing routes an import-map failure into them.
- **[PKGS]** boids-3d / murmuration-knob / pluck-boids exist only on the Desktop, not in-repo →
  package-side work (P1.6/P1.8/P2.4/P2.5) is out of branch scope; documented as follow-ups.
- **[TESTINFRA]** node v24.19.0 / pnpm 11.4.0 OK. All workspaces `vitest run`; 11 Playwright specs / 8
  configs, some 900–1500s; default config targets the DEPLOYED site; release gate
  (`deploy/scripts/release-verify.sh`) = install → shared build → typecheck → lint → test → prod builds
  → bundle scan, **zero Playwright**. `shared` must be built before others typecheck.

## 6. Per-lane test gates

- **Lane A:** unit tests on ffmpeg arg assembly (per-tier profile/level/GOP), master-playlist generation
  from probe results, retention/GC unit tests (pointer flip → old tree alive; GC after expiry), header
  tests on storage adapters. No re-transcode of existing media in CI.
- **Lane B:** reducer unit tests over the state cartesian (intent × generation × evidence × visibility ×
  timeout); fake-rVFC harness (target/stale generations, non-arrival); existing viewer Playwright suites
  must stay green with flag off AND on; new e2e: post-roll return keeps cover until target evidence.
- **Lane C:** apply-gate unit tests (ack-capable first activation waits; legacy holds cover; bounded
  failure path); no wrong-frame reveal in transition e2e.
- **Lane D:** stop-within-150ms, sim-switch-while-timer-pending, generation URL change, lease
  acquire/release incl. unmount, Strict-Mode double-mount.
- **Lane E:** unsupported-UA fixture renders poster + recovery, supported path unchanged.
- **Global:** `pnpm -r typecheck && pnpm -r lint && pnpm -r test`; targeted Playwright viewer/release-gate
  suites; all new flags default-off verified by a flag-state test.

## 7. Rollback design

Every lane's behavior change is independently flag-gated; server-side value wins; client may only
downgrade. Lane A encoder changes are versioned per-run (old trees retained by P0.3 itself). Lane C
capability metadata is per-revision, so demotion = republish pointer. No published revision bytes are
ever mutated (P7 invariant, preserved).

---

## 8. Requested feature — Duplicate project (new work, not an audit finding)

**Ask (owner, 2026-08-11):** a **Duplicate** action that copies a project's video and *all* of its
data into a brand-new independent project. The affordance sits **next to the existing delete control**
(`VideoEditor.tsx:1340` "Delete video"; the project-level twin lives at `HomeHero.tsx:144` /
`HomeSidebar.tsx:168`). This is a separate lane — it is NOT an audit finding and must not delay P0 work.
Land it after the audit lanes merge, or on its own branch off the same base.

### 8.1 Why this is not a shallow row copy

`projects` is the root of a wide cascade: ~28 tables carry `project_id` (schema.ts), and the media
lives in object storage under per-entity prefixes. Three properties make a naive copy dangerous:

1. **Cross-row identity.** `timeline_sections` references `video_file_id` AND `simulation_id`;
   `branch_edges`/`branch_choice_points` reference section and sequence ids; `video_files.sequence_id`
   references `branch_sequences`. A copy must remap **every** id consistently or it silently produces a
   project whose branch graph points at the ORIGINAL's rows.
2. **Storage is not transactional.** Rows can be copied in one transaction; bytes cannot. Use the
   pattern this branch already establishes for revisions (Lane C): copy bytes into fresh prefixes
   FIRST, verify, then commit the rows — so a failed copy leaves orphan bytes (reapable) rather than a
   project pointing at objects that do not exist.
3. **It collides with Lane A's retention work.** If the duplicate *references* the source's
   `hls/{videoFileId}/{runId}` tree instead of copying it, a later re-transcode of the ORIGINAL will
   retire that tree and `sweepRetiredHlsRuns` will delete it out from under the copy. Either copy the
   HLS bytes under the new `video_file_id`, or introduce refcounting — **copying is strongly
   preferred**; refcounting distributed media is exactly the complexity P0.3 avoided.

### 8.2 Proposed copy matrix (verify each against the schema before implementing)

| Class | Tables | Treatment |
|---|---|---|
| Root | `projects` | New row, new id/org-scoped; `title` → `"<title> (copy)"`; **reset**: `visibility='private'`, `share_token=null`, `share_enabled_at=null`, `slug=null`, `view_count=0`, `status` → draft-equivalent. Never copy a permalink — the slug namespace is unique and shared with playlists. |
| Media rows | `video_files`, `image_files`, `audio_files` | New ids; new storage keys; HLS pointer fields (`hls_master_key`, `hls_360p_key`) rewritten to the copied tree; derived state (`crop_*`, `captions_*`, `waveform_peaks`) copied as data so the copy does not re-run expensive jobs. |
| Timeline | `timeline_sections`, `timeline_markers` | New ids; remap `video_file_id` + `simulation_id`; rewrite `simulation_url` for the copied package. |
| Branching | `branch_sequences`, `branch_choice_points`, `branch_edges`, and `video_files.sequence_id` | Full id remap; copy in FK order; assert no edge escapes the new project. |
| Simulations | `simulations`, `sim_revisions`, `sim_posters` | Project-scoped (`simulations.project_id` NOT NULL cascade), so they MUST be copied, not shared. Copy the **active revision only** as the new project's first revision (`revision_counter` restarts); carry `package_class`/canary verdict only if the bytes are byte-identical, otherwise leave unclassified. Never copy `active_revision_id` verbatim. |
| Authoring inputs | `scripts`, `scenes`, `camera_plans`, `corpora`, `avatar_profiles`/`avatar_visuals` (project-scoped rows only) | Copy — they are the "all the data" the owner means. |
| **Do NOT copy** | `branch_path_events`, `sim_rum_events`, `token_usage`, `billing_transactions`, `user_purchases`, `jobs`, `video_generation_jobs`, `collaborators`, `project_redirect_targets`, `course_lessons` links, `playlists`/`playlist_items`, `avatar_conversations` | Analytics/audit/billing history, in-flight work, access grants and publication bindings belong to the original. A duplicate starts clean. |

### 8.3 Shape of the implementation

- **Backend:** `ProjectDuplicationService` with an explicit ordered plan (storage copy → row copy in FK
  order → single commit), an id-remap map threaded through every step, and a dry-run mode that reports
  what *would* be copied (invaluable as the test oracle). Endpoint `POST /v1/projects/:id/duplicate`
  behind the same authorization as delete (owner/org), plus quota check — duplication multiplies stored
  bytes and must respect plan limits.
- **Async, not request-scoped.** A full HLS ladder is hundreds of MB; run it as a job with progress
  (mirror `video_generation_jobs` patterns) and return the new project id immediately in a
  `duplicating` state. The UI shows progress and blocks editing until ready.
- **Storage copy:** prefer a server-side copy API (R2/S3 `CopyObject`, no download/upload round trip);
  `LocalStorageAdapter` needs a filesystem-copy equivalent. Add `copyPrefix(srcPrefix, destPrefix)` to
  `StorageService` alongside the existing `deleteWithPrefix`.
- **Frontend:** a Duplicate button beside Delete in `VideoEditor.tsx` (and the project cards in
  `HomeHero.tsx`/`HomeSidebar.tsx`), with a confirm dialog reusing the existing delete-dialog component,
  progress state, and navigation to the copy when complete.
- **Tests:** a PGlite fixture project populated across every table in the matrix, then assert
  (a) every copied row's FKs resolve **inside** the new project, (b) zero references escape to the
  original, (c) excluded tables are empty for the copy, (d) storage prefixes differ and both sets of
  bytes exist, (e) a mid-copy failure leaves no half-built project, (f) deleting the ORIGINAL afterwards
  (including its HLS retirement sweep) leaves the copy fully playable — this is the P0.3 interaction
  and it is the single most important regression test in the lane.

### 8.4 Open product questions (need owner input before build)

1. Should the copy land in the same org always, or may it target another org the user belongs to?
2. Should `avatar_config`/persona and guidance data carry over? (Assumed yes — they are authoring data.)
3. Is a partial copy ever wanted ("duplicate structure without media"), or always a full clone?
4. Quota behavior when duplication would exceed the plan: hard refuse, or allow and bill?
