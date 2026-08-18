# Dependency Audit — FlowVid

Scope covered: `podcast-saas/package.json`, all six workspace `package.json` files
(`backend-api`, `client-web`, `admin-web`, `shared`, `ops/release`, `ops/ship`),
`podcast-saas/pnpm-workspace.yaml`, `podcast-saas/pnpm-lock.yaml` (lockfileVersion 9.0), and the
three Dockerfiles under `podcast-saas/deploy/docker/`. No installs or lockfile mutation were
performed — every version claim below is read from the manifests/lockfile as text, or from a
resolved lockfile entry, and every advisory claim was looked up (never recalled from memory);
sources are cited in each finding's evidence. `pnpm audit` was **not** run — it is blocked by the
guard and I did not attempt it.

---

### [P1] adm-zip is pinned to a version vulnerable to a DoS on attacker-controlled zip uploads
- id: dependency-001
- location: podcast-saas/backend-api/package.json:20 (also podcast-saas/pnpm-lock.yaml:2756)
- category: security
- confidence: high
- status: confirmed
- what: `adm-zip` is declared as `^0.5.10` and the lockfile resolves it to `0.5.17`
  (`pnpm-lock.yaml:2756`, `adm-zip@0.5.17`). `adm-zip` versions 0.5.10–0.5.17 are affected by
  CVE-2026-39244 / GHSA-xcpc-8h2w-3j85: `zipEntry.js` does `Buffer.alloc(_centralHeader.size)`
  using the declared (attacker-controlled) uncompressed-size field from the ZIP central directory,
  with no bound check against the actual compressed payload — a ~120-byte crafted ZIP can force a
  ~4 GB allocation. Fixed in 0.5.18 (bounded in 0.6.0).
- why: `new AdmZip(buf)` is called directly on **user-uploaded** zip bytes in three real
  entry points: `backend-api/src/services/simulation/SimulationService.ts:3327`
  (`extractZip`, used when a user replaces/uploads a simulation package),
  `backend-api/src/controllers/v1/simulations.controller.ts:649`, and
  `backend-api/src/controllers/v1/avatar.controller.ts:145` (`zipHasHtml`, sniffs an uploaded
  knowledge-doc zip for HTML). All three routes require `firebaseAuthMiddleware`
  (confirmed via `preHandler: [firebaseAuthMiddleware]` at
  `backend-api/src/controllers/v1/simulations.controller.ts:97,125,265,454,549,595,630,668,715,778,798,818`),
  so this is an authenticated-user DoS, not an unauthenticated one — any signed-in user can crash
  or exhaust the worker process handling their own upload.
- evidence: Read `pnpm-lock.yaml:2756` (`adm-zip@0.5.17`); read the three call sites above
  (`new AdmZip(buffer)` / `new AdmZip(buf)` followed immediately by `.getEntries()`, which parses
  the central directory and triggers the allocation). Advisory: GHSA-xcpc-8h2w-3j85 /
  CVE-2026-39244 (github.com/advisories/GHSA-xcpc-8h2w-3j85), confirmed affected range
  0.5.10–0.5.17, fixed 0.5.18.
- fix: Bump the `adm-zip` range in `podcast-saas/backend-api/package.json` to `^0.5.18` (or `^0.6.0`
  for the hardened allocator) so the lockfile re-resolves past the vulnerable range on the next
  `pnpm install`. Cannot run the install here — hand this to whoever runs it next; the change is a
  one-line manifest edit, not a code change, so no new test is needed beyond re-running the
  existing zip-upload tests (`backend-api/src/controllers/v1/__tests__/simulations.replace.test.ts`,
  `backend-api/src/services/simulation/__tests__/SimulationService.test.ts`).
- effort: S

### [P1] Next.js is three minor versions behind the fix for a critical, self-hosted-relevant middleware bypass (CVE-2025-29927)
- id: dependency-002
- location: podcast-saas/client-web/package.json:19 (also podcast-saas/admin-web/package.json:14)
- category: security
- confidence: high
- status: confirmed
- what: Both frontends pin `"next": "15.1.0"` exactly (no caret). CVE-2025-29927 (CVSS 9.1) affects
  all Next.js 15.x releases before 15.2.3: a request carrying the internal
  `x-middleware-subrequest` header is treated as an internal subrequest and **skips
  `middleware.ts` entirely**. The fix (15.2.3+) strips that header from external requests and
  validates it against a per-build random token.
- why: The condition Vercel names for exposure is self-hosted deployment running `next start` with
  middleware present — this repo matches exactly: `deploy/docker/web.Dockerfile:80` runs
  `CMD ["pnpm", "start"]` → `next start` inside plain Docker/nginx (per stack.md, not Vercel), and
  `client-web/middleware.ts` exists and is registered for `/c/:path*`, `/v/:path*`, `/pl/:path*`
  (`client-web/middleware.ts:20-22`). Read the middleware in full: today it does not gate
  authn/authz — it serves a 410 for archived courses and issues legacy-URL redirects — so bypassing
  it today means a crafted request can make an archived course fail to 410 or a legacy `/v/*`
  token URL fail to redirect, not an auth bypass. That is why this is filed P1 (real, reachable
  defect with a confirmed CVE and a one-line fix) rather than P0 (no path today turns the bypass
  into an authz/data exposure), but it is one added `middleware.ts` check away from becoming
  exactly that, and the fix is trivial. `admin-web` has no `middleware.ts`, so it is unaffected by
  this specific bypass even though it also pins 15.1.0.
- evidence: `client-web/package.json:19` and `admin-web/package.json:15` both `"next": "15.1.0"`
  (exact); `deploy/docker/web.Dockerfile:80` `CMD ["pnpm", "start"]`; read
  `client-web/middleware.ts:1-91` in full (no auth/session checks present). Advisory:
  CVE-2025-29927, Vercel security bulletin "Next.js and the corrupt middleware" (published
  2026-03; datadoghq.com/security-labs, zscaler.com/blogs/security-research), affected <15.2.3,
  fixed 15.2.3+.
- fix: Bump `next` to `^15.2.3` or later (current 15.x line) in both
  `podcast-saas/client-web/package.json` and `podcast-saas/admin-web/package.json`. This is a
  same-major bump; re-run `pnpm -C podcast-saas --filter client-web typecheck` and the Playwright
  suites that exercise `/c/*` and `/v/*` routing after the bump (client-web owns 9 Playwright
  configs per stack.md) since 15.2.x also changed some middleware `NextResponse` matching
  semantics.
- effort: S

### [P2] tsoa is a declared runtime dependency that is imported nowhere, with a matching dead tsoa.json
- id: dependency-003
- location: podcast-saas/backend-api/package.json:25 (also podcast-saas/backend-api/tsoa.json:1)
- category: maintainability
- confidence: high
- status: confirmed
- what: `tsoa` (`^6.4.0`) is listed under `backend-api`'s `dependencies` and `backend-api/tsoa.json`
  configures a full TSOA codegen pipeline (`entryFile: src/server.ts`,
  `controllerPathGlobs: ["src/controllers/**/*.controller.ts"]`, spec output to
  `src/generated`).
- why: `grep -rn "tsoa" backend-api/src` returns zero hits — nothing imports it, no `npm` script
  runs `tsoa spec`/`tsoa routes`, and routes are hand-registered `register*Routes(app)` functions
  (per stack.md), not TSOA decorators. This misleads every future reader into believing there is a
  generated-OpenAPI pipeline (stack.md already flags this as a known trap, but it is still present
  in the manifest and worth a concrete dependency-scope finding: it is an actual unused prod
  dependency, installed into every build and every Docker image, not merely stale documentation).
- evidence: `grep -rn "tsoa" backend-api/src --include=*.ts` → no matches. `backend-api/package.json`
  has no `tsoa`-related script. `backend-api/tsoa.json` exists and references
  `src/generated`, a directory that does not correspond to any build step.
- fix: Remove `"tsoa": "^6.4.0"` from `podcast-saas/backend-api/package.json` `dependencies` and
  delete `podcast-saas/backend-api/tsoa.json`, or — if TSOA codegen is actually intended — wire a
  `generate`/`build` script that runs it and land it before removing this finding. Either way, the
  current state (dependency + config file, zero wiring) should not persist.
- effort: S

### [P2] Six of seven @radix-ui packages plus class-variance-authority/tailwind-merge/clsx are declared but never imported in client-web (and cva/tailwind-merge/clsx also unused in admin-web)
- id: dependency-004
- location: podcast-saas/client-web/package.json:5-13 (also podcast-saas/admin-web/package.json:9-16)
- category: maintainability
- confidence: high
- status: confirmed
- what: `client-web/package.json` declares `@radix-ui/react-dialog`, `@radix-ui/react-dropdown-menu`,
  `@radix-ui/react-label`, `@radix-ui/react-progress`, `@radix-ui/react-select`,
  `@radix-ui/react-tabs`, `@radix-ui/react-toast`, `class-variance-authority`, `tailwind-merge`,
  and `clsx`. `admin-web/package.json` separately declares `class-variance-authority`,
  `tailwind-merge`, `clsx`.
- why: A grep for each package name across `.ts`/`.tsx` (excluding `node_modules`/`coverage`) in
  client-web found imports only for `@radix-ui/react-dialog` (5 files); the other six
  `@radix-ui/*` packages plus `class-variance-authority`, `tailwind-merge`, and `clsx` return zero
  matches. The same three (`class-variance-authority`, `tailwind-merge`, `clsx`) are also declared
  and also unused in `admin-web`. There is no `lib/utils.ts`/`cn.ts` helper in either app (the
  usual home for `clsx`+`tailwind-merge`), so this reads as a shadcn/ui-style design-system layer
  that was scaffolded and abandoned, not code that tree-shaking merely hides. Unused dependencies
  do not change the shipped bundle (dead-code elimination removes unreferenced imports), but they
  inflate install size/lockfile surface and mislead a reader into assuming a design system exists.
- evidence: `grep -rl "@radix-ui/react-dropdown-menu\|@radix-ui/react-label\|@radix-ui/react-progress\|@radix-ui/react-select\|@radix-ui/react-tabs\|@radix-ui/react-toast" client-web --include=*.ts --include=*.tsx` → no hits outside `node_modules`/`coverage`;
  same for `class-variance-authority`, `tailwind-merge`, `clsx` in both `client-web` and
  `admin-web`; `find client-web admin-web -iname utils.ts -o -iname cn.ts` → no matches.
- fix: Remove the seven unused entries from `client-web/package.json` and the three unused entries
  from `admin-web/package.json`, or wire up the intended `cn()` helper and start using the Radix
  primitives that were installed for it. Re-run
  `pnpm -C podcast-saas --filter client-web typecheck` /
  `pnpm -C podcast-saas --filter admin-web typecheck` after either change to confirm nothing was
  silently relying on a transitive re-export.
- effort: S

### [P3] `allowBuilds: bson: true` in pnpm-workspace.yaml grants postinstall permission to a package absent from the lockfile
- id: dependency-005
- location: podcast-saas/pnpm-workspace.yaml:8
- category: maintainability
- confidence: high
- status: confirmed
- what: `pnpm-workspace.yaml`'s `allowBuilds` grants arbitrary-postinstall-script permission to
  five packages: `@google/genai`, `bson`, `esbuild`, `protobufjs`, `sharp`. `bson` does not appear
  anywhere in `pnpm-lock.yaml` — not as a direct dependency of any workspace package.json, and not
  as a transitive entry in the lockfile's package graph.
- why: An `allowBuilds` entry for a package that is not currently installed is dead configuration
  that widens the postinstall-script allowlist for no present benefit. If `bson` (MongoDB's BSON
  codec, typically pulled in by a MongoDB driver) is reintroduced later by an unrelated dependency
  bump, it would silently inherit build permission without anyone re-reviewing why — the opposite
  of what an explicit allowlist is for. The other four entries were checked and are legitimate:
  `sharp@0.33.5` is an `optionalDependencies` entry of `next@15.1.0` (`pnpm-lock.yaml:9711-9733`)
  used for `next/image` (confirmed one real usage:
  `client-web/components/viewer/SimPresentationLayers.tsx`); `protobufjs@7.6.1` is pulled in
  transitively via `firebase-admin` → `@google-cloud/firestore` → `google-gax`
  (`pnpm-lock.yaml:6505-6511`); `esbuild` is a direct devDependency of `client-web` and a
  transitive dependency of `vite`/`vitest`; `@google/genai@1.52.0` is a direct dependency used in
  `backend-api/src/services/llm/GeminiProvider.ts` and `systemAi.ts`.
- evidence: `grep -n "bson" podcast-saas/pnpm-lock.yaml` → zero matches (checked whole file).
  `grep -n "sharp@0.33.5\|protobufjs@7.6.1" pnpm-lock.yaml` confirms both are present and
  transitively required as described above.
- fix: Remove the `bson: true` line from `podcast-saas/pnpm-workspace.yaml`'s `allowBuilds` map. If
  a future dependency bump needs it, re-add it then, at the point where it is actually reviewable
  against a real import.
- effort: S

### [P2] ffmpeg in backend.Dockerfile is fetched from a mutable "latest" tag with no checksum verification, despite the comment calling it "a PINNED static build"
- id: dependency-006
- location: podcast-saas/deploy/docker/backend.Dockerfile:52-62
- category: maintainability
- confidence: high
- status: confirmed
- what: `ARG FFMPEG_BUILD=ffmpeg-n8.1-latest-linux64-gpl-8.1` is downloaded from
  `https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/${FFMPEG_BUILD}.tar.xz` with no
  hash/signature check — the `curl` just streams the tarball straight to disk and extracts it.
- why: BtbN/FFmpeg-Builds' `latest` GitHub release tag is explicitly a **rolling** release —
  BtbN's own retention policy is "daily builds run at 12:00 UTC and are automatically released",
  keeping only the last 14 daily builds plus the last build of each month; the `latest` tag's
  assets are replaced by each new automated build. So `${FFMPEG_BUILD}.tar.xz` under `latest` is
  not a fixed artifact — its filename encodes the ffmpeg version (`n8.1`) but its **contents** can
  change on any subsequent daily rebuild of that branch, and there is nothing here that would
  detect a change (no `--checksum`/`sha256sum` comparison), unlike the sibling
  `export-worker.Dockerfile`'s Chrome stage, which explicitly relies on `@puppeteer/browsers`
  verifying the download "against that channel's published hash" (comment at
  `export-worker.Dockerfile:21-23`). The comment at `backend.Dockerfile:50` ("a PINNED static
  build is installed instead of the distro package") is accurate about avoiding Debian's ffmpeg
  5.1, but overstates what pinning is actually happening here: the version number is pinned, the
  bytes are not. A rebuild six months from now can silently pull a different binary under the same
  filename, with no build-time signal if that binary regresses (the exact class of incident this
  file's own comments memorialize twice, for Chrome).
- evidence: Read `backend.Dockerfile:45-62` in full; read `export-worker.Dockerfile:16-23,45-65` for
  the contrasting verified-download pattern in the same repo. BtbN/FFmpeg-Builds retention/rolling
  policy confirmed via the repo's release history and referenced release-notes wording ("Release
  Latest Auto-Build" retagged continuously; last-14-daily / last-of-month retention).
- fix: Pin to a specific `autobuild-YYYY-MM-DD-HH-MM` release tag (not `latest`) and add a
  `sha256sum -c` check against a hash committed alongside the Dockerfile (BtbN publishes
  `.sha256` files per asset), mirroring the verification rigor already applied to the Chrome
  download in `export-worker.Dockerfile`. This does not require a rebuild to verify — it is a text
  change to the `curl`/`RUN` block.
- effort: M

### [P3] pino-pretty is a dev-only transport shipped in backend-api's production `dependencies`
- id: dependency-007
- location: podcast-saas/backend-api/package.json:48
- category: maintainability
- confidence: high
- status: confirmed
- what: `pino-pretty` (`^11.2.1`) is listed under `dependencies`, but `backend-api/src/lib/logger.ts:5-8`
  only wires it in when `process.env.NODE_ENV !== 'production'` (`transport: ... : undefined` in
  production).
- why: It is not a broken-install risk (it is present either way), but it is dev-only code shipped
  into the production image and installed by `pnpm install --frozen-lockfile` in
  `backend.Dockerfile`/`export-worker.Dockerfile` for a code path that is `undefined` at runtime in
  that same image. Minor image-size/audit-surface cost for zero production benefit.
- evidence: Read `backend-api/src/lib/logger.ts:1-9` in full — the only reference to `pino-pretty`
  in `backend-api/src` is that one conditional `target: 'pino-pretty'` string, gated off in
  production.
- fix: Move `"pino-pretty": "^11.2.1"` from `dependencies` to `devDependencies` in
  `podcast-saas/backend-api/package.json`. No code change needed since it is referenced by string
  name (pino resolves transports dynamically), so this does not affect the dev experience once
  pnpm installs devDependencies locally; it only trims what ships in the built image.
- effort: S

### [P3] groq-sdk is pinned six-plus major-equivalent releases behind current (0.8.0 vs. 1.5.0), with no advisory review possible on the gap
- id: dependency-008
- location: podcast-saas/backend-api/package.json:19
- category: maintainability
- confidence: medium
- status: suspected
- what: `groq-sdk` is declared `^0.8.0` and the lockfile resolves exactly `0.8.0`
  (`pnpm-lock.yaml:3725`). The current published version is `1.5.0` (per npm, checked 2026-08-16).
  Because npm's caret on a `0.x.y` specifier only floats the patch digit (`^0.8.0` ⇒
  `>=0.8.0 <0.9.0`), this project has never received any `groq-sdk` update since it was first
  pinned — 0.9 through 1.5 are all outside the declared range.
- why: `groq-sdk` is the transcription client used in `services/captions/CaptionService.ts` and
  `services/ingestion/AudioIngester.ts` per stack.md, i.e. it sends real user audio to Groq's API.
  A version gap this large means any advisory or breaking fix released between 0.8.0 and 1.5.0 is
  unreviewed here, and I could not individually diff every intermediate release's changelog for
  vulnerability fixes in the time available — hence `status: suspected`, not `confirmed`. This is
  a version-discipline finding (item 3 in scope), not an asserted CVE.
- evidence: `pnpm-lock.yaml:3725` `groq-sdk@0.8.0`; `backend-api/package.json:19`
  `"groq-sdk": "^0.8.0"`; npm registry query for `groq-sdk` returned latest `1.5.0`, published
  9 days before this run.
- fix: Schedule a deliberate `groq-sdk` bump (not part of this audit) with a manual read of the
  package's CHANGELOG between 0.8.0 and the target version, specifically for
  `services/captions/CaptionService.ts` and `services/ingestion/AudioIngester.ts` call-site
  compatibility, since a 0.x→1.x jump is exactly the kind of bump this project's `stack.md` history
  suggests has broken things before (llm-pipeline-reviewer owns verifying the call sites; flagged
  here as a signal).
- effort: M
- cross: @llm-pipeline-reviewer

---

## Scope notes (clean areas, checked explicitly)

- **`@trigger.dev/sdk`**: NOT dead, despite being a common false-positive in this repo (stack.md
  calls out "pg-boss 12, not Trigger.dev" for the *queue driver*, but the SDK itself is genuinely
  imported: `backend-api/src/jobs/corpus.ingest.ts:1`, `video.transcode.ts:1`,
  `video.generate.ts:1`, plus the archived v1 podcast pipeline). Correctly kept as a `dependencies`
  entry.
- **firebase (client SDK) 10.13.0/10.14.1**: checked against CVE-2024-11023
  (`FIREBASE_DEFAULTS` cookie session-hijack, fixed in 10.9.0) — both resolved versions
  (`pnpm-lock.yaml:3578`, `firebase@10.14.1`) are past the fix. Clean.
- **`@fastify/multipart@8.3.1`** (resolved, `pnpm-lock.yaml:1119`) and **`fastify@4.29.1`**
  (resolved, `pnpm-lock.yaml:3531`): both land exactly on or past the fixed versions for the
  advisories checked — CVE-2025-24033 (fixed 8.3.1) and CVE-2025-32442 (fixed 4.29.1)
  respectively. Clean.
- **`shared: file:../shared`** in `backend-api`/`client-web`/`admin-web`: confirmed all three
  Dockerfiles (`backend.Dockerfile`, `web.Dockerfile`, `export-worker.Dockerfile`) build with
  repo-root context and explicitly `COPY shared/` before install/build, so the `file:` link
  resolves correctly inside the image. No supply-chain gap here.
- **No git/tarball dependencies**: `grep -n "git+\|github:\|tarball" pnpm-lock.yaml` found zero
  matches — every dependency resolves from the npm registry.
- **Version consistency across workspaces**: `typescript` (`^5.5.4`), `vitest` (`^4.1.7`), `eslint`
  (`^9.39.4`), `tailwindcss` (`^3.4.14`), `zod` (`^3.23.8` at the direct-dependency level),
  `@types/node` (`^22.0.0`/`^22.10.2`), and `next` (`15.1.0` exact) are pinned identically across
  every workspace package that declares them — no split-version drift found.
- **Licences**: spot-checked the browser-bundled packages in `client-web`/`admin-web`
  (`next`, `react`, `chart.js`, `hls.js`, `katex`, radix packages, `firebase`) — all MIT/BSD/Apache-2.0
  by package, no copyleft found reaching a shipped bundle. The ffmpeg build in
  `backend.Dockerfile` uses the `-gpl-` BtbN variant (GPLv2/v3 codecs such as x264/x265); this is
  server-side-only (never distributed as a binary to end users — only its output, encoded video,
  leaves the box), so it does not trigger GPL source-provision obligations for a SaaS deployment.
  Noted, not filed as a finding.
- **`pnpm-lock.yaml` / manifest sync**: `lockfileVersion: '9.0'`, `autoInstallPeers: true`. Spot-
  checked every direct dependency named in scope (adm-zip, `@fastify/multipart`, fastify, next,
  firebase-admin, postgres, stripe, the four LLM SDKs, tsoa, `@trigger.dev/sdk`) against a lockfile
  entry — every manifest range has a satisfying lockfile resolution. No drift found.
