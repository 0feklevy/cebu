# Types & Contracts — findings

Run `2026-08-13T2227` · branch `fix/export-prod-assembly-and-consent-ui` · reviewer `types-contracts-reviewer`

## Method and coverage (read this before the findings)

**Typecheck: all four packages are GREEN.**

```
pnpm -C podcast-saas --filter shared      typecheck  → exit 0
pnpm -C podcast-saas --filter backend-api typecheck  → exit 0
pnpm -C podcast-saas --filter client-web  typecheck  → exit 0
pnpm -C podcast-saas --filter admin-web   typecheck  → exit 0
```

Zero errors, pre-existing or otherwise. This is *evidence for* the central finding rather than
reassurance: a green typecheck across all four packages proves nothing about the API contract,
because no compilation unit spans a Fastify route and its caller.

**The three-column map was built mechanically and is complete.**

| Column | Extracted | How |
|---|---|---|
| (a) backend routes | **245** raw → **248** after expanding one templated registrar | AST-ish scan of `backend-api/src/controllers/**` for `app.<verb>(`, balanced-paren walk to the first string literal (routes are multi-line, so a line-oriented grep finds only 22 of 245) |
| (b) client methods | **160** call sites across **144** `client-v1.ts` + **16** `admin-v1.ts` methods | balanced-paren extraction of `this.request*(...)`, verb read from `method:` **inside the same call expression** |
| (c) frontend hand-rolled call sites | **79** in production code (+16 in tests/e2e) across **23** files | regex for `/api/(admin/)?v1/...` in `client-web`/`admin-web`, `_archive`/`.next`/`node_modules` excluded |

Three scanner bugs were found and fixed during the run; each had produced false drift, and I am
recording them because the *first* version of each looked convincing:

1. A 6-line lookahead for `method:` bled into the *next* method, inventing 16 verb mismatches
   (e.g. "`listProjects` is a PATCH"). Fixed by walking balanced parens.
2. A trailing-`${q}` query-suffix strip also ate trailing **path** params, inventing 37 more.
   Fixed by only stripping `${...}` not preceded by `/`.
3. The frontend scan anchored on a quote character immediately before `/api/`, so it missed every
   `` `${API_URL}/api/v1/...` `` form — it saw 35 references when there are 95. Fixed by dropping
   the anchor. **The first-pass number was wrong by more than 2x**; the corrected figure is what
   column (c) above reports.

### The headline result is a negative one, and it is honest

**After correcting those bugs, path/verb drift is zero.**

- All **160** client call sites resolve to a registered route by verb + normalised path.
- All **79** production hand-rolled frontend call sites resolve too, except one (finding
  `types-012`, in a module that only `_archive` imports).
- All **23** `204`-returning routes map to client methods declared `Promise<void>` — checked
  one by one, not assumed.
- The export contract, which is what this branch touches, is **clean**: `exportBody()`
  (`export.controller.ts:43-59`) emits exactly the nine fields of `ProjectExport`
  (`client-v1.ts:202-212`), and the eight `ProjectExportStatus` values match the `project_exports`
  status comment (`schema.ts:1427`) and every writer in `ProjectExportService.ts`.

So I am **not** reporting the P1 "guaranteed 404" class that the run context anticipated: it does
not currently exist. The hand-maintained clients are, today, accurate. What does not exist is any
mechanism that keeps them that way — findings `types-001`, `types-002` and `types-010` are about
the missing mechanism, and the rest are real type-level defects found along the way.

### What I did NOT cover (the edges of this map)

- **Field-level response shapes were sampled, not exhaustively diffed.** I fully audited
  `admin-v1.ts` (all 16 methods, 272 lines) and the export flow. For `client-v1.ts`'s 144 methods
  I checked the boundary plumbing, the 204 set, and the shapes reachable from the admin/export/
  billing/playlist paths. **A field renamed inside a large nested response elsewhere in
  `client-v1.ts` would not have been caught by this run.** Exhaustive shape diffing needs the
  generator that findings `types-001`/`types-002` call for.
- **Request-body types** were checked only where a zod schema exists to compare against
  (`types-003`, `types-004`). Bodies with no server-side schema were not systematically enumerated.
- `shared/src/sim/**` and `shared/src/prompts/**` internals belong to `simulation-reviewer` and
  `llm-pipeline-reviewer`; I looked only at their casts.
- `_archive/**` excluded throughout, per `stack.md` §3.

### Two casts I deliberately cleared

Per my brief ("flag casts at *unvalidated* boundaries", not every `as`):

- `shared/src/sim/runtimeProtocol.ts:463` — `raw as unknown as AnySimEnvelope` is preceded by ~30
  lines of field-by-field validation (`isNonEmptyString`, seq integer/ordering checks,
  `isObject(raw.payload)`, allow-listed types). **Correct cast. Not a finding.**
- `export.controller.ts:44` — `row.plan as { warnings?: unknown } | null` on a `jsonb` column is
  immediately narrowed by `Array.isArray(...)` + `.filter((w): w is string => typeof w === 'string')`.
  **Correct cast. Not a finding.**

These two are the pattern the rest of the codebase should copy, and they are why `types-002` is a
real gap rather than a stylistic complaint.

---

### [P2] `generated/` is not generated: tsoa config and a `generate` script that cannot run
- id: types-001
- location: podcast-saas/backend-api/tsoa.json:1
- category: maintainability
- confidence: high
- status: confirmed
- what: Three artefacts assert an API-contract pipeline that does not exist. (1)
  `backend-api/tsoa.json` is a complete, plausible tsoa config (`"entryFile": "src/server.ts"`,
  `"noImplicitAdditionalProperties": "throw-on-extras"`). (2) `tsoa` is a real dependency at
  `podcast-saas/backend-api/package.json:52` and **nothing imports it**. (3) The root script
  `"generate": "pnpm --filter backend-api generate && pnpm --filter shared build"`
  (`podcast-saas/package.json:19`) delegates to a `backend-api` script that **does not exist** —
  `backend-api`'s scripts are dev, dev:worker, build, start, worker, db:migrate, db:check,
  verify:storage, backfill:storage, backfill:urls, videos:audit, sims:reinject-gates,
  sims:backfill-ack, duplication:diagnose, db:studio, typecheck, test, test:watch, test:coverage,
  lint. And the directory holding the two clients is named `generated/`.
- why: Four independent signals tell a reader "the client is generated from the routes; the build
  will catch drift". None of it is true, so the one safety habit that would catch drift —
  re-running codegen and reading the diff — is never performed. This is the enabling condition for
  every other contract finding here: `types-002` (no validation), `types-010` (79 bypass call
  sites) and the sampling limit I declared above all trace back to it.
- evidence: `ls podcast-saas/backend-api/tsoa.json` → exists, 598 bytes.
  `grep -rn "from 'tsoa'|require('tsoa')|@tsoa" podcast-saas --include=*.ts --include=*.tsx`
  (node_modules excluded) → **no matches**.
  `node -e` over `backend-api/package.json` scripts → no `generate` key. Confirms `stack.md` §2.
  Directory listing: `shared/src/generated/` contains only the two hand-edited files
  (`client-v1.ts` 1667 lines, last modified Aug 13; `admin-v1.ts` 272 lines, Aug 11).
- fix: Pick one and make it true. Either (a) delete `tsoa.json`, drop the `tsoa` dependency, remove
  the root `generate` script, and **rename `shared/src/generated/` to `shared/src/api/`** with a
  header comment on both files saying they are hand-maintained and must be updated alongside any
  route change; or (b) stand up real generation and wire it into CI. (a) is S effort and removes
  the lie today; (b) is the durable fix. Do (a) now regardless — the misleading directory name is
  the cheapest part to fix and the most misleading part to leave.
- verify: `grep -rn "generated" podcast-saas --include=*.ts | grep -v node_modules` shows no stale
  import paths after the rename; `pnpm -C podcast-saas --filter shared typecheck` stays clean.
- cross: @dependency-auditor (unused `tsoa` dep), @fleet-maintainer (confirms `stack.md` §2)
- effort: S

### [P2] Every API response enters the app through an unvalidated `JSON.parse(...) as T`
- id: types-002
- location: podcast-saas/shared/src/generated/client-v1.ts:801
- category: types
- confidence: high
- status: confirmed
- what: `return JSON.parse(text) as T;` is the single funnel through which **all 160 client call
  sites** receive their data. `T` is supplied by the calling method's declared return type and is
  never checked. The same pattern repeats at `client-v1.ts:835` and `admin-v1.ts:173`
  (`return res.json() as Promise<T>;`). The declared type is a wish, not a guarantee.
- why: With no generator (`types-001`), the *only* thing that could catch a backend field rename is
  a runtime check — and there is none. A renamed or newly-nullable field surfaces as
  `undefined` deep inside a React render, far from the fetch, with a stack trace that points at the
  component rather than the contract. This is precisely the "silent until runtime" failure mode the
  hand-maintained client creates.
- evidence: Read `client-v1.ts:777-836`. The `request<T>` body performs `res.ok` and empty-body
  checks only; there is no schema call on the success path.
  **zod is already available and already used for this exact job elsewhere**: it is a dependency in
  `shared` (`package.json:32`), `backend-api` (`:53`) and `client-web` (`:39`), and
  `shared/src/types/` already defines schemas in `project.ts:1`, `corpus.ts:1`, `course-view.ts:1`,
  `errors.ts:1`, `host.ts:1`, `podcast.ts:1`, `podcastStudio.ts:13`, `course.ts:1`. `client-v1.ts`
  imports from those very modules — but with `import type` only (`client-v1.ts:2-22`), so it pulls
  the shapes and leaves the validators behind. Contrast `runtimeProtocol.ts:463` and
  `export.controller.ts:44-47`, where casts *are* guarded.
- fix: Give `request<T>` an optional `schema?: ZodType<T>` parameter and `return schema ? schema.parse(json) : json as T`.
  Wire the already-written schemas in `shared/src/types/*` into the methods that return those
  shapes, starting with the highest-traffic ones (`getPlayerConfig`, `listProjects`,
  `getProjectExport`, `getPodcastStudio`). Throw a typed `ContractError` naming the endpoint and
  the failing path so drift reports itself at the seam instead of in a component.
- verify: Add a `shared` unit test that feeds `request` a payload with a renamed field and asserts
  a `ContractError` mentioning the endpoint; red before, green after.
  `pnpm -C podcast-saas --filter shared typecheck` stays clean.
- cross: @frontend-reviewer (error surfacing at call sites), @observability-reviewer
- effort: L

### [P2] `updateSettings` advertises 33 settable fields; the server silently discards 16 of them
- id: types-003
- location: podcast-saas/shared/src/generated/admin-v1.ts:180
- category: types
- confidence: high
- status: confirmed
- what: `updateSettings(body: Partial<AdminSettings>): Promise<AdminSettings>` targets
  `PUT /api/admin/v1/settings`. `AdminSettings` (`admin-v1.ts:14-53`) declares ~33 fields, so
  `Partial<>` types **every one of them** as settable. The server's `UpdateSettingsSchema`
  (`podcast-saas/backend-api/src/controllers/admin/v1/settings.controller.ts:9-30`) allows only 15
  keys. zod's `z.object()` defaults to **strip** mode, so unknown keys do not fail validation —
  `safeParse` succeeds and they are dropped before the `db.update()` at `settings.controller.ts:49-53`.
  The route then returns **200 with the unchanged row**.
- why: `updateSettings({ temperature: 0.5, utility_model: 'x' })` typechecks, returns 200, and
  changes nothing. There is no error to surface. The 16 silently-dropped fields are
  `default_provider`, `temperature`, `max_tokens`, `extended_thinking_enabled`,
  `thinking_budget_tokens`, `utility_model`, `generation_model`, `complex_model`,
  `complex_min_corpus_tokens`, `complex_min_retries`, `tts_provider`, `elevenlabs_model`,
  `default_voice_id_a`, `default_voice_id_b`, `podcast_model`, `podcast_effort` — they are settable
  only via the *other* route, `PUT /api/admin/v1/llm-config`.
- evidence: Read both files in full. Key sets diffed by hand. **Not currently triggered**: the one
  caller, `podcast-saas/admin-web/app/feature-flags/page.tsx:61`, sends a `Pick<>` of exactly 11
  keys (`page.tsx:8-23`), all of which are in the schema — so this is latent today, which is why it
  is P2 and not P1. It becomes a live silent-failure the first time someone adds an LLM field to
  that page, and the type system will encourage them to.
- fix: Stop letting the type over-promise. Define
  `type AdminControlSettings = Pick<AdminSettings, 'billing_enabled' | 'generation_paused' | … >`
  (the 15 keys the route accepts) and change the signature to
  `updateSettings(body: Partial<AdminControlSettings>)`. Independently, add `.strict()` to
  `UpdateSettingsSchema` so an unexpected key returns 400 instead of being dropped — a rejected
  write is far better than a pretend-successful one.
- verify: A backend test PUTting `{ temperature: 0.5 }` should assert 400 after the change (it
  asserts 200-and-no-change today); `pnpm -C podcast-saas --filter admin-web typecheck` stays clean.
- cross: @backend-reviewer (`.strict()` on the route), @ui-ux-reviewer (admin save reports success)
- effort: S

### [P2] `default_voice_id_a/b` are nullable on read but reject `null` on write
- id: types-004
- location: podcast-saas/shared/src/generated/admin-v1.ts:37
- category: types
- confidence: high
- status: confirmed
- what: `AdminSettings` declares `default_voice_id_a: string | null` and
  `default_voice_id_b: string | null` (`admin-v1.ts:37-38`), matching the nullable DB columns that
  `GET /api/admin/v1/llm-config` returns verbatim. But the write schema accepts only
  `z.string().optional()` — `default_voice_id_a` at
  `podcast-saas/backend-api/src/controllers/admin/v1/llm-config.controller.ts:28` and
  `default_voice_id_b` at `:29`. `null` is not `undefined`, so it fails validation and the route
  returns 400 (`llm-config.controller.ts:48`).
- why: A read-modify-write round trip — `getLlmConfig()`, change one field, `updateLlmConfig(cfg)` —
  fails with an opaque zod message whenever either voice id is unset, which is their default state.
  `Partial<AdminSettings>` types the `null` as perfectly legal, so the typecheck is green and the
  failure only appears at runtime. It is also an inconsistency within the same file: the nullable
  string fields in `UpdateSettingsSchema` were written correctly as `.nullable().optional()`
  (`settings.controller.ts:12` and `:14`), so the intended pattern exists three files away.
- evidence: Read `llm-config.controller.ts:14-33` (schema) and `:45-56` (handler); read
  `admin-v1.ts:14-53`. Latent today — `admin-web/app/llm-config/page.tsx:8-18` picks 9 fields and
  does not include the voice ids — so P2, not P1. Confirmed nullable in the DB via
  `admin_settings` in `podcast-saas/backend-api/src/db/schema.ts`.
- fix: Change both to `z.string().nullable().optional()` in `llm-config.controller.ts:28-29`,
  matching `settings.controller.ts:12`. Clearing a default voice is a legitimate operation and
  currently impossible through the API.
- verify: Backend test PUTting `{ default_voice_id_a: null }` to `/api/admin/v1/llm-config`
  asserts 200 and a nulled column; red before, green after.
- cross: @backend-reviewer
- effort: S

### [P2] Admin billing transactions ships raw DB rows; the declared type covers 13 of 19 columns
- id: types-005
- location: podcast-saas/backend-api/src/controllers/admin/v1/billing.controller.ts:45
- category: types
- confidence: high
- status: confirmed
- what: `GET /api/admin/v1/billing/transactions` does `return reply.send(rows)` where `rows` is an
  unprojected `db.query.billing_transactions.findMany({ limit: 200 })` — every column of the table.
  The client type `AdminBillingTransaction` (`podcast-saas/shared/src/generated/admin-v1.ts:258-272`)
  declares 13 fields. The table has 19. The six undeclared columns that ship anyway are
  `stripe_checkout_session_id`, `stripe_payment_intent_id`, `payer_user_id`, `creator_user_id`,
  `error`, and `updated_at`-adjacent internals.
- why: Two distinct problems from one line. (1) The response is defined by the *database schema*,
  not by a serialiser, so any future column — including a sensitive one — is published to the admin
  client automatically, and any column rename silently breaks the client with no build error
  (`types-001` again). (2) Stripe identifiers and internal user UUIDs are sent to the browser
  without being part of the declared contract, so nothing in review would flag their arrival.
- evidence: Read `billing.controller.ts:37-47` — no `columns:` projection, no `.select()`.
  Column list read from `billing_transactions` in `podcast-saas/backend-api/src/db/schema.ts`
  (19 columns; `payer_email` at schema-relative line 12 does exist, so the declared fields are
  accurate as far as they go — the problem is the six extra). Contrast the sibling route
  `/billing/overview` (`billing.controller.ts:23-32`), which builds an explicit object literal and
  is correct.
- fix: Add an explicit projection to the query — `columns: { id: true, status: true, type: true,
  amount_cents: true, currency: true, platform_fee_cents: true, creator_payout_cents: true,
  content_type: true, content_id: true, description: true, payer_email: true, created_at: true,
  completed_at: true }` — so the response is defined by the contract instead of the schema. Mirror
  the object-literal style already used by `/billing/overview`.
- verify: Backend test asserts the response keys equal exactly the 13 declared fields; add a
  `Object.keys(row).sort()` assertion so a new column fails the test rather than leaking.
- cross: @security-reviewer (Stripe ids + internal UUIDs to browser), @billing-integrity-reviewer
- effort: S

### [P2] The viewer's whole rendering contract is `any` at the shared boundary
- id: types-006
- location: podcast-saas/shared/src/generated/client-v1.ts:674
- category: types
- confidence: high
- status: confirmed
- what: `PlaylistPlayItem.config: any` (`client-v1.ts:668-675`) carries the complete `PlayerConfig`
  for every playlist item — segments, captions, simulation overlays, b-roll, branching — as `any`,
  behind an `eslint-disable-next-line @typescript-eslint/no-explicit-any`. The comment says
  "PlayerConfig is intentionally loosely typed here (the viewer owns the precise shape)".
- why: The shape is not actually unknown — `PlayerConfig` is a fully specified interface at
  `podcast-saas/client-web/components/viewer/types.ts:217`, imported by 15+ modules including
  `ViewerPage.tsx:4`, `LessonPlayer.tsx:11` and `useProjectPlayer.ts:5`. It is `any` here only
  because it lives in `client-web` and `shared` cannot depend on `client-web`. So the single most
  complex payload in the product has three unlinked definitions — the backend builder in
  `player.controller.ts:30`, `any` in the shared client, and the real interface in `client-web` —
  and nothing checks that they agree. `any` also disables checking *through* it: every property
  access on `config` downstream is unchecked.
- evidence: Read `client-v1.ts:661-688`. `grep -rn "PlayerConfig" podcast-saas/shared` → no
  definition in `shared`; all 15 hits are under `client-web`. The backend side is reachable as
  `GET /api/v1/projects/:id/player-config` (`podcast-saas/backend-api/src/controllers/v1/player.controller.ts:30`),
  which has **no client method at all** and is fetched by hand at
  `podcast-saas/client-web/components/viewer/ViewerPage.tsx:38` (see `types-010`).
- fix: Move `PlayerConfig` and its satellite types (`PlayerSegment`, `SimulationOverlay`,
  `TimelineSeg`, `BrollClip`, `ImageOverlayItem`, `AudioCutaway`, `PlayerBranch*`) from
  `client-web/components/viewer/types.ts` into `shared/src/types/player.ts`, re-export them from
  `client-web/components/viewer/types.ts` so no client-web import path changes, then type
  `PlaylistPlayItem.config` as `PlayerConfig` and drop the eslint suppression.
- verify: `pnpm -C podcast-saas --filter shared typecheck && pnpm -C podcast-saas --filter client-web typecheck`
  both clean; the eslint-disable comment is gone.
- cross: @frontend-reviewer, @simulation-reviewer (overlay shapes)
- effort: M

### [P2] `requestMultipart` lacks the empty-body guard its sibling `request` has
- id: types-007
- location: podcast-saas/shared/src/generated/client-v1.ts:835
- category: bug
- confidence: high
- status: confirmed
- what: `request<T>` carefully handles bodyless responses — `if (res.status === 204) return undefined as T;`
  (`client-v1.ts:798`) and `if (!text) return undefined as T;` (`:800`), under a comment explaining
  that empty bodies "must not be fed to JSON.parse". `requestMultipart<T>` (`:822-836`) does none of
  that: it goes straight to `return res.json() as Promise<T>;` (`:835`). `admin-v1.ts:173` has the
  same gap.
- why: `res.json()` on a 204 or an empty body rejects with a `SyntaxError` ("Unexpected end of JSON
  input") rather than resolving. The upload methods routed through `requestMultipart` —
  `uploadProjectThumbnail` (`client-v1.ts:937`), `uploadCorpus` (`:963`) — would surface a JSON
  parse error instead of a successful upload if their routes ever answered 204. The knowledge that
  this is necessary is already written down 30 lines above; it just was not applied here.
- evidence: Read `client-v1.ts:777-836` — the asymmetry is visible in one screen. No multipart route
  currently returns 204 (I checked all 23 `code(204)` sites; none are the thumbnail or corpus upload
  routes), so this is latent rather than firing today — hence P2.
- fix: Extract the shared tail of `request` into a `parseBody<T>(res): Promise<T>` helper that does
  the 204/empty checks, and call it from `request`, `requestMultipart`, and `admin-v1.ts`'s
  `request`. One implementation, three call sites, no third chance to forget.
- verify: Unit test in `shared` where a mocked multipart response returns 204; asserts `undefined`
  rather than a rejected promise. Red before, green after.
- effort: S

### [P2] 79 hand-rolled call sites bypass the typed clients entirely
- id: types-010
- location: podcast-saas/client-web/components/avatar/avatarApi.ts:113
- category: maintainability
- confidence: high
- status: confirmed
- what: **90 of 248 routes have no method in either typed client.** The gap is not evenly spread:
  34 are avatar routes, 20 are course routes, 18 are public/unauthenticated, and 18 are the
  remainder (7 of which are dead Phase-2 stubs in `controllers/stubs.ts`). They are reached instead
  by three parallel hand-written clients and a scattering of inline fetches —
  `podcast-saas/client-web/components/avatar/avatarApi.ts` (26 references),
  `podcast-saas/client-web/components/VideoUploader.tsx` (7),
  `podcast-saas/admin-web/lib/avatarAdminApi.ts` (7),
  `podcast-saas/client-web/components/SectionEditor.tsx` (5),
  `podcast-saas/client-web/lib/courseApi.ts` (5), and 18 more files with 1-3 each.
- why: There are now four places a route path is written down (`client-v1.ts`, `admin-v1.ts`,
  `avatarApi.ts`, `avatarAdminApi.ts`) plus 19 files with inline paths, and no build step relates
  any of them to `controllers/**` (`types-001`). Each is an independent opportunity for the silent
  404 this review was sent to find. The single most important payload in the viewer —
  `GET /api/v1/projects/:id/player-config` — is in this bypassed set, fetched by raw `fetch` at
  `podcast-saas/client-web/components/viewer/ViewerPage.tsx:38`, which is also why its type
  degraded to `any` (`types-006`).
- evidence: Route table (248) diffed against client methods (160 call sites); orphan set written to
  the run scratchpad and grouped by prefix. Frontend scan found 79 production `/api/v1/...`
  literals in 23 files. **I verified the paths themselves are currently correct** — every one of the
  79 resolves to a registered route except `types-012` — so this finding is about the absence of a
  chokepoint, not about drift that exists today.
- fix: Fold `avatarApi.ts`, `avatarAdminApi.ts` and `courseApi.ts` into `ClientV1Api`/`AdminV1Api`
  as method groups so there is exactly one place per route where a path is written. Then add a
  cheap CI guard — a script that extracts route literals from `controllers/**` and from the clients
  and fails on a path in one and not the other. That guard is ~50 lines and would have made this
  entire review a `pnpm test` run; the extraction logic in this run's scratchpad can seed it.
- verify: The guard script passes on the current tree (it should — drift is zero today) and fails
  when a route path is edited on one side only.
- cross: @frontend-reviewer
- effort: L

### [P2] `.catch(() => <empty>)` in the avatar client turns any failure into plausible empty data
- id: types-011
- location: podcast-saas/client-web/components/avatar/avatarApi.ts:113
- category: bug
- confidence: high
- status: confirmed
- what: The hand-rolled avatar client terminates fetches with a catch-all that substitutes a
  well-formed empty value: `.catch(() => ({ tools: [] }))` (`:113`),
  `.catch(() => ({ data: [] }))` (`:116`, `:139`), `.catch(() => ({ config: null }))` (`:188`),
  `.catch(() => ({ byokEnabled: false, hasKey: false }))` (`:203`),
  `.catch(() => ({ items: [], total: 0, typeCounts: {} }))` (`:272`),
  `.catch(() => ({ token: null, turns: [], profile: {} }))` (`:253`), and `.catch(() => {})` on
  fire-and-forget writes (`:230`, `:262`).
- why: `jsonFetch` throws on `!res.ok`, so these catches swallow 401, 404, 500 and network failures
  identically and hand the UI a valid-looking empty result. In the specific context of this review
  that is the worst possible behaviour: it is exactly the class of bug — a route renamed on the
  backend — that the hand-maintained-client architecture makes likely, and this converts it from a
  visible error into "the user has no avatar tools". It would not appear in logs, in an error
  boundary, or in a bug report; it looks like an empty account.
- evidence: Read `avatarApi.ts:1-320`. `jsonFetch` (`:12-20`) throws on non-ok. All 8 catch sites
  listed above discard the error object entirely — none inspects `res.status`, none re-throws, none
  reports. Contrast the upload paths at `:123` and `:198`, which *do* parse a message and throw.
- fix: Let these reject and handle them at the call sites with an explicit error state, or at
  minimum narrow the catch to genuine network errors and re-throw HTTP failures:
  `.catch((e) => { if (e instanceof TypeError) return EMPTY; throw e; })`. A 404 from a renamed
  route must be loud.
- verify: Component test mocking a 404 for `/avatar/tools` asserts an error state renders rather
  than an empty tool list.
- cross: @frontend-reviewer, @observability-reviewer (silent failures never reach logs)
- effort: M

### [P2] No package enables `noUncheckedIndexedAccess` or `exactOptionalPropertyTypes`
- id: types-008
- location: podcast-saas/tsconfig.base.json:7
- category: types
- confidence: high
- status: confirmed
- what: `tsconfig.base.json` sets `"strict": true` and stops there (`:2-15`). `shared` and
  `backend-api` extend it. `client-web` and `admin-web` **do not extend it at all** — they declare
  their own options with `"strict": true` and a different `target` (ES2017 vs ES2022) and
  `moduleResolution` (`bundler` vs `Node16`). No package sets `noUncheckedIndexedAccess` or
  `exactOptionalPropertyTypes`.
- why: These two flags are the ones that matter most for a **hand-maintained** contract.
  `exactOptionalPropertyTypes` is what distinguishes "key absent" from "key present and
  `undefined`" — the exact distinction the optional contract fields turn on
  (`ProjectExport.download_url?: string | null` at `client-v1.ts:209`,
  `cancel_requested?: boolean` at `:211`, `StartedExport.already_running?: boolean` at `:182`).
  `noUncheckedIndexedAccess` is what forces a check on the index reads that parse API arrays and
  `Record<string, …>` maps (`UsageRollup.by_provider` etc.). Without them, `strict: true` gives less
  protection than the codebase's contract style needs. That `admin-web` also omits an `_archive`
  exclude (`client-web` has one) is a smaller instance of the same config drift.
- evidence: Read all four `tsconfig.json` files plus `tsconfig.base.json`. Verified all four
  typechecks are currently green, so tightening will surface *new* errors — that is the point, and
  it is why this is staged below.
- fix: Add `"noUncheckedIndexedAccess": true` and `"exactOptionalPropertyTypes": true` to
  `tsconfig.base.json`, and make `client-web`/`admin-web` extend it (overriding only `target`,
  `module`, `moduleResolution`, `jsx`, and the Next plugin). Land it per package, `shared` first —
  it is the smallest and holds the contract. Expect a real error count on the first run; triage
  rather than suppress.
- verify: `pnpm -C podcast-saas --filter shared typecheck` clean after fixing `shared`'s fallout,
  then repeat per package.
- effort: L

### [P2] `undefined as T` satisfies non-void return types; only convention keeps it honest
- id: types-009
- location: podcast-saas/shared/src/generated/client-v1.ts:798
- category: types
- confidence: medium
- status: confirmed
- what: `request<T>` returns `undefined as T` on a 204 (`:798`) and on an empty body (`:800`). `T`
  is whatever the calling method declared, so a method typed `Promise<ProjectExport>` whose route
  answers 204 returns `undefined` while TypeScript guarantees an object.
- why: The failure would be a `TypeError` on first property access, in a component, with nothing
  pointing back at the response. Nothing enforces the pairing — it is upheld only by whoever edits
  the two files remembering to keep them in step, and `types-001` means no build step checks.
- evidence: **Currently correct, which is why this is medium confidence and P2 rather than P1.** I
  mapped all 23 `code(204)` sites in `controllers/**` to their enclosing route and then to the
  client method calling that route: all 23 map to methods declared `Promise<void>` — `deleteProject`,
  `deleteVideo`, `deleteSection`, `deleteMarker`, `deleteBranchSequence`, `deleteChoicePoint`,
  `deleteBranchEdge`, `clearBranching`, `deleteBrollJob`, `deleteImage`, `deleteAudioFile`,
  `deleteSimulation`, `deletePlaylist`, `revokePlaylistShare`, `removeProjectCollaborator`,
  `removePlaylistCollaborator`, `deletePodcastShow`, `deletePodcastEpisode`, `deletePodcastSource`,
  `abortMultipartUpload` (20 methods; 3 further 204 routes have no client method). Zero mismatches.
- fix: Make the invariant explicit instead of implicit: overload `request` so the bodyless path is
  only reachable when `T` is `void` (`request<void>(path, opts): Promise<void>` alongside
  `request<T>(...): Promise<T>`), or have the non-void overload throw a `ContractError` naming the
  endpoint when it receives an empty body. Folds naturally into the `parseBody` helper from
  `types-007` and the schema work in `types-002`.
- verify: Unit test asserting a `Promise<ProjectExport>`-typed call against a 204 throws a
  `ContractError` rather than resolving `undefined`.
- effort: M

### [P3] `sse-client.ts` is dead code whose default path points at a route that does not exist
- id: types-012
- location: podcast-saas/client-web/lib/sse-client.ts:14
- category: maintainability
- confidence: high
- status: confirmed
- what: `connectSSEStream` defaults to `` `/api/v1/projects/${projectId}/stream` `` when no
  `streamPath` argument is given. **No such route is registered anywhere in the backend.** The
  module is also entirely unreferenced by live code.
- why: This is the only genuine path mismatch the full three-column diff found, and it is inert —
  worth recording precisely because it is the shape of the bug the architecture invites, preserved
  in a module nobody deleted. Left in place it is a trap: the next caller to use the convenient
  default gets a 404 that surfaces as `SSE connection failed: 404` (`sse-client.ts:24`).
- evidence: Full route table (248) contains only four `/stream` paths — the sim-script and guidance
  streams under `sections.controller.ts:687`/`:741` and `simulations.controller.ts:713`/`:816` —
  none matching `/api/v1/projects/:id/stream`. `grep -rn "connectSSEStream|sse-client"` across
  `client-web` and `admin-web` returns only the definition itself plus two importers under
  `_archive/v1-podcast-pipeline/` (excluded from review per `stack.md` §3).
- fix: Delete `podcast-saas/client-web/lib/sse-client.ts`. The live SSE consumers build their URLs
  directly (e.g. `SectionEditor.tsx:1009`). If it is kept for future use, make `streamPath`
  required so the broken default cannot be reached.
- verify: `pnpm -C podcast-saas --filter client-web typecheck` stays clean after deletion.
- effort: S

### [P3] `AdminSettings.default_provider` is narrower than the Postgres enum it reads from
- id: types-013
- location: podcast-saas/shared/src/generated/admin-v1.ts:24
- category: types
- confidence: high
- status: confirmed
- what: The client declares `default_provider: 'claude' | 'openai' | 'gemini'`. The column is
  `providerEnum('default_provider')` and `providerEnum` is
  `pgEnum('provider', ['claude', 'openai', 'gemini', 'elevenlabs'])`
  (`podcast-saas/backend-api/src/db/schema.ts:68`, used at `:270`). `GET /api/admin/v1/llm-config`
  returns the row unfiltered (`llm-config.controller.ts:40`), so a fourth value can reach a client
  that has excluded it from the union.
- why: Low impact and correctly ordered as P3: writes are constrained to the three LLM providers by
  `z.enum(['claude','openai','gemini'])` at `llm-config.controller.ts:15`, so `'elevenlabs'` can
  only land in that column via direct SQL. The union is a reasonable intent — `elevenlabs` is a TTS
  vendor, not an LLM — but the shared `provider` enum is doing double duty for both
  `admin_settings.default_provider` and `api_keys.provider` (`schema.ts:134`), where `elevenlabs`
  *is* valid. The type is right about intent and wrong about what the column can hold.
- evidence: Read `schema.ts:68`, `:134`, `:270`; `llm-config.controller.ts:15` and `:36-43`.
- fix: Add a `CHECK` constraint (or a separate narrower enum) restricting
  `admin_settings.default_provider` to the three LLM providers, so the type and the column agree at
  the database rather than by convention. Cheaper interim: a code comment on `admin-v1.ts:24`
  noting the deliberate narrowing and the shared enum.
- verify: The constraint rejects `'elevenlabs'` for `admin_settings.default_provider` while
  `api_keys.provider` still accepts it.
- cross: @database-reviewer (constraint), @migration-auditor
- effort: S

### [P3] `PipelineStats.by_hls_status` is declared closed but built as an open map
- id: types-014
- location: podcast-saas/shared/src/generated/admin-v1.ts:109
- category: types
- confidence: high
- status: confirmed
- what: The client declares `by_hls_status` as a closed object with exactly
  `{ pending, processing, ready, failed }` (`admin-v1.ts:109-114`). The server builds it as
  `Record<string, number>` seeded with those four keys and then assigns **unconditionally** from the
  `GROUP BY`: `videoByStatus[r.hls_status] = r.count;`
  (`podcast-saas/backend-api/src/controllers/admin/v1/pipeline-stats.controller.ts:57-60`). Any
  other `hls_status` value in `video_files` adds a key the type says cannot exist.
- why: Minor — extra keys are ignored by the admin dashboard rather than crashing it. It is worth
  recording because the *sibling* aggregation four lines below gets it right: `simByStatus` guards
  with `if (r.status in simByStatus)` (`:62-65`) before assigning, so simulations cannot grow keys
  and videos can. Two adjacent loops, two different contracts, one shared declared shape.
- evidence: Read `pipeline-stats.controller.ts:56-66` and `:78-85`; read `admin-v1.ts:98-140`.
- fix: Add the same `in` guard to the video loop for symmetry with the sim loop, or — better, since
  it is genuinely open data — declare both as
  `by_hls_status: Partial<Record<string, number>> & { pending: number; processing: number; ready: number; failed: number }`
  and let the dashboard render unknown statuses instead of dropping them silently.
- verify: Backend test with a `video_files` row in an unexpected `hls_status` asserts the chosen
  behaviour (rejected or surfaced) rather than the current silent extra key.
- effort: S

### [P3] `AdminBillingOverview` uses camelCase; every other contract type uses snake_case
- id: types-015
- location: podcast-saas/shared/src/generated/admin-v1.ts:247
- category: maintainability
- confidence: high
- status: confirmed
- what: `AdminBillingOverview` (`admin-v1.ts:247-256`) declares `platformFeePercent`,
  `totalTransactions`, `totalVolumeCents`, `totalPlatformFeesCents`, `pendingTransactions`,
  `activeCreators`, `activeBuyers`. Every other interface in both clients is snake_case — including
  `AdminBillingTransaction` directly beneath it (`:258-272`, `amount_cents`, `platform_fee_cents`)
  and `PipelineStats.revenue` (`:134-139`, `gross_cents`, `platform_fee_cents`), which expose the
  same quantities under snake_case names.
- why: `platform_fee_cents` and `platformFeePercent` are neighbours in the admin UI and differ in
  both case convention and unit (cents vs percent). The naming is accurate to the handler — the
  overview route builds a fresh object literal (`billing.controller.ts:23-32`) rather than
  returning DB rows — so this is a convention break, not drift. Recording it as a nit because a
  reader who pattern-matches the file's snake_case will mistype these and only find out at runtime,
  which `types-002` guarantees is the only place they'd find out.
- evidence: Read `admin-v1.ts:238-272` and `billing.controller.ts:8-47`. The two interfaces are
  declared *after* the class that returns them (`:238`, `:242`) — legal via hoisting, but it is why
  the inconsistency is easy to miss when reading top-down.
- fix: Rename to snake_case in `AdminBillingOverview` and in the handler's object literal at
  `billing.controller.ts:23-32`, updating the admin billing page's property reads. Single consumer,
  contained change.
- verify: `pnpm -C podcast-saas --filter admin-web typecheck` catches every read site during the
  rename; clean afterwards.
- effort: S
