---
name: repo-structure-gotchas
description: Non-obvious repo-layout facts that cost real time to rediscover when reviewing podcast-saas types/contracts
metadata:
  type: project
---

Two facts worth checking again (not blindly trusting) before starting the next types-contracts pass
on this repo, since they cost real time to rediscover from scratch.

- **`client-web/` and `admin-web/` have no `src/` directory.** Code lives directly under
  `app/`, `components/`, `lib/`, `hooks/` at the package root (e.g.
  `podcast-saas/client-web/components/SectionEditor.tsx`, not
  `podcast-saas/client-web/src/components/...`). A `grep -r ... client-web/src` silently returns
  zero matches and looks like "no consumer found" instead of "wrong path" — this produced a false
  "avatar routes have zero frontend consumers" conclusion mid-review before the path was fixed.
  Always grep `client-web/app client-web/components client-web/lib client-web/hooks` (and the
  admin-web equivalents) explicitly, and exclude `.next/` (webpack bundles under `.next/server/`
  contain stringified source and will produce huge false-positive matches for any grep across the
  package root).

- **The backend<->frontend contract is NOT just `shared/src/generated/{client,admin}-v1.ts`.**
  There are at least three more hand-written, unvalidated fetch clients living outside `shared/`:
  `client-web/components/avatar/avatarApi.ts`, `client-web/lib/courseApi.ts`, and
  `admin-web/lib/avatarAdminApi.ts`. A route with no method in `client-v1.ts`/`admin-v1.ts` is
  **not** automatically drift — check these three files (and a raw `fetch(` grep in the relevant
  component) before concluding a route is orphaned. See [[flowvid-types-contracts-findings-summary]]
  for what was already found this way (avatar and project-share routes both turned out to be
  intentionally hand-fetched, not drift; courses.controller.ts turned out to be genuinely orphaned
  everywhere, including these three files).

- As of commit `2d187e3` (2026-08-15 review), an exhaustive method-by-method diff of every
  `client-v1.ts`/`admin-v1.ts` method against its backend route found **zero confirmed
  "guaranteed-404" drift** — every path/method/param-count matched. The real cost in this codebase
  is response-*shape* drift (a TS type that no longer matches what the server writes, e.g. `SimMeta`)
  and dead/duplicated contract surface, not missing routes. Don't assume that's still true on a
  future pass — re-verify — but it means starting future reviews by hunting for shape drift and
  duplicated hand-written types is probably higher-yield than another full route/method sweep,
  unless `git diff` shows controller changes since this commit.
