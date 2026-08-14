# ops/ship — the shipment conductor

One command takes a branch from *committed locally* to *released and audited in
production*:

```bash
pnpm -C podcast-saas ship run --bump patch
```

It replaces this manual loop — open a PR, wait, click Merge, wait, open Actions,
dispatch **Release FlowVid**, pick a bump, wait, approve the `production` environment,
wait, dispatch **Production audit**, download artifacts, read logs — with one process
that does all of it and writes down what happened.

## What it is not

**It decides nothing about the code.** Every pass/fail verdict still comes from CI, the
release gate in [`ops/release`](../release), and the production audit — all of which
stay AI-free and deterministic by design. The conductor only sequences dispatches,
watches results, collects evidence, and reports. It never edits a workflow, never
weakens a check, and never approves production on its own.

## The pipeline

| Stage | What happens | Who decides |
| --- | --- | --- |
| `preflight` | clean tree, feature branch, `gh` access, push | conductor |
| `pr` | create or adopt the pull request | conductor |
| `ci` | the `pull_request` CI run must be green | **CI** |
| `merge` | merge into `main` (merge commit by default) | conductor |
| `main-ci` | the push-to-main run — normally short-circuited by the CI redundancy guard | **CI** |
| `release` | dispatch `release.yml`, watch to the approval gate | **release engine** |
| `approval` | production environment approval | **a human** |
| `deploy` | deploy, post-deploy gate, publish | **release engine** |
| `audit` | dispatch `production-audit.yml`, read its verdict | **production audit** |
| `report` | assemble `SHIP-REPORT.md` | conductor |

## Run directory

Everything about one shipment lands in `.claude/ship/runs/<runId>/` (git-ignored):

```
ship.json          resumable state — stages, workflow run ids, verdict, failure
ship.ndjson        append-only event journal, one JSON object per line
SHIP-REPORT.md     the one file to read: verdict, timeline, evidence, next actions
APPROVE | DENY     the approval handshake, written by `ship approve` / `ship deny`
ci/failed.log      failed-step logs, collected only on failure
release/           release-report.json/md, gate.json, state.json, manifest.json
audit/             audit-report.json/md, audit-verdict.json, collectors.json
```

## Watching it live

```bash
node podcast-saas/ops/ship/watch.mjs .claude/ship/runs/<runId>/ship.ndjson
```

Prints one line per notable event, replays from the beginning if attached late, and
exits when the shipment ends. No dependencies — this is what Claude's `Monitor` runs
(see [`.claude/skills/ship`](../../../.claude/skills/ship/SKILL.md)).

## Commands

```
ship run --bump patch|minor|major     take the current branch all the way
   [--no-deploy] [--no-audit] [--auto-approve] [--squash]
   [--backfill report-only|allow-safe|require-approval] [--approve-high]
ship resume                           continue after a fix, a Ctrl-C, or a sleeping laptop
ship approve | deny                   answer the production gate
ship status [--json] · ship report    where it stands · the full report
ship watch-cmd                        print the watcher command for this run
ship doctor                           check gh access and repo settings; changes nothing
```

Exit codes: `0` shipped · `1` blocked or failed · `2` aborted · `3` awaiting approval.

## Two invariants

The tests in `src/__tests__` exist to hold these, because this code merges pull
requests and approves production deployments:

1. **Silence is never success.** Every wait has a ceiling, and hitting one is a `FAILED`
   verdict, never a pass. `BLOCKED` (a gate said no — fix the code) is kept strictly
   apart from `FAILED` (the pipeline could not produce a trustworthy answer — fix the
   pipeline, and conclude nothing about production), mirroring the audit's own
   `BLOCKED_BY_FINDINGS` / `BLOCKED_BY_AUDIT_ERROR` split.
2. **Resumable, never repeated.** Each stage asks GitHub what already exists before
   acting, and a stage that reached a good terminal status is never re-entered — so a
   resume can never open a second PR or dispatch a second release for the same version.

## The CI redundancy guard

`release:verify` used to run three times per change: on the PR, on the push to main,
and again inside the release. The `guard` job in `.github/workflows/ci.yml` removes the
middle one, but only when it can *prove* it is redundant — the push is a merge commit,
its tree is byte-identical to the PR head's tree, and a `pull_request` CI run for that
head concluded success. If main moved in between, the trees differ and the full gate
runs. Anything the guard cannot prove, and any API error, leaves the work in place.
