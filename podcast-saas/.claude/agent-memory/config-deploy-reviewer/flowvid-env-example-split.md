---
name: flowvid-env-example-split
description: FlowVid has TWO .env.example files with different purposes — don't diff process.env reads against only one of them.
metadata:
  type: reference
---

Two separate `.env.example` files, both legitimate, easy to conflate:

- `podcast-saas/.env.example` — app secrets/API keys (DATABASE_URL, FIREBASE_*, LLM keys,
  storage creds, STRIPE_*, ENCRYPTION_KEY, PORT/NODE_ENV/LOG_LEVEL, plus the browser-visible
  `NEXT_PUBLIC_APP_URL`/`BACKEND_API_URL`/`PUBLIC_SITE_URL` with LOCALHOST dev defaults). Loaded by
  `backend`/`worker` compose services via `env_file: ../.env` (`deploy/docker-compose.yml:32,68`).
- `podcast-saas/deploy/.env.example` — ORCHESTRATION config for docker-compose itself: `DOMAIN_*`
  subdomains, `LETSENCRYPT_*`, `APP_VERSION`, `MAX_UPLOAD_SIZE` (nginx), and the frontend
  build-time `NEXT_PUBLIC_FIREBASE_*` values (baked into the browser bundle via Dockerfile ARGs).
  Auto-loaded by `docker compose` for `${...}` interpolation in `docker-compose.yml` when run from
  `deploy/`. It explicitly does NOT hold app API keys — see its own header comment.

Critically: `docker-compose.yml` OVERRIDES several root-`.env.example` vars for the containers
directly from `DOMAIN_*` (e.g. `BACKEND_API_URL: https://${DOMAIN_API}` at
`docker-compose.yml:43`, `ADMIN_ORIGIN: https://${DOMAIN_ADMIN}` at line 46) — so a var's
localhost default in the root `.env.example` is NOT what production actually gets when deployed
via compose; check `docker-compose.yml`'s `environment:` blocks before concluding a var is
misconfigured in the real deploy path. This matters for false-positive avoidance: a var missing
from root `.env.example` but present in `docker-compose.yml`'s environment block (e.g.
`ADMIN_ORIGIN`) is a documentation gap for non-compose deployments, not a production bug in the
actual shipped path.

When doing the env-var contract diff, grep `process.env.X` across all four packages AND diff
against the UNION of both `.env.example` files AND `docker-compose.yml`'s `environment:`/`args:`
blocks — a var can be legitimately absent from `.env.example` but still wired correctly via
compose.
