# Library Share — the shareable materials mini-site

**Status:** decision-grade plan, ready to build.
**Verification basis:** every file, line number and behaviour cited below was read from **`origin/main` @ `6c7f9bb`** (via `git show origin/main:<path>`), not from the working tree. Anything I could not verify is marked **[unverified]** inline.

> ### ⚠ Read this before writing a line of code
> The working tree at `/Users/ofeklevy/cebu` is on `feat/library-share-minisite` @ `2d187e3`, which is **118 commits behind `origin/main`** (`git rev-list --count HEAD..origin/main` = 118). Its migrations stop at `058`; `origin/main` carries `059`–`064`. Building here would (a) revert fourteen merged PRs including the storage-leak fixes and the fail-closed `ENCRYPTION_KEY` change, and (b) claim migration number `059`, which CI's migration-audit will reject on sight.
> **Recreate the branch from `origin/main` first. The next free migration number is `065`.**
>
> One correction to the briefing that came from that stale tree: `DELETE /api/v1/projects/:id/images/:imageId` is **no longer** a storage leak. On `origin/main` (`images.controller.ts`, the DELETE handler) it deletes the row with `.returning({ storage_key })` and then calls `deleteWithFallback(removed.storage_key)`. Do not carry that risk forward into this plan's risk register.

---

## 1. What we are building

The Library panel in the editor gets a **share icon immediately to the LEFT of the "Extended" button**. Clicking it produces one link. Anyone with that link — no account, no login — opens a small public page that presents all of that project's materials (הקבצים הנלווים): its **simulations, images, videos and sounds**. The page has typed sub-pages, so `/library/images` is its own shareable landing page showing only the images, `/library/simulation` only the simulations, and so on. The look is the owner's own desktop page: a grid of banner tiles, minimal, responsive, tap a tile and it opens full-screen; close it and it unmounts.

The link's path is built from the video's title, so it reads as the title:
`flowvidco.com/the-edge-of-chaos-when-one-bird-changes-the-sky-<code>/library`.

**And it stores nothing.** No zip is built, no HTML file is written, no bytes are copied into the bucket. The page is assembled at request time out of the URLs the materials *already* have, and the assembled HTML lives for 60 seconds in the web container's cache before being thrown away and rebuilt from the database. That is the literal reading of "temporary HTML mini-site" (מיני-אתר HTML זמני), and it is a better one than a generated file: delete a material and it is gone from the page within a minute; revoke the link and the page stops existing.

**Plain-language version.** Today the only way to send someone the stuff attached to a video is to send them the video. This adds a second, separate link that shows only the *materials* — every simulation, image, video clip and sound file in the project — laid out as a small, tidy, phone-friendly page of picture tiles. You get the link from a share button next to "Extended" in the editor. You can narrow it to just some kinds of material, and you can switch it off at any time. It costs no storage, because it is not a copy of anything: it is a page that points at the files that already exist, rebuilt from scratch every minute.

**The five non-negotiables and where each is satisfied:**

| # | Requirement | Where it lands |
|---|---|---|
| (a) | Share icon **left of** the Extended button | §6, `VideoEditor.tsx` header row (line 1360 on `origin/main`) |
| (b) | Title-slug URL with `/library` and typed sub-routes | §2, `app/[slug]/library/…` |
| (c) | Zero / near-zero new stored bytes | §4 — one ~250-byte Postgres row per shared project, zero bucket objects |
| (d) | Minimal + responsive banner/card aesthetic | §7 |
| (e) | Works for anonymous visitors with only the link | §5, `GET /api/v1/public/library/:slug`, no auth |

---

## 2. The URL scheme

Canonical sub-route names are the owner's own words — `/simulation` singular, the rest plural. Aliases 308 to the canonical form.

### Public pages (Next.js, `client-web`)

| Route | File | Renders | Access | Cache |
|---|---|---|---|---|
| `/{librarySlug}/library` | `app/[slug]/library/page.tsx` | All four buckets, with per-type counts | Capability = the slug itself (contains a 64-bit code) | ISR `revalidate = 60`, tag `library-share:{slug}` |
| `/{librarySlug}/library/simulation` | `app/[slug]/library/[type]/page.tsx` | Simulations only | same | same |
| `/{librarySlug}/library/images` | ″ | Images only | same | same |
| `/{librarySlug}/library/videos` | ″ | Video files only | same | same |
| `/{librarySlug}/library/sounds` | ″ | Audio files only | same | same |
| `/{librarySlug}/library/{simulations\|image\|video\|sound\|audio}` | ″ | — | 308 → canonical | — |
| `/{librarySlug}/library/{anything else}` | ″ | — | `notFound()` | — |
| `/{projects.slug}/library[/…]` | same files | Identical page, clean URL, no code in the path | Only when the project is `visibility='public'` **and** has a permalink **and** has a live share | same, second cache key |
| `/{librarySlug}/library/og` | `app/[slug]/library/og/route.tsx` | 1200×630 `next/og` image | same | explicit `Cache-Control` (Phase 2) |

### Public API (`backend-api`, Fastify)

| Endpoint | Auth | Returns |
|---|---|---|
| `GET /api/v1/public/library/:slug` | none (`firebaseAuthOptionalMiddleware`), IP rate-limited | `LibraryView` JSON, or 404 |
| `GET /api/v1/public/library/resolve?title=…` | none, IP rate-limited | `{ slug }` for a human-typed title, or 404 (Phase 2) |

### Owner API (`backend-api`)

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/v1/projects/:id/library-share` | `firebaseAuthMiddleware` + `editableProject` | Current link state, or nulls |
| `POST /api/v1/projects/:id/library-share` | ″ | Mint (idempotent) |
| `PATCH /api/v1/projects/:id/library-share` | ″ | Change type scope / expiry / regenerate slug |
| `DELETE /api/v1/projects/:id/library-share` | ″ | Revoke |

All four return **404, never 403**, on denial — the platform-wide convention (`share.controller.ts`, `permalink.controller.ts`).

### How the slug is built

`librarySlug = slugify(projects.title) + '-' + code13`

* `slugify` is `backend-api/src/services/seo/SlugService.ts` — the existing, pure, unit-tested function. **Verified by executing its algorithm:** `"The Edge of Chaos: When One Bird Changes the Sky"` → `the-edge-of-chaos-when-one-bird-changes-the-sky` (47 chars). It transliterates Hebrew → Latin (niqqud stripped) before kebab-casing, so a Hebrew title yields a readable ASCII slug.
* `code13` = `randomBytes(8)` rendered as 13 lowercase base32 chars (~64 bits of entropy). It lives **inside** the path segment rather than in a `?k=` query param — see §3 for why that is the load-bearing choice.
* The title base is truncated to 66 chars so `base + '-' + 13` never exceeds `MAX_SLUG_LENGTH = 80`.
* A null/unsluggable title falls back to `lib-{first 8 hex of project id}` — deterministic, never a human placeholder, matching `makeSlugBase` precedence.
* The result matches `^[a-z0-9]+(?:-[a-z0-9]+)*$` — the same shape as the DB CHECK constraints, the shared `SlugSchema`, and the `SLUG_SHAPE` regex already hardcoded in `client-web/app/[slug]/page.tsx` (line 14). This matters: **the existing root page already rejects anything else**, so the library slug passes the guard unchanged.

### The literal URL the owner pasted

`flowvidco.com/The Edge of Chaos: When One Bird Changes the Sky/library` has spaces and a colon in the first segment. That segment fails `SLUG_SHAPE`, and no amount of design makes a colon legal in this codebase's slug contract. Phase 2 handles it *gracefully*: the Server Component sees a non-slug first segment, calls `GET /api/v1/public/library/resolve?title=<raw>`, which slugifies the raw text and looks for a live share on a project whose title slugifies to the same base — and on a hit issues `permanentRedirect()` (308) to the canonical URL. This works **inside a Server Component**, so it needs no entry in `client-web/middleware.ts` and therefore adds no per-request backend round-trip to `/c`, `/v` or `/pl` (which is what the `middleware.ts` matcher already costs for those paths).

### Route namespace safety — verified

`git ls-tree origin/main -- podcast-saas/client-web/app` shows `app/[slug]/page.tsx` with **no sibling directories**. Adding `app/[slug]/library/` is a *static child of an existing dynamic segment*: it claims no new top-level path, so it cannot shadow a creator's permalink, and it needs no `RESERVED_SLUGS` entry to function.

We add reservations anyway, defensively, to `RESERVED_SLUGS` in `backend-api/src/services/permalinkService.ts` (line 26): **`library`, `libraries`, `simulation`, `simulations`, `sound`, `sounds`, `sim`**. Verified against the current set: `images`, `videos`, `video`, `media`, `assets`, `public`, `share`, `embed` are already reserved; **none of the six above are.** Without this a creator could claim the permalink `library`, which makes `/library/library` real and confusing, and permanently blocks any future top-level `/library`.

---

## 3. Chosen architecture, and what lost

### Chosen: a dedicated `library_shares` row whose slug carries its own capability, rendered by an ISR Server Component nested under `app/[slug]`

Three properties, in order of importance:

**1. The link is an object with a lifecycle, not an attribute of the project.** A share link is created, scoped to types, optionally expired, and revoked — and after revocation you want to know it existed. `projects` already carries two link lifecycles (`share_token` for `/v/`, `slug` for the permalink) as loose columns, and that is exactly why neither has an audit trail, an expiry, or a rotation story. A table gets all three for free and adds nothing to the hottest row in the schema.

**2. One URL form means one cache key.** The page is fronted by Next ISR, which on this deployment is the *only* cache — verified: `deploy/docker-compose.yml` has no Redis, there is no CDN, and `nginx.conf` declares no `limit_req`. If the same path could be rendered two ways (anonymous-and-cacheable vs. token-bearing-and-uncacheable), then revocation stops being "purge one tag" and starts being "purge one tag and hope no token-bearing copy was cached". Putting the code *in the path segment* collapses that to a single cache key per share, so `revoke → dispatch purge` is complete.

**3. It cannot be broken by an unrelated edit.** This is the decisive one, and it is verified rather than theoretical: `projects.slug` is **mutable and clearable** by `PUT /api/v1/projects/:id/permalink` (`permalink.controller.ts` line 153 → `setSlug` line 206; `null`/`''` clears it), and `client-web/components/PermalinkEditor.tsx` puts that control in front of every creator. Any design that makes `projects.slug` the *first segment of the library link* hands the creator a button that silently 404s every library link they have ever sent.

### Rejected: five new columns on `projects`, with the library URL built on `projects.slug` and an `?k=` query-param token

This was the other candidate spine — `library_visibility`, `library_share_token`, `library_share_enabled_at`, `library_share_types`, `previous_slug` on `projects`, URL `/{projects.slug}/library?k={token}`.

It lost on three specific counts:

* **The permalink coupling above.** Fatal, and verified. It would need a `previous_slug` column plus a redirect resolver just to survive an edit the creator is invited to make, and would still break on a *cleared* permalink, which `setSlug` explicitly supports.
* **Two access semantics on one path.** `?k=` means `/{slug}/library` is sometimes a public ISR page and sometimes a private no-store render. The rejected design was honest about this and handled it (`cache: 'no-store'` on tokened fetches, `Cache-Control: private, no-store`, `robots: noindex`) — but it is three separate correctness obligations where the chosen design has zero.
* **A second visibility enum on `projects`.** `library_visibility` sitting beside `visibility`, both of type `project_visibility`, both meaning different things, is a trap for every future reader of that table. The one genuinely useful thing it bought — a clean, code-free URL — is recovered below without it.

### What was grafted from the rejected design (it had the better instincts in five places)

1. **The clean alias.** When the project is already `visibility='public'` **and** has a permalink **and** has a live share, `/{projects.slug}/library` resolves to the same page with no code in the URL — the owner's literal ask. Crucially it is an *alias resolved through the same share row*, not a second access path, so editing or clearing the permalink degrades the clean form back to the code form instead of breaking anything. The dialog shows the clean form when it exists.
2. **`/resolve?title=`** and the Server-Component 308 for the human-typed URL. Cheap, no middleware, real usability win.
3. **Full `typeCounts` on every response** regardless of the active filter, so the four filter pills always show real totals without over-fetching. This mirrors the `typeCounts` the avatar library endpoint already returns.
4. **The degraded simulation read.** `buildLibraryView` copies the `loadSimulations` retry from `editor-state.controller.ts` verbatim: a full `findMany()` selects `bridge_ack_capable` (migration 055) and `requires_import_maps` (057), so an app image deployed ahead of its migrations raises Postgres 42703 and takes the whole read down. The retry drops exactly those two columns.
5. **`robots: Disallow` in Phase 1**, decided explicitly rather than by omission — the `/[slug]` permalink surface today is neither allowed nor disallowed, which is the gap not to repeat.

### What was killed from both designs

* **A live simulation preview in the grid.** `ExtendedLibraryModal`'s IntersectionObserver lazy-mount is correct for an authenticated editor on a desktop; on an anonymous public page served by one 2-vCPU VM it is a self-inflicted outage. Grid tiles are static. Exactly one sim mounts, on tap, in the overlay.
* **Minting posters for banner images.** A poster's identity is `packageRevision__variantKey__configHash__aspect__quality` and there is deliberately no fallback across identities. A library card has no section, hence no valid identity, so borrowing another identity's poster would be a lie. Phase 1 uses gradient tiles. (Verified: the only non-test writer of `sim_posters` in the whole backend is `scripts/sim-canary-publish.ts` — every other reference reads.)
* **`avatar_visuals` (the Extended library).** The spec names four buckets. Charts, equations and diagrams live only in `visual_spec` jsonb with no storage object at all, and `scope='basic'` rows are a throttled 60-second mirror, not a source of truth. Out of scope; see §10.
* **Per-request `view_count` writes.** `share.controller.ts` fires an unawaited `UPDATE projects SET view_count = view_count + 1` per anonymous hit against a pool capped at `max: 10` (`db/index.ts`). Not copied. See §10 for the bounded alternative.
* **`CREATE INDEX CONCURRENTLY`.** `migrate.ts` wraps every file in one transaction and documents that CONCURRENTLY fails with 25001 and rolls the file back. Not usable.

---

## 4. The storage story — the number is zero objects

**Bucket objects written by this feature: 0.** Not "few" — zero. The feature contains no call to `StorageService.uploadFile`, `getPresignedUploadUrl`, `createMultipartUpload`, `copyObject` or `copyPrefix`. This is checkable as a grep in code review, and it should be one.

**Postgres bytes written: one `library_shares` row per shared project, ~250 bytes**, removed by `ON DELETE CASCADE` when the project is deleted.

Every material URL on the page already exists and is simply re-emitted, using the exact calls `buildPlayerConfig` already makes:

| Material | URL source | Verified at |
|---|---|---|
| Image | `image_files.original_url` verbatim + the stored `crop_x/y/w/h` fractions applied as a CSS transform | `schema.ts` `image_files`; written at upload as `{SUPABASE_URL}/storage/v1/object/public/{bucket}/{key}` (`SupabaseStorageAdapter` `publicBase`, line 91) |
| Sound | `audio_files.url` verbatim | `schema.ts` `audio_files` |
| Video | `storage.getPublicUrl(hls_master_key ?? hls_360p_key)`, only when `hls_status === 'ready'` | `buildPlayerConfig.ts` lines 508–511 — identical precedence |
| Simulation | `storage.getSimPublicUrl(active_revision_entry_key ?? entry_file)`, only when `status === 'ready'`, with the legacy guard `entry_file.startsWith('http') ? entry_file : getSimPublicUrl(entry_file)` | `buildPlayerConfig.ts` line 885; `simulations.controller.ts` lines 126 & 148; `simulationUrlResolver.ts` |

Preferring `active_revision_entry_key` over the mutable `entry_file` is deliberate: revision bytes are immutable and carry a real cache policy, whereas the mutable pointer is served `no-cache`.

**Presigned URLs are deliberately not used.** A 3600-second presign inside a page cached for 60 seconds and linked from a message someone opens tomorrow is a broken link with extra steps.

**What the "temporary HTML mini-site" actually is.** The Next ISR render, held in the `client-web` container's `.next/cache` with `revalidate = 60`. It is a cache and not storage in three checkable senses: it is bounded and self-evicting; it is regenerated from the live database on demand; and it is destroyed on every deploy, because `deploy/scripts/deploy-images.sh` replaces the container from a pinned image (CI forbids that script from containing `pnpm install`, `next build`, `docker build` or `tsc`). It is precisely the mechanism `/c/[courseSlug]` already runs on. The Phase-2 OG image follows the second blessed pattern — `next/og` `ImageResponse` computed per request with an explicit `Cache-Control`, never persisted, exactly as `app/c/[courseSlug]/og/route.tsx` does.

**Consequence for the storage-leak ledger:** the feature adds **no writer**, therefore it needs **no deleter**, therefore it cannot widen the writers-vs-deleters asymmetry the 2026-08-19 audit recorded, and it does not have to wait on the production storage census. Any future decision that *does* write bytes here (library posters — §10) must be an explicit, owner-approved exception, and must write under `{simulations.storage_prefix}/posters/…`, which cascades with the simulation row and is swept by `RevisionService.gc()`.

---

## 5. Backend work

### 5.1 Migration — `065_library_shares.sql` + `065_library_shares.rollback.sql`

Next free number **verified**: `migrate.ts` line 66's hardcoded array ends at `064_avatar_cost_meter.sql`, and the migrations directory on `origin/main` matches. Append the new filename to that array — CI's migration-audit compares the directory against the runner *and* against the previous release tag.

```sql
CREATE TABLE library_shares (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  slug          text NOT NULL,
  code          text NOT NULL,          -- the 13-char capability, also the slug suffix
  include_types text[] NOT NULL DEFAULT ARRAY['simulation','image','video','audio'],
  expires_at    timestamptz,
  revoked_at    timestamptz,
  render_count  integer NOT NULL DEFAULT 0,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT library_shares_slug_shape CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 80),
  CONSTRAINT library_shares_types_chk CHECK (
    include_types <@ ARRAY['simulation','image','video','audio']::text[]
    AND array_length(include_types, 1) >= 1)
);
CREATE UNIQUE INDEX uniq_library_shares_slug ON library_shares(slug);
CREATE UNIQUE INDEX uniq_library_shares_live ON library_shares(project_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_library_shares_project ON library_shares(project_id);
```

No `CONCURRENTLY` (the runner forbids it). Mirror the table in `backend-api/src/db/schema.ts` beside `playlists`; `text('include_types').array()` is a shape the schema already uses (`projects.portrait_ref_urls`, `podcast` `audio_tags`).

`uniq_library_shares_live` pins Phase 1 to one live link per project while leaving room for per-recipient links later with no second migration.

### 5.2 `shared/src/types/library-view.ts` (new)

The public view model, mirroring `shared/src/types/course-view.ts`. A zod schema plus its inferred types, so the client-web boundary can validate exactly as `courseApi.ts` validates `CourseViewSchema`.

```ts
export type LibraryMaterialType = 'simulation' | 'image' | 'video' | 'audio';

export interface LibraryMaterial {
  id: string;                    // the asset row id — no project_id, no storage key
  type: LibraryMaterialType;
  name: string;
  url: string;                   // already-public, already-resolved
  durationSec?: number | null;   // video, audio
  width?: number | null;         // image
  height?: number | null;
  crop?: { x: number; y: number; w: number; h: number } | null;   // image
  captionsUrl?: string | null;   // video, when captions_status === 'ready'
  createdAt: string;
}

export interface LibraryView {
  title: string;
  direction: 'ltr' | 'rtl';
  counts: Record<LibraryMaterialType, number>;
  materials: LibraryMaterial[];
  canonicalUrl: string;
  indexable: false;              // Phase 1
}
```

### 5.3 `backend-api/src/services/library/LibraryShareService.ts` (new)

* `mintShare(project, userId)` — `slugify(project.title)` (truncate base to 66) + `'-'` + `base32(randomBytes(8))`; reject if the base collides with `RESERVED_SLUGS`; insert; on PG `23505` re-mint the code (max 3 attempts) rather than mutating the title base. Idempotent: returns the existing live row if one exists.
* `resolveShare(slug)` → `{ share, project } | null`. Order: (1) `library_shares.slug = slug` where `revoked_at IS NULL` and (`expires_at IS NULL` or `expires_at > now()`); (2) fall back to `projects.slug = slug` **joined to a live share**, and only when `projects.visibility = 'public'`. Returns `null` — never a reason — for every miss.
* `revokeShare(projectId)` — stamps `revoked_at`.
* `libraryShareUrl(share)` — built through `backend-api/src/config/publicOrigins.ts#siteUrl()`, **never** the inline `process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'` that `share.controller.ts` uses in three places. `publicOrigins` throws in production rather than emitting a loopback URL; the inline form is the exact shape of the incident it was written to prevent.

### 5.4 `backend-api/src/services/library/buildLibraryView.ts` (new) — the heart

The `buildPlayerConfig` analogue. One `Promise.all` over the same four reads `editor-state.controller.ts` already performs, filtered by `include_types`:

```ts
const [videoRows, simRows, imageRows, audioRows] = await Promise.all([
  db.query.video_files.findMany({ where: eq(video_files.project_id, id), orderBy: [desc(video_files.created_at)] }),
  loadSimulationsDegraded(id),   // the 42703 retry, copied from editor-state.controller.ts
  db.query.image_files.findMany({ where: eq(image_files.project_id, id), orderBy: [desc(image_files.created_at)] }),
  db.query.audio_files.findMany({ where: eq(audio_files.project_id, id), orderBy: [desc(audio_files.created_at)] }),
]);
```

Then map to `LibraryMaterial[]` using the URL sources in §4. Rules the function enforces, each of which gets a test:

* Only `video_files.hls_status === 'ready'` and `simulations.status === 'ready'` rows are emitted. Half-uploaded and failed materials are invisible, not broken tiles.
* **Emits no storage key, no `code`, no `share_token`, no `project_id`, no `org_id`, no `created_by`, no `bridge_functions`, no `guidance`, no `canary_report`.** This is the `PublicCourseQueryService` discipline and it is the single highest-value test in the suite.
* `counts` is computed over **all four** buckets even when one type is requested.
* **R2 guard.** `R2StorageAdapter.getSimPublicUrl` returns `${R2_PUBLIC_URL}/${path}` — verified — which is *not* a `/sim-public/` path, so `shared/src/sim/simUrl.ts#rebaseSimPublicOrigin` will not rebase it and the frontend `frame-src` (which lists only `'self'`, the API origin, Stripe and the Firebase auth origin) will refuse it: a blank iframe. R2 is not the production writer today, but `buildLibraryView` asserts the sim URL's origin equals the API origin and **drops the material with a logged warning** rather than shipping a frame that renders nothing.
* `direction` comes from a tiny pure `shared/src/text/textDirection.ts` (Hebrew/Arabic block scan over the title). Phase 3 consumes it; Phase 1 emits `'ltr'` unconditionally to keep the contract stable.

### 5.5 `backend-api/src/controllers/v1/library-share.controller.ts` (new)

Registered in `server.ts` beside `registerShareRoutes` (line 592) and `registerPermalinkRoutes` (line 593).

**(1) `GET /api/v1/public/library/:slug?type=` — anonymous**

* `preHandler: [firebaseAuthOptionalMiddleware]`
* `rateLimit('libshare:' + request.ip, 60, 60_000)` from `backend-api/src/lib/rateLimit.ts`, following the `sim-rum` precedent. `request.ip` is trustworthy because Fastify runs with `trustProxy: TRUST_PROXY_HOPS` (a hop count, not `true`) — `server.ts` line 185. Over quota → `429`.
* `resolveShare(slug)`; null → `404 { message: 'Library not found' }`. Unknown, revoked and expired are indistinguishable from outside.
* Paid projects keep the existing contract: `BillingService.hasAccess(userId, 'project', id, project)` and, on denial, the `{ locked: true, content_type, content_id, title, price_cents, currency }` stub that `PaywallOverlay` already renders — never a 403, never a config.
* Explicit `Cache-Control: public, max-age=60, s-maxage=60, stale-while-revalidate=300`. Note this is *new behaviour for a public endpoint here*: verified that `/api/v1/share/:token`, `/api/v1/public/permalink/:slug/config` and `/api/v1/public/courses/*` all return JSON with **no** `Cache-Control` at all.
* One bounded `UPDATE library_shares SET render_count = render_count + 1`. Safe because ISR makes this at most one write per path per 60 s — a cache-*miss* counter, not a visitor counter. Say so in the column comment so nobody later reads it as analytics.

**(2) `GET /api/v1/public/library/resolve?title=` — anonymous** (Phase 2). Same limiter, `Cache-Control: public, max-age=300`. `slugify(title)` → look for a live share whose slug base equals it → `{ slug }` or 404.

**(3–6) The four owner routes.** Every one is `preHandler: [firebaseAuthMiddleware]` then `editableProject(request.params.id, user)` (creator **or** invited collaborator) with `404` on denial — the same two lines every write route in this codebase opens with.

* `GET` → `{ slug, url, cleanUrl, includeTypes, expiresAt, createdAt }` or all-nulls.
* `POST` → mint, idempotent, `201`.
* `PATCH` → zod body `{ includeTypes?: LibraryMaterialType[]; expiresAt?: string | null; regenerateSlug?: boolean }`. Dispatch invalidation on success.
* `DELETE` → `revoked_at = now()`, dispatch invalidation, `204`.

### 5.6 Edits to existing files

| File | Edit |
|---|---|
| `backend-api/src/db/migrate.ts` (line 66) | append `'065_library_shares.sql'` |
| `backend-api/src/db/schema.ts` | add the `library_shares` table |
| `backend-api/src/server.ts` (~line 593) | `await registerLibraryShareRoutes(app);` |
| `backend-api/src/services/permalinkService.ts` (line 26) | add `library`, `libraries`, `simulation`, `simulations`, `sound`, `sounds`, `sim` to `RESERVED_SLUGS` |
| `backend-api/src/services/permalinkService.ts` (`permalinkSlugTaken`) | also query `library_shares.slug`, so a creator can never claim a permalink identical to a live library slug and make `/{x}/library` ambiguous |
| `backend-api/src/services/course/PublishingInvalidationService.ts` | add a **pure, unit-tested** `computeLibraryInvalidationTargets({ slug, cleanSlug })` → paths `/{slug}/library` + the four sub-routes + `/og`, for **both** slug forms; tag `library-share:{slug}`. Plus a `dispatchLibraryInvalidation` twin. This is the only function in the repo feeding `POST /api/revalidate`; a cached route not listed here is never purged. |
| `client-web/app/robots.txt/route.ts` | add `Disallow: /*/library` |

### 5.7 No change required (verified, and worth stating so nobody "helpfully" changes it)

* `sim-public.controller.ts` — its `frame-ancestors ${browserOrigins().join(' ')}` already contains `appOrigin()`, which is where the mini-site lives.
* `config/publicOrigins.ts` / `browserOrigins()` — **must not** be widened. Widening it to admit another origin would simultaneously widen who may frame *every* simulation in the product.
* CORS — all page data is fetched server-side by the Server Component, so nothing crosses an origin from the browser.
* `client-web/middleware.ts` — no 410/308 semantics needed; the alias redirect is a Server Component `permanentRedirect()`. Adding a matcher entry would cost one uncached backend round-trip per request on that path.
* nginx / docker-compose — a Next route and a Fastify route need no infra change; nginx proxies by subdomain with a bare `location /` catch-all.

---

## 6. Frontend work

### 6.1 Where the share icon goes — exactly

**Verified against `origin/main`.** `client-web/components/VideoEditor.tsx`, the Library panel header:

```
1360   <div className="flex items-start justify-between gap-3 border-b border-border/40 pb-2">
1361     <div className="min-w-0">
1362       <h2 …>Library</h2>
1363–65    <p …>{n} clips · {m} sections</p>
1366     </div>
1367     <button                                    ← the Extended button
1368       type="button"
1369       onClick={() => setExtendedLibraryOpen(true)}
1370       className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-[10px] font-semibold text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-ring"
1371       title="Manage the avatar's basic and extended visual library"
1372     >
1373       <Sparkles size={12} strokeWidth={1.9} aria-hidden />
1374       Extended
1375     </button>
1376   </div>
```

**Correction to one of the input designs:** it claimed the button sits "in the same `flex items-center gap-1.5` container". It does not. Line 1360 is `flex items-start justify-between` with exactly **two** children — the title block and the Extended button. A sibling inserted before line 1367 would be spread by `justify-between`, not placed beside Extended.

**The edit:** wrap lines 1367–1375 in a right-hand group and put the share button first inside it.

```tsx
  <div className="flex shrink-0 items-center gap-1.5">
    <LibraryShareButton projectId={projectId} title={project?.title ?? null} />
    <button type="button" onClick={() => setExtendedLibraryOpen(true)} …>   {/* unchanged */}
      <Sparkles size={12} strokeWidth={1.9} aria-hidden />
      Extended
    </button>
  </div>
```

`VideoEditor` already receives `projectId: string` (props interface line 263, destructured line 266). `Share2` is **not** currently in the file's `lucide-react` import (line 4) — it is imported in `ProjectHeader.tsx` — so it is imported by the new component, not added to `VideoEditor`'s list.

### 6.2 New components

| File | Kind | What it is |
|---|---|---|
| `components/library/LibraryShareButton.tsx` | client | `h-8 rounded-lg border border-border bg-card` chrome matching Extended, `<Share2 size={12} strokeWidth={1.9} aria-hidden />`, **`aria-label="Share this library"` + `title`**. Icon-only buttons whose entire content is an `aria-hidden` icon are a named failure in `client-web/__tests__/a11yOperableControls.test.tsx` (ui-ux-003) — the accessible name is mandatory, not polish. Reads state on mount; never mutates on first click. Outline when unshared, primary tint + "Shared" title when live. |
| `components/library/LibraryShareDialog.tsx` | client | Read-only link field + Copy; four include-type checkboxes; expiry select; "Update link to match the new title" (shown only when `slugify(title) !== storedBase`); destructive Revoke behind an inline Yes/No confirm (the `ExtendedLibraryModal` delete pattern). Results in an inline status strip — **never `alert()`**. Modelled on `components/PermalinkEditor.tsx`, which is the house pattern for exactly this UI. Must pass `confirmDialogA11y`-style checks. |
| `lib/libraryShareClient.ts` | client | Four authenticated wrappers. Copy the **zod-validated** shape of `lib/api.ts`'s `createShareToken` / `getShareToken` / `revokeShareToken` (lines 51–92), including its documented lesson (types-010): the read path resolves any failure — transport, status or shape — to a not-shared sentinel, so a malformed token can never be *adopted* and rendered as a plausible link to nothing. |
| `lib/libraryApi.ts` | `server-only` | The `courseApi.ts` twin. `getLibraryPage(slug)` fetches `${BACKEND}/api/v1/public/library/{slug}` with `next: { revalidate: 60, tags: ['library-share', 'library-share:'+slug] }`, validates against `LibraryViewSchema`, returns the same `PageResult<T>` discriminated union. A body that fails to parse is `not_found`, loudly logged — the exact policy `courseApi.getPage` documents. |
| `app/[slug]/library/page.tsx` | server | `export const revalidate = 60`. Guards the segment with the same `SLUG_SHAPE` regex used at `app/[slug]/page.tsx:14`; `notFound()` on miss (Phase 2 adds the `/resolve` + `permanentRedirect` branch). `generateMetadata` sets title/description/OG and `robots: { index: false, follow: false }`. **Does not read `searchParams`** — that would opt the route out of static rendering and destroy the ISR cache. |
| `app/[slug]/library/[type]/page.tsx` | server | Maps `simulation \| images \| videos \| sounds` to a `LibraryMaterialType`; `permanentRedirect()` for the alias set; `notFound()` otherwise. Its own `generateMetadata` ("Simulations — {title}") is what makes each sub-route a real landing page rather than a client-side tab. |
| `app/[slug]/library/og/route.tsx` | route handler | Phase 2. `next/og` `ImageResponse` 1200×630, `Cache-Control: public, max-age=300, s-maxage=86400, stale-while-revalidate=604800` — a direct copy of `app/c/[courseSlug]/og/route.tsx`. |
| `components/library/LibraryMiniSite.tsx` | server | The shell: header, filter pills, grid. See §7. |
| `components/library/LibraryCard.tsx` | server | One banner tile. See §7. |
| `components/library/LibraryOverlay.tsx` | client | The single full-viewport dialog. See §7. |

### 6.3 One small change to a shared component

`SimSurface` (`client-web/lib/sim/SimSurface.tsx`) has **no `allow` prop** — verified; its props are `src, srcDoc, bootHide, visible, frameRef, onLoad, title, className, style, sandbox, interactive, fade, children`. The owner's desktop page opens its iframe with `allow="autoplay; fullscreen; xr-spatial-tracking"`, and a full-screen simulation on a phone wants at least `fullscreen`.

Add an optional `allow?: string` prop. **It must be added to `admin-web/components/AdminSimSurface.tsx` at the same time**: `client-web/__tests__/passiveSimSurfaces.test.tsx` asserts the two components produce *identical DOM for identical props*, precisely to stop them drifting. This is a ~6-line change across two files plus one test assertion — small, but it is a shared-component change and should be reviewed as one.

---

## 7. The mini-site itself

### What ports from the owner's desktop page, and what deliberately does not

The reference (`/Users/ofeklevy/Desktop/short simulations/index.html`, 14 KB, zero dependencies) is a genuinely good artifact and its comments state its own reasoning. **Verified by reading it.**

**Ports:**
* `<button class="banner">` tiles containing an `object-fit: cover` screenshot, a gradient `.scrim`, and a caption block — the tile *is* the control, so keyboard and screen-reader operability come free.
* Progressive caption degradation: name / blurb / change, dropping the lower tiers as height shrinks.
* `svh` units, not `vh`, for the overlay — a phone URL bar must not clip the close button.
* `min-height: 0` on flex/grid children, which is what actually lets tiles shrink.
* **Exactly one iframe mounted at a time, and removed on close.** The desktop page's own comment says removal is what releases the WebGL context and stops the audio. The repo independently documents the same fact (an opacity-0 in-viewport iframe is *not* throttled by browsers), which is why `LibraryOverlay` unmounts rather than hides.
* `role="dialog"` + `aria-modal`, Escape closes, focus restored to the invoking tile.
* `prefers-reduced-motion` kills transitions — here expressed as the existing `html[data-motion="reduced"]` rule in `globals.css`.

**Does not port:** the one-screen, `overflow: hidden`, `100svh`, `grid-template-rows: repeat(4, 1fr)` pin. That page has exactly seven tiles. A project library can have two hundred images. The mini-site scrolls, and the grid is `auto-fill` rather than a fixed row count.

### Layout

* **Header** — project title (as `<h1>`), an item count, and the four filter pills. Minimal: no branding wall, no hero image unless `projects.thumbnail_url` exists.
* **Filter pills** — `All · Simulations · Images · Videos · Sounds`, each with its count from `counts`, rendered as **real `next/link` anchors to the sub-routes**, `href` cast `as Route` (`experimental.typedRoutes: true` is verified on in `next.config.ts`), with `aria-current="page"` on the active one. **The filter is the URL.** That is what makes each filtered view its own shareable landing page, what makes it work with JavaScript disabled, and what keeps client filter state at zero.
* **Grid** — `grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4`, tiles `aspect-video`, `min-h-0`.
* **Sort** — the only piece of client state, reflected into `?sort=` with `router.replace(…, { scroll: false })` and read client-side only, so the server route stays statically cacheable. Phase 2.

### The card

Reuses the house card pattern, which is `components/HomeHero.tsx` (verified):

```
rounded-lg border border-border bg-card text-card-foreground shadow-sm-soft
transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-card focus-ring
```

* **Image** → `<img loading="lazy" decoding="async">` at `aspect-video object-cover`, with the stored crop fractions applied as the same CSS transform the editor's thumbnail uses. Eager for the first row, lazy after — the desktop page's own trick. `onError` hides the `<img>` and reveals the gradient behind it.
* **Simulation / Video / Sound** → a deterministic gradient tile (hash of the material id into the `CARD_GRADIENTS` palette used by `PlaylistsPanel.tsx`) with a type glyph, the name, and a sub-label (duration, or the simulation's bridge-function count).
* **No live simulation in the grid**, ever. See §3.

**Dark mode** is not optional and not free: style **only** with the HSL custom-property tokens — `bg-background`, `text-foreground`, `bg-card`, `text-card-foreground`, `border-border`, `text-muted-foreground`, `.shadow-card`, `.shadow-sm-soft`, `.themed-card`, `.focus-ring`. Verified in `app/globals.css`: the light palette is on `:root`, the dark palette on `html[data-theme="dark"]`, applied by an inline script in `app/layout.tsx`. **Do not copy the existing `/c/` pages** — they hardcode `text-black/50` and are broken in dark mode. That is the single most likely way this page ships looking wrong.

### The overlay

One `role="dialog" aria-modal` full-viewport surface, exactly one child mounted, unmounted on close.

* **Simulation** → `<SimSurface src={url} bootHide={[]} visible={loaded} frameRef={NOOP} interactive allow="fullscreen" title={name} />`. Never a hand-rolled `<iframe>`: `SimSurface` owns the `#simboot=` fragment (dropping it turns a hash-only src change into a full navigation that hard-reloads a live sim), the `allow-scripts allow-same-origin allow-forms` sandbox, and the `inert` + `aria-hidden` + `tabIndex={-1}` rules for a hidden frame. All three are verified in the component source.
* **Video** → a ~60-line hls.js attach with the `canPlayType('application/vnd.apple.mpegurl')` native-Safari path, `const Hls = (await import('hls.js')).default` so the library is not in the first-load bundle. `hls.js@^1.6.16` is already a `client-web` dependency (verified in `package.json`). A `<track kind="captions">` when `captionsUrl` is present.
* **Sound** → `<audio controls preload="none">`. `preload="none"` matters on a 2-vCPU VM with no CDN.
* **Image** → the uncropped original at `object-contain`.

### Empty, loading and error states

* **Empty bucket** (`/library/videos` on a project with no videos) → **200 with an honest empty state**, never a 404. The bucket exists; it has nothing in it. One line of `text-muted-foreground` ("No videos in this library yet") and the pills stay visible with their real counts so the visitor can move to a bucket that has content.
* **Empty library** (nothing at all, or every type excluded) → the same treatment at the top level, plus a single sentence explaining that the owner has not published any materials.
* **Loading** → there is none for the page: it is server-rendered, so the visitor's first paint is the finished grid. Inside the overlay, a simulation shows the `.sim-recovery-spinner`-style cue until `SimSurface` reports `load`; a video shows a poster-less black frame with a spinner. No skeleton grid — a skeleton for content that arrives with the HTML is theatre.
* **Revoked / expired / unknown link** → `notFound()`, i.e. Next's 404. There is no `app/not-found.tsx` in `client-web` today (verified), so this renders Next's default. Phase 2 should add one; it is a two-file change and it is what an owner's mistyped link will actually hit.
* **Backend unreachable or schema mismatch** → `getLibraryPage` returns `not_found` and logs loudly, per the `courseApi` policy. A 404 is a better answer than half a page.
* **A material whose bytes have gone** (deleted image, retired sim) → the tile's image `onError` falls back to the gradient; a sim whose URL fails origin validation is dropped server-side before it reaches the page.

---

## 8. Security & abuse

### Token scope

The 64-bit code authorizes **one project's materials view, read-only, and nothing else**. It is not `projects.share_token`, so it does not unlock `/v/{token}`, the player config, the timeline, chapters, transcripts, branching or the avatar. Minting it does not change `projects.visibility`. Sharing materials and publishing the video stay separate acts.

64 bits behind a 60-request/minute per-IP limiter is not enumerable.

### Revocation, and its honest limit

`DELETE` stamps `revoked_at` and dispatches an ISR purge, so the page 404s within seconds. **Revocation cannot recall the material URLs themselves,** and the share dialog must say so in one line rather than implying a gate that does not exist. Verified reasons:

* Under the production Supabase adapter, `getPublicUrl(key)` returns `{SUPABASE_URL}/storage/v1/object/public/{bucket}/{key}` — permanent, unauthenticated, no expiry, **no media token** (only the Local and R2 adapters mint `hls/` tokens). `image_files.original_url` and `audio_files.url` are that shape already, stored at upload time.
* `/sim-public/*` is unauthenticated **by design** for every key under `simulations/` — the unguessable key *is* the capability. Verified: the handler's only guard is `key.startsWith('simulations/') && !keyHasTraversal(key)`.

This is a pre-existing platform property that every `/v/{token}` share already hands out. The library share does not weaken it — but it publishes *more* keys at once, and it turns previously-obscure keys into ones someone may have bookmarked. That is a disclosure, not a bug, and it belongs in the dialog copy: *"anyone who saved a file keeps it."* Real recall would require gating `/sim-public` plus signing image/audio URLs — a platform change, not a library-share change.

Worth noting for symmetry: on the **local and R2** adapters, `getPublicUrl` for an `hls/` key embeds a day-quantized HMAC media token valid 7–8 days, so an HLS URL there outlives a revoke by up to a week. Production (Supabase) has no such token, and no expiry either.

### Leak prevention

* `buildLibraryView` emits a public-only view model (§5.4). The "no storage key, no code, no ids" assertion is a test.
* Only `status='ready'` rows are exposed.
* `include_types` is enforced **in the query**, server-side. An excluded type is *absent from the payload*, not hidden by CSS, and its sub-route 404s. Client-side hiding of data the server already sent is not scope control.
* Denials are 404, never 403, for unknown / revoked / expired alike.

### CSP — no change is needed, and none is permitted

* `shared/src/csp.ts` line 107 emits `frame-ancestors 'none'` unconditionally for every app page, and `ops/release/src/csp-audit.ts` raises a **HIGH** release finding for anything else. The mini-site is not embeddable, and must not become so.
* Simulation iframes work **today, with zero CSP work**, and the reason is worth stating precisely: the page is served from the app origin; `buildFrontendCsp`'s `frame-src` already lists the API origin (for `/sim-public`); and `/sim-public`'s own response CSP sets `frame-ancestors ${browserOrigins().join(' ')}`, which already contains `appOrigin()`. Both directions are satisfied by construction.
* `img-src 'self' data: blob: https:` covers Supabase images; `media-src 'self' blob: https:` covers hls.js MSE blobs and Supabase audio; `connect-src 'self' https: wss:` covers segment fetches.
* **This is the decisive argument for keeping the mini-site a `client-web` route.** Serving it from any other origin would require adding that origin to `browserOrigins()` — which would simultaneously widen who may frame *every simulation in the product*.
* No `srcDoc` is used anywhere in this feature, so the "a same-origin sandboxed document can strip its own sandbox" hazard cannot arise.

### Rate limiting and capacity

* `rateLimit('libshare:' + ip, 60, 60_000)` on both public endpoints. Verified: `backend-api/src/lib/rateLimit.ts` is an in-process fixed-window `Map` with an unref'd cleanup timer, explicitly documented as per-process and inadequate for multi-instance. `deploy/nginx/nginx.conf` declares **no** `limit_req` or `limit_conn` anywhere, and there is no Redis in the production compose file. This limiter is the only request-level protection that exists.
* **The real defence is architectural.** ISR at `revalidate = 60` means N anonymous visitors cost at most one backend render per path per minute, against a DB pool of `max: 10` per container (`db/index.ts`). That is also what makes the bounded `render_count` increment safe.
* What ISR does **not** bound is media egress. A shared library that lets anonymous visitors stream HLS and load a heavy WebGL simulation is the heaviest thing this deployment can be asked to serve. Mitigations already in the design: no live sim in the grid, exactly one sim mounted at a time, hard unmount on close, `preload="none"` on audio, lazy images.

### Owner-side auth

All four mutation routes are `firebaseAuthMiddleware` + `editableProject(projectId, user)` — creator or invited collaborator — with 404 on denial. No new authorization model, no per-asset ACL, no per-asset visibility flag.

---

## 9. Phased plan

### Phase 1 — one link, four material types, typed sub-routes — **shippable alone**

**Scope.** Recreate the branch from `origin/main` and confirm `065` is still free. Migration + schema table. `LibraryShareService` + `buildLibraryView` + `library-share.controller.ts` (five routes) registered in `server.ts`. `RESERVED_SLUGS` + `permalinkSlugTaken` extension. `shared/src/types/library-view.ts`. `lib/libraryApi.ts` + `lib/libraryShareClient.ts`. `app/[slug]/library/page.tsx` + `app/[slug]/library/[type]/page.tsx` with the four canonical sub-routes and their aliases. `LibraryMiniSite` + `LibraryCard` + `LibraryOverlay`. `LibraryShareButton` wired left of Extended, plus `LibraryShareDialog` with copy + revoke. The `allow` prop on `SimSurface` **and** `AdminSimSurface`. `robots` Disallow. ISR `revalidate = 60` with purge on revoke. Per-IP rate limit.

**Files touched:** ~8 new backend files, ~10 new frontend files, 7 edited files (`migrate.ts`, `schema.ts`, `server.ts`, `permalinkService.ts`, `PublishingInvalidationService.ts`, `VideoEditor.tsx`, `robots.txt/route.ts`) plus the two SimSurface files and their parity test.

**Effort:** 6–8 working days, one engineer.

**The tests that prove it works.**
Backend (`backend-api/src/services/library/__tests__/publicLibrary.integration.test.ts`, PGlite, node env — 60 s timeouts because PGlite boots real WASM Postgres and replays every migration):
1. mint is idempotent; a second POST returns the same slug;
2. a slug collision (forced `23505`) re-mints the code and succeeds within three attempts;
3. revoked → 404; expired → 404; unknown → 404 — all three byte-identical responses;
4. a type excluded from `include_types` is absent from `materials` **and** its sub-route 404s;
5. a `status='processing'` simulation and a non-`ready` video are omitted;
6. **the shaping test:** no `storage_key`, `code`, `share_token`, `project_id`, `org_id` or `created_by` appears anywhere in the serialized response — asserted over the whole JSON string, not field by field;
7. `counts` covers all four types even when `?type=images`.

Frontend (`client-web/__tests__/libraryMiniSite.test.tsx`, jsdom):
8. the four pills render the four hrefs and mark the active one with `aria-current="page"`;
9. opening a simulation mounts exactly one `SimSurface`, and closing **unmounts** it (assert the iframe is gone from the DOM, not merely hidden — this is the WebGL-context guarantee);
10. Escape closes and focus returns to the invoking tile;
11. the share button resolves through the accessibility tree by its name (the `a11yOperableControls` rule);
12. no hardcoded hex or `text-black/` in the rendered tree (the dark-mode guard).

Note the coverage blind spot this compensates for: `backend-api/vitest.config.ts` measures coverage over `src/services/**` only, so a new **controller** can be entirely untested without moving the number. Tests 1–7 are the only thing preventing that. There are currently no controller tests for `share.controller.ts` or `permalink.controller.ts` — do not inherit that.

---

### Phase 2 — owner control, freshness, and the pasted URL

**Scope.** Per-type checkboxes and expiry wired to `PATCH`. "Update link to match the new title" (mint new, revoke old). `GET /api/v1/public/library/resolve?title=` plus the Server-Component `permanentRedirect` branch, so the owner's literal pasted URL works. `computeLibraryInvalidationTargets` called from the six asset mutation paths (image/audio/video/simulation create + delete, and simulation status → ready) so the page refreshes the moment materials change rather than within 60 s. The `/og` `ImageResponse` route. Sort + in-page search over the already-fetched list. A live-link badge on the share button. `app/not-found.tsx`.

**Files touched:** `library-share.controller.ts`, `PublishingInvalidationService.ts` + its test, six existing asset controllers (one dispatch line each), the two page files, `LibraryShareDialog`, one new route handler, one new page file.

**Effort:** 3–4 days.

**The test that proves it:** a unit test on the pure `computeLibraryInvalidationTargets` asserting it returns all six paths for **both** slug forms and the `library-share:{slug}` tag (the existing `statusAndInvalidation.test.ts` is the pattern); plus an integration test that deleting an image dispatches invalidation with that project's live share slug; plus a route test that `/{title with spaces}/library` 308s to the canonical URL.

---

### Phase 3 — Hebrew/RTL, presentation polish, release gating

**Scope.** `shared/src/text/textDirection.ts` plus `lang`/`dir` on the library page root and logical CSS (`ms-`/`me-`/`text-start`) throughout — this would be the **first `dir`-aware surface in `client-web`**. Verified: there is no `dir=` attribute anywhere in `client-web`, `app/layout.tsx` line 55 hardcodes `<html lang="en">`, and there is no i18n library, locale routing or message catalogue. A locale-correct date/duration formatter instead of the hardcoded `Intl.*Format('en'|'en-US')` helpers copied around `components/`. Optionally: library-identity simulation posters via `sim-canary-publish.ts --apply` — an explicit, owner-approved exception to the zero-bytes rule (§10). Add the route to `ops/release/src/config.ts` `requiredPublicRoutes` (today it contains exactly `[/^\/health\/?$/i]`) and to the production-audit page list, behind a permanently seeded demo share.

**Effort:** 4–5 days.

**The test that proves it:** a jsdom test that a Hebrew title yields `dir="rtl"` on the page root and that no physical-direction utility (`ml-`, `pr-`, `text-left`) appears in the library component tree; plus a green production audit against the seeded demo share.

---

## 10. Open decisions for the owner

Each with the default I recommend if no answer comes back.

1. **Clean URL or coded URL by default?** The link always contains a short code unless the project is already public with a permalink, in which case a clean `/{permalink}/library` also works. Do you want the dialog to *offer to make the project public* so the clean form appears?
   **Default: no.** Sharing materials should not silently publish the video. Show the clean form when it already applies, and say why it does not when it does not.

2. **Should the library page be indexable by Google?** Phase 1 is `Disallow: /*/library` on both URL forms.
   **Default: keep it noindex.** A title-derived URL that is *guessable* is one thing; one that is *searchable* is another. Revisit only for the clean public form, and then it needs a sitemap entry, JSON-LD and a canonical.

3. **Do you want view counts?** Phase 1 counts cache-miss renders (`render_count`), which undercounts — many visitors, one increment per minute.
   **Default: keep `render_count` and label it honestly.** Real per-visitor analytics needs a batched counter or a beacon endpoint; copying the existing unbounded per-request `UPDATE` against a ten-connection pool would be a regression, not a feature.

4. **Should the mini-site have a "watch the video" button?** Today it shows materials only.
   **Default: no in Phase 1.** Adding it means deciding whether the library link also grants access to the video, which is a visibility decision, not a UI addition.

5. **Should visitors be able to download materials, or only view them?** Images and sounds are already downloadable by URL (they are plain public URLs); video is not, because no presign is emitted.
   **Default: view only, no download affordance.** The spec says "presentation" (הצגה מסודרת). Adding a download button turns a viewing page into a distribution page.

6. **Are real simulation banner images worth bytes?** Phase 1 uses gradient tiles. Real posters need a `variantKey: 'library'` capture through `sim-canary-publish.ts --apply`, writing to `{storage_prefix}/posters/{identity}/` — sweepable via the simulation cascade and `RevisionService.gc()`, but it breaks the zero-new-bytes promise and needs a canary run per package.
   **Default: gradients.** Revisit once the production storage census has actually been run. **[unverified: how many simulations currently have posters in production — there is no approved production connection from this workspace.]**

7. **Hebrew: RTL interface, or Hebrew content inside English chrome?** Phase 3 assumes a `dir`-aware layout driven by the title's script, with English button labels.
   **Default: `dir`-aware layout, English chrome.** Translating the chrome ("Simulations", "Sounds") is a separate and larger decision because there is no i18n infrastructure at all.

8. **One link per project, or several with different scopes?** The table already supports several (one images-only link for a designer, one full link for a collaborator); only the `uniq_library_shares_live` index and the dialog would change.
   **Default: one.** Ship one, add more if anyone asks.

9. **Should a broken library page block a release?** Adding it to `ops/release/src/config.ts` `requiredPublicRoutes` means a regression fails every deploy — but it needs a permanently seeded demo share to be auditable.
   **Default: yes, in Phase 3, once the page is stable.**

10. **Do you want the "Extended" (avatar) materials — charts, equations, diagrams — on the page too?** The spec names four buckets; those live in a different table with different delete semantics, and three of the five types have no stored file at all.
    **Default: no.** But note the share button will sit right next to the Extended button, so the question will get asked. If yes, it is a fifth bucket with its own scope flag, not a reuse of `include_types`.

11. **Do the seven simulations on your Desktop (`~/Desktop/short simulations`, 65 MB, seven packages) need to appear on a shared library?** They are not FlowVid `simulations` rows — they are loose folders served with `python3 -m http.server`. **[verified: the folder and its `assets/` of hand-captured JPEGs exist; the packages pull `three@0.169.0` and `chart.js` from jsDelivr, so they are not offline-self-contained.]**
    **Default: no — this is a content task, not a design one.** Uploading them through the existing `SimulationUploader` into a project makes them appear automatically.

---

## Appendix — risk register

| Risk | Severity | Mitigation / status |
|---|---|---|
| Building on the 118-behind working tree | **Blocking** | Recreate the branch from `origin/main` @ `6c7f9bb`; use migration `065` |
| Revocation cannot recall already-fetched material URLs | High, inherent | Stated in the dialog copy; pre-existing platform property, not introduced here |
| A shared library publishes previously-obscure `/sim-public` keys | Medium, inherent | Same; the key is the capability by design |
| R2 adapter sim URLs are on a third origin → blank iframe | Medium, latent | `buildLibraryView` asserts origin and drops the material with a warning; R2 is not the production writer |
| Anonymous WebGL + HLS load on a 2-vCPU VM with no CDN | Medium | Static grid tiles, one sim at a time, unmount on close, `preload="none"`, ISR |
| A revoked link served from a stale ISR entry | Low | Purge on revoke; but `dispatchInvalidation` is best-effort and no-ops without `REVALIDATE_URL`, so the true worst case is 60 s. Documented, not assumed away. |
| The frozen slug drifts from an edited title | Low | "Update link to match the new title" in Phase 2 + explicit dialog copy in Phase 1 |
| New controller ships untested (coverage measures `src/services/**` only) | Low | The seven integration tests in Phase 1 are the guard |
| `typedRoutes` build failure on a dynamic `href` | Low | Every pill href cast `as Route` |
| The page ships looking wrong in dark mode | Low | Token-only styling; test 12 |
