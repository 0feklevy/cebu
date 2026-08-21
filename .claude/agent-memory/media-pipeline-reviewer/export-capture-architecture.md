---
name: export-capture-architecture
description: Where the export/capture pipeline's structural weak points are - per-section container capture, the canvas-only sanity gate, and the two-sided storage lifecycle
metadata:
  type: project
---

Structural facts about the linear-video-export path that took a full read of ~10 files to establish,
verified at commit 2d187e3 (review run `2026-08-15T2109`).

**The capture unit is one section = one `docker run`.** `ContainerCaptureProvider.captureSection`
stages the whole sim package from object storage, runs a container, and tears it down, once per
scripted section; `ProjectExportService` drives them sequentially. Every fixed cost (package list +
download, container create, Chrome cold start, loopback server, navigation, handshake) is paid N
times for N sections of the SAME package. That is the structural half of the "capture is ~10x too
slow against the 600 s cap" blocker — the per-frame loop is the other half.

**Why:** the boundary was designed as a pure function of (input mount, spec) for security reasons
(`captureJobBoundary.ts` — the container never holds a credential), and batching was never added on
top.

**How to apply:** any throughput proposal must preserve "no credential in the container". Batching
several sections into one container run is compatible with that; sharing a staged input mount across
sections of one package is too.

**The sanity gate is canvas-only and hard-fails.** `sanityGate.ts` samples `<canvas>` pixels; a page
with no canvas yields zero samples, which reads as "failed", so DOM/SVG simulations can never pass
however correctly they captured.

**The storage lifecycle is asymmetric.** HLS has real retention (`hls_retired_runs` +
`sweepRetiredHlsRuns` + a grace window). The export path has none: per-section capture clips under
`exports/{project}/{export}/sections/` and the container provider's `clip-*` temp dirs are both
write-and-forget.

**How to apply:** when someone adds a new intermediate artefact to the export path, ask which sweep
deletes it. Today the answer is "none".

Related: [[media-review-method]]
