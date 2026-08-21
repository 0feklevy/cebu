---
name: no-invented-prod-numbers
description: Never state a production volume/size/count that was not measured; say which query would produce it and mark it UNMEASURED
metadata:
  type: feedback
---

Never produce a production quantity ("this saves ~40GB", "the heaviest projects are…", a
percentage) unless it came from a measurement the user can point at. If a number needs
production data, name the exact query or bucket LIST that would produce it and mark it
**UNMEASURED**.

**Why:** the user's brief for the storage/DB volume audit called a fabricated estimate
"the single worst possible output here". Reviewers have no production access at all — no
psql, no DATABASE_URL, no Supabase S3, no SSH, no `supabase` CLI — so any number that looks
measured is necessarily invented, and an invented number gets acted on.

**How to apply:** in any volume, cost, or capacity finding, split the claim in two — the
*mechanism* (verifiable statically, cite `file:line`) and the *magnitude* (BLOCKED-ON-CENSUS
until the owner runs the read-only census). Rank by (certainty it is safe) × (likely volume)
and say plainly which half of each pair is unmeasured.

Related: [[storage-volume-audit-context]]
