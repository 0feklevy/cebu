---
name: release-audit
description: Explain a FlowVid release run, rollback, or production audit from its deterministic JSON reports. Use when the user asks "what happened to the release", "why did the release fail/block", "explain the audit findings", or points at a release-artifacts directory / release-report.json. Read-only — never deploys, approves, applies backfills, or bypasses checks.
---

# Release audit — explain deterministic release reports

The release autopilot (GitHub Actions + `ops/release`) already decided everything
deterministically. This skill is for EXPLAINING its outputs, never for overriding them.

## Steps

1. **Locate artifacts.** Ask for (or find) the `release-artifacts/` directory or the
   individual files: `release-report.json`, `gate.json`, `state.json`,
   `image-manifest.json`, `vm-audit.json`, `browser-audit.json`, `csp-*.json`,
   `migration-audit.json`, `db-url-audit.json`. If only a workflow run URL exists,
   tell the user to download the `release-report` / `release-artifacts` artifact.
   To produce fresh LOCAL artifacts without touching production, run:
   `pnpm --filter ops-release release-cli dry-run --out-dir /tmp/flowvid-dryrun`
   (offline; live read-only checks are `csp-audit` and `endpoint-audit`).

2. **Establish the verdict.** From `state.json` (final state + history = exactly where
   it stopped) and `gate.json` (blocked?, shouldRollback?, counts, reasons).

3. **Explain findings most-severe-first.** For each CRITICAL/HIGH: what it means for a
   real user, which artifact/field proves it, and its remediation field. Severity
   policy lives in `ops/release/src/severity.ts` (CRITICAL always blocks + rolls back
   post-deploy; HIGH blocks unless `approve_high`; WARNING reports).

4. **Recommend next actions** — exact workflow + inputs (e.g. "fix X, merge to main,
   re-run Release FlowVid with bump=patch; the failed run's tag was consumed, the next
   run computes the following patch version"). For complex cases delegate to the
   subagents: `release-auditor` (overall), `migration-auditor` (SQL), and
   `incident-reporter` (write-up).

## Hard limits (same as the subagents)

- Never deploy, roll back production, approve environments, create/publish releases,
  apply migrations, or run backfills in `--apply` mode.
- Never read `.env` / `.env.*` or secrets; artifacts are pre-redacted.
- Never suggest weakening a check or whitelisting a finding to turn the gate green —
  propose a real fix plus a regression test instead.
