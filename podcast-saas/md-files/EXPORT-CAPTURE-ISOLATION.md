# Export capture isolation — operational runbook

**Scope.** The Linear Video Export capture worker (Phase 2) runs **untrusted code** and must be
isolated so that SSRF and secret exfiltration are **impossible by construction, not by filtering**.
This document is the threat model, every isolation control and *why*, the container-verification
checklist (the parts that can only be proven inside a real Linux container), and the deploy story.
It is the operative companion to `md-files/LINEAR-VIDEO-EXPORT-PLAN.md` **§0.2 (Security
architecture — a v1 requirement)**, which this build makes real.

**What "the capture worker" is.** A short-lived container that renders **one scripted simulation
section** into frames: `chrome-headless-shell` navigates to the section's simulation, driven by the
product's own v2 bridge under a deterministic clock, and writes frames the trusted side assembles
with ffmpeg. One container per section (sharded, concurrency-limited like `FFMPEG_CONCURRENCY`).

> **Note on the plan's later pivot.** `LINEAR-VIDEO-EXPORT-PLAN.md` later pivots v1 to *on-device*
> capture and demotes this headless worker to the **fallback / v2 automation** path ("Where the
> headless path survives"). This runbook covers that headless worker — it blocks nothing in v1 and
> the assembler consumes `sections/{sectionId}.*` identically from either producer. Its isolation
> requirements are unchanged: the headless worker still runs untrusted generated JavaScript.

---

## 1. Threat model

**What is untrusted.** The simulation HTML/JS is **generated from user prompts**, and there is a
**ZIP-upload path** — so the bytes the browser executes are, for security purposes, arbitrary
attacker-controlled JavaScript. It runs in a real Chromium with a real network stack.

**What an attacker would try**, and what each buys them if it works:

| Goal | Vector inside the sim | Impact if reachable |
|---|---|---|
| Cloud credential theft | `fetch('http://169.254.169.254/latest/meta-data/…')` (IMDS) | STS creds → the whole AWS account |
| Internal SSRF | `fetch` the backend, admin, Postgres, Redis, internal services | data exfiltration, privilege escalation |
| Secret exfiltration | read env / disk for API keys, DB URLs, cookies | Stripe/LLM keys, DB access |
| Persistence / lateral movement | write the rootfs, spawn processes, exhaust the host | worker compromise, noisy-neighbour DoS |
| Sandbox escape | a Chromium renderer 0-day | host compromise |

**The SwiftShader inversion — stated because it is the crux of *why* isolation is non-negotiable
here.** Chromium's own console warning for `--enable-unsafe-swiftshader` says it lowers security
guarantees and is intended for **trusted** content. We render software WebGL for GPU-less
determinism (plan §4), so **we run exactly the configuration Chromium warns is for trusted content —
against untrusted content.** That is not a reason to avoid SwiftShader (we need it); it is the reason
the *container* around it must assume the browser process is hostile and give it nothing to reach.

**Design principle.** Do not enumerate and block bad destinations (a deny-list is a race the
attacker only has to win once). **Remove the capability.** The container has no network egress, no
credentials, no writable rootfs, and no route to anything but a loopback socket serving bytes we
already vetted.

---

## 2. The crux: `--network none` and a loopback server are NOT in tension

The simulation has to load from *somewhere*, yet the container has no network. These sound
contradictory. They are not, and this is the single most important claim in the design:

- **`--network none` creates a fresh, isolated network namespace with only the loopback interface
  `lo`, and `lo` is brought UP.** It removes the veth pair to the bridge and the default route — it
  does **not** remove or down `lo`. So `127.0.0.1` is reachable *inside the container*, and nothing
  else is.
- Therefore: the trusted job downloads the (already-immutable) package on the trusted side, hands
  the bytes into the container on a read-only mount, and a tiny **loopback package server** (ours,
  `loopbackPackageServer.ts`) serves them on `127.0.0.1:<port>`. Chrome navigates to
  `http://127.0.0.1:<port>/<entry>?section=…&v=…#simboot=…`.
- The sim can reach the loopback server and **nothing else** — not IMDS, not the backend, not
  Postgres, not any internal host. There is no route for a packet to take.

This claim is **verified-in-container: PENDING** on this machine (macOS) — it is item **C1** of the
checklist in §7. It is the one thing that most needs to be confirmed on a real Linux host, and the
checklist confirms both halves in one run: egress to a canary is refused *while* `127.0.0.1` serves.

The loopback server is additionally hardened so that even inside the namespace it is a poor target:

- It serves from a **frozen in-memory map**, not a filesystem — so **path traversal is structurally
  impossible**: a request path is a key lookup, never an `open()`, and there is no directory to climb
  out of. (Verified locally — §6.)
- It **can only bind a loopback literal** (`127.0.0.1`/`::1`); a non-loopback host throws at
  construction. "Accidentally bound `0.0.0.0`" is not a state this class can enter. (Verified
  locally — §6.)
- It answers only `GET`/`HEAD`, sets `X-Content-Type-Options: nosniff`, and serves the immutable
  cache header. There is no write path over the socket; captured output leaves by a file mount.

---

## 3. No credentials, ever — the trusted/untrusted boundary

The container **never holds a credential**. The boundary (`captureJobBoundary.ts`) is narrow and
one-directional in each leg:

- **In** → the package bytes (downloaded by the trusted job via a presigned GET) plus a
  `capture-spec.json` that is **pure description**. `buildCaptureSpec` deliberately **drops the
  external origin** of the stored `servedUrl` and keeps only its `?section=&v=` query and
  `#simboot=` fragment (losing either breaks dispatch / the pre-paint cloak — plan §4). The spec
  carries no URL to any external origin, no presigned URL, no DB handle, no cookie, no token. A
  recursive guard (`FORBIDDEN_SPEC_KEY_SUBSTRINGS`) throws if a credential-shaped key ever appears,
  and a unit test asserts the serialized spec is clean.
- **Out** → frames/clip written to the `/output` mount, plus a `result.json` describing what was
  produced and the renderer identity. The **trusted side** reads those off the shared directory and
  does the presigned PUT itself.

The presigned GET/PUT are minted by `ProjectExportService` (trusted, has the DB) and **never shared
with the browser process**. Because the container has no network anyway, it could not use a
presigned URL even if one leaked in.

**Alignment with the browser-driver half.** The sibling owns `capture/captureTypes.ts` — the
in-process `SimCaptureBackend.captureSection(spec)` contract, whose `spec.servedSimUrl` is exactly
the loopback URL this layer serves. `backendAdapter.ts` is the single bridge: it builds the
backend's `CaptureSpec` from this layer's `ContainerCaptureSpec` + the loopback entry URL, and
relocates the backend's artifacts onto `/output` (the backend writes to the ephemeral tmpfs, so the
bytes must be copied to the bind mount before exit). To avoid a name collision, this layer's
file-boundary shapes are `ContainerCaptureSpec` / `ContainerCaptureResult`; the result field names
(`framesDir`/`clipPath`/`frameCount`/`rendererString`/`gate`/`reason`) match the sibling's so the
container result is a strict superset of the in-process one.

---

## 4. Every isolation control, and why

Applied by `containerRunArgs.buildContainerRunArgv` (the authoritative, unit-tested source) and
mirrored for review in `deploy/docker-compose.export-worker.yml`.

| Control | Flag | Why |
|---|---|---|
| No network egress | `--network none` | The crux (§2). No route to IMDS/backend/Postgres/anything. `lo` stays up so the loopback server serves. |
| Read-only rootfs | `--read-only` | The sim cannot persist, cannot overwrite the runtime, cannot stage a payload. |
| Single RAM scratch | `--tmpfs /tmp:rw,nosuid,nodev,noexec,size=…,mode=1777` | The only writable surface Chrome needs (user-data-dir, `/dev/shm` substitute under `--disable-dev-shm-usage`, temp). RAM-backed, ephemeral, `noexec` so nothing dropped there runs. |
| Input, read-only | `--mount …,dst=/input,ro` | Package bytes + spec go in; the sim cannot tamper with them. |
| Output, minimal RW | `--mount …,dst=/output` | Frames/clip come out; the trusted side reads them. Put the host dir on tmpfs so captures never touch disk. |
| Non-root | `--user 10001:10001` (also baked into the image) | No root in the container even before other controls; assembler **refuses** a root user. |
| Drop all caps | `--cap-drop ALL` | Remove every Linux capability; the userns sandbox needs none (§5). |
| No privilege escalation | `--security-opt no-new-privileges:true` | Blocks setuid escalation; compatible with the userns sandbox. |
| CPU / memory / PID quotas | `--cpus`, `--memory` + `--memory-swap` (equal ⇒ no swap), `--pids-limit` | Bound a runaway/adversarial sim: no fork bomb, no OOM of the host, no CPU monopoly. |
| Proper PID 1 | `--init` | tini reaps zombies and forwards SIGKILL to the whole tree so the wall-clock kill is clean. |
| Graceful window | `--stop-timeout` | Bounds `docker stop`; the hard wall-clock kill is the orchestrator's (below). |
| Chrome's own sandbox KEPT | **no `--no-sandbox`**, ever | The renderer sandbox stays on; we grant what it needs instead of disabling it (§5). |
| No secrets | **no `-e`/`--env`/`--env-file`** carrying credentials | The spec is a file on `/input`, never an env var. |

**The hard wall-clock timeout that SIGKILLs.** Docker cannot SIGKILL itself on a wall clock, so the
orchestrator enforces it: `DockerCaptureBoundary` starts an unref'd timer and, on expiry (or on an
`AbortSignal` cancel after a graceful `docker stop`), runs `docker kill --signal=KILL <name>`, which
tears down the whole container including the browser. Per-section and per-job caps both apply.

**Flags that must NEVER appear** (each would silently break or weaken the design — plan §4):
`--no-sandbox` (disables the renderer sandbox), `--privileged` (defeats the whole model),
`--disable-gpu` (silently re-enables SwiftShader in a way that can null WebGL contexts on 144+),
`--in-process-gpu` / `--single-process` (kill the GL surface ANGLE needs). The run-arg assembler
emits none of these and a unit test asserts their absence.

**Determinism doubles as isolation.** The seeded PRNG (mulberry32 from `configHash`) and the virtual
clock (plan §4) also remove two side channels (`Math.random`, real time) — a hostile sim cannot use
them to fingerprint the host or smuggle entropy out through frame timing.

---

## 5. Chrome's own sandbox, kept — exactly which capability, and the fallbacks

We do **not** pass `--no-sandbox`. Chrome's Linux sandbox has two layers we keep: the **namespace
sandbox** (isolates each renderer in its own namespaces) and the **seccomp-bpf** layer inside each
renderer. The classic reason people reach for `--no-sandbox` in Docker is that the namespace sandbox
needs to create a user namespace, which some host configurations block. We grant that instead of
disabling the sandbox. `containerRunArgs` supports three mechanisms via `sandboxMechanism`:

- **`userns` (default, least privilege).** `chrome-headless-shell`'s namespace sandbox creates an
  **unprivileged user namespace** (`unshare(CLONE_NEWUSER|…)`). Creating a *new* user namespace
  requires **no capability** — that is the point of unprivileged userns — so it is fully compatible
  with `--cap-drop ALL`. The "grant" is a **host** property: unprivileged user namespaces must be
  enabled (default on modern Debian/Ubuntu/Amazon Linux 2023), and Docker's **default** seccomp
  profile already permits the needed `clone`/`unshare`. No extra docker flag is emitted.
- **`sys-admin` (documented fallback — TWO caps, experimentally proven).** For a hardened host
  with unprivileged userns **disabled**, add `--cap-add SYS_ADMIN` **and** `--cap-add SYS_CHROOT`.
  Both are required: on Ubuntu 26.04 (AppArmor, `kernel.apparmor_restrict_unprivileged_userns=1`)
  SYS_ADMIN alone gets the namespace layer up and then dies in the sandbox's chroot jail —
  `Check failed: sys_chroot("/proc/self/fdinfo/") == 0 … No such file or directory`, exit 133.
  With the pair, Chrome initialises its sandbox and renders (§7a). Broad, but the residual blast
  radius is bounded by `--network none` + `--read-only` + non-root + `--pids-limit` +
  `no-new-privileges`, and it is **still not `--no-sandbox`** — the renderer seccomp layer stays on.
- **`seccomp-profile`.** For a host whose default seccomp is stricter than stock Docker's, supply a
  curated profile via `--security-opt seccomp=<path>` (e.g. Docker's default plus the clone/unshare
  the namespace sandbox needs). No setuid `chrome-sandbox` binary is shipped — the namespace sandbox
  needs none.

**Which one this deployment uses is a host fact to confirm** (checklist C3): if
`sysctl kernel.unprivileged_userns_clone` is `1` (Debian) or `user.max_user_namespaces > 0`
(mainline), `userns` works with `--cap-drop ALL` and nothing else. If not, switch to `sys-admin`.
**The production EC2 host is the second case**: Ubuntu 26.04 ships AppArmor with
`kernel.apparmor_restrict_unprivileged_userns=1`, which denies the unprivileged userns path to
unconfined binaries — `userns` there fails with Chrome's `No usable sandbox!`. The operator
selects the mechanism with `EXPORT_CAPTURE_SANDBOX_MECHANISM` (strict allow-list:
`userns` | `sys-admin`; anything else refuses to configure — no silent downgrade, no arbitrary
docker arguments from environment).

---

## 6. Verified locally (macOS, in the unit suite)

These are the parts that do **not** need a Linux container, and they are the ones the task requires
be proven here. Run: `cd backend-api && npx vitest run src/services/export/capture/isolation`.

| # | Claim | Test |
|---|---|---|
| L1 | The loopback server serves the package files with the right content-types (`text/html`, `text/javascript`, json/css/wasm), honouring the manifest type over the extension. | `loopbackPackageServer.test.ts` |
| L2 | It **refuses path traversal** (`../`, encoded, NUL) and returns 404 for a miss — with no filesystem to reach, nothing leaks. | `loopbackPackageServer.test.ts` |
| L3 | It **binds `127.0.0.1`, never `0.0.0.0`**, and refuses to construct with a non-loopback host. | `loopbackPackageServer.test.ts` |
| L4 | The run-arg assembler produces the **exact hardened flag set** — `--network none`, `--read-only`, single tmpfs, non-root `--user`, `--cap-drop ALL`, `no-new-privileges`, cpu/memory(+swap off)/pids quotas, `--init`, `--stop-timeout` — and **never** `--no-sandbox`/`--privileged`, and passes **no env**. | `containerRunArgs.test.ts` |
| L5 | The three sandbox mechanisms emit the right grant and none emits `--no-sandbox`; assembler refuses a root user / empty inputs / non-positive quotas. | `containerRunArgs.test.ts` |
| L6 | The capture spec drops the external origin, preserves `?section=&v=` + `#simboot=` verbatim, seeds from `configHash`, and contains **no credential-shaped key**; the result parser rejects malformed shapes. | `captureJobBoundary.test.ts` |
| L7 | The container entrypoint serves the package on loopback, hands the driver a loopback entry URL that actually serves, writes a validated result, and closes the server even on driver failure. | `containerEntrypoint.test.ts` |
| L8 | The alignment bridge maps `ContainerCaptureSpec` + loopback URL → the sibling's `CaptureSpec` and relocates the backend's frames/clip onto `/output`. | `backendAdapter.test.ts` |

**Current status: 57 tests passing across 5 files; `tsc --noEmit` clean; `eslint` on the isolation
directory 0 errors.**

---

## 7. Container-verification checklist (Linux container only)

macOS cannot run this: `HeadlessExperimental.beginFrame` is unsupported on macOS (plan §4,
measured), and `--network none` / namespace semantics are Linux kernel behaviour. Each item is a
concrete command a human runs on a real Linux host with the built image, and its expected result.
**§7a (sandbox + runtime packaging) is now experimentally VERIFIED on the production host; the
remaining items stay `verified-in-container: PENDING`.** Build first:

```bash
docker build -f deploy/docker/export-worker.Dockerfile \
  --build-arg CHROME_HEADLESS_SHELL_VERSION=<a real CfT build ≥151> \
  -t podcast-saas/export-worker:verify ..
IMG=podcast-saas/export-worker:verify
```

### §7a — VERIFIED 2026-08-14: sandbox + runtime packaging on the production host

Host: **Ubuntu 26.04 EC2**, AppArmor enabled, `kernel.apparmor_restrict_unprivileged_userns=1`.
Three experiments, in order:

1. **`userns` path** (no cap grants): Chrome prints `No usable sandbox!` — expected on this host;
   the sysctl denies unprivileged user namespaces to unconfined binaries.
2. **`SYS_ADMIN` alone**: advances past namespace setup, then
   `Check failed: sys_chroot("/proc/self/fdinfo/") == 0 … No such file or directory`, exit 133.
   The namespace sandbox's chroot jail needs `sys_chroot` once the namespace layer is granted.
3. **The production-equivalent jail with BOTH caps** — rendered and exited 0:

```bash
docker run --rm \
  --network none --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=512m,mode=1777 \
  --user 1000:1000 \
  --cap-drop ALL --cap-add SYS_ADMIN --cap-add SYS_CHROOT \
  --security-opt no-new-privileges:true \
  --pids-limit 256 --memory 2048m --memory-swap 2048m --cpus 2 \
  --entrypoint /opt/chrome-headless-shell "$IMG" \
  --headless --disable-dev-shm-usage --dump-dom 'data:text/html,FLOWVID-SANDBOX-OK'
# → <html><head></head><body>FLOWVID-SANDBOX-OK</body></html>
# → CHROME_EXIT=0, FLOWVID_SANDBOX=PASS
```

This experiment is Stage A of `deploy/scripts/export-worker-smoke.sh <image> [mechanism]` — run
the WHOLE script after EVERY image build. Each false-pass taught it a stage:

- **Stage A — Chrome cage render.** `test -x`/`--version` are NOT sufficient: the v0.1.21 image
  passed both while its `COPY`-dereferenced standalone binary died at first launch with
  `Invalid file descriptor to ICU data received.` (exit 133) — Chrome resolves its runtime data
  (`icudtl.dat`, `.pak`, the v8 snapshot, `locales/`, `libEGL`/`libGLESv2`) relative to the
  executable. Only a real render proves packaging + sandbox together.
- **Stage B — backend module contract.** Stage A alone is ALSO not sufficient: the v0.1.22 image
  rendered perfectly while `EXPORT_CAPTURE_BACKEND_MODULE` named a module with no
  `createBackend()`/default export — every real capture container exited 1 before any capture
  code ran. Stage B dynamic-imports the module named by the image's OWN env (no duplicated path
  to drift) and requires a usable `SimCaptureBackend` that reports `available: true`.
- **Stage C — entrypoint capture.** The real `node …/isolation/main.js` against a deterministic,
  NON-static fixture sim (frame counter + hue sweep, minimal v2 bridge): loopback serving, bridge
  handshake, beginFrame pump, 60 frames on `/output`, `result.json` with `gate: passed` — and the
  first/last frames must DIFFER byte-wise, so a dead compositor or a static-capture regression
  cannot pass. Same cage, same caps, no relaxation.

(Fontconfig may log `No writable cache directories` unless HOME/XDG point below `/tmp`; the image
sets that, and the warning is non-fatal either way.)

### C1 — `--network none` blocks egress WHILE `127.0.0.1` still serves (the crux)

```bash
# (a) Egress to a canary is refused. `--add-host` proves DNS is irrelevant — even a known IP fails.
docker run --rm --network none "$IMG" \
  node -e 'fetch("http://169.254.169.254/latest/meta-data/",{signal:AbortSignal.timeout(3000)})
           .then(()=>{console.log("REACHED-IMDS");process.exit(1)})
           .catch(e=>{console.log("blocked:",e.code||e.name);process.exit(0)})'
# Expect: "blocked: …", exit 0.  A "REACHED-IMDS" is a FAIL.

# (b) In the SAME netns, loopback serves. Start a loopback HTTP server and curl it from 127.0.0.1.
docker run --rm --network none "$IMG" node -e '
  const http=require("http");
  const s=http.createServer((_,r)=>{r.end("ok")}).listen(0,"127.0.0.1",()=>{
    const p=s.address().port;
    http.get({host:"127.0.0.1",port:p},res=>{let b="";res.on("data",d=>b+=d);
      res.on("end",()=>{console.log("loopback:",b);process.exit(b==="ok"?0:1)})});
  });'
# Expect: "loopback: ok", exit 0.
```
Also run the real path: mount a package + spec at `/input`, an empty dir at `/output`, and confirm a
sim that *tries* `fetch(backendUrl)` / `fetch(postgresHost)` / IMDS gets nothing, while the frames
still render from `127.0.0.1`.

### C2 — read-only rootfs; the only writable surface is the tmpfs

```bash
docker run --rm --read-only --tmpfs /tmp:rw,nosuid,nodev,noexec,size=64m "$IMG" \
  sh -c 'touch /root/x 2>&1; touch /app/x 2>&1; touch /tmp/ok && echo TMP-OK'
# Expect: "Read-only file system" for /root/x and /app/x; then "TMP-OK".
```

### C3 — non-root, and Chrome's sandbox initialises WITHOUT `--no-sandbox`

```bash
docker run --rm "$IMG" id -u          # Expect: 10001 (never 0)
# Host userns check (pick your distro's key):
sysctl kernel.unprivileged_userns_clone 2>/dev/null || sysctl user.max_user_namespaces
# Expect: 1 (Debian) or a value > 0. If 0/absent, use sandboxMechanism='sys-admin'.
# Sandbox smoke test (no --no-sandbox): launch headless-shell and confirm it starts + a renderer runs.
docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges:true \
  --tmpfs /tmp:rw,nosuid,nodev,size=256m "$IMG" \
  /opt/chrome-headless-shell --headless --disable-dev-shm-usage --dump-dom about:blank
# Expect: it prints <html>…</html> and exits 0. A "Failed to move to new namespace" / sandbox error
# means unprivileged userns is off on this host — switch to the sys-admin fallback (§5), NOT --no-sandbox.
```

### C4 — quotas enforced

```bash
# PID cap: a fork storm hits the ceiling instead of the host.
docker run --rm --pids-limit 64 "$IMG" \
  sh -c 'for i in $(seq 1 200); do sleep 30 & done; wait' 2>&1 | grep -qi "resource temporarily unavailable" \
  && echo PIDS-CAPPED
# Expect: PIDS-CAPPED.
# Memory cap: the container is OOM-killed rather than the host. (Watch `docker events` / exit 137.)
docker run --rm --memory 256m --memory-swap 256m "$IMG" \
  node -e 'const a=[];while(true)a.push(Buffer.alloc(10*1024*1024))' ; echo "exit=$?"
# Expect: killed (exit 137), host unaffected.
```

### C5 — the adversarial sim gets nothing

Materialise a package whose entry JS attempts, in one run: IMDS, the backend origin, the Postgres
host:port, and reading env for a secret. Run it through the real entrypoint with the full hardened
flag set (use the run-arg assembler / the compose file). **Expect:** every fetch rejects, `process.env`
holds no credential, frames still render from loopback, and `result.json` reports `status:"ok"` with
a real `gate` verdict. Capture the transcript and attach it to this section as the record that flips
C1–C5 from PENDING to VERIFIED (with the image digest and Chrome version tested).

### C6 — determinism (belt-and-braces, from the plan's Phase-2 test)

Capture the same canary section **twice** and diff the per-frame hashes — byte-identical proves the
seeded PRNG + virtual clock hold under the container. A deliberately misconfigured run
(`--use-angle=gl`, no display) must trip the black-frame gate and fail loudly (the M144 negative
test). These live with the sibling's backend but are run in this container.

---

## 8. Deploy story — where this runs

**Production shape.** The trusted `ProjectExportService` (the existing **worker tier** in
`deploy/docker-compose.yml`) orchestrates the export. For each scripted-sim section it:

1. downloads the immutable package (presigned GET) and writes it + `capture-spec.json` to a
   **per-section input dir** (`writeCaptureInput`), and creates an empty **per-section output dir**;
2. spawns **one hardened `export-worker` container** via `DockerCaptureBoundary` → `docker run` with
   the flags from `containerRunArgs` (this is *docker-out-of-docker*: the worker tier is given access
   to a Docker socket — scoped, see below);
3. on exit, reads `result.json` + frames from the output dir and does the presigned PUT, then
   `cleanupCaptureIo` removes both dirs.

Put both per-section dirs on a **tmpfs/ramdisk** host mount so no captured bytes touch disk, and so
`--tmpfs`-style ephemerality extends to the handoff.

**Two viable placements** (choose per your Docker-socket posture):

- **Sibling worker + DooD (recommended first).** Keep the existing `worker` service; give it access
  to a Docker socket restricted to *running the pinned export-worker image with these flags* (a
  socket proxy such as tecnativa/docker-socket-proxy, or a rootless/`sysbox` runtime). The
  export-worker containers are short-lived children. Least new infrastructure.
- **Dedicated capture sidecar / node pool.** Run the export-worker on an isolated node (its own
  security group, no IAM instance profile, no route to internal subnets) so even a hypothetical
  sandbox escape lands nowhere. Strongest, more ops.

**Do not** run capture inside the web/API container, and do not co-locate it with anything holding
DB credentials beyond the thin orchestrator that mints presigned URLs.

**Image pinning.** Build with a real Chrome-for-Testing build ≥151 (`@puppeteer/browsers` verifies
the download hash). The resulting **image digest** and the **headless-shell version** are recorded in
every capture's `RendererIdentity`, so "why do these two exports differ?" stays answerable. Never run
`:latest` in production.

**Config knobs** (`DockerCaptureBoundaryConfig`): `image` (digest), `user`, `cpus`, `memoryMb`,
`pidsLimit`, `tmpfsScratchMb`, `stopTimeoutSec`, `sandboxMechanism` (+ `seccompProfilePath`),
`dockerBin`. The per-section `wallClockTimeoutSec` lives in the capture spec.

---

## 8. The trusted-side caller and the single-VM deployment shape

The caller this document kept referring to ("the caller owns download, `writeCaptureInput`,
reading the frames…") now exists: `capture/isolation/containerCaptureProvider.ts`. It implements
the in-process `SimCaptureBackend` seam that `ProjectExportService` accepts, and per section it:
parses the window's served URL back into storage keys, downloads the package via the storage
adapter (`listObjects` + `readObject`), stages the input mount, runs `DockerCaptureBoundary`,
and turns the result into a clip (copying the container's clip out, or encoding its frame
directory with ffmpeg). It is **null unless `EXPORT_CAPTURE_IMAGE` is set** — the unset state is
byte-identical to the Phase-1 poster-fallback behaviour.

Deployment shape (single VM, `deploy/docker-compose.capture.yml` overlay):

- `project_export` is routed through pg-boss (`PGBOSS_JOB_NAMES`), so the export job — ffmpeg
  assembly AND docker spawning — runs in the **worker service**, never the web tier. (The
  2026-08-13 incident was the kernel OOM-killing the API container mid-assembly.)
- The backend image carries a **pinned static docker CLI**; it is inert until the overlay grants
  the worker the socket and `.env` names the image.
- `EXPORT_CAPTURE_WORKDIR` is bind-mounted at the SAME path on host and worker, because the
  daemon resolves the capture container's `-v` flags against the HOST filesystem.
- `EXPORT_CAPTURE_SANDBOX_MECHANISM` selects the sandbox grant (strict allow-list: `userns` |
  `sys-admin`; unknown values refuse to configure). The overlay defaults it to `sys-admin` —
  the production host's AppArmor blocks the userns path (§5, §7a).
- **Socket tradeoff, stated plainly (see §9 gap 3):** the overlay hands the worker the raw
  docker socket, which is root-equivalent on the host. On a single VM running first-party worker
  code this is an explicit, opt-in compromise; the untrusted sim still never sees the socket —
  it runs inside the hardened capture container. On anything bigger than one VM, prefer the §9
  recommendation: a scoped socket proxy or a dedicated capture node.
- Enabling it on a host is the overlay header's one-time setup, and **§7 must be run on that
  host first** — the checklist is still the gate between "wired" and "trusted".

---

## 9. Honest status

| Area | Status |
|---|---|
| Loopback server: serves, refuses traversal, binds 127.0.0.1 | **Verified locally** (§6, L1–L3) |
| Run-arg assembler: exact hardened flag set, no `--no-sandbox`, no env | **Verified locally** (§6, L4–L5) |
| Boundary: no-credential spec, query/fragment preserved, result validation | **Verified locally** (§6, L6) |
| Entrypoint + alignment bridge | **Verified locally** (§6, L7–L8) |
| Trusted-side caller (`containerCaptureProvider`): staging, verdict pass-through, env gate | **Verified locally** (unit suite, fake boundary) |
| Runtime packaging: binary stays inside its CfT distribution (icudtl.dat & siblings) | **VERIFIED on Ubuntu 26.04** (§7a; v0.1.21 standalone-binary failure reproduced + fixed) |
| Chrome sandbox initialises in the full jail (sys-admin = SYS_ADMIN + SYS_CHROOT) | **VERIFIED on Ubuntu 26.04** (§7a; render smoke `FLOWVID_SANDBOX=PASS`, exit 0) |
| Backend plugin contract (`createBackend` ↔ `loadBackend`, instance validated) | **Unit-pinned** (contract test through the REAL loader; the v0.1.22 mismatch reproduces red on the old tree) |
| beginFrame transport (CDP pipe) + real `captureSection` composition | **Verified over a scripted transport** (unit suite); REAL-Chrome execution = smoke Stage C, **PENDING on the host** |
| Non-zero-exit diagnostics (failed result.json surfaced, bounded sanitized stderr) | **Unit-pinned** (stub docker binary; exit-1-with-ok-result is a refused contradiction) |
| userns mechanism on the production host | **BLOCKED by host AppArmor** (`apparmor_restrict_unprivileged_userns=1`) — use `sys-admin` there |
| `--network none` blocks egress while loopback serves | **PENDING** (§7, C1) — cannot run on macOS |
| Read-only rootfs, non-root, quotas (beyond what §7a's jail exercised) | **PENDING** (§7, C2–C4) |
| Adversarial sim reaches nothing; determinism | **PENDING** (§7, C5–C6) |
| Chrome-headless-shell version / image digest | **Not pinned in this change** — set a real CfT build at build time |

**Gaps called out plainly.** (1) §7a (packaging + sandbox) is the only container-level item
executed so far — the REST of §7 remains PENDING and must be run on the Linux host before
trusting real exports. (2) The exact
`chrome-headless-shell` build is an un-pinned build ARG; the Dockerfile refuses to build without it,
but a real published version + verified digest must be chosen. (3) The Docker-socket exposure for
docker-out-of-docket is a real attack surface of its own — use a scoped socket proxy or a dedicated
node; do not hand the worker an unrestricted Docker socket. (4) The browser driver, injection, and
the paint/WebGL sanity gate are the sibling's territory (`capture/driver.ts`, `injection.ts`,
`sanityGate.ts`, `captureTypes.ts`); this document covers only the container and the trusted
orchestration around it.
