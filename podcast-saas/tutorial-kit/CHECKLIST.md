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
