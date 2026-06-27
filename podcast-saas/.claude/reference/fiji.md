# Fiji — Reference Architecture Knowledge Base

> Curated, verified notes on the **fiji** project, used by the `fiji-advisor` agent to ground
> solutions for podcast-saas. Fiji is a mature, scalable, production platform; podcast-saas should
> borrow its **patterns** (not its exact code — different stack). Read this first, then open the
> real fiji source to confirm details before recommending anything.

- **Location:** `/Users/admin/cebu/fiji` (separate GitLab repo `lliansky-group/fiji`, gitignored by cebu — never committed into podcast-saas).
- **Fiji's own docs (authoritative, read them):** `/Users/admin/cebu/fiji/.claude/docs/` —
  `architecture.md`, `deployment.md`, `fijiserver.md`, `fijiweb.md`, `fijiadmin.md`, `fijicomm.md`,
  `fijicapture.md`, `fijiframework.md`, `testing.md`, `shared-and-scripts.md`.
- **Production domain:** simuvibe.com (see `nginx.conf`).

## Stack at a glance (and how it differs from podcast-saas)
| | **fiji** | **podcast-saas** |
|---|---|---|
| Backend | Express + **TSOA** (decorators → OpenAPI) | Fastify, hand-written routes |
| DB | **MongoDB** + Mongoose | **Postgres**/Supabase + Drizzle |
| Frontend | React + **Vite** (fijiweb, fijiadmin) | **Next.js** App Router (client-web, admin-web) |
| Auth | **Firebase** + scoped RS256 artifact tokens | Firebase middleware (`firebaseAuthMiddleware`) |
| Storage | **Multi-cloud `StorageService`** (S3/GCP/Azure) + presigned URLs + auth proxy | R2 read-only → **local-disk fallback served via raw `path.join`** ⚠️ |
| API client | **Generated** from OpenAPI (`generate-stubs:web/admin`) | **Hand-maintained** `client-v1.ts` (drifts) |
| Real-time | fijicomm (Socket.io, Redis adapter) | n/a |
| Deploy | Docker Compose + nginx reverse proxy | GoDaddy Node.js Hosting (single app) |

**Translation rule:** port fiji's *design*, adapt to Fastify/Drizzle/Next/Postgres. Don't copy
Mongoose/TSOA/Express code verbatim.

## Module map (ports)
| Package | Purpose | Port |
|---|---|---|
| `fijiserver` | REST API, AI orchestration, **storage** (Express + TSOA) | 8080 |
| `fijicomm` | Real-time WebSocket (Socket.io, optional Redis adapter for horizontal scale) | 8090 |
| `fijiweb` | User frontend (React + Vite) | 3000 |
| `fijiadmin` | Admin dashboard (React + Vite) | 3001/8001 |
| `fijiframework` | Client-side JS modules bundled into artifacts | — |
| `fijicapture` | Screenshot/video service (Playwright browser pool) | 3091/8092 |
| `fijisfu` | WebRTC media routing (mediasoup) | — |
| `shared` | constants + version | — |

---

## ★ Storage & public links — the headline pattern (solves podcast-saas's P0)

**Fiji never serves user media by `path.join(localDir, userKey)`.** That single decision is why
fiji has none of podcast-saas's local-storage problems (P0-1/P0-2 traversal, R2-read-only fallback,
unbounded buffering). The model has three pillars:

### 1. `StorageService` — multi-cloud object storage abstraction
`fijiserver/src/services/StorageService.ts` (static class). Verified surface:
- Providers: **AWS S3 / GCP Cloud Storage / Azure Blob**, selected by `STORAGE_PROVIDER` env.
- S3 uses **`agentkeepalive`** (`maxSockets: 50`) for connection pooling / socket rotation → scales.
- Methods: `uploadFile`, `downloadFile`, `deleteFile`, `deleteFiles`, `copyFile`,
  `getPresignedUrl` / `getPresignedUrlForDownload` / `getPresignedUrlForUpload`.
- **Presigned-URL cache:** in-memory `Map`, 30-min TTL, under the 1-hour URL expiry (`presignedUrlCache`).
- **Storage keys are server-constructed**, structured paths:
  `artifacts/{artifactId}/v{version}/{file}`, `drafts/{tempId}/{file}`, `framework/{module}/{version}/...`,
  `videos/{artifactId}-{timestamp}.webm`. The client never supplies a raw filesystem path.
- Config: `fijiserver/src/env.ts` (`STORAGE_PROVIDER`, `STORAGE_BUCKET`, `AWS_S3_BUCKET`,
  `AWS_ENDPOINT` for MinIO/S3-compatible, `GCP_BUCKET`, `AZURE_*`).

### 2. Presigned URLs — uploads/downloads bypass the app server
`fijiserver/src/controllers/v1/StorageController.ts` (`@Route('storage')`):
- `POST /storage/upload-url` `@Security('firebase')` → returns a **presigned PUT URL**; the client
  uploads **directly to cloud**. **No bytes flow through Node** → no buffering, no memory blowup,
  no app-bandwidth bottleneck (contrast podcast-saas `perf-001` `arrayBuffer()` buffering and the
  `PUT /local-storage/upload/*` write path).
- `POST /storage/thumbnail-url` → same pattern for thumbnails.
- Downloads: `StorageService.getPresignedUrl(file)` returns a short-lived signed GET URL; callers
  like `ArtifactService` set `dto.thumbnailUrl` / `dto.videoUrl` to presigned URLs
  (`ArtifactService.ts:1151,1173`). Browser fetches from cloud/CDN, not from Node.

### 3. Auth-scoped proxy — when bytes must pass through (per-object authorization)
`fijiserver/src/controllers/v1/StorageProxyHandler.ts` — `GET /api/v1/storage/proxy/{filePath}`:
- Wildcard path is used as a **cloud object key** for `StorageService.downloadFile({ key: fullPath })`.
  Because it's an S3/GCS key (not `path.join` on the local FS), **OS path traversal to read
  arbitrary files is structurally impossible** — the worst case is another object in the same bucket,
  which is gated by authorization.
- **Per-object authorization** before serving: `checkArtifactAccess()` / `checkVideoAccess()` resolve
  the artifact from MongoDB and allow only if **`artifact.isPublic`**, OR the requester is the
  **owner**, OR an **admin**, OR presents a **valid scoped artifact token**, OR is localhost (internal
  services). Otherwise **403**. → "Public link" = the `isPublic` flag on a real record, evaluated at
  serve time — *not* a path prefix like podcast-saas's `startsWith('hls/')`.
- Content-Type from an extension allow-list (`getContentTypeFromPath`).

### Why podcast-saas hits problems fiji doesn't
- podcast-saas `server.ts:104/127/187/312` does `readFile(join(LOCAL_STORAGE_BASE_DIR, key))` guarded
  only by `key.startsWith('hls/')` → `hls/../../etc/passwd` escapes (P0-2). Fiji's key→object-store
  mapping + per-object auth removes the entire class.
- podcast-saas `PUT /local-storage/upload/*` (P0-1) writes the request body to a client-controlled FS
  path with no auth. Fiji uses **presigned PUT to cloud** — the server only signs a server-built key;
  the client can't pick an arbitrary path, and the upload doesn't touch the app's disk.
- podcast-saas R2 token is read-only → fragile local fallback. Fiji writes to a **writable** bucket via
  presigned PUT, with a clean delete abstraction (`StorageService.deleteFile`) — no "delete is a no-op"
  bug (podcast-saas `backend-003`).

**Port for podcast-saas (concrete):** introduce a `StorageService`-style abstraction with a writable
object store (real R2 write creds, or S3/Supabase Storage), issue **presigned upload URLs** from the
backend with **server-constructed keys**, serve media as **presigned download URLs** (or a
`/storage/proxy` that maps key→object-store + checks a DB `is_public`/owner/token), and **delete the
raw `/local-storage/*` + `/local-storage/upload/*` FS routes** (or, as an interim, add resolve()-
containment + auth + `is_public` checks — see review FIX_PLAN P0-1/P0-2).

---

## Contract generation — antidote to podcast-saas's drift (types-001/002/003)
Fiji defines routes with **TSOA decorators** on controllers; `yarn generate-routes` emits OpenAPI
(`fijiserver/src/generated/swagger.json`), and `generate-stubs:web` / `generate-stubs:admin`
**generate the typed API clients** consumed by fijiweb/fijiadmin. The client is *derived from the
server*, so backend↔frontend drift is caught at build time. podcast-saas hand-maintains
`shared/src/generated/client-v1.ts` (cast-based `JSON.parse as T`), which silently drifts (dead
methods that 404, nullable-as-required crashes). **Port:** generate the client from an OpenAPI/zod
source of truth, or at minimum add a drift-detection test (review `tq-010`).

## Public links / token model
- **Firebase Auth** primary identity; security schemes `firebase`, `firebase-optional`,
  `firebase-admin` (decorator-driven).
- **Artifact tokens**: RS256 JWT signed by fijiserver (`ArtifactTokenService`), scoped to one
  artifactId, 1-hour expiry, refreshable; passed to sandboxed iframes via `postMessage` (`fiji:auth`);
  validated by both fijiserver and fijicomm. This is how fiji shares "public" interactive content
  safely without exposing the whole API.

## Scalability patterns worth borrowing
- **nginx reverse proxy** (`nginx.conf`): `/` → web, `/api` → server (with `client_max_body_size 100M`,
  600s read/send timeouts for SSE), `/comm` → websocket (86400s timeouts). Single TLS edge.
- **Presigned direct-to-cloud** upload/download → app servers stay stateless and bandwidth-light.
- **fijicomm**: optional **Redis adapter** for horizontal Socket.io scaling; `HeartbeatService`
  registers nodes in Mongo; `SessionroomCleanupService` expires idle rooms.
- **fijicapture**: pre-warmed **BrowserPool** (Playwright), health checks, idle recycling, single
  poll-loop `JobDispatcher` with fairness — a model for bounding podcast-saas's unbounded ffmpeg
  spawning (review `perf-002`, `backend-011`, `perf-011`).
- **AI model tiering**: utility/generation/complex tiers with auto-escalation + presigned/cached
  artifacts — relevant to podcast-saas LLM cost-DoS (review `security-003`).
- **Docker Compose** deploy; `scripts/setup-deployment.sh` generates compose+nginx+deploy.

## Caveats when porting
- Fiji = MongoDB/Mongoose; podcast-saas = Postgres/Drizzle. "Find artifact by storage path regex"
  becomes a Drizzle query on a `projects`/`videos` table with an `is_public` column.
- Fiji = Express/TSOA; podcast-saas = Fastify. Decorator security → Fastify preHandler/hooks.
- Fiji multi-cloud may be more than podcast-saas needs — a single writable bucket (R2 with write creds,
  or Supabase Storage which is HTTPS-friendly for the GoDaddy egress limits) is enough; keep the
  *abstraction* so the provider is swappable.
- Don't import fiji code; it's a different repo with its own license/stack. Reference and re-implement.
