---
name: ship
description: Take the current branch all the way to production in one go — open the PR, wait for CI, merge, cut the release, hold at the production gate, deploy, and run the production audit — by driving `pnpm ship` and watching its live event stream. Use when the user says "ship it", "push a version", "make a PR and release", "release this", or asks to resume, approve, or explain a shipment already in flight.
---

# Ship — one command from branch to audited release

`podcast-saas/ops/ship` is a conductor: it sequences the existing GitHub workflows and
writes down what happens. It decides nothing about the code. Every pass/fail verdict
still comes from CI, the release gate (`ops/release`), and the production audit — all
of which stay AI-free by design. **Your job is to drive it, watch it, and explain it —
never to overrule it.**

## Run it

Every command below uses `pnpm -C podcast-saas` rather than `cd podcast-saas && pnpm`.
That is deliberate and matters twice: it is the repo's own command rule
(`.claude/reference/stack.md`), and a single uncompounded command is what a
`permissions.allow` rule can actually match — a `cd … && …` chain cannot be
pre-authorised, so it prompts on every shipment.

1. **Check the environment** (fast, changes nothing):

   ```bash
   pnpm -C podcast-saas ship doctor
   ```

   Fix anything red before starting. A dirty working tree, a protected branch, or a
   `gh` token without write access all stop a shipment at stage one anyway.

2. **Pick the bump.** Default to `patch`. Use `minor` for new user-facing capability,
   `major` only when the user says so. Don't ask if `patch` is obviously right.

3. **Start it in the background** — a shipment takes 25–45 minutes, so never run it in
   the foreground:

   ```bash
   pnpm -C podcast-saas ship run --bump patch
   ```

   Use `Bash` with `run_in_background: true`.

4. **Attach the watcher immediately** so every stage arrives as a notification:

   ```bash
   RUN=$(cat .claude/ship/current) && node podcast-saas/ops/ship/watch.mjs ".claude/ship/runs/$RUN/ship.ndjson"
   ```

   Use `Monitor` with `persistent: true`. It replays from the first event and exits by
   itself when the shipment ends, so the watch never outlives the run.

5. **Tell the user it is running**, with the run id and roughly what to expect. Then
   stay available — they can keep working while it goes.

## React to the stream

Events arrive as `HH:MM:SS <mark> [stage] message`. Handle three of them.

### `[approval] production deploy of vX.Y.Z is waiting for your approval`

The release is built, tagged, and drafted; production has not been touched.

1. Send a `PushNotification` — the user has probably walked away.
2. Show them what they are approving: the version, and the migration/gate summary from
   `.claude/ship/runs/$RUN/release/` if it downloaded.
3. **Wait for an explicit yes.** Then, and only then:

   ```bash
   pnpm -C podcast-saas ship approve
   ```

   `pnpm ship deny` rejects it and nothing deploys.

**Never approve on your own initiative, and never pass `--auto-approve`,** unless the
user asks for it in that exact turn. This is the only human gate before production.

### `✗ [stage] …` — something failed

Do all of this without being asked:

1. Read `.claude/ship/runs/$RUN/SHIP-REPORT.md`. It already names the failure kind, the
   failed jobs, the evidence paths, and the recommended actions.
2. Read the evidence — `ci/failed.log`, `release/gate.json`, `release/state.json`,
   `audit/audit-report.md`. The logs are pre-filtered to failed steps only.
3. Send a `PushNotification` with one actionable line, e.g. `deploy blocked: 1 CRITICAL
   in the post-deploy gate — production rolled back`.
4. Explain it in the chat: what broke, what it means for a real user, and whether
   production changed. **Read the verdict precisely:**
   - `BLOCKED` — a gate said no. The pipeline worked. Fix the code.
   - `FAILED` — the pipeline could not produce a trustworthy answer. Fix the pipeline;
     draw no conclusion about production.
   - `audit-error` specifically means production state is **UNKNOWN** — never report it
     as either healthy or broken.
5. Propose a concrete fix and wait for approval before editing anything.

For a deep read of a release or audit, hand off rather than guessing: the
`release-audit` skill, or the `release-auditor`, `migration-auditor`, and
`incident-reporter` agents.

### `run.end` — the shipment finished

`PushNotification` the outcome, then report: version, production audit verdict, and the
report path. On success there is nothing else to do.

## Resuming

The conductor is resumable and every stage is guarded, so a laptop that slept, a
Ctrl-C, or a fixed failure all continue with:

```bash
pnpm -C podcast-saas ship resume
```

It re-attaches to the existing PR and release run rather than creating new ones. After
pushing a fix to the same branch, `resume` re-runs CI from the failed stage onward.

Other read-only commands: `pnpm ship status`, `pnpm ship report`, `pnpm ship status --json`.

## Hard limits

These match the `release-audit` skill and the release engine's own policy:

- **Never** approve production, deploy, roll back, publish a release, apply migrations,
  or run a backfill in apply mode on your own initiative.
- **Never** re-run a red gate hoping for green, and never suggest `--approve-high`,
  `--no-audit`, or editing a check to get past a finding. Propose a real fix plus a
  regression test instead.
- **Never** read `.env` or secret material. The artifacts the conductor collects are
  already redacted; the fleet-guard hook denies it at the tool layer regardless.
- A shipment stopping is information, not an obstacle. Report it plainly.
