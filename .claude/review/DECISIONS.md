# Open decisions

**Nothing here is waiting on a ruling.** D-13, D-14, D-16 and D-17 were all ruled by the external
reviewer on 2026-08-19 and have moved to `DECISIONS-ARCHIVE.md` with their reasoning and the
corrections intact. What remains below is **execution state** — work that is specified, partly
built, and blocked only on being finished or on you flipping a switch.

Last updated: **2026-08-19, overnight run** · branch `fix/night-audit-2026-08-15`
Shipped: **PR #31, #32 and #33 merged · v0.1.28 tagged and built** — the production deploy is still
waiting on your environment approval.

**Out of scope this session:** payments, paywalls, locked videos, paid playlists, Stripe,
entitlements — by your instruction. 24 findings carry `OUT_OF_SCOPE_BILLING` in the ledger rather
than being deleted, so nothing is lost if it is picked up later.

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
| **D-16** vertical crop | The client half is fixed (`7c342ce`): frame-rate-independent smoothing, cuts adopted rather than eased across, segments starting on their first keyframe, and the 4:3 → padded-frame coordinate transform the ruling specified. Still open: explicit shot boundaries in the crop JSON, causal-only motion (the offline Gaussian is zero-phase and starts moving *before* the new speaker), replacing the RGB skin heuristic with a face/person detector tested on diverse skin tones, and a confidence gate + preview + opt-out before an unreliable crop auto-publishes. `QUEUE_CROP_CONCURRENCY=1` until measured on the 2-vCPU host. |
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

334 findings tracked in `.audit-ledger/ledger.jsonl`. **No product P1 remains open.** Everything
still open is P2 or P3, on a population where adversarial checking has moved **26 severities down
and zero up** — so a P2 in that tail is most likely a P3, and the tail is not hiding a P0.

Rows marked `FIXED_SELF_VERIFIED` mean code-verified by the implementer and **not** adversarially
re-verified. That distinction is load-bearing: it is exactly the gap that let `a63aa4e` and
`anam-backend-003` both be recorded as fixed when they were not.
