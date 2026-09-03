# Memory Index

- [Re-verify live state before flagging stale](feedback_reverify-live-state-before-flagging-stale.md) — this repo changes concurrently during an audit; check for open PRs before reporting a gap; poll pending CI checks to completion before a SHIP call
- [FlowVid decisions/ledger process](project_flowvid-decisions-process.md) — DECISIONS.md vs frozen CODEX docs, docs-PR update pattern, merge-authorization boundary, ledger.jsonl schema
- [FlowVid billing review descoped](project_flowvid-billing-review-descoped.md) — owner cancelled the planned billing round 2026-08-21; don't propose it unattended
- [Concrete 2026-08-22 audit gaps](project_flowvid-2026-08-22-audit-gaps.md) — job-queue-014 CI wiring gap, job-queue-015 still open, a11y/crop staleness in DECISIONS.md
- [FlowVid secret-file guard mechanism](project_flowvid-secret-file-guard.md) — secret-*.txt is ignored by BOTH tracked .gitignore:47 and local .git/info/exclude; check-ignore matches .gitignore
- [Concrete 2026-08-26 audit gaps](project_flowvid-2026-08-26-audit-gaps.md) — supersedes earlier same-day note (those gaps now fixed); PR #151 missing from ledger, stale header, SMOKE_PUBLIC_PATH unset, stuck v0.2.11 release run
- [PR #167 podcast car-mode audit](project_flowvid-2026-09-03-podcast-car-mode-audit.md) — 2 real CI gaps found + fixed + merged live mid-audit; CarModePlayer.tsx/vad.ts still never created, still no route-level test
- [PR #168 help-coverage audit — CLOSED](project_flowvid-2026-09-03-help-coverage-audit.md) — all 3 gaps fixed by PR #171 (4c93336), re-verified by mutation 2026-09-03; also closes the §6/PR #169 poster-route-test and lint gaps
- [PRs #174/#175 deploy-retention + listener-inbox audit — CLOSED](project_flowvid-2026-09-03-deploy-retention-and-listener-inbox-audit.md) — both merged clean; one live CI-race fixed mid-audit (raiseHand.test.tsx vs new replies fetch)
