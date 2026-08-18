# FlowVid — Engineering Novelty Assessment

**Run 2026-08-16 · patent-scout · commit `2d187e3` (main)**

> This is an engineering assessment, not a legal opinion. Whether any of it is *patentable* —
> claim scope, jurisdiction, a real prior-art search — is a question for a patent attorney. What
> follows is an attempt to hand an attorney a short, hostile-tested shortlist instead of a long
> credulous one.

---

## How to read this

I started every candidate at **"this is obvious"** and made it earn its way up. The question was
never "is this clever?" or "was this hard?" — a great deal of the best work in this repository is
both, and still obvious in hindsight. The question was only ever:

> Would a competent engineer in this field, handed this exact problem and the tools of the day,
> plausibly arrive at this solution?

I surveyed roughly thirty mechanisms, researched the ones that survived against how the field
already solves the same problem, then wrote the strongest case *against* each survivor and kept
only the ones that answered it.

**Two survived.** Both are moderate — worth an attorney's hour, neither oversold. The rejected
list is longer than the shortlist by design; it is what makes the shortlist worth reading.

One headline finding before the entries: **the deterministic-video-export machinery, which was the
most promising-sounding lead, did not survive** — and it failed twice over. The technique is the
established industry standard, and separately, the reproducibility guarantee the system is
believed to make is not actually established by the code. That is written up in the rejections,
because it matters more than a weak entry would.

---

# Survivor 1 — Nothing reaches the screen until something has vouched for it

### The problem

A viewer is watching a video. Part way through, the video stops and a live, interactive
simulation takes over the same rectangle of screen. Later it hands back to video. The user should
experience one continuous thing.

The hard part is the seam. When you switch what the user is looking at, you have to uncover the
new content at the exact moment it is genuinely ready — and **the browser will not tell you when
that is.** It will happily tell you a dozen nearby things that all sound like the answer and are
not: that data exists, that seeking finished, that playback started, that the element believes it
can play. None of those means *the specific picture you asked for has actually been drawn.*

So you uncover, and one time in twenty the user sees a black flash, or a frozen frame of the wrong
moment, or — worst — the previous simulation still sitting there looking exactly like a real
answer. The user cannot tell that it is wrong. They just think the product is broken.

Every naive fix makes it worse. Wait longer, and slow devices still fail while fast ones feel
sluggish. Wait for the strongest signal the browser offers, and it sometimes never arrives at all
— on an occluded tab, on an unsupported browser, on certain source switches.

### How the system solves it

The rule is that **a cover is never dropped on a belief — only on evidence.** And the system is
strict about what counts.

```
              the user leaves the simulation
                            │
                            ▼
        ┌───────────────────────────────────────────┐
        │  THE COVER HOLDS                          │
        │  the frozen simulation frame the user     │
        │  was already looking at — still-valid     │
        │  pixels, not black                        │
        └───────────────────────────────────────────┘
                            │  now seek the video to the handoff point
                            ▼
        ┌───────────────────────────────────────────┐
        │  WAIT FOR PROOF                           │
        │  two observation channels run at once     │
        └───────────────────────────────────────────┘
             │                │                │
             │                │                │
    a frame arrives   a frame arrives    no frame ever
    from THIS         but from an        arrives at all
    handoff, at       older handoff,          │
    THIS timecode     or the wrong            │
             │        timecode                │
             │                │               │
             │           REJECTED —           │  the weaker,
             │           re-arm and           │  explicitly LABELLED
             │           keep waiting         │  proof is unlocked
             │                                │
             ▼                                ▼
    ┌──────────────────┐            ┌──────────────────────┐
    │  PROOF ACCEPTED  │            │  DEADLINE, still     │
    └──────────────────┘            │  no proof            │
             │                      └──────────────────────┘
    wait one more paint of                     │
    the page, and re-check                     ▼
    that the proof STILL              ┌──────────────────────┐
    matches                           │  COVERED FAILURE     │
             │                        │  cover stays up,     │
             ▼                        │  user is offered a   │
    ┌──────────────────┐              │  retry               │
    │  UNCOVER         │              └──────────────────────┘
    └──────────────────┘                       ▲
                                               │
                          this is the deadline's ONLY exit.
                          There is no path from here to "uncover".
```

Three things in that picture are doing the real work.

**A frame is not proof — the *right* frame is proof.** A picture arriving during a seek is a
genuine, freshly-drawn frame; it is just a frame of the wrong moment. So each observation is
stamped with which handoff it belongs to and which timecode it carries, and anything that does not
match both is thrown away and the wait re-arms.

**The deadline cannot authorise a reveal.** When proof never comes, the system does not shrug and
show it anyway. The timer's only reachable outcome is a held cover with an honest retry. The
system will sooner leave a cover up forever than show one frame nobody vouched for.

**Proof is re-checked one paint later.** Evidence says the video frame reached the compositor —
not that removing the cover has been drawn. So the uncover is committed on the *next* paint of the
page, with the evidence re-verified at that moment.

The same rule is applied at every independent place a timer could be tempted to authorise pixels —
the handoff, the section-switch hold, the failure policy — and each of those places carries a
comment recording that it used to do the opposite.

### The insight

The specific non-obvious step is a distinction about **what elapsed time is allowed to be evidence
of.** The instinct — and the thing a competent engineer would get wrong — is to adopt one uniform
timeout policy: *wait N milliseconds, then proceed.* This system refuses that, but it does not
refuse timeouts. It draws a line, and the line is in an unusual place.

A deadline is never admissible as evidence about **pixels**, because time elapsing is not an
observation of a canvas. But a deadline *is* admissible as evidence about other propositions: the
same subsystem that forbids a timer from revealing a frame explicitly *allows* a timer to conclude
"this content's bridge never acknowledges anything" — because silence, after a bounded wait in
which the content was asked a direct question, is a real observation about the content. One
deadline is a fact about a correspondent; the other is a guess about a picture.

Getting that line in the right place, and then holding it at four separate sites where a shortcut
was locally tempting, is the thing. The default engineering instinct runs the other way: a
permanently stuck cover is a worse user experience *in the common case* than a rare wrong frame,
so almost everyone builds the timeout fallback. Choosing the inversion — and accepting a visible,
retryable stall as the price of never lying — is a deliberate stance, not a discovered one.

### What the field generally does

Browsers now expose a callback that fires when a video frame is handed to the compositor, carrying
that frame's own timecode. It exists precisely so applications can stop guessing, it is widely
documented, and using it to verify a seek landed is squarely its intended use. Its own
specification is candid that it is best-effort and offers no strict guarantee.

Above that primitive, the common industry pattern in media players is a *timeout-backed* reveal:
wait for the best available readiness signal, and if it does not arrive within a bound, proceed
anyway rather than stall. Player frameworks in this space generally optimise for never getting
stuck, on the reasoning that a stall is visible and blamed while a one-frame artefact is usually
not noticed. Discarding stale asynchronous results by tagging them with a generation counter is
likewise textbook practice across the whole industry, not specific to media.

So the constituent parts are all standard. What is not standard is the refusal.

### The case against

**The strongest argument that this is obvious:** it is three well-known parts bolted together. The
frame-presented callback is the documented tool for exactly this job. Rejecting a callback whose
timecode does not match your seek target is the *first* thing anyone doing frame-accurate seeking
does — there are public write-ups of precisely that trick. Generation counters for stale async
results are a pattern every senior engineer already has. And "fail closed" is a safety principle so
standard it is a cliché. Sum of three known parts, applied competently. Not an invention.

**My answer, and its limits.** The fail-closed framing is where the argument is weakest, because
fail-closed here is *not* the conservative default — it is the aggressive choice. In a security
context, failing closed denies an action; the cost is inconvenience. Here, failing closed means
deliberately accepting a **permanently stuck user interface** in exchange for never showing a wrong
frame. That trade is not the obvious one, it is not what player frameworks in the field do, and the
repository contains the archaeology of the team making the opposite choice first and reversing it.
The second non-obvious element is the asymmetry described above — timers refused as evidence about
pixels while being accepted as evidence about a correspondent's silence — which is a finer
distinction than "fail closed" captures, and I could not find it articulated in the field.

**Where the argument against still bites**, honestly: I can construct a plausible path by which a
good engineer arrives here. Ship a player, get bug reports about black flashes, read the callback's
documentation, add timecode matching, then discover the callback sometimes never fires and face a
binary choice — reveal anyway or hold the cover. Picking "hold" is one of two doors. That
constructible path is exactly why this is *moderate* and not *strong*.

**And three claims in the code do not hold up**, which an attorney should know before relying on
the internal documentation:

- The invariant's named "executable form" is a **test-only auditor**, not a production guard. This
  is arguably a better design — the guarantee is enforced structurally, by there being no path in
  the state machine from a deadline to a revealed state — but the documentation overstates it.
- The exhaustive test is real and does assert the invariant after every single step, but it walks
  **120 generated combinations**, not the six-axis product the comment describes: one axis is
  constant, one is cycled rather than crossed, and event *ordering* follows a fixed template rather
  than being permuted. The header's "no sequence, of any length, in any order" is stronger than
  what runs.
- The "labelled" weaker evidence is **not durably labelled**. The label reaches an in-page debug
  array that requires a URL flag and is never transmitted. Nothing in the product's telemetry can
  currently distinguish a high-confidence reveal from a low-confidence one.

### Verdict

**Moderate.** The refusal to let elapsed time authorise pixels — and the finer rule about what
elapsed time *may* be evidence of — is a real, deliberate, testable inversion of what the field
does, but a competent engineer could plausibly reach it from a clear statement of the problem.

### Where it lives

`podcast-saas/client-web/lib/sim/transitionCoordinator.ts` (accept/reject at :531-600, deadline→covered at :719-741, auditor at :398-405);
`podcast-saas/client-web/lib/sim/frameEvidence.ts`;
`podcast-saas/client-web/lib/sim/presentationPolicy.ts`;
`podcast-saas/shared/src/sim/activationMachine.ts`;
`podcast-saas/shared/src/sim/simFailurePolicy.ts`;
`podcast-saas/client-web/lib/sim/SimRuntimeClient.ts:1657` (the deadline-as-evidence-about-silence case);
tests: `podcast-saas/client-web/__tests__/transitionCoordinator.test.ts:298-357` (120 cases, verified by running the suite).

---

# Survivor 2 — Content that has to earn the right to be shown live

### The problem

The simulations in this product are **customer-authored programs**. The platform did not write
them, cannot rewrite them, and cannot assume anything about how they behave.

That collides badly with the guarantee in Survivor 1. That guarantee depends on the content
*telling* the viewer when it has drawn the requested scene. Some packages do. Some cannot — they
were written before the convention existed, or they are simply built in a way that makes the
question unanswerable.

Which leaves a genuine bootstrapping trap. The viewer needs to know, *before* it shows anything,
whether this package is the kind that will answer. But the only way to find out is to ask one and
see — and the cost of finding out the answer is "no" is precisely the defect you were trying to
prevent: a wrong frame on screen, in front of a real user. **The very first time each package is
used in each session is unavoidably a guess, and the guess was "reveal".** The user could be shown
the wrong sub-simulation, once per package, per session, forever.

### How the system solves it

The observation is moved off the user's session entirely. Whether a package answers is a property
of its **bytes**, not of anyone's viewing session — so it is stable for the life of that version,
and it can be discovered once, at publication, in a real browser, with no user watching.

The elegant part is what one such run produces. It is not a test that returns pass or fail. It is
a single execution that emits four different things, each consumed by a different part of the
system:

```
        AT PUBLICATION — one run, in a real browser, on hardware we control
        ═════════════════════════════════════════════════════════════════════

   the customer's package ──▶ asked to present every variant, in every
   (bytes we did not write        required configuration, and to say so
    and cannot edit)                          │
                                              │ produces four artefacts
        ┌─────────────────┬───────────────────┼──────────────────┬─────────────────┐
        ▼                 ▼                   ▼                  ▼                 │
   a VERDICT         a PICTURE            a DURATION       a CAPABILITY            │
   can it present    of exactly what      how long it      does it answer          │
   what it is        it presented         took             when spoken to          │
   asked for?                                                                      │
        │                 │                   │                  │                 │
        ▼                 ▼                   ▼                  ▼                 │
   the viewer's      shown INSTEAD OF     the cold-start   the first               │
   PERMISSION to     the live frame       preparation      activation is a         │
   show live         whenever the         lead time, and   lookup instead of       │
   pixels at all     verdict says no      the standard a   a guess                 │
                                          device is                                │
                                          judged against                           │
        └─────────────────┴───────────────────┴──────────────────┴─────────────────┘
                                        │
                            all four keyed on ONE identity —
                            the same fingerprint the viewer's
                            reveal gate compares against
```

Two rules make it trustworthy rather than decorative:

**An incomplete proof is never a success.** A run that crashed, timed out, or could not reach the
asset server produces *failure* — never a quiet downgrade to a lesser classification. Those are
different statements: the lesser class means "we watched it behave cooperatively", and a run that
aborted watched nothing. The same reasoning is applied to omission: a report that lists no steps
has nothing failing in it and would otherwise classify as fully capable while having demonstrated
nothing, so publication additionally requires that every case reported every step.

**The verdict is re-derived, never read.** The classification is stored as a field, and that field
arrives across a process boundary and could have been written by an older build or edited by hand.
The publish gate therefore recomputes the classification from the report's own evidence and
requires the two to agree. A report whose stamp disagrees with its contents is refused rather than
reconciled — there is no way to know which of the two is the lie.

And one package failing one configuration demotes the whole package, because the viewer picks the
variant at runtime and cannot be selective about a promise.

### The insight

The specific non-obvious step is that **the certification run produces the fallback as a
by-product of producing the proof.**

Almost anyone would arrive at "run the content at upload time and cache what you learn" — that
part is ordinary. What is easy to miss is that the run has already done the expensive, hard-to-
reproduce work of getting this exact package into this exact configuration and making it draw. At
that instant it is holding the picture. So the still image that will stand in for the live content
— on a device too old to run it, during the window before it has proved itself, or when the
verdict is "this one may never be shown live" — is captured *from the same execution that produced
the verdict*, keyed by the same fingerprint.

That closes a gap that is otherwise very hard to close: a substitute image only works if it shows
what the live frame *would have* shown — same variant, same interface chrome, same hidden
controls, same camera, same aspect. A generic package screenshot fails all of those at once and is
worse than no image at all, because the user sees one picture, then a visibly different one, and
reads the difference as a glitch. Sourcing the substitute from the proof run makes that
correspondence structural rather than aspirational. The system goes further and treats a fully-
capable package with no captured picture as an **error**, on the grounds that it cannot honour the
fallback its own policy promises.

The second, quieter insight is the direction of the coupling: this is not a quality score or a
report. It is a **permission**, consumed at runtime by a safety invariant. Content that cannot
prove it will speak is not shown live — not degraded, not shown with a warning. Represented by a
picture.

### What the field generally does

Validating user-supplied content at upload time is completely standard — media platforms transcode
and probe on ingest, app marketplaces review submissions before granting privileges, and browsers
have long negotiated capability by probing rather than assuming. Making a deployment gate depend on
a real-browser run that must pass is ordinary continuous-integration discipline. Caching an
expensive-to-compute property of an artefact at build time rather than recomputing it at runtime is
just memoisation.

Publish-time capture of a representative still image is also common — video platforms generate
thumbnails on ingest as a matter of course.

What I did not find as a general pattern is the *coupling*: a certification run whose output is
simultaneously (a) a runtime permission consulted by a display-safety rule, and (b) the substitute
artefact used when that permission is denied, both keyed on one identity so they cannot drift.

### The case against

**The strongest argument that this is obvious:** each half is thoroughly ordinary. Upload-time
validation is standard. Thumbnail generation at ingest is standard. Fail-closed on incomplete
verification is standard. Not trusting a serialised derived field and recomputing it is standard
defensive practice with a name. Feature detection instead of assumption is a documented best
practice. Put them in one pipeline and you have a competent ingest pipeline, not an invention — and
"the run that renders the thumbnail also tells you if rendering worked" is arguably just noticing
you already had the data.

**My answer.** The last point is the real one, and I think it survives, narrowly. The
non-obviousness is not that one run produces two outputs — it is *which* two, and what they are
wired to. The thumbnail is not a thumbnail here; it is the load-bearing substitute in a safety
rule, and its correctness requirement is unusually strict — it must match the live frame on five
separate configuration axes or it actively makes the product look broken. Meeting that requirement
by construction, rather than by a second pipeline that tries to reproduce the same conditions, is
the step. A competent engineer building this would very plausibly build two systems: a validator
and a thumbnailer. They would then spend a long time discovering that their thumbnails do not match
what the player shows.

**Where the argument against still bites:** the bootstrapping problem, once clearly stated —
"this is a property of the bytes, not of the session" — makes moving the observation to publish
time nearly automatic. If the only invention were that move, it would not clear the bar. The entry
rests on the artefact coupling, not on the move.

### Verdict

**Moderate.** A single publish-time execution that mints both a runtime display permission and the
exact substitute used when that permission is denied is a defensible, non-obvious coupling — but
every individual component of it is standard practice, and the assembly is reachable by a careful
engineer.

### Where it lives

`podcast-saas/shared/src/sim/canaryContract.ts` (classification rule);
`podcast-saas/backend-api/src/services/simulation/canaryJudge.ts` (re-derivation and completeness guard);
`podcast-saas/shared/src/sim/bridgeCapability.ts` (capability read from published bytes);
`podcast-saas/backend-api/src/scripts/sim-canary-publish.ts:99-171` (posters captured by the canary run; missing poster is an error);
`podcast-saas/shared/src/sim/posterIdentity.ts`, `podcast-saas/backend-api/src/services/simulation/PosterService.ts`;
`podcast-saas/backend-api/src/services/buildPlayerConfig.ts:478-507, :882` (verdict, class and lab budget delivered to the viewer);
identity shared across viewer, poster and export via `computeConfigHash` in `podcast-saas/shared/src/sim/simIdentity.ts:136`.

---

# Rejected candidates

Each of these was considered seriously and did not survive. Grouped by why.

## The big one: deterministic video export

**Rendering interactive content to video against a virtual clock.** This was the most promising
lead and it failed twice.

*First, the technique is the industry standard, matched almost part for part.* Replacing the
browser's notion of time — the date object, the high-resolution timer, the timeout and interval
functions, and the animation-frame callback — so that frame N is pinned to exactly N/fps, then
stepping frames faster or slower than real time, is what widely-used open-source capture libraries
have done for about a decade. Driving the browser's compositor explicitly, one frame at a time,
through the headless browser's frame-control interface is the documented approach and is what the
mainstream programmatic-video tools and several open-source capture wrappers do. Seeding the random
number generator so renders reproduce is a first-class, documented feature of the leading
programmatic video framework, which also pins the same specialised headless browser binary this
repo pins, for the same stated reason. A competent engineer researching "render a web animation to
video deterministically" finds this stack immediately.

*Second, and more important for the owner: the reproducibility guarantee is not established.* The
export is **not** a deterministic function of (package bytes, configuration, duration, frame rate).
Two host-dependent terms leak in: the number of virtual frames burned during the startup handshake
depends on real elapsed time, because the driver steps one virtual frame per polling iteration and
yields to the real event loop between them; and the compositor's clock is advanced by a pump that
fires on a real-time interval during page load, so a slower load shifts the compositor timeline
before capture begins. The test suite acknowledges the second one directly, asserting a six-frame
slack band rather than equality. There is exactly one run-to-run byte-identity assertion in the
repository; it is disabled by default, runs against a synthetic fixture, and covers only the
non-production backend. Nothing in production compares two runs. The honest statement of the
shipped guarantee is *"frame timing is independent of host load and the random stream is seeded"*,
which is real and valuable — but it is not *"the same package produces the same bytes"*.

**Running untrusted customer code with no network and no credentials.** Standard sandboxing. The
argv is genuinely strict — no network, read-only root filesystem, all capabilities dropped, no
new privileges, no environment variables, bind mounts for input and output — and the credential-
shaped-key sweep on the job spec is a nice touch. But this is textbook container hardening. Worth
noting for the owner: the file itself says it proves the arguments are correct and nothing more,
and both container components are marked as never having been verified inside an actual container.

**One injected frame-gate serving both live pause and deterministic export.** The most interesting
thing on the capture side, and it is true in the code: because the capture's clock is installed
before the page's own scripts, the pause/resume gate that the platform injects into every customer
package captures the *virtualised* animation-frame function as its "native" one — so the same
injected mechanism that lets the viewer freeze a simulation lets the exporter step it. That yields
a genuine property: export drives the content through the identical code path the viewer does, so
the two cannot diverge. Rejected because "install your shim at document start so everything
downstream sees it" is the standard technique that every tool in this space relies on; the
composition is a consequence of it rather than an addition to it. Also worth knowing: the test that
pins this uses a five-line stand-in for the gate, not the real gate's bytes; the test that
exercises the real gate is skipped unless an environment flag is set.

**Naming the package boundary rather than inferring it.** After an incident where staging the
entry file's directory dropped a sibling file the package needed, the fix was to parse the storage
key into a package root and stage the whole package with its layout preserved. Correct, well
reasoned, and obvious in hindsight — the labour was the incident, not the idea.

## Standard patterns wearing a local name

**Immutable revisions with an atomic pointer flip.** Stage every byte under a never-reused prefix,
verify, then make it live with one compare-and-set inside a transaction. This is immutable
publishing / blue-green deployment, applied to content. Textbook, and correctly done.

**Content-addressed cache keys covering everything that affects appearance.** Standard content
addressing. That the key folds in interface state, camera and aspect is thoroughness, not
invention.

**Separating configuration fields that force a rebuild from those that can be applied live.** A
real bug drove this — toggling a display option was re-minting the identity and therefore restarting
the physics simulation — and the fix is well built, with the partition held as data and made total
at the type level so a new field cannot be forgotten. But this is precisely the pattern
infrastructure-as-code tools have long used to mark which resource attributes force replacement
versus update in place. Same idea, different domain.

**A private message channel to a sandboxed frame.** Transferring one endpoint of a message channel
into an iframe so only its holder can speak the protocol — and so a navigated-away document
structurally cannot, because the port dies with it — is the documented, widely-blogged standard
pattern, recommended for exactly the stale-sender reason given here.

**Per-activation identities to defeat stale messages.** Generation and epoch tagging so an
acknowledgement about a past state cannot be applied to the present. Textbook. The six-axis
decomposition is unusually careful, and the observation that an iframe element's window reference
survives navigation is a good gotcha, but neither is inventive.

**Three-state capability flags (true / false / not-yet-known).** Tri-state optionality where
absence is its own case. Standard.

**Pure reducers for lifecycle so that illegal states are enumerable and testable.** Excellent
discipline and the reason Survivor 1 is provable at all. But state machines are a standard pattern,
and methodology is not mechanism.

**A section lifecycle contract replacing a single cleanup callback.** Standard component lifecycle
design — the observation that one teardown hook cannot express suspend, quiesce, release-memory and
prove-first-frame is correct and ordinary.

## Standard control and scheduling

**Predictive residency under a hard budget.** Deciding ahead of time which packages to keep warm,
per-package rather than per-section, with eviction rules. This is preloading plus a warm pool; the
field does exactly this, including predicting future needs from usage traces.

**Adaptive quality with hysteresis.** Asymmetric thresholds — quick to protect a struggling device,
slow to re-expand a recovering one — is textbook control design, and adaptive-quality managers in
the 3D-on-web space are documented as using hysteresis for exactly the stated anti-oscillation
reason.

**Closed-loop budget refinement from field telemetry, with hostile-input guards.** Minimum sample
counts, implausible-magnitude rejection, truncated-feed rejection, bounded step from the lab
number. All correct, all standard telemetry hygiene for an unauthenticated ingest endpoint.

**Bootstrapping a cold-start estimate from a lab measurement, then refining with field data.** The
standard approach to cold-start estimation. The subtlety that the lab and field numbers must span
the same steps to be comparable is a good catch and still obvious once stated.

**Not judging a device against a standard derived from that device's own population.** A genuinely
nice bug — comparing a device's 90th percentile against a budget that *is* the fleet's 90th
percentile times a constant is a tautology that pins every device to its current tier. Rejected:
this is a fixed defect, and "do not compare a signal against a reference derived from that same
signal" is basic control-loop hygiene.

**A page-wide lease so only one simulation does real work at a time.** A priority mutex with a
broker. Standard.

**Detecting section boundaries from presented video frames instead of the coarse progress event.**
Documented use of the frame callback, and the module honestly notes it only moves detection earlier
and fixes nothing downstream.

## Correct, careful, and ordinary

**Verifying that a storage key is really inside an immutable revision by checking the database
rather than trusting the path shape.** A good catch — customer packages can contain a directory
that mimics the system's own path grammar, and getting it wrong means serving mutable bytes with a
one-year immutable cache header. Rejected: "do not infer trust from a user-controllable path" is a
well-known class of defect.

**Feature-detecting a browser capability floor, per package rather than per browser.** Explicitly
the documented best practice (detect the feature, never sniff the user-agent), plus the sensible
refinement of only penalising packages that actually need the feature.

**A manifest whose hashes are of the final stored bytes, after every rewrite and injection.** A
build-integrity manifest. The insight that hashing a pre-transform version proves nothing while
looking exactly like proof is well put and well known.

**Crash-safe write ordering for the substitute images** (bytes before rows on write, rows before
bytes on delete, so any crash leaves the invisible failure rather than the visible one). Standard
ordering discipline for a two-store write.

**The release gate and migration audit.** Severity-classified findings that block a deploy, a
persisted release state machine so an interrupted run can say where it stopped, and static
classification of SQL statements as destructive / lock-risk / backwards-incompatible against the
previous image. This is ordinary continuous-delivery discipline plus a schema-migration linter;
several mature open-source linters classify migration statements this way. Well executed and not
novel. The audit-and-refuse structure specifically is the standard quality-gate shape: no green
run, no deploy.

**Various bug fixes with good write-ups**, each rejected as a fix rather than an invention:
tracking an outstanding suspend as an explicit debt rather than asking a state machine a question
it is designed not to answer; identifying an eviction victim by object instance rather than by key
so a re-entry cannot be destroyed by a queued removal; rewriting section identifiers in place when
a project is duplicated so a copied package still dispatches; centralising an eviction guard that
three of five call sites had been missing.

---

# What would strengthen a filing

For the two survivors only, and only things that are genuinely under-specified, undocumented or
untested today.

### Survivor 1 — the reveal invariant

1. **Close the gap between the documented invariant and the enforced one.** The invariant's
   "executable form" is currently a test-only auditor. The guarantee is in fact enforced
   structurally, which is stronger — but the description and the artefact should match, because an
   attorney reading the header will believe a runtime guard exists. Either promote the check to the
   production path or restate the enforcement as what it is: an unreachability property of the
   state machine.

2. **Make the exhaustive test as exhaustive as it claims.** It walks 120 combinations and asserts
   the invariant after every step, which is substantial. But one axis is held constant, one is
   cycled rather than crossed, and event ordering is a fixed template. Permuting order and crossing
   the remaining axes would let the claim "no sequence of events can produce a reveal without
   matching evidence" be made without qualification. That sentence is the whole asset.

3. **Fix the evidence-label integrity hole.** When the frame callback fires without its timecode
   metadata, the observation falls back to the element's own clock but is *still labelled* as the
   strong evidence kind — so it is stamped high-confidence and skips the weaker evidence's
   admissibility checks entirely. No test covers that branch. This directly undermines the central
   claim that only verified evidence can authorise a reveal.

4. **Make the confidence label durable.** Today it reaches only an in-page debug array behind a URL
   flag and is never transmitted. There is consequently no evidence, anywhere, about how often the
   system relies on the weaker proof — which is exactly the measurement that would demonstrate the
   mechanism works in the field rather than only in tests.

5. **Reconcile the dead branches.** The transition coordinator's substitute-image cover cannot occur
   at runtime (the availability flag is hard-coded off on every handoff and the corresponding event
   is dispatched from nowhere), and the presentation policy's rule about mounting hidden content
   behind an opaque, decoded cover is unreachable on the exit path. Both are exercised by tests.
   Describing a mechanism that does not execute is the single most damaging thing that can happen to
   a filing.

### Survivor 2 — the certification-as-permission coupling

1. **Pin the correspondence between the captured substitute and the live frame.** This is the
   heart of the entry and, as far as I can tell, nothing tests it. The claim is that the picture
   captured during certification is what the live frame would have shown. A test that renders the
   same identity live and compares it against the stored substitute — perceptually, not
   byte-wise — would convert the entry's central assertion from a design intention into a
   demonstrated property.

2. **Run the certification on more than one engine.** The publish guard currently accepts
   single-engine evidence while the configuration defaults to one browser engine, so a package can
   be certified as fully capable on the strength of one engine's behaviour. A cross-engine
   requirement would materially strengthen the claim that the permission means what it says.

3. **Record the protocol versions the certification observed.** Every revision currently records
   both protocol version numbers as zero, so the stored evidence cannot say which protocol the
   package actually demonstrated. That is a data-integrity gap in exactly the record the runtime
   permission is derived from.

4. **Close the substitute-image invalidation path.** Substitutes are never invalidated or swept on
   the production publication path, so a republished package can retain a picture captured from
   different bytes. Since the entry rests on the substitute *provably* corresponding to the live
   frame, a stale one is a direct counter-example to the claim.

5. **Document the identity as a single named thing.** One fingerprint currently serves as the
   reveal gate's comparison, the substitute image's cache key, the certification case identity, and
   the random seed for video export. That unification is real and verifiable in the code, and it is
   the reason the three subsystems cannot drift — but it is nowhere stated as a design property, and
   it is the sort of cross-cutting fact an attorney would want stated plainly.

---

*Method note: candidates were surveyed from the subsystem map produced by the 62-agent audit of
2026-08-15, from a scan for long explanatory comments (709 blocks of six lines or more across the
simulation, export, viewer and release subsystems — in this repository those comments reliably mark
where something was learned the hard way), and from the six leads supplied with this run. Field
research was conducted in the vocabulary of the field — headless rendering, deterministic capture,
frame-presented callbacks, sandboxed embedding, adaptive quality, reproducible builds — and
deliberately favoured engineering blogs, open-source projects, product documentation and standards
material, since those are the better evidence of what a skilled engineer would consider obvious.
Two subsystem specialists were dispatched with narrow verification questions; their findings are
reflected above, including where they contradicted the code's own comments.*
