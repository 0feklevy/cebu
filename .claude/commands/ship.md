---
description: Ship the current branch to production in one command — PR, CI, merge, release, production approval, deploy, and audit — streamed live with automatic failure diagnosis.
argument-hint: [patch | minor | major] [--no-deploy] [--no-audit]
---

Ship the current branch. Bump: **$ARGUMENTS** (default `patch` when empty).

Follow the `ship` skill exactly. In short:

1. `pnpm -C podcast-saas ship doctor` — stop and report if anything is red.
2. Start `pnpm ship run --bump <bump>` **in the background**.
3. Attach a persistent `Monitor` running `node podcast-saas/ops/ship/watch.mjs` on this
   run's `ship.ndjson`, so every stage arrives as a notification.
4. When the production gate is reached: notify me, show me the version and the
   migration plan, and **wait for my explicit yes** before `pnpm ship approve`.
5. On any failure: read `SHIP-REPORT.md` and the collected evidence, notify me with one
   actionable line, explain what broke and whether production changed, and propose a
   fix — without editing anything until I approve.

Nothing is approved, deployed, or rolled back without me saying so.
