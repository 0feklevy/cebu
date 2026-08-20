# Library Share — Phase 1 implementation report

**Branch:** `feat/library-share-impl`, based on `origin/main` @ `6c7f9bb`. Not pushed, no PR.
**Spec:** `podcast-saas/md-files/LIBRARY-SHARE-MINISITE-PLAN.md` §9 (Phase 1).
**Migration number used: `065`** — reserved by the coordinator and independently re-verified (see below).

---

## 1. Phase-1 scope — item by item

| # | Item | Verdict | Evidence |
|---|---|---|---|
| 1 | Migration `065_library_shares.sql` + rollback | **DONE** | `backend-api/src/db/migrations/065_library_shares.sql`, `…rollback.sql`; registered in **both** `migrate.ts` and `src/scripts/check-db.ts` — see §4.9 |
| 2 | `library_shares` mirrored in `db/schema.ts` | **DONE** | `schema.ts`, declared beside `playlists` (before `playlist_items`) |
| 3 | `shared/src/types/library-view.ts` (zod + inferred types) | **DONE** | New file, 128 lines; re-exported from `shared/src/index.ts` |
| 4 | `LibraryShareService` — mint (idempotent), resolve, revoke | **DONE** | `backend-api/src/services/library/LibraryShareService.ts` |
| 5 | URL building through `publicOrigins`, **not** the inline env fallback | **DONE** | `libraryShareUrl` / `libraryCleanUrl` call `siteUrl()`; no `process.env.NEXT_PUBLIC_APP_URL` anywhere in the feature |
| 6 | `buildLibraryView` — four reads | **DONE** | one `Promise.all` over `video_files`, simulations, `image_files`, `audio_files` |
| 7 | …ready-only filtering | **DONE** | `hls_status !== 'ready'` and `status !== 'ready'` rows skipped; backend test 5 |
| 8 | …degraded simulation read (42703 retry) | **DONE** | `loadSimulationsDegraded`, copied from `editor-state.controller.ts`, drops `bridge_ack_capable` + `requires_import_maps` on retry |
| 9 | …R2 origin guard | **DONE** | `simUrlIsFramable` compares the sim URL origin to `publicApiOrigin()` and drops with a logged warning |
| 10 | …public-only view model (no storage key / code / project_id / org_id / created_by) | **DONE with one correction** | Every material is constructed field by field; no row is ever spread. See §4 — the plan's `project_id` claim is wrong against current main |
| 11 | `library-share.controller.ts` public GET (optional auth, IP rate limit, Cache-Control) | **DONE** | `firebaseAuthOptionalMiddleware`; `rateLimit('libshare:'+ip, 60, 60_000)` → 429; `public, max-age=60, s-maxage=60, stale-while-revalidate=300` |
| 12 | …four owner routes (auth + `editableProject`, 404 never 403) | **DONE** | GET / POST / PATCH / DELETE, each opening with `editableProject(…)` → `404 { message: 'Project not found' }` |
| 13 | …registered in `server.ts` | **DONE** | line 595, beside `registerPermalinkRoutes` (line 594) |
| 14 | `RESERVED_SLUGS` additions | **DONE** | `library, libraries, simulation, simulations, sound, sounds, sim` — verified none was already present |
| 15 | `permalinkSlugTaken` extension | **DONE** | third parallel query against `library_shares` where `revoked_at IS NULL` |
| 16 | `lib/libraryApi.ts` (server-only, zod-validated, `PageResult` union) | **DONE** | `import 'server-only'`; `LibraryViewSchema.safeParse`; ISR tags `library-share` + `library-share:{slug}` |
| 17 | `lib/libraryShareClient.ts` | **DONE** | four wrappers; the read resolves any failure to `NOT_SHARED` (types-010), the writes throw |
| 18 | `app/[slug]/library/page.tsx` | **DONE** | `export const revalidate = 60`; `SLUG_SHAPE` guard; `robots: { index: false, follow: false }`; does not read `searchParams` |
| 19 | `app/[slug]/library/[type]/page.tsx` — canonical sub-routes + alias 308s | **DONE** | `simulation / images / videos / sounds` canonical; `simulations, sims, sim, image, video, sound, audio` → `permanentRedirect()`; everything else `notFound()` |
| 20 | `LibraryMiniSite` / `LibraryCard` / `LibraryOverlay` | **DONE (+1 file)** | plus `LibraryGrid.tsx` — see §4, the server/client boundary makes the plan's 3-file split unbuildable as written |
| 21 | `LibraryShareButton` + `LibraryShareDialog` | **DONE** | copy + inline-confirm revoke + inline status strip; no `alert()` |
| 22 | Share icon placement per §6.1 | **DONE** | see §3 |
| 23 | `allow` prop on `SimSurface` **and** `AdminSimSurface` | **DONE** | both files; parity test extended to pin it |
| 24 | robots `Disallow` | **DONE** | `Disallow: /*/library` in `app/robots.txt/route.ts` |
| 25 | ISR `revalidate = 60` with purge on revoke | **DONE** | both page files; `dispatchLibraryInvalidation` on DELETE and PATCH |
| 26 | Per-IP rate limit | **DONE** | asserted by a test that trips it at request 61 |
| 27 | `computeLibraryInvalidationTargets` (pure, unit-tested) | **DONE** | `PublishingInvalidationService.ts` + 3 unit tests |
| 28 | Five routes recorded in the hand-maintained `client-v1.ts` | **DONE** | `LibraryShareInfo` + four owner methods; the public read is documented there but deliberately not a browser method |
| — | Phase 2 / Phase 3 work | **NOT DONE, deliberately** | no `/resolve`, no `/og`, no RTL layer, no sort/search, no per-type checkboxes wired to PATCH |

---

## 2. Test results

### Backend — `backend-api/src/services/library/__tests__/publicLibrary.integration.test.ts`

Real PGlite with **every migration through 065 replayed**, and the actual Fastify routes registered
via `app.inject()`.

```
 Test Files  1 passed (1)
      Tests  12 passed (12)
   Duration  12.34s
```

The plan's seven, all present and passing:

1. `is idempotent — a second mint returns the same slug, not a second link`
2. `re-mints the code on a forced 23505 and succeeds within three attempts`
3. `revoked, expired and unknown are byte-identical 404s`
4. `a type outside include_types is absent from materials AND its sub-route 404s`
5. `omits a processing simulation and a video whose HLS is not ready`
6. `no private field survives serialization — asserted over the WHOLE response`
7. `counts cover all four buckets even when one type is requested`

Plus five that fell out of writing them: id-derived slug fallback, the clean-permalink alias gated
on `visibility='public'`, the emitted URLs and crop fractions, the `Cache-Control` header, and the
429.

### Backend — `computeLibraryInvalidationTargets`

```
 Test Files  1 passed (1)
      Tests  14 passed (14)     (statusAndInvalidation.test.ts: 11 → 14)
```

### Frontend — `client-web/__tests__/libraryMiniSite.test.tsx`

```
 Test Files  1 passed (1)
      Tests  10 passed (10)
   Duration  983ms
```

The plan's five:

8. `renders the four sub-route hrefs plus All, and marks only the active one`
9. `mounts no iframe in the grid, one on open, and none again after close` — asserts
   `container.querySelector('iframe')` is **null** after close, not merely hidden
10. `restores focus to the tile that opened the overlay` (Escape)
11. `is reachable through the accessibility tree and opens the dialog` (`name: 'Share this library'`)
12. `the grid, the pills and the header use only palette tokens` — rejects hex, `text-black/`,
    `text-white/` and `rgb()/rgba()`

Plus: the `All` pill's active state, the honest empty-bucket state, the SimSurface routing
(`simboot=` + sandbox + `allow="fullscreen"` + `inert`), the overlay's tokens, and the gradient
tiles.

### Regression suites

| Suite | Result |
|---|---|
| `client-web` full vitest | **87 files, 1613 tests, all passed** |
| `client-web/__tests__/passiveSimSurfaces.test.tsx` | **23 passed** (was 21 — two added for `allow`) |
| `admin-web` full vitest | **4 files, 44 tests, all passed** |
| `pnpm -r typecheck` (6 projects) | **all Done, zero errors** |
| `pnpm -r lint` | **0 errors** (87 pre-existing warnings, none in new files) |
| `next build` (client-web, production origins) | **succeeds**; `/[slug]/library` and `/[slug]/library/[type]` both in the route table |
| `backend-api` full vitest | **240 passed / 3 skipped / 0 failed — 3546 tests** (after §4.1 and §4.9 were fixed) |

---

## 3. The `VideoEditor.tsx` edit

The plan's §6.1 correction was accurate: line 1360 is `flex items-start justify-between gap-3` with
exactly **two** children, so a sibling inserted before the Extended button would have been spread to
the far side rather than placed beside it.

**Line numbers had not shifted.** The header row was still at 1360 on current main. The share button
is now at **line 1375**, inside a new wrapper opened at **line 1374**.

```tsx
1360  <div className="flex items-start justify-between gap-3 border-b border-border/40 pb-2">
1361    <div className="min-w-0">
1362      <h2 className="text-sm font-semibold text-foreground">Library</h2>
1363-65    <p …>{videos.length} clip… · {sections.length} section…</p>
1366    </div>
1367-73  {/* comment: why the wrapper exists */}
1374    <div className="flex shrink-0 items-center gap-1.5">
1375      <LibraryShareButton projectId={projectId} title={null} />
1376      <button
1377        type="button"
1378        onClick={() => setExtendedLibraryOpen(true)}
1379        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border
                     bg-card px-2.5 text-[10px] font-semibold text-muted-foreground
                     transition-colors hover:bg-muted/60 hover:text-foreground focus-ring"
1380        title="Manage the avatar's basic and extended visual library"
1381      >
1382        <Sparkles size={12} strokeWidth={1.9} aria-hidden />
1383        Extended
1384      </button>
1385    </div>
1386  </div>
```

Share is **first inside the group**, i.e. to the LEFT of Extended. The Extended button's own markup
is byte-identical apart from indentation. `Share2` is imported by `LibraryShareButton`, not added to
`VideoEditor`'s lucide import — as the plan specified. The component import went in at line 19.

---

## 4. Plan claims that turned out to be wrong against current main

### 4.1 Migration 065 must be idempotent — the plan's SQL is not, and it broke two suites

The plan's DDL is bare `CREATE TABLE` / `CREATE INDEX`. Applying it verbatim turned
`src/db/__tests__/migration062.test.ts` and `migration063.test.ts` red with
`relation "library_shares" already exists`. Those suites' *runner hygiene* tests apply every
migration after their target **twice** and assert the schema snapshot is unchanged — so **every
migration in this repository must be re-runnable**, which the plan never mentions and which 058 and
064 both honour with `IF NOT EXISTS`.

Fixed: `CREATE TABLE IF NOT EXISTS`, `CREATE UNIQUE INDEX IF NOT EXISTS` ×2, `CREATE INDEX IF NOT
EXISTS`. Both suites pass again (23 tests).

This is the highest-value discrepancy in this report: the plan's SQL, shipped as written, would have
failed CI on a file nobody would have thought to look at.

### 4.2 "no `project_id` … appears anywhere in the serialized response" is not achievable, and is not a leak

Plan §9, test 6. It is false against current main, for a structural reason:
`SimulationService.ts` stores every package under `simulations/{projectId}/{simId}/…` (lines 2478,
2565, 2881, 3457), and `/sim-public/{key}` serves that key verbatim. A simulation's public URL
therefore *contains* the project id, and `buildLibraryView` cannot remove it without emitting a URL
that does not resolve. Every existing public surface — `/v/{token}`, the permalink player config —
already publishes it for exactly the same reason.

The test was written to the truthful, narrower claim instead, and it is strictly stronger than a
field-name check:

* none of 22 private field **names** appears anywhere in the payload;
* the `share_token`, `org_id` and `created_by` **values** do not appear;
* `video-raw/` (the raw upload key, the one storage key with no public route in front of it) does
  not appear;
* the share **code** appears exactly once — `expect(json.split(share.code)).toHaveLength(2)` — and
  that once is inside `canonicalUrl`, which is the URL the visitor already typed;
* the project id appears **only** inside a simulation URL: the whole response with simulations
  removed is asserted not to contain it, and each simulation URL is asserted to match
  `/sim-public/simulations/{projectId}/`;
* a positive control (`materials` has length 4), because every negative assertion above would pass
  on an empty body.

### 4.3 `VideoEditor` has no `project` object, so `project?.title` does not compile

Plan §6.1 passes `title={project?.title ?? null}`. `VideoEditor`'s props are `{ projectId: string }`
and there is no project state, no `projectTitle`, no title anywhere in the file. `title={null}` is
passed; `LibraryShareDialog` renders "this project" in that case. Wiring a real title would mean
adding a project fetch to the editor, which is outside Phase 1.

### 4.4 The three-component frontend split cannot be built as specified

The plan lists `LibraryMiniSite` (server), `LibraryCard` (server) and `LibraryOverlay` (client). A
server-rendered card cannot carry the `onClick` that opens the overlay, and tests 9 and 10 both
require the tile and the overlay to share client state (which material is open, and which tile to
restore focus to).

Resolved with a fourth small file rather than by distorting one of the three:

* `LibraryMiniSite.tsx` — **server**. Header, item count, and the filter pills as real `next/link`
  anchors. This is what keeps "the filter is the URL" true.
* `LibraryGrid.tsx` — **client**, 59 lines. Owns the open material and focus restoration.
* `LibraryCard.tsx` — the tile. Client, because of `onError` and `onClick`.
* `LibraryOverlay.tsx` — **client**, the dialog only, exactly as specified.

The page still server-renders completely on first request (client components SSR in the App
Router), so the plan's "the visitor's first paint is the finished grid" still holds.

### 4.5 The gradient palette the plan names would fail the plan's own test 12

§7 says to hash the material id into "the `CARD_GRADIENTS` palette used by `PlaylistsPanel.tsx`".
That palette is six hardcoded hex triples (`#6366f1`, `#a855f7`, …) — fixed sRGB values that ignore
the theme entirely, and test 12 rejects hex in the rendered tree. The two requirements are
incompatible and the test is the one that matters.

`LibraryCard` uses six **token** gradients instead (`from-primary/80 via-primary/55 to-primary/25`,
etc.), hashed the same deterministic way. Same behaviour, survives dark mode, passes test 12.

### 4.6 Backend files import shared types from `'shared'`, not `'shared/src/types/…js'`

Minor, but it cost a typecheck cycle. `shared/package.json`'s subpath export is
`"./src/*": "./src/*.ts"`, so `'shared/src/types/library-view.js'` does not resolve from
`backend-api` (TS2307). `PublicCourseQueryService.ts` imports its view types from `'shared'`; the
three new backend files now do the same. `client-web` uses the `'shared/src/types/library-view'`
form, which is correct there — the two workspaces genuinely differ.

### 4.7 Two smaller notes

* **`slugify` already truncates to 80.** The plan's "truncate the base to 66" is still needed and is
  applied on top, since `slugify`'s own cap would leave no room for `-{code13}`.
* **A reserved base is prefixed, not rejected.** The plan says mint should "reject if the base
  collides with `RESERVED_SLUGS`". Refusing to mint a link for a project honestly titled *Media*
  would be the permalink reservation leaking into an unrelated decision, so `libraryTitleBase`
  prefixes it to `lib-media` instead. The reservation still does its actual job: a creator cannot
  claim `library` as a permalink.

### 4.9 There is a SECOND migration registry the plan does not mention, and it is enforced

The plan's §5.6 lists exactly one registration edit: append the filename to the array in
`migrate.ts`. That is not sufficient. `backend-api/src/scripts/check-db.ts` carries its own ordered
list of migration filenames, and two suites enforce it:

* `src/db/__tests__/migration059.test.ts` → `EVERY migration file on disk is registered — no future
  file can go unshipped`, which computes `missingFromRunner` **and** `missingFromCheck` and asserts
  both are empty. Its comment says it was generalised from a real incident: a migration written,
  reviewed and committed, listed by neither runner, so it would never have run anywhere.
* `src/db/__tests__/migration050.test.ts` → `is registered with db:check, along with the 046-049 gap
  it had drifted into`.

Both went red on `065_library_shares.sql`, and both pass now that the filename is in
`check-db.ts:85` as well. Like §4.1, this is a failure that would have reached CI on a file nobody
would have thought to open.

Together, §4.1 and §4.9 mean the plan's migration guidance is incomplete in two independent ways: it
omits the idempotency requirement and it omits the second registry. Any future migration written
from this plan alone will fail CI twice.

### 4.8 One plan claim confirmed correct and worth recording

The §6.1 line-1360 correction was right, and so was the warning it superseded. `hls.js@^1.6.16` is a
`client-web` dependency. `experimental.typedRoutes` is on. `app/[slug]/` had no sibling directories.
`SimSurface` had no `allow` prop. `rateLimit` is the in-process fixed-window limiter described. The
`sim-rum` 60/60s precedent exists. `LocalStorageAdapter.getSimPublicUrl` returns an API-origin URL,
so the origin guard passes in dev and would drop R2 URLs as designed.

---

## 5. Files touched

**New — backend (5)**

```
backend-api/src/db/migrations/065_library_shares.sql
backend-api/src/db/migrations/065_library_shares.rollback.sql
backend-api/src/services/library/LibraryShareService.ts
backend-api/src/services/library/buildLibraryView.ts
backend-api/src/controllers/v1/library-share.controller.ts
backend-api/src/services/library/__tests__/publicLibrary.integration.test.ts
```

**New — shared (1)**

```
shared/src/types/library-view.ts
```

**New — frontend (10)**

```
client-web/lib/libraryApi.ts
client-web/lib/libraryShareClient.ts
client-web/app/[slug]/library/page.tsx
client-web/app/[slug]/library/[type]/page.tsx
client-web/components/library/LibraryMiniSite.tsx
client-web/components/library/LibraryGrid.tsx
client-web/components/library/LibraryCard.tsx
client-web/components/library/LibraryOverlay.tsx
client-web/components/library/LibraryShareButton.tsx
client-web/components/library/LibraryShareDialog.tsx
client-web/__tests__/libraryMiniSite.test.tsx
```

**Edited (11)**

```
backend-api/src/db/migrate.ts                                   ordered array += '065_library_shares.sql'
backend-api/src/scripts/check-db.ts                             the SECOND registry, += '065_library_shares.sql'
backend-api/src/db/schema.ts                                    + library_shares table
backend-api/src/server.ts                                       + import, + registerLibraryShareRoutes (line 595)
backend-api/src/services/permalinkService.ts                    + 7 reserved slugs, + library_shares in permalinkSlugTaken
backend-api/src/services/course/PublishingInvalidationService.ts + computeLibraryInvalidationTargets / dispatchLibraryInvalidation
backend-api/src/services/course/__tests__/statusAndInvalidation.test.ts + 3 tests
shared/src/index.ts                                             + export * from './types/library-view.js'
shared/src/generated/client-v1.ts                               + LibraryShareInfo + 4 owner methods
client-web/lib/sim/SimSurface.tsx                               + allow prop
client-web/components/VideoEditor.tsx                           + import, + the wrapper group
client-web/app/robots.txt/route.ts                              + Disallow: /*/library
client-web/__tests__/passiveSimSurfaces.test.tsx                allow pinned in frameRules + 2 cases
admin-web/components/AdminSimSurface.tsx                        + allow prop
```

31 files, +2612 / −22.

---

## 5a. One deliberate non-finding

An independent checklist pass flagged `updateLibraryShare` in `client-web/lib/libraryShareClient.ts`
as having no caller. That is correct and intended: plan §6.2 specifies `libraryShareClient.ts` as
"**Four** authenticated wrappers", and §5.5 puts the `PATCH` route in Phase 1 while §9 puts the
checkbox/expiry UI that drives it in Phase 2. The wrapper is the client half of a Phase-1 endpoint,
not a placeholder for unfinished work — the alternative (shipping the route with no typed client)
is the contract drift `CLAUDE.md` §5 warns about. Left in place deliberately.

## 6. Verification appendix

Commands run, in order, all from the worktree:

```
pnpm -C podcast-saas --filter shared build
pnpm -C podcast-saas -r typecheck                              → 6/6 Done, 0 errors
pnpm -C podcast-saas -r lint                                   → 0 errors
backend-api:  npx vitest run                                   → see below
client-web:   npx vitest run                                   → 87 files / 1613 tests passed
admin-web:    npx vitest run                                   → 4 files / 44 tests passed
client-web:   npx next build (production origins)              → succeeds, both routes present
```

The `next build` needs `NEXT_PUBLIC_FIREBASE_API_KEY` set — `deploy/scripts/release-verify.sh:52`
supplies `release-verify-placeholder-key` for exactly this reason. Without it the build fails
prerendering `/_not-found` with `auth/invalid-api-key`, which is pre-existing and unrelated.

### Zero-bytes check

The plan asks for this to be a grep in code review. It is:

```
grep -rn "uploadFile\|getPresignedUploadUrl\|createMultipartUpload\|copyObject\|copyPrefix" \
  backend-api/src/services/library backend-api/src/controllers/v1/library-share.controller.ts
→ no matches
```

The feature contains no storage writer, therefore needs no deleter, therefore cannot widen the
writers-vs-deleters asymmetry the 2026-08-19 audit recorded.
