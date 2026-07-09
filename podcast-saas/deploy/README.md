# Deployment — podcast-saas on AWS (Docker Compose + NGINX + Let's Encrypt)

Production deployment for a **single AWS Ubuntu VM**. Every service runs in its own
container. NGINX is the sole traffic-termination point (ports 80/443) and reverse-proxies
by subdomain. TLS is issued and auto-renewed by Let's Encrypt. Deploys are versioned by
git SHA with automatic health-gated rollback.

- **VM:** Ubuntu, public IP `44.225.68.155`
- **Domain:** `flowvidco.com`
- **SSH (from your laptop):** `ssh -i keys/Cebu_key1.pem ubuntu@44.225.68.155`
  (the key stays on your machine — it is never referenced by content anywhere in this repo)

---

## 1. Architecture

```
                          Internet (443/80)
                                │
                    ┌───────────▼───────────┐
                    │   nginx (TLS term)     │  ← only container binding host ports
                    └───┬───────┬────────┬───┘
        app/www/apex ───┘       │        └─── admin.
                                api.
            ┌───────────────────┼───────────────────┐
            ▼                   ▼                    ▼
      client-web:3000     backend:8080         admin-web:3000
      (Next.js)           (Fastify API)        (Next.js)
                               │
             worker (pg-boss + ffmpeg jobs)
                               │
                               ▼   outbound HTTPS/5432
                    Supabase Postgres (EXTERNAL — not a container)
```

| Container    | Image                          | Role                                   | Host port |
|--------------|--------------------------------|----------------------------------------|-----------|
| `nginx`      | `nginx:1.27-alpine`            | Reverse proxy + TLS termination        | 80, 443   |
| `client-web` | `podcast-saas/client-web:<sha>`| Next.js frontend (viewer/editor)       | –         |
| `backend`    | `podcast-saas/backend:<sha>`   | Fastify API (`/health`), ffmpeg        | –         |
| `worker`     | `podcast-saas/backend:<sha>`   | pg-boss worker (transcode/captions)    | –         |
| `admin-web`  | `podcast-saas/admin-web:<sha>` | Next.js admin                          | –         |
| `certbot`    | `certbot/certbot`              | Let's Encrypt renewal loop             | –         |

The **database is external (Supabase)** — there is no Postgres container. Only `nginx` is
reachable from the internet; the apps sit on the `edge` network, the `worker` on an isolated
`internal` network. All containers reach Supabase via outbound connections.

### Routing

| URL                                            | → Service      |
|------------------------------------------------|----------------|
| `https://flowvidco.com`, `https://www.flowvidco.com`, `https://app.flowvidco.com` | `client-web` |
| `https://api.flowvidco.com`                    | `backend`      |
| `https://admin.flowvidco.com` (optional)       | `admin-web`    |
| `http://*` (port 80)                           | 301 → HTTPS (except ACME challenge + `/healthz`) |

---

## 2. DNS (do this first)

Create these records at your DNS provider, all pointing at `44.225.68.155`:

```
flowvidco.com        A      44.225.68.155
www.flowvidco.com    A      44.225.68.155      # or CNAME -> flowvidco.com
app.flowvidco.com    A      44.225.68.155
api.flowvidco.com    A      44.225.68.155
admin.flowvidco.com  A      44.225.68.155      # optional
```

Also confirm the **AWS Security Group** for the instance allows inbound **TCP 80 and 443**
(and 22 for SSH). Let's Encrypt validation fails if port 80 is closed.

Verify propagation before issuing certs: `dig +short flowvidco.com` should return the IP.

---

## 3. First-time setup (run on the VM)

```bash
# From your laptop:
ssh -i keys/Cebu_key1.pem ubuntu@44.225.68.155

# On the VM — clone the repo (private repo: use a deploy key or a PAT):
git clone <YOUR_REPO_URL> ~/podcast-saas
cd ~/podcast-saas

# 3a. Install Docker + compose, firewall, systemd unit (idempotent):
./deploy/scripts/provision.sh
#   -> if it added you to the `docker` group, run `newgrp docker` or re-login.

# 3b. Configure environment (TWO files):
cp deploy/.env.example deploy/.env      # orchestration: domains, versions, LE email, Firebase build args
nano deploy/.env
cp .env.example .env                     # app secrets: DATABASE_URL (Supabase), API keys, Firebase, Stripe…
nano .env
#   deploy/.env : set LETSENCRYPT_EMAIL + NEXT_PUBLIC_FIREBASE_*  (domains already = flowvidco.com)
#   root .env   : set DATABASE_URL to the Supabase SESSION pooler (:5432) + all API keys

# 3c. Preflight — HARD GATE. Confirms DNS + ports before touching Let's Encrypt.
#     Do NOT run init-ssl until this passes.
./deploy/scripts/preflight.sh 44.225.68.155

# 3d. Issue TLS certificates (only after preflight passes):
./deploy/scripts/init-ssl.sh

# 3e. Build images, run migrations, launch, health-check:
./deploy/scripts/deploy.sh
```

When `deploy.sh` finishes green, browse to `https://flowvidco.com`.

> **Tip:** while testing SSL, set `LETSENCRYPT_STAGING=1` in `deploy/.env` to avoid the
> Let's Encrypt rate limit, then flip to `0` and re-run `init-ssl.sh` for a trusted cert.

---

## 4. The two environment files

| File            | Committed? | Contents                                                        |
|-----------------|------------|-----------------------------------------------------------------|
| `deploy/.env`   | **No**     | Orchestration: `DOMAIN_*`, `APP_VERSION`, `LETSENCRYPT_EMAIL`, `MAX_UPLOAD_SIZE`, `NEXT_PUBLIC_FIREBASE_*` (build args) |
| `.env` (root)   | **No**     | App runtime secrets loaded by `backend`/`worker` via `env_file` — including **`DATABASE_URL` (Supabase)**, plus Anthropic/OpenAI/Groq/Stripe/Supabase-Storage/Firebase-admin keys, etc. |

`docker-compose.yml` reads `deploy/.env` for `${...}` interpolation. The database is
**external Supabase**: `DATABASE_URL` (and optional `QUEUE_DATABASE_URL`) come straight from
root `.env` — the compose file does **not** override them and there is no Postgres container.

> **pg-boss connection mode matters.** The `worker` uses pg-boss (LISTEN/NOTIFY + advisory
> locks), which is **incompatible with Supabase's transaction pooler (port 6543)**. Point
> `DATABASE_URL` at the **session-mode pooler / direct connection (port 5432)**. If you want
> the web tier on the transaction pooler for scale, keep `DATABASE_URL=:6543` and set
> `QUEUE_DATABASE_URL=` the `:5432` session pooler so the queue still works.
>
> On this AWS VM, outbound to Supabase on 5432/6543 is allowed by default (unlike the
> GoDaddy platform notes in the top-level CLAUDE.md, which do not apply here).

`NEXT_PUBLIC_*` values are **baked into the frontend bundle at build time**, so changing
them requires a rebuild (`deploy.sh`), not just a restart.

---

## 5. Deploying a new version

```bash
cd ~/podcast-saas
./deploy/scripts/deploy.sh                 # deploy latest of current branch
./deploy/scripts/deploy.sh main            # a branch
./deploy/scripts/deploy.sh v1.4.0          # a tag
./deploy/scripts/deploy.sh 9f3a1c2         # a specific commit
```

What it does:

1. `git fetch` + checkout/pull the requested ref.
2. Records the currently-running version as the **rollback target** (`deploy/.deploy-state`).
3. Builds images tagged with the **new git short SHA** — unchanged layers are cached, and
   compose only recreates services whose image actually changed.
4. Runs **DB migrations** against Supabase (`node dist/db/migrate.js`, idempotent).
   If migrations fail, it aborts **before** swapping app containers — the old version keeps serving.
5. Recreates `backend`, `worker`, `client-web`, `admin-web`, `nginx` and reloads nginx.
6. **Polls health** for up to `HEALTH_TIMEOUT` seconds (default 240).
   - Healthy → done; previous images retained for rollback.
   - Unhealthy → **automatic rollback** to the previous version.

Useful flags:

```bash
FORCE=1 ./deploy/scripts/deploy.sh         # redeploy the same SHA
HEALTH_TIMEOUT=360 ./deploy/scripts/deploy.sh
NO_ROLLBACK=1 ./deploy/scripts/deploy.sh   # leave a failed deploy up for debugging
```

### Why this is "gradual" and safe
- Migrations run against Supabase **before** any app container is swapped.
- App containers are recreated with the new image while nginx stays up; nginx resolves
  upstreams per-request via Docker DNS, so it follows recreated containers.
- Health is verified before the deploy is considered successful; otherwise it rolls back.

> For **zero-downtime** blue/green (two backend replicas drained one at a time), this design
> can be extended, but the health-gated recreate above keeps downtime to a few seconds per
> container and stays simple to operate by hand.

---

## 6. Rolling back

Automatic on failed health checks. Manual:

```bash
./deploy/scripts/rollback.sh               # -> PREVIOUS_VERSION in .deploy-state
./deploy/scripts/rollback.sh 9f3a1c2       # -> a specific previously-built SHA
docker images 'podcast-saas/*'             # list versions available to roll back to
```

Rollback **re-launches retained images** — no rebuild, so it's fast. It restores **code**,
not schema; migrations are written to be additive/idempotent, so a forward-only DB is the
assumption. A destructive schema change needs a manual down-migration.

---

## 7. Health checks

- **Per container:** every service has a Docker `healthcheck` (`docker compose ps` shows `healthy`).
  - `backend` → `GET /health` (returns 503 when Supabase is unreachable).
  - frontends → `GET /`.
  - `worker` → PID-1 liveness via restart policy.  `nginx` → `GET /healthz`.
- **Whole-stack snapshot** (containers + internal + public HTTPS endpoints):

```bash
./deploy/scripts/health-check.sh           # exit 0 iff everything is green
```

- **Load-balancer / uptime probe:** `http://<host>/healthz` and `https://api.flowvidco.com/health`.

---

## 8. Logs & debugging

```bash
./deploy/scripts/logs.sh                    # tail everything (follow)
./deploy/scripts/logs.sh backend            # one service
./deploy/scripts/logs.sh backend worker     # several
SINCE=1h ./deploy/scripts/logs.sh nginx     # time-bounded, no follow
TAIL=1000 ./deploy/scripts/logs.sh backend

# Raw compose (run from deploy/):
cd ~/podcast-saas/deploy
docker compose ps
docker compose exec backend sh             # shell into a container
docker compose exec nginx nginx -t         # test nginx config
docker compose exec backend curl -s localhost:8080/health

# nginx access/error logs (persisted to the nginx_logs volume):
docker compose exec nginx tail -f /var/log/nginx/access.log
```

Common issues:

| Symptom                              | Check                                                                 |
|--------------------------------------|-----------------------------------------------------------------------|
| 502 from nginx                       | Is the upstream healthy? `docker compose ps`; `logs.sh backend`       |
| Cert error / `init-ssl` fails        | DNS points to VM? Port 80 open in the AWS SG? Try `LETSENCRYPT_STAGING=1` |
| Backend 503 on `/health`             | Supabase reachable? Right connection mode/port in `DATABASE_URL`? Migrations applied? `logs.sh backend` |
| Worker not processing jobs / queue errors | `DATABASE_URL` on the transaction pooler (:6543)? Switch queue to the :5432 session pooler (see §4) |
| Frontend shows wrong API URL         | `NEXT_PUBLIC_*` are build-time — rebuild via `deploy.sh`              |
| Deploy rolled back automatically     | `NO_ROLLBACK=1 ./deploy.sh` then inspect `logs.sh backend`            |

---

## 9. TLS renewal

The `certbot` container attempts renewal twice daily and only acts near expiry; `nginx`
reloads every 6h to pick up renewed certs. No cron needed. Force a renewal test:

```bash
cd ~/podcast-saas/deploy
docker compose run --rm certbot renew --dry-run
```

---

## 10. Boot persistence (systemd)

`provision.sh` installs `/etc/systemd/system/podcast-saas.service`, which brings the whole
stack up on VM reboot (containers also carry `restart: unless-stopped`).

```bash
sudo systemctl status podcast-saas
sudo systemctl restart podcast-saas
sudo systemctl stop podcast-saas
```

---

## 11. File map

```
deploy/
├── docker-compose.yml            # the whole stack (6 services, 2 networks, named volumes)
├── .env.example                  # orchestration env (copy -> deploy/.env)
├── README.md                     # this file
├── docker/
│   ├── backend.Dockerfile        # backend + worker image (Node 22 + ffmpeg, pnpm monorepo)
│   └── web.Dockerfile            # shared Next.js image (--build-arg APP=client-web|admin-web)
├── nginx/
│   ├── nginx.conf                # http core (mounted directly)
│   ├── ssl-params.conf           # shared TLS hardening
│   └── templates/app.conf.template  # vhosts; envsubst -> conf.d/ at container start
├── scripts/
│   ├── provision.sh              # one-time VM setup (Docker, firewall, systemd)
│   ├── preflight.sh              # HARD GATE: DNS + port + CA-egress checks before SSL
│   ├── init-ssl.sh               # Let's Encrypt bootstrap (dummy cert -> real certs)
│   ├── deploy.sh                 # versioned, health-gated deploy + auto-rollback
│   ├── rollback.sh               # manual/auto rollback to a retained version
│   ├── health-check.sh           # full-stack health snapshot
│   ├── logs.sh                   # log tailing helper
│   ├── ssh-vm.sh                 # (run locally) SSH into the VM using keys/Cebu_key1.pem
│   └── _lib.sh                   # shared helpers (sourced)
└── systemd/podcast-saas.service  # boot unit (installed by provision.sh)
```

Root-level `.dockerignore` keeps build contexts small; root `.env` holds app secrets.
