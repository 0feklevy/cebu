---
name: fastify-logger-false-trap
description: Fastify is built with logger:false in this repo, so any request.log.*/reply.log.* call is a guaranteed silent no-op — grep for this pattern first in every review.
metadata:
  type: project
---

`podcast-saas/backend-api/src/server.ts` builds Fastify with `logger: false` (comment: "use pino
directly"), intending all logging to go through the app's own `lib/logger.ts` pino instance instead.
Fastify's own source (`node_modules/fastify/lib/logger.js`) wires `request.log`/`reply.log` to
`abstract-logging` when `logger` is falsy — every method on it is a true no-op stub, not a
degraded/console fallback. It does not throw, so nothing signals the mistake at runtime.

**Why this matters for review:** any call site that uses `request.log.error(...)` or
`reply.log.*` instead of the imported `logger` silently discards that log line in production. Found
two real instances on 2026-08-15 (`controllers/v1/projects.controller.ts:278,559`) — both were
clearly typos, since the same file correctly uses `logger.error(...)` three lines away and imports
`logger` at the top. This is a recurring, easy-to-miss bug class specific to this repo's Fastify
config, not a general Fastify anti-pattern (a repo that leaves `logger` on wouldn't have this trap).

**How to apply:** on every future review of this repo, `grep -rn "request\.log\.\|reply\.log\."
backend-api/src` (excluding tests/_archive) as a first-pass check — any hit outside a file that
deliberately re-enables Fastify's logger is a P1. Also worth checking whether `server.ts:145` still
says `logger: false` before trusting this memory; if it's since been flipped to a real pino
instance, this whole class of bug disappears and `request.log.*` becomes safe/preferred (see
[[flowvid-job-status-writes]] for the related correlation-id gap that the same fix would close).
