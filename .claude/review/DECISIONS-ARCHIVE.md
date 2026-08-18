# Answered decisions — archive

Rulings already made, kept for reference. **Open items live in `DECISIONS.md`.**

---

## D-01 🟢 B-roll anchoring — ripple, anchored to a main segment

Anchor to a stable **main video segment id + local offset** via an explicit nullable
`anchor_video_file_id` + `anchor_offset_sec` pair — *not* a `timeline_sections.section_id` (those are
sparse annotations and do not cover every point), and not by overloading the existing source id. One
shared resolver derives absolute time for editor, viewer, prewarm/markers and export. Half-open
segment boundaries; define a legal last-segment post-roll tail; same abstraction for audio cutaways.
Follow-up recorded for absolute markers and manual avatar ranges — same drift class.

- **b — duration change, replace and delete are three different things.** A probe/re-transcode
  correction rewrites nothing; derived time ripples from the anchor. A media *replace* keeps the host
  id and local offset but stages and probes first — anything now out of range goes to an
  impact-review list, never silently clamped or re-attached. Deleting an anchored host is `RESTRICT`
  (or a transactional preflight) and requires an explicit user choice; never auto-re-anchor to "the
  next" content. **The generated-b-roll job must store the host anchor at enqueue time** — today it
  stores only an absolute target and can finish long after the timeline moved.
- **c — overlap allowed, winner-takes-all.** Explicit `z_index` plus an immutable monotonic
  `stack_seq` insertion tiebreak. Rule: layer class (sim/poster > image > clip/b-roll > base), then
  `z_index`, then `stack_seq`. **Not** last-written — an unrelated PATCH must not restack. The editor
  must show which clip is on top.
- **d — live, but versioned and boundary-safe.** New config applies to *future* boundaries; the
  currently playing clip is pinned until its boundary so a correction cannot swap mid-shot. Security
  takedown may override immediately. Schedule and prewarm reconcile from one atomic config
  revision/ETag. Structural main-timeline changes stay session-snapshotted.
- **e — visual b-roll is silent.** The viewer already hard-mutes both b-roll elements and export
  strips their audio; align the editor to that. `broll_volume` defaults to `1.0` and is *not*
  evidence of intent. Gain is reserved for audio cutaways. Natural sound later needs an explicit
  `audio_mode = muted | mix | duck_main` (default muted); never read legacy `broll_volume=1` as
  opt-in.
- **f — cap to the authoritative source, warn before commit.** No looping, no silent freeze. Apply
  the cap defensively in viewer and export too. Freeze may later be an explicit `fill_mode`. Do not
  invent a 30-second duration while metadata is unknown.

**Rollout:** expand/contract — nullable anchor pair + placement mode (`segment` | `legacy_absolute`),
dual read (anchor first, absolute fallback), then new-writes-anchored. **No silent backfill**:
mapping today's absolute second onto today's segment can canonize an already-wrong placement.
Dry-run report; convert on explicit review or drag ("keep current visible location"). Exclude
unknown-duration, out-of-range and branched rows from any automated candidate.

---

## D-02 🟢 Close the still-open P1 first, then a read-only report

The premise was false — the original fix was incomplete. Authorization and self-removal must be
`user_id`-only; invite creation stays pending instead of resolving by raw `users.email`; only a token
with `email_verified === true` may claim. Needs an **integration** test driving `editableProject`,
not a unit test asserting no UPDATE ran.

Then **Option 1, report only** — and SQL alone cannot answer it: `users` stores neither verification
nor admin-grant provenance, collaborators store no claim provenance, admins can be granted manually.
Join candidates by `firebase_uid` against Firebase Admin for verification/disabled/provider state and
DB↔Firebase↔invited-email mismatches. Counts first; PII only through a private channel, never
committed, never in CI artifacts. Zero rows → stop. Non-zero → targeted reviewed remediation, never a
blind bulk script; protect the last legitimate admin from lockout; revoke collaborators only after
the raw-email paths are gone, notify the owner, review activity since the claim. Option 3 rejected —
collaborator access is broad edit authority too. No production mutation without approval of the report.

*Status: the code half is implemented and independently verified. The historical report is not run.*

---

## D-03 🟢 Keep anonymous viewing, bind it to a capability

Anonymous avatar use is intentional: shared/public viewers expose Ask Avatar and guests use Firebase
anonymous auth. Requiring middleware auth fixes nothing (disposable anonymous accounts still pass)
and requiring a real account is a feature regression.

Required: `projectId` mandatory for public starts (reject the bodyless global path); the canonical
player/share/permalink path mints a short-lived `aud=avatar` capability bound to project, entitlement
and nonce/jti *after* visibility and share-token checks — **a project UUID is not a capability**,
especially for unlisted content; require that capability on `/avatar/start`,
`/avatar/visual/analyze` and `/avatar/image/analyze` (those analyze routes today accept arbitrary
project ids, touch a private library, and spend money); **atomically reserve weighted cost in
Postgres before the vendor call**, layered by HMAC(IP), Firebase uid incl. anonymous, capability jti,
project, owner/account and a platform-global budget, with the process-local limiter demoted to a
burst shield; concurrency limits, `Retry-After`, alerts, global kill switch, fail closed for billable
calls if the reservation cannot be made. `/avatar/end` is a no-op — do not trust it to release cost;
reserve worst-case duration or reconcile against vendor usage. Weight analysis by real fan-out. Scope
idempotency to viewer/capability — today's short cache can hand one token to unrelated viewers.

Phasing: strict Zod bodies + mandatory capability-ready shape + conservative burst caps + kill switch
now; durable meter in shadow mode to calibrate while emergency caps hold; then enforce.
Short-retention IP HMACs only. Follow-up recorded for disclosure/consent and retention/deletion of
transcripts, conversation facts and generated visuals.

*Note: the entitlement half of the capability is out of scope this session (billing excluded). The
visibility, share-token, abuse-limit and kill-switch halves are not.*

---

## D-04 🟢 Fail loudly now (revisioned sims only), full fix next — not blocked by D-01

Fail loudly **only when `active_revision_id` exists**; legacy sims keep their working mutable-prefix
paths. Replace returns a stable structured 409 (`SIM_REVISION_WRITE_UNSUPPORTED`) *before* multipart
parsing, the status CAS, or any storage write. Publish guidance is EventSource, so establish SSE
first and emit a **named error** with the same code before touching `guidance_status`, TTS or upload
— a pre-SSE JSON 409 renders in the current client as just "Connection lost". Tests must prove zero
DB/storage/TTS mutation for a blocked revisioned sim, and keep legacy happy-path coverage. Disable
the UI action with the same explanation, but the server guard stays authoritative.

`simulation-003` is a *different* bug: reads/replace compatibility use the legacy source/bridge while
publication derives from the active revision. Fix that read path now to use the active manifest and
`package/bridge.js`; blocking new replaces does not repair already-diverged data.

Full revision-aware work is **independent of D-01**. One shared primitive: derive from active
revision → transform → draft/upload/validate → CAS activate with `expectedActiveRevisionId`. Replace
combines uploaded files with the live bridge/guidance; guidance derives a new revision, injects
`guidance.js` and the entry tag, and updates metadata/status inside the activation transaction. Do
not rewrite N section URLs with `?g` — the new revision URL is the cache bust. File/download/UI-control
reads become revision-aware. No process-local lock for activation. Ordering dependency: PR #31 holds
the capture-compatibility gate in `RevisionService.validate`, so build on that head.

Read-only reconciliation report for historical false successes: revisioned sims marked
guidance-ready whose active manifest lacks guidance, and legacy sources replaced after the active
revision forked. Do not auto-promote legacy bytes — the active bridge may have diverged.

---

## D-05 🟢 PR #31 stays deferred

Do not merge. Preserve branch ordering; continue on the branch already based on #31. No production
data mutation, no anchoring bulk migration, no merge without a new explicit instruction.

---

## D-07 ⚫ Playlist entitlement matrix — WITHDRAWN

Asked whether paid content is live, to size finding `billing-001`. **Withdrawn:** payments,
paywalls, locked videos and paid playlists are out of scope for this session by owner instruction.
No answer needed.
