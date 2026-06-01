# client-web

Next.js 15 frontend for the podcast-saas platform.

## Dev server

**Always start with `pnpm dev`. Never run `next dev` directly.**

```bash
pnpm dev
```

`pnpm dev` runs `bash dev.sh`, which:
- Frees port 3000 (kills stale server)
- Sets `WATCHPACK_POLLING=true` and `CHOKIDAR_USEPOLLING=true` to prevent EMFILE on pnpm symlink trees
- Sets `NEXT_TELEMETRY_DISABLED=1`
- Raises `ulimit -n 65536`
- Tees Next.js output to `$DEV_LOG` (default `/tmp/nextjs-dev.log`) for `pnpm dev:watch` scanning
- Runs `pnpm exec next dev -p 3000`

Running `next dev` directly without these env vars will cause Watchpack EMFILE errors and random 404s on the root route.

## Build

**Stop `pnpm dev` before running `pnpm build`.**

```bash
# 1. Stop the dev server (Ctrl-C in its terminal)
# 2. Run the production build:
pnpm build
# 3. Restart the dev server:
pnpm dev
```

Mixing `pnpm build` and `pnpm dev` overwrites `.next/` artifacts. If you run both simultaneously, the dev server will crash with:

```
Cannot find module './vendor-chunks/undici@X.Y.Z.js'
```

If you see vendor-chunks errors:
1. Stop `pnpm dev`
2. `rm -rf .next` (once only — do not add this to dev.sh)
3. `pnpm dev`

## Health checks

After starting, verify the server in a second terminal:

```bash
# Full preflight (file structure + routes + stale cache detection):
pnpm dev:doctor

# With a real project ID (proves data path, not just routing):
PROJECT_ID=<uuid> pnpm dev:doctor

# Quick route check only:
pnpm dev:check
PROJECT_ID=<uuid> pnpm dev:check

# Continuous monitor (checks every 10 s, scans log for EMFILE/404):
pnpm dev:watch
PROJECT_ID=<uuid> pnpm dev:watch
DEV_LOG=/path/to/dev.log pnpm dev:watch
```

`dev:doctor` and `dev:check` fail immediately with a clear message if the server is not running — they do **not** wait or retry.

`dev:doctor` also scans the dev log for stale cache signatures and prints actionable advice.

`dev:watch` does not auto-restart. It detects and reports loudly.

## Route map

| URL | Page |
|-----|------|
| `/` | Home / project list |
| `/new` | Create project |
| `/projects/[id]/editor` | Interactive video editor |
| `/projects/[id]/view` | Full-screen viewer (no header) |
