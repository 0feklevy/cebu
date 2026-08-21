---
name: flowvid-decisions-process
description: how FlowVid tracks "what's open" — DECISIONS.md as the live ledger, dated CODEX-DECISION-RESPONSE docs as frozen rulings, the audit ledger jsonl, and the merge-authorization boundary
metadata:
  type: project
---

**Where the truth lives.** `.claude/review/DECISIONS.md` is the single current-status ledger
(sections: 🔴 blocked-on-owner, 🟠 standing constraints, 🟡 backlog, 🔵 parked feature requests
awaiting approval, ⚪ accepted risks). `.claude/review/CODEX-DECISION-RESPONSE-YYYY-MM-DD.md` files
are point-in-time rulings documents — written once, referenced from `DECISIONS.md`, and NOT kept
live afterward (e.g. the 2026-08-21 one still says "Do NOT cut v0.1.36 yet" even after it shipped —
that's expected, it's a historical record of a ruling that was later executed). Round-map style
sections (e.g. "P3-F") sequence backlog work into lettered rounds (A ship / B evidence / C code /
D surfaces) — check `DECISIONS.md`'s current top section before trusting an old round map, since
owner decisions (e.g. descoping a planned round) land as edits to `DECISIONS.md`, not to the codex.

**Status updates land as small docs-only PRs.** e.g. PR #48 `docs(decisions): v0.1.36 is live —
close what shipped, correct what went stale`. The CI redundancy guard skips heavy lanes
(release-verify, e2e chromium/firefox/webkit) on docs-only diffs, so these PRs go green fast on
just "Redundancy guard" + "Static audits."

**Merge-authorization boundary (R-12, `autoMode.allow`).** Covers `gh pr merge` when required
checks pass, plus branch bookkeeping. Explicitly does NOT cover: `--admin`/`--bypass` merges,
dispatching `release.yml` (production deploy), anything touching the VM/Supabase/live API keys, or
editing the permission file itself.

**The audit ledger** is `.audit-ledger/ledger.jsonl` (334 entries as of 2026-08-21), one JSON object
per finding, key field `currentDisposition`: `OPEN` (235), `FIXED_SELF_VERIFIED` (66),
`OUT_OF_SCOPE_BILLING` (24, incl. two P1s: `billing-001`, `test-quality-002`),
`BLOCKED_DECIDED_NOT_IMPLEMENTED` (1: `broll-data-001`), `OPEN_AUDIT_BLOCKER` (3),
`REFUTED`/`LIKELY_REFUTED` (5). "OPEN" items have never been adversarially verified — only
self-verified by whoever proposed the fix, per the `residualRisk` field's recurring caveat.

See also [[flowvid-billing-review-descoped]] and [[reverify-live-state-before-flagging-stale]].
