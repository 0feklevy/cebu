# Open decisions

**Nothing here is waiting on a ruling.** D-13, D-14, D-16 and D-17 were all ruled by the external
reviewer on 2026-08-19 and have moved to `DECISIONS-ARCHIVE.md` with their reasoning and the
corrections intact. What remains below is **execution state** — work that is specified, partly
built, and blocked only on being finished or on you flipping a switch.

Last updated: **2026-08-19, end of the overnight run** · all work merged, nothing left on a branch.
Shipped: **PR #31, #32, #33 and #34 merged · v0.1.29 tagged, built and drafted.**

**Out of scope this session:** payments, paywalls, locked videos, paid playlists, Stripe,
entitlements — by your instruction. 24 findings carry `OUT_OF_SCOPE_BILLING` in the ledger rather
than being deleted, so nothing is lost if it is picked up later.

---

## 🔴 Production is NOT running this code — the deploy fails on the VM

Correcting what this file said before: the v0.1.28 deploy was **not** waiting for your approval.
You approved it, it ran, and it **failed 32 seconds in** — at the step *"Pin VM checkout to the
release commit"*, after which *"Fail fast if the VM checkout could not be pinned"* aborted the run
(GitHub Actions run `32149868485`).

**Nothing is broken in production.** That step is git-only by design, so the containers were left
untouched and the site is still serving the previously deployed version. But it does mean:

- every code fix from PRs #32 and #34 is **merged, tagged and built — and not live**;
- `v0.1.28` and `v0.1.29` both exist as **draft releases with images already on GHCR**;
- the blocker is on the **VM**, not in this repository, and diagnosing it needs SSH — which is
  out of bounds for this session, so it is yours.

`v0.1.29` was deliberately cut with **`deploy=false`**: plan → verify → images → tag → draft, and
stop. It needed no approval and carried no production risk. When the VM is fixed, re-dispatch the
release workflow with `deploy=true`, or deploy the existing `v0.1.29` images directly.

---

## 🔴 The one thing that needs you: do not flip either avatar `enforce` switch

`AVATAR_CAPABILITY_MODE` and `AVATAR_BUDGET_MODE` both default to `shadow`, and both must stay
there. The reviewer's D-14 ruling is explicit, and the order is not negotiable:

1. schema + an **atomic Postgres function** (not the multi-row upsert I first proposed) with real
   concurrency tests;
2. the asynchronous shadow observer + metrics, over **several days of representative traffic**;
3. the capability wired into every client surface — direct, share, permalink, playlist, course —
   including refresh and reconnect;
4. a real end-to-end run with `AVATAR_CAPABILITY_MODE=enforce` while the budget is still shadow;
5. only after the caps have been calibrated and reviewed: `AVATAR_BUDGET_MODE=enforce`.

**Flipping capability enforce before step 3 gives every viewer a 401 on every avatar open.**

---

## 🟡 PARTIAL — specified and ruled, not yet built

| | what is left |
|---|---|
| **D-13** viewer config freshness | Conditional GET on the existing config routes, 60s ± jitter. Authorization must run **before** any `304`; the cache must be keyed by full audience variant, never by `projectId` alone; the client applies an **atomic overlay bundle** (b-roll, clip overlays, image overlays, audio cutaways) rather than replacing the session config; config revalidation must **not** count as a view (today share/permalink/playlist bump `view_count` on every GET, which would turn one viewer into ~60). Stays PARTIAL until the playlist and course surfaces are covered or explicitly excluded. |
| **D-14** avatar spend control | Async shadow via a **bounded queue with 1–2 workers** (not `void promise` per request); enforce as a single transactional Postgres function with canonical lock ordering and true all-or-nothing rollback; leases stay the source of truth (a maintained counter never decrements, because `/avatar/end` is unreliable); the capability keeps its own endpoint, **prefetched at page load**, and stays out of the config JSON so it cannot poison the D-13 ETag. |
| **D-16** vertical crop | The client half is fixed (`7c342ce`): frame-rate-independent smoothing, cuts adopted rather than eased across, segments starting on their first keyframe, and the 4:3 → padded-frame coordinate transform the ruling specified. Still open: explicit shot boundaries in the crop JSON, causal-only motion (the offline Gaussian is zero-phase and starts moving *before* the new speaker), replacing the RGB skin heuristic with a face/person detector tested on diverse skin tones, and a confidence gate + preview + opt-out before an unreliable crop auto-publishes. `QUEUE_CROP_CONCURRENCY=1` until measured on the 2-vCPU host — this is now the code default (it said 2, and nothing in deploy config overrode it, so the requirement had never actually been in force). |
| **D-17** Avatar Ask quality | Split in two. **17a (correctness):** one canonical versioned `KnowledgeSnapshot` per project feeding all four consumers, with branching represented as paths rather than a false concatenation — until then, Ask Avatar on a multi-segment or branching project should be marked unsupported or scoped to the current segment. **17b (retrieval):** one visual decision per conversational turn, relevance before popularity, and `character_id` actually filtered. Two items close **before** any public rollout: remove `chart` from the classifier until numbers carry provenance, and route viewer-generated visuals through moderation (the service was fixed in `9d06762`; the avatar paths still do not call it). |

---

## ⚪ Known and accepted, for the record

- **`security-001`** — production HLS is served from a public bucket, so per-object authorization
  never runs and a URL already handed out keeps working after a share is revoked. Confirmed,
  deliberately deferred: the correct fix is four ordered landings including a capacity decision,
  and a signed-URL cutover whose segments expire mid-playback is a new outage. **This also means
  D-13 is editorial freshness, not a takedown mechanism** — do not treat the poll as revocation.
- **Sim-capture export throughput** is ~10× too slow on the 2-vCPU host. Measured, unfixed, and
  the obvious levers are already spent.
- **3 audit blockers remain open** (`fleet-014/015/019`) — all hook-level or environmental limits
  that no fleet agent is permitted to fix. Documented rather than hidden.
- **The backend coverage percentage covers only `src/services`** — auth, routes and the queue are
  invisible to it.

---

## How to read the ledger

334 findings tracked in `.audit-ledger/ledger.jsonl`. The previous summary here said *"No product
P1 remains open"* and used the severity drift as if it bounded the unread tail. **Both were wrong**,
and the external reviewer was right to call it. This is the state of the file, not a release
promise:

| P1 disposition | count | what it actually means |
|---|---:|---|
| `FIXED_SELF_VERIFIED` | 32 | fixed and checked **by the implementer only** |
| `OPEN_AUDIT_BLOCKER` | 3 | hook/environment limits no fleet agent may fix |
| `OUT_OF_SCOPE_BILLING` | 2 | excluded by your instruction — **not** resolved |
| `BLOCKED_DECIDED_NOT_IMPLEMENTED` | 1 | `broll-data-001`; its own residual says there is no schema or code |
| `REFUTED` / `LIKELY_REFUTED` | 2 | the fleet caught itself |

So a P1 *is* outstanding (`broll-data-001`), two more are parked rather than fixed, and **all 5 P0s
and 34 of the 40 P1s were never adversarially re-verified** — only self-verified by whoever wrote
the fix. That gap is exactly what let `a63aa4e` and `anam-backend-003` be recorded as fixed when
they were not.

**On the severity drift.** 23 severities moved down and none moved up. That is real evidence that
reporters overstate — but the checked group was P0/P1 only, so it is **not a random sample** and
bounds nothing about the 235 open P2/P3 findings that no verifier ever read. The honest sentence
about the tail is: *235 findings are open and unverified.*
