---
name: flowvid-novelty-map
description: Where FlowVid's genuinely non-obvious engineering sits as of the 2026-08-19 sweep — the survivors, the demotion, the reaffirmed kills, and the through-line stance
metadata:
  type: project
---

Conclusions of the full-system sweep of 2026-08-19 (`origin/main` @ `ca0f00b`). Dossier:
`/Users/ofeklevy/Desktop/flowvid-patent-dossier-2026-08-19.md`; machine record:
`.claude/review/patents/2026-08-19-novelty-dossier.jsonl`.

**The through-line worth leading with:** *absence of evidence is never allowed to become evidence, in
either direction.* Independently derived in ~8 places, including the direction that proves it is a
real rule — a timeline anchor whose host video is still transcoding produces **no violation**, because
refusing the author's edit would be the same mistake pointing the other way. It is a stance, not a
mechanism, so it is not a survivor; it is the best framing for the survivors.

**Survivors, ranked:** (1) **strong** — the renderer choice is frozen onto the export plan, hashed, and
the sandbox's GPU grant is derived from that frozen record rather than the worker's environment, then
audited afterwards from an isolated world the untrusted page cannot reach. (2) **moderate** — offline
dependency closure: external references graded by what their absence costs the *pixels* (boot/visual/
cosmetic), satisfied from pinned hash-verified vendored packs into a disposable copy, stored bytes
never mutated. (3) **moderate** — the viewer reveal gate (carried from 2026-08-16, re-verified
byte-identical). (4) **moderate** — attestation inheritance across a derived revision: never manufacture
a confident `false`. (5)–(6) **weak** — consent bound to a plan fingerprint; the interface extracted
from generated code so the package beneath can be swapped.

**Demoted:** the 2026-08-16 "certification mints a permission and its own fallback image" entry. Its
central claim — four artefacts keyed on one identity — is **refuted**: only the poster is config-keyed,
the verdict is package-scoped, the budget is a worst case, and the capability comes from a different
producer at a different moment.

**Reaffirmed kills worth not re-litigating:** deterministic virtual-clock export (industry standard,
and the reproducibility guarantee is still not established by the code); the four-valued audit model
(monitoring UNKNOWN and unit-test error-vs-failure are decades old); anchored timeline coordinates
(standard in editors and audio workstations); `verify-committed-tree.sh` (CI on a clean checkout,
and staged-state pre-commit tooling).

**Why this matters:** the productive hunting grounds are `services/export/capture/**`,
`services/simulation/Revision*`, `shared/src/sim/**` and `client-web/lib/sim/**`. Storage, billing,
usage, queue, course and avatar were surveyed and are ordinary. The single highest-yield search in
this repo is a scan for explanatory comment blocks of 6+ lines — they reliably mark a defect that
shipped, and they were the source of nearly every survivor.

Related: [[stale-worktree-trap]], [[dossier-conventions]]
