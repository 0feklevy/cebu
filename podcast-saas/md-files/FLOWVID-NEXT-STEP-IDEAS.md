# FlowVid — Next Step Ideas

**Date:** 2026-08-20
**Basis:** six independent idea sweeps (interactive video, assessment, creator experience, distribution, AI/agentic, wildcard), each re-grounded against the actual tree, plus a completeness pass that found the categories nobody looked at. Three further sweeps — customer acquisition (PLG + B2B), strategic expansion, and niche expansion — live in the companion volume `FLOWVID-EXPANSION-AND-GTM-IDEAS.md`.
**Ground truth:** everything below was checked against `origin/main` @ `6c7f9bb`. The local working tree is on `feat/library-share-minisite` @ `2d187e3`, **118 commits behind**. Anything built from the local tree silently reverts 14 merged PRs including the storage-leak fixes and the security-004 media-token fix. **Branch from `origin/main`.** Next free migration number is `065`, and `library_shares` (the in-flight mini-site) is expected to claim it — coordinate before you take a number.

---

## What FlowVid is uniquely positioned to own

FlowVid sits in a gap that currently has nobody in it. On one side are interactive-video products — Wirewax/Vimeo, H5P, Kaltura, Eko — whose "interactivity" is inert overlays on recorded pixels: a hotspot is a link that moves, a quiz is a form on top of a frame. On the other side are explorable-explanation authors — Ciechanowski, Nicky Case, Distill, PhET — who have a genuinely live program but no narration, no timeline, no pipeline, and no way to publish at volume. FlowVid is the only stack that has both halves wired together: a narrated, segmented, branchable video timeline *and* a real running simulation program in a sandboxed iframe, pinned to an immutable content-hashed revision, with a generated bridge that drives it, a guidance layer that narrates it from its own source, a presentation policy that refuses to reveal an unproven frame, and an export path that can flatten the whole thing to a linear master. Nothing else in the category ships a live program to the learner. That is the moat, and almost every idea in this document is an argument about how to spend it.

The honest corollary, which several of the sweeps had to learn the hard way: **FlowVid does not generate video lessons from text.** The v1 text→script pipeline is archived (`backend-api/src/_archive/v1-podcast-pipeline/`), `/new` redirects to `/`, and `corpora.extracted_md` has no live consumer in the video path. A FlowVid lesson today is *an uploaded or recorded video, cut into `timeline_sections`, some of which carry generated interactive simulations, exported and shared.* Every idea that assumed a script generator is dead or has been rewritten. Every idea that treats the **simulation** as the artifact is cheap, native, and mostly half-built already.

---

## Start here — the top 12

Ranked on (learning impact × wow) ÷ effort, adjusted for strategic fit and for how much each one unblocks.

| # | Idea | Why it wins | Effort | First step |
|---|------|-------------|--------|------------|
| 1 | **Read the Sim** | One ~30-line addition to the rAF gate lets the platform read live simulation values. It is the single dependency under Ask-the-Simulation, Live Readout, the accessibility live region, parameter-space analytics, and half of every assessment idea. And because entry HTML is rewritten at **serve** time (`injectSimBootSnippet`, `no-cache`), it reaches **every already-published package** with zero re-processing. | S | Add a `readSimState` branch to `RAF_GATE_TEMPLATE`, inject it from `sim-public.controller.ts`, open an untouched deployed sim, confirm it reports live slider values. |
| 2 | **Takes — one-click rollback** | `RevisionService.rollback()`, `listRevisions()` and `rollbackTargetFor` are fully implemented, tested and GC-aware, and are exposed by **zero controllers and zero UI**. Today Generate is irreversible, so creators hesitate before every regeneration — the exact opposite of what an iteration product needs. Two thin endpoints. | M | Add `GET .../revisions` and `POST .../revisions/:id/activate`, roll one real regeneration back from curl, confirm the editor serves the restored revision. |
| 3 | **Set the Knob → Keep the Knob** | The write channel: put a value *into* a running simulation, and stop throwing away the viewer's slider changes on resume. `resumeFromSim` currently calls `stopNow()` specifically so the learner's changes are discarded "by design" — that comment is the feature request. `SimPresentationConfig.initialState` already exists as a config-hash axis and is classified STRUCTURAL. The slot was designed; nothing fills it. Six other ideas are consumers. | M | Hand-patch one stored entry HTML's gate with a `readSimControls` handler, log the payload on `userInteraction`. If real sliders come back with meaningful values in an hour, the family is proven. |
| 4 | **Goal State** | Assessment that cannot be guessed and that no screencast platform can fake: "split the flock into two stable groups", judged by the simulation itself. The engine exists twice over — `GuidanceService` already compiles author-approved predicates over live sim state, and `triggerMatches` → `selectEdge` already routes sim messages to branches end to end. You are re-pointing two shipped systems at each other. | M | Hand-edit one published `guidance.js` so a `config` predicate posts `{type:'goalReached'}`, add one `branch_edges` row with that trigger, set `auto_script=false`. Zero new code. |
| 5 | **Export transparency** | Migration 061 already returns `current_phase`, `current_section_label`, `capture_stage`, `frames_done/total`, `degraded_windows` — and `ExportProgressPanel.tsx` renders none of it. A paused progress bar is perceived worse than any other pacing behaviour (Harrison, UIST 2007), and this product has the worst version of it. The hard part is merged; the rest is a rendering change. | S | Render `current_section_label` and `frames_done/frames_total` from fields the poll already returns; watch them move during one real capture. |
| 6 | **Playable Link** | A cold visitor's first screen should be the thing FlowVid is best at, already running and already touchable — not a poster and a play button. `useProjectPlayer` already computes `simFirst`, already boots packages into hidden frames, already pauses video on touch, and `SET_UI_POLICY` already ships. This is a default, not a system. | S | Behind a flag on one share link: suppress autoplay, reveal the hero sim with Minimal-UI applied, start video only on explicit play. Watch five strangers. |
| 7 | **Behind a Flag** | `admin-web/app/feature-flags/` exists and **not one of 60+ ideas mentioned it**. Almost everything here modifies a 4,198-line viewer hook with a documented history of wrong-frame incidents, or an export path that fails closed. Per-project targeting plus a one-click revert is what converts every "now" on this list from a gamble into a rollout. | S | Gate one shipped behaviour behind the existing flag end to end, turn it off in production, confirm the viewer changes within a page load. |
| 8 | **Cost of Goods** | A dozen ideas in this sweep are blocked on a sentence like "this is a billing decision before it is a UX one" — and none can be settled because the number does not exist. `token_usage` is half-instrumented; ElevenLabs characters, Anam minutes, GPU capture minutes and storage bytes are entirely dark. You cannot price a plan, approve a per-viewer LLM feature, or tell a lossy customer from a profitable one. | M | Meter the two unmetered vendors only — `GuidanceTTSService` and `anamService` — and run for a week. |
| 9 | **Segment Cache** | The repo's own throughput notes already name this as the unspent lever: "no clip cache — clips key on `exportId` although `configHash` is already computed in `exportPlan.ts:264-285`." The second export is almost always a 5% change to a 100% render, and the expensive part is GPU capture (~27 s per 10 s window). Makes a re-export after a typo fix nearly free. | M | No schema, no storage: log the would-be cache key per sim window across three exports and confirm it is stable across two and differs for exactly the republished one. |
| 10 | **Hand Over the Controls** | Worked-example fading is one of the most reliable results in instructional design, nobody in interactive video does it, and the first version needs **no migration, no endpoint, no backend change** — the fade is a client-side subtraction from the `hideSelectors` list the player already passes into every sim start. | S | At `useProjectPlayer.ts:1915`, drop the last selector from `ui_hide` when localStorage says this section was seen once. Reload three times, watch controls appear. |
| 11 | **Sneakernet Bundle** | The offline dependency-vendoring machinery — the part the strategist called "the one genuinely new piece of engineering" — is **already written, hash-pinned and tested** on `origin/main`: `offlinePackage.ts` + `vendor/sim-deps/registry.json`. A downloadable lesson that runs with no internet costs zero bandwidth, zero render, zero CDN to serve, and opens the Kolibri/PhET distribution world. | M | 40-line script: `parseSimPackageKey` → `fetchPackageFiles` → `prepareOfflinePackage` → zip → unzip → open with the network off. |
| 12 | **The Paperwork** | Zero hits across the entire repo for privacy policy, GDPR, FERPA, COPPA, DPA or subprocessor. FlowVid already mints a durable anonymous browser identity on public pages and writes per-session telemetry with no notice. No school district signs a SCORM package from a vendor with no privacy policy — so this, not Frame Pass, is the real gate on the institutional business, and it is mostly not engineering. | S (+ a lawyer) | Write the subprocessor list. Twenty minutes, first thing every buyer's questionnaire asks for, and it forces the retention question into the open. |

**Just below the line:** House Style (S — deterministic course art that replaces per-thumbnail `gpt-image-1` calls), Pocket Handoff (S — a QR that hands the lesson to a phone), Payouts and Audience (S — creators cannot currently see that they sold five videos), The Commit Bar (M — builds the `learner_responses` substrate five other ideas need).

### Do these this afternoon
Five things that are each under an hour and each fix something real:

1. **Rate-limit `POST /api/v1/avatar/start`.** It is the only *unlimited, anonymous, billable* endpoint in the product. One `rateLimit()` call, following `sim-rum.controller.ts:68`. Safety and cost fix in one line.
2. **Add `error.tsx` and `not-found.tsx`** to `client-web/app`. Today an exception on a public lesson page shows a Next.js default and a dead share link shows nothing designed — on a marketing surface.
3. **Add a viewport guard to the editor.** `VideoEditor.tsx` and `SectionEditor.tsx` have zero touch handlers; `TimelinePanel.tsx` has one pointer handler in 2,293 lines. An iPad gets a pointer-captured scrubber that pointer events never reach, silently. Say "this needs a wider screen" instead.
4. **Render the branch-analytics panel.** `GET /api/v1/projects/:id/branch/analytics` already computes `edgeChoiceCounts` per edge, owner-only, working, with **zero frontend consumers anywhere**. A day of work turns a live endpoint into "61% of your viewers chose X".
5. **Write the subprocessor list** (Firebase, Supabase, Stripe, Anthropic/OpenAI/Google, ElevenLabs, Groq, Anam, Cloudflare/R2).

---

## The GTM companion — top picks from the acquisition & expansion sweeps

Three further sweeps (customer acquisition PLG + B2B, strategic expansion with validation paths, niche/ecosystem expansion — 105 ideas, merged and deduplicated against this document) live in **`FLOWVID-EXPANSION-AND-GTM-IDEAS.md`**, alongside an 11K-character strategy memo with three ranked 4-week bets. Its top 10, ranked on (acquisition or strategic impact) ÷ effort:

| # | Idea | One line | Effort |
|---|------|----------|--------|
| 1 | **Comprehension Delta Engine** | Correctness flag on `branch_edges` + pre/post quiz checks + one SQL join = the interaction→comprehension number nobody else can produce; instruments every pilot. | M (MVP: days) |
| 2 | **Attested Understanding** | Compliance evidence-by-doing (quarantine the simulated phish) sold into budgeted KnowBe4/Staffbase lines; trigger-edge capture ships today, only viewer identity is missing. | M |
| 3 | **"Made with FlowVid" badge** | Zero attribution exists on any shared surface — every share is a wasted impression; always-on v1 needs no plan model. | S |
| 4 | **FlowVid MCP server** | The empty "agent-built lesson with a verified working sim" slot; canary/bridge-contract verdicts are exactly the error shape agents self-correct against. | M |
| 5 | **Embeddable player + oEmbed (`/embed`)** | The embed is the demo and the keystone under SCORM/white-label/fintech; `'embed'` is already reserved in `RESERVED_SLUGS`. | S–M |
| 6 | **Vertical fake-door mini-sites** | Four door courses on the shipped course/SEO rails with a pre-registered threshold let behavior — not opinion — pick the wedge vertical. | S |
| 7 | **Pilot-in-a-box / design-partner program** | `/trust` page + seeded sandbox + paid time-boxed charter + forwardable report = several concurrent pilots survivable for one person. | S |
| 8 | **Hand-over-the-keys presales demos** | Consensus/Navattic charge $500–1,250/mo for half the mechanic; `auto_script` + the interaction-hold IS the fusion, shipping today. | M |
| 9 | **State-Aware Narration** | Narration that reacts to what the viewer just did — the demo nobody else can make, assembled from shipped trigger/guidance/TTS parts. | M |
| 10 | **OpenSim Package Spec v1** | Publish the sim package format (the spec prose already exists as doc comments in `shared/src/sim`) and set the standard the way H5P did. | M |

---

## Already in flight — do not duplicate

`md-files/LIBRARY-SHARE-MINISITE-PLAN.md` is an active, decided design. Its spine: a new `library_shares` table whose slug is `slugify(title) + '-' + 13-char code`, rendered by an ISR Server Component at `app/[slug]/library` — a static child of the existing `[slug]` segment, so no top-level route is claimed. Zero bucket objects; one ~250-byte Postgres row per shared project; every media URL re-emitted from existing keys the way `buildPlayerConfig` already does. P1 is 6–8 days with 12 named tests including a whole-JSON leak assertion.

Decisions already made there that constrain ideas in this document:

- **No live sim previews in the grid, no minted posters** — there is no valid poster identity for a library card. Gradient tiles instead. (This is why *Motion Poster* dies and why *Paper Trail* must not assume stills.)
- **`/library` stays `noindex`** — an explicit robots Disallow. *The Commons* silently reverses this decision; if you want it, argue it to the owner on its own terms.
- **Revocation cannot recall material URLs.** Supabase public URLs are permanent and untokened; `/sim-public` is unauthenticated by design. This is dialog copy, not a footnote — and it bounds what *Remix Lineage* and *Frame Pass* can promise.
- **No CSP change needed and none permitted** for the mini-site: sim iframes work because the page is on the app origin, already in `frame-src` and in `/sim-public`'s `frame-ancestors browserOrigins()`. *Frame Pass* is the idea that changes this, and it must be argued separately.
- **A real gap it found:** `SimSurface` has no `allow` prop, so a full-screen sim cannot go fullscreen; fixing it requires the same change to `AdminSimSurface` because `passiveSimSurfaces.test.tsx` pins DOM parity. Several ideas here want fullscreen sims — inherit that fix, do not re-derive it.
- **Where to extend rather than reinvent:** `library_shares` is the sharing primitive to build on. *Pocket Handoff*, *Paper Trail*, *Frame Pass* and *Playable Link* should all target it rather than minting new share concepts, and `projects.share_token` (22 chars, no expiry, no rotation, no scoping) should not be extended further.

---

# The catalogue

Grouped by theme, not by the lens that produced it. Duplicates across lenses have been merged. Ideas the feasibility pass killed are named in the rejected appendix with the one-line reason, so you know they were considered.

Two facts govern almost everything in Theme 1 and are worth stating once:

- **The rAF gate is baked into stored entry HTML at UPLOAD time** (`injectRafGate` inside `processFiles`), so a new *gate version* reaches only republished packages. **But `SIM_BOOT_SNIPPET` is injected at SERVE time** by `sim-public.controller.ts`, and entry HTML is deliberately `no-cache, must-revalidate` — so anything you can put in the boot snippet reaches **every already-published revision immediately**. That distinction is the difference between a one-day feature and a fleet migration. Prefer serve-time.
- **Every new per-package capability must be three-state** — `true` proven / `false` proven-not / `null` unknown — exactly like `bridge_ack_capable` (migration 055) and `requires_import_maps` (057), or like `shared/src/sim/bridgeCapability.ts`. Collapsing `null` into a boolean is the mistake that module exists to prevent.

---

## Theme 1 — Make the simulation controllable

The product's central asset is a live program the platform can currently neither read nor write. Two channels fix that, and nine features fall out of them.

### 1.1 Read the Sim
**What it is.** A `readSimState` message the platform can send to any running simulation, answered with `{selector, value}` for every control the gate already inventories — plus, later, named observables for derived quantities.

**Why it's good.** It is the single cheapest unlock on the entire list. The rAF gate (`RAF_GATE_VERSION` 4, `SimulationService.ts` ~325–620) already walks the **live DOM** and returns every `button/input/select/textarea/[role=slider]` with a stable unambiguous selector, a kind and a human label — `SectionEditor.tsx:1269-1292` already consumes it. It returns no *values*, and that gap is roughly thirty lines of ES5 in a template that already exists. Reading `.value` costs nothing per view, involves no model, writes no bytes, and is the prerequisite under an AI tutor that can see what the learner sees, a live numeric readout, a screen-reader live region, parameter-space analytics, and the outcome half of every prediction feature. The decisive detail: put it in the **serve-time** boot snippet, not the upload-time gate, and it lands on every package already in production.

**How it would work here.** Add a `readSimState` branch to the existing message listener in `RAF_GATE_TEMPLATE` (`backend-api/src/services/simulation/SimulationService.ts`), answering `{selector, value}` for the selectors `listSimControls` already resolves (`backend-api/src/services/simulation/SimUiControls.ts`, mirrored client-side in `client-web/lib/simUiControls.ts`). Inject via `injectSimBootSnippet` in `backend-api/src/controllers/sim-public.controller.ts`. Route the reply through `client-web/lib/sim/SimRuntimeClient.ts`, whose per-frame listener already scopes every event by `e.source` so a background pool frame cannot drive it. Constraints: the child runtime is written in ES5 with no arrow functions, `const`/`let`, optional chaining or template literals, because some uploaded sims parse in quirks mode and a syntax error is a dead package with no error message. Its only harness is `backend-api/src/services/simulation/__tests__/rafGate.test.ts`.

**Effort.** S.

**First step.** Add the branch, inject at serve time, open an untouched deployed simulation in the editor preview, confirm it reports live slider values. If serve-time injection works on an already-published revision, five features are unblocked in a day.

---

### 1.2 Set the Knob
**What it is.** The write half: a validated message that sets a control inside a running simulation and dispatches the events the sim's own listeners expect.

**Why it's good.** Six separate ideas — Keep the Knob, What-If Ribbon, Counterfactual, Conduct, Two Worlds, and the seeding half of every share-a-parameter-set feature — all reduce to "put a value into a stored package," and today there is no wire representation for it at all. The complete parent→child set in `shared/src/sim/runtimeProtocol.ts` is INIT / SUSPEND / RESUME / DISPOSE_DOCUMENT, SET_AUDIBLE, SET_QUALITY, PREPARE / PRESENT / ACTIVATE / RELEASE_SECTION, PAUSE / RESUME_AUTOMATION, SET_UI_POLICY, SET_AUTOMATION_POLICY. **Nothing sets a knob.** Meanwhile `SimPresentationConfig.initialState` already exists in `shared/src/sim/simIdentity.ts`, is documented as "author-set initial camera/simulation state", is folded into `computeConfigHash`, and is already classified STRUCTURAL in `simPolicy.ts`. The plumbing for parameterising a simulation was designed and never filled. Build this once, as its own item, and decide the gate-vs-protocol question once instead of six times.

**How it would work here.** Two candidate layers, and the choice is the actual design decision. (a) **Gate**: `setSimControls` beside `listSimControls` — assign `.value`/`.checked`, then dispatch `input` + `change`; works on anything with real form controls, no per-sim API, but writing and dispatching is a *guess* about the sim's event wiring, so it needs a proven / proven-not signal, not an assumption. (b) **Protocol**: a new activation-scoped `SET_CONTROL {selector, value}` envelope in `shared/src/sim/runtimeProtocol.ts` plus a bridge function — cleaner, but bumps `SIM_CHILD_RUNTIME_VERSION` and means rebuilding every stored `bridge.js` (the drill already has tooling: `backend-api/src/scripts/rebuild-sim-bridges.ts`, `verify-sim-rebuild.ts`, `prove-sim-rebuild.ts`). Either way: reuse the validated selector charset (`SIM_UI_UNSAFE_SELECTOR_RE`, `SimUiControlSchema`, kept in sync across four sites), validate every proposed write server-side against the stored control list from `GET /api/v1/projects/:id/simulations/:simId/ui-controls` or `sim_meta.uiControls`, and add a three-state capability column so a package that cannot be driven says so.

**Effort.** M (gate route) / L (protocol route).

**First step.** Take the cheap route first: add `setSimControls` to the gate behind a flag, drive one slider on the deployed boids-3d package from the parent frame, and check whether the sim actually reacts or absorbs it. That single result decides gate-vs-protocol for all six consumers.

---

### 1.3 Keep the Knob
**What it is.** When a viewer moves a slider inside a simulation and presses resume, carry their setting into the next simulation section instead of discarding it — and have the caption acknowledge it: "you set cohesion to 0.8, so here's what 200 generations of that looks like."

**Why it's good.** The premise is verified rather than assumed: `resumeFromSim` in `useProjectPlayer.ts:4159` calls `rt.stopNow()` **specifically** so the identical `startScript` is not deduped, because "the user's manual changes (sliders etc.) are discarded on 'resume video', by design." That comment is the feature request. Inverting it is the difference between a viewer being an audience for someone else's example and watching the consequences of their own — the single most direct expression of what FlowVid has that nothing else does. It is also the smallest possible consumer of 1.1 + 1.2, so it is the right thing to build immediately after them.

**How it would work here.** Snapshot on the `userInteraction` → `videoRef.pause()` branch of the message handler (`client-web/components/viewer/useProjectPlayer.ts:3284`), hold it in a ref, replay it in `resumeFromSim` (`:4159`) after the deliberate `stopNow()`. Carry it forward by populating `SimPresentationConfig.initialState` (`shared/src/sim/simIdentity.ts`) and extending `SimStartParams` in `client-web/lib/sim/protocol.ts` — noting that file explicitly says the current wire protocol is not to be extended toward the activation-scoped redesign, so which protocol it lands in is a call to make. The narration acknowledgement is caption text only, through the existing guidance queue (`enqueueGuidance`, `useProjectPlayer.ts:1364`) — guidance TTS audio is minted at publish time and cannot say a runtime number.

**Effort.** M.

**First step.** On one seeded local sim, hand-patch the stored entry HTML with a `readSimControls` handler that posts back `{selector: el.value}`, and log the payload on `userInteraction`. If a real package's sliders come back with meaningful values in under an hour, this and half of Theme 1 are proven. If the interesting state is not in form controls, you have killed four ideas for the price of an afternoon.

---

### 1.4 What-If Ribbon
**What it is.** At the end of a narrated simulation beat, a slim ribbon: "Run that again with gravity ×2" / "…with predators off." One tap rewinds to the start of the beat and replays the identical narration over a differently-seeded simulation, then shows a badge comparing outcomes.

**Why it's good.** The second viewing is where learning happens and nobody rewatches a video — this gives rewinding a reason and controls the comparison so exactly one variable moved. It also converts FlowVid's biggest content cost into leverage: narration is reused verbatim, only the simulation's inputs change, so no new voice, no new render, no capture run. Mechanically it is close: `rt.activate({script, params})` on an already-resident frame is exactly what `resumeFromSim` does today, with no teardown and no reboot, and because `initialState` is already an identity axis, two seedings are already two distinct presentations with two distinct config hashes.

**How it would work here.** A `variants: [{label, params}]` field on `timeline_sections` — cleanest folded into the existing `sim_meta` jsonb (migration 013, already accepted on section PATCH at `sections.controller.ts:227`, already copied verbatim by project duplication). Surface as a ribbon in `client-web/components/viewer/SimPoolOverlay.tsx` or as a fourth layer in `SimPresentationLayers.tsx`. Selecting a variant seeks back via the player's own `issueSeek`/`loadSegment` and re-activates the resident frame with `initialState` merged in. **Strike one claim from the pitch:** the outcome badge needs the simulation to report a number at run end, and no shipped package reports anything but lifecycle acks — so v1 compares nothing and just re-runs. Note also that `initialState` is STRUCTURAL under `simPolicy.ts`, so a variant tap pays the whole prepare/apply/reveal cost and `presentationPolicy` will correctly refuse to show the frame until it is proven.

**Effort.** M (hard-depends on 1.2).

**First step.** Hard-code two variants for one seeded section behind a dev flag, and on tap call `rt.activate()` with different `params` on the resident frame while seeking back. **Measure how long the frame stays covered** — if a re-seed costs a multi-second blank under `presentationPolicy`, the ribbon is a worse experience than the rewind it replaces.

---

### 1.5 Counterfactual — the ghost run
**What it is.** Mid-lesson, the learner drags the timeline back four seconds, nudges one parameter, and lets it run again — while the original run stays on screen as a translucent ghost, so both futures are visible at once.

**Why it's good.** This is the most differentiated single interaction available to FlowVid, and half of it is already on screen: touching a live sim pauses the video and the automation, the learner perturbs the system, and resume restarts the section. What is missing is the *comparison* — the learner can change the world but cannot see the counterfactual beside it, so perturbation reads as fiddling rather than as an experiment. "What if the damping were lower?" stops being a sentence in a script and becomes a gesture the learner performs.

**How it would work here.** Depends entirely on 1.2. Two corrections to the obvious design: (a) "rewind needs no snapshotting because the run is deterministic" is **false in the browser** — `backend-api/src/services/export/capture/injection.ts` never ships client-side, so a rewind is a section re-activation from frame 0 with the new value, not a replay, and any sim whose init reads `Date.now` or `Math.random` will not reproduce. (b) The ghost as literally specified is the expensive part: `SimPresentationLayers.tsx` stacks layers but the pool caps at 4 documents and `md-files/SIMULATION-VIDEO-PIPELINE-DEEP-AUDIT.md` measures one live heavy sim as the honest budget (boids `_frame()` p50 18.1 ms at 720p on an M1). **A cheaper honest ghost:** sample one scalar observable via 1.1 and plot the previous run's trace over the live one with chart.js, already a client dependency.

**Effort.** XL (L if you accept the trace-ghost instead of two live contexts).

**First step.** Ship the trace-ghost, not the second WebGL context. One observable, two runs, one overlaid line.

---

### 1.6 Look Around — camera during narration
**What it is.** During a 3D simulation section the viewer can orbit, pan and zoom while narration keeps playing — no pause, no interruption — with a "back to the director's shot" control before the next beat.

**Why it's good.** The instant a viewer wants to see the other side of the thing, a video says no, and that is the exact moment attention is lost. The reusable half is small and well-placed: the `userInteraction` → pause behaviour is **one branch in one message handler**, so adding an interaction class that deliberately does *not* pause is easy to build and easy to reason about — and that class is useful far beyond cameras. `initialState` being documented as "author-set initial camera state" shows camera was anticipated as an identity axis before anything used it.

**How it would work here.** Advertise a `camera` capability on `SIM_READY` alongside the existing `dispatch` and `policy` advertisements (`client-web/lib/sim/protocol.ts`) — absence means unknown means the affordance never appears. Add a `cameraOnly` message type the handler at `useProjectPlayer.ts:3284` explicitly does not treat as `userInteraction`. At the section boundary, post a `resetCamera` before the exit fade begins — the deferred-stop window (`SIM_EXIT_STOP_MS` 280 ms, deliberately longer than `SIM_FADE_MS`) is exactly the slot where a package can restore state while covered. **Do not** try to interpolate inside `client-web/lib/sim/transitionCoordinator.ts`; it is a phase machine over frame evidence and cover kinds and has no concept of scene state. Honest limits: no published simulation exposes a camera API, `SimBridgeContract` cannot verify one exists (it is a regex existence check over bridge text), only 3D packages benefit, and nothing identifies which packages are 3D — so the audience is unmeasurable today. Also: a viewer-moved camera has no poster and never will, because posters are identity-keyed with deliberately no fallback.

**Effort.** L.

**First step.** Add the `cameraOnly` class alone and make the handler not pause on it, then hand-patch one 3D package to post it on drag. The interaction class is the reusable half regardless of whether cameras ever ship.

---

### 1.7 Scrub the Simulation
**What it is.** Make the simulation a function of the video's time: drag back ten seconds and the flock un-flocks.

**Why it's good.** There is a real correctness bug underneath it, and it is worth naming honestly: the player has a full pointer-captured scrubber (`useProjectPlayer.ts:3810`), and scrubbing back into a simulation section re-runs `updateSimOverlay` but **does not rewind the simulation** — so narration from 0:30 plays over simulation state from 1:30. That is a defect a learner experiences as "this is out of sync," and today nobody knows how often it happens.

**How it would work here.** Correcting the tempting framing: `client-web/lib/sim/boundaryClock.ts` is **not** a continuous time source — it is a one-shot boundary sentinel with a 0.35 s arming horizon, bounded to 120 re-arms, whose own header states `timeupdate` remains the master clock and that rVFC does not fire while paused. Scrubbing is a paused activity, so a frame-true clock is unavailable in exactly the state the feature lives in. The reachable version is not "the sim is a pure function of t" but **"the sim re-activates from the nearest authored checkpoint"** — 1.4 with a scrubber attached, modelled with `initialState` and `computeConfigHash` so a checkpoint is a distinct presentation identity `presentationPolicy` can cover until proven. True per-frame seeking would additionally need a `SIM_SEEK` in `protocol.ts`, a three-state capability column, and — the actual cost — a published authoring contract requiring fixed-dt deterministic replay, enforced at canary time the way `package_class` is. No package is deterministic today and nothing asks it to be.

**Effort.** XL (S for the instrumentation).

**First step.** Instrument the existing scrubber: when a scrub lands inside a simulation section, log the section, the media time and the sim's current activation. That proves or disproves the mismatch in an hour and tells you how often real viewers hit it — which decides whether this is a correctness fix worth an XL or a theoretical complaint.

---

### 1.8 Two Worlds
**What it is.** Two instances of the same simulation side by side on one clock: the canonical run the narration describes, and the viewer's parameters.

**Why it's good.** Sensitivity is genuinely the hardest thing to teach from one run, and the identity half checks out — `configHash` already folds `initialState`, so two seedings are already two legitimate presentation identities the pool can hold separately, and `client-web/lib/sim/poolResidency.ts` already implements tiered residency with a hard cap and a victim-selection rule that spares fading frames.

**How it would work here.** Grant a second pool lease keyed on `{package_revision, configHash: viewerParams}` and render a 2-up arrangement above `client-web/lib/sim/SimSurface.tsx`, which is presentation-only and deliberately does not own lifecycle. **Affordability cannot come from `sim_lab_budget_ms`** — that is a publish-time canary measurement of one package on a lab machine, and `labStandardMs` returns `null` (never a fallback, never a floor) for any package never canaried, which is most of them, because the only producer is a manual Playwright script run with `--apply`. Use the device signals the pool tier already buckets in `shared/src/sim/rumEvents.ts` (`RumDeviceProfile`: `deviceMemory`, `hardwareConcurrency`, coarse pointer, `saveData`) plus a measured first-frame rate, degrading to a fast A/B flip on **one** frame rather than two live contexts. The pipeline docs measure ~6.7 fps for a single heavy sim under 6× CPU throttle with "one live heavy sim at a time" stated as the honest budget: this is a real capability on strong desktops and a broken one on the phones that are most of the audience.

**Effort.** L.

**First step.** Mount two `SimSurface` frames of the same seeded package in a throwaway dev route and measure frame rate on a mid-range phone with CPU throttled. If the pair cannot hold a usable rate on the majority device class, you have saved an L.

---

### 1.9 Conduct — the classroom
**What it is.** A teacher opens a published lesson in conduct mode and gets a room code. Thirty students join; the teacher's parameter changes drive every student's simulation; the teacher can hand the controls to one student; and student predictions appear live as dots on the teacher's screen.

**Why it's good.** The market read is the sharpest in the whole sweep — schools buy class periods, not videos, and a live shared simulation is a structurally better classroom object than a slide plus a poll. It would also change who buys: a cohort trainer per seat rather than a creator per render.

**How it would work here.** Honestly: this is the largest infrastructure ask on the list landing on the thinnest infrastructure. `SET_UI_POLICY` and `SET_AUTOMATION_POLICY` are genuinely shipped (the modern bridge implements `_onUiPolicy`/`_onAutoPolicy` and answers `POLICY_APPLIED` or `POLICY_REFUSED` with an explicit "never-started" refusal; `SimRuntimeClient.ts:2117-2123` already posts them), so a teacher can broadcast chrome and automation state today. But there is no parameter envelope (1.2), and there is **no realtime tier of any kind**: no WebSocket, no socket.io, no yjs, no Redis (`deploy/docker-compose.yml` has no cache service; the queue is pg-boss on Supabase). SSE exists (`client-web/lib/sse-client.ts`) but is one-way and used only for generation streams. `sim_rum_events` cannot carry student responses — no `project_id`, no `section_id`, no `user_id`, and a session id documented as unlinkable across visits by design. And the public viewer has no learner identity at all, so "thirty students join" means inventing enrolment, rosters and consent. Prerequisites: 1.2, Teams (7.4), a realtime service, and a consent model.

**Effort.** XL.

**First step.** Do not build the room. Give one teacher a share link plus a second screen with the *existing* `SET_UI_POLICY` / `SET_AUTOMATION_POLICY` toggles, run a real class period, and record which missing capability they actually name — "sync everyone" or "let me change the number." If it is the latter, Conduct is a follow-on to 1.2 and should be re-scoped as one.

---

## Theme 2 — Assessment a video cannot fake

One structural fact governs this whole theme and was mis-assumed by three separate sweeps, so it is stated once here:

> **A choice point cannot fire mid-lesson.** `branch_choice_points` belongs to a SEQUENCE, only the first per sequence is used (`buildPlayerConfig.ts:720`), and it reveals during the last `lead_in_sec` of that sequence's FINAL SEGMENT (`useProjectPlayer.ts:2726-2737`). Sequences are sets of whole `video_files` (`buildPlayerConfig.ts:737`), not time ranges. **"Pause at 4:12" is not expressible** — you get one question per sequence, at a clip boundary. The escape hatch that *does* exist: a simulation section already pauses the timeline and hands the learner the screen with a back-to-video control (`useProjectPlayer.ts:1949-1956`). That is the real interruption primitive, and it is a better one, because it is interactive.

Second fact: **there is no `learner_responses`, `quiz`, or progress table anywhere.** (`branch_edges.dest_quiz_id`'s own schema comment says "quiz table is Phase 4".) No duplication risk, but no substrate either — exactly one idea in this theme has to build it, and 2.3 is the cheapest place to put it.

### 2.1 Goal State
*(merges "Won't Continue Until" and "Goal State" — same mechanism, same first step, written twice)*

**What it is.** A checkpoint that does not ask a question. It hands the learner the live simulation and a goal — "get the population to stabilise above 400 without changing the birth rate" — and the video does not continue until the simulation itself reports the goal met. Hints escalate in the narrator's voice if they stall.

**Why it's good.** A goal in a live system tests whether someone can *operate* a concept, which no multiple-choice item reaches, and it cannot be guessed. Partial credit becomes real: the system can see they got the shape right but overshot. What makes it credible rather than aspirational is that the engine exists twice over and nobody has pointed the halves at each other. `GuidanceService` already accepts `{kind:'config', predicateBody, observables, debounce}`, re-scans the body against 16 `PREDICATE_BANS` (no `window.`/`document.`/`eval`/`fetch`/timers/`postMessage`), compiles with `new Function('S', body)`, warns when no observable is grounded in the sim's real element ids or `window.X =` assignments, and bakes it into `guidance.js` where it is polled at 150 ms against a read-only `S` accessor (`S.num`, `S.global`, `S.allEqual`, `S.fracTrue`, `S.count`). That is a pass predicate, already built, already validated, already human-reviewed in the editor. And the other half — sim message → branch navigation — is live end to end: `schema.ts:1069` stores `trigger_event`/`trigger_match`, `branch.controller.ts:379` writes them, `buildPlayerConfig.ts:817` emits them, and `useProjectPlayer.ts:3175` matches **every** iframe postMessage against the current sequence's edges via `triggerMatches` and calls `selectEdge`. Every simulation with a published guidance layer becomes assessable.

**How it would work here.** Add `kind: 'goal'` to `backend-api/src/services/simulation/GuidanceService.ts`: same schema, same validator, but `_fire` posts `{type:'goalReached', id}` instead of `{type:'guidanceCue', ...}`. Nothing else on the message path changes. Two real gaps: (1) `client-web/components/branching/BranchingModal.tsx` has no input for `trigger_event`/`trigger_match` — it exposes layout, behavior and `lead_in_sec` only — so add one text field plus an optional `{key, op, value}` row; (2) the config poll is gated OFF while `auto_script` runs (`_autoScript` in the generated `guidance.js`), so a goal section must set `timeline_sections.auto_script = false`. Authoring reuses the shipped SSE flow (`GET /api/v1/projects/:id/simulations/:simId/generate-guidance/stream` and `.../publish-guidance/stream`) with the review UI already in `SectionEditor.tsx:236-244`. Hints ride the existing queue (`enqueueGuidance`, `MIN_GUIDANCE_GAP_MS`) escalating on a dwell timer.

**Watch out for.** `_fired` makes every entry one-shot per document and `_COOLDOWN = 10000` throttles **all** fires globally — fine for one goal, fatal for scored retries, which need a separate re-arm message. A goal predicate is baked into `guidance.js` at publish time under a per-simulation lock, so **goals belong to a SIMULATION, not to a learner and not to a section** — two sections sharing a sim share its goals. `pauseAutomation()` is a documented no-op on stored pre-v2.1 bridges, so on older packages the auto-demo keeps fighting the learner. And a gate that refuses to continue **must** have an escape hatch, or a wedged predicate strands the viewer forever; this codebase's own discipline (fail closed, bounded holds, `SIM_APPLY_STALL_MS`) says design the give-up path first.

**Effort.** M.

**First step.** Zero new code. On one seeded sim, hand-write a guidance entry whose `predicateBody` is a goal condition, hand-edit the generated `guidance.js` so `_fire` posts `{type:'goalReached', id}`, hand-insert one `branch_edges` row with `trigger_event = 'goalReached'` and a `dest_sequence_id`, and set `auto_script = false`. Load the lesson. It either navigates when you reach the goal or it does not, and you know in an afternoon whether this whole family is real.

---

### 2.2 Wrong in a Specific Way
*(merges "Wrong in a Specific Way" and "Wrong Answers With Names" — routing and distractor generation are one feature)*

**What it is.** Branching that routes on the *shape* of the error. A viewer who overshoots goes to the clip about confusing rate with total; one who undershoots goes elsewhere; one who is close goes straight on. And when FlowVid generates a question, the distractors each embody a specific, *named* misconception drawn from the source, stored alongside the option.

**Why it's good.** This is the difference between a quiz that measures and a quiz that teaches: a diagnostic wrong answer tells you what a learner believes *instead*. It is also the cheapest real capability on the list, because three of its four parts already ship and one ships with no UI on top of it at all. `triggerMatches` (`useProjectPlayer.ts:259`) implements `gte/lte/gt/lt/eq` today and `cp.edges.find(...)` gives first-match-wins ordering — so **ordering edges narrowest-band-first produces banding with zero runtime change**. `ChoiceOverlay.tsx` already has a `layout: 'quiz'` path with lettered A/B/C answers. And the creator-facing payoff already exists as a live endpoint nobody calls: `GET /api/v1/projects/:id/branch/analytics` returns `edgeChoiceCounts` per edge — literally "61% of your viewers chose X" — with zero frontend consumers anywhere in `client-web`. Misconception frequency becomes a `GROUP BY` on day one.

**How it would work here.** (1) A band editor per edge in `client-web/components/branching/BranchingModal.tsx` writing `{key, op, value}`, edges ordered narrowest-first; add a `between` op to `triggerMatches` as a small pure change. The backend zod schema at `backend-api/src/controllers/v1/branch.controller.ts:51` already accepts and persists `trigger_event`/`trigger_match` — the type in `client-web/components/viewer/types.ts:186` is annotated "sim-triggered edges (later phase)" and that annotation is out of date. (2) `misconception_key` + `misconception_note` on `branch_edges`, and — unavoidably — a `correct` boolean, which the branch model completely lacks: without it a misconception tag records what was picked but never that it was wrong. One migration plus its rollback plus an entry in the hardcoded array in `backend-api/src/db/migrate.ts:66` (CI's migration-audit compares the directory against that runner *and* against the previous release tag). (3) Authoring: a new `complex`-tier `TaskType` running `sendStructured` over `resolveLessonContent(projectId).transcript` emitting `{question, correct, distractors[{text, misconception_key, why_tempting}]}` — note `TaskType` (`LLMProvider.ts:3`) is a **closed union** with a `Record<TaskType, Tier>` companion at `LLMService.ts:54`, so every new pass is a two-file typecheck-breaking edit. (4) Reporting: rewrite the analytics endpoint first — it currently does an unbounded `findMany` over every `branch_path_events` row for a project and aggregates in JS against a 10-connection pool (`branch.controller.ts:494`).

**Watch out for.** Sim-driven banding needs the simulation to post a number; nothing does yet (that is 2.1 + 1.1). The multiple-choice half has no such dependency and should ship alone first. Remediation via `destination_type: 'sequence'` requires a real sequence made of real `video_files` — there is no inline-beat primitive, and `'back'` returns to the *decision*, not to where the learner was. One choice point per sequence means one diagnostic question per clip boundary; a lesson that is a single uploaded video gets exactly one.

**Effort.** S (MCQ routing) → M (with generation and reporting).

**First step.** Author a quiz choice point by hand in the DB with three edges whose `trigger_match` bands are ordered narrowest-first, drive it from a page that posts a matching message, and confirm `triggerMatches` + `edges.find` routes correctly with **no code change**. Separately, run one `complex`-tier `sendStructured` call over a real transcript asking for named distractors and have a subject expert read them — if they are plausible-but-generic rather than diagnostic, the moat claim is false and the rest is not worth building.

---

### 2.3 The Commit Bar — and the response substrate
**What it is.** Every question takes two inputs: an answer and how sure you are (guessing / fairly sure / certain). Confident-and-wrong is the most important event in the system — instead of a red X, the player rewinds to the second of narration that contradicts the learner and replays it. Confident-and-right skips the explanation.

**Why it's good.** Hypercorrection is one of the most replicated findings in memory research: the moment a learner is most wrong is the moment they are most teachable, and FlowVid throws that moment away entirely today. Practically, this is the idea worth building **first** in this theme — not because it is flashiest but because it forces the substrate into existence. Nothing in this repo stores a learner response of any kind, and 2.7, 2.8, 2.2 and every analytics idea need that table. The UI half is genuinely trivial: `ChoiceOverlay.tsx` is 73 lines and already renders a lettered quiz layout with a countdown.

**How it would work here.** Three parts. (1) **Confidence**: a three-notch control in `client-web/components/viewer/ChoiceOverlay.tsx` under the `layout === 'quiz'` branch, styled from the existing `.viewer-choice-quiz` rules in `client-web/components/viewer/viewer.css`; `client-web/__tests__/a11yOperableControls.test.tsx` requires a named, keyboard-operable control, not a click-only div. (2) **Storage**: one migration creating `learner_responses` keyed by `project_id`, the anonymous `session_id` already used by `branch_path_events`, `edge_id`, a confidence integer — and, critically, an `outcome_id` column from day one so 2.7 does not require a second migration. Write it through an optional-auth endpoint modelled on `POST /api/v1/projects/:id/branch/events` (`branch.controller.ts:458`) **but add the `rateLimit()` call that endpoint is missing** — see `backend-api/src/controllers/sim-rum.controller.ts:68` (20/60 s per IP) — because the pool max is 10 per container and there is no nginx `limit_req` anywhere. (3) **The rewind**: `useProjectPlayer` already owns seek across the segment timeline; the contradicting timecode is a cue start in `video_files.captions_vtt` (`backend-api/src/services/captions/CaptionService.ts`, DB is source of truth since migration 033) plus the segment's global offset, **stamped onto the edge at authoring time** so the player never parses VTT at runtime.

**Watch out for.** Do not source timings from `LessonContentService` (one flattened string, no timings) or from `scenes.start_ms`/`aligned_words` — those are legacy, written only under `backend-api/src/_archive/v1-podcast-pipeline/` and by `ProjectDuplicationService`. Confident-and-wrong is undetectable until `branch_edges` gains the `correct` flag from 2.2, so sequence them together.

**Effort.** M.

**First step.** Add the three-notch control to `ChoiceOverlay.tsx` and POST it to the **existing** `/branch/events` endpoint as an extra field it currently ignores — no migration, no new route. Watch real answers land in the network tab against a seeded branching project. That proves the overlay and the anonymous write path in an hour, and tells you whether a quiz at a sequence end even reads as a question.

---

### 2.4 Place Your Bet
*(merges "Place Your Bet" and "Predict the Sim")*

**What it is.** At an authored moment the video freezes and asks the viewer to commit to a prediction — drag the curve where you think it goes, drop a dot where the ball lands, set the slider to where it settles. Then playback resumes and the truth is revealed on top of the viewer's mark, which stays on screen.

**Why it's good.** Prediction-before-reveal is the best-evidenced single intervention you can make to an instructional video, and the evidence claim survives checking *with its mechanism intact*: the meta-analytic effect (g = 0.522, Interactive Learning Environments 2022) is contingent on the video **pausing** during the interaction, and FlowVid's `userInteraction` handler does exactly that — `videoRef.current?.pause()` plus stopping the HLS loaders, in one branch at `useProjectPlayer.ts:3284`. Being wrong out loud before the answer arrives is what makes the answer stick, and unlike the multiple-choice interaction H5P and YouTube ship, a drawn mark cannot be guessed. It also produces the most valuable data point in the system: what a learner believed **before** being told.

**How it would work here.** A prediction overlay mounted as a sibling layer in `client-web/components/viewer/SimPresentationLayers.tsx`, whose `simLayers.css` already establishes an isolated stacking context with per-layer `pointer-events` and a documented reduced-motion story. The trigger is an authored moment — a `behavior: 'pause'` choice point with a new `predict` layout — **not** a guidance cue, because cues are LLM-drafted per package with publish-time TTS and cannot carry an author's answer key. The commitment row goes in 2.3's `learner_responses`. Once 1.1 + 2.1 exist, a sim-side prediction becomes a target predicate plus near-miss predicates each posting `{type:'predictionCommitted', bucket:'over'|'under'|'hit'}`, matched by `triggerMatches`.

**Cut two claims from the pitch.** (a) The reveal **cannot be probed out of the simulation** — `SimBridgeContract` is a regex text-existence checker that proves an identifier still appears somewhere in a package's HTML/JS/CSS, and it only runs on Replace; it cannot tell you a member is callable, what it takes or what it returns. v1 is authored-answer only. (b) The four-real-future-frames variant is unavailable: `sim_posters` are keyed by `packageRevision__variantKey__configHash__aspect__quality` with an explicit **no-fallback** policy (`shared/src/sim/posterIdentity.ts`, `PosterService.ts`), the only producer is the manual `sim-canary-publish.ts --apply`, and they come in two fixed sizes.

**Watch out for.** A drag-to-draw surface has no keyboard equivalent by default and `a11yOperableControls.test.tsx` enforces reachability — the slider variant is the accessible fallback and must ship in the same change. Freeze semantics must be explicit: the sim's canvas is frozen but the rAF gate keeps its loop alive unless paused, or the truth reveals itself before the prediction is made. And near-miss buckets need N predicates each subject to the 150 ms poll, the 3-tick stability debounce, and the **global 10 s cooldown** that will swallow a second bucket firing within 10 s of the first.

**Effort.** M (slider) → L (drawing + sim-side buckets).

**First step.** Build the slider-only version behind a dev flag on one seeded section: a `behavior:'pause'` choice point rendering a value slider instead of cards, keeping the viewer's mark, drawing a hard-coded authored answer beside it on resume. One day, no protocol change, and it settles whether the pause-mark-reveal beat feels good before any canvas is written.

---

### 2.5 Cold Open
**What it is.** Every lesson opens with one hard question the learner almost certainly cannot answer yet — the hardest claim the lesson will make. They guess. Then the lesson runs, and at the end the same question comes back.

**Why it's good.** It is the only assessment idea here that **completely sidesteps the structural wall**: it renders before the player mounts and after it ends, so it never needs a mid-timeline pause, never touches `branch_choice_points`, and needs no learner identity because both halves happen in one session. Pretesting works even when learners get it wrong — the failure is the mechanism (Richland, Kornell & Kao 2009). And it is the cheapest genuine pre/post pair a buyer can be shown, from one authoring-time LLM call.

**How it would work here.** Authoring: one `LLMService.sendStructured` pass over `resolveLessonContent(projectId).transcript` (`backend-api/src/services/course/LessonContentService.ts`) emitting `{question, options[], correctIndex, why}` — a new member in the closed `TaskType` union (`LLMProvider.ts:3`) **and** a matching row in `TASK_TIER` (`LLMService.ts:54`), or typecheck fails. Store on the lesson (`course_lessons` already carries per-lesson overrides). Rendering: `client-web/app/c/[courseSlug]/[lessonSlug]/page.tsx` is a Server Component with `revalidate = 300` mounting `LessonPlayer` as a client island — add a sibling island that asks before the player is engaged, then unmounts. The end-of-lesson repeat hangs off the player's existing terminal path (`useProjectPlayer.ts:3026`). The question ships inside the ISR-cached view model from `PublicCourseQueryService`, so there is zero extra request on the hot path — and for the same reason it is identical for every viewer, which is fine here.

**Watch out for.** **Trim the mid-lesson "here's your answer" marker** — `timeline_markers` is an editor-only table that never reaches the viewer's `PlayerConfig`, so that beat is new viewer rendering, not a reuse. The pre-question sits between a learner and the video on a public SEO page: it must be a dismissible island over an already-rendered page, never a gate on the Server Component. A regenerated question must be added to `computeInvalidationTargets` in `PublishingInvalidationService.ts` or it will not appear for up to 300 s plus a purge. And only lessons with a real transcript qualify — `resolveLessonContent` requires 120+ chars and returns `hasMeaningfulText: false` otherwise.

**Effort.** S.

**First step.** Hardcode one question object for one seeded lesson directly in `[lessonSlug]/page.tsx`, render it as a client island above `LessonPlayer` with a commit button, and show it again on a "you finished" panel. No LLM, no migration, no endpoint. Watch two people take it — you learn in an hour whether a pre-question on a public video page reads as intriguing or as a paywall.

---

### 2.6 Hand Over the Controls
**What it is.** The first time a learner meets a simulation, the narration drives it and every control is locked. On the next encounter, one control unlocks and the learner does that step themselves. Then two. By the fourth encounter the learner is driving and the system just states a goal.

**Why it's good.** Worked-example fading (Renkl, Atkinson & Merrill) is one of the most reliable results in instructional design, nobody in interactive video does progressive control handover, and it directly answers "learners just watch the sim happen." It is also the only idea in the entire sweep that needs **no migration, no endpoint and no backend change** for a first version: the fade schedule is a client-side subtraction from a selector list the player already passes into the sim on every start.

**How it would work here.** `timeline_sections` carries `simple_ui`, `auto_script` (default TRUE) and `sim_meta.uiControls.hide`. `buildPlayerConfig.ts:521` projects that list as `ui_hide` via `uiHideFromMeta` (`:890` — there is no `ui_hide` *column*), and `client-web/components/viewer/useProjectPlayer.ts:1915` passes it verbatim as `startScript.params.hideSelectors` (`SimStartParams`, `client-web/lib/sim/protocol.ts:71`). Because the pass-through is client-side, a per-encounter schedule is a change at that one line: read an encounter counter from localStorage keyed by the existing `avatar_anon_id` (`client-web/components/avatar/hooks/useConversationMemory.ts:8`, a durable crypto UUID already keying `avatar_profiles`) plus the section id, and subtract the first N selectors in a stable order. **No `PlayerConfig` change** — which matters, because the public lesson config is ISR-cached at 300 s and cannot vary per viewer. The handover *order* should be authored, not guessed: `backend-api/src/services/simulation/SimUiControls.ts` already produces a validated control inventory with kinds and human labels, so a difficulty rank is one extra field in the existing `sim_meta` shape.

**Watch out for.** Flipping `auto_script` off on a later encounter desynchronises the narration from the simulation — the stored script is what makes the sim do what the voiceover describes. **Fade controls first**; only flip `auto_script` on a section authored to tolerate it. `hideSelectors` is honoured only by rebuilt bridges and the mechanical hide path only engages while `simple_ui` is on. Encounter count is browser-local: a cleared browser or a second device silently restarts the learner at encounter 1. Honest caveat on impact: FlowVid ships almost no multi-encounter courses today, so the fade will mostly be observed across repeat views of one lesson until courses get longer — the ratings assume a course depth that does not yet exist.

**Effort.** S.

**First step.** Hardcode a two-step fade for one section at `useProjectPlayer.ts:1915`. Reload three times and watch controls appear. If the sim stays sane with narration running, it is real; if the narration immediately contradicts what the learner can now touch, it is not.

---

### 2.7 The Outcome Ledger
*(absorbs "Second Sitting" spacing and "The Mixed Set" interleaving as scheduling policy, not separate systems)*

**What it is.** Turn `courses.learning_outcomes` from a JSON array that exists to make the landing page look good into the spine of the product: every question, prediction, goal task and explain-back tagged to one outcome, with the learner seeing where they stand on each and every bar clickable through to the evidence.

**Why it's good.** This is the artifact a buyer pays for. A course that can say what a learner can now *do* is worth several times one that can say they watched 47 minutes, and making the model inspectable is separately evidenced by the open-learner-model literature (Bull & Kay). Identity is in better shape than assumed: `localStorage['avatar_anon_id']` is a durable crypto UUID already used as the key for cross-session avatar memory, with an HMAC capability token (`backend-api/src/services/avatar/memoryToken.ts`, bound to `{projectKey, sessionKey}`, 12 h TTL) authorising the anonymous write — so "you did this twice, three days apart" works today on one browser.

**How it would work here.** (1) Promote outcomes to rows: a `course_outcomes` table with stable ids plus a backfill from the existing `learning_outcomes` jsonb, whose only constraint today is `outcomesArrayChk` (a `jsonb_typeof` check — no shape, no ids, frequently null). (2) Every assessment row carries `outcome_id` — which is why 2.3 must include the column from day one. (3) Estimation as a **pure module with fixtures**: a decayed, confidence-weighted proportion-correct with an explicit evidence count. The whole point is inspectability, and this workspace has been burned by logic living somewhere unmutatable. (4) Rendering: `client-web/app/c/[courseSlug]/page.tsx` is a Server Component with `revalidate = 300` fed by `PublicCourseQueryService`, so per-learner state **cannot** be in the SSR view model — it must be a client island on a new uncached anonymous endpoint with an explicit `Cache-Control`, a `rateLimit()` guard and a query budget against a pool of 10. (5) **Scheduling policy, not a system:** spacing (review the handful of claims that are due at the start of the next lesson) and interleaving ("never group items from the same lesson; order confusable outcomes adjacently") are a comparator and a due-date field on the item pool this ledger owns. Do not build a second scheduler; `ts-fsrs` is not a dependency and installing one must clear the frozen-install release gate for a scheduler with nothing to schedule.

**Watch out for.** **There is nothing to display until at least two producers ship.** Build the evidence producers first and the ledger becomes a reporting layer; build it first and it is an empty page with a migration behind it. Identity is browser-local: clearing storage or switching devices silently resets a learner to zero and the page has no way to explain that. And the public `/c/` pages hardcode `text-black/50` and `text-[var(--fg,#111)]` rather than the HSL token set — a panel copied from them will be broken in dark mode.

**Effort.** L.

**First step.** Do not migrate anything. Write the estimator as a pure function — `(responses[], now) => {outcomeId, estimate, evidenceCount}[]` — with fixtures for zero evidence, one confident-correct, and a correct-after-wrong pair, and render its output as a static mock panel on one seeded course page using the real design tokens. Show it to someone. If the bars are not obviously more persuasive than "you watched 47 minutes," the commercial claim is wrong before any schema moves.

---

### 2.8 Teach It Back
**What it is.** After a lesson the avatar appears — as a slightly confused fellow student, not a teacher. "I didn't really get the bit about feedback loops, can you explain it to me?" The learner explains out loud, and the avatar asks the one follow-up that targets what the explanation left out.

**Why it's good.** Self-explanation (Bisra et al. 2018, g = 0.55) and the protégé effect stack, and FlowVid is the rare product that already ships a real-time conversational avatar on the **public** lesson page — `LessonPlayer.tsx:36-38` mounts `AskAvatarButton` + `AvatarPopup` for every anonymous viewer of a published lesson. Two things make it more feasible than assumed: `anamService` mints session tokens with a full, server-controlled ephemeral `personaConfig` including a system-prompt override, so a "confused peer" is a prompt swap rather than a new vendor persona; and `origin/main`'s `avatarBudget.ts` + `AvatarBudgetService.ts` (migration 064) is a durable, cross-replica, weighted, day-salted-HMAC cost meter with a kill switch built specifically for billable anonymous endpoints.

**How it would work here.** (a) A new character in `backend-api/src/services/avatar/characters.ts` — today all four are historical figures (einstein/darwin/napoleon/archimedes) with system prompts; the peer needs PS2-Pal-style constraints: ask one thing at a time, never supply the explanation, admit confusion rather than correcting. (b) Feed it `resolveLessonContent(projectId).transcript`, noting this is one flattened string, so "the 3–5 load-bearing points" is a separate authoring-time extraction, not a free read. (c) Diagnosis writes into `avatar_profiles.facts`, exactly how `memoryService.extractAndSaveFacts` already works, authorised by the existing HMAC capability token. (d) **Every new call must be metered through `backend-api/src/services/usage/avatarBudget.ts` with its own weight**, or it is an unmetered billable anonymous endpoint — precisely the finding migration 064 exists to fix.

**Watch out for.** Cost. `/avatar/start` reserves the **worst-case** vendor session length up front and never releases it early, because the server cannot trust `/avatar/end`. Offering a session to every anonymous lesson-finisher is by a wide margin the most expensive per-viewer feature on this list — which is why it sits behind 7.1 (Cost of Goods). All existing personas are historical figures with distinctive voices; a neutral confused peer is new persona/voice configuration on the Anam side, not just a prompt string. And the diagnosis has nowhere to go until 2.7 exists.

**Effort.** L.

**First step.** Add one `CharacterConfig` with the confused-peer prompt and a hardcoded one-paragraph lesson summary, open the existing `AvatarPopup` against it on a seeded lesson, and try explaining something to it out loud. If it corrects you instead of staying confused, or the follow-up is generic, **the prompt constraints ARE the project** — learned in an hour for the price of one session.

---

### 2.9 The Mayer Lint
**What it is.** A checker that flags places where narration and visuals fight each other — a simulation event twelve seconds after the sentence describing it, a charming aside that teaches nothing, a four-minute stretch with no moment where the learner does anything. Reported as clickable timecodes in the editor.

**Why it's good.** FlowVid's quality ceiling is set at authoring time and nothing in the pipeline currently knows anything about multimedia learning, so this is the cheapest way to raise the floor on lessons nobody reviews. Be honest about how many checks are computable, though: **segmenting and temporal contiguity are; coherence is (as a cheap LLM pass); redundancy is not.** There is no OCR anywhere, `image_files` has no label or alt column (only filename), and `timeline_markers` are creator notes that never reach a viewer. Two-and-a-half rules of four — still worth having, but not the sales sentence "checked against Mayer's principles."

**How it would work here.** A **pure module** in `backend-api/src/services/` with real fixtures and no source-text scanning, per this workspace's own hard-won rule (a source-text test let four viewer regressions ship). *Segmenting*: walk `timeline_sections` ordered by `sort_order` on `track = 'main'` and flag any gap over N seconds containing no simulation section, no choice point and no guidance cue. *Temporal contiguity*: compare a section's `start_sec` against the offset of the caption cue naming it, from `video_files.captions_vtt` (`CaptionService.ts`) — the only reliable timing source now that `scenes.start_ms` and `aligned_words` are legacy. *Coherence*: one utility-tier `sendStructured` pass scoring each caption paragraph against `courses.learning_outcomes`, degrading cleanly when it is null, which it usually is. *Redundancy*: cut, or narrow to sim control **labels**, which `scanSimUiControls` already extracts with `prettifyIdentifier`. Surface in `client-web/components/TimelinePanel.tsx` next to the existing markers UI.

**Watch out for.** Backend coverage is measured only over `src/services/**`, so a lint module scores well on the metric while its controller wiring stays invisible — pin the rules with real fixtures, not with the coverage number. It improves nothing a learner experiences until an author acts on it: it is a floor-raiser, not a feature, and should not compete with the assessment substrate for the same sprint.

**Effort.** M.

**First step.** Write the segmenting rule alone as a pure function over `{start_sec, end_sec, type}[]` plus a list of interactive moments, with four hand-built fixtures (dense / one long gap / all-sim / empty). Run it against three real seeded projects. If it flags nothing on lessons a human would call too passive, the whole rule family is mistuned — learned for one afternoon and no schema change.

---

## Theme 3 — Know what learners actually do

Three sweeps independently proposed a per-second interaction heatmap and all three were blocked on the same missing stream. They are one program, in this order. One correction that applies to all of them: **`sim_rum_events` cannot carry this.** It is a rendering-performance table — exactly three kinds (`transition | residency | failure`), stage timings and coarse device buckets, **no `project_id`, no `section_id`, no `user_id`** — with a session id documented as random per page load and non-persisted *specifically so it cannot link two visits*, and a sample rate that normalises to 0 through three fail-closed layers because "the failure mode of a bad config must be collect nothing." Riding it means reversing a privacy posture that is written down as a design decision. Copy its *shape*, not its table.

### 3.1 The panel for the analytics you already have
**What it is.** A distribution panel in the editor over the endpoint that already exists: choices per edge, sequence entries, sessions, completions.

**Why it's good.** `GET /api/v1/projects/:id/branch/analytics` (`branch.controller.ts:525`) is owner-only, working, and has **zero frontend consumers anywhere in `client-web`**. There is a shipped analytics backend waiting for a UI. It ships in a day, needs no migration and no ingest, and answers the entire premise of Theme 3 cheaply: do creators change anything after seeing the distribution? If they do not, the expensive telemetry stream is unfunded.

**How it would work here.** Render `edgeChoiceCounts` and `sequenceEnterCounts` in the editor next to the branching UI. **Rewrite the endpoint first**: it currently loads every `branch_path_events` row for a project into memory and aggregates in JS (`branch.controller.ts:494`) — replace with a single `GROUP BY`. That query is also the honest floor of what this feature can show today, and seeing how thin it looks is itself the decision input for 3.2.

**Effort.** S.

**First step.** Write the aggregate SQL (sessions, per-edge choice counts, completion rate) and paste the output for one real project into a text file.

---

### 3.2 The learner signal stream
*(merges "Struggle Signals", "Attention Map" and "Where They Get Lost" — one table, one ingest, one privacy decision, three read surfaces)*

**What it is.** Capture the behaviours that mean someone is drowning — rewinding the same eight seconds twice, scrubbing back and forth, pausing on a simulation without touching it, a long delay before the first click — and draw them on the editor timeline as heat lanes, with the named misconception that fired at each second.

**Why it's good.** It is the only idea in the whole sweep that **compounds**: it improves the content permanently for everyone who ever watches it, rather than one session for one learner. Cognitive load is a property of the learner, not the content, so static segmenting is guaranteed to be wrong for most people — and the behavioural signals really are already flowing through the player and being thrown away. `useProjectPlayer` already owns seek, pause, section transitions, choice handling and the sim bridge's first-interaction message.

**How it would work here.** Build the **signal** half and treat adaptation as a separate later decision. Copy the shape of `client-web/lib/sim/rumClient.ts` and `shared/src/sim/rumEvents.ts` exactly: a sampling roll returning a **no-op recorder** so no branch in the player behaves differently when measurement is off, a bounded ring buffer (`RUM_RING_CAP` 200, `RUM_MAX_EVENTS_PER_BATCH` 500), `sendBeacon` first with `fetch(keepalive)` fallback, and terminal-quiet failure — any throw disables collection for the session. Feed it from `useProjectPlayer.ts` (seek deltas, pause dwell, `userInteraction` arrival time at `:3146`, section transitions). Receive it with a controller modelled on `backend-api/src/controllers/sim-rum.controller.ts`, whose own comment names the stakes ("a connection pool of ten is a small target") and which is one of only three surfaces with an anonymous `rateLimit(...ip, 20, 60_000)` guard — **mandatory, not optional**. Store as a `learner_signal_events` sibling (`project_id`, `section_id`, `media_time`, event kind, random per-load session id, coarse device buckets, `t_ms` offsets rather than wall-clock). Extend `branch_path_events` in the same migration with `media_time` and the widened `event_type`, since today it records only `sequence_enter | choice | complete` and **nothing can say where in a lesson anything happened**. Render heat lanes in `client-web/components/TimelinePanel.tsx` alongside `timeline_markers` (migration 041).

**Watch out for.** The **response** half is structurally blocked: "insert a recap" and "skip the aside" both mean editing the timeline mid-playback, which the branching model cannot do (see the Theme 2 preamble). Ship read-only. The auto-repair loop some versions of this were sold on does not exist: current lessons are uploaded video, narration audio is not regenerable, and there is no TTS re-render path for an uploaded clip — the propose step can suggest a script edit for a human to re-record, nothing more. An anonymous per-view write path repeats the pattern already flagged in the share controller (unbounded fire-and-forget `view_count + 1` per hit); batch or roll up, do not add another naked UPDATE. And a per-learner struggle profile keyed to `avatar_anon_id` is a different and far more sensitive thing than anonymous aggregates — that needs 7.5 (The Paperwork) first.

**Effort.** L.

**First step.** Instrument **one** signal — seek-backwards count per section — through the existing sim-rum endpoint's shape with a hardcoded 100% sample rate on a seeded project, and print the counts. Watch three people go through a real lesson. If the rewinds cluster where you would have predicted, the signal is worth a stream; if they scatter, you have saved an L.

---

### 3.3 Explored Space
**What it is.** Report not how much of the video someone watched, but **which regions of the simulation's parameter space they visited** — "eleven never tried a negative value; four found the tipping point inside a minute; the rest never left the default."

**Why it's good.** This is evidence shaped like understanding, and it is a thing only FlowVid can produce, because only FlowVid ships a running program that already exposes its own state. It is also the read surface that makes 1.1 pay for itself twice. Ship the **author-facing, anonymous, aggregate** version first: "which explanation fails, at which parameter, for how many people" is a question the company needs answered right now and needs no identity model at all. The per-student teacher dashboard is the same data plus enrolment and consent, and should not gate the useful half.

**How it would work here.** Declare a small set of **observables** per section alongside the guidance entries — `GuidanceService`'s injected layer already polls a read-only sim-state API (`S.el/S.val/S.num/S.text/S.checked/S.global/S.flat/S.allEqual/S.fracTrue/S.count`) inside every guidance-published package. Sample them on the existing poll, ship **coarse buckets** through 3.2's client discipline into the same table, and draw the heatmap with chart.js (already a client dependency). xAPI/Caliper emission is a separable later layer once enrolment exists — and it is what makes this enterprise-sellable, so keep the event shape compatible.

**Watch out for.** Only packages that have been through guidance generation carry the `S` layer, so coverage is partial and there is no observable-declaration format yet. `DOMAIN_EVENT` is defined in the protocol and consumed at `SimRuntimeClient.ts:1403` but **no shipped bridge produces it** — do not design around it.

**Effort.** M.

**First step.** Prove the observable, not the dashboard. Add one declared observable to a single guidance-published section, sample it on the existing poll, and log coarse buckets to the console for one real play-through. If the values describe where the learner went in parameter space, the table and the heatmap are routine.

---

## Theme 4 — The creator's day

The editor is where the product is used most and reviewed least. Three of these are already-built capabilities with no UI.

### 4.1 Takes — versions and one-click rollback
**What it is.** Every regeneration becomes a numbered version you can go back to. A simulation's history is listed, one click restores any previous version, nothing you generate is ever destroyed.

**Why it's good.** Today Generate publishes a new revision and retires the previous one **with no way back**, so creators hesitate before every regeneration — the wrong instinct for a product whose value is fast iteration. And the remarkable thing is how close it already is: `RevisionService` implements the full state machine (draft → uploading → validating → canary_passed → active → retired/rolled_back), a compare-and-set pointer flip backed by the cluster-wide partial unique index `uniq_sim_revisions_active`, verified read-back-and-rehash of stored bytes, `rollbackTargetFor` ordered by **activation time** rather than revision number, and a GC with a keep floor. Grep the controllers and the client for `rollback` and you get comments only. The safety property creators most want is built, tested, swept, and unreachable. This is the largest confidence change available in the product and it is two thin endpoints away.

**How it would work here.** Expose `GET /api/v1/projects/:id/simulations/:simId/revisions` over the existing `listRevisions()`, and `POST .../revisions/:revisionId/activate` over the existing `rollback()`, both owner-gated like the other simulation routes (`backend-api/src/controllers/v1/simulations.controller.ts`). The editor gets a Versions list per simulation showing `revision_number`, `activated_at`, `package_class` and `manifest_hash`; restoring flips the pointer in one statement and `simulationUrlResolver` picks it up on the next read, with `withServedSimulationUrls` keeping the stored `timeline_sections.simulation_url` byte-identical as it must. Where a revision has a matching poster the list shows it; where it does not, **the list says so** — `posterFor` has no cross-identity fallback by design and inventing one would be a lie.

**Watch out for.** Do **not** build side-by-side live comparison: `client-web/lib/simPool.ts` sets `EDITOR_SIM_RESIDENT_CAP = 1` with the written rationale that "a second timeline document plus the preview is three WebGL contexts on a machine that is also decoding video and rendering a timeline" (`SIM_POOL_CAP = 4` is the *viewer's* and is "deliberately not ported"). The comparison surface is a version list with stills. `revisionGcSweep` runs `gc()` every 6 hours with a `GC_MIN_KEEP` floor, so visible history is bounded and the UI must say so rather than offering a revision whose bytes are gone (the service already guards activation; the UI must not offer it). And `'canary_passed'` does **not** prove a canary ran — check `canary_report`/`canary_at`, because a version list implying verification it does not have is worse than none. Script takes are out of scope: `scripts.version` belongs to the archived pipeline and the live per-section text (`sim_script`, `sim_prompt`) has no history at all.

**Effort.** M.

**First step.** Add the two endpoints, roll one real regeneration back from a curl, and confirm the editor's next editor-state read serves the restored revision. No UI yet.

---

### 4.2 Export transparency
*(merges "Glass Kitchen" and "Draft Cut" — both start with rendering data the poll already returns)*

**What it is.** Replace every spinner with an honest live view: which phase, which section by name, how far into that section's frames, how many windows were substituted — and stream real generated text while a simulation is being written, instead of an ellipsis that grows.

**Why it's good.** Harrison et al. (UIST 2007) found a paused progress bar is perceived worse than any other pacing behaviour, and this product has the worst version of it: a simulation capture is minutes long and the old `objects_done` counter sat still for all of it. Migration 061's own header states the problem exactly — the counter was incremented **before** each window, so a project reported "3 of 4 done" while the third had not started, and if the run then failed the user had been told it was nearly finished. That is fixed on the server and not on the client. `GET /api/v1/projects/:id/export` already returns `current_phase`, `phase_done/total`, `current_section_id`, `current_section_label`, `capture_stage`, `frames_done/total`, `degraded_windows`, `retryable` and `degraded_retry_available`, and `ExportProgressPanel.tsx` + `useProjectExport.ts` are byte-identical on main to their pre-061 versions. This is the rare idea where the hard part is already merged.

**How it would work here.** Thread the fields through `client-web/lib/useProjectExport.ts` into `client-web/components/ExportProgressPanel.tsx`, keeping its existing rule 8 (indeterminate rather than a fake 0%) as the honesty floor and rule 2 (warnings verbatim, including on success). **Respect rule 7** — fixed header and action row, only the warning list scrolls — that was a production incident where consent looked unanswerable, and `floatingPanelViewportClamp`/`exportPanelViewport` tests will catch a regression. Second: `sections.controller.ts`'s SSE already emits `status`/`token`/`done` with a 12 s stall-aware heartbeat reporting elapsed seconds during a silent thinking phase, and `SectionEditor` renders `token` by **appending an ellipsis to a status string** — showing the real streamed text is a change in one dispatch branch. Third: `GET /api/v1/projects/:id/export/preview` already answers "what would this export do" — which sections would be replaced by stills — with no row, no job and no charge, and nothing renders it.

**On Draft Cut specifically.** Before building a `profile: 'draft'`, measure: on `origin/main` with `LINEAR_EXPORT_ENABLED=true` and `EXPORT_CAPTURE_IMAGE` unset (which already produces an all-poster-fallback export), time one real export of a sim-heavy project end to end. If it is already under a minute, Draft Cut is a button label and a watermark, not a feature. If it is worth building, two structural costs are real and were mis-guessed: `EXPORT_GRID` is a module const (1920×1080@30) **frozen into the plan for auditability** and consumed by `resolvePlan`'s frame snapping, `ffmpegGraph`'s normalisation chain and `assertMasterGates`, so a lower-resolution draft is a change in four places; and `uniq_project_exports_inflight` (migration 058) permits exactly **one** in-flight export per project, so a draft queuing alongside a master needs `profile` added to that partial index's predicate. Also note posters exist only for canaried packages, so a draft cut of a sim-heavy project shows the base video or black, not stills.

**Cut from the pitch.** Per-stage cost is **not** a read — the only token/cost columns belong to the archived podcast pipeline, and the named stages "corpus, structure, draft, validate" do not exist in this product. A per-workspace p50 ETA needs a duration history table that does not exist, and with one GPU worker and `QUEUE_EXPORT_CONCURRENCY=1` queue wait is a bigger term than stage duration. Cut speculative prefetch entirely: generation costs money and is governed by `RateLimitService` token budgets and a platform `generation_paused` flag, so it is a billing decision, not a UX one.

**Effort.** S (progress + SSE text + preview) / M (draft profile).

**First step.** Render `current_section_label` and `frames_done / frames_total` from fields the poll already returns, and watch them move during one real capture. If they do, ship it that day; if they do not, you have found a server bug that matters more than the panel.

---

### 4.3 Segment Cache
**What it is.** Never capture the same simulation twice. Each sim window already has a complete content identity; cache the captured frames under it and reuse them on the next export.

**Why it's good.** The second export is almost always a five-percent change to a hundred-percent render, and the expensive part is unambiguous: GPU capture of simulation windows, ~27 s per 10 s window on the T4 orchestrator, against a per-section wall clock that is the *correctness* budget. Encoding is not the bottleneck. This is not speculative — it is written down in the project's own throughput notes as the fourth unspent lever: "no clip cache — clips key on `exportId` although `configHash` is already computed in `exportPlan.ts:264-285`." It makes a re-export after a typo fix nearly free and takes real load off a single dedicated GPU host.

**How it would work here.** **Cache the capture, not the encoded output.** `ffmpegGraph.ts` bans the concat demuxer by name — "splices via trim/atrim + setpts/asetpts + the concat FILTER, never the concat demuxer (measured: demuxer + `-c copy` exits 0 with 1.36 s of baked-in A/V drift)" — and audio is not per-window at all: `LinearAssembler` mixes the whole timeline through batched `amix` plus a two-pass `loudnorm`. `exportPlan.ts:264-285` already computes `computeConfigHash({simpleUi, hideSelectors, autoScript, quality, aspect})` and pairs it with `packageRevisionOf()` and `variantKeyFor()`; that triple **plus the output grid and the renderer profile** is a complete content key, and revision bytes under `revisions/{revisionId}/` are immutable by construction so an unchanged simulation provably cannot need re-capture. `captureJobBoundary.ts` already carries `configHash` into the job spec — have `containerCaptureProvider` check the cache before launching the container and write frames back on success. Everything else in the assembler is untouched.

**Watch out for.** **Every new byte written needs a deleter.** The 2026-08-19 audit found ~30 writers against 11 deleters and `deploy/scripts/storage-census.sql` has never been run in production; a clip cache needs its own GC sweep modelled on `revisionGcSweep.ts` **before** it ships, not after. `SYSTEM_OWNED_SEGMENTS` in `shared/src/sim/simRevision.ts` is `['revisions','posters']` and nothing may write into them, so the cache needs its own segment and its own `isSystemOwned` entry or a package upload could overwrite cached captures. The key **must** include the renderer profile (hardware vs software) and the output grid, or a software-rendered clip could be served into a hardware export, bypassing the identity check that currently fails closed on SwiftShader. A stale clip is a silently wrong video, which is worse than a slow one: derive the key in **one** place next to `computeConfigHash` and unit-test the negative case.

**Effort.** M.

**First step.** No schema, no storage. Log the would-be cache key for every sim window. Run two exports of the same project back to back, then republish one simulation and run a third. Confirm keys are byte-identical across 1 and 2 and differ for exactly the republished window in 3.

---

### 4.4 Sim Inspector
**What it is.** Click a control inside the running simulation in the preview and get a properties panel: rename it, set its starting value, hide it, lock it. No prompt, no regeneration, no waiting — stored as a declarative patch beside the section so it survives the next regeneration instead of being wiped by it.

**Why it's good.** The edits creators want most are tiny and mechanical, and this product has already proven the appetite internally: the Generate button reads **"Apply minimal UI (no AI)"** when the prompt is empty, because someone realised round-tripping a model to hide a slider is absurd. Hiding already works this way — mechanically, through a CSS layer, with no LLM call and no reload, because `hideSelectors` ride the URL fragment. Extending the same instinct from *hide* to *rename, initial value and lock* is what makes a generated simulation feel authored rather than received.

**How it would work here.** Much of the plumbing exists: the rAF gate answers `listSimControls` from the live DOM; `SimUiControls.ts` is the shared contract with a static HTML-parsing fallback served by `GET .../simulations/:simId/ui-controls`; `SectionEditor` already renders the picker, prefers the runtime scan when its preview is live, and applies selections mechanically via the `#simboot=` fragment and `SET_UI_POLICY` on the v3 child runtime — so a selection change **never reloads a live sim**. What does not exist is the write side: hide compiles to a stylesheet, but rename / initialValue / lock have to reach into the sim's own DOM and JS at boot, which is `simRuntimeChild.ts`'s job, and that module's output is **embedded into stored `bridge.js` bytes**. Adding a capability there bumps `SIM_CHILD_RUNTIME_VERSION` and requires rebuilding every stored package (`rebuild-sim-bridges.ts`, `verify-sim-rebuild.ts`, `prove-sim-rebuild.ts` exist for exactly this drill). Store the patch as `{selector -> {label, initialValue, hidden, locked}}` **beside the section, not inside the package**, so regeneration re-applies it — and report any selector that no longer resolves loudly, the way `SimBridgeContract` reports a broken anchor rather than silently no-opping.

**Watch out for.** The child runtime is ES5 with no arrow functions, `const`/`let`, optional chaining or template literals, because some uploaded sims parse in quirks mode and a syntax error is a dead package with no error message. Selectors must survive `SIM_UI_UNSAFE_SELECTOR_RE` and stay in sync across four sites. And the patch changes what the viewer runs, so it enters the presentation identity: `computeConfigHash` canonicalises a **fixed** `SimPresentationConfig` today — leaving the patch out silently invalidates posters and any capture cache; putting it in changes a hash the export plan, poster identity and canary all depend on. "Make it glow at 0:42" is a timeline-anchored behaviour, not a boot patch — cut it from v1.

**Effort.** L.

**First step.** Extend the existing runtime scan to also return each control's current value and bounding rect, and draw a hover highlight over the live preview from it. That proves the click-to-select round trip without touching stored bridge bytes, defining a patch format, or bumping a runtime version. (It is also 1.1, so you get it for free.)

---

### 4.5 Command Bar
**What it is.** One shortcut opens a search box over every action in the editor — add a section, regenerate this simulation, jump to section 7, place a marker, export — each result showing its own hotkey.

**Why it's good.** `m` is the **only** keyboard shortcut in the entire editor (`VideoEditor.tsx:1170`, and it bails on any modifier). Every other action is a hunt through panels across `VideoEditor` (1,898 lines), `SectionEditor` (3,145 lines) and `ProjectHeader`. A palette costs no screen space, surfaces capabilities that could never justify their own button, and teaches its own shortcuts. It is also the cheapest thing in this theme by a wide margin — no migration, no storage, no CSP surface, no new endpoint.

**How it would work here.** An overlay fed by an action registry of `{id, label, keywords, hotkey, run, enabledWhen}`. The handlers span three components — `VideoEditor` owns `handlePlaceMarker`, `handleUndo`/`handleRedo`, `commitSections` and the library handlers; generation lives in `SectionEditor`'s `handleGenerate`; export lives in `ProjectHeader` via `useProjectExport` — which is an argument for lifting the registry to a context rather than prop-drilling. Section titles register as jump-to rows off the `TimelineSection` array `VideoEditor` already holds. Undo/redo rows must respect `historyBusy` through `enabledWhen`. Accessibility is enforced, not aspirational: `a11yOperableControls.test.tsx` resolves controls through the accessibility tree and fails icon-only buttons without an accessible name; `confirmDialogA11y.test.tsx` sets the bar for the dialog itself. No `cmdk`/`kbar` dependency exists — either add one (through the frozen-install bundle scan) or write the matcher, which is small but real.

**Effort.** S.

**First step.** Ship the overlay with exactly five actions already wired inside `VideoEditor` — undo, redo, place marker, open export, jump to section — each showing its hotkey. Check a week later whether anyone uses the hotkeys. If the palette is used but the hotkeys are not, the teaching claim is wrong and the registry should stay small.

---

### 4.6 Undo that feels instant
**What it is.** Apply the restored snapshot to local state immediately, leave the toolbar enabled, flush the diff in the background, reconcile on failure.

**Why it's good.** Undo today clones the whole `TimelineSection` array into a 50-deep snapshot stack, then replays it by diffing and issuing **sequential** per-section PATCH/POST/DELETE calls while `historyBusy` disables both toolbar buttons (`VideoEditor.tsx:42,44,147,156,581-642`). It short-circuits unchanged sections through `sectionComparable`, so it is N-changed round-trips rather than N-total — but it is still serial, still blocking, and still covers only sections: markers and library actions are outside it entirely. **Untrusted undo makes people cautious, and cautious people ship the first version they were given.** This is the 80% of the "local-first op log" idea that needs none of its infrastructure.

**How it would work here.** A change inside `handleUndo`/`handleRedo`: set the restored sections locally before awaiting, stop gating the toolbar on `historyBusy`, and let the existing catch-and-`loadData()` path reconcile a failure. Do **not** build the op log: `editor-state.controller.ts` is a GET-only bootstrap route contractually shape-locked to the standalone list endpoints and cannot become a sync endpoint cheaply; there is no IndexedDB dependency; server writes are already last-write-wins per row with no field versioning; and a new sync controller would be invisible to a coverage metric that measures `src/services/**` only.

**Effort.** S.

**First step.** Make the change, use the editor for an hour. If undo then feels trustworthy, the op log was never the requirement.

---

### 4.7 House Style
**What it is.** Each course gets a visual signature — palette, poster frames, chapter cards, motif — generated **deterministically** from a hash of the course itself. Unique to that course, reproducible forever, never the same twice across courses.

**Why it's good.** It is the best-priced idea in this document and it fixes a problem the codebase demonstrably has: project thumbnails today go through `gpt-image-1` with a `dall-e-3` fallback (`backend-api/src/services/generateAiThumbnail.ts`), which costs an API call per thumbnail, produces exactly the generic AI look, and cannot be reproduced. A seeded generator is cheaper, faster, deterministic across re-exports, and distinctive. It also fits the codebase's strongest existing pattern — `client-web/app/c/[courseSlug]/og/route.tsx` already renders 1200×630 per request with `next/og` and cache headers, writing **zero bytes** to storage — which matters more than usual given ~30 storage writers against 11 deleters.

**How it would work here.** `mulberry32` is already exported from `backend-api/src/services/export/capture/injection.ts` (with a matching `MULBERRY32_JS` string and a test pinning the two together) — lift it into `shared/` so both apps can import it without pulling in export code. Key on the course id, generate a deterministic palette plus a small SVG motif, and render two ways: as an `ImageResponse` in a new og route following the existing one exactly (same `Cache-Control: public, max-age=300, s-maxage=86400, stale-while-revalidate=604800`), and as inline SVG for chapter cards in the player. Use the HSL token set in `client-web/app/globals.css`, not hardcoded hex, or it breaks under `html[data-theme="dark"]` — note the existing `/c/` pages get this wrong and are the wrong model to copy. Honour `html[data-motion="reduced"]`. **Drop the WebGPU animated-card scope**; it buys nothing and adds a compatibility matrix. Note `PosterService` cannot render this (it stores captured sim stills) and there is no avatarCircles rendering service (`backend-api/src/services/avatarCircles/` is only `normalizeAvatarCircles.ts`; visuals live client-side in `AvatarCircleViz.tsx`).

**Effort.** S.

**First step.** Half a day: a pure `seededSignature(courseId)` in `shared/` returning palette + motif, rendered in a scratch `next/og` route, with twelve real course ids side by side. If twelve courses do not look like twelve different courses at thumbnail size, tune the generator before touching a product surface.

---

### 4.8 Brand tokens inside the simulation
**What it is.** Inject design tokens into the published simulation package as a CSS custom-property layer applied at boot, so generated sims inherit brand colours without trusting the model to remember them.

**Why it's good.** It is the one genuinely good half of the Brand Kit idea, and the mechanism is already proven: `SIM_BOOT_SNIPPET` in `sim-public.controller.ts` injects a script into every entry HTML that reads the `#simboot=` fragment and applies styles **during parse**, and `hideSelectors` already ride that fragment so a change never reloads a live sim. A token layer is the same trick with different CSS — and, being serve-time, it reaches every published package. (The rest of Brand Kit is dead: `projects.style_preset` is written by exactly two places and read by **nothing** outside the archive, `orgs` has no membership table, and captions are unstyled WebVTT with no styling layer to unify.)

**How it would work here.** Extend `SIM_BOOT_SNIPPET` to accept a small set of CSS custom properties alongside the existing hide list (`shared/src/sim/simUrl.ts` owns the fragment shape). Keep the property set small and named, and decide deliberately whether it enters `computeConfigHash` — if it does not, two brandings collide in the poster store.

**Effort.** S.

**First step.** Confirm one generated simulation picks up a brand accent colour at boot with no reload and no regeneration.

---

### 4.9 Margin Notes
**What it is.** Share a link that lets a colleague or subject-matter expert leave a comment pinned to 2:14. Comments arrive in the editor as flags on the timeline, resolve when addressed, and a course cannot publish until a required reviewer signs off.

**Why it's good.** Review today happens in a chat window with timestamps typed by hand, which is exactly where corrections get lost or applied to the wrong moment. For educational content the stakes are higher than for advertising: a wrong formula inside a simulation becomes a wrong formula in a thousand students' heads, and a publish gate is a cheap defence. FlowVid genuinely has the two halves — timecoded flags (`timeline_markers`, migration 041, with an `m` hotkey and optimistic client updates) and a real pre-publish check (`GET /api/v1/courses/:id/readiness`, which already flags thin lessons before `CoursePublishingService.publish`).

**How it would work here.** The threads are easy; **the access model is the hard part.** `timeline_markers` is `{id, project_id, at_sec, label, notes, color, created_at}` — no author, no user reference, no `resolved_at` — so adding `author_user_id`, `body`, `resolved_at` plus replies is routine. The expensive part: `editableProject` (`backend-api/src/services/collabAccess.ts`) grants **full edit** to every row in `collaborators` — there is no reviewer role — and `requireProjectAccess` has exactly three branches (public, owner, matching share token) with no "may comment" among them. So "no reviewer account needed" means designing a new scoped-token access path plus a rate limiter. Sign-off slots naturally into `CoursePublishingService.publish` next to the readiness check. Anchoring a comment *inside* a simulation has no target — the runtime has an activation lifecycle, not addressable steps. Depends on 7.4 (Teams).

**Effort.** L.

**First step.** Add `author_user_id`, `body` and `resolved_at` to `timeline_markers` and let two people who are **already collaborators** comment and resolve on the timeline. That proves the review loop is used before you invent a reviewer role, a scoped token, or an anonymous rate limiter.

---

### 4.10 Storyboard (text cards)
**What it is.** A card view of the whole video — one card per section with title, length, type and simulation status — with drag to reorder and shift-click multi-select.

**Why it's good.** A timeline is right for frame-accurate trimming and wrong for "what is in this lesson and is the order right?". Batch selection is the other half: without it a thirty-section course means thirty identical clicks to change one setting, which is a real reason a creator abandons a restructure they know would help. The data is already there in one round-trip: `GET /api/v1/projects/:id/editor-state` returns videos, sections, simulations, broll jobs, images and audio.

**How it would work here.** **Render text cards, not images.** Posters exist only for canaried packages (`PosterService` has exactly one non-test caller — the manual `sim-canary-publish.ts`) and `posterFor` has no cross-identity fallback, and video/clip sections have no per-section thumbnail at all; only image sections get a visual. So the card grid's images are mostly missing and must render as honest type-and-status cards. Reorder is **not** one batched op: `sections.controller.ts` exposes per-section PATCH with no batch route, so a ten-section reorder is ten requests against a 10-connection pool. The one thing genuinely in its favour: `commitSections` pushes exactly **one** snapshot per call, so a whole batch applied through a single `commitSections` **is already a single undo entry** — the existing snapshot history is bad for granular ops and good for batches, which is the opposite of the usual assumption.

**Effort.** M.

**First step.** Render the card grid with no images behind a view toggle, and instrument how many sections across real projects actually have a matching poster row. That number decides whether the visual half is buildable at all.

---

### 4.11 Director's Console
**What it is.** Say what you want changed across the whole project — "shorten every section by 20%, move the quiz after the derivation" — and get back a plain-language list of the exact edits it intends. Tick the ones you want, apply as a batch, undo the whole batch with one keystroke.

**Why it's good.** Everything in the editor is per-section, so a change of mind about the whole video is repetitive clicking — which means creators do not make those changes and ship the structure they were first given. The reviewable-batch framing is what makes it usable rather than terrifying: the model proposes, the human approves per item, and the undo is a single entry because it was a single batch. **And the dependency everyone assumes is backwards:** `commitSections` already pushes one snapshot per call and then sets the whole array, so a batch of fifty edits applied through a single `commitSections` is already one undo entry. The reviewable-batch shape fits the editor as it stands — it needs neither an op log nor a command palette.

**How it would work here.** The model receives the `TimelineSection` array as structured state and returns **typed per-section patches**, never free-form database writes; the editor renders them as a checklist with per-item checkboxes and a *preview value* per row, not just a label; the approved subset is applied locally and flushed through the existing per-section PATCH; the whole thing lands as one snapshot. Exclude generation-heavy operations from v1: a batch that regenerates simulations spends money and retires revisions, and until 4.1 exposes rollback there is no way back — so sequence this **after** Takes. Partial failure has no story today (`restoreSectionSnapshot`'s catch falls back to a full `loadData()`, acceptable for undo and not for "thirty of fifty applied"), and applying a batch is N sequential PATCHes against a pool of 10, so it needs either a transactional route or deliberate throttling.

**Effort.** L.

**First step.** Build it with **no model at all**. Add one hardcoded operation — "shorten every section by N%" — computed client-side, rendered as a per-section checklist with before/after values, applied through a single `commitSections`. If people do not tick the boxes, the model half was never the missing piece.

---

### 4.12 Steerable Draft
**What it is.** While you are still typing the description of a simulation, a rough wireframe assembles itself in the preview, updating every second or two. When the shape looks right you commit, and the real model builds the polished version constrained by that skeleton.

**Why it's good.** The core observation is the best in the creator sweep: an interactive simulation is the hardest thing in this product to specify in words, and prompting for it today is blind — write, wait, discover, rewrite. Seeing a wrong layout after two seconds is worth far more than after ninety. The editor also already guards supersession correctly: a Generate that supersedes an in-flight run keeps the newer run's state because the `finally` block checks `genAbortRef.current === abort` before clearing anything — exactly the invariant a debounced loop needs.

**How it would work here.** Three constraints make it more expensive than it looks. (1) `EDITOR_SIM_RESIDENT_CAP = 1` — a skeleton runtime cannot take a second pooled iframe; it must replace the preview or render as plain DOM. (2) Every keystroke burst is an LLM call, and generation is metered (`RateLimitService`: 100k tokens/week, 500k/month per user, plus a platform `generation_paused` flag) — a debounced continuous loop is a **billing decision before it is an architecture**, so 7.1 comes first. (3) There is no restricted widget schema, no generic skeleton renderer and no fast-model tier; the existing SSE streams a *finished* generation. The commit step — handing the skeleton to the full pass as a hard structural constraint — is where the quality claim actually lives and is entirely unproven.

**Effort.** XL.

**First step.** Measure before you build. Instrument the existing `generate-sim-script/stream` to record wall-clock time from request to `done` across real generations. If p50 is already under ~30 s, a two-tier speculative architecture is buying seconds at the price of an XL, and the cheaper win is showing the model's actual streamed output — which 4.2 already covers.

---

### 4.13 Sim Kits
**What it is.** Turn a simulation you already built into a reusable component with knobs — "Titration Lab (compound, starting pH, show graph)" — droppable into any lesson in any project, with a fix-once-update-everywhere story.

**Why it's good.** A creator building a twelve-lesson chemistry course builds essentially the same lab widget twelve times, paying twelve generations and twelve rounds of debugging. The compounding argument is real and the ceiling is the highest in this theme. One half of the mechanism genuinely exists: a published package is an immutable, content-hashed, manifest-verified artefact that already serves **many** timeline sections from **one** document through the v2 dynamic bridge — `variantKeyFor` picks the sub-simulation and `packageKeyOf` pools by document so a shared package boots once. Multi-instance from one artefact is already how this product works *within* a project.

**How it would work here.** The blocker is ownership and it is total. `orgs` is `{id, name, owner_user_id, created_at}` with **no membership table**; every asset in the product is `project_id NOT NULL` with `onDelete` cascade, no per-asset ACL, and no cross-project sharing anywhere — the closest primitive is `ProjectDuplicationService`, which **copies**. Second problem: a typed props schema has to enter the presentation identity. `computeConfigHash` canonicalises a fixed `SimPresentationConfig`; arbitrary kit props left out of it make two differently-configured instances collide in the poster store and any capture cache, and putting them in changes a hash the export plan, poster identity and canary all depend on. Prerequisites: 7.4 (Teams) and a decision on the hash. (Naming correction for whoever picks this up: `dynamicScriptFor` lives in `client-web/lib/simPool.ts`, not in `shared/src/sim/simIdentity.ts`.)

**Effort.** XL.

**First step.** Ship **"copy this simulation into another of my projects"**, reusing `ProjectDuplicationService`'s existing package-copy path — one project-scoped row and a byte copy, no new ownership model. If creators do not use copy, they will never use kits, and you have saved an XL.

---

## Theme 5 — Distribution: getting FlowVid onto other people's pages

One fact governs the top of this theme: **FlowVid pages cannot be framed anywhere, by three independent mechanisms.** `shared/src/csp.ts:107` emits `frame-ancestors 'none'` unconditionally; `client-web/next.config.ts` applies it to `/:path*`; `deploy/nginx/ssl-params.conf` adds `X-Frame-Options SAMEORIGIN always` at the server level. And `ops/release/src/csp-audit.ts:60-70` raises a HIGH `frame-ancestors.weakened` finding for anything but exactly `'none'`. Every embedding idea inherits all four.

A second fact governs the bottom: every anonymous surface proposed here lands on **one 2-vCPU VM with no CDN, no nginx `limit_req`, a 10-connection Supabase pool**, and existing public routes that set **no `Cache-Control`** and fire an unbounded `view_count` UPDATE per hit. `rateLimit()` on `request.ip` and ISR are not polish; they are the entry fee.

### 5.1 Playable Link
**What it is.** A public share link whose first screen is not a poster with a play button, but the lesson's simulation already running and already touchable. Pressing play starts the narration; if the visitor never presses play, they still got to hold the thing.

**Why it's good.** It is the highest-leverage change available for the thing FlowVid is actually best at, at the exact moment a cold visitor decides whether to care — and the delta is a **default, not a system**. `useProjectPlayer.ts:440` already computes `simFirst` when the first segment carries a simulation at t≈0 and arms the sim pool immediately rather than waiting on the video's boot gate; `SimPoolOverlay.tsx` already boots packages into hidden, inert, `aria-hidden` frames and `SimPresentationLayers.tsx` reveals by opacity swap; `userInteraction` already pauses the video, calls `pauseAutomation()` and stops the HLS loaders (`useProjectPlayer.ts:3146`); and `SET_UI_POLICY` is genuinely implemented in the modern bridge (`_onUiPolicy` → `POLICY_APPLIED` / `POLICY_REFUSED` with an **explicit refusal** rather than a silent no-op) and already posted by `SimRuntimeClient.ts:2117`.

**How it would work here.** For a share/permalink entry, do not autoplay: reveal the hero sim with automation running and Minimal-UI applied via `SET_UI_POLICY`, and start the video on the first explicit play. Extend `library_shares` (see "Already in flight") rather than `projects.share_token`.

**Watch out for.** Only lessons whose **first** section is a simulation at t≈0 have a hero; everything else needs an authoring decision about which section is the hero. `SET_UI_POLICY` is honoured only by modern bridges, so the `POLICY_REFUSED` path must be designed. Posters have no fallback and exist only for canaried packages, so the pre-boot frame is often blank — `browserFloor.ts`'s honest "this browser cannot run it" path must cover it. A cold visitor on a weak device gets a heavy WebGL package before any video: verify the `adaptiveQuality` tiers and pool residency on a low-end profile. And **the SEO justification does not apply**: `/v/` and `/pl/` are `Disallow`ed in `robots.txt` and render no server HTML (`SharedViewerPage.tsx` is a pure client shell with no `generateMetadata`); only `/c/*` is SEO-grade.

**Effort.** S.

**First step.** One day behind a query flag on a single share link. Put it in front of five people who have never seen FlowVid and watch whether they touch the simulation before they look for the play button.

---

### 5.2 Pocket Handoff and Paper Trail
*(merged — they share the QR encoder neither has and the print stylesheet that does not exist anywhere in `client-web`)*

**What it is.** (a) A QR on every lesson page, embed and mini-site that hands the viewer's current lesson — and their position in it — to their phone. (b) A printable one-page companion: key ideas from the narration, a labelled legend of what the simulation's controls do, room for notes, and a QR back to the live interactive version. A handout a teacher can photocopy thirty times.

**Why it's good.** The QR is the cheapest genuinely new distribution surface available and the only one that needs **no new access decision at all** — it encodes the URL the person is already looking at, so it grants nothing that was not already granted. The projector/classroom/conference-booth case is exactly how this content gets shown, and today the experience ends when the projector switches off. The handout is the best-grounded print idea because **its hardest input is already assembled**: `LessonContentService.resolveLessonContent` returns `{transcript, transcriptSource, topics, interactiveElements, hasMeaningfulText}` with a documented four-source fallback chain and an explicit rule against ever using the internal `sim_prompt` as user-facing text; and `simulations.guidance` is `GuidanceEntry[]` where each entry already has a `title` and a `narration` describing one control, produced and validated by `GuidanceService`. Paper survives a locked-down school network, a device ban and a procurement officer who will not click links — and every photocopy carries a QR back to the live thing.

**How it would work here.** A QR component rendering `CanonicalUrlService.lessonUrl(...)` plus a `#t=` **fragment** (not a query — fragments do not mint a second ISR cache key). There is **no QR library in either workspace** (verified: zero hits for qrcode/QRCode/qr-code), so either add one through the frozen-install CI and `scan-bundle-localhost.sh`, or generate the matrix yourself and render inline SVG — which also lets `next/og` use it later. The resume half is a small addition to `client-web/components/viewer/HLSPlayerShell.tsx` (774 lines, currently **zero** `location.hash` handling): read `#t=` on mount, seek once, write it back on pause. The handout is `client-web/app/c/[courseSlug]/[lessonSlug]/handout/page.tsx` with `@media print` — **not** a server-side PDF: there is no PDF renderer in the repo (no pdfkit, no puppeteer in backend-api; Playwright is a client-web devDependency), so a print stylesheet gets you a PDF for free with no new dependency, no new bytes and no new deleter. Cache by lesson `updated_at` the way the OG routes already do with `?v={updated_at.getTime()}`.

**Watch out for.** **Do not source stills from `sim_posters`** — most lessons would render a handout with holes. Use `projects.thumbnail_url` plus the gradient-tile discipline the mini-site plan already adopted. `simulations.guidance` is only populated when `guidance_status = 'ready'`, so an unguided lesson produces a handout with no control legend — which is the whole middle of the page. Icon-only QR buttons need an accessible name or `a11yOperableControls.test.tsx` fails the build. And use the token palette from `globals.css`, not the `text-black/50` the existing `/c/` pages regrettably hardcode.

**Effort.** S (QR) / M (handout).

**First step.** Add an inline-SVG QR next to the title on one lesson page encoding `CanonicalUrlService.lessonUrl(...)` — no `#t=`, no print sheet, no component library. Put it on a projector and scan it. Separately: render the handout route server-side and **unstyled**, print it to PDF, and hand it to a teacher. If the guidance text reads as a usable control legend on paper, the rest is a stylesheet; if it reads as internal prose, the guidance corpus needs an editing pass before any of this is worth designing.

---

### 5.3 Sneakernet Bundle
**What it is.** A downloadable lesson that works with no internet: one archive containing the simulation package with every library vendored locally, plus a small index page. Double-click and it runs; copyable to a USB stick.

**Why it's good.** The vendoring — the part everyone assumed was the new engineering — **is already written, hash-pinned and tested** on `origin/main`. `backend-api/src/services/export/capture/dependencies/offlinePackage.ts` exposes `prepareOfflinePackage(files, entryPath)`, which materialises a hash-pinned dependency closure into `__flowvid_vendor/<name>/<version>/`, rewrites the entry HTML's import map at it, neutralises unsatisfiable external stylesheets, and returns `bootComplete: false` plus `ExternalDependencyBlocked` **naming the exact unresolved URLs** — i.e. it fails loudly on a remaining absolute external URL, which is precisely the property you want. `backend-api/vendor/sim-deps/registry.json` pins `three@0.169.0` with per-file SHA-256 and satisfies the jsDelivr, unpkg and esm.sh spellings — verified against the actual CDN URLs the deployed packages use. This is a repackaging of finished, integrity-checked work that costs zero bandwidth, zero render and zero CDN to serve, and it opens the Kolibri/PhET distribution world where FlowVid's competitors structurally cannot go.

**How it would work here.** Feed the existing pipeline in a different direction. `parseSimPackageKey` (`capture/isolation/simPackageKey.ts`) turns a served sim URL into `{packageRoot, entryPath}` with a fail-closed grammar; `containerCaptureProvider.fetchPackageFiles` stages the package **whole from its root** with layout preserved (256 MB ceiling, `revisions/` + `posters/` skipped) — anchoring at the package root and never `dirname(entry)` is the v0.1.23 lesson and matters here because generated `bridge.js` lives at the root and nested entries reference `../bridge.js`. Hand those files to `prepareOfflinePackage`, then zip with AdmZip exactly as `simulations.controller.ts:627` already does — **but not with that endpoint's key filter**, which zips every key under the prefix including all revision copies.

**Watch out for.** The vendoring modules are on `origin/main` only. Only `three@0.169.0` is vendored today — `chart.js` and Google Fonts are used by real packages and will come back `unresolved` (honest, but it means "offline" is per-package until the registry grows; adding one is a `vendor/sim-deps/build-pack.mjs` run and a commit). `MAX_VENDOR_TOTAL_BYTES` is 32 MB and `MAX_VENDOR_FILES` 400 per pack, and the existing download.zip buffers the whole archive in memory. **Phase 1 should ship the simulation package alone**: bundling video means presigning or embedding media that `canServeMediaKey` normally gates, which is a deliberate access decision since a downloaded file cannot be revoked.

**Effort.** M.

**First step.** A 40-line script: `parseSimPackageKey` + `fetchPackageFiles` + `prepareOfflinePackage` on one real production simulation, zip, unzip to a temp dir, open the entry **with the network off**. Either the sim runs — in which case the hardest part was finished by someone else — or `bootComplete` is false and it prints the exact URLs in the way.

---

### 5.4 Frame Pass → Institution Pack
**What it is.** (a) A dedicated public embed route — `/embed/{code}` — rendering one lesson or one simulation in a bare, chrome-free player designed to sit inside somebody else's page, plus a standard oEmbed endpoint so pasting a FlowVid link into Notion, WordPress, Ghost or Confluence turns into a live playable simulation instead of a dead blue link. (b) Then, and only then, a SCORM 1.2 package that opens the hosted lesson and reports completion.

**Why it's good.** It is the only idea in this document that puts FlowVid on a page it does not own, and it is the keystone under the institutional business. The prior art for the fix is already in the repo and working: `sim-public.controller.ts` registers with `{ helmet: false }` and stamps its **own** per-response CSP whose `frame-ancestors` is `browserOrigins()` — a sim already frames cross-origin today, just only into flowvidco.com. And `client-web/components/viewer/LessonPlayer.tsx` is 46 lines that take a pre-fetched `PlayerConfig`, so the player half is nearly free. The hosted-wrapper shape is right for FlowVid specifically because simulation packages are large, revisioned and constantly updated: freezing a copy into a Moodle would break the revision pointer `simulationUrlResolver.ts` exists to maintain.

**How it would work here.** **Not** `{ helmet: false }` on a Next route — that trick lives on the Fastify side. In `client-web` you must **exclude `/embed` from the global `headers()` rule** in `next.config.ts` and give it its own header set, because Next sends every matching rule and browsers enforce the **intersection** of multiple CSP headers, so a second permissive rule leaves `'none'` winning. Then a `location /embed/` block in `deploy/nginx/templates/app.conf.template` that omits `X-Frame-Options` — and note nginx `add_header` does **not** merge across levels, so that block must re-declare HSTS and nosniff from `ssl-params.conf` or it silently drops them. Data comes from a new anonymous backend route following `PublicCourseQueryService` (public-only view model, 404 never 403, explicit `Cache-Control`, `rateLimit()` on `request.ip`) fetched server-side with `next: {revalidate, tags}` like `client-web/lib/courseApi.ts`. `embed` is already in `RESERVED_SLUGS`. oEmbed is a Fastify route plus a raw `<link rel="alternate" type="application/json+oembed">` in the `/c/*` pages — Next `Metadata.alternates` cannot express that type, so it goes in the page body, not `seoToMetadata`. The domain allowlist is **new schema**; build it on `library_shares`, not on `projects.share_token`. For the SCORM half: the zip is cheap and has prior art (`simulations.controller.ts:627` already builds a package zip with AdmZip and streams it), so it is `imsmanifest.xml` plus a ~4 KB adapter that walks `window.parent` for the SCORM API and writes `cmi.core.lesson_status`, with the launch URL from `CanonicalUrlService`. Completion telemetry is nearly free: `sim_rum_events` already records `furthest_stage` and `present_ms` on a `transition` event, so "the simulation actually reached present" is a query, not a new event kind.

**Watch out for.** The nginx part is a **deploy-template change, not an app deploy** — `deploy-images.sh` only pulls pinned digests. `csp-audit.ts` probes `/` only (`production-audit.spec.ts:269`), so a scoped carve-out will not auto-fail, but its own remediation text says widening must be an explicit documented decision: this needs an owner sign-off, not a quiet commit. Under the R2 adapter sims serve straight from the R2 public URL, **bypassing the `/sim-public` proxy and its CSP entirely**, so an embed design must not assume those headers. Scope the LMS phase to SCORM 1.2 alone (no certification needed); cmi5 needs an xAPI emitter and an LRS target, and LTI 1.3 needs OIDC, JWKS rotation and Deep Linking, none of which exist. And there is no institution *product* to attach it to yet — no seat model, no admin console (see 7.4) — and no named pilot customer in the repo.

**Effort.** L (Frame Pass) → XL (Institution Pack).

**First step.** Add one Next route `client-web/app/embed/[code]/page.tsx` rendering `LessonPlayer` from an existing published lesson, exclude `/embed` from the `/:path*` header rule, give it `frame-ancestors *`, and — locally, with nginx out of the picture — load it in an iframe from a different origin. If the sim inside it paints, the idea is alive; if `/sim-public`'s own `frame-ancestors ${browserOrigins()}` blanks the inner frame, you have found the second wall before spending a week on oEmbed. **In parallel, for free:** hand-write a 6-file SCORM 1.2 zip that iframes one published lesson, upload it to a SCORM Cloud sandbox, and screenshot the framing failure. That screenshot is the business case for Frame Pass and the manifest is reusable the day it lands.

---

### 5.5 Run Card
**What it is.** When a viewer finishes playing with a simulation they can share what **they** did — a compact, spoiler-free card showing the parameters they chose and what happened, plus a link that reopens the simulation in exactly that state. Not "here's a cool thing" but "here's the flock I made — beat it."

**Why it's good.** Wordle's lesson was that the **share format**, not the puzzle, was the viral object. This is the only idea in the sweep where the codebase's most carefully designed subsystem is already shaped to receive it: `shared/src/sim/bridgeCapability.ts` exists specifically to record, at publication time, what a package **can** do, with a documented three-state discipline and a stated rule that collapsing `null` into a boolean is the mistake the module exists to prevent. `scriptApplied` and `requiresImportMaps` already live there; `stateSerializable` is the same shape, answered by the same publication path, projected at the same pointer flip, read by the same consumer. And it needs no new access model, no new storage bytes, no CDN and no new authorization decision — the rarest combination on this list.

**How it would work here.** One correction that changes the design: **the URL fragment is already occupied and is load-bearing.** `shared/src/sim/simUrl.ts` always emits `#simboot=<urlencoded JSON>` on a sim iframe src, and dropping or replacing it turns a hash-only src change into a full **navigation** that hard-reloads a live sim. So serialized state belongs on the **page** URL (`/c/{course}/{lesson}#run=…`), decoded by the page and pushed into the runtime as a new inbound message. Concretely: add `SERIALIZE_STATE` / `APPLY_STATE` inbound and `STATE_SERIALIZED` outbound to `shared/src/sim/runtimeProtocol.ts` (bumping to v4), add `stateSerializable` to `BridgeCapabilities`, and have the bridge generator in `SimulationService.injectBridge` discover the pair — note `simulations.bridge_functions` is a **discovered** list of `{name, windowFn, description}`, not an author-declared contract, so discovery is the realistic path. Share text comes from `simulations.guidance` entry titles plus the state values.

**Watch out for.** Bumping `SIM_PROTOCOL_VERSION` has a rollout cost: revisions record their bridge/runtime protocol versions and `sim-canary-publish.ts` is the gate that grants `managed-presentable`. Every existing package answers `null` for the new capability and must keep working — which is exactly what the three-state rule is for, but it must be honoured everywhere. Reliable `serializeState`/`applyState` discovery across heterogeneous third-party sims is the real risk (`SimBridgeContract.ts` shows how much care discovery already needs). And be honest about revocation: a `/v/{token}` run card dies with the token, but a `/c/` lesson has `publish_state`, not a share row — so the promise holds only for tokened links.

**Effort.** L.

**First step.** Skip the protocol. Take one simulation you control, hand-add `window.__fvSerializeState()` and `window.__fvApplyState(s)` to its source, and in the console read the state out, base64url it into the page URL, reload, and apply it back through the existing runtime client. If the sim comes back in the same state within an hour of fiddling, the feature is a protocol message pair and a share button; if its state is entangled with rAF timing and cannot be round-tripped, you have killed it for an afternoon.

---

### 5.6 Assistant Shelf
**What it is.** Make FlowVid's public content directly readable by AI assistants: a machine-readable catalogue (per-lesson `llms.txt`, transcripts, structured metadata) and later an MCP server that lets assistants search the public library and hand back a deep link to the exact simulation.

**Why it's good.** The asymmetry is the strongest strategic point in the distribution sweep: assistants are good at *explaining* things and structurally incapable of *showing* an interactive one, so a FlowVid link **completes** an assistant's answer rather than competing with it. And the catalogue half is close to free: `LessonContentService.resolveLessonContent` already returns transcript, topics and interactive-element descriptions with a source label, `getCourseSitemap` already enumerates the public set, and `client-web/app/llms.txt/route.ts` **already exists** as a `force-dynamic` route emitting the course index. Extending it to per-lesson detail is one route plus one public backend endpoint over data that is already assembled and already public.

**How it would work here.** Split it, because the two halves have completely different costs. **Catalogue (native):** a public endpoint backed by `LessonContentService` and `PublicCourseQueryService`, served with an explicit `Cache-Control` — today **no** public endpoint sets one (grep finds `Cache-Control` only in sim-rum, sim-public and three SSE cases) — and `rateLimit()` on `request.ip`, because an assistant-facing catalogue is a crawler magnet aimed at a 10-connection pool. **MCP (not native):** there is no `@modelcontextprotocol` dependency and no MCP code in the tree, and the deploy topology is a fixed docker-compose of four services routed by nginx subdomain — a fifth is a **compose and nginx template change**, i.e. a deploy-config release, not an app deploy. Scope strictly to the already-published `/c/*` set; the opt-in "listed" subset depends on 5.10.

**Watch out for.** Deep-linking "to the exact moment" needs the `#t=` fragment from 5.2, and "a simulation already configured for the question" needs 5.5. Backend coverage measures `src/services/**` only, so a new public controller can ship entirely untested without moving the metric — write controller-level tests deliberately.

**Effort.** M (catalogue) / L (with MCP).

**First step.** Extend `client-web/app/llms.txt/route.ts` from a course index to a per-lesson catalogue — canonical URL, title, `topics`, and the `interactiveElements` labels and descriptions straight out of `resolveLessonContent`, with an explicit `Cache-Control`. Then paste the URL into three assistants and ask each "show me a simulation of emergent flocking." If they cite it, the whole distribution thesis is validated for one afternoon's work.

---

### 5.7 The podcast has no feed
**What it is.** Make the podcast product distributable: a per-show RSS 2.0 feed with the iTunes namespace, a public episode page, and episode artwork — so a FlowVid show can be submitted to Apple Podcasts and Spotify.

**Why it's good.** In a sweep of sixty-plus ideas the podcast surface appeared only as a *correction* ("that belongs to the podcast product") and never as a subject. Meanwhile the repo contains `backend-api/src/services/podcast/` with a multi-agent writers' room (`ScriptRoom.ts`), `PodcastMemory.ts`, ElevenLabs dialogue rendering with a content-addressed chunk cache, ffmpeg mastering, four dedicated controllers, and `client-web/components/podcast/studio/` — a full Web Audio timeline editor with a mix engine, waveform peaks, clip popovers, a versions drawer and an export dialog whose preview is guaranteed to match the server render. **That is a shipped product, and it cannot be published.** Grep for `rss`, `itunes`, `feed.xml` or `application/rss` and you get one incidental hit (a reserved slug). Every podcast route is Firebase-auth plus ownership, masters live behind 6-hour presigned URLs, and there is no public episode page. FlowVid built a podcast studio and no way to have a podcast. There is also a finished design document for the next phase — `md-files/INTERACTIVE-PODCAST-PLAN.md` — that this sweep never read.

**How it would work here.** (a) A publish state on `podcast_shows` and `podcast_episodes` mirroring `courses.publish_state`. (b) A public master URL that is **not** a 6-hour presigned link — podcast clients re-fetch for months, so this needs a stable, cacheable, range-request-capable route. (c) `GET /feed/{showSlug}.xml`: RSS 2.0 plus `itunes:` elements, `<enclosure>` with a real byte length and MIME type, GUIDs that never change, and artwork. (d) A public episode page for the human-facing link. Note the constraint the interactive-podcast plan already identified: the never-interrupt listener needs a pristine linear file, so the static feed is not a fallback, it is the primary artifact.

**Effort.** M.

**First step.** Hand-write the RSS XML for one existing rendered episode, host it, subscribe in Apple Podcasts. If it plays, the feature is a route and a publish flag; if the enclosure fails, you have found the presigned-URL problem before designing anything.

---

### 5.8 A link preview that says "this moves"
**What it is.** Make the static OG card actually communicate that the thing on the other end is interactive.

**Why it's good.** The link preview is the front door and today it is `client-web/app/c/[courseSlug]/[lessonSlug]/og/route.tsx` — dark background, title text, brand name, indistinguishable from a blog post. That part of the complaint is entirely true. **The animated version is not buildable**, and it is worth writing down why so nobody re-proposes it: `next/og` `ImageResponse` cannot emit an animated image; the only writer of `sim_posters` in the whole backend is the manual `sim-canary-publish.ts --apply`, so every motion poster costs a human running a canary against one package; capture measures 4.28 s/frame at 640×360 on the production host, so even a deliberately tiny 45-frame loop is minutes per poster; posters have **no** cross-identity fallback by explicit design ("absent is honest, approximate is not"), so 90% of content would silently degrade to a still anyway; and X does not animate `og:image` regardless. What is left is a two-hour edit that pays: type-and-topic chips, the deterministic 4.7 signature as the card's visual identity, and the interactive-element count from `resolveLessonContent`.

**Effort.** S.

**First step.** Before anything: encode one animated WebP by hand from an existing canary capture, point a test page's `og:image` at it, and paste the link into Slack, Discord, WhatsApp and LinkedIn. If fewer than two animate it, the whole animated branch is settled and you spend the two hours on the static card instead.

---

### 5.9 Remix Lineage
**What it is.** A public "Remix this simulation" button: anyone who can see a shared simulation takes an independent copy into their own account in one click, edits it and republishes, while the copy permanently carries a "Remixed from ⟨original⟩" credit and the original gains a visible remix count.

**Why it's good.** Scratch has ~30% of projects as remixes and 2.6M remixes historically; Observable has 1M+ notebooks behind a fork button. The remixing↔learning correlation is documented (CSCW 2016). And the machinery genuinely exists in outline: `ProjectDuplicationService.ts` plus its **pure** `duplicationPlan.ts` oracle do a full byte-and-row copy with a dry run, a byte cap, a claim/lease, verification and a single commit transaction.

**How it would work here.** Two corrections make this XL rather than L. (1) `projects.controller.ts:476` states the access rule as a **decision**, not an accident: "Owner-only, exactly like DELETE… Collaborators can edit but not fork (collab-042's line)." Opening it to any authenticated viewer reverses a rule someone wrote down on purpose — that needs the owner, not an engineer. (2) Duplication is **whole-project by construction** — it copies the entire HLS ladder, which is why `duplicateMaxBytes()` exists. A package-scoped fork is a **new plan shape**: `duplicationPlan.ts`'s `StorageCopy` already knows a `package-root` kind that excludes `revisions/` and `posters/`, so the copy primitive is there, but the surrounding plan (id maps for sections, videos, images, audio; `assertNoEscapingReferences`) assumes a project. Expect a sibling planner emitting one `package-root` copy plus one `simulations` row in an existing destination project. Also new: lineage columns, `fork_count`, and an SPDX license selector — there is no license field anywhere in the schema.

**Watch out for.** The leak-map memory records that duplication copies bytes **on purpose** — cross-project media dedupe was ruled out deliberately for delete and permission independence — so every remix is a real byte copy (measured packages run 546 KB for boids-3d up to 31 MB for ising-kid-v3), onto a bucket whose production census has never been run. `RevisionService.gc()` sweeps retired revisions on a keep-2 floor but a fork is a **live** row nothing reaps. Anonymous Firebase users (`users.is_anonymous`) could fork — a spam vector with no shared rate-limit store. And "the source has a live share" needs a definition: `projects.share_token` is project-level, so a simulation has no share of its own to check (use `library_shares`).

**Effort.** XL.

**First step.** Do not touch access control. Write `forkPlan()` next to `duplicationPlan.ts` as a **pure** function taking one `simulations` row and a destination project id, returning a plan of exactly one `package-root` StorageCopy plus one row insert — and unit-test it against the existing duplication fixtures. If that plan cannot be expressed without dragging in section/video/image id maps, the "finished machinery" claim is false.

---

### 5.10 The Commons
**What it is.** A public, browsable, search-indexable gallery of simulations and lessons that creators opt into — organised by topic, with structured data, its own sitemap and a weekly digest.

**Why it's good.** The diagnosis is right and worth stating plainly: after the mini-site ships, FlowVid will still have **zero organic discovery surface**. `SitemapService.ts` has two methods, `courseEntries` and `videoEntries`, covering published courses and lessons only; there is no `/c` index page, no public creator page, and no `app/not-found.tsx`. Nothing anywhere lists public projects to an anonymous visitor.

**How it would work here.** Two hard truths. (1) **Simulations have no visibility model to opt into.** There is no visibility column, and `/sim-public/*` is unauthenticated for every key under `simulations/` by design — the unguessable key *is* the capability. Making a simulation listable means giving it an owner-facing identity, an opt-in, and a public read model that none of the three existing access models (project visibility, playlist slug, course publish_state) can express. (2) The obvious ranking signal does not join: `sim_rum_events` has no `simulation_id` and deliberately no foreign key (a revision may be GC'd while its measurements stay useful), so ranking by completion means resolving `package_revision` → `sim_revisions.id` → `simulation_id`, and for legacy un-revisioned sims `packageRevision` is `derivePackageRevision(simId, bridgeHash)` — a different shape entirely. Build a rollup table, not a per-request query. Everything else follows the grain well: JSON-LD via `JsonLdService`, canonicals via `CanonicalUrlService`, a new `SitemapService` method emitting only published+indexable records, an `Allow` in `robots.txt/route.ts`, and purge targets added to `computeInvalidationTargets` — the only function that feeds `POST /api/revalidate`, so a cached route missing from it is never purged. `feed` and `rss` are already in `RESERVED_SLUGS`.

**Watch out for.** **This inverts a decision made three weeks ago** (mini-site §10 decision 2: keep `/library` noindex — "a guessable URL is one thing, a searchable one is another"). That reversal needs the owner and should not be smuggled in under a new feature name. It is also operationally hostile to the current host: an indexable gallery invites crawlers onto a single 2-vCPU VM with a 10-connection pool and public routes that do an unbounded fire-and-forget `view_count` UPDATE per hit. Its best ranking signal (fork count) depends on 5.9.

**Effort.** XL.

**First step.** Answer the one question that decides whether it can exist: count `simulations` rows with `status='ready'`, a non-null `active_revision_id`, in a project whose visibility is `public` — i.e. how many could be listed today **without a single new access decision**. If the answer is under twenty, this is a content problem wearing a product costume.

---

### 5.11 Hook Cutter
**What it is.** One button that turns a finished lesson into five or six vertical short-form clips — self-contained 20–45 second moments, captions burned in, footage reframed to 9:16, end card with the lesson link and QR. It proposes and scores; a human picks.

**Why it's good.** ffmpeg is real and well-governed here: `LinearAssembler.ts` already produces a gated `master.mp4` (exit code, ffprobe duration agreement, codec/profile checks, moov-before-mdat parsed from the file) and every spawn goes through `runFfmpegLimited`. And the best building block was missed by the sweep that proposed it: **9:16 reframing already exists** — `backend-api/src/services/crop/` (`cropProcessor.ts`, `sceneAnalyzer.ts`, `ffmpegExtract.ts`, `dsp.ts`) is a smart portrait-crop pipeline with `video_files.crop_status`/`crop_key` and a `POST /api/v1/projects/:id/recrop` endpoint. Opus Clip has 12M+ users and a ~40% discard rate, which is itself the argument for propose-and-let-a-human-pick.

**How it would work here.** Source the cut from `project_exports.output_key` (the ready master), **never** from re-capture. Candidate selection reads `scenes` where available and falls back to VTT cue boundaries plus `timeline_sections.label` when it is not — and **says which source it used**, so a user knows why a clip is loosely timed. Do not use `camera_plans.cuts_json`; that is shot-cut planning data with no subject bounding box. Clips are new bytes: write them under `exports/{projectId}/`, which already has a deleter.

**Watch out for.** `scenes.is_hook` and `aligned_words` exist **only for AI-scripted projects** — `LessonContentService` documents a four-source fallback chain precisely because scenes are often absent, and an uploaded-video lesson has only cue-level WebVTT. So karaoke captions are unavailable on most content and the tool must degrade honestly. A ready master only exists after an export reaches `status='ready'`. And ffmpeg contention is real: exports, HLS transcodes, crops, captions and podcast renders already share `runFfmpegLimited` on a 2-vCPU host.

**Effort.** L.

**First step.** Take one project with a ready `project_exports` row and write a throwaway script that reads its `scenes` rows where `is_hook = true`, prints the proposed in/out points, and cuts **one** 30-second 9:16 clip from `output_key` using the existing `crop_key` box. If `scenes` is empty on your three best lessons, you have learned the data claim does not hold before building a planner.

---

### 5.12 Lessons on Tap
**What it is.** Publish FlowVid as something other AI agents can call — an MCP server and an A2A agent card that accept "produce a six-minute lesson on Kirchhoff's laws with a working simulation, for a fifteen-year-old" and return a playable, signed lesson.

**Why it's good.** Being the **simulation supplier** to other people's tutoring agents is a better position than competing with them. A2A v1.0 is under the Linux Foundation with 150+ organisations; MCP is co-governed under the Agentic AI Foundation. Synthesia and HeyGen are exposing *avatars* to agents; nobody is exposing interactive simulations.

**How it would work here.** Be clear that the plumbing is **not** nearly free. `backend-api/tsoa.json` exists but there are **zero tsoa decorators** anywhere in `backend-api/src`, no generated spec, no script — every controller is hand-written Fastify, so writing the OpenAPI document is step zero, not a freebie. Behind it sit two things that must exist before any agent traffic is safe: a **machine principal** (auth today is Firebase bearer tokens for human users only — no API key, no service account, no scoped credential) and real rate limiting (an in-process fixed-window Map on three endpoints, no nginx `limit_req`, 10-connection pool). `RateLimitService` and `UsageTrackingService` both key on a `userId` and cannot meter a non-user caller — so 7.1 and 7.2 come first. What is real and reusable: `ContentModerationService` as the inbound trust boundary, `BillingService.hasAccess` for the paid contract, and share tokens plus permalinks as the returnable artifact — an agent gets back a real playable URL today, which is genuinely most of the value. **Drop** "return a recipe the caller can embed": `frame-ancestors 'none'` means no caller can embed a FlowVid page at all until 5.4.

**Effort.** L.

**First step.** Prove demand before building auth. Stand up a read-only MCP server exposing exactly one tool — "fetch the public lesson at this permalink as structured text plus its simulation URL" — over the existing anonymous permalink config endpoint. No new auth, no spec, no metering, and it answers the only question that matters: does any agent actually call it.

---

### 5.13 Receipts — provenance without the verifier
**What it is.** Every exported video carries a signed manifest naming its source documents, the model that wrote what, the simulation revision, and the config hash.

**Why it's good.** FlowVid genuinely knows which corpus documents, which simulation revision and which manifest hash produced a given master, and almost nobody else can say that. `corpora` rows carry the ingested sources, `sim_revisions` carries `revision_number` and `manifest_hash` — a SHA-256 over the **final stored bytes** per file with a canonicalised whole-manifest hash (`shared/src/sim/simManifest.ts`) — and `project_exports.plan` holds the resolved composition. C2PA Content Credentials are now in camera firmware (Sony, Nikon, Leica, Canon) and the EU AI Act transparency labelling obligation lands in August 2026, which its AI assertion type satisfies directly. Emitting the manifest is contained work with a real compliance tailwind.

**How it would work here.** Split it and **ship only the provenance half.** The re-render verifier — "re-run the recipe and get the same pixels, frame hash for frame hash" — is the differentiating claim and it is blocked, not on taste but on three verified facts: the virtual clock in `injection.ts` has never produced a moving frame on a real WebGL package (byte-identical frames is the recorded open blocker, and `localCaptureProvider.ts`'s header states plainly that the compositor never ticks so the back-buffer reads back blank, which is why the local path abandons determinism); capture measures 16.3 s/frame at 1080p against a `wallClockCapSec` of `min(600, 90+dur*6)`; and sim capture is off by default in production, so masters frequently contain posters and `quality_state` reads `'degraded'`. A public re-render endpoint on this host is not a product surface. Note also that no C2PA library exists in the repo, and that the "seed" a manifest would name is **not** a simulation seed — `configHash` covers presentation only.

**Effort.** L (provenance manifest) / blocked (verifier).

**First step.** Test the blocking claim, not the feature: capture the same sim section twice with identical inputs on the production capture path and hash the frames. If run A and run B do not match — or if either is a sequence of identical frames — the verify page is dead and only the manifest survives.

---

### 5.14 The compatibility badge
**What it is.** Surface the simulation-replacement fit report as a durable, linkable result: which sections would still work if you swapped this package in, naming the exact control or API anchor that would break.

**Why it's good.** The hard, defensible part **already ships and is already exposed over HTTP**: `SimBridgeContract.ts` extracts per-section anchors (id | selector | text | class | global | member) from the installed package's combined `bridge.js` and verifies they still resolve in a candidate bundle; `checkReplaceCompatibility` returns a per-section verdict with the exact missing anchors, and it is served at `POST /api/v1/projects/:id/simulations/:simId/replace?dry_run=true` (`simulations.controller.ts:263, 398`). Today it is invisible unless you are mid-upload. Making it a persisted, shareable result on the simulation card is a day, and it is the honest, small version of the "marketplace" idea whose actual blocker is ownership (see 4.13 and 7.4).

**Watch out for.** The contract comes from the **installed** bridge, so you can only fit-check a *replacement* for a slot that already has a simulation — never a candidate into an empty section. And `verifyContract` is **existence-only text matching** across HTML+JS+CSS: it proves an identifier still appears, not that it still behaves. A badge must not claim behavioural equivalence. (The "18/18 against deployed packages" claim is fixture-based — the tests say their fixtures "mirror the anchor shapes found in the DEPLOYED bridges" — not a run against real bytes.)

**Effort.** S.

**First step.** Render the existing dry-run `CompatibilityReport` on the simulation card in the editor Library panel. If authors do not open it, no marketplace built on top of it would be trusted either.

---

## Theme 6 — AI that has something real to point at

Every AI tutor on the market is blind: it knows the exercise id at best. FlowVid is the only product here where the learning artifact is a **live program** that can be asked what it is currently doing. That is the whole theme.

Two guardrail corrections that apply throughout: `sendStructured` gives you the `generation_paused` admin switch and the `token_usage` ledger, but it does **not** moderate (`moderateGenerationInput` is called explicitly by four controllers), and the rolling-24h quota is **off by default**, counts *calls* not tokens, and requires a `userId` that anonymous public viewers do not have. For anonymous surfaces the only real protection is the in-process `rateLimit()` — no Redis, no nginx `limit_req`, 10 DB connections per container. Also: `TaskType` (`LLMProvider.ts:3`) is a closed union with a `Record<TaskType, Tier>` companion (`LLMService.ts:53`), so every new pass is a two-file typecheck-breaking edit.

### 6.1 Ask the Simulation
**What it is.** A tutor you can open on top of a playing lesson that can actually **see** the simulation in front of you — the current slider values, which sub-simulation is on screen, where you are in the section. When you ask "why did it suddenly stabilise?", it reads the live numbers before answering. And when prose is the wrong answer, it moves the controls and says "watch this."

**Why it's good.** It kills the failure mode that makes AI tutors untrustworthy in science teaching: confidently explaining a phenomenon the student is not looking at. Khanmigo's stated differentiator is that it knows which exercise you are on; NotebookLM's Join button hears the podcast but cannot see anything. FlowVid can read the artifact. Nothing else in the category can.

**How it would work here.** Step 1 is **1.1 Read the Sim** — that is the whole transport question, and the serve-time injection route means it works on already-published packages. Step 2 is the security-sensitive write half (1.2): reuse the validated selector charset (`SIM_UI_UNSAFE_SELECTOR_RE` + `SimUiControlSchema`) and validate every proposed action **server-side** against the stored control list from `GET .../ui-controls` or `sim_meta.uiControls`, so a hallucinated knob is refused rather than crashing the sim. Step 3: the context manifest the tutor needs **is real but transient** — `buildContextPrompt` (`SimulationService.ts:2330-2363`) already emits controls with id/type/label/min/max, buttons, selects and globals during bridge generation and never stores it; the queryable substitutes are `simulations.bridge_functions`, `sim_meta.uiControls` and the ui-controls endpoint. Step 4: one `sendStructured` call with a new task type. Step 5: mount beside the already-shipped `AskAvatarButton`/`AvatarPopup` in `client-web/components/viewer/LessonPlayer.tsx:36-38` rather than inventing a surface. Haiku-tier pricing checks out against the real table (`LLMProvider.ts:76`, cached input at 1/10).

**Watch out for.** **The tutor sees the simulation, not the video.** The video's meaning is available only as a Groq-Whisper VTT, so "where you are in the narration" is approximate — do not promise narration-accurate context. Writing to a control is a **new capability class**: nothing today lets an outside party set a value inside a customer's uploaded package, so it needs an explicit refusal path and probably a per-simulation owner opt-in. And the real gate for anonymous viewers is `rateLimit('sim-tutor:'+request.ip, N, 60_000)`, per the sim-rum precedent.

**Effort.** L (S once 1.1 lands).

**First step.** Ship 1.1 first; then a hardcoded prompt with the live state pasted in, asked five real questions on one deployed sim.

---

### 6.2 Office Hours
**What it is.** At the end of a lesson the host avatar offers to talk it through — same face and voice, in real time, over voice — with its knowledge fenced to this lesson. Inside the lesson it teaches Socratically; outside it says so and offers something else instead of bluffing.

**Why it's good.** About **70% already ships** and nobody framed it as a feature. `AskAvatarButton` and `AvatarPopup` are already mounted in the viewer (`LessonPlayer.tsx:14-38`, `PlaylistViewer.tsx:237-256`, `ViewerPage.tsx`); `anamService.buildPersonaConfig` (`anamService.ts:349-421`) already composes a complete **server-side** persona — systemPrompt, an appended KNOWLEDGE block, greeting, language, avatar, voice and `llmId` — from `projects.avatar_config`; a per-project Anam knowledge group and RAG tool already exist behind the knowledge-documents routes; and `memoryService.ts` already gives cross-session memory. So this is prompt composition plus metering on a shipped feature, not a new subsystem.

**How it would work here.** Compose `avatar_config.systemPrompt` from lesson artifacts instead of a static character: the `video_files.captions_vtt` transcript window, `timeline_sections` labels for structure, an explicit refusal contract, and — once 1.1 lands — the live sim state as a tail block. **The real engineering is metering, and it is missing entirely:** `POST /api/v1/avatar/start` uses `firebaseAuthOptionalMiddleware`, so an anonymous viewer can open a session, and there is **no `rateLimit()` on it** — compare avatar-visual (30/60 s) and avatar-image (10/60 s), which are limited (`avatar.controller.ts:245, :266`). Worse for cost visibility, the avatar's brain is Anam-hosted via `llmId`, so **its tokens never reach `token_usage`** and minutes are invisible to every existing usage surface. So: add the rate limit, add a minutes counter with a per-session and per-project cap through `avatarBudget.ts`, and surface it wherever tokens are surfaced. While you are there, give `projects.avatar_config` — untyped `jsonb` with no schema — a zod shape.

**Watch out for.** `/avatar/start` reserves the **worst-case** session length up front and never releases it, because the server cannot trust `/avatar/end`. A Socratic refusal contract lives in a prompt and is only as strong as the model; without retrieval-grounded refusal it will leak outside the lesson. And this modifies a **shipped** feature, so regressions land directly on existing viewers — it needs the viewer e2e path, not just unit tests.

**Effort.** M.

**First step.** For a single lesson, compose the system prompt from its `captions_vtt` plus section labels plus an explicit refusal clause, then ask the live avatar five questions — three inside the lesson, two clearly outside. If it refuses the two cleanly and teaches the three, the fence is a prompt change and the remaining work is metering; if it bluffs on either, this needs retrieval and the estimate doubles.

---

### 6.3 Explain What I Just Did
**What it is.** The system notices the interesting moments in how a learner plays with a simulation — the slider oscillated twenty times, the parameter regime the narration never covered — and offers a twenty-second narrated micro-explanation about **that**, playing over the learner's own live simulation.

**Why it's good.** Because the delivery half **already ships**, and that reprices the whole idea from an XL subsystem to a bounded feature. `GuidanceService` generates cues triggered by observable predicates, synthesises per-language audio to `{sim_prefix}/guidance/{language}/{id}.{hash}.mp3`, and assembles a `guidance.js` that posts `{type:'guidanceCue', id, text, audioUrl}`; `useProjectPlayer.ts:3159-3167` dedupes by cue id, acks with `guidanceFired`, and plays it over the running simulation **with no video render**. A narrated micro-explanation over a learner's own live sim is a shipped feature. The genuinely new part is narrower: author that cue **on demand** for a state the author never anticipated. The content-economics argument gets stronger, not weaker, because the expensive delivery layer is already paid for.

**How it would work here.** Two gaps. **(a) On-demand authoring:** one small `sendStructured` call producing ~60 words grounded in the captured state, one TTS render, one injection into the running guidance list. The content-hashed audio key (`GuidanceService.ts:557-565`) means an identical narration re-uses the stored mp3 — a natural `(section, state-bucket)` cache. **(b) Telemetry**, which does not exist in the assumed form: interaction events need either new columns plus a new kind plus an extended validator on `sim_rum_events`, or (better) the separate table from 3.2, inheriting the same discipline — bounded ring, `rateLimit`, total failure isolation so it can never degrade playback. Detection stays **deterministic client-side**; the model is invoked only after a rule fires and the learner accepts.

**Watch out for.** Every generated clip writes new audio bytes, so **its deleter must be designed at the same time** — keep it under the simulation prefix so it dies with the sim. Per-clip ElevenLabs synthesis is the actual unit cost (the LLM call is a rounding error) and is billed per character against one shared key with no per-project metering (see 7.1). The cue list is stored on `simulations.guidance` as a published artifact, so a learner-specific cue needs a path that does **not** mutate the published package.

**Effort.** L.

**First step.** Skip generation entirely. Add one deterministic client-side rule over the existing guidance evaluator — a slider oscillated N times, say — and have it fire an **already-published** cue out of its normal order. If a well-timed explanation the learner did not expect reads as insight rather than as a nag, the expensive half is worth building; if it reads as a nag, no amount of on-demand authoring downstream will save it.

---

### 6.4 Self-Healing Packages
**What it is.** When a simulation regresses — a bridge anchor renamed by an edit, a control that no longer responds — an agent receives the failure evidence, proposes a minimal repair, and re-verifies. It publishes only if the new run comes back clean **and** complete, and hands a human the diagnosis after two failed attempts.

**Why it's good.** FlowVid has something genuinely rare: a verdict about a generated artifact that is **re-derived rather than trusted**. `canaryJudge` recomputes classification instead of reading a stamped field, separately refuses an incomplete report, and `mayPublishAsModern` gates publication on both; `SimBridgeContract.verifyContract` produces a per-section missing-anchor list resolved statically against HTML+JS+CSS. That means an agent here can be **graded rather than believed**, which is exactly the condition under which agentic repair is safe.

**How it would work here.** Scope to **bridge** repair, not package repair, and the whole loop runs with no browser. `checkReplaceCompatibility` (`SimBridgeContract.ts:354`) already returns exactly the evidence a repair brief needs — per-section missing anchors plus `describeIncompatibility` for a human-readable diagnosis. Feed that plus the package sources into one `bridge_plan` call: that task type already exists, is already tiered `complex`, and is already wired to extended thinking with effort `high` on adaptive models (`LLMService.ts:63-77`), so **nothing is added to the closed TaskType union**. Gate the result on `verifyContract` coming back clean, hard-cap at two attempts, record each attempt with its evidence, and hang the loop on the existing report/`--apply` harness `backend-api/src/scripts/rebuild-sim-bridges.ts`.

**Watch out for.** **There is no browser in production.** `@playwright/test` is a client-web devDependency; `playwright.canary.config.ts` + `e2e/sim-canary.spec.ts` run from a dev machine or CI. The one production browser path is the opt-in `deploy/docker-compose.capture.yml` overlay, whose own comments require root host setup and ≥4 GB on a host recorded as OOM-killing plain assembly. So the strongest oracle cannot run inside the loop; keep the canary where it is, as a publication gate. Two traps the code documents: revision status `canary_passed` does **not** prove a canary ran (check `canary_report`/`canary_at`), and `verifyContract` proves anchor **existence**, not structure — resolving against HTML alone falsely failed 3 of 7 deployed sections, which is why it searches HTML+JS+CSS. A bridge that passes can still be semantically wrong, so publish as a **new revision** through `RevisionService` and never flip `active_revision_id` without a human or a real canary. Note `revisionGcSweep.ts` is on `origin/main` and absent from the local checkout — repair revisions would accumulate until you rebase.

**Effort.** M.

**First step.** Run `rebuild-sim-bridges.ts` in report mode against production, pick one simulation whose `checkReplaceCompatibility` reports missing anchors, and hand that report plus the sources to a single `bridge_plan` call. If the returned bridge makes `verifyContract` come back clean on a failing section, the offline loop is real; if the model cannot repair a case where the exact missing anchor is handed to it, no orchestration will help.

---

### 6.5 Course Memory
**What it is.** After each lesson is finished, an agent records what was actually taught — terms defined, notation used, what was promised for later, what was simplified — so lesson 7 uses lesson 3's notation and never re-explains what the learner has already been told.

**Why it's good.** This is the difference between a course and a pile of videos, and the drift it prevents is exactly the kind learners experience as "this course is confusing" without being able to say why. FlowVid has **already built and shipped the mechanism for podcast series**: `PodcastMemory.ts` is 74 lines that on approval summarise via one `podcast_memory` call into `MemorySummarySchema`, upsert onto the episode, and rebuild `podcast_shows.memory_json` newest-first capped at `MAX_REMEMBERED_EPISODES = 12`, best-effort and non-blocking on failure. Porting the producer is cheap.

**How it would work here.** The **consumer** must change, because there is no lesson generator to inject memory into. Source from `video_files.captions_vtt` plus `timeline_sections` labels plus the lesson's attached simulations — what the lesson actually contains, not what a generator intended. Storage: `course_lessons` has no jsonb column, so this needs one migration plus its `migrate.ts` entry (CI's migration-audit compares the directory against that runner **and** the previous release tag). Rolling memory ordered by `course_lessons.position`. Consumer: a **pure function** over the accumulated defined-term set that warns the author when a lesson uses a term no earlier lesson introduced, and points at the lesson that would fix it. Make it a real pure module with real fixtures — this workspace's own lesson is that a source-text test let four viewer regressions ship.

**Watch out for.** Sell it as **continuity QA, not cost control**: unlike the podcast version there is no doomed generation to refuse, so it saves nothing and only prevents confusion. Lesson content is a Whisper transcript, so defined-term extraction inherits ASR errors. There is no per-lesson "approval" event to hook — podcasts have one, courses have `publish_state` on the course.

**Effort.** S.

**First step.** Run the existing `podcast_memory_scribe` prompt over two lessons' `captions_vtt` and diff the returned `defined_terms` sets by hand. If lesson 2 demonstrably uses terms lesson 1 never defined and the extractor catches it, the gate is worth a migration; if the sets are noise, you spent two API calls to avoid a schema change.

---

### 6.6 Cold Read
**What it is.** Before a lesson goes out, a small panel of specialist critics reviews it: a Fact Auditor, a Confused Learner who marks the exact timestamps where a newcomer loses the thread, a Pace Editor, and a deterministic linter. Five timestamped notes instead of a wall of unknown quality.

**Why it's good.** The pattern is **proven inside this repo**: `ScriptRoom` runs exactly this panel on podcasts today — three critics in one `Promise.all` over a shared prefix (`ScriptRoom.ts:168-191`), with `scriptLint.ts` as the deterministic co-signer catching the AI-tells the LLM judges generate and therefore cannot see, plus a `fact_auditor_verify` re-audit at `:235`. It is simply pointed at the wrong artifact for video. Reviewing your own 12-minute recording is slow and you cannot see your own blind spots; five timestamped notes keyed to sections is a genuine time saver plus a quality number you can trend.

**How it would work here.** Point it at the transcript: findings as `{timestamp, severity, quote, problem, suggested_fix}` keyed to section ids so the editor playhead can jump to each. Instance-specific rubrics need learning objectives, which do not exist on `projects` — derive them from the transcript in the same pass, or read `courses.learning_outcomes` when the project is a course lesson. Counter judge positivity bias by **forcing a top-3 even when the critic wants to say "looks great."**

**Watch out for.** **Reframe the claim.** There is no generated lesson script to critique — the only text is a Whisper VTT of the creator's own recording — so this is "notes on your recording," a different and more modest product claim than "QA the generator." ASR errors will produce phantom fact findings; the Fact Auditor cannot tell a mis-transcription from a mistake. Three new task types touch the closed union. And backend coverage measures `src/services/**` only, so the controller wiring needs deliberate tests.

**Effort.** M.

**First step.** A throwaway script under `backend-api/src/scripts/` that feeds one real project's `captions_vtt` plus its section list into the existing ScriptRoom review prompts. Read the five notes. If they are not more useful than re-watching the video, the idea dies for a dollar and you never touch a controller.

---

### 6.7 Claim Ledger *(podcast)*
**What it is.** Every factual sentence the podcast pipeline writes is recorded with a pointer to the exact passage of the uploaded source it came from. Unsupported sentences are flagged before render as "cut, or add a source." Listeners get a Sources rail that highlights the supporting passage as the narration reaches each claim.

**Why it's good.** Measured citation hallucination in deployed systems runs 11%–57% (arXiv 2605.06635), and for anyone putting their name on explanatory media a single confidently-narrated wrong fact is **unfixable after publication** because it is baked into rendered audio. The receipt is a sales asset and a real quality floor. Honest framing: this is an **upgrade to a check that already exists** — ScriptRoom already runs a Fact Auditor plus a re-audit — from prose findings to **span-level receipts**.

**How it would work here.** (a) Extend the turn schema in `backend-api/src/services/podcast/schemas.ts` so each turn carries `claim_spans[]` referencing a `podcast_sources` row plus a character offset. (b) Chunk `extracted_md` once at ingest and keep offsets — note `podcast_sources` has `extracted_md` but **no hash column**, so "the hash is already there" does not transfer; that is a migration. (c) A batched decomposed-entailment pass per section on the utility tier scoring supported/unsupported/contradicted, stored beside the existing `review_json` on `podcast_scripts`, blocking approval on any `contradicted`. (d) Add the new task to `QUOTA_EXEMPT_TASKS` (`LLMService.ts:46`) so it never eats a user's interactive cap. Costs are trivial on the real table (Gemini 2.0 Flash at $0.00001/token in).

**Watch out for.** It is **podcast-only**: `corpora` has no consumer in the video path, so there is no video-side producer to instrument. Adding `claim_spans[]` changes a creative-tier output schema — the most expensive prompts in the product to regress, with a documented refusal-retry path on Opus. And a span is only a receipt if it actually appears in the cited source.

**Effort.** M.

**First step.** Add `claim_spans[]` to one pass's output schema, run the existing Fact Auditor prompt over three real episodes, and **measure how often a returned span literally appears** in the cited `podcast_sources.extracted_md`. That single number decides whether this is receipts or theatre, and it costs three API calls.

---

### 6.8 Paper to Course
**What it is.** Paste an arXiv link, a docs site or a YouTube lecture. An agent ingests it and proposes a course outline — lessons, objectives, a one-line brief per simulation — and **waits**. You edit the outline, hit go, and it scaffolds.

**Why it's good.** The cold-start problem is real and the ingest half genuinely exists: `CorpusBuilder` plus seven ingesters already turn PDF/web/YouTube/audio/image/doc into hashed markdown. The human gate at the outline is the right design — it is where the user gets to be the expert and it costs pennies before anything expensive runs. Note that the ingest half has been sitting **unconsumed**, which is itself a demand signal worth reading.

**How it would work here.** Be precise about where it stops. `course_lessons` requires an existing `project_id` with a `uniq_lesson_course_project` constraint, and a project only becomes watchable when a human uploads or records a video; `CoursePublishingService` allocates slugs and drives publish state but creates no content. So the buildable thing is a **planner plus a scaffolder**, not a pipeline driver: one `sendStructured` call on the complex tier over an already-ingested corpus returning `{lessons[], objectives[], sim_briefs[], prerequisite_edges[]}`; render it as an editable plan (MCP's elicitation pattern maps cleanly onto the SSE shape already used by the guidance streams); on approval create the `courses` row, N empty `projects`, and `course_lessons` rows with objectives attached — then hand each sim brief to the **one generator that works**, the avatar single-file sim generator (`visualService.buildSimPrompt`). The user still brings the video. Run the outline call through the **queue**, not the request path: a 40¢ complex-tier call against a 10-connection pool is not a request-path operation.

**Watch out for.** Courses are org-scoped (`courses.org_id`) and lesson publishing is org-checked, so the planner needs an org context that anonymous or single-user flows do not carry — see 7.4. And the objectives it emits should be designed to feed 2.7 from day one.

**Effort.** L.

**First step.** Take one already-ingested corpus, run a single outline call, then hand **two of the sim briefs unedited** to the existing avatar sim generator and watch what comes out. If the briefs are not specific enough for the one generator that works, the outline is a document rather than a pipeline.

---

### 6.9 What-If Fork
**What it is.** A learner types "what if gravity were half as strong?" and gets a working, playable fork of that exact simulation beside the original.

**Why it's good.** The counterfactual question is the moment a learner's curiosity fires, and today FlowVid's answer is nothing. A viewer who **created** something inside your product behaves differently from one who watched.

**How it would work here.** The honest version is much smaller than the pitch. There is **no LLM-patch path for a multi-file customer package**: `POST .../simulations/:simId/replace` swaps files the *user* supplies and gates them with `checkReplaceCompatibility`; `bridge_plan` writes the **bridge** that drives an uploaded sim, not the sim itself. The one shipped route matching this shape is `POST /api/v1/projects/:id/avatar/library/:visualId/edit-simulation {instructions}` (`avatar.controller.ts:621`), which LLM-edits an **avatar-generated single-file** sim, offered by `ExtendedLibraryModal` only when `visual_type==='simulation' && visual_spec.source !== 'zip'`. That is the honest v1: forks of generated single-file sims, rendered through `client-web/components/avatar/SimulationOverlay.tsx`, which already handles readiness and reveal via `useSimRuntime`.

**Watch out for.** Verification cannot use the canary (no browser in production, see 6.4). `sim_revisions` has **no ephemeral or learner-owned tier** — revision numbers come from a row-locked counter, activation is a compare-and-set against a partial unique index, and GC has a keep floor, so learner forks would pollute the publication machinery. `simulations` has no visibility column and `/sim-public/*` is unauthenticated by design, so a learner's fork is world-readable by URL. And anonymous viewers have no `userId` for the quota or the ledger, while Opus-tier generation per fork is the most expensive call in the product.

**Effort.** XL (M for the single-file version).

**First step.** Wire the already-shipped `edit-simulation` route to a "what if…" box over an avatar-generated single-file sim in the viewer, and run 10 real counterfactual prompts measuring end-to-end latency and how often the result still runs. If a single-file edit cannot come back correct and fast, the multi-file version certainly cannot.

---

## Theme 7 — The business

Of sixty-plus ideas in the sweep, exactly one made the business cheaper, **none** made it money, and none reduced risk. This theme is that gap. A competitor does not have to beat "Keep the Knob" — they have to sign an institution, and FlowVid currently cannot produce a privacy policy, a VPAT, a seat, an invoice line, or an RSS feed. Comparable products price at $22–67/seat/month ([Synthesia](https://www.creatorstackclub.com/software/synthesia)) or sell unlimited learners with $100/month admin seats ([Coursebox](https://www.coursebox.ai/pricing)).

### 7.1 Cost of Goods
**What it is.** A per-project cost number — LLM tokens, TTS characters, GPU capture minutes, avatar minutes, storage bytes, egress — visible to admin per project and per user, and to the creator as "this lesson cost X to make."

**Why it's good.** Roughly a dozen ideas in this document have a blocker written as "this is a billing decision before it is a UX one" — Steerable Draft, Teach It Back, Office Hours, Explain What I Just Did, What-If Fork — and **not one of them can be settled, because the number does not exist.** Half the meter is already built and nobody finished it: `token_usage` carries `project_id` and `cost_cents` as `doublePrecision` (migration 046 made it fractional specifically so sub-cent utility calls do not round to free). The other half is completely dark: no ElevenLabs character accounting anywhere in `services/usage/`, no Anam minute ledger (the avatar's brain is vendor-hosted so its tokens never touch `token_usage`), no GPU capture-minute record on `project_exports`, and no storage attribution — on a bucket whose census has never been run. A company that cannot state gross margin per unit cannot price 7.2, cannot approve a per-viewer LLM feature, and cannot tell a lossy customer from a profitable one.

**How it would work here.** One `resource_usage` table with `(project_id, user_id, kind, quantity, unit, cost_cents, occurred_at)` and a thin `meter(kind, qty, ctx)` helper called at five spend points: `LLMService` (already instrumented — backfill the shape), `GuidanceTTSService` and `PodcastVoiceService` (characters), `anamService.start` (reserved minutes, which the existing worst-case reservation makes easy), `ProjectExportService` (wall-clock capture seconds from the migration-061 progress fields), and the storage adapter (bytes written per prefix). Roll up nightly. Show it in admin first; show creators a rounded figure only once it is trusted.

**Effort.** M.

**First step.** Meter the **two unmetered vendors only** — `GuidanceTTSService` and `anamService` — and run for a week. If avatar minutes turn out to be the dominant line, 2.8 and 6.2 get re-priced before anyone builds them.

---

### 7.2 A Plan, Not a Purchase
**What it is.** A recurring subscription with seats and quotas alongside the existing per-video unlock: a creator tier that lifts generation caps, and a team tier that bills per editor seat.

**Why it's good.** FlowVid's billing rail is real and good — `024_billing.sql` gives `billing_transactions` with `platform_fee_cents` and `creator_payout_cents`, `user_purchases` with a `UNIQUE (user_id, content_type, content_id)`, Stripe Checkout, a customer portal, refund and dispute handlers, and an admin dashboard already reporting gross revenue, payouts and fees. But it is a **marketplace** rail: FlowVid takes a cut when a creator sells one video to one viewer. **There is no way for FlowVid to charge for FlowVid.** `BillingService.hasAccess(userId, contentType, contentId)` cannot answer "is this account paid" — which is exactly why the watermark-loop idea collapsed and why every LLM-cost blocker in this sweep has no revenue line to sit against. Meanwhile the quota that governs cost (`RateLimitService`, 100k tokens/week) is a flat cap with nothing to upgrade to. Every competitor monetises the **creation** side monthly; FlowVid monetises only the consumption side, once.

**How it would work here.** Add `subscriptions` (stripe_subscription_id, plan, status, current_period_end, seats) and `plan_entitlements` as a **pure module** mapping plan → {monthly token budget, export minutes, sim generations, seats, watermark on/off}. Extend `stripe-webhook.controller.ts` — which already handles checkout, refund and dispute events — with `customer.subscription.*`. Make `RateLimitService` read the entitlement instead of a constant, and give `LockPriceControl` a sibling: a plan picker. The seat half needs 7.4.

**Effort.** L.

**First step.** Do not write code. Take the admin dashboard's gross-revenue and payout numbers, put them beside the last 30 days of `token_usage.cost_cents` summed by user, and see whether the platform fee on marketplace sales covers the LLM bill of the people generating.

---

### 7.3 Payouts and Audience
**What it is.** The creator's business view: revenue, refunds, pending payout, per-lesson sales, views by source (permalink / share token / course page / embed), and completion — with a CSV export.

**Why it's good.** Three sweeps proposed per-second heatmaps and all three were blocked on telemetry that does not exist. Meanwhile the **simple** creator numbers already exist server-side with no creator-facing surface: `billing_transactions` records every sale with the creator's id and payout, `projects.view_count` and `playlists.view_count` increment on every anonymous hit, and `admin-web/app/dashboard` renders all of it — **for FlowVid staff**. A creator who has sold five videos through FlowVid's own Stripe rail cannot see that they sold five videos. This is the least glamorous idea here and the only one where a creator's most-asked question is answerable today with a `GROUP BY`.

**How it would work here.** One owner-scoped endpoint aggregating `billing_transactions` by `creator_user_id` and content, joined to `projects`/`playlists` for titles, plus view counts. Do the aggregation **in SQL** — the precedent to avoid is `GET /branch/analytics`, which `findMany`s every event row and reduces in Node against a 10-connection pool. Add a `source` column to the view-count increment path so permalink / `/v/` / `/c/` / embed traffic can be told apart; that is the one schema change. Render in the existing home sidebar, not a new app.

**Effort.** S.

**First step.** Write the two aggregate queries and paste the output for one real creator into a text file. If the numbers are all zero, **that is the finding** — and it re-prices half this document.

---

### 7.4 Teams
**What it is.** Org membership with roles — owner, editor, reviewer, viewer — so more than one person can work on a course and an institution can buy more than one seat.

**Why it's good.** This is the single most-cited missing foundation in the entire sweep and **nobody proposed it as an item**. `orgs` is four columns — `id, name, owner_user_id, created_at` — with no membership table, and `users.default_org_id` is one nullable pointer. Six independent analyses tripped over it and filed it as somebody else's blocker: Sim Kits ("nothing to scope an org-level kit to"), Brand Kit ("org-level has no meaning in this schema"), Margin Notes ("`editableProject` grants full edit to every collaborator — there is no reviewer role"), Institution Pack ("no seat model, no admin console"), The Commons, and the seat half of monetisation. When six sweeps trip over the same absent table, **that table is the roadmap item and the six features are its consequences.** It is also the gate on B2B revenue: you cannot sell per-seat to an organisation that cannot have members.

**How it would work here.** `org_members (org_id, user_id, role, invited_by, joined_at)` plus an invitation flow. Then the real work, which is authorization, not schema: `collabAccess.editableProject` currently grants full edit to every row in `collaborators`, and `requireProjectAccess` has exactly three branches. Introduce roles as **one capability function with exhaustive tests**, not per-controller checks. Scope projects and courses to orgs on write, keeping the personal-project path intact.

**Effort.** L.

**First step.** Write the permission matrix — roles × the ~20 mutation surfaces — on one page and check it against what `editableProject` grants today. The gaps you find are the security review you were going to need anyway.

---

### 7.5 The Paperwork
**What it is.** The documents an institution cannot buy without: privacy policy, terms, a subprocessor list, a DPA, a security overview, a stated retention policy, and an explicit position on under-13 learners.

**Why it's good.** **Zero hits** across the whole repo for "privacy policy", "terms of service", "GDPR", "FERPA", "COPPA", "DPA" or "subprocessor" — the only file mentioning any of it is an architecture markdown. This document contains a SCORM/LTI Institution Pack correctly gated behind Frame Pass; it is actually gated behind **this**. No school district signs a package from a vendor with no privacy policy, and no university procurement office gets past the first form. It is also a live product problem: FlowVid writes anonymous per-session telemetry (`branch_path_events.session_id`, `sim_rum_events.session_id`) and mints a **durable browser identity** (`localStorage['avatar_anon_id']`, a crypto UUID keyed to `avatar_profiles`) on public pages with no notice and no consent surface anywhere — and several ideas here propose *extending* that identity into per-learner profiles. Doing that before there is a policy turns a documentation gap into a regulatory one.

**How it would work here.** Mostly not engineering. The engineering parts: a `/legal/*` route set (static, ISR, in the sitemap), a footer link on every public surface, a consent/notice component on pages that write telemetry, and a documented retention window enforced by a scheduled delete on the event tables. The rest is a lawyer, a subprocessor inventory (Firebase, Supabase, Stripe, Anthropic/OpenAI/Google, ElevenLabs, Groq, Anam, Cloudflare/R2), and a decision on whether under-13 learners are in scope — because if they are, COPPA changes the anonymous-identity design and therefore changes 2.7, 3.2 and 3.3.

**Effort.** S in code; a decision with a calendar, not a sprint.

**First step.** Write the subprocessor list. Twenty minutes, first thing every buyer's questionnaire asks for, and producing it forces the retention question into the open.

---

### 7.6 Your Data, On Request
**What it is.** Account deletion that actually deletes, and a project/account export that hands back everything: video, simulation packages, transcripts, captions, timeline, branching graph, metadata as JSON.

**Why it's good.** There is **no account-deletion endpoint anywhere** in `backend-api/src/controllers` and no data-export path. For a product that takes payment cards through Stripe, stores uploaded video and writes anonymous learner telemetry, that is an exposure: GDPR erasure and portability are not optional for an EU user. And the storage-leak memory in this workspace records that FlowVid already loses track of bytes on **ordinary** deletes (~30 writers against 11 deleters, census never run in production) — so an account deletion built on that foundation would silently leave a person's video in a bucket forever. Separately, "we hold your course hostage" is the most common objection to an AI course tool, and an export is the cheapest answer to it.

**How it would work here.** Sequence deliberately. (a) **Run `deploy/scripts/storage-census.sql` in production first** — deleting an account is the operation that most needs a complete map of what is reachable. (b) **Export before deletion**: a queued job assembling a zip using the AdmZip pattern from `simulations.controller.ts:627`, plus a `manifest.json` of every row scoped to the user, delivered as a presigned link rather than a buffered response. (c) Deletion as a two-phase soft-delete with a grace window, reusing the cascade already declared on `project_id`, followed by a verification sweep asserting zero remaining objects under the user's prefixes. Keep `token_usage` and `billing_transactions` — both already use `ON DELETE SET NULL` for exactly this reason, which is a good decision someone already made.

**Effort.** L.

**First step.** Run the storage census. Everything else here is uncostable until that number exists.

---

### 7.7 Moderating What Comes Out
**What it is.** Extend safety from the prompt to the artifact: moderate generated narration, generated simulation code and live avatar conversation; give public pages an abuse-report path; give admins a takedown.

**Why it's good.** `moderateGenerationInput` is called in exactly four places — `projects.controller.ts` (×2), `playlists.controller.ts`, `podcast-script.controller.ts`, `broll.controller.ts` — and every call site passes `{userId: user.id}`, so it is **authenticated-input-only. Nothing moderates output.** The generated simulation is arbitrary HTML/JS that FlowVid writes, stores and then serves from `/sim-public/*`, an intentionally unauthenticated route — and this document proposes making that surface *more* public (5.4, 5.9, 5.10, 5.6) while also proposing to let learners trigger generation into it (6.3, 6.9). Meanwhile `POST /api/v1/avatar/start` is anonymous-capable with **no rate limit at all**, so a real-time conversational avatar talks to unauthenticated members of the public — possibly children — with no output moderation and no transcript review. There is no abuse-report button on any public page and no takedown tooling in `admin-web`, whose nav is feature-flags, llm-config, users, billing, api-keys and system-prompts.

**How it would work here.** Three layers. (a) Output moderation on the two learner-facing text paths: guidance narration at publish time (it already has a human review gate in `SectionEditor` — put the automated check beside it) and avatar conversation via the vendor's moderation hooks plus a stored, admin-visible transcript sample. (b) A generated-code policy pass — not a sandbox replacement, but a check for network calls and external endpoints in generated sim source before publication. (c) A report-content endpoint (rate-limited on `request.ip`, following `sim-rum.controller.ts:68`) writing to a queue, and an admin page that can flip a project to unlisted and revoke its share token in one action.

**Effort.** M.

**First step.** Put a rate limit on `POST /api/v1/avatar/start` **today**. One line, the only unlimited anonymous *billable* endpoint in the product, and a safety and a cost fix at once.

---

## Theme 8 — Reach: accessibility, language, device

### 8.1 Conformance, not good intentions
**What it is.** Keyboard operability of **simulation** controls, a documented conformance report (VPAT/ACR) against WCAG 2.2 AA and EN 301 549, and an automated axe pass over the viewer as shipped.

**Why it's good.** An interactive simulation is by default the least accessible thing on the internet — a canvas full of meaning with no text in it — and this is the thing that fails an audit **first**, before audio description. `client-web/__tests__/a11yOperableControls.test.tsx` enforces accessible names and keyboard reachability **through the accessibility tree** — for app chrome. A simulation is a sandboxed iframe of arbitrary customer HTML, and nothing tests it, requires it, or reports on it. So the product's flagship interactive object is, in the general case, mouse-only and unnamed. Institutions ask for a conformance document **before** they ask for SCORM, the European Accessibility Act deadline has already passed, and accessibility effort is the standard published drawback in this category. It is also the honest home for the "steer the sim with hand gestures" impulse: sustained mid-air gesture is generally *worse* for tremor, limited reach and fatigue than a keyboard, so the inclusive win is the keyboard.

**How it would work here.** (a) Turn `SimUiControls.ts` — which already inventories every control with a selector, a kind and a human label — into a **requirement**: at publish time, flag controls that are not focusable or lack an accessible name, and surface a per-simulation accessibility score in the editor the way `canaryJudge` gates presentability. (b) Give the rAF gate a keyboard path so the platform can operate a control the package left unreachable — **sharing the write channel from 1.2**, so this is nearly free once that lands. (c) Add an automated axe pass over the real viewer to CI. (d) Write the ACR from the results, honestly, including the partial rows.

**Effort.** M.

**First step.** Tab through one published lesson end to end, **including its simulation**, and write down where focus dies. That list is both the backlog and the first draft of the conformance report.

---

### 8.2 Described and Audible
*(merges "Nothing Unspoken" and "Audible Physics" — they share the same tap into the guidance layer)*

**What it is.** Three things off one mechanism: a live screen-readable state region ("separation 0.4, flock has split into two groups") updating as the learner changes it; a real audio-description track for the stretches where something happens on screen while nobody speaks; and a second soundtrack made out of the simulation itself — pitch tracking a population, a click on each collision, stereo position following a particle.

**Why it's good.** The audio-description half is **the most under-recognised asset in the repo**: FlowVid already generates spoken narration bound to live simulation state, from the simulation's own source, with TTS audio pre-rendered. It just fires as an *interaction coach* — once per cue, on a 10-second global cooldown, and only while automation is OFF — so it never functions as a described track for a learner who cannot see the screen. Turning a coach into a track is a small change with a large claim attached: **a genuinely described interactive physics demo is something no AI-video competitor can produce**, because they are describing their own rendered pixels while FlowVid describes ground truth. The live region is separately the cheapest real accessibility win available and costs **nothing per view**, because it reads actual values rather than calling a model — there is currently **no `aria-live` region anywhere** in `client-web/components/viewer/`. And sonification has a shipped precedent worth copying: Highcharts Sonification Studio was built with blind participants from phase one.

**How it would work here.** All three tap the same place. **Live region:** reuse 1.1's `readSimState`, render into an `aria-live="polite"` region next to the existing presentation layers so a screen reader narrates it natively. **Described track:** in `GuidanceService`'s generated `guidance.js`, (a) lift the `_active(){ return _gate && !_autoScript }` gate so cues also fire during automated playback, (b) drop fire-once/`_COOLDOWN` for a described-track mode, (c) ship it as a **second VTT text track** rather than an audio track — VTT is already the storage format, `GET /api/v1/videos/:videoId/captions.vtt` already serves it, and the DB is already source of truth (migration 033). **Sonification:** a Web Audio mapper in `client-web` polling the same `S` observables and mapping chosen scalars to pitch/rate/pan, toggled in `ControlsBar.tsx` (which already carries a captions toggle as the UX precedent). **Alt text** is nearly free while you are here: `avatar_visuals.alt_text` already exists as a column and `PATCH /api/v1/projects/:id/avatar/library/:visualId` already accepts `{altText}` (`avatar.controller.ts:641`) — nothing generates it, and `image_caption` is already a live task type in `QUOTA_EXEMPT_TASKS`.

**Watch out for.** **Do not promise real audio description**: `buildPlayerConfig` has no alternate audio track, the player has no track selector, `HLSTranscoder.ts` emits one audio track per variant with no `EXT-X-MEDIA` alternate audio group, and `ffmpegGraph.ts` mixes everything to one stream. A text description track is a *partial* WCAG answer, not conformance — say so. `DOMAIN_EVENT` is **not** the tap: it is defined and consumed at `SimRuntimeClient.ts:1403` but no shipped bridge produces it. Guidance narration is LLM-authored with a confidence score and warnings, so shipping it as accessibility copy needs an author review step, not auto-publish. A live region that fires on every slider tick will spam a screen reader — it needs debouncing and a semantic summary, which is design work the estimate must carry. And sign language is entirely vendor-shaped (Signapse/SyncWords) with no foothold here: out of scope, not a later phase.

**Effort.** M (live region + described track) / L (with sonification).

**First step.** Take one published simulation that already has guidance entries, flip the `!_autoScript` gate and the fire-once guard behind a query flag, and **play the lesson with your eyes shut.** One afternoon. If the existing cues do not describe the screen well enough to follow the lesson blind, the described-track claim dies before any Web Audio work starts.

---

### 8.3 Right to Left
**What it is.** Make FlowVid usable, and publishable, in Hebrew and Arabic: `dir`-aware layout, logical CSS properties, locale-correct dates and currency, a `lang` on the `<html>` element that matches the content, and `hreflang` on public pages.

**Why it's good.** The founder writes Hebrew, and the codebase already admits it in exactly one place: `backend-api/src/services/seo/SlugService.ts` carries a hand-built Hebrew→Latin transliteration map with niqqud stripping and maqaf handling, because someone hit the problem and solved it **for slugs only**. Everywhere else the product is monolingual by construction — `client-web/app/layout.tsx:55` hardcodes `<html lang="en">`, the string `dir="rtl"` appears **nowhere** in the repo, `hreflang` appears zero times, and `PaywallOverlay.tsx` formats every price with `Intl.NumberFormat('en-US')` regardless of the creator's currency. A Hebrew creator today authors right-to-left prose into left-to-right inputs, and a Hebrew lesson page tells Google it is English. Two sweeps noticed this in passing and both filed it as a blocker on somebody else's feature rather than as the work.

**How it would work here.** Three separable layers, cheapest first. **(a) Correctness:** resolve `lang`/`dir` per page from `courses.language` / `course_lessons.language` — which already exist and today only reach OpenGraph `locale` via `client-web/lib/seo.ts:28` — and emit `hreflang` alternates from `SitemapService`. **(b) Layout:** replace directional Tailwind utilities (`ml-`, `pr-`, `left-`, `text-left`) with logical equivalents (`ms-`, `pe-`, `start-`, `text-start`) across editor and viewer, with a lint rule so it does not regress; the timeline and scrubber need explicit attention, because a scrubber that fills from the left is wrong in RTL. **(c) Chrome:** extract UI strings to a catalogue — no i18n library is installed, so this is a real dependency decision that must clear the frozen-install release gate.

**Effort.** M for (a)+(b); L with (c).

**First step.** Set `dir="rtl"` on one seeded Hebrew lesson page and screenshot it. The list of things that break **is** the backlog, and it takes an hour to produce.

---

### 8.4 Translate what's inside the simulation
*(the surviving, buildable core of both dubbing ideas)*

**What it is.** Publish a simulation's spoken guidance in another language, and translate the text **inside** the simulation — the slider labels, the button text, the axis captions.

**Why it's good.** The novel half is real and nobody else can do it: for a physics or economics simulation **the labels ARE the content** — "separation", "cohesion", "alignment" are the concepts — and translating them requires a machine-readable inventory of the artifact's own text, which FlowVid has and competitors do not. And the unglamorous half is **already 80% built and nobody noticed**: guidance narration is language-partitioned end to end, from the language picker in the editor (`SectionEditor.tsx:21-33`, already offering `he` and `ar`) to the storage key — `GuidanceService.publishGuidance` writes cue audio to `{sim_prefix}/guidance/{language}/{id}.{hash}.mp3` (`:563`), and `resolveGuidanceVoice` already defaults every non-English language to `eleven_multilingual_v2` (`GuidanceTTSService.ts:21-32`). The content-hashed filename means re-publishing an unchanged narration re-uses the stored mp3. PhET's translation utility reached 130+ languages through community translators with minimal computer expertise; that on-ramp is real.

**How it would work here.** (a) **Guidance in another language** is nearly free: key the stored cue list by language instead of overwriting (it is language-partitioned in storage but not in `simulations.guidance`), and add a language selector in the viewer. No new package revision, therefore no canary run, therefore no new bytes beyond the regenerated audio. (b) **Label translation** must go through `RevisionService` as a **new immutable revision** (draft → beginUpload → writeFile → finishUpload → validate → activate), never an in-place rewrite — `SYSTEM_OWNED_SEGMENTS` forbids writing into `revisions/` and those bytes are pinned immutable. The safety net is genuine: `verifyContract`/`checkReplaceCompatibility` resolve anchors including **label text** against HTML+JS+CSS and will catch a translation that orphans an anchor a bridge section binds to.

**Watch out for.** **Cut video narration dubbing.** A lesson's narration is baked into the uploaded video's audio and its four HLS renditions — `HLSTranscoder.ts` emits single-audio tiers with no alternate audio group — so a dubbed lesson is a whole new `video_files` row plus a full ladder plus captions plus a thumbnail, roughly the storage footprint of the original lesson **per language**, on a bucket whose census has never been run. And ElevenLabs is wired for the podcast side only (`podcast_shows.teacher_voice_id`, `revoiceTurn.ts`), not the lesson video pipeline. Label translation multiplies package storage and the **poster identity space** (posters are keyed by `packageRevision` with no fallback, so every translated revision loses its poster until a canary re-mints one). And a translated simulation renders inside English LTR chrome unless 8.3 lands with it.

**Effort.** M.

**First step.** Re-publish guidance for one existing simulation in Spanish (or Hebrew) through the shipped `publish-guidance/stream` route and confirm the audio lands under `.../guidance/es/` and the cues fire in the viewer. That proves the language-partitioned half in an afternoon, shows exactly how the cue list needs to be keyed, and tells you what label translation would really cost.

---

### 8.5 Honest on a Phone
**What it is.** Decide, per surface, what mobile means — make the viewer genuinely good on a phone, and make the editor **say plainly** that it needs a bigger screen instead of rendering a broken timeline.

**Why it's good.** The viewer is *partly* handled: `viewer.css` has four media queries (including two `max-height: 420px` landscape cases) and every `<video>` carries `playsInline`. **The editor is not handled at all** — `VideoEditor.tsx` and `SectionEditor.tsx` contain zero `onTouchStart`/`pointerdown` handlers and zero responsive breakpoint utilities, and `TimelinePanel.tsx` has exactly one pointer handler in 2,293 lines. So a creator who opens FlowVid on an iPad gets a pointer-captured scrubber that pointer events never reach, **silently**. Nobody in six sweeps opened the product on a phone. It matters more here than in most products for a specific reason the sweeps did establish: the audience for a simulation-heavy lesson is disproportionately mobile, and the documented budget is "one live heavy sim at a time" measured at ~6.7 fps under 6× CPU throttle. Mobile is where the flagship feature is weakest and least observed.

**How it would work here.** (a) **Viewer:** verify the sim overlay under a phone's landscape/fullscreen transitions and orientation change — `SimPresentationLayers.tsx` reveals by opacity swap and the **aspect it was proven at is part of `configHash`**, so a rotation is an identity change nobody has tested. Add a real fullscreen path (inherit the `SimSurface` `allow` prop fix the mini-site plan already identified, and its `AdminSimSurface` twin, since `passiveSimSurfaces.test.tsx` pins DOM parity). (b) **Editor:** one viewport guard rendering a clear "FlowVid's editor needs a wider screen — here's your project on a phone instead" panel linking to the viewer. That is a day, and it converts a broken experience into an honest one. (c) Only then decide whether touch editing is worth building.

**Effort.** S (honest version) / L (touch editing).

**First step.** Open one real project's editor on an actual phone and screenshot it. Ship the guard the same afternoon.

---

## Theme 9 — The floor

Three small things that multiply the safety and the value of everything above.

### 9.1 Behind a Flag
**What it is.** Put every item in this document behind the feature-flag system that already exists, with per-project and per-user targeting and a documented kill switch.

**Why it's good.** `admin-web/app/feature-flags/` exists and is live, alongside `llm-config`, `system-prompts` and a maintenance-mode toggle — and **not one of sixty-plus ideas mentioned it**. That matters because almost every proposal here modifies the viewer (a 4,198-line hook with a documented history of wrong-frame incidents) or the export path (which fails closed by design since migration 059). Shipping Keep the Knob, Playable Link, Office Hours or a new gate version without a per-project rollout and a one-click revert means every regression is a **deploy** — and the deploy path is deliberately build-free and image-pinned. The single most valuable sentence that could be added to every "now" verdict here is *"behind flag X, defaulting off, with a named owner who can turn it off from admin."*

**How it would work here.** Extend the existing flag store with targeting (user id, project id, percentage) and a **typed accessor shared between backend and client** so a flag name cannot be misspelled into permanent-off. Emit the active flag set into `PlayerConfig` — noting that the public lesson config is ISR-cached at 300 s and shared across viewers, so per-viewer flags must be resolved client-side from an uncached endpoint or not at all. Add a flag-state line to the release audit so a deploy records which flags were on.

**Effort.** S.

**First step.** Gate one shipped behaviour behind the existing flag end to end, then turn it off in production and confirm the viewer changes within a page load. If it does not, the flag system is decorative and every rollout plan in this document is fiction.

---

### 9.2 When It Breaks
**What it is.** An error boundary and a not-found page, user-visible job failure with a retry, and a runtime error signal.

**Why it's good.** `client-web/app` contains `layout.tsx`, `page.tsx` and `icon.tsx` — no `error.tsx`, no `not-found.tsx`, no `global-error.tsx`. An exception on a public lesson page shows a Next.js default and a bad slug on a creator's shared permalink shows nothing designed, on a **marketing surface**. Meanwhile the product runs long asynchronous jobs that fail for real reasons — HLS transcode, captions, crop, export, simulation generation — on a single 2-vCPU VM, and since migration 059 an export with `degradation_policy = 'forbid'` **fails the whole run** rather than degrading. The `jobs` table has `attempts` and `last_error`; nothing surfaces `last_error` to the person whose video did not finish. This document contains an entire idea about rendering *progress* more honestly and none about rendering *failure* honestly — which is the state users remember.

**How it would work here.** (a) `error.tsx` and `not-found.tsx` per route group, with the public ones **designed**. (b) A failure state in the editor for each job kind showing the sanitized `last_error` and offering a retry, reusing the existing `idempotency_key` so a retry cannot double-charge. (c) Route unhandled client exceptions to a real error tracker with release tags — there is a release pipeline with audits and rollback but **no runtime error signal to trigger one**.

**Effort.** S.

**First step.** Visit `/does-not-exist` and a lesson whose backend call throws. Whatever the viewer sees is what a stranger sees on a link a creator shared.

---

### 9.3 First Five Minutes
**What it is.** A real first-run: a sample project that already has a simulation, a video and a share link; an empty state that says what to do; and a three-step path from signup to a lesson someone else can watch.

**Why it's good.** `client-web/app/new/page.tsx` is a two-line redirect to `/`. There is no create-project flow, no template, no sample content and no empty state that teaches. The creator sweep spent an entire pass on the editor's **tenth hour** — command palette, undo, storyboard, batch edits — and none on its first, which is the hour where every user is actually lost. Worse, FlowVid's central capability (attach a generated interactive simulation to a video section) is buried inside `SectionEditor.tsx` behind a section you must first create on a video you must first upload. **A new user can plausibly finish a session without discovering the one thing the product does that nothing else does.**

**How it would work here.** Three parts, none needing backend work. (a) A **seeded demo project cloned into every new account on first login** using `ProjectDuplicationService`, which already does a full byte-and-row copy with a dry run and a byte cap — this is exactly what it is for. (b) An empty state on `/` offering two doors: "start from a video you have" and "open the demo." (c) A dismissible three-step checklist keyed on real state (has a video / has a simulation / has a share link), not a tour library.

**Effort.** S.

**First step.** Sit one person who has never seen FlowVid in front of a fresh account and time how long until something plays. Do not help them. Whatever they get stuck on first is the whole ticket.

---

# Sequencing

The order matters more than the list. Three principles govern it:

1. **Unlocks before consumers.** `Read the Sim` and `Set the Knob` are each one bounded change that turns five to seven other ideas from XL guesses into small features. Building any consumer first means building the channel badly, inside a feature, six times.
2. **Cheap proofs before expensive builds.** Almost every entry above has a first step that costs an afternoon and can *kill* the idea. Run those before committing a sprint — several of them (the poster census, the branch-analytics counts, the export timing) are single queries whose answers re-price whole themes.
3. **The floor is not optional.** A flag system, an error page, a rate limit on the one unmetered billable anonymous endpoint, and a subprocessor list are collectively about three days and they change the risk profile of everything else.

---

## Horizon 1 — the next four weeks

**Theme: make the platform able to see its own simulations, and stop shipping without a safety net.**

| Week | Work |
|------|------|
| 1 | **The floor.** Rate-limit `/avatar/start`. `error.tsx` + `not-found.tsx`. Editor viewport guard. Subprocessor list. Extend the existing feature flag with per-project targeting (9.1). Branch out from `origin/main`. |
| 1–2 | **Read the Sim (1.1)** via the serve-time boot snippet — the single highest-leverage change available. Prove it against an already-published package. |
| 2 | **Takes (4.1)** — two endpoints over `RevisionService.rollback()` and `listRevisions()`, then a Versions list. **Export transparency (4.2)** — render the migration-061 fields and the SSE token stream. |
| 3 | **Playable Link (5.1)** behind the new flag on one share link. **House Style (4.7)** — deterministic course art, killing the per-thumbnail image-generation call. **Payouts panel (7.3)** and the **branch-analytics panel (3.1)** — two `GROUP BY`s that turn shipped backends into visible product. |
| 4 | **Cost of Goods (7.1)** metering on the two dark vendors. **Hand Over the Controls (2.6)** — one line in `useProjectPlayer`. Start `Set the Knob` (1.2) with the gate-vs-protocol experiment. |

**Why this compounds:** by the end of week 4 the platform can read a simulation's live state (unlocking Theme 6 and half of Theme 8), can undo a regeneration (unlocking everything creators are currently too scared to try), can tell you what a lesson costs (unblocking a dozen stalled decisions), and can turn any of it off from admin without a deploy. Nothing in Horizon 1 requires a migration except the flag targeting.

---

## Horizon 2 — the next quarter

**Theme: turn the read/write channels into the two things nobody else can sell — assessment that cannot be guessed, and a lesson that lives on other people's pages.**

**Track A — the simulation becomes controllable.** Finish `Set the Knob` (1.2) → `Keep the Knob` (1.3) → `What-If Ribbon` (1.4). Each is a small increment on the last, and by the end a viewer's parameters survive a section boundary and an author can offer "run that again with X."

**Track B — assessment.** `Goal State` (2.1) first, because its proof needs zero new code and it validates the whole family. Then `The Commit Bar` (2.3), because it builds `learner_responses` **with `outcome_id` from day one**, which is the substrate under 2.7. Then `Wrong in a Specific Way` (2.2) — the MCQ half ships alone; the sim-driven banding arrives free once 2.1 lands. `Cold Open` (2.5) is a cheap parallel win that needs none of it.

**Track C — distribution.** `Sneakernet Bundle` (5.3) first — the vendoring is already written and it is the fastest big win on the list. Then `Frame Pass` (5.4), which is the keystone under the institutional business and needs an owner sign-off on the CSP carve-out, so start the conversation early. `Pocket Handoff` (5.2) and the `llms.txt` catalogue (5.6) are afternoons that ride along. The **podcast feed** (5.7) is an M that makes a finished, shipped product publishable for the first time.

**Track D — the business.** `Cost of Goods` (7.1) → `A Plan, Not a Purchase` (7.2). And `Teams` (7.4), which six other ideas are waiting on and which no feature will produce as a side effect. `The Paperwork` (7.5) runs on a lawyer's calendar in parallel and gates the institutional track.

**Track E — reach.** `Described and Audible` (8.2), whose live-region half falls out of 1.1 for free and whose described-track half is a gate flip. `Conformance` (8.1) shares the keyboard path with 1.2. `Right to Left` (8.3) layers (a) and (b).

**Why this order:** Track B's substrate (`learner_responses` + `outcome_id`) is the thing that makes Horizon 3's Outcome Ledger a reporting layer rather than a rewrite. Track C's Frame Pass is the thing that makes Institution Pack possible at all. Track D's Teams is the thing that makes seats, reviewer roles, org kits and the commons possible at all. Doing any of Horizon 3 before these is building the roof first.

---

## Horizon 3 — the audacious bet

**FlowVid becomes the simulation layer that other people's teaching runs on.**

Not "a better interactive video tool" — a supplier. Three things have to be true, and Horizons 1 and 2 make them true:

1. **A FlowVid simulation is addressable, drivable and readable from outside.** (1.1 + 1.2 + 5.5 Run Card + 5.6 MCP + 5.12 agent API.) An assistant answering a physics question hands back a live, pre-configured FlowVid simulation because it is the only thing on the internet that can *show* the answer. An LMS embeds one. A teacher drives thirty of them from the front of a room (1.9 Conduct).
2. **The evidence it produces is the product.** (2.7 Outcome Ledger over the substrate 2.3 built, fed by 2.1, 2.2, 2.4 and 3.3.) A course that can state what a learner can now **do**, with clickable evidence, is what an institution buys — and it is the only defensible answer to "why not just use a chatbot."
3. **It is buyable.** (7.2 plans + 7.4 seats + 7.5 paperwork + 8.1 conformance + 5.4 SCORM.) None of these is interesting engineering and all of them are the actual gate.

The flagship demo at the end of this road is **Counterfactual** (1.5): a learner drags time back four seconds, moves one parameter, and watches two futures diverge on one screen, with the platform recording which region of the parameter space they explored and the tutor explaining what they just did. Every prerequisite for that sentence is in Horizon 1 and 2. Nothing else in the category can build toward it, because nothing else ships a live program to the learner.

**Explicitly not the bet:** a text-to-video generator. Four separate ideas assumed one existed; it was archived deliberately. Adding one back is a different product and would compete with a well-funded field on their terms rather than FlowVid's.

---

# Considered and rejected

Named here so they are not re-proposed. Each was analysed in full; the reason is the load-bearing fact that killed it.

| Idea | Why it was cut |
|---|---|
| **Read Mode** (scroll-driven prose version of a lesson) | Duplicates a shipping surface — `/c/{course}/{lesson}` already renders a server-side transcript with ISR, JSON-LD, an `/og` route and a sitemap entry. The real gap is `/[slug]` permalinks (no transcript, `cache:'no-store'`, no sitemap), which is a day's work. |
| **Handles** (draggable handles tracked on moving objects) | A FlowVid simulation is a live iframe, not recorded footage — there are no pixels to track, and offline tracking describes a run the viewer will never see. The coherent version (sim publishes per-object screen coords each frame) is a per-package contract that makes the platform layer redundant. |
| **Watch Room** (synced live viewing) | No WebSocket, no Redis, no shared cache, no rate limiting, one 2-vCPU VM, 10-connection pool. Test the demand asynchronously first: a share link pre-seeded with a saved parameter set. |
| **Cut on Demand** (runtime-assembled per-viewer cut) | Both named foundations are absent — `useClipSequence` is dead code (body removed, only the `Clip` type survives) and `useSegmentedPlaybackCore` is explicitly not used by the viewer. The real sequencer is 4,198 lines with a documented wrong-frame incident history. |
| **Somewhere Else Entirely** (LLM-graded transfer tasks) | Duplicates Teach It Back's mechanism with no delivery surface — there is **no free-text input anywhere in the viewer** — and sits behind the deepest dependency chain in the sweep. Fold one transfer scenario into the confused-peer prompt instead. |
| **The Mixed Set** (interleaved end-of-course set) | Not a system — a ~30-line comparator over an item pool that does not exist yet. Salvaged as acceptance criteria on 2.7: "never group items from the same lesson; order confusable outcomes adjacently." |
| **Live Wire** (local-first op log + multiplayer sync) | An XL rewrite of the editor's entire mutation layer; `editor-state.controller.ts` is GET-only and shape-locked, no IndexedDB dependency exists, and a new sync controller would be invisible to the coverage metric. The 80% that matters is 4.6. |
| **Ten Lessons from One Folder** (batch course generation) | There is no text-to-video generator to fan out to. `corpora.extracted_md` has **zero** live consumers in the video path, `/new` redirects to `/`, and `course_lessons` requires an existing project with a real video. |
| **Brand Kit** (org-wide visual identity) | `projects.style_preset` is written by two places and read by **nothing** outside `_archive`; `orgs` has no membership table; captions are unstyled WebVTT. The good half survives as 4.8 (design tokens through `SIM_BOOT_SNIPPET`). |
| **Made With Loop** (viral "Made with FlowVid" badge) | No creator entity or handle (`users` has no handle column, no public profile route), no subscription to gate removal on (`BillingService.hasAccess` answers per-content, not per-account), and all four rendering surfaces unbuilt. |
| **Variant Arena** (A/B testing explanations) | Three missing subsystems: nothing to vary (no lesson generator), no quiz storage ("quiz table is Phase 4"), no outcome telemetry (RUM is three performance kinds and off by default). And auto-promoting published content from an unauthenticated feed is exactly what `shared/src/sim/closedLoop.ts` exists to forbid. |
| **Difficulty Rungs** (novice/standard/expert narrations) | Lesson audio is muxed into the uploaded video and its HLS renditions; there is no narration artifact, no lesson TTS path, and no alternate-audio-track concept in `buildPlayerConfig` or the player. Three rungs = three videos = three lessons. |
| **Your Map** (learner-visible model) | No learner identity on public pages (all anonymous by design), no skill model (`courses.learning_outcomes` is free text with no ids or edges), and its two intended consumers are themselves cut. Revisit if authenticated learners ever become a product intent. |
| **Seed & Stream** (ship the recipe, not the video) | Describes **shipped behaviour** — the viewer already boots and runs sims live from a stored recipe; `buildPlayerConfig` already emits it. The residue is a real bug: the live sim's automation runs on its own rAF with no relation to the audio clock. Open a drift ticket. |
| **Paper Portals** (printed AR markers) | A FlowVid simulation is arbitrary customer HTML in a sandboxed iframe, not a scene graph — "render the sim into the AR layer" is a per-package rewrite. Zero WebXR/marker code or dependencies exist. |
| **Handled** (webcam hand-gesture control) | Gated behind the same write channel as everything in Theme 1, and its accessibility justification is **inverted** — sustained mid-air gesture is generally worse for tremor, limited reach and fatigue. Rewritten as 8.1. |
| **FlowVid Box** (offline classroom appliance) | Reverses a deliberate kill switch (`layout.tsx` unregisters every service worker and clears Cache Storage on every load), and its size argument rests on the false Seed & Stream premise — lessons are mostly video. Partner with Kolibri rather than build hardware. |
| **Boss Level** (replay-verified leaderboards) | Every named building block is falsified: `autoScript` is a **boolean** (`driver.ts:65`), `DOMAIN_EVENT` has no producer, determinism is unproven, and capture is orders of magnitude over budget. Revisit only if a deterministic runtime ever exists. |
| **Motion Poster** (animated link previews) | `next/og` cannot emit animated output; the only poster producer is a manual script; posters have no cross-identity fallback so most links degrade to a still; X does not animate `og:image`. Survives as 5.8. |
| **Crowd Dub** (community video dubbing) | A dubbed lesson is a full new HLS ladder per language on an uncensused bucket, plus i18n/RTL infrastructure that does not exist. The buildable core survives as 8.4. |
| **Storyboard as an image grid** | Posters exist only for canaried packages and non-sim sections have no thumbnail at all, so the headline visual is mostly absent. Survives as 4.10 (text cards). |
| **Fit Check Marketplace** | The fit check **already ships** as `?dry_run=true`; the marketplace needs an ownership model the schema cannot express (every asset is `project_id NOT NULL` with cascade, no ACL). Survives as 5.14 (the badge). |
| **The Receipts verify page** | The virtual clock has never rendered a moving frame on a real WebGL package, capture runs 16.3 s/frame at 1080p, and sim capture is off by default so masters often contain posters. Survives as the provenance manifest in 5.13. |

---

# Where to steal from

Each line is what to actually take, not just a name to admire.

### Explorable explanations and interaction design
- **Bartosz Ciechanowski** (ciechanow.ski, "Gears", "Color Spaces") — every diagram is a pure function of a slider and the first thing on the page is a thing you can drag. Take the *layout*: prose column, sticky interactive figure, numeric readout pinned beside every figure.
- **Bret Victor** — *Tangle* (reader-set values propagate through the whole document), *Scrubbing Calculator*, *Media for Thinking the Unthinkable* (show the space of behaviours, not one run), *Stop Drawing Dead Fish* (simulation as performance). Take the reactive-value primitive for 1.3 and the parameter-space framing for 3.3.
- **Nicky Case** — *Parable of the Polygons* (the re-run-with-different-bias button **is** the argument) and the "4 More Design Patterns" essay, specifically pattern #1 "Puzzle It Out" and #2 "Place Your Bets!". Take these for 1.4 and 2.4.
- **Distill**, "Communicating with Interactive Articles" — the *Personalizing Reading* and *Prompting Self-Reflection* affordances, and "How to Use t-SNE Effectively" for parameter grids as argument (1.8).
- **Idyll** (`Scroller`, Idyll Studio, Conlen & Heer UIST 2018/2021) and **Observable** — reactive documents as a publishable artifact; take the "any notebook can be forked and any value imported" model for 5.9.
- **DimP: Video Browsing by Direct Manipulation** (Dragicevic et al., UIST 2007) — dragging content rather than a timeline bar; relevant to 1.7.
- **Explorable multiverse analyses** (Dragicevic et al., CHI 2019) — showing the space of alternative runs rather than one path.

### Simulations and science education
- **PhET Interactive Simulations** — 170+ sims, 130+ languages, 250M uses/year, downloadable per-sim. Take three things: **implicit scaffolding** (constrain what is available so learners are guided without feeling guided — 2.6), the **community translation utility** built for people with minimal computer expertise (8.4), and the iterative design process refined through 600+ student think-aloud interviews (Podolefsky, Moore & Perkins, arXiv 1306.6544).
- **PhET-iO** — instrumented sims that emit every state change for research and assessment; the closest existing precedent for 3.3.
- **Desmos Classroom** — Marbleslides (the answer is judged by whether the marble collects the stars, not by matching a string — 2.1), Card Sort teacher dashboard (clustering students by *how* they were wrong — 2.2), sketch-your-prediction screens (2.4), snapshots and teacher pacing (1.9).
- **HHMI BioInteractive Interactive Video Builder** — pause specifically at the moment *before* results are revealed, and interrupt roughly every two minutes (2.4, 2.9).
- **Manim / 3Blue1Brown** — scenes parameterised by t rather than recorded; framing as pedagogy.

### Learning science (the evidence behind Theme 2)
- **Butterfield & Metcalfe (2001)**, "Errors Committed With High Confidence Are Hypercorrected", plus Metcalfe & Finn's follow-ups showing persistence over a week — the basis for 2.3.
- **Gardner-Medwin's Certainty-Based Marking**, used in UCL medical/physiology assessment; see the 2025 *Advances in Physiology Education* web implementation.
- **Richland, Kornell & Kao (2009)**, "The Pretesting Effect"; **Kornell, Hays & Bjork (2009)** on errorful generation — 2.5.
- **Szpunar, Khan & Schacter (PNAS 2013)** — students tested during a 21-minute online lecture were half as likely to mind-wander and three times as likely to take notes.
- **Renkl, Atkinson & Maier** on fading worked-out steps, and Atkinson/Renkl/Merrill on backward fading — 2.6.
- **Bisra, Liu, Nesbit, Salimi & Winne (2018)**, "Inducing Self-Explanation: a Meta-Analysis", g = 0.55 — 2.8.
- **Adesope, Trevisan & Sundararajan (2017)**, practice-testing meta-analysis, g = 0.61 across 217 studies; transfer 0.53 vs retention 0.63.
- **Taylor & Rohrer (2010)** and **Rohrer, Dedrick & Stershic (2015/2019)** on interleaving — the ordering rule folded into 2.7.
- **Cepeda, Vul, Rohrer, Wixted & Pashler (2008)** on optimal spacing; **Settles & Meeder (ACL 2016)** on Duolingo's half-life regression trained on 13M traces.
- **Meta-analysis of enhanced interaction in educational video** (Interactive Learning Environments, 2022), g = 0.522, **effect contingent on the video pausing** — the mechanism 2.4 depends on.
- **Mayer's CTML**; Clark & Mayer (2024); **Cynthia Brame**, "Effective Educational Videos" (CBE-LSE); Noetzel & Mayer (JARMAC 2021) — 2.9.
- **Bull & Kay**, "Open Learner Models"; the 2020 systematic review of OLMs in *Computers & Education* — 2.7.
- **Betty's Brain / Teachable Agents Group (Vanderbilt, Biswas et al.)** — the protégé effect; assessment by whether the *taught agent* can answer.
- **Eedi Diagnostic Questions** and the **NeurIPS 2020 Education Challenge dataset** (Wang et al., PMLR v133) — MCQs "whose distractors embody misconceptions", plus Eedi's own misconception-mapping writeup over 20M responses — 2.2.
- **Mazur's Peer Instruction ConcepTests**; **Carnegie Learning MATHia** and the cognitive-tutor "buggy rule" libraries (Anderson's ACT-R lineage; Ritter et al., EDM 2016).
- **Kestin et al., "AI tutoring outperforms in-class active learning"**, *Scientific Reports* 2025 — the PS2 Pal prompt constraints (one step at a time, never divulge the solution) — 2.8, 6.2.

### Product patterns worth copying directly
- **Superhuman**, "How to build a remarkable command palette" — teach the hotkey inside the palette (4.5). Plus Linear, Vercel, Raycast, Retool's "Designing Retool's command palette".
- **Cursor** — accept/reject per hunk, and the user backlash when it was removed (4.11).
- **Chromatic** — TurboSnap (re-test only what a change affects — 4.3) and side-by-side snapshot diff with one-click baseline promotion (4.1).
- **Figma** — version history, components/variants/instance overrides (4.13), comment pins anchored to objects (4.9), the plugin API as a typed operation surface (4.11), and Evan Wallace's "How Figma's multiplayer technology works" for per-property last-write-wins.
- **Frame.io V4** — timecode-accurate comments and Collections for multi-stage review and approval (4.9).
- **Descript** — storyboard/scene view beside the multitrack timeline (4.10) and Underlord's chat-driven multicam edits (4.11).
- **Lovable Visual Edits** and **Supademo Hotspots 2.0** (Jan 2026) — click an element in the live preview and edit it without prompting (4.4).
- **Krea** — real-time canvas that updates continuously as you type (4.12); **Runway Gen-4** keyframes as structural constraints and Fix Seed for one-variable comparison.
- **Wistia** per-second engagement heatmaps — the marketing-side proof that this changes editing behaviour (3.2). **Mux Data** for per-view timelines; **Mux Player CuePoints** driving React overlay state.
- **Loom** — the share page as the whole first impression, and the recipient→creator loop that reached 25M users with almost no paid marketing.
- **Gamma** — card model with Smart Layouts; **Canva Bulk Create**; **Synthesia Brand Kits** — for what a template/brand system looks like when it is real.

### Distribution, standards and offline
- **CodePen / CodeSandbox oEmbed** — the canonical "paste a URL, get a live sandbox" pattern, both in the ~300-provider oEmbed registry (5.4).
- **Iframely's domains DB** — what Notion actually consults for its ~1,900 supported embeds; **Embedly's provider requirements** (iframe embeds only, script tags rejected, must accept a `referrer` parameter).
- **H5P.com** — an entire institutional business built on an iframe that stays hosted while living inside somebody else's LMS page; **Lumi's H5P SCORM packager** as the independent proof the wrapper is small.
- **cmi5 (ADL/AICC v1.0)** — "the course structure file can reference content from anywhere"; **1EdTech LTI Advantage** certification and Deep Linking; **xAPI Video Profile** for the event shape (3.3).
- **Kolibri / Learning Equality** — offline-first, 173 languages, USB and peer-to-peer distribution, deployed at government-school scale; **Kiwix**; **Internet-in-a-Box / RACHEL** (5.3).
- **Wolfram Demonstrations Project** — 1,300 at launch to 10,000+, open contribution with staff curation; **Figma Community**; **Scratch** (73M users, ~30% of projects are remixes) and the MIT/CDSC paper "Remixing as a Pathway to Computational Thinking" (CSCW 2016); **Glitch's shutdown** as the hosting-cost cautionary tale (5.9, 5.10).
- **Wordle's emoji grid** — invented by a player, then shipped as a Share button; the *share format* was the viral object, not the puzzle (5.5). Plus **Desmos graph links** (entire graph state in the URL) and **Strava/Duolingo** result cards.
- **Wiley's AI Gateway MCP server** (Oct 2025), **OpenAI's MCP adoption at DevDay**, the **MCP Registry**, and the **llms.txt convention** already implemented at `client-web/app/llms.txt/route.ts` (5.6). **A2A Protocol v1.0** under the Linux Foundation for 5.12.
- **C2PA Content Credentials** (camera firmware from Sony, Nikon, Leica, Canon; Pixel 10 at top-tier conformance), the OpenAI+Google dual-layer manifest+watermark model, **Adobe Content Authenticity Inspect** as a public verifier UI, and **EU AI Act** transparency labelling effective August 2026 (5.13).
- **Opus Clip** — 12M+ users, virality scoring, auto-reframe; note the ~40% discard rate, which is the argument for human selection (5.11).
- **Calendly's "Powered by" badge** (25% of new users signed up after spotting it) — the loop mechanics, filed for after a creator page exists.

### AI, agents and verification
- **Playwright Test Agents** (planner / generator / healer) — the healer reads failure output, rewrites the broken locator and re-runs to verify: the exact shape of 6.4.
- **Model Context Protocol** tool/resource primitives and the **elicitation** primitive (servers requesting human confirmation mid-task for long, expensive work) — 6.8.
- **Google Research Generative UI / PAGEN** — models emitting live HTML/JS interfaces with tool access; **Claude Artifacts** for "the answer is a running program"; **MAIC-UI** (arXiv 2604.25806) for zero-code interactive courseware editing.
- **Khanmigo** — documented context awareness (knows which exercise the student is on) and refusal design (guide, never hand over the answer) — 6.1, 6.2.
- **NotebookLM** — Interactive Mode "Join" (interrupt the audio and ask), the quiz "explain" affordance that cites back to the exact source passage, and Short Video Overviews as proof that ~60-second generated explainers are now cheap (6.3).
- **Bespoke-MiniCheck**, **FActScore**, **GopherCite**, and "Cited but Not Verified" (arXiv 2605.06635, 11–57% citation hallucination) — 6.7.
- **RubricHub** (arXiv 2601.08430), **AutoChecklist** (arXiv 2603.07019), **BiGGen Bench** — instance-specific rubrics beat holistic scoring; plus the documented GPT-4-as-judge positivity bias that forces a top-3 (6.6).
- **Duolingo's Birdbrain** and "Improving Duolingo, one experiment at a time" — wins measured on both engagement *and* learning before launch.
- **Highcharts Sonification Studio** (Highsoft × Georgia Tech, ICAD 2021) — open-source, built with blind participants from phase one (8.2); **Signapse + SyncWords** for where sign language actually is.
- **Harrison, Amento, Kuznetsov & Bell, "Rethinking the Progress Bar" (UIST 2007)** — nonlinear pacing and pauses measurably change perceived duration (4.2).
- **Gaffer On Games, "Deterministic Lockstep"**, and Quake `.dem` / StarCraft `.rep` / Factorio replays — the reference model for what a genuinely deterministic runtime would buy, and therefore what Boss Level and the Receipts verifier would need.
- **Remotion** — video as a deterministic function of frame number through headless Chromium: the same trick FlowVid's capture already uses, and the reference for where that path leads.

---

*Written 2026-08-20 from six feasibility-checked idea sweeps plus a completeness critique. Every claim about the codebase in this document was verified against `origin/main` @ `6c7f9bb`. Where a sweep's original pitch was contradicted by the code, the correction is stated inline rather than the pitch repeated — those corrections are the most valuable part of the document and should be read before starting any item.*
