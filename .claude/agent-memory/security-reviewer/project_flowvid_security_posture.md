---
name: flowvid-security-posture
description: What the FlowVid backend's security controls actually are and where the real gaps sit — the map that makes a second security review fast
metadata:
  type: project
---

FlowVid's backend authz is unusually well-built by hand: every `controllers/v1/**` route has an
explicit auth preHandler, and nested resource ids are consistently re-scoped to the parent
(`and(eq(child.id, param), eq(child.project_id, project.id))`). Ownership lives in four helpers —
`services/collabAccess.ts`, `projectAccess.ts`, `podcastAccess.ts`, `avatar/avatarAccess.ts` — and
`controllers/admin/v1/**` is uniformly behind `firebase-admin-required.ts`.

**Why:** several rounds of prior security review (findings referenced in-code as security-002 through
security-107) already fixed the obvious IDOR class, so a naive route-by-route IDOR hunt returns
almost nothing.

**How to apply:** don't re-hunt route-level IDOR from scratch. The residual risk in this codebase is
structural and lives in four places:
1. **Storage backend divergence.** Guards are implemented on the backend serve routes
   (`/hls-proxy`, `/video-raw`, `/local-storage`, `authorizeMediaRequest`), but the *production*
   adapter is `SupabaseStorageAdapter`, whose `getPublicUrl` returns a raw public-bucket URL that
   bypasses them entirely. Always ask "which adapter does prod use?" before trusting a media guard.
2. **The avatar surface** (`controllers/v1/avatar.controller.ts`, ~27 routes) is the least-hardened
   file: it mixes unauthenticated viewer endpoints with authenticated editor ones, and reaches
   provider SDKs (Anam, OpenAI images) from both.
3. **User-authored HTML** — sim packages and avatar library uploads are stored and served as
   `text/html` from the API origin via `/sim-public/*`, which is unauthenticated by design.
4. **Config-shaped fail-open** — `mediaAccess.canServeMediaKey` returns true on DB error;
   `mediaToken.getMediaSecret()` accepts a malformed `ENCRYPTION_KEY` without validation.

Also worth remembering: `reply.sent` is used as the "auth denied" signal in `server.ts` and
`firebase-admin-required.ts`, and in Fastify 4 that is a `raw.writableEnded` probe — correct only
while no `onSend` hook is registered anywhere.
