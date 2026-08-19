# Open decisions

**Clean slate — the 2026-08 remediation round is closed and archived.** PRs #31–#37 merged;
v0.1.30 tagged and built. The full record of that round, including every ruling and correction,
is in `DECISIONS-ARCHIVE.md` (bottom section, dated 2026-08-19).

Last updated: **2026-08-19**, at round close.

---

## 🔴 Blocked on you (two items, both small)

1. **The production deploy fails on the VM, not in this repo.** The approved v0.1.28 deploy
   failed 32 seconds in at *"Pin VM checkout"* — the working tree at `/home/ubuntu/cebu` holds
   uncommitted changes, so the pin refuses. Containers were never touched; production still runs
   the older version, and **every fix since PR #32 is merged, tagged, built — and not live.**
   Do NOT clean the VM with `git reset --hard`: first a read-only census of
   `git status --porcelain=v2` there, review what those files are, then preserve/commit/move
   aside, then re-dispatch the release workflow with `deploy=true`. Needs SSH, which no session
   here has.
2. **One-time Supabase dashboard action:** bucket lifecycle rule *"abort incomplete multipart
   uploads after 7 days."* Abandoned upload parts are billed but invisible to LIST, and no code
   path can reach them. Documented in `.env.example`.

## 🟠 Standing constraints (do not change without a ruling)

- `AVATAR_CAPABILITY_MODE` / `AVATAR_BUDGET_MODE` stay `shadow` — the five-step enforce ordering
  is in `.env.example` and the archive. Flipping capability enforce early 401s every viewer.
- Budget-shadow traffic is **not** valid calibration data until the async observer is rebuilt.
- `QUEUE_CROP_CONCURRENCY` stays 1 until measured on the 2-vCPU host (now also the code default).

## 🟡 The next work, when picked up

- **Production storage census** — run `deploy/scripts/storage-census.sql` (read-only, aggregates
  only, no PII) and bring the output. It unblocks: `branch_path_events` retention (needs a rollup
  design, not a bare TTL), failed-duplication reaping, `token_usage` rollup, TOAST-column review.
- **D-13 viewer config freshness** — ruled, specified in the archive, not yet built.
- **D-14 avatar spend enforcement** — atomic Postgres function + async observer + client
  capability wiring, in that order.
- **D-16 crop hardening** — discontinuity markers, detector fallbacks, confidence gate before
  auto-publish is trusted.
- **D-17 knowledge/retrieval** — KnowledgeSnapshot first; three feature gates before any public
  Avatar rollout (multi-segment scoping, `chart` off without provenance, moderation wired on the
  visual/image routes).
- **Billing scope** — 24 findings parked as `OUT_OF_SCOPE_BILLING` in the ledger, including two
  P1s. Parked is not fixed.
- **A P1 with no implementation:** `broll-data-001` (b-roll offsets anchored to
  `video_files.duration_sec`) — decided, no schema or code yet.

## ⚪ Known and accepted

- Public-bucket HLS: revoked shares keep working until the signed-URL cutover (four ordered
  landings; a naive cutover is an outage).
- Sim-capture export ~10× too slow on the 2-vCPU host; obvious levers spent.
- The e2e WebKit lane is non-blocking by design (`__CHILD` keyed on Window identity); its one
  failing test is documented in `ci.yml`.
- 235 ledger findings remain open and unverified (P2/P3-labelled, tail never adversarially read).
