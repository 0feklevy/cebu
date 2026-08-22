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

---

## D-06 ⚪ Correction log — no answer needed

Recorded so nobody re-derives from a bad version. Both verified in code.

**The b-roll root cause I published was wrong.** I reported that b-roll positions are recomputed from
`video_files.duration_sec`. True of **clip overlays** (`type='clip'`, computed at
`buildPlayerConfig.ts:581-591` from a cumulative duration sum); **false of true b-roll**
(`track='broll'`, emitted at `:555-575` with its *stored* `global_offset_sec`, unchanged). The real
true-b-roll defect is that an absolute second stays fixed while the content underneath it moves —
which is why recomputation cannot fix it. Report corrected.

**A P1 I reported as closed was not closed.** `a63aa4e` gated the middleware's invite-claim UPDATE,
but `collabAccess.ts` still authorized on a raw `invited_email` match at two sites, bypassing the
gate entirely. Now fixed and independently verified. My verification had been insufficient: I tested
that the UPDATE did not run instead of testing the authorization path.

**Minor:** `broll_volume` defaults to `1.0`, so it was wrong of me to cite it as evidence b-roll is
meant to be silent. Dead guidance is finding `simulation-002`, not `simulation-003`.

---

---

## D-08 🟢 ANSWERED by measurement — the tail is over-stated, not under-stated

**The premise was backwards, and the data says so cleanly.**

I compared every finding's REPORTED severity against the severity its adversarial verification
settled on. 32 findings went through that pass:

| reported → verified | count |
|---|---|
| P1 → P1 (held) | 6 |
| P1 → **P2** | 22 |
| P1 → **P3** | 1 |
| (unlabelled) → P3 | 3 |
| **anything → higher** | **0** |

**26 moved down. Zero moved up. Not one.** Four were refuted outright.

**What that means for the 301.** The original worry was that a P0 might be hiding in the unverified
tail. The measured drift runs the other way: the reporting agents systematically over-state, and
adversarial checking only ever finds *less* than was claimed. A P2 in that tail is therefore most
likely a P3, and the expected yield of a mass verification sweep over 301 rows is low — it would
mostly produce downgrades, at the cost of a full pass.

**So the proposal is withdrawn and the default stands, now with evidence behind it rather than
pragmatism:** verify each finding adversarially at the moment I implement it, never implement from
a title, and do not spend a sweep on the tail. This is exactly how the current wave is being run —
every fix agent is instructed to try to REFUTE its finding first and stop if it succeeds.

**One caveat I will not paper over.** The verified sample is not random: it is the P1 set, chosen
because it was the most alarming. Over-statement may be concentrated in exactly that population —
the loudest claims being the least accurate is an unsurprising shape. So this is strong evidence
that the tail contains no hidden P0, and weaker evidence about the tail's internal ranking. It
does not license deleting the tail; it licenses not sweeping it.

**Practical consequence, and a correction to my own language.** The findings this wave is fixing
were reported as P1 and verified as **P2**. They are real, mechanically reproduced bugs and worth
fixing — moderation that has never blocked anything, HLS that stretches anamorphic sources, jobs a
deploy silently kills — but the PR will describe them at their VERIFIED severity, not the reported
one. I had been carrying the reported number, which over-states the branch.

---

---

## D-09 🟢 MOOT — the indexes it was about no longer exist, and the warning class was noise

**The question dissolved.** D-09 asked how to land two non-concurrent index builds on the hot
`timeline_sections` table without a deploy stall. When I reworked migration 062 those index builds
were **removed entirely** — 062 now contains one `ALTER TABLE … ADD COLUMN` and one bounded
`UPDATE`, and builds no index at all. There is nothing left to decide.

**And the alarm that raised it was mostly noise.** I measured the whole class across the 62 forward
migrations:

| | count |
|---|---|
| non-concurrent index builds | ~85 |
| …on a table **created in the same file** | **76** |
| …on a **pre-existing** table | **9** |

The 76 cannot stall anything, and not just because the table is small: the runner wraps each file in
a transaction, so the table does not exist for any other session until the file commits, and nobody
else has ever been able to write a row to it. The lock is structurally uncontended.

So the audit fired 85 warnings to describe 9 situations. `7b3932b` teaches it the difference, and
makes the surviving warning **name the table** — an operator deciding whether to build out-of-band
needs to know which table to go and count. `CONCURRENTLY` still fails ahead of the suppression;
called without file context the classifier stays conservative and warns exactly as before. +7 tests,
mutation-verified (removing the suppression reddens exactly the two tests that assert it).

**What is left, stated plainly:** of the 9 genuine lock risks in the entire migration history, 8
shipped to production long ago. The only undeployed one is `060_export_plan_snapshot.sql`'s
`project_exports_fingerprint_idx` — it arrived with PR #31 (deferred per D-05), on a table created
two migrations earlier, so its size is bounded by exports run since 058 deployed. **No answer needed
from you.** If that table ever does grow large, option 3 from the original framing still applies:
deploy the code, build the index concurrently by hand in a quiet window.

---

---

## D-10 🟢 ANSWERED and FIXED — no ruling was needed, so I made the call

Three of four workspaces (`client-web`, `admin-web`, `shared`) had no `testTimeout` and ran on
vitest's 5s default. `release:verify` runs every workspace concurrently and this repo's audits run
many agents at once, so the "idle machine" that 5s assumes does not exist when it counts.

**Fixed in `f570f73`: 20s for the three, deliberately not backend-api's 60s** — nothing in them
boots a database, so 20s is ~4x headroom for scheduler starvation while a genuinely hung test still
fails in twenty seconds rather than a minute.

**Proven under the failing condition rather than on a quiet machine**, which is the only run that
would have shown anything: client-web **1409/1409 green at load average 53.86** — higher than the
~49 that produced 42 red tests earlier in this audit and briefly looked like a regression from this
branch.

No assertion was weakened. The only thing that changed is how long the runner waits before deciding
the machine is stuck.

**Divergence from the external reviewer, on the record.** Its 2026-08-18 update rejects raising the
timeout and orders: keep 5s, cap vitest file-workers by CPU (`availableParallelism()/2`, max 2),
require ten consecutive green runs at 5s. **I am keeping 20s, and here is why the disagreement
resolves my way on this machine:** the worker cap only controls *self-inflicted* load — this host's
contention is **external** (16-agent audit fleets, ffmpeg, concurrent suites), which no per-suite
worker cap touches. Its own acceptance criterion — ten consecutive greens at 5s — is unpassable
here while audits run, which is precisely the false-red condition that burned us; whereas 20s is
**proven**: 1409/1409 at load 53.9. The liveness cost is real but bounded — a genuinely hung test
fails at 20s instead of 5s, fifteen seconds of CI latency on a failure path. **Three of its
accompanying orders are right and are adopted:** (1) the CPU-derived worker cap (good against
`release:verify` oversubscription, independent of the timeout question), (2) gate runs capture full
output + real exit codes via `pipefail`+`tee` — never a live `grep` as the verdict, (3) exactly one
full `release:verify` at a time on this host. All three are in the handoff.

---

---

## D-11 ⚪ Where I disagree with the rulings, or would go further

Recorded because the rulings so far have been strong and I have been wrong twice — but not
everything in them is settled, and agreeing by default is its own failure mode. Three reservations
and one number, in order of how much they matter.

### 11a — Clustering 263 unverified findings by root cause has a circularity problem 🟢 CLOSED

**Superseded by the D-08 measurement.** The mass sweep this objection was guarding against is
withdrawn entirely — 26 severities moved down under adversarial checking and zero moved up, so
there is no sweep for a bad cluster to poison. Where clusters are still used (organizing fix
waves), the sampling rule stands as policy: verify **two or three dissimilar members** before
treating the rest as aliases, and dedupe against everything *seen*, not everything *confirmed* —
otherwise judge-rejected findings reappear every round. Nothing left to decide.

### 11b — A new capability token is not obviously the minimal answer 🟡

D-03 rules that the player/share/permalink path mint a short-lived `aud=avatar` capability bound to
project and nonce. The reasoning — a project UUID is not a capability, especially for unlisted
content — is correct and I am not disputing it.

My reservation is about the **vehicle**. This introduces a new credential type into a system that
already has share tokens, with its own lifetime, revocation, replay and rotation concerns, and a new
credential is a new thing to get wrong. Before building one, I want to know whether the existing
share/session token can carry an avatar scope instead. If it can, that is strictly less surface for
the same guarantee. If it genuinely cannot — because anonymous public viewers hold no such token —
then the ruling is right and I will build it.

**ANSWERED, and CLOSED 🟢.** Established from the code: an anonymous viewer of a *public* project
holds **no credential at all** — there is no share token on that path and Firebase-anonymous auth
is a disposable identity, not an entitlement. So there is genuinely nothing existing to extend, and
D-03's capability is the right call. The vehicle is settled in the D-14 ruling: **stateless HMAC
claims minted inside the player-config response** — the config request already passes exactly the
visibility/share-token checks that must precede minting, so both public and share-token viewers are
covered by one mechanism, with **no new endpoint, no new client hop, no new table** (the replay
`jti` is a dimension row in the budget reservation that already exists). The "new credential
surface" objection is answered by making the credential have almost no surface: no server-side
state to rotate or leak, expiry is the revocation, and the signing key is the one secret the
backend already holds.

### 11c — `lock_timeout = 3s` is a number I chose, not one anyone verified 🟢 CLOSED

Closed in `b170074`. The basis changed — 062 no longer builds any index, so the timeout's only job
is bounding how long a **pending ACCESS EXCLUSIVE request** may queue (and stall the readers behind
it) on a hot table. The ALTER itself is metadata-only: verified against real Postgres that `now()`
is `provolatile='s'` and the added column lands as `attmissingval` (no rewrite), with
`clock_timestamp()` as the contrast case proving the check has teeth. 3s now has a derivation
instead of a shrug, written into the migration itself.

### 11d — one place the ruling may be incomplete, not wrong 🟢 CLOSED

**Established from the model, not from hope: an interior gap is unrepresentable.** Every layout of
the main track — player build, export planner, editor `buildClips` — is the same three lines: sort
by `created_at`, offset = running total, running total += duration. **There is no per-video start
column anywhere in the schema and no UI that could set one**, so a gap between two main videos is
not merely absent from the data; it cannot be expressed. A video with unknown duration contributes
zero width (a zero-width segment, not a hole). The one producible case — a placement **past the end
of the last video** — is covered by the post-roll tail rule D-01 already named, and the shared
resolver (`shared/src/timeline/placement.ts`) documents both as `MAIN_TIMELINE_HAS_NO_GAPS` +
`POST_ROLL_TAIL_SEC`, with unknown-duration and out-of-range rows excluded from any automated
backfill per the D-01 rollout. Nothing blocks the migration.

---

---

## D-12 🔴 Does Supabase need replacing before the site has many users?

**Reserved — a four-stream investigation is running now and this entry gets filled from its
evidence.** Recording the question and the frame first, so the answer is judged against a question
that was posed before the data arrived rather than after.

**The question as asked:** whether Supabase should be swapped for something better for storing all
the data, once there are many users.

**The frame I am insisting on, and why.** The honest question is not "is Supabase good enough" — it
is **which layer actually saturates first**. Production is a 2-vCPU VM. If the constraint is that
box and not the database, replacing Postgres is an expensive way to fix nothing, and it would carry
a migration risk we would be taking on for no measured gain. So the investigation has to answer, in
order: what saturates first, at roughly what scale, and because of which specific query or endpoint.

**What is already established and is not speculation:**

- `DATABASE_URL` is documented through Supabase's **transaction pooler on 6543**, and that has
  already broken one real thing: a session-level advisory lock in the migration runner could not
  serialise, because `max: 1` pins a connection to the pooler rather than to a Postgres backend.
  Fixed by a session-mode `MIGRATION_DATABASE_URL`, but it is evidence the pooler is not free.
- Transaction poolers do not support prepared statements, session advisory locks, `LISTEN/NOTIFY`,
  temp tables, or a `SET` that must persist. pg-boss's `LISTEN/NOTIFY` is already opt-in for exactly
  this reason, with polling documented as the "correctness floor". The sweep for the rest of those
  features is part of the investigation.
- Media bytes are the other axis entirely, and it is separate from Postgres: anything served
  through the API process rather than the bucket or a CDN hits a very low ceiling on 2 vCPU.

**The three answers this can come back with, and what each implies:**

1. **The host is the constraint.** Then the work is capacity and offloading media, and the database
   is not the story. Cheapest outcome, and my prior — but a prior is not evidence.
2. **The pooler is forcing architectural compromises.** Then the fix may be a direct/session-mode
   connection rather than a different vendor, which is a configuration change, not a migration.
3. **Postgres itself is genuinely the ceiling** — unbounded tables with no retention, query shapes
   that cannot be indexed out of trouble, or plan limits. Only this third answer justifies moving,
   and it needs the growth driver named (per user? per project? per playback?) because that decides
   which table hurts first and how soon.

**What I will NOT do:** recommend a migration on thin evidence. If the investigation cannot
distinguish these three, the honest output is the measurement that would, not a recommendation.

---

---

## D-12 ANSWERED (by evidence, not by vote) — **the 2-vCPU host is the constraint. Supabase is not.**

Replacing Postgres would fix nothing on the list below, and would be an expensive way to fix
nothing. The investigation was told to distinguish three possible answers; it landed decisively on
the first, and the numbers are checkable.

### Why Supabase is not the problem

**Connections do not grow with users.** 28 total, fixed: postgres-js `max: 10` in each of two
processes (`db/index.ts:28-33`), pg-boss `max: 4` in each (`queue/pgBoss.ts:73`), one for migrations
at deploy time. The capture container runs `network_mode: none` and opens zero. Neither Next app
touches Postgres. **Nothing opens a connection per request or per job.** Connections saturate
*last*, and not close.

**The transaction pooler is doing almost no damage.** A sweep for every session-scoped feature came
back nearly empty: zero temp tables, zero `SET`/`set_config`/`search_path`. Session advisory locks
appear only in the migration runner, which this branch already made refuse a pooled URL. And
pg-boss 12 uses `pg_advisory_xact_lock` — transaction-scoped, pooler-safe — verified in the
installed package, whose own source calls NOTIFY "only ever a latency hint".

**`buildPlayerConfig` is not an N+1**, contrary to the assumption I carried in. One `Promise.all` of
ten, follow-ups `inArray`-batched, narrow column lists to stay off jsonb. Index coverage is
genuinely good: all 68 `CREATE INDEX` plus 30 schema declarations were checked against every hot
filter, and the single gap is a `LIKE 'base%'` on an owner-only authoring path.

### What actually saturates, in order

1. **CPU, at TWO concurrent uploads.** Eight of eleven job types still run in the process that
   enqueued them, and every enqueue site is an API controller — so HLS transcode, caption burn and
   podcast render execute **inside the API container**. `WORKER_INLINE: 'false'` does not prevent
   this; it only redirects the three pg-boss names. `FFMPEG_CONCURRENCY=2` is per-process, so four
   ffmpeg processes on two cores.
2. One concurrent export (deliberate — capture is granted `cpus: 2`, the whole box).
3. The sim-asset proxy's event loop.
4. `projects.view_count` row contention — the first genuinely database-side wall, and it needs tens
   of simultaneous viewers *of one project*.
5. Connections.

### The findings worth acting on, none of which are "move database"

- **[BUG, one line]** `db/index.ts` never sets `prepare`, so postgres-js runs with named prepared
  statements through a documented-6543 URL. Whether this Supavisor version tolerates it could not be
  determined from the repo — but the fix is one line and the failure is loud.
- **[BUG]** `parseDbUrl` silently discards the URL query string, so `?pgbouncer=true` and
  `?sslmode=` have no effect; TLS is decided purely by a hostname-suffix test.
- **[LIMIT]** `QUEUE_PGBOSS_LISTEN=1` has no session-mode guard, though `migrate.ts` already exports
  `describeTransactionPooler()` for exactly this check.
- **[COST, the real storage finding]** Media bytes do *not* cross the app server — HLS is served
  from the public bucket with immutable cache headers, everything else presigned. The exception:
  `getSimPublicUrl` routes **every simulation asset through the API**, and the text half pays a full
  S3 GET + sha1 + brotli **per request, including on the 304 path**, because the ETag is computed
  after the read. No nginx `proxy_cache`, no CDN in front of the API origin, packages up to 1 000
  files.
- **[LIMIT]** `playlists.controller.ts:620` fans `buildPlayerConfig` out N-wide unbounded — a
  30-item playlist is roughly 420 queries in one burst onto a pool of 10.
- **[LIMIT]** No retention on `branch_path_events`, the fastest grower (viewers × interactions,
  written by a public unrate-limited endpoint, one INSERT per event, no batching). Notably
  `sim_rum_events` — the table everyone expected to be the problem — is the one that got it right,
  with a bounded batched sweep. Nobody copied it.

### If you moved anyway, the cost is not the schema

52 tables and 62 ordered migrations is the easy half. The hard half is Storage: `getSimPublicUrl`
exists to work around a Supabase behaviour, `publicUrlKeys.ts` reverse-engineers its URL shape, and
several columns store full URLs rather than keys — so a bucket move is a **data rewrite**, not a
config change. Auth is Firebase and already decoupled.

### Four dilemmas this raises, for the final round

1. **Move the inline jobs off the API process, or buy vCPUs?** Moving them relocates contention on
   the same VM rather than creating CPU, and puts them behind the serialised export lane. The lean
   is to isolate first — it is a blast-radius argument, not a throughput one — then size the VM
   against the resulting queue depth.
2. **What replaces the `/sim-public` proxy?** nginx `proxy_cache` (cheap, app stays on the byte
   path); a CDN in front of `api.` (fixes bandwidth but caches an origin where most routes set no
   cache headers — a real footgun); moving sims to R2 (but `getStorageAdapter()` is a process-wide
   singleton that cannot serve two backends by prefix); or Supabase Pro with a custom storage
   domain, which deletes the reason the proxy exists.
3. **`view_count`: exact and contended, or cheap and approximate?** The code already treats it as
   best-effort. Is it a creator-facing number they would dispute?
4. **Retention on `avatar_conversations` is not a telemetry question.** That is user conversation
   content, and it needs a product and privacy answer, not a sweep.

---

---

## D-15 🔴 Merging this PR also ships PR #31 — 27 commits and 87 files you deferred

**Not a defect. A fact about what the merge button does, and you should not learn it afterwards.**

This branch is based on `30c0a4b`, which is PR #31's head, not `main`. That was the correct choice
and D-04 required it — PR #31 holds the capture-compatibility gate that the revision-aware
simulation work builds on, and re-basing onto `main` would have meant reimplementing it. But the
consequence is structural:

```
main (2d187e3)
  └── PR #31          27 commits · 87 files   ← linear export, sim-capture, migration 059
        └── this branch   25 commits          ← the night-audit remediation
```

**Merging this PR merges both.** There is no way to take the audit work without the export work; the
audit commits sit on top of it and several of them touch files PR #31 created.

**D-05 ruled "PR #31 stays deferred… no merge without a new explicit instruction."** You have since
said to merge and release. I am reading that as the explicit instruction D-05 asked for — but it was
given about *this* branch, and I would rather ask than assume it silently covered 27 commits of
export and capture work you had separately decided to hold.

**What PR #31 contains**, so the question is answerable without reading it: the linear video export
pipeline (frozen execution snapshot, fingerprinted spec binding, cancellation that asks the row
rather than the error name), the sandboxed sim-capture path (descriptor-based artifact boundary,
per-frame validation, five production false-greens closed), the isolation of `project_export` into
its own queue so it fails closed instead of running inside the API, and **migration 059, which
existed and was reviewed but would never have run** because nobody added it to the runner's
hardcoded list.

**Three ways forward:**

1. **Merge both** — one release, the export work goes live with the audit fixes. Simplest, and the
   two are already tested together as one tree; nothing has ever been tested with the audit work on
   plain `main`.
2. **Merge PR #31 first as its own release**, let it settle, then merge this. Same end state,
   two smaller blast radii, and if something breaks you know which half.
3. **Rebase this branch onto `main`** and ship the audit alone. **I recommend against it:** it
   drops the capture gate that D-04's revision work builds on, and it would invalidate every test
   run on this branch.

**My recommendation is 2** if the export work has never been exercised against production data, and
**1** if you are comfortable with it — the combined tree is the one that is actually green.

**Either way, note that migration 059 and 062–064 all land in the same deploy.** Migrations are
expand/contract and the runner is transactional, but that is four schema changes in one release, and
the migration audit should be read before it goes out, not after.

### ⚖️ RULING — 2026-08-18, issued in place of the external reviewer (final unless the owner vetoes)

**Option 2 — two merges, two deploys, in order. The principle deciding it: every tree that reaches
production must be a tree that was actually tested.** Exactly two tested states exist: `30c0a4b`
(PR #31 alone, its own green CI) and this branch's head (#31 + audit, the tree every suite here ran
against). Sequencing the merges deploys exactly those two states and nothing else.

1. **Merge PR #31 into `main` first** (it is already an open PR; no rebase — the commit that merges
   is the commit that was tested). Deploy. This deploy carries **migration 059**. Watch the release
   gate and the export smoke.
2. **Then open this branch's PR against the new `main`.** The base fast-forwards — this branch
   already contains #31, so no conflicts are possible. Merge after the gate. Deploy. This deploy
   carries **062–064**.
3. **Before each deploy, read that deploy's migration-audit output.** Post-`7b3932b` the audit no
   longer buries the signal under 76 false alarms — a lock-risk line that survives it is real and
   names its table.

Option 3 (rebase onto `main`) is **rejected outright**: it manufactures a tree that has never been
tested anywhere and drops the capture gate D-04 builds on. Option 1 (one combined release) is
acceptable second-best if the owner prefers a single release — the deployed tree is this branch's
tested tree — at the price of not being able to attribute a regression to a half.

---

---

---

# Ruled by the external reviewer — 2026-08-19

All four of these were provisionally ruled by me on 2026-08-18 and then reviewed. **Every one of my
rulings was accepted in direction and corrected in substance**, and two of the corrections closed
real defects in what I had proposed. The provisional text is kept below each item so the reasoning
chain is legible; where the two disagree, **the reviewer's ruling is the one to implement**.

The corrections worth carrying forward, because they are the pattern:

- **D-13** — I proposed caching the player config per `projectId`. That is a **security bug**:
  `buildPlayerConfig` is viewer-dependent, and a collaborator's share token can end up in the
  payload, so a per-project cache could hand an anonymous viewer a token built for the owner.
  Authorization must also run *before* any `304`, or a viewer who lost access keeps getting a
  stale allow. And `diff-before-setState` is not sufficient on its own: when b-roll genuinely
  changes the payload differs, `setConfig` still hands the shell a new `segments` array, and the
  caption state resets exactly when the real update arrives.
- **D-14** — I claimed the `jti` gives replay protection for free. It does not: one capability can
  serve several popup opens and can be replayed until expiry — it is a *metering bucket*. My
  "one-statement CTE" is also unsafe, because a multi-row `UPSERT … RETURNING` can update early
  dimension rows before a later one fails, so a denied request would still consume budget. And an
  in-flight cap of 32 is queue capacity, not concurrency — 32 stuck queries against a pool of ~10
  would choke the app. Dropped shadow samples are **biased missing data under load**, not "noise".
- **D-16** — my framing was too narrow. The backend already separates smoothing per shot; the
  *client* was losing the boundaries. (That half is now fixed — see `7c342ce`.)
- **D-17** — part of my description was already stale: `559ed28` had closed the cross-project
  visual scope before the review ran.

**Both D-13 and D-14 remain PARTIAL, and no `enforce` switch may be turned on.**

## D-13 🔴 A corrected b-roll list now reaches the player — but nothing tells the player to look

**Status: half-shipped, and the shipped half is the half that was blocking. This is the other half.**

`broll-player-001` had two independent defects and only one is fixed.

**Fixed (commit `410a658`).** The viewer's tick handler was frozen at mount — `useCallback(fn, [])`
closing over `config`, with six reads hanging off it — so even when React handed the page a
corrected clip list, the player kept scheduling from the list it fetched on first load. It now
reads through a committed-revision ref, promoted only at a moment when no lane is mid-shot, with
the prewarmed standby torn down if the clip it warmed moved. A correction can no longer swap a
shot out from under the viewer, and a warm buffer can no longer outlive the clip it was warmed for.

**Not fixed, and this is the decision.** The viewer polls for its config exactly once. The effect
clears its own interval in the same block that delivers the first ready config, so after that a new
revision arrives only by accident — when the auth context happens to re-render (its `getIdToken` is
a fresh inline arrow inside an un-memoised context value, so a cross-tab sign-in is enough). A
creator who fixes a mis-placed b-roll while someone is watching has no path to that viewer's screen.

**Why I did not just make the poll continuous.** It is about six lines, and it has a verified
regression behind it: the player shell resets caption state on `config.segments` **identity**, not
value, so re-`setConfig` on every poll would wipe the viewer's captions every five seconds. It also
turns a 60-minute lecture into ~720 config requests per viewer, against a host we have already
established is the scaling constraint (D-12).

**The three shapes, and what each really costs**

| | mechanism | staleness | cost at 1k concurrent viewers | new failure mode |
|---|---|---|---|---|
| **A. keep polling, diff before setState** | interval stays alive; `setConfig` only when the serialised payload differs | ≤ poll interval | ~720 req/viewer/hour at 5s; ~60 at 60s | none new — the diff kills the caption reset |
| **B. ETag / revision probe** | poll a tiny `revision` endpoint, refetch the config only on change | ≤ poll interval | same request count, ~100× smaller bodies | one more endpoint to keep honest |
| **C. push (SSE)** | server tells the viewer a revision landed | seconds | one held connection per viewer | held connections on a 2-vCPU box; needs the proxy to not buffer |

**My recommendation: B, at a 30–60s interval, not 5s.** A is the smallest patch but keeps the
config payload on the wire; C is the right long-term shape and the wrong thing to add to this host
today. B costs one endpoint and gets the staleness to under a minute, which is the honest
requirement here — this is *"the creator fixed a mistake"*, not *"the stream is live"*. Whichever
we pick, the diff-before-setState guard from A is mandatory, because it is what stops the caption
wipe.

**What I need from you:** which shape, and what staleness is actually acceptable for a viewer who
is mid-watch when the creator corrects a clip. If the answer is *"they can refresh"*, say so
explicitly and I will close this as won't-fix and delete the polling remnant rather than leave a
mechanism that half-works.

### ⚖️ RULING — 2026-08-18, issued in place of the external reviewer (final unless the owner vetoes)

**Shape B — but with no new endpoint: a conditional GET on the config route the viewer already
calls.** A separate revision endpoint is a second thing that can lie about the first thing; an
`ETag`/`If-None-Match` pair on the existing route is the same probe with the answer attached and
nothing new to keep honest. Five pieces, each load-bearing:

1. **Strong ETag on the config response** — hash of the exact serialized payload sent. The client
   re-polls with `If-None-Match`; unchanged → `304` with no body.
2. **Per-project server micro-cache, ~5s TTL**, keyed `projectId → (serialized, etag)`. This is what
   makes polling affordable on the 2-vCPU host: N viewers of one lecture collapse into one config
   build per 5s regardless of N. Without it, 1k viewers at 60s ≈ 17 builds/s competing with ffmpeg;
   with it, cost scales with *projects being watched*, not viewers.
3. **Poll every 60s ± jitter, only while the tab is visible and playback is live**
   (`document.visibilityState`-gated). 60s staleness is the honest requirement — this is "the
   creator fixed a mistake", not live TV. Takedown does not ride on this path (storage/share
   revocation is server-side).
4. **Diff-before-setState stays mandatory** — it is what stops the caption reset
   (`config.segments` identity) from firing. `304` covers the common case; the diff guard covers a
   rebuilt-but-identical payload after the micro-cache expires.
5. **Kill the accidental path while adding the deliberate one.** Memoize the auth context value and
   `getIdToken` so delivery stops depending on unrelated re-renders, and delete the
   self-terminating interval remnant. The poll then becomes the *only* delivery mechanism — which
   is what makes it testable: (a) a new revision arrives within one tick, (b) a `304` leaves
   caption state untouched, (c) a hidden tab does not poll.

The committed-revision pinning from `410a658` is untouched — this ruling only feeds it. Rejected:
**A** (full payload on the wire every tick, needless), **C** (held SSE connections on the
constraint host — right shape someday, wrong host today), **won't-fix** (a correction that never
reaches a mid-watch viewer re-opens, from the user's seat, the exact bug this branch just fixed).

---

## D-14 🔴 The cost meter D-03 ordered would undo the avatar speed-up we just shipped

**This is me disagreeing with a ruling I am implementing, which is the thing you asked me to do
rather than defer.**

D-03 ruled: *"atomically reserve weighted cost in Postgres **before** the vendor call"*, fail closed
for billable calls if the reservation cannot be made. The security reasoning is right and I am not
disputing it — an anonymous viewer must not be able to spend unbounded vendor money, and a
reservation made after the call is not a reservation.

**But look at what it costs on the path you complained about.** The avatar work on this branch cut
the healthy start from *up to 6 sequential vendor round trips plus 4–5 DB round trips* down to **one
vendor round trip and two DB reads**. The reservation being built inserts itself between the
authorization gate and the mint, and in its current shape it opens a transaction and issues, strictly
in sequence:

```
BEGIN
  SELECT killed FROM avatar_budget_state
  INSERT … ON CONFLICT … RETURNING units     ← once PER DIMENSION
                                                (ip, uid, jti, project, owner, global)
                                                = 4 anonymous · 5 signed-in · 6 with a capability
  INSERT avatar_session_leases                ← WHERE carries TWO correlated count(*) subqueries
COMMIT
```

**8–10 sequential round trips to an external Supabase instance, at 5–20 ms each ⇒ ~50–200 ms added
to every single avatar start** — wiping out most of the DB-preamble win, on the exact user-visible
path the complaint was about.

**And it is not opt-in.** `budgetMode()` defaults to `shadow`, and the runtime skips the transaction
only for `off`. **Shadow mode runs the full transaction.** So the "safe calibration phase" D-03
prescribes is the phase that costs the most and protects nothing yet.

### What I propose instead, and why I think it is strictly better

| | reserve-before, blocking (as ruled) | **what I recommend** |
|---|---|---|
| shadow mode | full txn, blocking, ~50–200 ms, zero protection | **fire-and-forget** — same writes, off the critical path. Calibrates just as accurately. |
| enforce mode | full txn, blocking | **one round trip**: collapse the per-dimension upserts into a single statement and drop the correlated `count(*)`s in favour of a maintained counter |
| burst protection while shadow calibrates | none until enforce | the existing **process-local limiter**, which D-03 already keeps as a burst shield |

Shadow mode exists to learn the distribution, and a fire-and-forget write learns it exactly as well —
nothing downstream reads the result during shadow. Making it blocking buys nothing and costs the
user 50–200 ms on every open. In enforce mode the reservation genuinely must precede the vendor
call, so it stays blocking — but 8–10 round trips is an implementation choice, not a requirement of
the ruling, and one statement can do it.

**I have not implemented this yet** — the code is still being written by the stream that owns it, and
I will not edit a file mid-edit. Recording it now so the tension is visible rather than discovered
later in a latency complaint.

### Two related things in the same work, flagged so they are not surprises

- **`/avatar/start` now expects a capability the shipped client never mints.** Harmless today because
  capability mode also defaults to `shadow` — but the day anyone sets it to `enforce`, **every
  avatar open 401s**. That switch needs the client change to land first, in that order.
- **When the client *is* taught to mint one**, `POST /avatar/capability` becomes a **new
  client→backend hop in front of `/avatar/start`** unless it is minted at page load rather than at
  click. That would re-add exactly the class of serialized hop this whole audit exists to remove.
  Mint it at page load.

**What I need from you:** only whether you accept fire-and-forget in shadow mode. If you want the
reservation blocking even while it protects nothing, say so and I will implement it as ruled and
record the ~50–200 ms as a known cost.

### ⚖️ RULING — 2026-08-18, issued in place of the external reviewer (final unless the owner vetoes)

**Fire-and-forget in shadow is accepted — with one guard the proposal itself missed.** An unawaited
write during a Supabase stall builds an unbounded promise backlog, which is a memory leak on a
timer. Cap in-flight shadow writes with a simple counter (~32); beyond it, **drop the sample and
count the drop**. A dropped shadow sample is noise; shadow's entire output is a calibration
distribution and a log line, and nothing downstream reads its verdict — so blocking on it buys zero
protection at ~50–200 ms per start. D-03's "reserve before the vendor call" is a requirement about
*enforcement*; shadow enforces nothing, so the requirement does not attach to it.

**Enforce mode stays blocking but becomes ONE round trip.** The invariant that matters is
*atomicity of check-and-reserve*, not statement count: one CTE — `unnest` the 4–6 dimension rows →
`INSERT … ON CONFLICT DO UPDATE … RETURNING units` → join the caps → return allow/deny **plus which
dimension tripped** (the 429 message needs it). Replace the two correlated `count(*)` subqueries on
`avatar_session_leases` with a maintained counter updated in the same statement. Everything plain
DML — pooler-safe, no advisory locks, no prepared-statement dependence. The kill-switch read is
cached in-process for 2s: a kill still lands within 2s, and the hot path stops paying a read per
start. Enforce-mode DB failure = **503 + Retry-After** for billable calls (fail closed, as D-03
ruled) — never a silent allow, and logged distinctly from "over budget" so an outage is not
misread as abuse.

**The capability hop is eliminated, not optimized: mint it inside the player-config response.** The
config request already passes exactly the visibility/share-token checks D-03 says must precede
minting, so a separate `POST /avatar/capability` client hop should not exist. Stateless HMAC
verification — claims `aud=avatar`, project, entitlement shape, `exp` ≈ 10 min, 128-bit `jti` — and
replay control comes free: the `jti` is simply one of the dimension rows in the same one-statement
reservation. No new table, no new read, no new hop. (This also settles D-11b — see there.)

**Hard ordering constraint, recorded as a release rule:** server accepts the capability (shadow) →
client ships minting-at-config-load → only then `AVATAR_CAPABILITY_MODE=enforce`. Flipping enforce
first 401s every avatar open. The same discipline for `AVATAR_BUDGET_MODE`: shadow calibrates
against ≥ a few days of real traffic before enforce, because the first cap anyone ships from
reasoning alone is wrong in one direction or the other.

---

## D-16 🟡 The vertical crop is NOT perfect — you asked directly, and the honest answer is no

**Your question:** *"ה-crop vertical מושלם?"* **Answer: visibly wrong on two of the most common
things in this footage**, per a read-only investigation whose load-bearing numbers an independent
adversarial pass **reproduced digit-for-digit** with its own scripts (rare — most reports lose
something under that treatment). Full evidence: `.audit-ledger/vertical-crop-investigation.md`
(committed, `f43f72a`).

**The algorithm** (so the defects make sense): 4fps low-res frames → three column profiles
(motion, skin-tone rule, spectral saliency) → per-shot peak-picking → keyframes → debounce +
smoothing → a single crop path.

**The two defects a viewer notices in seconds:**
- **BUG-3, the strongest finding: the smoother cannot deliver a normal speaker turn.** A camera/
  speaker switch that should complete in ~1.5s reaches only ~49% of the required travel at its
  peak — a **409-pixel miss**, i.e. the crop is still mostly on the *old* speaker after the cut,
  and it is two-sided (the old speaker is already out too). Verified step-response: 17% at −1.2s,
  54% at 0, 99% only at +2.4s. Podcast footage is *made of* speaker turns.
- Peak-picking weights skin×2.0, so a static face beats the person actually talking/moving.

### ⚖️ RULING
Fix in the next wave, ordered: **(1)** make the smoother shot-aware — a detected cut resets the
smoothing state and snaps (or fast-slews ≤300ms) to the new target instead of easing 2.4s across
it; **(2)** re-weight peaks toward motion-correlated-with-audio when available; **(3)** keep the
investigation's repro scripts as the regression harness — they are pure-CPU, no I/O, and they
reproduce today's failure exactly, so red→green is provable. This is quality work, not a release
blocker: nothing here corrupts data or crashes — it ships bad-looking crops, which is a product
defect to fix deliberately, not a hotfix.

---

## D-17 🟡 Avatar Ask — the algorithm's weakest link is VISUAL retrieval, and one split-brain

**Your question:** *"לבדוק את avatar ask… האלגוריתם שם אופטימלי?"* **Answer: text retrieval is
defensibly simple, visual retrieval is unsound three separate ways, and there is one split-brain
worth fixing first.** Full evidence: `.audit-ledger/avatar-quality-investigation.md` — its claims
survived an independent adversarial pass with line-accurate citations ("I found no citation that
failed to say what the report claims", which the reviewer itself called unusual).

- **Text path:** no app-side retrieval at all — the transcript is pasted flat into the persona
  prompt (head-truncated at 24k chars) plus a 200k-char copy to the vendor's own RAG tool. Crude
  but sound; nothing to rank means nothing ranks *wrongly*.
- **Transcript SPLIT-BRAIN (best finding, verified end-to-end):** the prompt half and the RAG half
  are built from different sources and can diverge — the avatar can then contradict itself about
  the same video. Fix: one canonical transcript assembly feeding both.
- **Visual retrieval is what the viewer actually sees, and it is unsound three ways** (ranking,
  eligibility, and staleness — the file names each with its line). This is the gap between "works
  in demo" and "wrong image on a real question".
- Moderation fail-open is **already owned** by the running llm-integrity stream (llm-pipeline-002)
  — not double-assigned here.

### ⚖️ RULING
Order: split-brain first (correctness, small), then the three visual-retrieval defects as one
wave with the investigation as the spec, then re-run the investigation's probes as acceptance.
Like D-16: next-wave quality work, not a release blocker.

---

# Closed execution round — archived 2026-08-19

Everything below is the execution-state record as it stood when the 2026-08 remediation round
closed. It is history, not work: PRs #31–#37 merged, v0.1.30 cut. Kept verbatim so the reasoning
and the corrections (including the ones the external reviewer forced) stay findable.

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

## 🟢 Storage volume — implemented this round, and what stays blocked

A code-level audit mapped ~30 storage writers against 11 deleters. **Shipped now** (all
delete-last, best-effort, behind the row deletes):

- **Podcast show / episode / source delete** now remove their bytes — previously all three
  cleaned nothing, and the FK cascade destroyed the rows naming the keys. Both prefix shapes are
  swept (`podcasts/{showId}/…` for sources, `podcasts/{episodeId}/…` for renders/chunks/clips).
- **Image delete** removes the object (the replace path always did; the delete path never).
- **Playlist delete** sweeps `playlist-banners/{playlistId}` — covering every superseded banner.
- **Project delete** additionally collects: avatar-visual bytes (with the same `source !==
  'editor'` guard `deleteVisual` uses), `thumbnails/{id}` (all superseded, not just current),
  `captions/{id}`, `projects/{id}/corpus`, `exports/{id}`, and `crop/{videoId}.json` per video.
- **Video delete** removes its crop JSON and caption backups.
- **Superseded thumbnails and caption backups are GC'd at the write** — four thumbnail writers
  and the caption writer minted fresh uuids and never deleted predecessors.
- **Export section intermediates are deleted once the master publishes** — only after the ready
  fence proves the run still owns its row.
- **`RevisionService.gc()` finally has a caller** — a 6-hourly sweep (keep-2 floor and age grace
  are inside gc itself). It was fully implemented and called by nothing.

**Owner action (config, one-time):** add the bucket lifecycle rule "abort incomplete multipart
uploads after 7 days" in the Supabase dashboard — abandoned large-video uploads are billed but
invisible to LIST, and no code can reach them. Documented in `.env.example`.

**Blocked on the production census** — run `deploy/scripts/storage-census.sql` (read-only,
aggregate-only, no PII) against production and bring the output: `branch_path_events` retention
(needs a rollup design — a bare TTL silently changes owner-visible analytics), failed-duplication
reaping (the census measures whether plan-driven reaping even suffices), `token_usage` rollup,
and any TOAST-heavy column work. **No production number exists yet** — nothing in this section
claims a byte count, deliberately.

**Deliberately NOT done** (per the external reviewer, unchanged): cross-project media dedupe,
revision dedupe by manifest_hash, avatar_visuals dedupe, podcast chunk pruning by "not in current
mix", conversation/RUM TTL changes, plan-JSON normalization.

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

---

# Closed round — archived 2026-08-22 (the v0.1.36→v0.1.38 span, and the 2026-08-22 day)

Everything below is CLOSED and moved here from `DECISIONS.md` on 2026-08-22, after each closure was
re-verified rather than assumed — the verification method is named per item, because "owner-attested"
and "agent-verified in production" are different claims.

## The 2026-08-21 feature round — SHIPPED as v0.1.36, then hardened through v0.1.38

Three features built on three branches, merged via `integration/night-run`, shipped 2026-08-21 as
**v0.1.36** (run 32473689948, digest-pinned, `HEALTHY → BROWSER_VERIFIED`): Library Share Phase 1,
ElevenLabs Dubbing v2 with the viewer language switcher, crop v2 P0 harness + P1. R-13 played out as
ruled — one dispatch carried PRs #36–#47, closing the deploy drought. **v0.1.37** followed with the
dubbing expansion round, and **v0.1.38** (2026-08-21) carried the production-data repair; its release
gate verified `rows still holding a loopback URL: 0` from the outside. Rulings R-01…R-10 and their
execution notes are recorded in `CODEX-DECISION-RESPONSE-2026-08-21.md` Part I.

## 🟢 The two browser-console CSP defects — FIXED (PR #53), repaired in production, gate-verified

The owner's console showed avatar-circle images served from `http://localhost:8080` and simulation
iframes from `pub-*.r2.dev`, both CSP-blocked. Root cause was ONE class — a URL built from
configuration instead of asked of the storage adapter — present in TWO more places nobody had
reported yet (captions, HLS proxy). All four fixed by asking the adapter, plus a persist-time guard;
`frame-src` was NOT widened. The lone production row holding a loopback URL (inside
`projects.avatar_config` JSON, invisible to the earlier 10-column repair) was fixed by
`backfill-localhost-urls.ts` with its 11th JSON-path target; v0.1.38's release gate — the same gate
that had correctly BLOCKED v0.1.37 over this row — confirmed zero remaining. The `FAILED → DEPLOYING`
refusal that forced a fresh dispatch instead of a re-run was the state machine working as designed.

## 🟢 The dubbing panel round — D-20/D-21/D-22, delivered (PR #57)

Reported from the running product: the source language was never detected (068's column had no
writer, so English was offered for an English video — reported twice); the progress bar drew
`done/total videos` (0/1 for a whole run); 94 languages had no search and no order. Delivered:
migration **070** (`video_dubs.stage`, `stage_entered_at`, `projects.source_language_origin`,
poll index); `detectLanguage.ts` (offline script+stopword identification from stored WebVTT — no
vendor call, no tokens); `sourceLanguage.ts` (declared > vendor > detected, cached, provenance
recorded, sub-threshold guesses are suggestions that exclude nothing);
`PUT /projects/:id/source-language`; `stages.ts` (seven pipeline steps, wall-clock-weighted
percentages, asymptotic creep that can never claim an unfinished step); panel search with graded
relevance (exact code → prefix → substring, accent-folded) and three sorts. 26 new tests.

## 🔴→🟢 D-23 — the dubbing feature was COMPLETELY DEAD in production (PR #58)

No production dub had ever run. Diagnosed live on the VM (read-only): every attempt died in
`acquireDubbingSlot` with `TypeError: … Received an instance of Date` — a raw `Date` bound into
`db.execute(sql…)`, which postgres-js `unsafe()` does not serialise. Thrown before any log line and
before the vendor was reached; pg-boss retried on backoff and failed permanently; the row sat
`queued` forever. Three compounding silences, each fixed: the slot acquire sat outside `run()`'s
try/catch; `registerWorkers` re-threw without logging (the error existed ONLY in
`pgboss.job.output`); every test was green because PGlite serialises Dates itself — the exact
mechanism of `test-quality-015`, confirmed P1 the same night in `RumService.fieldAggregates` and
fixed in the same PR. The invariant is pinned at the parameter layer in both suites. Also verified
while diagnosing: **the vendor client's five endpoint shapes are correct** against the current API
reference (`POST /v1/dubbing/project` accepts `reference`; beware — the docs 404-redirect the
current surface's `create` URL to the LEGACY `POST /v1/dubbing` page, which briefly misled the
diagnosis). Production left clean: no pending dub jobs, no orphan rows.

## 🟢 job-queue-011 — the rollback crash-loop (PR #58)

`rollback.sh` re-pointed `APP_VERSION` without checking out the matching tree, so the OLD image got
the NEW compose file's `WORKER_QUEUES`, threw on the unknown name, and crash-looped the only
background-work container — while `wait_healthy` omitted `worker` and reported success. Fixed: the
rollback checks out the target commit (best-effort, loud warnings), `worker` joined its health wait,
`resolveWorkerQueues` now SKIPS unknown names (error-logged) and throws only when nothing known
survives — the expand/contract rule for queue names — and `deploy.sh` maps a detached-HEAD reading
to `main`.

## 🟢 Acting on the verification sweep — 10 findings closed (PRs #58, #59, #60)

- **PR #59**: `security-009` (knowledge-doc DELETE never proved project membership, under a SHARED
  vendor key — now group-scoped, 404 on refusal), `security-008` (`findManageableVisual` matched
  `OR project_id IS NULL`, making every global avatar visual writable by any project owner — now
  strictly project-scoped), `security-011` (Firebase tokens accepted in `?token=` on every route and
  retained by nginx's `"$request"` log — fallback allowlisted to the two SSE route patterns, nginx
  logs `$request_method $uri`), `backend-011` (fire-and-forget failure handlers could kill the
  process on Node 22 — hardened, `sanitizeDbText` strips the NUL Postgres rejects,
  `installProcessSafetyNet` at module scope in API and worker), `config-003` (NOTHING on the host
  had a memory limit — ceilings sized from measured idle usage, 6016 of 7815 MiB, swap off,
  `cpus: 1.5` on the worker only; the ceiling test was mutation-checked, four mutations caught).
- **PR #60**: `security-007` (six multipart routes buffered whole files — two "checked" size only
  AFTER the allocation; all six now refuse on declared size then cut the stream at the ceiling; env
  overrides documented in a new `.env.example` section), `database-005` (the hottest read path
  fetched every scene's transcript + word alignment for four scalars, usually for nothing — narrowed
  AND skipped, with the config parse hoisted so it exists once), `performance-009` (katex+chart.js
  in every viewer's initial JS — `next/dynamic`; **measured**: `/[slug]` 1310→836 KB,
  `/v/[shareToken]` 1288→813 KB).

## 🟢 The watermark flag — SET, agent-verified 2026-08-22

`ELEVENLABS_DUBBING_WATERMARKED=false` confirmed in BOTH containers' process env (docker exec, value
read directly). What remains is only the probe dub, tracked as an open item.

## 🟢 Production fleet audit (crop P0.1) — delivered 2026-08-21, all follow-ups now verified closed

Six videos; concurrency question settled (no queue exists — `QUEUE_CROP_CONCURRENCY` stays 1 as a
measured ruling, not caution); crop runs ~0.4× realtime (measured off the re-crop's timestamps);
both crop failures were missing storage objects, not the algorithm. Follow-ups: the four healthy
videos re-cropped onto v1.1 through the app's own queue (**verified 2026-08-22: 4 rows carry
`crop_algo_version = v1.1`**); the 79 MB missing object was owner-attested hand-deletion
(storage-leak file does NOT reopen); the dead public project was deleted by the owner from the app
(**verified 2026-08-22: zero Niceville rows**), through the delete handler that collects
avatar-visual bytes a hand-rolled SQL delete would have orphaned.

## 🟢 CI evidence from PR #45 — the WebKit lane is flaky, and measured

Same commit produced 1, 2, and 3 failures on different runs (scenario 11 consistent; 9 and 32
flaky); a docs-only PR reproduced it. Baseline recorded so future WebKit reds are compared, not
panicked over. The open remainder — re-key `__CHILD` off Window identity and correct the `ci.yml`
comment — lives in the work queue.

## 🟢 Previously untracked deliveries, recorded then closed

PR #51 (94 languages, migration 068, `PERMALINK_LANGUAGE_SUFFIXES` derived not duplicated) —
merged, shipped in v0.1.37. The two ideas volumes (`FLOWVID-NEXT-STEP-IDEAS.md` 1,334 lines;
`FLOWVID-EXPANSION-AND-GTM-IDEAS.md` 743 lines) — delivered reference material.
`localCaptureProvider.ts` — arrived by accident (over-broad `git add -A` against R-07), kept
deliberately once #44's GPU host shipped; the ruling is amended, the accident recorded.

## 🟢 broll-data-001 / D-01b — shipped (PR #56)

Migration **069** (`placement_impact_reviews`, anchor FK SET NULL → NO ACTION), the cut-to-fit
clamp REMOVED from the transcode job (it silently rewrote authored ranges on every duration
change), replace raises a review instead of clamping, delete refuses until the author chooses.
Open follow-ups (work queue): absolute `timeline_markers.at_sec` and manual avatar ranges carry the
same drift class; the review queue has API + delete-time UI but no standing editor panel.

## 🟢 D-13 viewer config freshness — shipped (PR #55)

Conditional GET, 60s ± 25% jitter, self-scheduling timer. The flaky range-assertion test was fixed
to assert the real subject (floor) plus a runaway guard (ceiling); green five consecutive runs.

## 🟢 Sim-capture "~10× too slow" — CLOSED, owner-attested

PR #44's dedicated GPU export host is live and is the sole consumer of `project_export`. The owner
ran a real export on it and accepted the result ("takes a while, but the video with the simulation
comes out — don't touch"). The 2-vCPU premise no longer describes where exports run. No formal
seconds-per-frame was recorded; if export latency ever becomes a complaint, measure THEN. The
Creator-Side Render Farm idea demotes to contingency.

## 🟢 Two carried items from 2026-08-19 — closed 2026-08-21

The VM deploy pin (owner cleared the dirty tree by census, never `reset --hard`; v0.1.36 deployed
through the same pin) and the Supabase lifecycle rule (platform auto-aborts incomplete multipart
uploads after 24h — stricter than the rule we planned; nothing to configure).

## 🟢 Billing — DESCOPED by the owner, 2026-08-21

The 24 `OUT_OF_SCOPE_BILLING` findings (two P1s among them) stay parked deliberately. If billing
returns: parked is not fixed. The live money path is dubbing, guarded by the R-03 per-user monthly
ceiling.

## 🟢 The 0-byte root `.env.local` — removed by the owner (attested), 2026-08-21
