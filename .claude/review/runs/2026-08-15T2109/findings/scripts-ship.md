# scripts-ship — dedicated pass on `backend-api/src/scripts/**` and `ops/ship/**`

Scope: the 29 one-shot operational scripts under `podcast-saas/backend-api/src/scripts/` and the
13 source files of `podcast-saas/ops/ship/`. Both areas were named by zero agent definition files
before this run.

Baseline confirmed green this run: `pnpm -C podcast-saas --filter backend-api typecheck` clean;
`pnpm -C podcast-saas --filter ops-ship test` → 2 files / 35 tests passed.

Not repeated here (already filed): `backend-009` (state.ts:70 write-then-copy),
`backend-010` (fix-migration-tracking.ts), `backend-018` (migrate-sim-revisions.ts dry-run lie).

---

### [P1] The conductor never downloads gate.json or state.json — the artifact preference order picks the one artifact that contains neither
- id: scripts-ship-001
- location: podcast-saas/ops/ship/src/config.ts:53
- category: bug
- confidence: high
- status: confirmed
- what: `SHIP_CONFIG.artifacts.release` is `['release-report', 'release-artifacts']` and
  `collectRunEvidence` `break`s after the first artifact it manages to download. `release-report`
  is uploaded by `.github/workflows/release.yml:565` with `path: "release-artifacts/release-report.*"`
  — it contains only `release-report.json` and `release-report.md`. `gate.json`, `state.json` and
  `manifest.json` live only in the `release-artifacts` artifact, which is therefore never fetched.
- why: `finishReleaseRun` (conductor.ts:699-700) reads exactly those two files to classify a failed
  release, and the file's own docblock says "The release engine has already decided everything —
  gate.json says whether it blocked and whether it rolled back, state.json says exactly where it
  stopped." Both read `null` in practice. A post-deploy gate that found CRITICAL findings and rolled
  production back therefore never takes the `gate?.blocked` branch (conductor.ts:727); it falls
  through to `deployJob?.conclusion === 'failure'` and reports "the deployment failed — check
  whether production was left on the previous version", or to the catch-all "finished as failure
  without a failed job the conductor could name". The failure `kind` is wrong, so `nextActions`
  (report.ts:141-149) prints the deploy-failed playbook instead of the gate-blocked one, and
  `BLOCKING_KINDS` (conductor.ts:912) then labels the run FAILED rather than BLOCKED — inverting the
  one distinction the README calls invariant #1.
- evidence: Read config.ts:52-55; collect.ts:70-85 (`break` after the first successful download,
  with the comment "the first name in preference order is enough"); `.github/workflows/release.yml`
  lines 485, 522 (`release-artifacts`, overwrite:true, full directory) and 565 (`release-report`,
  `path: "release-artifacts/release-report.*"`). The two artifacts are disjoint: the `report` job
  downloads `release-artifacts`, writes `release-report.json` into it, and re-uploads only the
  report glob — so neither artifact alone contains everything the conductor reads. The existing
  suite cannot catch this: `conductor.test.ts:126` declares
  `async downloadArtifact(runId, _name, dest)` — the artifact **name is ignored** and gate.json /
  state.json / release-report.json / plan.json are all written into `dest` for any name, so
  `conductor.test.ts:240` ("reports a blocked post-deploy gate as BLOCKED") passes against a fake
  that cannot reproduce the real artifact split.
- fix: download every configured artifact rather than the first that succeeds — drop the `break` in
  collect.ts:76 and track which names landed (`got` becomes a set), or add an explicit second
  `gh.downloadArtifact(rel.runId, 'release-artifacts', paths.releaseDir)` in `finishReleaseRun`
  before the `readArtifact` calls. Then make `FakeGh.downloadArtifact` honour its `name` argument
  and split the fixture the way the workflow does.
- verify: extend `conductor.test.ts` so the fake serves `release-report.json` only under the name
  `release-report` and `gate.json`/`state.json` only under `release-artifacts`; the existing
  "blocked post-deploy gate" test goes red before the change and green after.
- cross: @release-auditor @test-quality
- effort: M

### [P2] `readArtifact`'s directory recursion resurrects the approval-time snapshot as the post-deploy state
- id: scripts-ship-002
- location: podcast-saas/ops/ship/src/collect.ts:106
- category: bug
- confidence: high
- status: confirmed
- what: When a file is not directly in the destination directory, `readArtifact` walks every
  subdirectory of it and returns the first match. `readPlannedVersion` (conductor.ts:896-903)
  downloads the whole `release-artifacts` artifact into `join(paths.releaseDir, 'plan')` while the
  run is parked on the approval gate. Later, `finishReleaseRun` calls
  `readArtifact(paths.releaseDir, 'gate.json')` and `readArtifact(paths.releaseDir, 'state.json')`
  and — finding nothing at the top level (see scripts-ship-001) — descends into `plan/` and returns
  the **pre-deploy** snapshot.
- why: The conductor presents that snapshot as the post-deploy verdict. On the success path the
  label becomes `"v0.2.0 deployed and published (state <pre-deploy state>)"` (conductor.ts:710); on
  the failure path `state?.state === 'ROLLED_BACK'` (conductor.ts:736) is evaluated against a
  snapshot taken before the deploy ever ran, so it can never be true and the operator is always told
  to go check `state.json` by hand. Worse than a missing artifact: a missing one is reported in
  `notes`, a stale one is silently believed.
- evidence: Read collect.ts:93-112 (`for (const entry of readdirSync(dir…)) { … return found }`),
  conductor.ts:896-903 (`const dir = join(this.d.paths.releaseDir, 'plan')`), conductor.ts:694-700
  (both `readArtifact` calls rooted at `paths.releaseDir`). The `plan/` directory is created only
  when the approval stage runs interactively — i.e. every non-`--auto-approve` shipment.
- fix: give `readPlannedVersion` its own directory outside `releaseDir` (e.g. `paths.dir/plan`), and
  bound `readArtifact`'s recursion to the single unpack level it was written for by passing the
  candidate subdirectory explicitly instead of scanning all of them.
- verify: unit-test `readArtifact` against a directory containing `plan/state.json` and assert it
  does not return it when asked for a top-level `state.json`.
- cross: @release-auditor
- effort: S

### [P2] `ship approve` followed by `ship resume` silently discards the approval
- id: scripts-ship-003
- location: podcast-saas/ops/ship/src/conductor.ts:597
- category: bug
- confidence: high
- status: confirmed
- what: `ship()` resets every stage whose status is `failed`, `blocked` **or `running`** back to
  `pending` (conductor.ts:130-137), so a resumed shipment re-enters `stageApproval`, which begins by
  `rmSync(paths.approveFile, { force: true })`. The APPROVE file an operator wrote before resuming
  is deleted, and the conductor goes back to waiting.
- why: The realistic sequence is: conductor is Ctrl-C'd at the gate → verdict is persisted as
  `AWAITING_APPROVAL` (conductor.ts:184, then saved at 214) → operator runs `pnpm ship approve`.
  `cmdDecision` only refuses when `run.verdict !== 'AWAITING_APPROVAL'` (cli.ts:197), so it accepts,
  writes APPROVE, and prints "the running conductor will act on it within a few seconds" — but no
  conductor is running. The operator then runs `ship resume`, which deletes the file. The release sits
  on the production gate until `approvalTimeoutMs` (config.ts:63 — **12 hours**) and then fails with
  "no approval decision within 720 minutes". The comment at cli.ts:192-196 documents this discard for
  decisions made *before* the gate; nothing says it also applies after.
- evidence: Read conductor.ts:127-138 (the reset loop includes `'running'`), conductor.ts:560-601
  (`begin('approval', …)` marks it running and saves; `rmSync` of both handshake files at 597-598 runs
  unconditionally on every entry), cli.ts:185-209. No test covers approve-then-resume:
  `conductor.test.ts:299` writes APPROVE *while* a conductor waits, and `:312` asserts stale files are
  cleared — the opposite property.
- fix: clear the handshake files only on the first entry into the stage — guard the two `rmSync`
  calls with `if (!stage(this.run, 'approval').startedAt)` before `begin()` stamps it, or compare the
  file's mtime against the recorded `startedAt` and honour a decision written after it. Additionally,
  have `cmdDecision` warn when the run's `endedAt` is set (no conductor attached) and tell the
  operator to run `resume` *before* approving.
- verify: new test — park a run at the gate, end the conductor, write APPROVE, resume with a fake
  that still reports a pending production deployment, and assert `reviewDeployment` is called with
  `approved` rather than the run timing out.
- cross: @release-auditor
- effort: S

### [P2] Two shipments can run at once — `.claude/ship/current` is a pointer, not a lock
- id: scripts-ship-004
- location: podcast-saas/ops/ship/src/cli.ts:154
- category: bug
- confidence: high
- status: confirmed
- what: `cmdRun` creates a run directory and calls `setCurrent`, then ships. Nothing checks whether
  another shipment is already in flight, and nothing is released at the end. `state.ts:5` states the
  design plainly: "current → run id of the shipment in flight (a pointer, not a lock)".
- why: Two `pnpm ship run` invocations (two terminals, a retried command, a background job) both pass
  preflight, both adopt the same PR via `gh.findPr`, both attempt the merge, and both call
  `dispatchWorkflow(release.yml)` — producing two concurrent release runs racing for the same version
  tag. That is exactly the hazard conductor.ts:510-512 guards against *within* one run ("two
  concurrent releases would race for the same version tag") but not across processes. Secondarily,
  `newRunId` (state.ts:58) has one-second resolution and its own comment concedes it is only
  "collision-free at one shipment per second" — two runs started in the same second share a directory
  and interleave writes to `ship.json` and `ship.ndjson`.
- evidence: Read cli.ts:122-168 and 170-183 (neither `cmdRun` nor `cmdResume` takes any lock),
  state.ts:23-100 (no lock primitive exists in the module), conductor.ts:506-521. Grepped the package
  for `flock|lockfile|\.lock|wx'` — no match anywhere in `ops/ship/src`.
- fix: in `cmdRun`/`cmdResume`, `openSync(join(home,'lock'), 'wx')` before the first stage, write
  `{pid, runId, startedAt}` into it, and remove it in a `finally` plus on SIGINT/SIGTERM. On EEXIST,
  read the holder, check `process.kill(pid, 0)`, and refuse with its runId (offering `--force` only
  when the holder pid is gone). Give `newRunId` millisecond resolution.
- verify: unit test that a second `cmdRun` against the same root exits non-zero without calling
  `createPr`.
- cross: @release-auditor
- effort: M

### [P2] A production deployment rejected in the GitHub UI is recorded as "production approved"
- id: scripts-ship-005
- location: podcast-saas/ops/ship/src/conductor.ts:634
- category: bug
- confidence: high
- status: confirmed
- what: While waiting at the gate the conductor polls `pendingDeployments(runId)` and treats an empty
  production entry as approval: `this.run.verdict = 'RUNNING'; this.ok('approval', 'production
  approved on GitHub')`. GitHub empties the pending-deployments list on **either** outcome — approve
  or reject. The same inference is made at conductor.ts:576-578, which `skip`s the stage with the note
  "no pending production deployment — it was already approved".
- why: The one thing the conductor must never do is misread the production approval gate. It does not
  bypass it — `reviewDeployment(…, 'approved', …)` is still only called for `--auto-approve` or an
  APPROVE file — and the run's own `failure` conclusion is caught downstream by `stageDeploy`, so the
  final verdict is still FAILED. But `SHIP-REPORT.md` records `approval ✓ production approved on
  GitHub`, and the failure is attributed to `deploy` with kind `deploy-failed`, whose next-action
  playbook (report.ts:146-149) tells the operator to read `state.json` and consider a rollback — for a
  deployment a human deliberately declined and that never started.
- evidence: Read conductor.ts:616-646 and 574-579. `Gh.pendingDeployments` (gh.ts:255-265) maps the
  raw `pending_deployments` list; GitHub removes the entry once *any* required reviewer submits a
  review, regardless of state. Nothing else in the loop consults the run's status or the review state.
- fix: on an empty pending list, confirm with `gh.viewRun(runId)` before declaring approval — a run
  that is `completed` with conclusion `failure` while this conductor never submitted a review is an
  external rejection, and should raise `Aborted`/`approval-denied`, not `stage.ok`. Apply the same
  check to the `prod.length === 0` skip at line 576.
- verify: extend the approval tests with a fake whose `pendingDeployments` empties and whose
  `viewRun` then reports `completed/failure`; assert the verdict is ABORTED with kind
  `approval-denied`.
- cross: @release-auditor
- effort: S

### [P2] `watch.mjs` can never exit when the conductor dies without emitting `run.end`
- id: scripts-ship-006
- location: podcast-saas/ops/ship/watch.mjs:39
- category: bug
- confidence: high
- status: confirmed
- what: The watcher loops forever, breaking only on an event with `event === 'run.end'`. It has no
  timeout, no liveness check and no terminal-verdict check.
- why: Its own header asserts "It exits on `run.end` and only on `run.end`. … silence here always
  means 'still working', never 'quietly finished'." That invariant does not hold for SIGKILL, an OOM
  kill, a laptop that sleeps and is force-quit, or a throw from inside `ship()`'s own catch block —
  conductor.ts:171-178 calls `markStage`, `this.save()` and `journal.emit()` while handling a
  StageFailure, and a throw there (full disk, EACCES on the run directory) escapes `ship()` to
  `cli.ts:369`, which prints to stderr and exits without ever emitting `run.end`. This is the command
  behind Claude's `Monitor`, so the failure mode is a watcher that prints nothing for hours and is
  indistinguishable from a healthy 40-minute release.
- evidence: Read watch.mjs:37-68 (the only `break` is `if (ended)`), cli.ts:365-372 (the top-level
  catch writes stderr; no journal write), conductor.ts:150-214 (the emit/save calls inside the catch
  are not themselves guarded).
- fix: also exit when `ship.json`'s `verdict` is terminal (`SHIPPED|BLOCKED|FAILED|ABORTED`) and
  print an explicit `watcher: the conductor exited without a run.end event` line; optionally track
  the conductor pid in `ship.json` and exit when `process.kill(pid, 0)` throws.
- verify: manual — start the watcher against a journal, `kill -9` the writer, confirm the watcher
  now terminates with the diagnostic line.
- cross: @observability
- effort: S

### [P3] Ctrl-C is not honoured during a `gh` call; the AbortSignal only cancels sleeps
- id: scripts-ship-007
- location: podcast-saas/ops/ship/src/run.ts:15
- category: bug
- confidence: high
- status: confirmed
- what: `runCommand` accepts only `{cwd, timeoutMs}` and never passes `execFile` a `signal`. The
  conductor's `AbortSignal` reaches only `sleep()`. Additionally `cmdResume` registers SIGINT but not
  SIGTERM (cli.ts:179), unlike `cmdRun` (cli.ts:160-161).
- why: A Ctrl-C during `gh run download` (300 s timeout, gh.ts:233) or `gh pr merge` (180 s,
  gh.ts:194) does nothing until the call returns and the next `sleep` is reached — up to five minutes
  of an apparently unresponsive terminal, which invites the second Ctrl-C that `process.once` leaves
  to the default handler, killing the process before `run.end` and the report are written (see
  scripts-ship-006). `gh.exec`'s retry backoff (`await sleep(2_000 * (i + 1))`, gh.ts:101) is also
  called without the signal.
- evidence: Read run.ts:13-27 (no `signal` in `Runner`'s options type or in the `execFile` options
  object), gh.ts:92-104, cli.ts:158-163 and 178-180.
- fix: add `signal?: AbortSignal` to `Runner`'s options, forward it to `execFile`, and thread
  `this.d.signal` through `Gh`/`Git`; pass it to the retry `sleep`; register SIGTERM in `cmdResume`.
- verify: existing 35 tests inject a fake runner and are unaffected; add one asserting an aborted
  signal rejects a long-running fake command.
- effort: S

### [P3] `runCommand` cannot distinguish a timeout or a maxBuffer overflow from an exit-1, and `failedLog` publishes the truncated output as evidence
- id: scripts-ship-008
- location: podcast-saas/ops/ship/src/run.ts:22
- category: bug
- confidence: medium
- status: confirmed
- what: When `execFile` kills a child for `timeout` or for exceeding `maxBuffer` (64 MB), the callback
  receives an error whose `code` is not a number (it is `undefined` with `killed: true`, or the
  `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` string code). `runCommand` maps anything non-numeric to
  `code: 1` and resolves with whatever partial stdout was captured. Nothing downstream can tell the
  difference.
- why: `Gh.failedLog` (gh.ts:222-228) ignores `res.code` entirely and returns `res.stdout`.
  `collectRunEvidence` (collect.ts:56-64) then writes that partial text to `ci/failed.log` and lists
  it in `evidence`, and `SHIP-REPORT.md` presents it as the failed-step log. A log truncated at
  64 MB, or cut off by the 300 s timeout, is published as complete — and the module header's rule 1
  ("a transport failure is never reported as a negative answer") is exactly what this violates in the
  evidence path.
- evidence: Read run.ts:15-27 (`typeof anyErr.code === 'number' ? anyErr.code : 1`), gh.ts:221-228
  (no code check), collect.ts:56-67 (only `log.trim()` is checked, so partial output is treated as
  success).
- fix: add `killed: boolean` and `signal: string | null` to `ExecResult`; have `failedLog` return `''`
  when `killed` is true so `collectRunEvidence` records the gap in `notes` instead of writing a
  misleading file.
- verify: unit test with a fake runner returning `{code:1, killed:true, stdout:'partial'}` asserting
  the note is emitted and no `failed.log` is written.
- cross: @observability
- effort: S

---

### [P1] `pnpm backfill:storage` overwrites every cloud object from local disk with no dry-run, no scope limit and no confirmation
- id: scripts-ship-009
- location: podcast-saas/backend-api/src/scripts/backfill-storage.ts:53
- category: data-integrity
- confidence: high
- status: confirmed
- what: `main()` walks the entire `LOCAL_STORAGE_BASE_DIR` tree and `uploadStream`s every file it
  finds to the configured cloud adapter under the same key. There is no `--apply`, no `--dry-run`,
  no `--prefix`, no object-count ceiling, no manifest and no prompt. The only guard is that the
  resolved adapter must not be `LocalStorageAdapter`.
- why: The docblock (line 8-9) claims "Idempotent enough to re-run (objects are overwritten). Safe:
  only reads local files and writes to the cloud adapter; never deletes anything." Overwriting a
  live cloud object with a stale local copy destroys it exactly as thoroughly as deleting it — and
  this repo states elsewhere that the bucket has no versioning
  (`rebuild-sim-bridges.ts:12-13`: "this tool overwrites objects in place in a bucket with no
  versioning and has no undo of its own"; `backup-sim-packages.ts:322` repeats it). After the
  storage switch the cloud is authoritative and the local disk holds the pre-switch fallback copies,
  so a second run of this one-time migration — trivially reachable, it is one of only six
  package.json-exposed scripts — replays every old local byte over the current cloud object. Every
  other write-capable script in this directory (`backfill-localhost-urls`, `backfill-avatar-circles`,
  `reinject-sim-gates`, `rebuild-sim-bridges`, `backfill-bridge-capabilities`, `sim-canary-publish`,
  `classify-orphan-sim-rows`) is report-first with an `--apply` gate. This one is not.
- evidence: Read the whole file (69 lines). Line 44-49 is the entire guard. Line 53-64 is an
  unbounded `for await` over `walk(LOCAL_STORAGE_BASE_DIR)` calling `storage.uploadStream(key, …)`
  with no existence check. package.json:16 exposes it as `backfill:storage` wired to
  `tsx --env-file=../.env`, so the target bucket is whatever the env file names.
- fix: default to report mode — list key, local size, local mtime and whether the key already exists
  in the bucket (`storage.objectExists`) — and require `--apply` to write, matching
  `backfill-localhost-urls.ts:53`. Add `--prefix <k>` and `--max-objects N` with the same
  block-unless-`--approve-unsafe` policy shape, and skip keys that already exist unless
  `--overwrite` is passed. Correct the docblock's "Safe" claim.
- verify: run with no flags against a bucket containing one of the keys and confirm it reports
  "would overwrite" and writes nothing; `pnpm -C podcast-saas --filter backend-api typecheck` stays
  clean.
- cross: @security
- effort: M

### [P2] `--max-affected` is coerced with `Number()`, and a NaN silently disables the safety ceiling
- id: scripts-ship-010
- location: podcast-saas/backend-api/src/scripts/backfill-localhost-urls.ts:60
- category: bug
- confidence: high
- status: confirmed
- what: `const MAX_AFFECTED = Number(argValue('--max-affected') ?? '50')`. `evaluateBackfillPolicy`
  (scripts/lib/urlBackfill.ts:92) raises the ceiling reason with `totalAffected > maxAffectedRows`,
  which is `false` for `NaN`. A malformed or misplaced `--max-affected` therefore removes the
  row-count ceiling from the policy gate entirely, and `--apply` proceeds unbounded without
  `--approve-unsafe`.
- why: This is reachable by an ordinary flag-order slip, not a contrived input: `argValue` returns
  "the next argv element" with no validation, so `--max-affected --apply` yields `'--apply'` and
  `Number('--apply')` is `NaN`. The gate is the only thing standing between a report-first tool and
  an unbounded `UPDATE` across nine columns of production data. The same coercion feeds the same kind
  of gate at `backfill-avatar-circles.ts:43` → `:131` (`repairs.length > MAX_AFFECTED`). The
  repository already solved this correctly one file over —
  `backfill-bridge-capabilities.ts:378-386` parses with `Number.parseInt` and comments "A malformed
  --limit is IGNORED rather than silently treated as 0: a run that quietly does nothing looks exactly
  like a run that found nothing to do."
- evidence: Read backfill-localhost-urls.ts:52-61 and lib/urlBackfill.ts:82-95. Verified the
  behaviour directly: with the real comparison, `total=9999, max=50` → `{unsafe:true,
  reasons:["ceiling"]}`; `total=9999, max=Number('--apply')` → `{unsafe:false, reasons:[]}`.
  The other two policy reasons (`wouldNull`, `missingAssets`) still fire, so the gate is weakened
  rather than removed — but a plan that is pure rewrites over thousands of rows is precisely the case
  the ceiling exists for.
- fix: parse with `Number.parseInt(raw, 10)` and exit 2 with a usage error when the result is not a
  finite non-negative integer, in both `backfill-localhost-urls.ts:60` and
  `backfill-avatar-circles.ts:43`; log the resolved ceiling (both already do) so the report shows what
  was enforced.
- verify: add a unit test on `evaluateBackfillPolicy` asserting a non-finite ceiling is rejected
  rather than silently passing.
- cross: @database
- effort: S

### [P2] `migrate-sim-revisions.ts --sim` with a missing value silently becomes a 25-simulation run
- id: scripts-ship-011
- location: podcast-saas/backend-api/src/scripts/migrate-sim-revisions.ts:35
- category: bug
- confidence: high
- status: confirmed
- what: `else if (a === '--sim') out.simId = argv[++i];` takes whatever follows, including nothing.
  A trailing `--sim`, or `--sim --dry-run` (which also swallows the dry-run flag so `dryRun` stays
  `false`), leaves `simId` undefined. `main()` then evaluates `args.simId ? [args.simId] : (…)` at
  line 58 and falls through to the un-scoped branch: every simulation with
  `active_revision_id IS NULL`, capped only by `--limit` (default 25).
- why: The operator's intent — "publish a revision for this one simulation" — becomes "publish
  revisions for 25 arbitrary simulations", each of which copies every byte of a package through the
  Node heap into a new storage prefix. `--limit` has the same shape: `Number(argv[++i] ?? 25)` yields
  `NaN` for `--limit --force`, and `NaN` then reaches drizzle's `.limit()`.
- evidence: Read the whole file (107 lines); `parseArgs` at 29-39, the branch at 58-67. The `?? 25`
  guard only covers the *undefined* case, not the *consumed-a-flag* case, and does not cover `--sim`
  at all. Note `backfill-bridge-capabilities.ts:378` avoids this entirely with `--limit=<n>` syntax.
- fix: reject a value flag whose argument is missing or starts with `--` (throw a usage error and
  exit 2); validate `limit` with `Number.parseInt` + `Number.isInteger(n) && n > 0`. Optionally adopt
  the `--sim=<id>` form used by the sibling script.
- verify: unit-test `parseArgs` (export it) for `['--sim']`, `['--sim','--dry-run']` and
  `['--limit','abc']`.
- effort: S

### [P2] `phase2-fixtures.ts create` writes its cleanup manifest only after every insert, and always to one fixed path
- id: scripts-ship-012
- location: podcast-saas/backend-api/src/scripts/phase2-fixtures.ts:166
- category: data-integrity
- confidence: high
- status: confirmed
- what: The docblock promises "Every created id is recorded to FIXTURES_FILE so `cleanup` can
  guarantee removal." In fact `writeFileSync(FIXTURES_FILE, …)` is the last statement of `create()`,
  after all ten fixture blocks have run. Any throw before it leaves the manifest unwritten and every
  row already inserted unrecorded. `FIXTURES_FILE` is the constant `/tmp/phase2-fixtures.json`
  (line 20), so a second `create` also overwrites the first run's manifest.
- why: `create()` inserts an org, up to nine projects, eight courses, lessons and redirect targets
  into whatever database `DATABASE_URL` names, and fixture block 10 (lines 149-164) queries real
  `video_files`/`projects` rows — a realistic place to throw. `cleanup()` (line 171-181) is driven
  entirely by the manifest and returns "No manifest; nothing to clean." when it is absent, so the
  orphaned org and its projects/courses stay in the database with no recorded ids and nothing but the
  `p2val-*` naming convention to find them by. Running `create` twice guarantees the first run is
  unrecoverable through the tool.
- evidence: Read the whole file (196 lines). Line 57 builds the manifest in memory; lines 58-59
  push ids into it; nothing persists it until line 166. Line 192-194's `finally` calls
  `process.exit`, not a manifest flush.
- fix: persist the manifest incrementally — make `track`/`trackCourse` write the file after each id,
  or wrap `create()` so the manifest is written in a `finally` whether or not it completed. Include
  the nonce in the filename (`/tmp/phase2-fixtures-${nonce}.json`) and have `cleanup` accept a path,
  so a second run cannot orphan the first.
- verify: force a throw in block 5, run `cleanup`, and confirm the org and projects created by
  blocks 1-4 are removed.
- cross: @database
- effort: S

### [P2] `seed-sim-pool-synthetic.ts` guards the storage target but not the database target
- id: scripts-ship-013
- location: podcast-saas/backend-api/src/scripts/seed-sim-pool-synthetic.ts:124
- category: data-integrity
- confidence: high
- status: confirmed
- what: `assertLocalStorageOnly(storage)` proves the fixture bytes cannot reach a cloud bucket.
  Nothing anywhere checks where `DATABASE_URL` points. `wipe()` (lines 81-88) then issues four
  DELETEs and `main()` inserts a `visibility: 'public'` project, an org, a user, three simulations
  with revision rows, two videos and four timeline sections.
- why: The docblock (lines 22-23) advertises the guard as covering the whole script — "All bytes are
  written through the storage adapter, which MUST be the local disk adapter — the script refuses to
  run otherwise, so it can never write into a cloud bucket" — and a reader reasonably concludes the
  script is contained. `STORAGE_BACKEND=local` with a production `DATABASE_URL` is the exact state a
  developer reaches by exporting one variable, and it seeds a public `[SYNTHETIC] Sim Pool` project
  into production. This is a class problem, not a one-off: grepping the directory, **no script has
  any database-target guard**; `seedGuards.ts` exists solely so the storage predicate is unit-testable
  and cannot be deleted unnoticed, and the equivalent for the database was never written. It stands
  directly against the project's standing rule that local runs never touch production.
- evidence: Read seed-sim-pool-synthetic.ts:121-135 and 81-88; seedGuards.ts (18 lines — one
  predicate, storage only). Grepped all 29 scripts for a connection-string check: the only
  `DATABASE_URL` references are `process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/podcast_saas'`
  fallbacks (check-db.ts:89, check-migrations.ts:2, fix-migration-tracking.ts:2,
  who-owns-projects.ts:13, backfill-localhost-urls.ts:103, backfill-avatar-circles.ts:78) — a safe
  *default*, but not a guard on what the env file actually supplies. The one opt-in that does exist
  (`seed-sim-pool-from-production…ts:42`) gates on reading real data, not on the write target.
- fix: add `assertLocalDatabase(connectionString)` to `seedGuards.ts` beside `assertLocalStorageOnly`
  — accept only hosts in `{localhost, 127.0.0.1, ::1}` unless
  `ALLOW_NONLOCAL_DB=i-understand-this-writes-to-a-shared-database` is set — call it from every
  seeder and fixture script (`seed-sim-pool-synthetic.ts`, `seed-sim-pool-from-production…ts`,
  `phase2-fixtures.ts`), and unit-test it the way the storage predicate already is.
- verify: new unit test on the predicate; run the seeder with a non-local `DATABASE_URL` and confirm
  it refuses before the first DELETE.
- cross: @security @database
- effort: M

### [P2] `db:check` carries a second hardcoded migration list that nothing audits
- id: scripts-ship-014
- location: podcast-saas/backend-api/src/scripts/check-db.ts:20
- category: data-integrity
- confidence: high
- status: confirmed
- what: `MIGRATION_FILES` is a 58-entry ordered array duplicating the hardcoded list in
  `podcast-saas/backend-api/src/db/migrate.ts:25`. Both are currently identical (verified this run —
  58 forward `.sql` files on disk, 58 entries in each list), but nothing keeps them so.
- why: `ops/release/src/migration-audit.ts:127-129` extracts the runner list with
  `source.match(/const\s+migrations\s*=\s*\[([\s\S]*?)\]/)` against `migrate.ts` and compares it to
  the files on disk — it reports `migrations.not-in-runner` / `migrations.missing-file` for that list
  only. `check-db.ts`'s copy is invisible to it. When migration 059 lands and is added to
  `migrate.ts`, `pnpm --filter backend-api db:check` will print `✓` for all 58 migrations it knows
  about and say nothing about 059 — reporting a database as current when the check never looked. This
  matters more than an ordinary duplication because `db:check` is one of only six package.json-exposed
  scripts (package.json:14) and is the tool an operator runs to answer "is this database current?".
- evidence: Read check-db.ts:1-115 (the list at 20-79, consumed at 99-110, with
  `readFileSync(join(MIGRATIONS_DIR, f))` at 115 confirming the file exists). Read migrate.ts:25 and
  migration-audit.ts:127-215. Counted: `ls src/db/migrations/*.sql | grep -v rollback` → 59, of which
  `phase2-schema.sql` is the known non-canonical file, i.e. 58 forward migrations, matching both lists.
- fix: export the ordered list from one module (e.g. `src/db/migrationList.ts`) and import it in both
  `migrate.ts` and `check-db.ts`; or have `check-db.ts` parse `migrate.ts` the way `migration-audit.ts`
  does. Add a `migration-audit` finding for any second literal list found under `backend-api/src`.
- verify: after the change, appending an entry in one place makes `db:check` see it with no second
  edit; `pnpm -C podcast-saas --filter backend-api typecheck` stays clean.
- cross: @database @migration-auditor
- effort: S

### [P2] `verify-storage.ts` leaves a 55 MB object and an unaborted multipart upload in the bucket on every failed run
- id: scripts-ship-015
- location: podcast-saas/backend-api/src/scripts/verify-storage.ts:121
- category: bug
- confidence: high
- status: confirmed
- what: The three cleanup `deleteFile` calls are the last statements of the `try` block. Anything that
  throws before them — the presigned GET (line 43), the presigned PUT (line 73), `readObject` (35),
  `getPresignedDownloadUrl` (42) — lands in the catch at line 139 and exits 1 with
  `_selfcheck/probe-*.txt`, `_selfcheck/presigned-*.txt` and `_selfcheck/multipart-*.bin` still in the
  bucket. Separately, the multipart block calls `storage.createMultipartUpload` at line 95 and its
  catch (114-119) only logs — there is no `abortMultipartUpload`, so a part PUT that fails leaves an
  in-progress multipart upload holding whatever parts already landed.
- why: This is the storage self-check an operator runs precisely when storage is misbehaving, so the
  failing path is the common path. Each failed run deposits 55 MB of garbage plus an orphaned
  multipart upload into the configured — i.e. usually production — bucket, and those uploads are
  billed and are not visible in an ordinary object listing. Nothing else ever cleans `_selfcheck/`.
- evidence: Read the whole file (146 lines). Lines 121-124 are inside the `try`; the `catch` at 139-142
  does no cleanup and there is no `finally`. Line 95 creates the multipart upload; the catch at 114
  records `multipartErr` and continues to line 121, so the abort never happens on the *thrown* path
  and the object delete at 124 is skipped whenever the throw came from an earlier step.
- fix: collect created keys into an array and delete them in a `finally` with `.catch(() => {})` each;
  hold `uploadId` outside the inner `try` and call the adapter's abort (adding
  `abortMultipartUpload` if the adapter lacks it) in the inner catch before rethrowing/continuing.
- verify: make `getPresignedDownloadUrl` reject and confirm the probe object no longer survives the
  run.
- cross: @media-pipeline
- effort: S

### [P2] `reinject-sim-gates.ts --apply` rewrites every ready simulation's entry HTML in place, with no backup, no scope limit and no drift check
- id: scripts-ship-016
- location: podcast-saas/backend-api/src/scripts/reinject-sim-gates.ts:81
- category: data-integrity
- confidence: high
- status: confirmed
- what: `--apply` iterates every simulation with `status = 'ready'` and calls
  `storage.uploadFile(entryKey, …)`, overwriting the live entry HTML of each package in one pass.
  The dry-run default is correct; what is missing is everything around it — no `--sim`, no `--limit`,
  no required rollback point, and no re-read of the object immediately before the PUT.
- why: Its sibling `rebuild-sim-bridges.ts` performs the *same class* of in-place overwrite on the
  *same* objects and surrounds it with two protections this script lacks. (1) A documented rollback
  precondition — rebuild-sim-bridges.ts:12-14: "Take a rollback point first — this tool overwrites
  objects in place in a bucket with no versioning and has no undo of its own: … backup-sim-packages.ts
  backup". reinject-sim-gates' docblock says nothing. (2) An optimistic-concurrency re-read —
  rebuild-sim-bridges.ts:117-125 calls `detectConflicts` and skips the package when the entry HTML
  moved, with the reason spelled out at lines 47-54: "entry HTML drift = a guidance publish (which
  rewrites the SAME entry HTML to carry the guidance.js?v=<hash> tag) would be silently reverted".
  reinject-sim-gates reads at line 61-70 and writes at 81 with an unbounded gap between them (a
  network `fetch` fallback sits in that gap), so a concurrent guidance publish is silently reverted.
  With no `--limit`, a defect in `injectInlineBridge`/`injectRafGate` corrupts every ready package in
  one run and there is nothing to restore from.
- evidence: Read the whole file (105 lines) and rebuild-sim-bridges.ts (163 lines) side by side. The
  only guard in reinject-sim-gates is the `--apply` flag at line 32; the write at line 81 is
  unconditional within the loop.
- fix: add `--sim <id>` and `--limit N`; re-read `entryKey` immediately before the upload and skip on
  mismatch (import `detectConflicts` from rebuild-sim-bridges.ts rather than duplicating it); state
  the `backup-sim-packages.ts backup` precondition in the docblock and refuse `--apply` without an
  explicit acknowledgement flag, matching the protocol rebuild-sim-bridges.ts already documents.
- verify: extend `src/scripts/__tests__/simRolloutTooling.test.ts` with a drift case for this script,
  mirroring the existing rebuild drift tests.
- cross: @simulation
- effort: M

### [P3] `gen-sim-fixture.ts` writes into any directory given on the command line; its sibling refuses to
- id: scripts-ship-017
- location: podcast-saas/backend-api/src/scripts/gen-sim-fixture.ts:905
- category: bug
- confidence: high
- status: confirmed
- what: `main()` takes `outDir` from `process.argv[2]` and calls `emit()` eight times; `emit` does
  `mkdirSync(dir, { recursive: true })` and `writeFileSync(join(dir, 'bridge.js'))` /
  `writeFileSync(join(dir, 'index.html'))`, silently overwriting whatever is already there. The only
  validation is that the argument is non-empty.
- why: `gen-rebuilt-fixture.ts:378-401` implements `prepareOutDir` for exactly this hazard, with the
  reasoning written out: "`<outDir>` comes from the command line, and the obvious `rmSync(outDir)`
  would happily delete a real `--dump-dir` (or a source tree) if someone reused the path." It refuses
  a non-empty directory carrying no fixture marker. The identical exposure in `gen-sim-fixture.ts` is
  unguarded, and this is the generator invoked indirectly by `seed-sim-pool-synthetic.ts:92`.
  Blast radius is a developer's directory rather than production, hence P3 — but the fix is already
  written one file over.
- evidence: Read gen-sim-fixture.ts:895-960 (`emit` at 895-902, `main` at 904-955, the direct-invoke
  guard at 957-959) and gen-rebuilt-fixture.ts:378-401.
- fix: call the same guard — refuse a non-empty `outDir` that carries no fixture marker file, and
  write the marker on success. Factor `prepareOutDir` into a shared helper so there is one copy.
- verify: run the generator twice into a directory containing an unrelated file and confirm the
  second run refuses.
- effort: S

### [P3] `seed-sim-pool-from-production` documents a filename that does not exist, and its "idempotent" wipe-and-recreate is not transactional
- id: scripts-ship-018
- location: podcast-saas/backend-api/src/scripts/seed-sim-pool-from-production.DO-NOT-USE-IN-E2E.ts:25
- category: maintainability
- confidence: high
- status: confirmed
- what: The usage block (lines 25-27) tells the operator to run
  `tsx --env-file=../.env src/scripts/seed-sim-pool-fixture.ts` — a file that does not exist; it was
  renamed to the current `…DO-NOT-USE-IN-E2E.ts` name (the replacement note at
  `seed-sim-pool-synthetic.ts:5` confirms the rename). Separately, the `db.delete(projects)` at line
  107 and the eight inserts that follow it (109-160) are not wrapped in a transaction.
- why: A copy-pasted usage line that cannot run is a small cost; the untransacted wipe is the larger
  one. Line 12 claims "fixed project id — idempotent: re-running deletes + recreates it", but an
  insert failure anywhere in 119-160 leaves a public `[FIXTURE]` project in the shared database with
  a partial timeline and no branching, and the "re-running fixes it" property only holds if the next
  run itself gets past the same failure point.
- evidence: Read the whole file (172 lines). Confirmed `seed-sim-pool-fixture.ts` does not exist in
  `src/scripts/` (directory listing). Lines 107-160 contain nine sequential `db.insert`/`db.delete`
  calls with no `db.transaction` wrapper.
- fix: update lines 25-27 to the real filename and to include the required
  `ALLOW_PRODUCTION_DATA_SEEDER=…` opt-in; wrap the delete and all inserts in `db.transaction(async
  (tx) => { … })` so a failed seed leaves nothing behind.
- verify: `grep -c seed-sim-pool-fixture.ts` across the repo returns 0 after the doc fix.
- effort: S
