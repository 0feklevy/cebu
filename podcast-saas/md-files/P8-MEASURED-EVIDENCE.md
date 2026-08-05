# Priority 8 — measured evidence

Every number here came from a real browser or a real stored package. Nothing is extrapolated from a
unit benchmark or a synthetic object, because a benchmark measures the benchmark.

Machine: macOS arm64, local dev stack (client-web + backend-api + Supabase storage). Absolute values
are machine-specific; the COMPARISONS are the evidence.

## 1. Package weight — a real published package

`simulations/d8e7557a…/49d20194…` (boids-3d), measured by `sim-weight-report.ts`, read-only:

| Category | Bytes | Files |
|---|---|---|
| entry | 17.2 KB | 1 |
| runtime | 23.3 KB | 1 |
| script | 177.6 KB | 16 |
| style | 10.1 KB | 2 |
| media | 85.7 KB | 1 |
| other | 257.8 KB | 6 |
| **total** | **571.7 KB** | **27** |

Largest single assets: `models/Parrot.glb` 94.8 KB, `models/hand.glb` 92.3 KB,
`audio/ding.mp3` 85.7 KB, `models/gull.glb` 62.7 KB.

### Before / after — a measured optimisation

`--optimize` downloads the package, applies gzip locally to the 22 text-shaped assets, and
re-measures. **Nothing is uploaded and no stored object is touched**: the point is to prove a saving
is real before anyone commits to it.

| | Before | After | Delta |
|---|---|---|---|
| entry | 17.2 KB | 6.3 KB | −10.9 KB |
| runtime | 23.3 KB | 5.7 KB | −17.6 KB |
| script | 177.6 KB | 59.2 KB | −118.4 KB |
| style | 10.1 KB | 3.5 KB | −6.5 KB |
| media | 85.7 KB | 85.7 KB | no change |
| other | 257.8 KB | 254.3 KB | −3.5 KB |
| **total** | **571.7 KB** | **414.8 KB** | **−156.9 KB (−27.4%)** |

Media correctly shows **no change** — it is already compressed, and a tool that claimed a saving
there would be reporting a number that evaporates in production.

gzip was chosen because it is lossless and is exactly what a CDN applies, so the saving needs no
change to what the package does. Findings that require judgement — dropping an unused model,
re-encoding audio — are reported for a human and never applied automatically to a customer's files.

## 2. Runtime cost — measured in a real browser

`e2e/sim-perf.spec.ts` against the seeded fixture, via CDP `Performance.getMetrics`.
`performance.memory` was tried first and discarded: Chrome quantises and caches it, and it reported
an identical figure at every point in a run where the resident document count went 0 → 1 → 2. It
cannot discriminate the thing being measured.

| Point | JS heap | Resident sim documents |
|---|---|---|
| cold, before any sim | 23.7 MB | 0 |
| after one sim | 25.3 MB | 1 |
| after a second package | 27.7 MB | 2 |
| single mode, one package | ~25.4 MB | 1 |

**Heap tracks document count** — roughly 1.6 MB and 2.4 MB for the two WebGL documents. This is the
cost the residency cap exists to bound, and the number that makes the `single` kill switch
meaningful rather than theoretical.

### Transition latency

Measured by the runtime itself and read from the telemetry the RUM path also uses:

| Case | p50 |
|---|---|
| warm re-entry (document resident and painted) | **0.3 ms** |
| different package, resident under the pool | **0.3 ms** |
| single mode (document not resident) | **0.5 ms** |

These are *reveal-decision* times for an already-prepared document, which is precisely the pool's
value: the work happened ahead of the boundary. They are **not** cold-start numbers, and this suite
does not yet reliably capture a cold transition — the seek lands before the pool has mounted. That
gap is stated rather than papered over, and it is the number field RUM is designed to supply.

## 3. What these numbers do NOT show

- **No GPU measurement.** Neither CDP nor the page exposes per-document GPU memory or utilisation in
  a way that can be attributed to one iframe. Resident-document count is the honest proxy, and it is
  what is reported above.
- **No CPU attribution per simulation.** CDP `TaskDuration` moved by ~1 ms across these runs, which
  is below the noise floor of a machine also running a dev server and three browsers. Reporting it
  as a per-sim CPU cost would be inventing precision.
- **No physical device.** Everything above is desktop Chromium on macOS arm64. See the rollout plan.
