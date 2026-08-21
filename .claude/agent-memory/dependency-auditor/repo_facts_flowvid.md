---
name: repo-facts-flowvid
description: Durable facts about FlowVid's dependency surface that are non-obvious from a single manifest read and are worth re-checking (not re-deriving from scratch) on future audits.
metadata:
  type: project
---

Facts confirmed by direct grep/lockfile inspection during the 2026-08-16 dependency audit
(commit 2d187e3). Re-verify before trusting if much time has passed — these are point-in-time.

- **`@trigger.dev/sdk` is a live dependency, not dead.** Easy to assume dead because stack.md says
  the queue *driver* is pg-boss, not Trigger.dev — but the SDK itself is genuinely imported in
  `backend-api/src/jobs/{corpus.ingest,video.transcode,video.generate}.ts` for `task()` definitions.
  Do not re-flag it as unused without re-grepping.
- **`tsoa` is genuinely dead**: zero imports in `backend-api/src`, `tsoa.json` present but nothing
  wires it into any script. Filed as dependency-003. Confirm still true (repo may have removed it)
  before re-filing.
- **`sharp`, `protobufjs` in `pnpm-workspace.yaml` `allowBuilds` are legitimate transitive deps**
  (sharp via `next`'s `optionalDependencies` for `next/image`; protobufjs via
  `firebase-admin → @google-cloud/firestore → google-gax`) — **`bson` is not**, it does not appear
  anywhere in `pnpm-lock.yaml`. Re-check `bson`'s presence specifically on future audits; the other
  four entries (`@google/genai`, `esbuild`, `protobufjs`, `sharp`) were each traced to a real
  consumer and are fine.
- **`backend.Dockerfile`'s ffmpeg download is not actually pinned to fixed bytes** despite its own
  comment claiming "a PINNED static build" — it pulls from BtbN/FFmpeg-Builds' `latest` GitHub
  release tag (a rolling release, retention: last 14 daily + last-of-month) with no checksum. The
  sibling `export-worker.Dockerfile`'s Chrome-headless-shell stage *does* verify against a
  published hash via `@puppeteer/browsers`. This asymmetry is worth re-checking each audit since
  it's an easy thing for someone to "fix" the Chrome side and forget the ffmpeg side.
- **`client-web/middleware.ts` exists but performs no authz** (only 410/redirect logic for
  archived/legacy course URLs) — relevant because Next.js middleware-bypass CVEs (e.g.
  CVE-2025-29927) are otherwise a P0 pattern; here it's P1 because there's nothing security-bearing
  in the middleware to bypass yet. If a future `middleware.ts` change adds an auth check, re-grade
  any outstanding Next.js version-gap finding.
- **Zip-upload paths (`AdmZip` fed directly from user uploads) are the highest-value place to check
  adm-zip advisories**: `SimulationService.extractZip` (:3327), `simulations.controller.ts:649`,
  `avatar.controller.ts:145` (`zipHasHtml`). All gated by `firebaseAuthMiddleware`, so any adm-zip
  DoS/traversal finding here is an authenticated-user issue, not unauthenticated.
