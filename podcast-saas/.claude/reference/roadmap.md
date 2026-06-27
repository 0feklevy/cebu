# podcast-saas — Approved Roadmap & Product Decisions

Locked by the product owner on 2026-06-27 (in response to the review + the presigned-storage design
[`solutions/presigned-storage.md`](solutions/presigned-storage.md)). This is the source of truth for the
agreed direction. **Nothing is committed yet — awaiting explicit commit approval.**

## Locked decisions
| # | Decision | Verdict |
|---|---|---|
| Hosting | **Path B** — keep Postgres/Supabase; deploy on a Postgres-friendly host. **Do NOT** migrate to GoDaddy/MySQL. | ✅ |
| Storage provider | **R2 with real write credentials** preferred; **Supabase Storage** behind the existing `StorageService` abstraction if write keys are unavailable. | ✅ |
| Storage model | Adopt fiji's **presigned-URL** model, phased: writable storage → direct uploads → direct playback → visibility/tokens → scale-out. | ✅ |
| Visibility | Explicit **private / unlisted / public** per project. Drafts are **not** world-readable by id. Anonymous viewers reach only public projects or valid share links. | ✅ |
| Captions | Generate at **processing time**, not lazily on first public view. | ✅ |
| Avatar "Ask" | Stays **public for anonymous viewers**, but add a **per-project/day budget cap** (admin portal + setting) and **server-issued scoped session tokens** (no client `Math.random()` keys). Persona/library/memory are public-viewer content only if explicitly intended. | ✅ |
| Errors | **Clean all user-facing errors** (generic to users, detail in logs) — fiji-style. | ✅ |
| Accessibility | **Full dialog a11y** (focus trap, Esc, labels) — education/institutional users in scope. | ✅ |
| Editor feedback | **No silent failures** — surface errors to the editor. | ✅ |
| Re-transcode | **Versioned/atomic** HLS replacement; lower priority unless re-processing existing videos is common. | ✅ |
| Sharing/URLs | Human share links are always **app URLs**; app mints fresh media URLs per load. | ✅ |
| Thumbnails/OG | **Public + stable** for public and unlisted/shared projects (video stays gated); private drafts use a placeholder / avoid exposing sensitive frames. | ✅ |
| Migration style | **Dual-read** — new media to cloud, legacy local keeps working, then backfill + retire local serving. | ✅ |
| Correlation IDs | Yes eventually, **low priority**. | ✅ |
| Read-only auto-detect (backend-001) | **Skip** — fix storage properly instead. | ❌ skip |
| Keepalive dep for current proxy (fiji-storage-005) | **Defer** — presigned/CDN replaces the proxy. | ⏸ defer |
| Multi-instance/worker tier | **Not now** — Phase 5, after storage. | ⏸ later |
| Housekeeping | Safe cleanups only, no feature changes, no commit without approval. | ✅ |

## Ownership — what gates the big work
**The storage migration (Phases 1–5) is blocked until the product owner provides writable storage.**
That is *your* action, not a code change I can make:
- **Preferred:** issue a Cloudflare R2 token with **Object Read & Write** and set the real `R2_*` values
  (the `R2StorageAdapter` already exists and auto-detects real vs placeholder creds), **or**
- **Fallback:** confirm we use **Supabase Storage** (I then add a `SupabaseStorageAdapter` behind the
  existing interface — ~M effort).
- Also confirm the **Path-B host** so deploy/config targets the right environment.

Until then, presigned uploads/playback/visibility can't be tested or shipped (a presigned PUT needs write
authority; a presigned GET needs the object to exist in the bucket).

## Phase plan (agreed order)
- **Phase 0 — Interim hardening — ✅ DONE** (traversal/auth/streaming/delete-fallback/graceful-shutdown,
  shipped in the review fix batches; uncommitted, awaiting approval).
- **Phase 1 — Unblock writes** *(code done; verification needs YOUR Supabase provisioning)* —
  `SupabaseStorageAdapter` implemented behind `StorageService`; `getStorageAdapter` prefers it when
  `SUPABASE_S3_*` creds are present (or `STORAGE_BACKEND=supabase`); `pnpm --filter backend-api verify:storage`
  does the PUT→exists→GET round-trip. **Confirmed R2 is read-only** (live log: `[R2] CORS … AccessDenied 403`),
  so Supabase is the provider. **Remaining (yours):** create a Supabase Storage bucket + S3 access keys, set
  `SUPABASE_URL`, `SUPABASE_S3_ACCESS_KEY_ID/SECRET`, `SUPABASE_S3_REGION`, `SUPABASE_STORAGE_BUCKET`, then run
  verify. (I can't load `.env` to run it myself — the never-read-`.env` boundary.)
- **Phase 2 — Presigned uploads** *(M)* — `POST …/videos/upload-url` (+`/confirm`), editor PUTs direct to
  cloud with a real progress bar; **enqueue transcode + captions on confirm (write-path)** — this is also
  where the captions-at-processing decision lands; remove the read-path enqueues from `buildPlayerConfig`.
- **Phase 3 — Direct playback** *(M)* — CDN-public for public HLS / presigned GET for private; retire
  `/hls-proxy`; version HLS keys per transcode run (atomic re-transcode).
- **Phase 4 — Visibility + scoped tokens** *(M)* — add `visibility` (private/unlisted/public) + a
  `requireProjectAccess()` gate; mint scoped capability tokens for share links and the avatar session;
  gate player-config on published-or-shared; keep thumbnails public+stable.
- **Phase 5 — Scale-out** *(L, later)* — externalize ffmpeg/caption/crop into a bounded queue/worker;
  replace in-process dedup with pg advisory locks; then enable multiple instances.

## Implemented now (unblocked, this session — NOT committed)
These approved items have no dependency on the storage migration and are already in the working tree:
- **Clean user-facing errors** (#6): avatar controller no longer echoes raw exception text; logs the cause.
- **Dialog accessibility** (#7): `AvatarPopup` now traps focus, restores it on close, and has `aria-labelledby`
  (it already had `role="dialog"`/`aria-modal`/Esc). *Remaining dialogs (e.g. ProjectSettingsPanel) to follow.*
- **Editor feedback** (#8): rename/delete failures in `HomeSidebar` are surfaced (no silent swallow).
- (Earlier batches already shipped: ffmpeg cap, streaming, SSRF guard, delete fallback, avatar rate-limit +
  size caps, reorder transaction, error-handler sanitization, contract fixes, caption-loop fix, a11y tap
  surfaces + toggles, crypto session id.)

## Deferred to their phase (not done now, by decision)
- Captions-at-processing → **Phase 2** (write-path enqueue; avoids breaking lazy generation mid-migration).
- Visibility model + scoped tokens → **Phase 4** (needs the schema + token work alongside storage).
- Versioned HLS keys → **Phase 3**. Correlation IDs → low priority, any time. Worker tier → **Phase 5**.
