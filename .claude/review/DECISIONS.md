# Open decisions

**This file holds only what is still open.** Answered rulings move to
`DECISIONS-ARCHIVE.md` so this one stays short enough to read in a minute.

Last updated: 2026-08-17 · branch `fix/night-audit-2026-08-15` · nothing is on `main`

**Status:** 🔴 critical · 🟡 blocks one item · ⚪ open, not blocking

**Out of scope this session:** payments, paywalls, locked videos, paid playlists, Stripe,
entitlements. Excluded from the remediation queue and from the reports by owner instruction — not a
critical feature for this pass. Findings in that class are marked `OUT OF SCOPE (billing)` in the
ledger rather than deleted, so nothing is lost if it is picked up later.

---

## D-09 🟡 The new b-roll idempotency indexes take a write lock during deploy

**Problem.** The migration audit reports three `migrations.lock-risk` WARNINGs: *"Non-concurrent
index build takes a write lock for its duration."* One is `060_export_plan_snapshot.sql` (arrived
with PR #31, pre-existing). Two are `062_broll_idempotency.sql` — ours, the durable job→section
uniqueness that stops a retried b-roll job appending a second section.

**Situation.** `timeline_sections` is a hot table. A non-concurrent index build blocks writes for as
long as it takes, so on a large table this is deploy downtime, not a formality. The obvious fix,
`CREATE INDEX CONCURRENTLY`, **cannot** be used as things now stand: the migration runner is now
transactional, and Postgres forbids CONCURRENTLY inside a transaction. The runner documents this as
a known limitation.

**Options.**
1. **Ship as-is.** Correct; the lock is proportional to current table size. Fine if the table is
   small, a visible stall if it is not.
2. **Add the per-file opt-out the runner already anticipates** — run that migration outside a
   transaction with per-statement splitting, then make 062 concurrent. More machinery, and the file
   loses the transactional rollback that was just added deliberately.
3. **Build the index out-of-band** — deploy the code, create the index concurrently by hand in a
   quiet window, then enable enforcement.

**Recommendation.** Turns on one number I do not have: the row count of `timeline_sections` in
production. Under ~100k this is milliseconds and option 1 is right. Above that, option 3 — it keeps
the transactional runner intact and moves the lock to a moment you choose.

**Default while unanswered.** Ship as option 1 on the branch. Nothing deploys without you, and the
warning stays in the audit output rather than hidden.

---

## D-08 ⚪ 301 findings nobody has adversarially checked

**Problem.** Of 330 findings, only **29** went through adversarial verification (28 confirmed, 1
refuted). The other 301 — every P2 and P3 — are unverified claims. One already collapsed on
inspection (`database-002`), and two of my own claims were refuted by review.

**Proposal.** Run a verification sweep over the P2/P3 set before implementing any of them in bulk,
the way the P1s were checked. Costs a pass; stops me building fixes for bugs that are not there.

**Default.** I verify each finding myself immediately before implementing it, and never implement
from a title. Slower per item, no wasted work.

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

## D-10 ⚪ client-web has no test timeout, so its suite goes red under load

**Problem.** During this session the full gate reported **42 client-web failures**. On an idle
machine the same suite is **1405/1405 green**. Every failure was `Test timed out in 5000ms`, and
every failing test was an async polling one — "polls the export id", "rides out a transient
failure", "defers the frame until the observer reports intersection".

**Situation.** `client-web/vitest.config.ts` sets no `testTimeout`, so it uses vitest's 5s default.
`backend-api/vitest.config.ts` raises its budget to 60s and carries a long comment explaining
exactly this failure mode — *"a TIMEOUT with passing assertions, which reads as a logic bug and is
not one"* — after the same thing happened there. The lesson was applied to one package.

**Why it matters beyond convenience.** A gate that goes red for the wrong reason trains people to
ignore it. It cost real time twice today, and both times the honest first read was "we broke
something".

**Options.** (1) Raise `testTimeout` for client-web with the same reasoning written down. (2) Leave
it and always run the gate on an idle machine. (3) Reduce vitest concurrency for that package.

**Recommendation.** Option 1. It weakens no assertion — a test that needs 6s instead of 5s is not a
worse test — and it makes the signal mean what it claims.

**Default.** Not changed yet. I have been running the gate on an idle machine and saying so.

---

## D-11 ⚪ Where I disagree with the rulings, or would go further

Recorded because the rulings so far have been strong and I have been wrong twice — but not
everything in them is settled, and agreeing by default is its own failure mode. Three reservations
and one number, in order of how much they matter.

### 11a — Clustering 263 unverified findings by root cause has a circularity problem 🟡

D-08 rules that the P2/P3 set be grouped by root cause and one canonical member of each cluster
verified, rather than sweeping 301 titles. The efficiency argument is right. But the grouping input
is the finding's own *claimed* root cause — and claims are exactly what is unverified. Of the 32
findings ever adversarially checked, **23 were downgraded**, which is direct evidence that reporters
misjudge their own findings at scale. Cluster from a bad claim and you verify one member, confirm
it, and then implement fixes for "aliases" that are not the same bug.

**What I would do instead:** verify **two or three** members per proposed cluster, chosen to be as
dissimilar as the cluster allows, before treating the rest as aliases. If they diverge, the cluster
was wrong and splits. It costs perhaps 2× on the sampled members and removes the failure mode
entirely. I am proceeding this way unless told otherwise.

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

**I will establish which is true before implementing, and report the answer rather than assuming.**

### 11c — `lock_timeout = 3s` is a number I chose, not one anyone verified ⚪

D-09 said "a low lock_timeout" and I picked 3s in migration 062. That is a guess dressed as a
decision. Too low and a deploy aborts during ordinary traffic; too high and it defeats the purpose.
It should be derived from how long the lease-column `ALTER TABLE` actually takes on a real table of
representative size — which is the same measurement D-09 already says is needed before adding any
index. Flagging it so it is not mistaken for a considered value.

### 11d — one place the ruling may be incomplete, not wrong ⚪

D-01a anchors a b-roll to a **main video segment id + local offset**. That survives a re-transcode
and a reorder, which is the point. But a placement in a gap between main videos, or past the end of
the last one, has no host to anchor to — D-01 mentions "a legal last-segment post-roll tail" but not
the gap case. If gaps are reachable in the editor, that needs an answer before the migration, not
after. I will establish whether they are and report.

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
