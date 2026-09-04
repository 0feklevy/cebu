---
name: project-heavy-3d-package
description: The molecular-motor three.js package (~35MB, 29.7MB GLB) is being made a first-class sim, during the staged R2 storage cutover — the two together are the live risk window
metadata:
  type: project
---

FlowVid is onboarding a heavy external 3D package as a first-class simulation: a Vite dist build of
a three.js molecular-motor sim — ~35 MB uncompressed / 30 MB zipped, 6 minified JS chunks (715 KB,
three.js bundled in, **no CDN import map**), three `.glb` models (29.7 MB kinesin with 183
morph-target channels, 5.5 MB dynein, 0.57 MB microtubule), and an *unminified* `sim.js` adapter
exposing `window.MolecularMotorSim`. Measured cold load of the kinesin model: ~6 s at 40 Mbps.

This lands during the **staged R2 storage cutover** (owner ruling 2026-09-03; see
`getStorageAdapter.ts` `migrating` mode). Production was still Supabase as of 2026-09-04.

**Why:** the two facts interact. Almost every simulation capability that is applied *at serve time*
lives in the `/sim-public/*` proxy, and the Supabase and Local adapters route sims through it while
the R2 adapter historically did not. A heavy package is also the first one big enough to exceed the
subsystem's hard-coded time bounds. Reviewing either in isolation misses the interaction.

**How to apply:** when reviewing anything in the sim subsystem during this window, always ask two
questions — (1) does this behave differently once `STORAGE_BACKEND` names r2 as primary? and (2)
does this constant still hold at 35 MB / 6 s? Re-verify the storage-adapter answer before citing it:
it is a one-line change and may already be fixed. See [[sim-review-owner-ground-truth]].
