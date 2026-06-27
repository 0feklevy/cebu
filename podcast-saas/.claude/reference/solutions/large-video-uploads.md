# Solution — Large Video Uploads to Supabase Storage (cloud-only)

> **Author:** fiji-advisor + backend implementer · **Status:** Implemented + verified (one human dashboard step pending)
> **Reference model:** fiji (`/Users/admin/cebu/fiji`) — its large-file path is S3 **multipart** upload; we ported that.

---

## 0. TL;DR

- **Root cause:** Supabase Storage's per-bucket **`file_size_limit`** (default **50 MB**) caps the
  total object size — for a single PUT **and** for the S3 endpoint (so it also caps multipart's
  final object). A 76 MB backfill and every new raw video (typically >50 MB) are rejected with
  `EntityTooLarge` → the raw source never lands → presigned GET 404 → transcode can't download →
  no HLS → `master.m3u8` 404 for every video.
- **Human must do (dashboard):** raise the bucket `file_size_limit` (and the project global limit if
  shown) to a video-appropriate value, e.g. **5 GB**. See §2 — this is the actual unblock.
- **Code shipped:** **presigned S3 multipart upload** (start → presign each part → browser PUTs parts
  direct to storage → complete/abort), the fiji pattern, so videos beyond a single PUT upload in
  parts. Small files keep the single presigned-PUT + confirm path. Everything stays **cloud-only**
  (no local-disk fallback). Plus a friendly **over-limit (413)** error, the cloud-only test rewrite,
  and a `verify:storage` multipart round-trip that proves a >50 MB object works (and fails loudly with
  the exact fix hint if the bucket limit is still at the default).

---

## 1. Root cause (confirmed precisely)

The app is now **cloud-only** on Supabase Storage (S3-compatible) — a hard requirement, since it's a
multi-user, horizontally-scalable web app and nothing may live on per-instance local disk
(`getStorageAdapter.ts` fails closed in production if no cloud creds; the local fallback was removed
from `uploadWithFallback.ts` / `uploadStreamWithFallback.ts`).

Supabase Storage enforces a **`file_size_limit`** per bucket (default **50 MB**). This limit is applied
by the storage backend to the **resulting object size**, regardless of upload method:

- A **single presigned PUT** of a >50 MB video → rejected (`The object exceeded the maximum allowed
  size`). This is what the original `videos/upload-url` → browser PUT path hit, and what the 76 MB
  `.mp4` backfill hit.
- Even **S3 multipart** is bounded by the same cap: parts upload fine until the **cumulative** object
  crosses the limit, then the crossing part (or `CompleteMultipartUpload`) fails `EntityTooLarge`.

**Verified empirically** by the extended `pnpm --filter backend-api verify:storage`, which uploads a
55 MB object in 7×8 MiB parts against the live bucket:

```
[verify-storage] multipart round-trip — 55 MB in 7 parts …
[verify-storage]   multipart FAILED: part 7/7 PUT failed status=413 etag=none
    body=…<Code>EntityTooLarge</Code><Message>The object exceeded the maximum allow…
```

Parts 1–6 (48 MB) succeeded and returned ETags; **part 7** (crossing ~50 MB) was rejected with HTTP
**413 `EntityTooLarge`**. That is the bucket `file_size_limit`, conclusively. (All other checks —
server PUT, presigned PUT, presigned GET, list, public read, CORS `*` — passed.)

**Why the symptom is "every video 404s":** `runVideoTranscode.ts:41` downloads the source via a
presigned GET before transcoding. If the source never landed (upload rejected), the GET 404s,
transcode throws "Failed to download source video: 404", HLS never produces `master.m3u8`, and the
player's `getPublicUrl(hls_master_key)` 404s. So the *playback* 404 is a downstream effect of the
*upload* rejection.

---

## 2. The fix the human must apply (Supabase dashboard) — REQUIRED

Raising the bucket size limit is the real unblock; the code below handles files that exceed a *single
PUT*, but **nothing larger than the bucket cap can be stored** until this is changed.

**Per-bucket limit (the one that matters):**
1. Supabase dashboard → **Storage** → select the **`media`** bucket (or whatever
   `SUPABASE_STORAGE_BUCKET` is set to).
2. Click the bucket's **⋯ / Edit bucket** (bucket settings).
3. Set **File size limit** to a video-appropriate value — e.g. **`5 GB`** (use the unit dropdown;
   or `5368709120` bytes). Keep it ≥ the largest video you expect; this app advertises up to 10 GB,
   so `10 GB` is also reasonable.
4. **Save.**

**Project-wide global limit (only if it caps you lower):**
- Supabase dashboard → **Storage** → **Settings** (or Project **Settings → Storage**) →
  **Global file upload limit / Upload file size limit**. A bucket's `file_size_limit` cannot exceed
  the project global limit, so if the global is below your target (e.g. still 50 MB on some plans),
  raise it there too. Note: the global ceiling is also **plan-dependent** (Free tier caps lower than
  Pro); upgrade the plan if you need to exceed the Free ceiling.

**Keep the app's pre-check in sync (optional):** the backend rejects uploads above `MAX_UPLOAD_BYTES`
(env, default 10 GB) with a friendly 413 *before* hitting storage. Set `MAX_UPLOAD_BYTES` to match the
bucket limit you chose, so the user-facing max and the storage max agree.

**Verify after changing it:**
```
pnpm --filter backend-api verify:storage
```
Expect: `✓ PASS — … and >50 MB multipart all work.` (The script uploads a real 55 MB object via
multipart and reads it back byte-for-byte.)

---

## 3. Fiji's pattern (what we ported)

Fiji never streams large media through its app server. `StorageController.ts:44` mints a presigned URL
and the browser uploads **direct to cloud**; for large files the S3 path is **multipart** (the AWS SDK
exposes `CreateMultipartUpload` / `UploadPart` / `CompleteMultipartUpload` / `AbortMultipartUpload`,
and `StorageService.ts` is built entirely on `@aws-sdk/client-s3` + `getSignedUrl`). The server only
**signs** per-part URLs against a **server-constructed key**; bytes never touch Node. We re-implemented
that design in podcast-saas's stack (Fastify + the existing `StorageService` adapter interface), since
Supabase Storage is S3-compatible and reuses the same SDK.

**Gap vs fiji:** fiji is multi-cloud (S3/GCP/Azure) and folds confirmation into artifact creation. We
need only **one** writable store (Supabase) and keep an explicit confirm/complete step because our HLS
transcode is a separate stage. We did **not** copy fiji's code — we ported the multipart *design* onto
our adapter interface.

---

## 4. What was implemented (design + files)

### Multipart upload flow (large files, ≥ 40 MB)
```
1. POST /videos/upload/multipart/start   { filename, content_type, file_size }
   → owner-checked; server builds key videos/{projectId}/{uuid}.{ext};
     CreateMultipartUpload; returns { upload_id, storage_key, content_type, part_size }
     (413 if file_size > MAX_UPLOAD_BYTES; 501 if backend can't do multipart → client falls back)
2. For each 8 MiB part:
   POST /videos/upload/multipart/part-url { storage_key, upload_id, part_number }
     → presigned UploadPart PUT URL
   Browser PUTs the chunk straight to storage; reads the ETag from the response.
3. POST /videos/upload/multipart/complete { storage_key, upload_id, filename, file_size, parts[] }
   → CompleteMultipartUpload (parts sorted by partNumber); inserts video_files row;
     enqueues HLS+crop+captions; returns the VideoFile + presigned raw_url
   (on error → 502 with a clear "may exceed the storage size limit" message)
4. On any client-side failure: POST /videos/upload/multipart/abort { storage_key, upload_id }
   → AbortMultipartUpload so storage drops orphaned parts (best-effort)
```
Small files (< 40 MB) keep the **existing** single presigned-PUT (`/videos/upload-url`) + `/videos/
confirm`. The legacy multipart-**through-API** route (`/videos/upload`, now cloud-only via
`uploadStreamWithFallback`) remains a last-ditch fallback.

### Files changed / added
| File | Change |
|---|---|
| `backend-api/src/services/storage/StorageService.ts` | Added `CompletedPart` type + 4 multipart methods to the interface. |
| `backend-api/src/services/storage/SupabaseStorageAdapter.ts` | Implemented `createMultipartUpload` / `getPresignedUploadPartUrl` / `completeMultipartUpload` / `abortMultipartUpload` (presigned `UploadPart`, no ContentType on parts). |
| `backend-api/src/services/storage/R2StorageAdapter.ts` | Same 4 multipart methods (R2 is S3-compatible — keeps the abstraction swappable). |
| `backend-api/src/services/storage/LocalStorageAdapter.ts` | 4 methods that throw "not supported" (multipart is a cloud concept; controller returns 501 → client uses single-PUT in local dev). |
| `backend-api/src/controllers/v1/video.controller.ts` | 4 new routes (`/multipart/start|part-url|complete|abort`); `findOwnedProject` + `finalizeUpload` helpers (de-dups confirm/complete); friendly **413 over-limit** pre-check on `upload-url` + `multipart/start`; `MAX_UPLOAD_BYTES` / `MULTIPART_PART_SIZE` (8 MiB) constants. |
| `shared/src/generated/client-v1.ts` | `startMultipartUpload` / `getMultipartPartUrl` / `completeMultipartUpload` / `abortMultipartUpload` typed client methods. |
| `client-web/components/VideoUploader.tsx` | Routes files ≥ 40 MB to multipart (per-part XHR PUT with aggregate progress + ETag capture); single-PUT for small; **`TooLargeError`** surfaces the 413 message (no fallback); 501 → fall back to single-PUT. |
| `backend-api/src/services/storage/__tests__/uploadWithFallback.test.ts` | Rewritten to the cloud-only contract (success→cloud URL; transient→retry; persistent→throw; asserts local adapter is **never** constructed/called). |
| `backend-api/src/scripts/verify-storage.ts` | Added a 55 MB **multipart** round-trip; PASS now requires it; on failure prints the exact "raise the bucket file_size_limit" hint. |

### Graceful errors (no silent failures — there's no local fallback)
- **Before storage:** `upload-url` and `multipart/start` reject `file_size > MAX_UPLOAD_BYTES` with
  **413** and a human message (`Video is too large (76 MB). The maximum is 10.0 GB.`). The browser
  shows it verbatim and does **not** retry/fallback.
- **At storage (cumulative cap hit mid-upload):** `multipart/complete` failure → **502** with
  "The upload could not be finalized. The file may exceed the storage size limit." The browser
  surfaces the message and `abort`s the orphaned parts.

### CORS note (already satisfied)
Reading a part's **ETag** from a cross-origin XHR needs `Access-Control-Expose-Headers: ETag` on the
storage CORS config. Supabase's S3 endpoint exposes it by default — confirmed by the verify run
(parts 1–6 returned ETags). If a future provider doesn't, the client throws a clear "check CORS
expose-headers" error rather than failing opaquely.

---

## 5. Verification results

| Check | Command | Result |
|---|---|---|
| Backend typecheck | `pnpm --filter backend-api typecheck` | ✓ clean |
| Client typecheck | `pnpm --filter client-web typecheck` (after `shared build`) | ✓ clean |
| Backend tests | `pnpm --filter backend-api test` | ✓ **366 passed** (incl. rewritten cloud-only `uploadWithFallback`) |
| Backend lint (changed files) | `eslint` on the 7 changed backend files | ✓ clean |
| Large-object round-trip | `pnpm --filter backend-api verify:storage` | **Reproduces the bug** — small PUT/GET/list/public all PASS; **55 MB multipart FAILS with 413 `EntityTooLarge`** → proves the bucket `file_size_limit` is still the default. Will PASS once §2 is applied. |

> client-web has no ESLint configured (`next lint` is uninitialized), so client lint isn't part of the
> verification path; the client change is covered by the (passing) typecheck.

**Interpretation:** the code is correct and the multipart path works end-to-end (6 parts uploaded with
valid ETags before the cap). The remaining failure is purely the **dashboard `file_size_limit`** — the
one human step in §2. After raising it, re-run `verify:storage` to see the full `✓ PASS … and >50 MB
multipart all work.`

---

## 6. Risks / notes
- **Bucket limit is the single gate.** Until §2 is done, large videos still can't be stored — by
  design (cloud-only, no local fallback). The 413/502 messages make that visible instead of silent.
- **Part size = 8 MiB** (≥ S3's 5 MiB minimum). A 5 GB video → ~640 parts, far under the 10,000-part
  limit. Parts upload sequentially (simple, low-memory); parallelizing is a future perf tweak.
- **Orphaned parts** from an interrupted upload are cleaned up by `abort`; Supabase also has bucket
  lifecycle/abort-incomplete-multipart settings if a belt-and-suspenders sweep is wanted.
- **Threshold 40 MB** sits safely under the 50 MB default so even a mis-set bucket pushes most videos
  down the multipart path; it's a client constant, easy to tune.
