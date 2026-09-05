# Master Checklist — Welcome-to-Flow-Video overnight production run

Audited by task-tracker against repo state as of **2026-09-05 01:31 EEST**, branch
`feat/welcome-tutorial-kit` (HEAD `77bf941` + uncommitted work). This run is live and
concurrent — files changed *during* this audit (see §11.3). Re-run this audit rather than
trusting it as the run progresses; do not treat a stale row as current without re-checking.

Legend: **DONE** = implemented, reachable, tested where testable · **PARTIAL** = some sub-parts
only, say which · **NOT DONE** = no implementation found · **BLOCKED** = cannot be done here ·
**N/A** = not a checkable artifact.

---

## 1. Default demo experience, seeded, as a PLAYLIST

| id | requirement | verdict | evidence |
|---|---|---|---|
| 1.1 | Playlist structure: teaser → tutorial → ≥2-3 niche videos | DONE (design) | `PRODUCTION-PLAN.md:13-25` (5-entry table), `CREATIVE-BRIEF.md` "OWNER RESTRUCTURE v2", `README.md:9-10` — all three agree |
| 1.2 | Teaser ~66s matches reference vibe: animated brand intro / real screen flows / ~150wpm / triple-tap close / brand ≥3× | PARTIAL | `scripts/SCRIPT-1-TEASER.md` v2: real screen flows ✓, 121 words/48s ≈ 151wpm ✓ (verified arithmetic), close "Touch it. Ask it. Steer it. — Flow Video." ✓, "Flow Video" spoken exactly 3× (scene 2, 6, 8 — recounted directly) ✓. **Gap: no brand-mark intro.** `CREATIVE-BRIEF.md` STYLE REFERENCE item 1 says "Animated brand-mark intro on a clean light ground (~3s) — then straight into product"; the actual script opens on kinesin product footage (scene 1) and puts the logo lockup only at the CLOSE (scene 8). The brief's own adopted-style note is not implemented in the shot list. Also: no rendered teaser exists yet (see §3, §5) — this is script-only. |
| 1.3 | ≥2-3 niche videos | PARTIAL | 3 niche scripts now exist: `scripts/SCRIPT-3-HEAVY-SIM.md`, `SCRIPT-4-VIEWER-POWERS.md`, `SCRIPT-5-SHARE.md` (all untracked, appeared during this audit at ~01:29). Satisfies "≥2-3" at script level. Zero have been captured/narrated/assembled. |
| 1.4 | Playlist actually seeded for every new user | NOT DONE | `grep -rl "welcome_project_id\|seedWelcomeProject\|WELCOME_SEED_ENABLED" backend-api/src admin-web/src client-web/src shared/src` → zero hits. No seeding code exists at all. |

## 2. The demo PROJECT (playlist entry #1): one timeline, live interactive sections

| id | requirement | verdict | evidence |
|---|---|---|---|
| 2.1 | Teaser + tutorial on ONE timeline, 7 sections incl. sims/image/audio/choice, "tasteful not overwhelming" | NOT DONE | Only a design exists (`PRODUCTION-PLAN.md:27-30`). No project has been created for this content — see 2.7. |
| 2.2 | Touchable sims: Murmuration + Wave Lab, license-clean | PARTIAL | Sims themselves: DONE — `sims/murmuration/index.html` (223 lines), `sims/wave-lab/index.html` (198 lines), both self-contained single-file HTML+canvas, zero external assets/fonts/CDNs, implement `window.MurmurationSim`/`window.WaveLabSim` + `window.__flowvidReadyForPresent` exactly per `CREATIVE-BRIEF.md`'s contract (verified by direct read, not by trusting the doc). **Not yet wired**: not embedded as a live section in any authored project via the real sim-authoring pipeline (upload → bridge → This-moment). `captures/stage-capture-prop.mjs` uploads Wave Lab as a raw sim file to a *capture-prop* project ("Standing Waves 101", in flight as of 01:31 — see §7), not to the real demo project. |
| 2.3 | Image section(s): generated on-brand infographics | NOT DONE | `assembly/` is empty (0 files). An HTML→PNG technique was proven for a *prop* asset (`captures/props/waves-diagram.html`+`.png`, 01:28-29) but nothing exists for the actual demo project's infographic. |
| 2.4 | Audio section: original generated ambient/sting | NOT DONE | `audio/` is empty (0 files) — no generation script exists. `captures/props/ambient-tone.wav` exists but is scoped by its own creating script's comment as a Library "prop" for the fictional capture project, not verified as the actual A2 track; its generation method (the "offline-rendered oscillator pad" `PRODUCTION-PLAN.md:78` describes) is not present as a reusable script anywhere, so it is not independently verifiable as original/commercial-clean-by-construction, and it isn't regenerable per the README's own contract. |
| 2.5 | Branching choice section | NOT DONE | No project exists yet to hold one. |
| 2.6 | The demo project actually built via real product usage | NOT DONE | See §7. |

## 3. Every frame is real product capture

| id | requirement | verdict | evidence |
|---|---|---|---|
| 3.1 | Captures via v0.7.0 local stack + Playwright | PARTIAL | Local stack confirmed live (`curl localhost:8080/health` → 200, `localhost:3000/` → 200, backend log actively serving requests at 01:31). Sim b-roll WAS captured via Playwright: `record-sim-footage.mjs` produced real output (scratchpad `footage/murmuration-lesson.mp4` 15.9MB, `footage/wave-lab-broll.mp4` 24MB, both mtime 01:09) — but these live only in `/private/tmp/.../scratchpad/footage/`, not in the repo (`tutorial-kit/captures/out/` doesn't exist), and the mp4s have no corresponding committed conversion step (the committed script only records raw `.webm`, so the mp4 conversion happened by hand, un-scripted). The comprehensive UI-walkthrough capture (`capture-all.mjs`, promised by `README.md:29`) does not exist — no editor/share-sheet/settings footage has been captured for this deliverable. |
| 3.2 | Kinesin appears in FILM captures only, never seeded | DONE (discipline, not yet exercised) | `tutorial-kit/sims/` contains only `murmuration/` and `wave-lab/` — no kinesin. The kinesin package used for film-capture purposes lives entirely outside `tutorial-kit/` (scratchpad `kinesin-pkg/`), correctly separated. Owner permission for film-capture use is dated and cited consistently across `CREATIVE-BRIEF.md`, `README.md`, and `scripts/SCRIPT-1-TEASER.md`/`SCRIPT-3-HEAVY-SIM.md` (2026-09-05). No kinesin footage has actually been produced yet, so the rule is structurally honored but untested end-to-end. |
| 3.3 | All seeded content license-clean | DONE (for what exists) | Both sims independently verified original/self-contained (no third-party code, no external fetches). Nothing else is seeded yet. |
| 3.4 | Generated media commercial-use-safe by construction | NOT DONE | No generation script for image/audio assets exists yet (see 2.3/2.4). |

## 4. Narration

| id | requirement | verdict | evidence |
|---|---|---|---|
| 4.1 | English TTS via the product's own ElevenLabs path | NOT DONE (path exists, unused) | `backend-api/src/services/audio/GuidanceTTSService.ts:44` `synthesize(text, cfg): Promise<Buffer>` is real and reachable, but nothing in `tutorial-kit/` calls it yet — `audio/` is empty, no narration audio exists for any of the 5 scripts. |
| 4.2 | Admin default voice | NOT DONE | Decision recorded (`PRODUCTION-PLAN.md:75`) but not exercised — no TTS call has been made. |
| 4.3 | Spend recorded | NOT DONE | `recordTtsSpend` wiring confirmed real (`GuidanceService.ts:637`, `VoiceQuestionService.ts:121`, re-verified live this session) but no `tutorial_narration`-style task label or call exists anywhere yet. |
| 4.4 | Word-timed captions VTT | NOT DONE, **and the plan's implied mechanism is wrong** | `GuidanceTTSService.ts:38-39` (code comment): *"the `/with-timestamps` variant used by the archived podcast pipeline returns base64 JSON — we don't need word alignment for guidance, only the audio clip."* GuidanceTTSService **cannot** produce word timings. The word-timing-capable code (`ForcedAlignmentService.ts`, ElevenLabs `/with-timestamps`) lives only in `backend-api/src/_archive/v1-podcast-pipeline/`, which is excluded from the TypeScript build (`backend-api/tsconfig.json:12`, `"exclude": [..., "src/_archive/**"]`) and imported by nothing live. **The actual reachable path is different**: `CaptionService.ts` (Groq STT) auto-transcribes any uploaded video's audio via `runVideoTranscode.ts:14 → enqueueCaptionsForProject`, which is what really produces `captions_vtt`. So word-timed captions require TTS-audio → assembled video → **upload through the normal pipeline** → Groq re-transcribes it — a real, live, already-wired path, but a different one than "get timestamps from ElevenLabs," and nobody has exercised it yet. Flag this explicitly to whoever builds the assembly step. |
| 4.5 | Tap-to-ask works on the tutorial | NOT DONE | Depends on 4.4; nothing produced yet. |

## 5. Assembly (ffmpeg)

| id | requirement | verdict | evidence |
|---|---|---|---|
| 5.1 | ffmpeg assembly: captures + infographic + narration + music | NOT DONE | `ffmpeg 8.1.2` is installed and available (`/opt/homebrew/bin/ffmpeg`, verified). `tutorial-kit/assembly/` is empty — no script, no output. |
| 5.2 | Loudness ≈ reference (mean ~-23dB) | NOT DONE | Reference measured (`PRODUCTION-PLAN.md:89`: "−22.8dB mean"); nothing produced yet to match against it. |
| 5.3 | QC at 360p legibility | NOT DONE | No assembled film exists. |
| 5.4 | H.264 1080p output | NOT DONE | No output exists. |

## 6. Critique gates (before AND after each stage)

| id | requirement | verdict | evidence |
|---|---|---|---|
| 6.1 | Gates defined before/after each stage | DONE | `PRODUCTION-PLAN.md:32-46` — G1-pre through G6, matches "before AND after" instruction. |
| 6.2 | Panel roles (marketing/PM/sales, narration director, editing critic) | DONE | `PRODUCTION-PLAN.md:36` names all five roles explicitly. |
| 6.3 | MUST-FIX vs NICE discipline, actually applied (not just declared) | DONE | `PRODUCTION-PLAN.md:48-71` is a genuine numbered MUST-FIX list; `scripts/SCRIPT-1-TEASER.md` v2's own changelog cites the numbered items it applied ("beat 1 ≤4s · narrator yields ... · brand 1→3 · triple-tap close ..."). Real before/after evidence, not just a label. |
| 6.4 | G1-pre done | PARTIAL — **the plan document contradicts itself** | `PRODUCTION-PLAN.md:40` table cell says "✅ ran (3 critics)"; six lines later, `:71` says "PM/accuracy critic: still running — its findings fold into v2 before G1-post." Only 2 of 3 critics (marketing, sales) have recorded verdicts. This is exactly the "state sentence contradicted lower in the same file" failure `CLAUDE.md §3b` names as a real recurring incident — fix the earlier line in the same pass once PM/accuracy actually reports. |
| 6.5 | Scripts v2 clears G1-post | NOT DONE | `PRODUCTION-PLAN.md:41` lists G1-post as "pending"; no G1-post verdict document exists anywhere. Scripts v2 (and the new v2-equivalent niche scripts) read, on independent inspection, as satisfying the substance of the MUST-FIX list and the honesty rules (see §9) — but that is this auditor's read, not a recorded critic sign-off, and the process explicitly requires the latter. |

## 7. Built via the product's real APIs, on the LOCAL stack

| id | requirement | verdict | evidence |
|---|---|---|---|
| 7.1 | Uploads via real API | PARTIAL, in progress | `captures/stage-capture-prop.mjs` (new, untracked, 01:29) — real `POST /api/v1/projects`, `/videos/upload`, `/simulations/upload`, `/images`, `/audio` calls, confirmed actively running via live backend log at 01:31 (polling `hls-status` for the project it just created). This builds a *capture-prop* project ("Standing Waves 101" — content the films show being built on camera), **not** the actual seeded demo project or the niche-film projects. |
| 7.2 | HLS transcode | DONE (mechanism), unexercised for the real deliverable | Confirmed automatic and working live (200s on `/hls-status` polling in the running backend log) — but so far only for the capture-prop project. |
| 7.3 | Sim sections with This-moment prompts | NOT DONE | `stage-capture-prop.mjs` only uploads a raw sim file; it does not create a timeline section or call the This-moment/bridge-generation endpoint. No section exists anywhere yet. |
| 7.4 | Minimal-UI generation | NOT DONE | Depends on 7.3; not reached. |
| 7.5 | Posters | NOT DONE | No sections exist to have posters. |
| 7.6 | Permalink | NOT DONE | Not reached. |
| 7.7 | Share links | NOT DONE | Not reached. |
| 7.8 | Playlist assembly with ordered entries | NOT DONE | No playlist row created. |
| 7.9 | Never touches prod | DONE | `stage-capture-prop.mjs:10-11` hardcodes `127.0.0.1:8080` / `127.0.0.1:9099` (Firebase emulator) with an explicit comment "Never points anywhere but localhost." Consistent with `CLAUDE.md §7`. |

## 8. Seeding mechanism (per `seeding/DESIGN.md`)

| id | requirement | verdict | evidence |
|---|---|---|---|
| 8.1 | Shared template + per-user row-level clone design | DONE (design only) | `seeding/DESIGN.md` is thorough (own header claims ~60 file:line citations from a dedicated verification pass). Zero corresponding implementation. |
| 8.2 | Migration 085 | NOT DONE | `backend-api/src/db/migrate.ts:66` — hardcoded `migrations` array's last entry is `084_simulation_import_provenance.sql`. No `085_*.sql` file exists anywhere in the repo. |
| 8.3 | Dark-gated env/admin flag | NOT DONE | `grep -rl "WELCOME_SEED_ENABLED\|WELCOME_TEMPLATE_PROJECT_ID\|welcome_seed_enabled"` across backend-api/admin-web/client-web/shared → zero hits. |
| 8.4 | Idempotent | NOT DONE / untestable | Three-layer idempotency is designed (`DESIGN.md:14-21`) but there is no code to be idempotent. |
| 8.5 | Unit tests | NOT DONE | No seeding code exists to test. |
| 8.6 | Integration tests | NOT DONE | Same. |
| 8.7 | The two pre-build fixes named in DESIGN.md | NOT DONE (fix #1) / DONE (fix #2, doc-only) | **Fix #1** (`ProjectDuplicationService` must carry `sim_files` on clone): `grep -n "sim_files" backend-api/src/services/project/ProjectDuplicationService.ts` → zero matches. Confirmed still unaddressed, re-verified fresh this session (not assumed from the design doc). **Fix #2** (operator bypass of `seedGuards` for template publish) is explicitly scoped in `DESIGN.md:64-67` as a one-time human operator action, not seeder code — nothing further to build; the doc itself is the deliverable here. |

## 9. Script honesty constraints (tonight's PM critic)

| id | requirement | verdict | evidence |
|---|---|---|---|
| 9.1 | Tutorial builds Wave Lab so "built exactly this way" is TRUE of the seeded project | DONE (script level) | `scripts/SCRIPT-2-TUTORIAL.md` scene 4 builds Wave Lab; scene 9: "That Wave Lab below? You just watched it get built." Consistent with the seeded project's own plan using Wave Lab as its live tutorial-adjacent section (`PRODUCTION-PLAN.md:28`, `README.md:10`). Will need re-verification once the actual project is built (2.2/7.3), since the claim is only as true as what actually gets built. |
| 9.2 | Handover promises only what works on cloned rows (prompt edit, sim swap — not Smart Crop/dubbing) | DONE (script level) | `SCRIPT-2-TUTORIAL.md` end card: "Change one word" / "Edit this section"; its own honesty footer explicitly scopes this and defers dubbing/Smart Crop to films 4/5. Matches `DESIGN.md`'s storage_key constraint precisely. |
| 9.3 | Teaser ask-scene uses avatar variant as plan-of-record with honest fallback | DONE (script level) | `SCRIPT-1-TEASER.md` scene 3b: "Plan-of-record: ANAM avatar conversation on the video page (real mic). Honest fallback if no ANAM key on the capture stack: the podcast surface's Tap-to-ask, reframed..." |
| 9.4 | No "instantly" faked latency | DONE (script level) | Both `SCRIPT-1-TEASER.md` scene 3b and `SCRIPT-4-VIEWER-POWERS.md` scene 3b explicitly state "cut on the natural answer start — no faked latency." |

All four of 9.1-9.4 are commitments in the *script text*, independently verified by direct reading — genuinely well-executed. None are yet proven against produced footage, because no footage/assembly exists (§3, §5).

## 10. Device/browser sweep

| id | requirement | verdict | evidence |
|---|---|---|---|
| 10.1 | Sweep runs on the SEEDED PLAYLIST | NOT DONE | No seeded playlist exists (§1.4, §8). |
| 10.2 | chromium/firefox/webkit × phone/tablet/laptop | NOT DONE for this deliverable | Scratchpad has `device-matrix-sweep.mjs` (mtime 2026-09-04 19:31) and `batch-device-sweep.mjs` (mtime 2026-09-04 23:42) with matching screenshots (`verify-playlist-editor.png`, `verify-library-page.png`, `verify-share-dialog.png`, engine-firefox/webkit.png) — all dated **before** this branch's first commit (01:07 tonight) and matching the prior library/playlist-restyle PR's own verification, not this deliverable. Reusable tooling, wrong target. |

## 11. Documentation for future regeneration

| id | requirement | verdict | evidence |
|---|---|---|---|
| 11.1 | Scripts carry UI-label anchors | DONE | All 5 scripts name concrete anchors (e.g. `sec-sim-select`, `sec-sim-prompt`, `CollaboratorsSection`, "Access card in Video settings"). |
| 11.2 | Capture manifests | PARTIAL/NOT DONE | `README.md:29` promises `capture-all.mjs` → `captures/out/<scene-id>/…` as the manifest; this doesn't exist. A narrower `captures/STAGE.json` (from `stage-capture-prop.mjs`, in progress) is a staging manifest for one prop project, not the shot-by-shot capture manifest the contract describes. |
| 11.3 | PRODUCTION-PLAN.md status | PARTIAL | Exists and is actively maintained, but is **untracked in git** (`git status` shows `?? tutorial-kit/PRODUCTION-PLAN.md`) and contains the self-contradiction noted in 6.4. |
| 11.4 | README regeneration contract | DONE | `README.md` documents the full contract: layout table, 4-point "what update to the new UI means," hard rules section. |
| 11.5 | DECISIONS.md ledger entries (CLAUDE.md §3b) | NOT DONE | `grep -in "welcome\|tutorial-kit\|Tutorial Kit\|Welcome to Flow Video\|PRODUCTION-PLAN" /Users/ofeklevy/cebu/.claude/review/DECISIONS.md` → **zero matches**. Two real commits (`07df44c`, `77bf941`) plus substantial further uncommitted work exist with no ledger trace at all — the exact failure mode `CLAUDE.md §3b` was written to prevent ("work that is not in the ledger is work the next session cannot find"). |

## 12. Commit discipline, PR, deploy approval

| id | requirement | verdict | evidence |
|---|---|---|---|
| 12.1 | Everything committed on `feat/welcome-tutorial-kit` | NOT DONE | `git status --short` at 01:31: modified `CREATIVE-BRIEF.md`, `scripts/SCRIPT-1-TEASER.md`, `scripts/SCRIPT-2-TUTORIAL.md`; untracked `PRODUCTION-PLAN.md`, `scripts/SCRIPT-3-HEAVY-SIM.md`, `SCRIPT-4-VIEWER-POWERS.md`, `SCRIPT-5-SHARE.md`, `captures/props/`, `captures/stage-capture-prop.mjs`. Real, uncommitted work — an overnight-run risk in itself (see priority actions below). |
| 12.2 | PR opened | NOT DONE | `gh pr status` → "There is no pull request associated with [feat/welcome-tutorial-kit]." |
| 12.3 | Production deploy approval left for the owner, never auto-approved | N/A (not yet reached) | No PR, no release dispatch exists yet, so no approval gate has been reached either way. Nothing to flag as a violation; also nothing to credit as "passed." |

## 13. Token-budget resume timer

| id | requirement | verdict | evidence |
|---|---|---|---|
| 13.1 | If tokens near exhaustion, set an automatic resume timer instead of stopping | N/A (not repo-verifiable) | This is runtime/process behavior of the orchestrating agent session, not a code or filesystem artifact. A repo audit cannot confirm or deny it from evidence; only the orchestrating session itself can attest to it. `PRODUCTION-PLAN.md`'s header restates the instruction but restating an instruction is not evidence it will be honored. |

---

## Priority actions (highest user-visible risk first)

1. **Fix the word-timed-captions plan now, before narration work starts** (closes 4.4). `GuidanceTTSService` cannot produce word timings — the archived ElevenLabs `/with-timestamps` path is excluded from the build. The real path is: synthesize narration → assemble into the film's audio track → upload the finished MP4 through the normal video pipeline → `CaptionService`'s Groq STT produces `captions_vtt` automatically. Build the assembly/upload step with this chain in mind, or the captions step will silently fail or need a rewrite at 4am.
2. **Fix `ProjectDuplicationService` to carry `sim_files` before writing the seeding service** (closes 8.7 fix #1). `DESIGN.md` itself flags this as a pre-build blocker; it is still unaddressed. Building the clone path on top of it ships a known bug into the one feature the whole night is for.
3. **Commit what already exists** (closes 12.1). Two commits landed; a full extra round of work (3 niche scripts, capture-prop infra, doc edits) is sitting uncommitted on disk only. For an unattended overnight run this is the single easiest thing to lose to a crash or context loss — commit early and often, don't batch it all for one giant commit at the end.
4. **Add the DECISIONS.md ledger entry now, not at the end** (closes 11.5). Per `CLAUDE.md §3b`, this is due at the point of opening a PR at the latest, but there's no cost to adding a running entry earlier — the two commits that already exist have zero ledger trace right now.
5. **Build migration 085 + the seeding service** (closes 8.2, 8.3, 8.4, 1.4, 2.6). This is the actual product outcome ("a default demo experience seeded for every user") — everything else in this checklist is in service of this one landing. Nothing currently creates it.
6. **Resolve the G1-pre self-contradiction**: get the PM/accuracy critic's verdict recorded, or correct the "✅ ran (3 critics)" line to say 2-of-3 until it has (closes 6.4). Don't let a plan document assert something six lines above where it admits the opposite.
7. **Build the actual demo project + niche projects via the real APIs** (closes 2.1-2.6, 7.1-7.8): sections with This-moment prompts, minimal-UI generation, posters, permalink, share links, playlist assembly. `stage-capture-prop.mjs` proves the upload/HLS path works; nothing yet creates the deliverable itself.
8. **Run the full capture campaign** (closes 3.1, and unblocks 4/5/9's footage-level proof): `capture-all.mjs` per the README's own contract, not just sim b-roll.
9. **Generate the original infographic + ambient audio through a committed, regenerable script** (closes 2.3, 2.4, 3.4, 11.2) — the HTML→PNG technique is proven for a prop asset; make it a real script under `assembly/`, not a one-off.
10. **Decide the teaser's opening beat**: either add the brand-mark intro the brief calls for, or update `CREATIVE-BRIEF.md`'s style-reference note to match the product-first open the script actually uses (closes 1.2's one open sub-item) — small, but currently the brief and the script disagree with each other.
11. **Re-run the device/browser sweep against the actual seeded playlist once it exists** (closes 10.1, 10.2) — the existing sweep tooling is reusable, just needs to be pointed at the real target.
12. **Open the PR** once the above has landed (closes 12.2), and leave deploy approval for the owner as already planned (12.3 has no violation to fix, just don't let anything auto-approve later).

## Scope check

No unrequested work found. `captures/stage-capture-prop.mjs` and the "Standing Waves 101" prop
project look at first glance like scope creep (a whole extra project nobody asked for by name) but
they are correctly in service of requirement 3 (real captures need real on-screen content to film)
— not extra scope, necessary infrastructure for a named requirement.

---

## COMPLETION PASS — 2026-09-05, ~12:00–12:20 EEST

Re-audited against `feat/welcome-tutorial-kit`, commit range `77bf941..4fa4d79` (PR #192, open,
`main` ← `feat/welcome-tutorial-kit`), i.e. everything that landed after the baseline snapshot
above. **This branch was still live/concurrent during this pass** — a new commit landed and two
EDL files were mid-edit while this was being written; see the §12.1 row below. Baseline items not listed below
are unchanged from the original audit; only items whose verdict moved, or that are new, appear here.

### 1–2. Playlist + demo project — now largely BUILT, not just designed

| id | requirement | verdict | evidence |
|---|---|---|---|
| 1.4 | Playlist actually seeded for every new user | **DONE** | Migration `085_welcome_seed.sql` registered (`backend-api/src/db/migrate.ts:66`, last entry). `WelcomeSeedService.ts` (129 lines) wired from TWO real call sites: post-signup in `firebase-auth.ts:188-190`, and a heal-on-list path in `projects.controller.ts:165-168`. Admin toggle wired end-to-end: `settings.controller.ts:32` (schema) → `admin-web/app/feature-flags/page.tsx:216-221` (UI). 10/10 unit tests pass (`welcomeSeed.test.ts`, re-run live: `Test Files 1 passed, Tests 10 passed`) with real branch-differentiated assertions (env-override, admin-flag fallback, no double-seed, no self-seed, orphan-adoption, playlist swap with project-id substitution) — not theatre. **Independently re-ran the E2E check myself** (`node seeding/e2e-seed-check.mjs`) against the live local stack (backend genuinely running with `WELCOME_SEED_ENABLED=true`): fresh user → private clone created, playable (200), personal playlist leads with the clone (`playlistLeadsWithClone: true`), idempotent (`cloneCount: 1` after a second listing) → `"verdict": "PASS"`. |
| 2.1–2.6, 7.1–7.8 | Demo project + niche projects, built via real APIs (sections, This-moment, posters, permalink, share, playlist) | **DONE, with two real gaps (see §14.1/§14.2)** | `seeding/TEMPLATE.json` (built 08:04–08:09 UTC) records 26 build steps, 24 `done`. Real project (`4d4bec1f…`), 2 timeline videos with HLS, 3 working sim sections (Murmuration/Solar/Orbit, all `generated:true` with live `simulation_url`+poster), image + audio-sting sections placed, branching choice block (4 edges, all enabled), permalink `/welcome-flow-video` (200), share link, podcast/audio edition, playlist (4 items, shared). `verification.asserts`: 8/11 `ok:true` — the 3 `ok:false` entries are a known, already-logged false-negative in the assert's OWN section-counting logic (confirmed independently, §14.4), not a missing feature. |
| 8.2 | Migration 085 | **DONE** | `085_welcome_seed.sql` + `.rollback.sql` both present and registered. |
| 8.3 | Dark-gated env/admin flag | **DONE** (shipped a real, now-fixed regression — see §14.7) | `WELCOME_SEED_ENABLED` env overrides `admin_settings.welcome_seed_enabled`; both switches confirmed wired to real code paths, not just present in a schema. |
| 8.4 | Idempotent | **DONE** | 3-layer idempotency (per-boot memo, partial unique index + orphan-adoption, conditional pointer update) — confirmed both in code and by the live E2E re-run's `cloneCount: 1`. |
| 8.5 | Unit tests | **DONE** (see §14.7 for a real nuance) | 10 tests, genuinely differentiated fixtures/assertions per gate — verified by reading, not just by the pass count. |
| 8.6 | Integration tests | **DONE** | `seeding/e2e-seed-check.mjs`, independently re-run PASS this session (not just trusted from DECISIONS.md's attestation). |
| 8.7 | Pre-build fix #1 (`sim_files` on clone) | **DONE** | `ProjectDuplicationService.ts` diff (+94 lines in commit `f445debe`) adds the `sim_files` copy path the design doc flagged as a blocker. |

### 3–5. Capture / narration / assembly — now largely PRODUCED (as SCRATCH, not final)

| id | requirement | verdict | evidence |
|---|---|---|---|
| 3.1 | Captures via v0.7.0 stack + Playwright, comprehensive | **DONE** | `captures/out/MANIFEST.json` has 16 real recorded shots spanning BOTH editor scenes (f2-s2a…s8: new project, library drop, mark section, This-moment, preview, layers, share; f3-s2…s4: heavy-sim drop, simple UI, iteration) AND viewer/public scenes (f1-s3/s7, f4-s1/s2/s4, f5-s5) — genuinely covers the editor+viewer split the task asked about. See §14.5 for a real portability caveat in HOW these are recorded. |
| 4.1–4.3 | Real TTS / admin voice / spend | **Correctly still BLOCKED, honestly reported** | `narration/audio/` is empty on disk (0 files) — real ElevenLabs TTS genuinely never ran. `narration/audio-scratch/` has 41 real `.mp3` files (one per script scene, macOS `say`) — the "scratch VO stands in" claim is disk-true, not just asserted. README/DECISIONS both state this is blocked on an owner-side credential; nothing overstates it. |
| 4.4–4.5 | Word-timed captions / tap-to-ask on tutorial | **PARTIAL, mechanism now exercised but not confirmed end-to-end** | The films WERE uploaded through the real video pipeline (`TEMPLATE.json` A1/A2: `film1.SCRATCH.mp4`/`film2.SCRATCH.mp4`, HLS ready) — the correct path identified at baseline (Groq STT auto-transcription on upload) is genuinely reachable now, not merely theoretical. Did not independently confirm `captions_vtt` actually populated (a live API probe for it came back empty/inconclusive; not chased further given diminishing returns). Flag for the next session rather than assume either way. |
| 5.1 | ffmpeg assembly (captures+infographic+narration+music) | **DONE** | All 5 films exist on disk, `assembly/out/film{1..5}.SCRATCH.mp4`. Durations independently re-measured with `ffprobe`: film1=72s, film2=133s, film3=78s, film4=72s, film5=64s — match the README's per-film targets (~72s/~2:12/~78s/~72s/~64s) closely. **Filenames say SCRATCH**: these are structurally-complete, correctly-timed assemblies using placeholder (`say`-synthesized) narration, not final production audio — real narration is a re-run away once the ElevenLabs key is fixed (`narration/run-narration.sh --force` per README), but has not happened yet. |
| 5.2 | Loudness ≈ reference (−22.8dB mean) | **DONE, independently re-measured** | `ffmpeg -af volumedetect` on `film1.SCRATCH.mp4`: **mean_volume: −23.0 dB** — a 0.2dB match to the −22.8dB reference. (Caution for future audits: the assembly pipeline's own `loudnorm` filter targets **−19 LUFS** integrated, `assembly/assemble-film.mjs:112` — a different, EBU-R128 metric from the plain dBFS "mean_volume" the reference number appears to use; measured Input Integrated was −19.7 LUFS, i.e. it matches ITS OWN target, not the −22.8dB figure directly. Don't conflate the two metrics in a future pass — re-verified the actual dBFS mean is what lines up with the stated reference.) |
| 5.3 | QC at 360p legibility | **PARTIAL** | Real QC-still infrastructure ran: 4 frames per film (8%/35%/60%/92% of runtime) × 5 films = 20 PNGs in `assembly/out/qc/`. No step actually downscales to 360p specifically (`assemble-film.mjs`'s only `scale=` call targets 1920×1080) — the stills are full-resolution frame grabs, so "legibility AT 360p" specifically was not demonstrated, only frame-level QC in general. |
| 5.4 | H.264 1080p output | **DONE** | `ffprobe` on `film1.SCRATCH.mp4`: `codec_name=h264, width=1920, height=1080, r_frame_rate=30/1`. |

### 6. Critique gates — G1-post is now claimed CLEAR in three places the ledger of record does not support

| id | requirement | verdict | evidence |
|---|---|---|---|
| 6.4/6.5 | G1-pre/G1-post gate completion | **Still not DONE, and now a worse, multi-document version of the same problem** | `PRODUCTION-PLAN.md` (the branch's own "ledger of record", per `DECISIONS.md`) is **unchanged since its one commit** (`git log --follow` shows exactly 1 commit; `git diff HEAD` clean) and still reads, verbatim: `PRODUCTION-PLAN.md:59` `\| G1-post \| scripts v2 after fixes \| pending \|` and `:89` `PM/accuracy critic: still running — its findings fold into v2 before G1-post.` No PM/accuracy findings were ever recorded anywhere (grepped the whole repo for a verdict doc — none exists). Yet **three other places now assert it passed**: `README.md:61` `"5 scripts through the critics-panel gates (G1-pre, G1-post CLEAR, films 3-5 panel)"`, `scripts/SCRIPT-1-TEASER.md:1` and `SCRIPT-2-TUTORIAL.md:1` both title themselves `"v2.1 (G1-post CLEAR)"`. This is the exact self-contradiction the original checklist flagged at 6.4 (`CLAUDE.md §3b`'s named failure mode) — except it has since spread from one internally-contradictory file to a genuine cross-document conflict between the source-of-truth ledger and three downstream documents, none of which were reconciled with it. The scripts' actual SUBSTANCE still reads as satisfying the honesty/accuracy bar on independent inspection (§9 below) — but that remains this auditor's read, not the recorded critic sign-off the plan itself requires. |

### 9. Script honesty — re-verified against the ACTUAL shipped product, not just script text

| id | requirement | verdict | evidence |
|---|---|---|---|
| 9.1 | "Built exactly this way" is true of the seeded project (owner steer moved this from Wave Lab to Solar System) | **DONE — verified byte-exact against the live build, not just read for internal consistency** | `SCRIPT-2-TUTORIAL.md` scene 4 has the capture rule: the on-camera prompt "must be VERBATIM the seeded section's stored prompt" — **"Give viewers the planets — let them speed up time and fly to any world."** Confirmed this exact string exists in THREE independent places: the script (`SCRIPT-2-TUTORIAL.md:19`), the builder source (`seeding/build-template.mjs:366`), and the actual API-committed value (`seeding/TEMPLATE.json` → `demo.sections.sim2.prompt`). All three match character-for-character, including the em dash. |
| 9.2–9.4 | Handover scope honesty / ANAM-fallback honesty / no faked latency | **DONE, still holds in the current v2.1 text** | Re-read directly: `SCRIPT-2-TUTORIAL.md:11,22,24,31` (edit/sim-swap scope, dubbing deferred to film 4); `SCRIPT-1-TEASER.md:18` and `SCRIPT-4-VIEWER-POWERS.md:10` (ANAM plan-of-record + honest fallback; "no faked latency" stated explicitly in both). |

### 10. Device/browser sweep — still not demonstrated against the real deliverable; a specific PR claim doesn't check out

| id | requirement | verdict | evidence |
|---|---|---|---|
| 10.1/10.2 | Sweep on the seeded playlist, chromium/firefox/webkit | **Still NOT DONE — a specific claim to the contrary does not check out** | PR #192's own body states: *"Cross-engine smoke (firefox/webkit) loads the permalink with all four videos mounted."* Searched the whole repo (`tutorial-kit/`, `seeding/`) and the session scratchpad for any firefox/webkit-tagged script or artifact: the ONLY matches are `engine-firefox.png`/`engine-webkit.png`, dated **2026-09-04 19:52** (the day before this branch's build) and showing a **Kinesin motor-protein "Walking cycle" demo** — confirmed by direct image inspection — i.e. leftover screenshots from an unrelated, earlier audit, not evidence of a welcome-playlist cross-engine check. CI's own "Viewer end-to-end (firefox/webkit, real app on loopback)" jobs did pass on this PR, but those are the pre-existing general viewer E2E suites, not a check of this specific permalink/playlist. No artifact substantiates the PR body's specific claim. |

### 11. Documentation

| id | requirement | verdict | evidence |
|---|---|---|---|
| 11.5 | DECISIONS.md ledger entries | **DONE, one small currency gap** | Substantive entry exists at `DECISIONS.md:2313-2345` (SHIPPED-TO-BRANCH, BUILT, 3× 🔴 OPEN, PR-opened lines) — real, specific, not just "work happened." Gap: the live hotfix commit `4fa4d79` (§14.7) landed after this entry was written and is not yet reflected — expected given timing (it landed minutes before this pass concluded), flagged for the next ledger touch rather than treated as a violation. |

### 12. Commit/PR/deploy

| id | requirement | verdict | evidence |
|---|---|---|---|
| 12.1 | Everything committed | **PARTIAL — live risk recurring, but for a different reason than before** | `git status --short` at the end of this pass: `M assembly/edl/film1.json`, `M assembly/edl/film4.json` — real, uncommitted, and changing WHILE this audit ran (confirmed by re-diffing mid-session: EDL shot references being updated from placeholders to real recorded shot IDs, e.g. `f1-s3-ask-surface`). This is the same class of risk the baseline's priority action #3 named; this time it reflects genuinely continuous work rather than neglect, but the exposure (uncommitted work an interrupted run could lose) is the same. |
| 12.2 | PR opened | **DONE** | PR #192, `feat/welcome-tutorial-kit` → `main`, open, mergeable. |
| 12.3 | Deploy approval left to owner | **N/A, unchanged** | No deploy/release dispatch attempted. |

---

## 14. New findings from this pass (not in the original 13 sections)

1. **[Highest priority — licensing/compliance] Two new sim packages with zero license documentation were added to the SEEDED template, and one was wired live, without recorded authorization.** `captures/props/galton-board.zip` and `five-species.zip` (each a single `index.html`, no LICENSE/attribution file, no license text found inside either — checked directly) were uploaded into the demo project's library (`TEMPLATE.json` step `A3`) and Galton Board was wired as a **4th live sim section** (`A5a`). Searched `CREATIVE-BRIEF.md`, `PRODUCTION-PLAN.md`, `README.md`, `seeding/DESIGN.md` for any mention of either sim's origin or license: **zero hits in all four**. PR #192's body calls them an "owner-GitHub variety pair" with no license named, which does not satisfy `CLAUDE.md §8`'s explicit rule ("name every new dependency and its licence in the PR body; when unsure, leave it out and say so"). This is a materially different situation from kinesin/dynein, which has a *dated, repeatedly-cited* owner permission and is contractually restricted to film-captures-only (never seeded) — these two are already inside the artifact every new user's account will contain. **Also a scope deviation**: `PRODUCTION-PLAN.md:40` ("OWNER STEER 3", timestamped 02:05) explicitly finalizes *"Final seeded lineup (3 sims, distinct characters): Murmuration 3D, Solar System 3D, Orbit Lab"* — Galton Board appears in none of the planning documents' decision record, only in the build script and the PR body.
2. **[High — correctness] The demo project's image + audio sections are unreachable by design, because it also has a branching block.** `client-web/components/viewer/useProjectPlayer.ts:2506` (`updateBrollOverlay`) and `:2549` (`updateAudioCutaway`) both open with `if (branching) return;  // flat overlays disabled in branching mode (Phase 2)`. The seeded demo project has BOTH a branching choice block (`A7`, "What next?") AND an image section + ambient-sting audio cutaway (`A6`) on the SAME project — meaning the infographic (checklist 2.3) and the ambient sting (2.4) will never render for any real viewer, despite being correctly configured server-side and shown as "done" in the build log. `TEMPLATE.json`'s own `notes` array already documents this exact tradeoff and explicitly says it needs a decision ("keep or drop the choice graph at capture time") — the decision was never made; the build kept both, so the conflict ships live and silent (nothing errors; the content is just never shown).
3. Galton Board's This-moment generation genuinely fails (`"Galton Board: generation error: Generation failed. Please try again or simplify your prompt."`, persisted verbatim in `TEMPLATE.json` → `demo.sections.galton.generation_error`) — already correctly logged in `DECISIONS.md` as 🔴 OPEN; independently re-confirmed from the persisted build record, not just trusted from the ledger.
4. `build-template.mjs`'s own `verification.asserts` block reports `"two sim sections present": false, found 1` (and two dependent per-section asserts also `false`) — already correctly logged in `DECISIONS.md` as a known false-negative in the assert's own counting logic (the real project has 3 working live sections, confirmed via `demo.sections`); re-confirmed independently rather than taken on trust.
5. **[Hygiene] The entire capture pipeline's `playwright` resolution is anchored to a hardcoded personal path.** All 10 scripts under `captures/` (`capture-all.mjs`, `probe-editor.mjs`, `record-sim-footage.mjs`, etc.) resolve the `playwright` package via `createRequire(pathToFileURL('/Users/ofeklevy/Desktop/Kinesin and Dynin/3d-kinesin/package.json'))` rather than any dependency inside this monorepo — despite `playwright` being genuinely installed and reachable in-repo (`node_modules/.pnpm/playwright@1.60.0`, used by `client-web`). This works today only because this exact developer's machine happens to have that external folder; it directly undercuts the README's own "regeneration contract" premise ("re-running scripts, not archaeology") on any other machine, or this same machine after that folder is cleaned up.
6. The teaser's opening-beat contradiction named in the ORIGINAL checklist (priority action #10) is **still unresolved**: `SCRIPT-1-TEASER.md`'s scene 1 (0:00–0:04) still opens on Kinesin product footage; `CREATIVE-BRIEF.md`'s STYLE REFERENCE item 1 still calls for "Animated brand-mark intro on a clean light ground (~3s) — then straight into product" first. Neither document was reconciled despite the script reaching "v2.1 (G1-post CLEAR)".
7. **[Live during this audit] PR #192's CI genuinely failed, was diagnosed, and was fixed, all within this pass.** At the run captured 08:50–08:52 UTC, two required checks failed: (a) **Release verification gate** — `admin-web`'s `adminControlsA11y.test.tsx` (`ui-ux-007`, "gives every switch the name of the flag it throws") asserted exactly 5 named switches and got 6, because this PR's own new "Welcome project seeding" toggle (`admin-web/app/feature-flags/page.tsx:216-221`) was never added to the test's expected-names list; (b) **Static audits** — the backend test-typecheck ratchet (`deploy/scripts/typecheck-tests-ratchet.sh`) reported `welcomeSeed.test.ts (4 new)` type errors, i.e. real TypeScript errors in a file vitest's runtime execution never surfaces (exactly the gap that ratchet exists to catch). **A commit landed mid-audit** (`4fa4d795`, "test: satisfy the CI gates the new toggle and test tripped") that fixes both by name; re-triggered CI was polled to completion in the background — see the final line of this report for the outcome.
8. Ledger currency: `DECISIONS.md`'s 2026-09-05 entry predates commit `4fa4d795` and does not yet mention it (expected — it landed minutes before this pass concluded).


### Scope check (this pass)

No unrequested implementation work found (this pass only read, measured, and re-ran existing
scripts/tests — no code changed). The completion-pass audit itself surfaced two things worth
naming as scope-adjacent rather than as findings against a requirement: (1) a stray, wrongly-placed
memory directory was committed at `podcast-saas/backend-api/.claude/agent-memory/task-tracker/`
(should be at the git root's `.claude/`) — harmless to the build (markdown only, not imported by
any TypeScript), but worth a cleanup pass since it will keep confusing future memory look-ups; (2)
the Galton Board / Five Species sim addition (§14.1) is itself scope creep relative to
`PRODUCTION-PLAN.md`'s own recorded "final lineup" decision, independent of its licensing gap.

---

## CRITICAL UPDATE (supersedes §14.7's "see the final line of this report") — a REAL regression, currently blocking PR #192

The CI re-run triggered by commit `4fa4d795` (which fixed the admin-a11y and welcomeSeed-typecheck
failures) was polled to completion. Result: **`Static audits` now SUCCESS; `Release verification
gate` is now FAILING FOR A DIFFERENT, NEW REASON** — and this one is a real product regression, not
a test-hygiene gap.

`client-web`'s test suite never actually ran to completion in the FIRST CI attempt: pnpm's
recursive-run stops at the first failing workspace package, and `admin-web` failed first
alphabetically, masking whatever came after it. Fixing `admin-web` let the pipeline reach
`client-web` for the first time in this PR's CI history — where it failed:
`Test Files 2 failed (2) | Tests 5 failed | 1983 passed (1988)`, in
`__tests__/simExitHandoff.test.tsx` (4 failures) and `__tests__/viewerActiveSimUrl.test.tsx`
(1 failure) — e.g. `"the seek must be issued at T0: expected 10 to be +0"` and
`"the return committed but never released the key: expected '...index.html' to be null"`.

**Confirmed by direct comparison, not inferred:** ran the identical two test files against a clean
`git worktree` of `main` (`bde9317c`) — **26/26 PASS**. Ran them again on this branch — **5/26
FAIL, reproducible locally** (`pnpm --filter client-web exec vitest run __tests__/simExitHandoff.
test.tsx __tests__/viewerActiveSimUrl.test.tsx`). The only `client-web` file this branch touches
relative to `main` is `components/viewer/useProjectPlayer.ts` (+75/-4), the "post-roll 'Go back to
video' ADVANCES instead of replaying" change the seeding commit (`f445debe`) describes as "verified
live through the whole welcome arc." That live click-through verification did not catch what the
existing automated suite catches: the new `simReturnPlanRef` virtual/seek continuation logic
(`useProjectPlayer.ts` ~lines 2083-2113, ~4222-4260) leaves stale seek state or fails to release
`activeSimUrl` on at least one explicit-return path.

**This is still open as of this pass — do not treat it as fixed.** While investigating, a SEPARATE,
uncommitted, in-progress edit to this same file was observed on disk (a `TEMP-DIAG` console.log in
`revealChoice` plus a fix for choice-doors-appearing-over-a-live-section) — evidence the concurrent
run is actively working in this exact area, but re-running the two failing spec files against that
uncommitted state still gives the same **5 failed | 21 passed** — it does not touch the regression
above. `gh pr view 192`: `mergeable=MERGEABLE mergeStateStatus=UNSTABLE`.
