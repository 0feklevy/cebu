# Sim Pipeline Hardening — Verdict on the Optimization Brief & What Shipped

**Input:** `md-files/FLOWVID-SIMULATION-PIPELINE-OPTIMIZATION-BRIEF.md` (external audit, reviewed at `1a29ce6`).
**Process:** every load-bearing claim was re-verified against the code by three independent adversarial passes before anything was changed.
**Outcome:** the brief's findings are **essentially all TRUE** (a few nuances below). Its *target architecture* is right long-term but is a multi-phase program; this PR implements the **causal fixes** inside the current architecture and defers the platform work with reasons.

---

## 1. Verification verdicts (all re-checked, not taken on faith)

| Brief claim | Verdict | Nuance found during verification |
|---|---|---|
| `SIM_PAINTED` is a false paint signal (bridge's own rAF `_fireReady` acks it) | **TRUE** | The 3s `setTimeout` fallback does NOT false-ack; only the rAF path. Guidance's poll loop is a second source. |
| `painted` is document-lifetime; later sections reveal on a stale paint with no per-section ack | **TRUE** | Reveal is double-rAF + 200ms fade, so the window is narrower than the brief implies — but architecturally real (previous section's frozen frame can be shown). |
| Fade-out flash: `stopScript` before the fade restores Full UI mid-fade | **TRUE** | Deterministic whenever something was hidden. Same on back-to-video; legacy reload there can blank mid-fade. |
| No `simMute` on deactivation; hidden frames stay unmuted; `guidanceGate off` sent after key nulled (goes nowhere) | **TRUE** | The gate-off no-op was found *during* verification — not in the brief. |
| 12s idle timer boots WebGL with zero play intent | **TRUE** | No-op only in `single` tier. |
| Window tier mounts the FIRST package at start regardless of distance | **TRUE** | Parked cold after `SIM_READY`, but boot cost is paid. |
| Window lookahead stops at segment+1; picks next ROW not next distinct package | **TRUE** | `ensurePooled` at activation prevents a *total* miss (cold entry instead). |
| `want.size > 0` guard blocks eviction through sim-free gaps | **TRUE** | Up to 2 stale WebGL docs retained indefinitely. |
| DPR is live in the URL → zoom/monitor change reloads resident frames | **TRUE, worse** | The reload's `load` event is **silently ignored** (`expectReload` false + flags set) → stale `ready/painted` on an unloaded doc → blind reveal until self-heal. |
| `pauseScript` ignored by the combined bridge | **TRUE, worse** | Its ONLY system-wide effect is re-enabling guidance polling. Automation is `setInterval` **by generation-prompt mandate** — nothing generic can pause it. |
| Cleanup throw wedges dispatch permanently | **TRUE** | Composes with the prototype gap: one `startScript('constructor')` message **permanently bricks** the document. The *oldest* template had the try/catch; both modern wraps dropped it. |
| Prototype-unsafe `SCRIPTS[name]` | **TRUE** | DoS-grade, not RCE (sandbox + frame-ancestors block third-party framing). `SAFE_SECTION_ID_RE` even accepts `constructor` as a section id. |
| Unknown section silently runs the boot-default body | **TRUE** | The "same variation everywhere" bug's return path; zero telemetry. |
| Local serving skips the boot snippet (dev≠prod first paint) | **TRUE** | Local also lacks ETag/cache headers. |
| `data-simboot` substring detection suppresses injection | **TRUE** | Its intended idempotency job is nearly vacuous (stored HTML never carries it). |
| 304 still costs full read+hash | **TRUE** | Deferred (needs manifest/revision infra — roadmap). |
| Year-immutable caching + in-place replace ⇒ stale CSS/JSON/binaries | **TRUE** | Live-confirmed: `style.css` immutable, unversioned, overwritten in place. Binary 308+immutable had **no revalidation path at all**. |
| `#simboot` overwrites author fragments | **TRUE** | The reader regex already supported the appended form — only the writer was wrong. |
| Editor `VideoPlayer` 50ms/800ms blind reveals; `SectionEditor` third policy; no inert/a11y; backdrop blur | **TRUE** | — |

**Where the brief needed correction:** the reveal is not "same-tick opacity 1" (double-rAF + fade); `setTimeout`-only `_fireReady` would have *broken* paint-acks for rAF-less sims (the brief's §3 hints at replacing the gate; the naive fix regresses — see `raw`/`sys` below); murmuration-style packages have **zero DOM contract** (pure JS API), which any selector-only policy misses.

---

## 2. What this PR ships (causal fixes, backward-compatible)

**Honest paint signal (template):** the gate now exposes `__SIM_RAF_GATE__.raw` (unwrapped) and `__SIM_RAF_GATE__.sys` (pause-coupled like the wrapped rAF, **paint-neutral**). The bridge schedules `_fireReady` via `raw`; guidance's poll loop runs on `sys` — system bookkeeping can no longer ack the sim's first paint, while `simPause` still freezes the guidance poll and rAF-less sims keep their bounded-hold fallback.

**Atomic exits (player):** `deactivateSim` and back-to-video now: freeze (`simPause`) + mute (`simMute`) + close the guidance gate **to the still-known key** → fade → `stopScript` (or the legacy reload) **deferred past the fade** (`SIM_EXIT_STOP_MS=280 > 200ms` CSS), cancelled if the same package re-activates mid-fade. Kills the Minimal-UI Full-flash and mid-fade blank deterministically.

**Per-activation ack (template + player):** `startScript` now posts `SCRIPT_APPLIED {script}`; a same-document switch to a different script holds the opacity swap for that ack (ceiling `SIM_APPLY_ACK_MS=200` → old behavior for stored pre-ack bridges, marked `ackCapable=false` once). `SCRIPT_MISSING` (unknown modern section: runs **nothing**, never another section's body) and `SCRIPT_ERROR` (cleanup/start threw — **recovered**, `try/finally`, never wedges) are surfaced to telemetry. Dispatch is own-property-guarded on **both** maps; `'main'` keeps its legacy boot-default fallback.

**Scheduler (player, pure+tested):** `flattenSimOccurrences` + `planWindowResidency` in `lib/simPool.ts` — window tier now scans the whole remaining path in absolute time, prefetches the next **distinct** package, mounts **nothing** at start (initial cap 0), and the plan is authoritative: empty plan ⇒ evict (active frame always protected). The 12s fallback arms only after a real `play` attempt.

**Frame identity/hygiene:** DPR is snapshotted per page (no zoom/monitor-triggered reloads → the silently-ignored-load hazard is unreachable); `navigateFrame` re-cloaks the **target** section's `bootHide`; hidden frames get `inert` + `aria-hidden` + `tabIndex=-1`; the transition-time `backdrop-filter: blur(2px)` is removed.

**Serving:** local path injects the boot snippet (dev=prod first paint); marker detection is exact-tag; text serves `no-cache`+strong-ETag (304s), binaries redirect `302` + `max-age=3600` — **bounded** staleness after a replace (was: a year, with no revalidation path). `#simboot` appends after author fragments.

**Tests:** +21 (bridge hardening round-trips [17–21] incl. the `constructor` wedge and throwing-cleanup recovery; planner suite; simUrl snapshot/fragment suites; sim-public policy/marker). Full runs: client **112/112**, backend **763/763**, ops-release untouched; typecheck+lint clean.

---

## 3. Deliberate deviations from the brief (with reasons)

- **Legacy pre-v4 force-reveal is KEPT** (brief: "timeouts fail closed"). Failing closed requires the poster layer, which doesn't exist yet; poster-less fail-closed = legacy packages (ising, pluck-boids) never appear at all. Bounded force-reveal stays, documented, until posters land.
- **No `pauseScript` fix**: automation lives in body-closure `setInterval`s — unpausable without the managed-lifecycle contract (§7 of the brief). Doing it "generically" would be a lie. Deferred to the lifecycle phase, honestly.
- **Package key stays URL-derived** (brief: `simulationId@revisionId`): `revisionId` doesn't exist; switching key derivation mid-flight touches every routing map for a duplicate-origin edge case that current single-origin data doesn't hit. Goes with the revision schema.
- **Stored packages upgrade lazily**: template fixes apply to future generations/replaces; existing `bridge.js`/gate stay as-is until regenerated (`rebuild-sim-bridges.ts` exists but writes to shared prod storage — owner's call). Player handles both generations (`ackCapable` feature-detection).

## 4. Deferred roadmap (right ideas, wrong PR)

In the brief's own phase order: deterministic visual fixture packages + filmstrip CI (§12) → shared `SimRuntimeClient`/`SimSurface` for viewer/editor/preview + envelope protocol over `MessageChannel` (§4–5) → poster layer + publish-time canaries (§9) → managed lifecycle contract incl. `pauseAuto`/suspend/audio scopes (§7) → immutable revision prefixes + manifest-driven serving + real 304s (§10) → predictive scheduler budgets + `requestVideoFrameCallback` clock + RUM (§8, §11). Each is a separate reviewable change, per the brief's own instruction not to combine them.
