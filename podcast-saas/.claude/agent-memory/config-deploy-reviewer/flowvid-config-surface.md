---
name: flowvid-config-surface
description: FlowVid's established fail-closed config pattern (publicOrigins.ts / next.config.ts) plus the specific env-var/deploy gaps found in the 2026-08-15 whole-codebase review — check these first on the next pass before re-deriving from scratch.
metadata:
  type: project
---

**As of the 2026-08-15T2109 review (commit 2d187e3 on main):**

FlowVid has a deliberate, repeated "fail closed on a missing required browser-visible origin"
convention, introduced after a real incident (localhost URLs shipped to browsers). The reference
implementation is `podcast-saas/backend-api/src/config/publicOrigins.ts`
(`assertPublicOriginsForProd`, called from `server.ts` and `worker.ts`) and is mirrored in
`client-web/next.config.ts` / `admin-web/next.config.ts` (`resolvePublicUrl`, throws at build time
on missing/localhost/non-https in production). `shared/src/csp.ts` follows the same discipline for
Firebase-auth-domain parsing (`firebaseAuthFrameOrigin`, `authEmulatorOrigin` — parse-then-rebuild
from `URL`, never `.split()` on an authority string). Before flagging a new "browser-visible
localhost" or "auth-domain parsing" bug in this area, check whether it already goes through one of
these three functions — they're well-tested and this pattern is intentional, not accidental.

**Known gaps in that same pattern, unresolved as of this review** (re-check on the next pass):
- `DATABASE_URL` (and derived `QUEUE_DATABASE_URL`) has NO equivalent fail-fast — falls back
  silently to `postgresql://postgres:postgres@localhost:5432/podcast_saas` in
  `backend-api/src/db/index.ts:6-7`, `db/migrate.ts:11`, `queue/pgBoss.ts:38-44`. Contrast with the
  `ENCRYPTION_KEY` check right next to it at `server.ts:609`.
- `AVATAR_MEMORY_SECRET` (`services/avatar/memoryToken.ts:20`) falls back to `DATABASE_URL`, then
  to a literal `'insecure-dev-only-secret'` string. Undocumented in `.env.example`.
- Production CSP (`shared/src/csp.ts:109`) always includes `'unsafe-inline' 'unsafe-eval'` in
  script-src (the `dev` flag only toggles localhost/http additions, never the unsafe-* tokens),
  and `connect-src` is `https: wss:` (any origin), not an allow-list.

**Deploy-surface mismatches found (not part of the fail-closed pattern, separate bug class):**
- `MAX_UPLOAD_SIZE` (nginx `client_max_body_size`, defaults to `2g` in
  `deploy/docker-compose.yml:176` and `deploy/.env.example`) vs `MAX_UPLOAD_BYTES` /
  `bodyLimit: TEN_GB` in `backend-api/src/controllers/v1/video.controller.ts:39,133` (10 GB) — the
  live streaming-upload route (`POST /api/v1/projects/:id/videos/upload`, used by
  `VideoUploader.tsx` and `SectionEditor.tsx`) will 413 at nginx for 2-10 GB uploads under the
  documented default. Note: most large-file upload paths go direct-to-Supabase via presigned URLs
  and don't hit this — only the one streaming route does.
- `backend`/`worker` compose services (`deploy/docker-compose.yml:24-86`) have no
  `mem_limit`/`cpus`, unlike `deploy/docker-compose.export-worker.yml:47-50` which does. There was
  already a real OOM incident (2026-08-13, documented in `queue/pgBoss.ts:17-20`) that moved ffmpeg
  assembly off the web tier onto `worker` — but `worker` itself is still unbounded.
- `.github/workflows/ci.yml` never runs Playwright at all. Of client-web's 9 `playwright.*.config.ts`
  files, only `playwright.production.config.ts` runs anywhere, and only post-deploy against a live
  site (`release.yml`, `rollback.yml`, `production-audit.yml`) — the other 8 never run in CI.
- Root `podcast-saas/package.json` still has the GoDaddy-era `main`/`start` pointing at
  `backend-api/dist/server.js`, a `workspaces` array that duplicates (and has drifted from —
  missing `ops/release`/`ops/ship`) `pnpm-workspace.yaml`, a `build` script using npm's `-w` syntax
  despite `packageManager: pnpm@11.4.0`, and a `"generate"` script that calls a `backend-api`
  script (`generate`) that does not exist. `backend-api/tsoa.json` is still present with zero
  `tsoa` imports anywhere. `podcast-saas/CLAUDE.md` is still 100% GoDaddy/MySQL content — confirmed
  by a full re-read, not just trusting `stack.md`'s earlier snapshot.

See [[flowvid-env-example-split]] for where deploy config actually lives.
