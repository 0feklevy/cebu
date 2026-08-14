## dependency-auditor findings

Method: read every manifest (`podcast-saas/{package.json,pnpm-workspace.yaml}`,
`backend-api|client-web|admin-web|shared|ops/release/package.json`), resolved exact installed
versions from `podcast-saas/pnpm-lock.yaml` (corroborated with a read-only
`pnpm -C podcast-saas list --filter backend-api --depth 0`), cross-checked imports against
manifests in both directions (declared-but-unimported, imported-but-undeclared) with scripted
greps over `src/**/*.ts(x)`, and looked up advisories for the untrusted-input-facing direct
dependencies named in scope. Did not and cannot run `pnpm audit`.

**Checked clean (no advisory found / installed version already past the fix), not filed as findings:**
`@fastify/multipart@8.3.1` (exactly the fixed version for GHSA-27c6-mcxv-x3fh / CVE-2025-24033,
which affects `<=8.3.0`), `fastify@4.29.1` (GHSA-455w-c45v-86rg only affects `<4.8.1`),
`firebase-admin@12.7.0` (pulls `node-forge@1.4.0`, past the 1.3.2 fix for GHSA-5gfm-wpxj-wjgq),
`postgres@3.4.9`, `stripe@22.2.0`, `@anthropic-ai/sdk@0.38.0` (the two known SDK advisories,
GHSA-p7fg-763f-g4gf and GHSA-5474-4w2j-mq4c, both require `>=0.79.0`; this repo pins `0.38.0`),
`openai@4.104.0`, `groq-sdk@0.8.0`, `@google/genai@1.52.0`. `shared: file:../shared` resolves as
a pnpm workspace symlink (confirmed via `pnpm list` → `shared@link:../shared`), not a literal
file fetch, so the Docker build's `COPY shared/ shared/` before `pnpm install` is sufficient.

---

### [P1] adm-zip 0.5.17 is vulnerable to a confirmed DoS (CVE-2026-39244) and is fed attacker-sized ZIP uploads from two authenticated endpoints
- id: dependency-001
- location: podcast-saas/backend-api/package.json:29 (adm-zip ^0.5.10, resolves 0.5.17 in podcast-saas/pnpm-lock.yaml:2732); called at podcast-saas/backend-api/src/services/simulation/SimulationService.ts:3327 and podcast-saas/backend-api/src/controllers/v1/avatar.controller.ts:145
- category: security
- confidence: high
- status: confirmed
- what: `adm-zip@0.5.17` is affected by CVE-2026-39244 / GHSA-xcpc-8h2w-3j85 (CVSS 7.5, High): `Buffer.alloc()` sizes its allocation from the ZIP central-directory header's declared uncompressed size without validating it against the actual compressed payload or any upper bound, and the allocation happens before CRC validation. A ~120-byte crafted ZIP declaring a ~4GB uncompressed size triggers a >33-million-to-1 amplification. Fixed in 0.6.0. In this repo, `SimulationService.extractZip(buf)` (line 3327) calls `new AdmZip(buf)` then `entry.getData()` for every entry, and `avatar.controller.ts` `zipHasHtml(buffer)` (line 145) calls `new AdmZip(buffer).getEntries()` — both run directly on a user-uploaded buffer with no size/entry-count pre-check. The upload path (avatar.controller.ts:526-527, `isZip` branch) is reached from an authenticated project-scoped multipart upload; the global multipart limit is 10 GB (server.ts:199), which does nothing to stop a 120-byte malicious file.
- why: Any authenticated user who can upload to a project can send a hand-crafted tiny ZIP that makes the backend-api process attempt a multi-gigabyte allocation. Because backend-api runs as a single Fastify process serving all tenants (unlike the sandboxed export-worker container), a successful trigger is a plausible OOM/crash of the whole API, not just the uploading user's session.
- evidence: GitHub Advisory GHSA-xcpc-8h2w-3j85 (https://github.com/advisories/ghsa-xcpc-8h2w-3j85), fixed in adm-zip 0.6.0, affected `<0.6.0`. Installed version confirmed via `grep -n "adm-zip@" podcast-saas/pnpm-lock.yaml` → `adm-zip@0.5.17` (line 2732) and `pnpm -C podcast-saas list --filter backend-api --depth 0` → `adm-zip@0.5.17`. Call sites read via `Read podcast-saas/backend-api/src/services/simulation/SimulationService.ts:3316-3336` and `podcast-saas/backend-api/src/controllers/v1/avatar.controller.ts:143-149,495-529`.
- fix: Bump `adm-zip` from `^0.5.10` to `0.6.0`. This is a pre-1.0 minor bump (0.5→0.6), which semver treats as potentially breaking — diff the `getEntries()`/`getData()`/constructor API before rolling it out and re-run the simulation-upload and avatar-upload test suites. Independent of the library fix, add a defensive pre-check before either call site touches `AdmZip`: read the ZIP end-of-central-directory record yourself (or use `adm-zip`'s entry list lazily) and reject files whose declared uncompressed size or entry count exceeds a fixed cap (e.g. a few hundred MB / a few thousand entries) before calling `getData()`.
- verify: After upgrading, craft the ~120-byte PoC ZIP from the advisory and confirm `SimulationService.extractZip` and `avatar.controller.ts`'s `zipHasHtml` reject it without attempting the large allocation (process RSS stays flat); `pnpm -C podcast-saas --filter backend-api test` covering `SimulationService` stays green.
- effort: M

### [P2] Next.js 15.1.0 is pinned exactly and predates the fix for a critical (CVSS 9.1) middleware-bypass CVE
- id: dependency-002
- location: podcast-saas/client-web/package.json:34 and podcast-saas/admin-web/package.json:18 (`"next": "15.1.0"`, exact pin, no caret); podcast-saas/pnpm-lock.yaml:4237/9687
- category: security
- confidence: high
- status: confirmed
- what: Next.js 15.1.0 predates the fix for GHSA-f82v-jwr5-mffw / CVE-2025-29927 (CVSS 9.1): a crafted `x-middleware-subrequest` header lets a request skip `middleware.ts` entirely. Fixed in 15.2.3+. Both `client-web` and `admin-web` pin `"next": "15.1.0"` exactly (no caret — an intentional, deliberate pin that has not been revisited since). `client-web/middleware.ts` exists and matches `/c/:path*`, `/v/:path*`, `/pl/:path*`; `admin-web` has no `middleware.ts`.
- why: Read the full body of `client-web/middleware.ts` (92 lines): it does not perform any authentication or authorization check — it only sets a 410 for archived courses, issues 308 redirects for archived/legacy content, and otherwise falls through (`res?.status` other than `gone`/`redirect` already falls through to the page per the file's own header comment). So in *this* app the demonstrated blast radius of the bypass is limited to skipping the "Gone"/redirect courtesy handling for archived content — not an authorization bypass of a protected route, since none is implemented in middleware. That keeps this out of P0/P1 territory here, but it is still a disclosed critical-CVSS vulnerability sitting unpatched in a production dependency serving public traffic, and the exact-pin means nobody gets it via a routine caret bump.
- evidence: GHSA-f82v-jwr5-mffw (https://github.com/advisories/GHSA-f82v-jwr5-mffw), CVE-2025-29927, affects Next.js `<15.2.3` for the 15.x line. Installed version confirmed via `grep -n "next@" podcast-saas/pnpm-lock.yaml` → `next@15.1.0` (lines 4237, 9687) and `grep -n '"next"' podcast-saas/client-web/package.json podcast-saas/admin-web/package.json`. Middleware content read in full (`podcast-saas/client-web/middleware.ts:1-92`); `find` confirmed no `admin-web/middleware.ts`.
- fix: Bump `next` to `15.2.3` or later (ideally the latest 15.x) in both `client-web/package.json` and `admin-web/package.json`, keep the two in sync since they share the `web.Dockerfile` build. Risk of the bump: 15.1→15.2/15.4 changed App Router caching defaults and some edge-runtime behavior — re-run both Playwright suites and specifically re-test the `/c/*` archive-status and legacy-redirect matcher paths in `middleware.ts` after upgrading, since that's the one place this app's behavior is coupled to middleware semantics.
- verify: `pnpm -C podcast-saas --filter client-web typecheck` and `pnpm -C podcast-saas --filter client-web test:smoke` after the bump; manually replay a request with `x-middleware-subrequest` set against a `/c/*` URL pre- and post-upgrade to confirm the header no longer skips the handler.
- effort: M

### [P2] client-web declares 10 dependencies with zero imports anywhere in its source
- id: dependency-003
- location: podcast-saas/client-web/package.json:15-39 (dependencies block)
- category: maintainability
- confidence: high
- status: confirmed
- what: `zod`, `clsx`, `tailwind-merge`, `class-variance-authority`, `@radix-ui/react-dropdown-menu`, `@radix-ui/react-label`, `@radix-ui/react-progress`, `@radix-ui/react-select`, `@radix-ui/react-tabs`, and `@radix-ui/react-toast` are declared as runtime dependencies but match zero `from '<pkg>'`/`require(...)`/dynamic-`import(...)` occurrences and zero bare string occurrences anywhere under `client-web` (checked `.ts`/`.tsx`/`.js`/`.mjs`, excluding `node_modules`/`.next`). `@radix-ui/react-dialog` (5 files) and `lucide-react` (43 files) *are* used, so this isn't a wholesale "radix isn't used" claim — it's these ten specific packages.
- why: Ten of client-web's 21 declared dependencies (nearly half) are dead weight: they inflate `pnpm install` time and the dependency graph for no runtime benefit, and each is a live supply-chain surface (a compromised `clsx` or `@radix-ui/react-select` release would still get pulled in) for code that doesn't run. It also actively misleads: a reader sees `zod` declared and reasonably assumes client-web does runtime validation with it — it doesn't (validation lives in `shared` and `backend-api`).
- evidence: `grep -rlE "from ['\"]<pkg>(/|['\"])" .` returned no hits for any of the ten packages across `client-web` (excluding `node_modules`/`.next`); confirmed with a plain literal-string `grep -rln -- "<pkg>"` pass to rule out re-export/dynamic-import false negatives (the same follow-up check correctly caught `hls.js`, which is loaded via `await import('hls.js')` and is genuinely used — so the method isn't systematically blind to non-static imports).
- fix: Remove the ten unused entries from `client-web/package.json`'s `dependencies`. If any were added for near-term work (e.g. `@radix-ui/react-select` for an in-progress form), leave a one-line comment or move the PR that will use it sooner rather than carrying it silently.
- verify: `pnpm -C podcast-saas --filter client-web typecheck` and `pnpm -C podcast-saas --filter client-web build` stay green after removal (proves nothing was actually reachable through a path this audit's grep missed).
- effort: S

### [P2] admin-web declares 4 dependencies with zero imports anywhere in its source
- id: dependency-004
- location: podcast-saas/admin-web/package.json:9-18 (dependencies block)
- category: maintainability
- confidence: high
- status: confirmed
- what: `clsx`, `tailwind-merge`, `class-variance-authority`, and `lucide-react` are declared but have zero import/require occurrences anywhere under `admin-web` (`.ts`/`.tsx`, excluding `node_modules`/`.next`). `firebase`, `next`, `react`, `shared` are all genuinely used.
- why: Same class of issue as dependency-003, on the smaller admin-web manifest — 4 of 9 declared dependencies are unused.
- evidence: `grep -rln -- "<pkg>" .` over `admin-web` (excluding `node_modules`/`.next`) returned no hits for any of the four names.
- fix: Remove `clsx`, `tailwind-merge`, `class-variance-authority`, and `lucide-react` from `admin-web/package.json`'s `dependencies`.
- verify: `pnpm -C podcast-saas --filter admin-web typecheck` and `pnpm -C podcast-saas --filter admin-web build` stay green after removal.
- effort: S

### [P3] tsoa is declared as a backend-api runtime dependency and imported nowhere; tsoa.json describes a codegen pipeline that doesn't exist
- id: dependency-005
- location: podcast-saas/backend-api/package.json:53 (`"tsoa": "^6.4.0"` under `dependencies`); podcast-saas/backend-api/tsoa.json
- category: maintainability
- confidence: high
- status: confirmed
- what: `grep -rn "from 'tsoa'\|require('tsoa')" podcast-saas/backend-api/src` returns nothing, and the scripted import-audit across every `dependencies` entry confirms it's the only one with zero hits. `tsoa.json` sits beside it configuring `controllerPathGlobs: ["src/controllers/**/*.controller.ts"]` and `routesDir: "src/generated"`, but `backend-api/src/generated` does not exist and no npm script invokes `tsoa`/`tsoa spec-and-routes` (the root `package.json`'s `"generate"` script calls a `backend-api` `generate` script that doesn't exist either — a related, pre-existing drift already tracked in `.claude/reference/stack.md`). Routes in this codebase are hand-registered `register*Routes(app)` functions, not TSOA decorators.
- why: This is worse than an ordinary unused dependency because the *combination* of a present `tsoa.json` and a real, matching `controllerPathGlobs` pattern actively suggests a working OpenAPI-generation pipeline to anyone reading the repo, when none exists. It's the exact trap `.claude/reference/stack.md` already documents under "Traps that have already produced wrong findings" — filing it here per this audit's explicit instruction to confirm and record it in the dependency-specific findings file.
- evidence: `grep -rn "from 'tsoa'\|require('tsoa')" podcast-saas/backend-api/src` → no matches; `grep -rln "tsoa" podcast-saas/backend-api --include=*.ts --include=*.json` → only `package.json` and `tsoa.json` itself; `find podcast-saas/backend-api/src/generated` → does not exist; `podcast-saas/backend-api/package.json` `scripts` block has no `generate`/`tsoa` entry.
- fix: Delete the `tsoa` dependency from `backend-api/package.json` and delete `backend-api/tsoa.json`, or — if TSOA-generated routing is actually planned — wire up the `generate` script, run it once, and commit the output so the config stops being aspirational.
- verify: `pnpm -C podcast-saas --filter backend-api typecheck` and `pnpm -C podcast-saas --filter backend-api test` stay green after removing the dependency (nothing imports it, so nothing should break).
- effort: S

### [P3] pnpm-workspace.yaml's allowBuilds grants install-time code execution to `bson`, which is not present anywhere in pnpm-lock.yaml
- id: dependency-006
- location: podcast-saas/pnpm-workspace.yaml:6-11 (`allowBuilds: bson: true`)
- category: maintainability
- confidence: high
- status: confirmed
- what: `allowBuilds` lists five packages permitted to run install-time build/postinstall scripts: `@google/genai`, `bson`, `esbuild`, `protobufjs`, `sharp`. Of these, `@google/genai` is a direct, imported dependency (backend-api); `esbuild` is a direct devDependency of `client-web` and also a transitive build tool for `drizzle-kit`/`tsx`/`vitest`; `protobufjs` is a transitive dependency of the Google/Firebase SDKs (7 consumer sites in the lockfile); `sharp` is `next`'s optional peer for image optimization (`podcast-saas/pnpm-lock.yaml:9709`, nested under the `next@15.1.0` `optionalDependencies` block). `bson` has **zero** occurrences anywhere in `podcast-saas/pnpm-lock.yaml` — it is not installed, direct or transitive, by anything in this workspace.
- why: An `allowBuilds` entry for a package that isn't in the tree is currently inert, but it's dangling config: it grants blanket install-script trust to a package name with no owner and no review trail tying it to a need. If `bson` (or a same-named malicious package) is ever pulled in transitively later — e.g. by a future MongoDB-adjacent tool — it would silently inherit build permission with no one re-examining whether that's still warranted.
- evidence: `grep -ni "bson" podcast-saas/pnpm-lock.yaml` → no matches. Cross-checked `sharp`, `protobufjs`, `esbuild` each resolve to real consumers in the same lockfile (`sharp@0.33.5` nested under `next@15.1.0(...)`'s `optionalDependencies` at line 9709; `protobufjs@7.6.1` referenced as a dependency at 6 other lockfile locations; `esbuild` declared directly in `client-web/package.json:51` and present as 3 versions pulled transitively by dev tooling).
- fix: Remove the `bson: true` line from `pnpm-workspace.yaml`'s `allowBuilds`. If a MongoDB-adjacent dependency reintroducing `bson` is added later, re-add the entry then, with a comment naming what pulled it in.
- verify: Re-grep `pnpm-lock.yaml` for `bson` after any future dependency changes before re-adding the entry.
- effort: S

### [P2] All three Dockerfiles ship the full builder node_modules — including devDependencies — into the runtime image
- id: dependency-007
- location: podcast-saas/deploy/docker/backend.Dockerfile:38 (`COPY --from=builder --chown=node:node /app /app`); podcast-saas/deploy/docker/web.Dockerfile:57 (same pattern); podcast-saas/deploy/docker/export-worker.Dockerfile:72 (same pattern)
- category: maintainability
- confidence: high
- status: confirmed
- what: All three Dockerfiles run `pnpm install --frozen-lockfile --filter "<app>..."` in the builder stage with no `--prod` flag and no subsequent `pnpm prune --prod` / `pnpm deploy` step, then `COPY --from=builder ... /app /app` copies the entire builder tree — including `node_modules` populated with devDependencies — straight into the runner stage. `NODE_ENV=production` is set only in the runner stage's `ENV`, after the copy, so it has no effect on what was installed. Neither `client-web` nor `admin-web`'s `next.config.*` sets `output: 'standalone'` (verified: no `output` key in either config), and both run via `pnpm start` → `next start`, which needs the full `node_modules`, not a pruned standalone bundle — so "just add `output: 'standalone'`" is the natural fix, not a `prune` bolted on afterward.
- why: The internet-facing `backend`/`worker`/`web` containers ship `eslint`, `vitest`, `drizzle-kit`, `tsx`, `typescript`, `@playwright/test`, `jsdom`, `@testing-library/react`, and friends into production — none of which `node dist/server.js` or `next start` need at runtime. This is pure unnecessary attack surface and image bloat (slower pulls/deploys on the resource-constrained VM the deploy docs already treat as memory-tight, per `NODE_BUILD_MEMORY` comments in the same files).
- evidence: Read all three Dockerfiles in full; none contains `prune`, `--prod`, or `pnpm deploy`. `grep -n "output" client-web/next.config.* admin-web/next.config.*` → no match.
- fix: For `web.Dockerfile`: add `output: 'standalone'` to both `next.config.*` files and switch the runner `COPY` to pull `.next/standalone` + `.next/static` + `public/` instead of the whole `/app`. For `backend.Dockerfile`/`export-worker.Dockerfile`: after the `tsc` build step, run `pnpm --filter backend-api deploy --prod /prod-out` (or `pnpm prune --prod` in the builder stage) and `COPY --from=builder /prod-out /app` in the runner instead of copying the unpruned tree.
- verify: After the change, `docker run <image> node -e "require('eslint')"` (or an equivalent check) should fail with `Cannot find module`; the API/worker/web images should still boot and pass a smoke request.
- effort: M

### [P2] Backend/worker Dockerfile fetches the pinned static ffmpeg build over HTTPS from a mutable "latest" GitHub release tag with no checksum verification
- id: dependency-008
- location: podcast-saas/deploy/docker/backend.Dockerfile:52-61
- category: security
- confidence: high
- status: confirmed
- what: `FFMPEG_BUILD=ffmpeg-n8.1-latest-linux64-gpl-8.1` names a specific build, but the download URL is `https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/${FFMPEG_BUILD}.tar.xz` — the *release* is the literal tag `latest`, a rolling release BtbN periodically republishes with a fresh asset set. The `install` steps place the extracted `ffmpeg`/`ffprobe` straight into `/usr/local/bin` with no `sha256sum -c` or GPG check against a published digest. Contrast with `export-worker.Dockerfile`'s Chrome download in the same repo (lines 47-51), which is fetched via `@puppeteer/browsers install`, and that tool verifies the download against the published Chrome-for-Testing hash for the pinned build id — the ffmpeg fetch has no equivalent.
- why: The filename is versioned, which is good discipline, but nothing stops (a) BtbN pruning that filename from the `latest` release before this image is next rebuilt (silent build breakage — already once bit this repo per the comment block explaining the ffmpeg 5.1→8 incident) or (b) a compromised release asset being installed into the image with zero integrity check, unlike every other pinned binary in this repo's Docker builds.
- evidence: Read `backend.Dockerfile:44-62` in full; the `curl` call targets `.../releases/download/latest/...` (not a version-numbered release tag) and the pipeline `curl → tar -xJf → install` has no hash-verification step anywhere in between. `export-worker.Dockerfile:47-51` shows the alternative pattern already in use elsewhere in this same repo for exactly this kind of binary fetch.
- fix: Pin to a specific numbered BtbN release tag (e.g. `releases/download/autobuild-2026-XX-XX/...` or whatever tag BtbN cuts for the `n8.1` line) instead of `latest`, and add a `sha256sum -c` check against a digest recorded in the Dockerfile (BtbN publishes `.sha256` files alongside each asset) before the `install` step.
- verify: `docker build` (config-deploy-reviewer's lane to actually run) should fail closed if the downloaded file's hash doesn't match the recorded one, rather than silently installing whatever `latest` currently serves.
- effort: S

### [P3] The pinned static ffmpeg build is a GPL (not LGPL) build bundled into the shipped backend/worker image, with no licence note in the repo
- id: dependency-009
- location: podcast-saas/deploy/docker/backend.Dockerfile:52 (`FFMPEG_BUILD=ffmpeg-n8.1-latest-linux64-gpl-8.1`)
- category: maintainability
- confidence: medium
- status: suspected
- what: BtbN's `-gpl-` build variant links GPL-licensed components (e.g. libx264/libx265) rather than the `-lgpl-` variant. This binary is installed into both the `backend` and `worker` images (they share `backend.Dockerfile`).
- why: Because this is server-side SaaS infrastructure — the ffmpeg binary itself is never distributed to end users, only its output media is — GPL's distribution-triggered copyleft obligations most likely don't attach here (this isn't AGPL, so network/SaaS use alone doesn't trigger source-sharing requirements either). I did not find and could not fully verify whether any code path re-exposes the binary itself (e.g. a debug/support-bundle endpoint that ships container contents) — marking `suspected` pending that check, which is outside this audit's read-only reach.
- evidence: Filename convention documented by BtbN's release naming (`-gpl-` vs `-lgpl-` suffix distinguishes the two build flavors); did not fetch BtbN's build matrix to confirm the exact component list bundled in `n8.1-gpl-8.1`, so treat the specific GPL component list as unconfirmed.
- fix: No code change required. Add a one-line `NOTICE`/comment recording the deliberate choice of the GPL build (it's presumably chosen for a codec/feature the LGPL build lacks) and confirming no code path serves the ffmpeg binary itself to a client, so the next reader doesn't have to re-derive this.
- verify: N/A — documentation-only.
- effort: S
