# Memory Index

- [Re-verify live state before flagging stale](feedback_reverify-live-state-before-flagging-stale.md) — this repo changes concurrently during an audit; check for open PRs before reporting a gap; poll pending CI checks to completion before a SHIP call
- [FlowVid decisions/ledger process](project_flowvid-decisions-process.md) — DECISIONS.md vs frozen CODEX docs, docs-PR update pattern, merge-authorization boundary, ledger.jsonl schema
- [FlowVid billing review descoped](project_flowvid-billing-review-descoped.md) — owner cancelled the planned billing round 2026-08-21; don't propose it unattended
- [Concrete 2026-08-22 audit gaps](project_flowvid-2026-08-22-audit-gaps.md) — job-queue-014 CI wiring gap, job-queue-015 still open, a11y/crop staleness in DECISIONS.md
- [FlowVid secret-file guard mechanism](project_flowvid-secret-file-guard.md) — secret-*.txt is ignored by BOTH tracked .gitignore:47 and local .git/info/exclude; check-ignore matches .gitignore
- [Concrete 2026-08-26 audit gaps](project_flowvid-2026-08-26-audit-gaps.md) — gallery merged into wrong base branch, unwired sim-authoring Playwright spec, 3 stale DECISIONS.md headers
