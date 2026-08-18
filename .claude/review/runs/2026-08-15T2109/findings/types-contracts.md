# Types & Contracts Review — FlowVid

Domain: TypeScript type safety plus the backend<->frontend API contract
(`podcast-saas/shared/**`, the hand-maintained `generated/client-v1.ts` / `admin-v1.ts`, and the
seams where Fastify route responses meet the client methods and frontend call sites).

## Method

- Read `podcast-saas/shared/src/generated/client-v1.ts` (1667 lines) and `admin-v1.ts` (272 lines)
  in full.
- Built a route inventory from every `app.(get|post|put|patch|delete)` call across
  `podcast-saas/backend-api/src/controllers/v1/**` and `.../admin/v1/**` (~230 routes) via targeted
  `grep`/`Read`, then diffed method-by-method against `client-v1.ts` / `admin-v1.ts`.
- For every client method or route with no obvious counterpart, grepped
  `podcast-saas/client-web/**` and `podcast-saas/admin-web/**` for a hand-rolled `fetch` call before
  concluding drift (per the "check both sides" instruction) — several apparent gaps turned out to be
  intentional hand-rolled clients (`client-web/components/avatar/avatarApi.ts`,
  `client-web/lib/courseApi.ts`, `admin-web/lib/avatarAdminApi.ts`), which were then diffed against
  their controllers too.
- Read all four `tsconfig.json` files (+ `tsconfig.base.json`) and confirmed `pnpm -r typecheck`
  passes per the orchestrator's baseline (not re-run; treated as ground truth per PROTOCOL §6).
- Read every file under `podcast-saas/shared/src/types/**` and spot-checked `sim/**` for zod-vs-type
  agreement.

## Scope covered

Full route inventory diffed for `v1/*.controller.ts` (27 files, ~200 routes) and `admin/v1/*` (7
files, ~25 routes) against `client-v1.ts`/`admin-v1.ts`. All of `shared/src/types/**` read.
`shared/src/csp.ts` read (clean; no type-contract issue, flagged nothing — this file is almost pure
string-parsing logic with no external contract surface). `shared/src/sim/**` spot-checked
(`runtimeProtocol.ts` in depth — its `as unknown as AnySimEnvelope` cast at the end of
`validateEnvelope` is preceded by exhaustive field-by-field checks, i.e. exactly the "cast on data
you just validated" case the brief says not to flag). Did **not** exhaustively re-read every
`sim/__tests__` file or every controller line-by-line (230 routes is a lot); the ones read in depth
were chosen because they were the shared-client's biggest/most-referenced surfaces (projects,
sections, export, branch, podcast studio, admin settings) or because grep flagged an anomaly
(courses, avatar's `Record<string, unknown>` bodies).

**Headline result**: no confirmed "client calls a route that returns 404" drift was found — the
23 controllers that back `client-v1.ts` methods matched on path, method, and param count in every
case checked. That is worth stating plainly since it contradicts the "guaranteed 404" scenario the
brief primes for; the real cost in this codebase is a different, quieter class of drift: response
**shapes** that no longer match their declared TS type, and a second, third and fourth hand-written
client (`avatarApi.ts`, `avatarAdminApi.ts`, `courseApi.ts`) that exist entirely outside `shared/`
and are invisible to anyone auditing only `generated/`.

---

### [P2] `SimMeta`'s exported shape has nothing to do with what the server actually writes — frontend already routes around it with unsafe casts
- id: types-001
- location: podcast-saas/shared/src/generated/client-v1.ts:500
- category: types
- confidence: high
- status: confirmed
- what: `SimMeta` (exported from the hand-maintained client, imported by `client-web` as the type of
  `TimelineSection.sim_meta`) declares a fixed, all-required shape: `targetControlId`, `confidence:
  number`, `warnings: string[]`, `hideControlIds: string[]`, `hideButtonIds: string[]`,
  `hideSelectorStrings: string[]`, `animation: {...} | null`, `planVersion: string`. The actual
  object the server writes into the `sim_meta` jsonb column (the "planVersion '7'" shape, per the
  controller's own comment) is a completely different object: `{planVersion, generatedBy, prompt,
  uiControls, sourceHash, bridgeHash, generatedAt, provider, model, confidence, confidenceLevel,
  contextTruncated, retryCount, retryReason, warnings, validationErrors, validationWarnings,
  supportsRuntimeParams, runtimeValidated, conversationHistory}` on the LLM path, or a narrower
  `{planVersion, generatedBy, uiControls, bridgeHash, generatedAt, supportsRuntimeParams}` on the
  mechanical/reuse path. Neither write site ever sets `targetControlId`, `hideControlIds`,
  `hideButtonIds`, `hideSelectorStrings`, or `animation` — the five fields `SimMeta` claims are
  guaranteed. `confidence` and `warnings` are only set on the LLM path, not the mechanical path, so
  even those two are not actually always-present despite the type saying `number`/`string[]`.
- why: Any new consumer of `TimelineSection.sim_meta` that trusts the exported type (e.g.
  `section.sim_meta.confidence * 100` without a guard, or `section.sim_meta.hideControlIds.map(...)`)
  will get `undefined` behaving as a `number`/array today, or a hard TypeError the next time someone
  removes what looks like a redundant runtime guard because "the type already says it's there." The
  frontend has already discovered this the hard way: the only place `SimMeta` is applied to real data
  re-casts it (`as SimMeta | null | undefined`, widening beyond the already-declared
  `TimelineSection.sim_meta: SimMeta | null`) and then immediately abandons the type entirely in
  favour of `as unknown as Record<string, unknown>` plus per-field `as string | undefined` /
  `?? []` handling, with a comment literally documenting the drift: "Render any/all sim_meta fields
  safely — handles both old BridgePlan shape and new Phase 4 shape."
- evidence: Type at `podcast-saas/shared/src/generated/client-v1.ts:500-517`. Write sites at
  `podcast-saas/backend-api/src/controllers/v1/sections.controller.ts:514-522` (mechanical/reuse) and
  `:575-596` (LLM path) — read the full `generateOrReuseSection` function (lines 448-601) to confirm
  these are the only two places `sim_meta` is persisted for this flow. Frontend workaround at
  `podcast-saas/client-web/components/SectionEditor.tsx:1229` (`const simMeta = section.sim_meta as
  SimMeta | null | undefined ?? null;`) and `:2097-2107` (the `as unknown as Record<string, unknown>`
  block with the "handles both old BridgePlan shape and new Phase 4 shape" comment).
- fix: Either (a) make `SimMeta` in `client-v1.ts` match reality — a loose type with every field
  optional and no assumed keys beyond `planVersion`, mirroring what `sections.controller.ts` actually
  writes, and add a small `parseSimMeta(raw: unknown)` helper in `shared/` that both the controller's
  read paths and `SectionEditor.tsx` call instead of hand-casting; or (b) if `targetControlId` /
  `hideControlIds` / etc. are meant to come back one day (Minimal-UI plan), rename the current
  interface to something like `SimGenerationMeta` so `TimelineSection.sim_meta`'s declared type
  stops promising fields no writer produces. Either way, delete the now-redundant `as unknown as
  Record<string, unknown>` cast in `SectionEditor.tsx` once the type is honest.
- effort: M

---

### [P2] `courses.controller.ts` — a full, zod-validated course-authoring API with zero consumers anywhere in the codebase
- id: types-002
- location: podcast-saas/backend-api/src/controllers/v1/courses.controller.ts:29
- category: maintainability
- confidence: high
- status: confirmed
- what: `registerCourseAuthoringRoutes` registers 15 routes (`POST /api/v1/courses`, `PATCH
  /api/v1/courses/:id`, `.../seo`, `.../slug`, `.../lessons`, `PATCH|DELETE
  /api/v1/course-lessons/:lessonId`, `.../reorder`, `.../readiness`, `.../publish`, `.../unpublish`,
  `.../unlist`, `.../archive`, `.../restore`), all wired up in `server.ts`, all backed by real zod
  schemas in `shared/src/types/course.ts` (`CourseSchema`, `CourseLessonSchema`,
  `ArchiveDispositionSchema`, etc.). Neither `shared/src/generated/client-v1.ts` nor any file under
  `client-web/` or `admin-web/` references `/api/v1/courses`, `/api/v1/course-lessons`, or any of
  `CourseSchema`/`CourseLessonSchema`/`PublishStateSchema`/`CourseKindSchema` outside
  `shared/src/types/course.ts` itself.
- why: This is a live, authenticated write surface (create/publish/archive courses) with no
  reachable UI and no client bindings anywhere — either a half-shipped feature that a future
  developer will assume is dead and delete along with its (working, tested-looking) validation, or
  a feature someone believes is live because the backend is fully built, when it is entirely
  unreachable from the product. Either reading is a maintenance trap; per the review brief this is
  exactly the "dead contract infrastructure" class ("a route with no client method... makes future
  readers believe a safety net exists" — here inverted: a whole feature exists with nothing
  believing in it).
- evidence: Route list extracted via `grep -rnoE "'/api/(v1|admin/v1)[^']*'"` across all controllers
  — courses routes at `podcast-saas/backend-api/src/controllers/v1/courses.controller.ts:30,41,50,
  53,56,61,64,67,70,74,78,80,81,83,85`. Registration confirmed at
  `podcast-saas/backend-api/src/server.ts:67` (`registerCourseAuthoringRoutes`). Zero hits for
  `grep -rn "api/v1/courses\|course-lessons\|CourseAuthoring"` across `client-web/` and `admin-web/`
  (excluding `.next/` build output). The *read* side (`public-courses.controller.ts` +
  `client-web/lib/courseApi.ts`) is fully wired — only the authoring/write side is orphaned.
- fix: If the authoring UI is planned but not yet built, say so in a comment at the top of
  `courses.controller.ts` (mirroring the "SHIPS DARK until Phase 2" pattern already used in
  `export.controller.ts:28-33`) so the next reviewer doesn't have to rediscover this. If it is truly
  abandoned, delete the routes and the now-unused half of `course.ts`'s zod schemas, or move them to
  `_archive/`.
- effort: S (documentation) / M (removal)

---

### [P2] `CourseViewSchema` / `LessonViewSchema` exist specifically to validate this boundary and are never called — the actual fetch uses an unchecked cast
- id: types-003
- location: podcast-saas/client-web/lib/courseApi.ts:27
- category: types
- confidence: high
- status: confirmed
- what: `shared/src/types/course-view.ts` defines `CourseViewSchema` and `LessonViewSchema` (zod),
  with a comment explaining exactly why: "The backend computes these... so the Next routes stay
  thin." `getPage<T>()` in `courseApi.ts` fetches from the backend and does
  `(await res.json()) as T` — a raw, unvalidated cast — for both `CourseView` and `LessonView`. The
  two zod schemas that exist for this exact purpose are never imported or called anywhere in the
  repository.
- why: This is a real network boundary (backend response → Next.js Server Component render), and
  the SEO/course-view feature is public-facing (renders `/c/[courseSlug]` pages, sitemaps, and OG
  images). A backend change that drops a field or changes its type would type-check on both sides
  (the cast hides it) and fail at render/JSON-LD-serialization time instead of at the fetch — exactly
  the "runtime/type mismatch... a bad payload throws far from its source" case zod is supposed to
  prevent here, and the schema to prevent it is sitting unused three files away.
- evidence: Schemas at `podcast-saas/shared/src/types/course-view.ts:49` (`CourseViewSchema`) and
  `:79` (`LessonViewSchema`). Cast at `podcast-saas/client-web/lib/courseApi.ts:27`
  (`return { status: 'ok', data: (await res.json()) as T };`, called from `getCoursePage`/
  `getLessonPage` at lines 36-45). `grep -rn "CourseViewSchema\|LessonViewSchema"` across the whole
  repo (excluding `node_modules`/`.next`) returns only the three definition lines in
  `course-view.ts` itself.
- fix: In `getPage<T>()`, accept the zod schema as a parameter (`getPage<T>(path, tags, schema:
  z.ZodType<T>)`) and `schema.parse(json)` instead of `as T`; a parse failure should log and fall
  through to the existing `not_found` path rather than serving a page built from malformed data.
- effort: S

---

### [P2] The `generated/` directory name, `tsoa.json`, and the root `generate` script together describe a codegen pipeline that has never existed
- id: types-004
- location: podcast-saas/package.json:19
- category: fleet
- confidence: high
- status: confirmed
- what: Root `package.json:19` defines `"generate": "pnpm --filter backend-api generate && pnpm
  --filter shared build"`. `backend-api/package.json`'s `scripts` block (lines 7-28) has no
  `generate` entry — `pnpm generate` from the repo root fails immediately with "Missing script"
  before it ever reaches the `shared build` half. `backend-api/tsoa.json` configures a full
  OpenAPI-from-controllers pipeline (`entryFile: src/server.ts`, `controllerPathGlobs:
  ["src/controllers/**/*.controller.ts"]`, `spec.outputDirectory: "src/generated"`), and `tsoa` is a
  real dependency (`backend-api/package.json:52`), but nothing in `backend-api/src` imports `tsoa`
  (`grep -rln "from 'tsoa'" backend-api/src` returns nothing), no controller uses tsoa's
  `@Route`/`@Get` decorators (they're all plain `app.get(...)` Fastify calls), and
  `backend-api/src/generated/` — the directory `tsoa.json` would write to — does not exist on disk.
  Meanwhile `shared/src/generated/client-v1.ts` and `admin-v1.ts`, which the fleet-wide `stack.md`
  already flags as hand-maintained, are the only "generated" output that actually exists, and they
  are hand-written.
- why: This is the load-bearing fact for every other finding in this file: there is no build step
  anywhere that would catch a controller route rename, a removed field, or a changed HTTP method
  before it reaches `client-v1.ts` consumers at runtime. A developer who finds `tsoa.json` and a
  `generated/` folder and doesn't check both could reasonably (and wrongly) assume such a check
  exists. Filed per the task brief's explicit instruction to report this as its own finding, with the
  exact evidence trail rather than restating `stack.md`'s summary.
- evidence: `podcast-saas/package.json:19`; `podcast-saas/backend-api/package.json:7-28` (no
  `generate` key); `podcast-saas/backend-api/tsoa.json:1-9`; `grep -rln "from 'tsoa'"
  podcast-saas/backend-api/src` → no results; `ls podcast-saas/backend-api/src/generated` →
  "No such file or directory".
- fix: Either build the pipeline (wire tsoa or an equivalent OpenAPI generator into a real
  `backend-api` `generate` script, regenerate `client-v1.ts`/`admin-v1.ts` from it, and add a CI
  check that fails on drift) or remove the fiction: delete `tsoa.json`, drop the `tsoa` dependency,
  rename `shared/src/generated/` to `shared/src/api-clients/` (or similar) so the name stops implying
  a safety net, and fix/remove the root `generate` script.
- effort: S (remove the fiction) / L (build the real pipeline)

---

### [P2] Branch edge PATCH accepts `Record<string, unknown>` with no value-level validation, unlike every sibling branch endpoint
- id: types-005
- location: podcast-saas/backend-api/src/controllers/v1/branch.controller.ts:387
- category: types
- confidence: high
- status: confirmed
- what: The client's `updateBranchEdge` is precisely typed:
  `body: Partial<Omit<BranchEdge, 'id' | 'project_id' | 'created_at'>>`
  (`podcast-saas/shared/src/generated/client-v1.ts:1199`). The server route it calls,
  `PATCH /api/v1/projects/:id/branch/edges/:eid`, declares `Body: Record<string, unknown>`
  (`branch.controller.ts:387`) and validates only `destination_type` (checked against an allow-list
  of strings, `:399-401`); every other whitelisted key (`sort_order`, `trigger_match`, `dest_url`,
  etc.) is copied from the raw body straight into the Drizzle `.set(patch)` with **no type check at
  all** — `sort_order` could be a string, `trigger_match` could be a number, and the write would only
  fail (or silently coerce) at the Postgres driver. Contrast this with the immediately preceding
  routes in the same file: `updateBranchSequence`'s route uses `Body: Partial<{ label: string;
  is_entry: boolean; sort_order: number; ... }>` (`:182`) and `updateChoicePoint`'s route uses a
  similarly typed `Partial<{...}>` (`:288`) — both at least document (if not runtime-enforce) the
  expected value types; only the edges route degrades to `Record<string, unknown>`.
- why: This is the "weak shapes... index signatures that hide typos" and "runtime/type mismatch"
  categories directly: the server's own Fastify generic type asserts nothing useful, so a bug in any
  future caller (or a hand-crafted request from outside `client-v1.ts`) that sends
  `{ sort_order: "3" }` type-checks at the route boundary and is only caught (if at all) by whatever
  Postgres does with a text value against an integer column via Drizzle.
- evidence: Read `podcast-saas/backend-api/src/controllers/v1/branch.controller.ts:387-411` in full;
  compared against `:182-208` (`updateBranchSequence`, typed) and `:288-314`
  (`updateChoicePoint`, typed). Client method at
  `podcast-saas/shared/src/generated/client-v1.ts:1199-1201`.
- fix: Replace the hand-rolled allow-list with a zod schema mirroring
  `Partial<Omit<BranchEdge, 'id' | 'project_id' | 'created_at'>>` (the shape the client already
  promises), `safeParse` it, and 400 on failure — the same pattern already used two routes up the
  file (`createBranchEdge`'s `DESTINATION_TYPES` check plus the sibling PATCH routes' typed bodies).
- effort: S

---

### [P2] `AvatarPersonaConfig` is defined independently on the server and in `client-web` (not in `shared/`) and the two copies have already diverged
- id: types-006
- location: podcast-saas/backend-api/src/services/avatar/anamService.ts:84
- category: types
- confidence: high
- status: confirmed
- what: The persisted avatar persona config (`projects.avatar_config`, a jsonb column) has two
  independently hand-written TypeScript interfaces, neither living in `shared/`:
  `AvatarPersonaConfig` in `backend-api/src/services/avatar/anamService.ts:84-108` (23 fields) and a
  second `AvatarPersonaConfig` in `client-web/components/avatar/avatarApi.ts:73-96` (used by
  `getAvatarConfig`/`saveAvatarConfig`, which round-trip this exact object to
  `PUT /api/v1/projects/:id/avatar/config`). The server copy has two fields the client copy lacks
  entirely: `avatarCircles?: AvatarCirclesConfig` and `transcriptDocId?: string`. Every other field
  name matches today, but there is nothing that would catch the next field the server adds from
  silently disappearing from the client's type (and therefore from `saveAvatarConfig`'s payload,
  since a field not in the type can't be set by TS-checked call sites, though it *would* still be
  echoed back by `getAvatarConfig` and land in a variable whose type doesn't admit it).
- why: This is the same class of risk as the `shared/generated` clients being hand-maintained, except
  worse: this contract isn't routed through `shared/` at all, so it isn't even visible to someone
  auditing "the client." Two people can edit either copy without the other noticing, and the two
  already disagree.
- evidence: `podcast-saas/backend-api/src/services/avatar/anamService.ts:84-108` vs
  `podcast-saas/client-web/components/avatar/avatarApi.ts:73-96` — read both in full and diffed field
  by field; `avatarCircles` and `transcriptDocId` appear only in the server copy. Both are imported
  by name (`import { type AvatarPersonaConfig } from ...`) at
  `podcast-saas/backend-api/src/controllers/v1/avatar.controller.ts:30` and
  `podcast-saas/backend-api/src/services/transcriptPropagation.ts:28`, confirming the server-side
  interface is the one actually read/written by the persistence and transcript-injection code paths.
- fix: Move `AvatarPersonaConfig` into `shared/src/types/`, export it once, and have both
  `anamService.ts` and `avatarApi.ts` import it. If `avatarCircles`/`transcriptDocId` are
  intentionally server-internal (never meant to round-trip through the client form), say so with a
  comment and consider an `Omit<>` on the client side so the exclusion is explicit instead of
  accidental.
- effort: S

---

### [P3] `ApiErrorSchema` / `ApiError` — a structured error envelope no endpoint ever returns
- id: types-007
- location: podcast-saas/shared/src/types/errors.ts:13
- category: maintainability
- confidence: high
- status: confirmed
- what: `errors.ts` exports `ApiErrorSchema = z.object({ error_type: z.nativeEnum(LLMErrorType),
  message: z.string(), details: z.record(z.unknown()).optional() })` and `type ApiError`. Every real
  error response observed across `v1/*.controller.ts` and `admin/v1/*.controller.ts` during this
  review is an ad hoc `{ message: string }` (occasionally with extra one-off fields like `code`,
  `current_rev`, `redirectUrl`) — none carries `error_type`. `grep -rln "ApiErrorSchema\b"` across the
  whole repo returns only the definition file itself; `grep -rn "\bApiError\b"` (excluding
  `errors.ts`) returns nothing.
- why: Low risk (nothing consumes it, so nothing can be broken by trusting it) but it is exactly the
  "dead contract infrastructure" pattern the review is hunting for — a reader who finds this and
  writes new error-handling code against it will produce a client that expects a shape the server has
  never sent.
- evidence: `podcast-saas/shared/src/types/errors.ts:13-18`; grepped for consumers repo-wide
  (excluding `node_modules`/`.next`), zero hits outside the definition file.
- fix: Delete `ApiErrorSchema`/`ApiError` if there's no near-term plan to standardize error
  responses, or adopt it in the Fastify error handler (a single `setErrorHandler` that always emits
  this shape) and update `ClientV1Api.request`'s error branch to parse it instead of the current
  ad hoc `{ message?: string }`.
- effort: S

---

### [P3] `POST /api/v1/projects/:id/videos/:videoId/retranscode` has no caller anywhere
- id: types-008
- location: podcast-saas/backend-api/src/controllers/v1/video.controller.ts:521
- category: maintainability
- confidence: medium
- status: confirmed
- what: The route is registered and implemented, but there is no method for it in `client-v1.ts` and
  no direct `fetch` to `retranscode` anywhere in `client-web/` or `admin-web/`
  (`grep -rn "retranscode" client-web admin-web shared` — zero hits).
- why: Either genuinely dead (safe to remove) or a manual-ops escape hatch meant to be called via
  `curl`/Postman rather than the UI — worth a one-line comment either way so the next contract audit
  doesn't have to re-derive this.
- evidence: Route at `podcast-saas/backend-api/src/controllers/v1/video.controller.ts:521`; grep
  across `client-web`, `admin-web`, `shared` for `retranscode` returns nothing.
- fix: Add a comment noting the intended caller (ops script / admin action / none), or remove the
  route and its handler if it's confirmed dead.
- effort: S

---

### [P3] No package enables `noUncheckedIndexedAccess`, despite pervasive `Record`/array indexing
- id: types-009
- location: podcast-saas/tsconfig.base.json:1
- category: types
- confidence: medium
- status: confirmed
- what: `tsconfig.base.json` (extended by `backend-api` and `shared`) and the standalone
  `client-web/tsconfig.json` / `admin-web/tsconfig.json` all set `strict: true` but none sets
  `noUncheckedIndexedAccess` or `exactOptionalPropertyTypes`. This is consistent across all four
  packages (not a cross-package inconsistency), but the codebase's own patterns show the risk is
  real: aggregate query results are routinely read as `total[0]?.c ?? 0`
  (`admin/v1/avatar.controller.ts:62-67`) and `Record<string, T>` lookups (`by_type`,
  `edge_choice_counts`, `by_provider`, etc. throughout `admin-v1.ts` and `client-v1.ts`) are typed as
  always returning `T`, never `T | undefined`, even though a missing key is exactly as likely as a
  present one for these maps.
- why: Every one of those `Record<string, T>` reads in the exported client types (`UsageRollup.
  by_provider`, `BranchAnalytics.edge_choice_counts`, `PipelineStats.*`) currently type-checks
  `record[someKey].whatever` with no null check, and will throw at the first key that turns out to be
  absent. The `?? 0` defensive style seen in a few backend call sites shows the team already knows
  this pattern is risky; the compiler flag would make it enforced instead of a matter of habit.
- evidence: `podcast-saas/tsconfig.base.json` (no `noUncheckedIndexedAccess`);
  `podcast-saas/client-web/tsconfig.json` and `podcast-saas/admin-web/tsconfig.json` (same, and they
  don't even extend the base config — each restates `strict: true` independently); representative
  `Record<string, T>` return types at
  `podcast-saas/shared/src/generated/admin-v1.ts:86-88` (`UsageRollup`) and
  `podcast-saas/shared/src/generated/client-v1.ts:766-767` (`BranchAnalytics`).
- fix: Turn on `noUncheckedIndexedAccess` in `tsconfig.base.json` and both frontend tsconfigs, then
  fix the (likely non-trivial but mechanical) fallout in one PR per package. If that's too big a
  bang, start with `shared/` alone since its types are the ones every consumer trusts.
- effort: L (fixing the fallout) / S (flipping the flag and measuring the blast radius first)

---

### [P3] `ProjectHeader.tsx` casts the share-token response with no validation, at a boundary the shared client doesn't cover
- id: types-010
- location: podcast-saas/client-web/components/ProjectHeader.tsx:70
- category: types
- confidence: medium
- status: confirmed
- what: `GET /api/v1/projects/:id/share` (implemented in
  `podcast-saas/backend-api/src/controllers/v1/share.controller.ts:53-70`) has no method in
  `client-v1.ts` — unlike the equivalent playlist endpoints, which do
  (`getPlaylistShare`/`createPlaylistShare`/`revokePlaylistShare`,
  `client-v1.ts:1425-1435`). `ProjectHeader.tsx` calls it directly with `fetch` and does
  `const d = await r.json() as { shareToken?: string | null };` — an inline, unvalidated cast
  duplicating (loosely) the shape the playlist share methods already model in the shared client.
- why: Not drift (the frontend does call the real route — this is the "route with no client method
  but the frontend calls it by hand" case the brief says is *not* a bug on its own), but it's a
  second instance of the pattern in finding types-006: a hand-rolled type at a network boundary that
  exists nowhere else and isn't validated, for a feature whose sibling (playlists) gets the properly
  typed treatment. The asymmetry is itself worth fixing since it means the project-share and
  playlist-share code paths will drift from each other over time for no functional reason.
- evidence: `podcast-saas/client-web/components/ProjectHeader.tsx:66-71`; absence of a project-share
  method confirmed by reading all of `client-v1.ts`'s "Collaboration"/sharing-related methods
  (lines 1344-1471) — only playlist share/permalink methods are present.
  `podcast-saas/backend-api/src/controllers/v1/share.controller.ts:53-70` is the route being called.
- fix: Add `getProjectShare`/`createProjectShare`/`revokeProjectShare` to `ClientV1Api`, mirroring
  the existing playlist methods, and switch `ProjectHeader.tsx` to use them.
- effort: S

---

### [P3] `ViewerPage.tsx` models a discriminated server response as an unsafe intersection type
- id: types-011
- location: podcast-saas/client-web/components/viewer/ViewerPage.tsx:41
- category: types
- confidence: medium
- status: confirmed
- what: `GET /api/v1/projects/:id/player-config` returns *either* a full player config (with a
  required `segments` array) *or* a `LockedContent` paywall stub (`{ locked: true, content_type,
  content_id, title, price_cents, currency }`, no `segments` field at all) — a true discriminated
  union on `locked`. `ViewerPage.tsx:41` types the parsed response as
  `PlayerConfig & Partial<LockedContent>` and casts with `as`: `const data = (await r.json()) as
  PlayerConfig & Partial<LockedContent>;`. That intersection asserts the object always satisfies the
  full `PlayerConfig` shape (including required `segments`) *and* may additionally have any
  `LockedContent` field — which is not what the server sends; a locked response has none of
  `PlayerConfig`'s required fields.
- what next: the code immediately does `if (data.locked) { setLocked(data as LockedContent); return;
  }` before touching `data.segments` — so today this is safe by early return, not by the type system.
  A discriminated union (`PlayerConfig | LockedContent`) would let TypeScript enforce that ordering
  instead of relying on every future edit preserving it.
- why: Matches the brief's "weak shapes... optional fields that are always present (or the reverse)"
  category precisely — `Partial<LockedContent>` makes every locked-response field optional on a type
  that's supposed to represent "definitely locked," and the base `PlayerConfig` intersection makes
  `segments` look mandatory on a response where it's actually absent.
- evidence: `podcast-saas/client-web/components/viewer/ViewerPage.tsx:20-51` read in full; `locked`
  paywall type at `podcast-saas/shared/src/generated/client-v1.ts:334-341`
  (`LockedContent`).
- fix: Define `type PlayerConfigResponse = PlayerConfig | LockedContent` (both already discriminate
  cleanly — `PlayerConfig` has no `locked` field, `LockedContent.locked` is the literal `true`) and
  use a type guard (`'locked' in data`) instead of the intersection cast.
- effort: S

---

### [P3] `PlaylistPlayItem.config: any` — explicit `any` leak in an exported, widely-imported type
- id: types-012
- location: podcast-saas/shared/src/generated/client-v1.ts:674
- category: types
- confidence: low
- status: confirmed
- what: `PlaylistPlayItem.config` is typed `any` (with an `eslint-disable-next-line
  @typescript-eslint/no-explicit-any` immediately above it), commented "intentionally loosely typed
  here (the viewer owns the precise shape)." This is a deliberate, documented choice, not an
  oversight — flagged because it's an explicit `any` on a field of an exported type consumed by
  `getPlaylistPlayConfig()`, so the looseness propagates to every call site rather than staying local.
- why: Lower priority than the other findings here because the author already made the tradeoff
  consciously and documented why; included per the brief's explicit "own any-leakage" scope item, and
  because `any` (vs. `unknown`) means a typo on a consumer's property access (e.g.
  `item.config.thubmnail`) won't even be caught by `noImplicitAny`-style checks downstream.
- evidence: `podcast-saas/shared/src/generated/client-v1.ts:666-675`.
- fix: Change `any` to `unknown` (forces every consumer to narrow/cast explicitly, which is one
  `as` per call site instead of a silent hole) — zero behavior change, strictly safer, and the
  existing comment continues to explain why it isn't a concrete type.
- effort: S

---

## Architecture notes

1. **The API contract is split across five independently hand-maintained clients, not one.**
   `shared/src/generated/client-v1.ts` and `admin-v1.ts` are the ones with a name implying rigor, but
   `client-web/components/avatar/avatarApi.ts`, `client-web/lib/courseApi.ts`, and
   `admin-web/lib/avatarAdminApi.ts` are three more, each duplicating the same `fetch`-wrapper +
   hand-typed-response pattern outside `shared/`, invisible to anyone who only audits `generated/`.
   `types-006` and `types-010` are instances of the cost this already has. If these domains
   (avatar, courses) are going to stay long-lived, folding their request/response types into
   `shared/src/types/` (even without a full codegen pipeline) would at least put every hand-written
   contract in one place a future audit can find.

2. **Read-side validation is essentially absent despite zod being available and, in places, already
   built for exactly this.** `ClientV1Api.request<T>()` (`client-v1.ts:777-802`) does
   `JSON.parse(text) as T` for all ~150 of its methods with no schema check; `CourseViewSchema`/
   `LessonViewSchema` (`types-003`) show the team already knows how to build the schema, they just
   stop short of calling `.parse()` on the response. Write-side validation is comparatively strong
   (`podcast-studio.controller.ts`'s `MixTimelineSchema.safeParse`, `admin/v1/settings.controller.ts`'s
   `UpdateSettingsSchema`) — the asymmetry suggests the team defends against bad *input* far more
   than bad *responses*, which is backwards for a codebase whose own `stack.md` says the client can
   drift from the server silently.

3. **Validation rigor at POST/PATCH bodies is inconsistent within the same controller file, not just
   across files** — `branch.controller.ts` has three sibling PATCH routes (sequences, choice-points,
   edges) with three different levels of type safety (`types-005`), and `avatar.controller.ts` mixes
   zod-validated bodies (`MemorySchema.safeParse` at `:344`) with unchecked `(request.body ?? {}) as
   {...}` casts at most of its other ~15 POST/PUT handlers. There's no house style being enforced
   here; a lint rule or a shared `parseBody(schema)` helper would make the zod path the path of least
   resistance instead of the exception.

4. **The `generated/` naming (`types-004`) is the single most consequential fact in this domain** —
   every other finding in this file is a specific instance of the class of bug that a real
   route-to-client codegen step (or even a CI diff-check between controller route strings and client
   method paths) would catch mechanically. Until that exists, this kind of review is the only thing
   standing between a backend refactor and a silent frontend break.
