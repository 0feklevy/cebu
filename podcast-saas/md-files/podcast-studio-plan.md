# Podcast Studio — Master Plan (v2, adversarially verified)

> NotebookLM-grade two-host podcast generator: multi-agent writers' room → editable per-turn script page → ElevenLabs v3 export with dead-air removal & natural overlaps → single-channel MP4.
> **Standalone product on the homepage** — its own entity tree (Shows → Episodes), NOT part of a video project.

Status: PLAN v2 (recon 2026-07-06 → plan → 4-agent adversarial verification → all findings folded in).
Build order per owner: **Phases 1–2 first (script generation + editor), audio export after.**

---

## 0. Verified foundations (recon summary)

| Asset | Where | Verdict |
|---|---|---|
| v1 podcast pipeline (3-pass script gen, per-turn editor UI, ElevenLabs TTS provider, ffmpeg assembly) | `backend-api/src/_archive/v1-podcast-pipeline/`, `client-web/_archive/...`, `shared/src/_archive/...` | **Reference, not re-mount** (verified: new Turn schema ≠ archived types; archived code becomes rewrite-with-reference). DB tables, LLM stack, prompt files, auth all still live. |
| Writers'-room reference (7 specialists, 5 pillars, host cards, v3 spec) | `reference-podcast/{SKILL-PODCAST,HOST,ELEVEN-V3-SPEC}.md`, `epsold-01.txt` | The soul of the product → seeded system prompts (general + science niche packs). |
| Live infra: LLMService (+quota/pause/usage), queue (CAS), Supabase storage, `runFfmpegLimited`, SSE, client-v1.ts | `backend-api/src/**` | Use as-is; conventions in §9 binding. |

Hard API facts (verified against live ElevenLabs docs + OpenAPI spec + Claude API docs):
- `eleven_v3`: **no request-stitching, no SSML `<break>`**; dialogue endpoint ≤ **2,000 chars/request**, ≤10 voices; `settings` = `stability` only (snaps 0.0/0.5/1.0). Freeform audio tags officially sanctioned ("experiment beyond the list").
- **`POST /v1/text-to-dialogue/with-timestamps` → `voice_segments[]`** (exact per-line start/end in the stitched audio) + char-level alignment. This is our pause-removal lever.
- Voice add required before use: `POST /v1/voices/add/{public_owner_id}/{voice_id}`. Search: `GET /v1/shared-voices` (filters: gender/age/accent/language/category/use_cases/search + `preview_url`).
- Claude 2026: `claude-opus-4-8` / `claude-fable-5` **reject `temperature` and `budget_tokens` (400)**. Use `thinking:{type:'adaptive'}` (omit entirely on fable-5) + `output_config:{effort}`. Creativity lives in prompts, not sampling. Fable refusals → server-side `fallbacks` beta. Opus 4.8 pricing $5/$25 MTok, Fable $10/$50.
- Human timing: modal turn gap ≈200 ms; backchannels start 300–700 ms before previous turn ends. All OSS clones do zero timing work — the stitcher is our differentiator.

---

## 1. Product shape

**Homepage → "Podcasts" product section** (accent: rose `#f43f5e`) — sibling of Projects/Playlists in `HomeSidebar.tsx` + CTA in `HomeHero`.

```
Show (series: hosts+voices+personas, language, niche pack, style knobs, series memory)
 └── Episode (brief + sources → script versions → renders)
```

Routes: `/podcasts` · `/podcasts/[showId]` · `/podcasts/[showId]/episodes/[episodeId]` (workspace tabs: **Brief → Script → Audio**).
⚠️ **Reserved-slug step (verified collision):** add `'podcasts'` + `'podcast'` to `RESERVED_SLUGS` in `backend-api/src/services/permalinkService.ts` in the same change that adds the route; check DB for an existing `permalink_slug='podcasts'` (rename + notify).

**Roles (owner spec — REVERSED vs the reference episode):**
- **Brittney** (`kPzsL2i3teMYv0FxEYQ6`) = **teacher** — knows the material, guides to insight by questions.
- **Titan** (candidate `dtSEyYGNJqjrtBArPCVZ` — verify via `GET /v1/shared-voices?search=Titan`) = **learner** — audience surrogate: asks, guesses wrong plausibly, ice-breaks, jokes.
- **Seed step (Phase 1, not Phase 4):** verify both voices via search API **and `voices/add` them to the workspace** (idempotent), store resolved voice_ids. Shared-library voices don't synthesize until added — deferring this to Phase 4 would break the first Phase-3 export.

**Episode lifecycle (explicit — the edit→approve→export→re-edit loop):**
1. Approved script versions are **immutable**. First edit on an approved version **auto-forks v(N+1)** (copy, status `ready`); episode returns to `script_ready`.
2. Export requires the latest **approved** version.
3. `podcast_renders` is the source of playable truth: episode shows `ready` if any render is ready; a failed re-render shows a "latest render failed" badge while the previous master stays playable/downloadable.
4. "Script changed since last render" banner when approved-version content hash ≠ last render's script hash. Re-export is cheap (chunk cache, §4).
5. Re-approve of v(N+1) **upserts** the episode's memory summary (keyed by episode_id) and rebuilds the show's rolling memory — never appends duplicates.

---

## 2. Data model (migration `044_podcast_studio.sql`)

New tables (NOT reusing project-coupled `scripts`; shared types authored fresh in `shared/src/types/podcast.ts` — do **not** restore archived shared types):

```sql
podcast_shows (
  id uuid PK, org_id, created_by,
  title, description, language text default 'en',       -- per-episode override allowed
  teacher_name text default 'Brittney', teacher_voice_id text,
  learner_name text default 'Titan',   learner_voice_id text,
  teacher_persona text, learner_persona text,
  niche_pack text default 'general',                    -- 'general' | 'science' | ...
  style_config jsonb,                                   -- humor level, analogy density, user_instructions (owner's extra MD prompt slot)
  memory_json jsonb,                                    -- rolling series memory (rebuilt from episode summaries)
  tts_seed bigint,                                      -- reserved
  created_at, updated_at
)
podcast_episodes (
  id uuid PK, show_id FK, episode_number int,
  title, brief text, target_minutes int default 8,
  language text,                                        -- optional override
  status text default 'draft',   -- draft|scripting|script_ready|approved|rendering|ready|failed
  tts_seed bigint,               -- minted on first render, REUSED across renders ("re-roll voices" bumps it)
  memory_summary jsonb, error text, created_at, updated_at
)
podcast_sources (
  id uuid PK, episode_id FK, kind text,                 -- 'file'|'url'|'note'
  storage_key text, source_url text, extracted_md text, title text, status text, created_at
)
podcast_scripts (
  id uuid PK, episode_id FK, version int, unique(episode_id, version),
  status text,                    -- drafting|reviewing|rewriting|compiling|ready|approved|failed
  claimed_at timestamptz,         -- job CAS claim (multi-stage status ⇒ dedicated claim column)
  story_json jsonb,               -- Pass A: story world, focus sentence, XY, beats+bridges, closing_return, curiosity ledger
  materials_json jsonb,           -- Pass B: analogy spine map, worked examples, grounding quotes, misconceptions
  review_json jsonb,              -- Pass D reports (auditor, ear editor, narrative judge)
  body_json jsonb,                -- FINAL turns (tags INLINE in text)
  content_hash text,              -- for "changed since render" banner
  telemetry jsonb, approved_at, created_at, updated_at
)
podcast_chunk_audio (              -- synth cache
  id uuid PK, episode_id FK,
  chunk_hash text,                 -- sha256 of the EXACT serialized ElevenLabs request payload (incl. context turns, tags, voices, seed, stability, language, normalization, format)
  unique(episode_id, chunk_hash),  -- ON CONFLICT DO NOTHING
  storage_key text, duration_ms int,
  segments_json jsonb,             -- voice_segments (per-line boundaries)
  kind text default 'chunk',       -- 'chunk' | 'backchannel' (reusable micro-clips library)
  created_at
)
podcast_renders (
  id uuid PK, episode_id FK, script_version int,
  status text,                     -- queued|synthesizing|stitching|encoding|ready|failed
  claimed_at timestamptz, progress jsonb,
  master_mp4_key text, master_mp3_key text, duration_ms int,
  script_hash text, timeline_json jsonb, cost_cents int, error text,
  created_at, updated_at
)
```

`system_prompts` seed rows — shape is `(key, name, content)` (verified against `019_guidance.sql`): `podcast_architect`, `podcast_materials`, `podcast_playwright`, `podcast_fact_auditor`, `podcast_ear_editor`, `podcast_narrative_judge`, `podcast_v3_compiler`, `podcast_turn_regen`, `podcast_memory_scribe`, `podcast_niche_science`, `podcast_hosts_general`.

**Turn schema** (`shared/src/types/podcast.ts`, Zod with `.catch()` resilience; copy the pattern from archived `DialogueTurnSchema`, not the types):
```ts
Turn = {
  id: string,                  // stable uuid, survives edits
  speaker: 'teacher' | 'learner',
  text: string,                // ≤ ~280 chars, 1–3 sentences; AUDIO TAGS INLINE: "[laughs] Right. [thoughtful] But wait..."
                               // (mid-turn tag placement is required by the v3 spec — no separate tags[] array)
  overlap: boolean,            // backchannel — synthesized separately & overlaid (§4)
  pause_after_ms?: number,     // editor override; else gap map
  is_hook?: boolean,
  beat: string                 // beat id → chunking is per-beat (cache stability)
}
ScriptBody = { title, turns: Turn[], open_loop?: string }
```

Access: shows gated by `created_by` **via one helper** `services/podcastAccess.ts` (never inline; keeps the later collab retrofit honest). All routes behind `firebaseAuthMiddleware`.

---

## 3. Backend — script generation (Phase 2)

### 3.1 LLM plumbing upgrade (prerequisite; verified file-level)
ClaudeProvider **breaks today** on opus-4-8 (sends `temperature` or `budget_tokens` on every call — both 400 on 4.7/4.8/fable-5):
- `ClaudeProvider.ts` (~L27, 60-62): add `claude-fable-5` to allowlist **and** `getAvailableModels()`; per-model param policy — for 4.7+/fable: no `temperature`/`top_k/p`, `thinking:{type:'adaptive'}` explicit on opus (omit on fable-5), pass `output_config:{effort}`.
- `LLMProvider.ts` (~L24-34, 64-65): add `effort?` to `LLMOptions`; **fix stale Opus pricing** → opus-4-7/4-8 $5/$25 (`{input:0.0005, output:0.0025}` in table units), fable-5 $10/$50.
- `LLMService.ts` (~L38, 122-127, 146, 183-202): add `'creative'` to tier union + `TASK_TIER` entries for `podcast_architect|podcast_materials|podcast_playwright|podcast_review|podcast_rewrite|podcast_compile|podcast_turn_regen|podcast_memory`; `resolveProviderAndModel`: `creative → admin_settings.podcast_model/podcast_effort`; extend thinking gate to creative; suppress `temperature` for the new models; **exempt `creative` from retry-escalation** (today parse-retries escalate to `complex_model` = gemini-2.0-flash — silent quality collapse); branch on `stopReason==='refusal'` BEFORE `parseAndRepair` (else refusals are misdiagnosed as parse errors → escalation).
- Fable refusals: prefer server-side fallbacks — `betas:['server-side-fallback-2026-06-01']`, `fallbacks:[{model:'claude-opus-4-8'}]` (one round trip, auto repricing). Note: fable-5 needs 30-day data retention; fail gracefully with a clear admin-facing error if org is ZDR.
- New `admin_settings` columns: `podcast_model` (default **`claude-opus-4-8`**), `podcast_effort` (default **`max`** per owner; admin-tunable — `xhigh` is the recommended fallback if max overthinks). Mirror in `LlmConfigSchema` (`controllers/admin/v1/llm-config.controller.ts`) + `admin-v1.ts`.

### 3.2 The writers' room (`services/podcast/ScriptRoom.ts`)
6 LLM passes + deterministic validator; every pass = `LLMService.sendStructured` (quota/pause/usage apply). Prompts from `system_prompts` (+ niche pack + host cards + style_config + director notes) with `{{PLACEHOLDER}}` substitution. Per-pass telemetry.

```
A. STORY ARCHITECT → story_json
   in: brief, sources (<corpus> w/ prompt-injection guard), series memory, pillars, target_minutes, director notes
   out: • XY gate: "about X; what's interesting is Y" (Y = surprise, not theme)
        • focus sentence ("someone does something because... but...") — one concept, everything serves it
        • STORY WORLD: ONE spine for the whole episode. If the user's brief contains an analogy
          it is MANDATORY as the spine — extend/upgrade it, never replace it.
        • cold open ≤90 words (mid-scene / most counterintuitive true sentence; value promise; open loop)
        • numbered beats, each with: pedagogical role, pillar, time budget,
          **bridge → next beat** (one of the 9 transition patterns, §6) — meta-navigation banned
        • breaking moment (learner's plausible wrong guess), teach-back placement
        • closing_return (how the ending pays off the cold open) + open loop for next episode + callbacks
        • curiosity ledger (loops opened/closed; ≥2 open mid-episode, ALL closed by end)
B. MATERIALS HUNTER → materials_json
   • analogy SPINE map: {element → concept → relation preserved} + declared breaking points
     (user analogy first-class: map → extend to 2 new true predictions → stress-test → declare the break on air)
   • fallback analogies ONLY for beats past a declared break ("temporary loaner", return to spine ≤2 beats)
   • 2–4 worked numeric examples in ear-friendly numbers, spoken aloud with intermediate results
   • misconception minefield; grounding: 1–2 quotes/facts per beat from sources (anti content-collapse)
C. PLAYWRIGHT → draft turns[]
   host cards binding (teacher guides by questions; learner guesses/objects/teach-backs; never mention host names in-dialogue),
   guess protocol, ≤3 sentences/turn + 1-2-word reaction turns, interruption budget 1–3 (SCRIPTED overlap turns only),
   no serial agreement, humor from situation, scratchpad-first (stripped), STORY ENGINE rules (§6) binding,
   every beat change through its bridge INSIDE the story world
D. PARALLEL REVIEW (3 agents, Promise.all) → review_json
   D1 Fact/Logic Auditor: 🔴 wrong (must fix) / 🟠 misconception-seeding (needs declared-simplification flag) / 🟡 analogy overstretched
   D2 Ear Editor: hook meter (≥1/90s) · lecture meter (>3 sentences) · tic meter (serial affirmations, host-name mentions)
      · spoken-language meter · persona meter (WHO EXPLAINS each beat — must be teacher) · **transition meter**
      (flag any beat boundary that resets context / reads as a section break) · **metaphor-churn meter**
      (new analogy while the spine still works) · length estimate
   D3 Narrative Judge (PodBench rubric): hook /6, structure&flow /10, rhythm /8, ending /6, naturalness, persona consistency;
      MUST quote the weakest transition verbatim + propose its rewrite
E. PLAYWRIGHT REWRITE → v2 (all 🔴/🟠 mandatory; judge's weakest-transition rewrite applied; one extra focused round if 🔴 remain)
F. V3 PRODUCTION COMPILER → final body_json
   ELEVEN-V3-SPEC: inline tag dosage (≤1/turn avg, ~1 per 2–3 turns), documented tags preferred + freeform flagged experimental,
   numbers/symbols → spoken words (language-aware; Hebrew rules incl. gender agreement), ellipses/punctuation pacing,
   **strips em-dash/crosstalk constructs — ALL overlaps come from the stitcher** (marks short reactions overlap:true),
   splits >300-char turns, strips scratchpad/markers
G. DETERMINISTIC VALIDATOR (no LLM): Zod parse, inline-tag whitelist scan (+experimental flags), ≥1 hook,
   speaker sanity (overlap turns exempt), per-turn hard cap, user-analogy keyword present in final turns (when supplied)
```

Job: `podcast_script` (queue/types.ts + registry.ts), **CAS claim on `claimed_at`** (multi-stage status ⇒ any non-terminal stage + fresh claim = held), stale window **45–60 min** (opus-max passes run long; crop's 20-min window is too short), `recoverStuckPodcastScripts()` at startup next to the existing recover fns. Progress: status/stage polling (canonical) + optional SSE via `src/lib/sse.ts` (`?token=` auth).
Note: new jobs run **inline** unless added to `PGBOSS_JOB_NAMES` — acceptable for v1 (CAS + recovery cover restarts); flag for the durable-worker roadmap item.

`POST .../script/generate` accepts optional `notes` (director's notes → injected into A/C/E) — the "user is the director" channel for regenerate-with-feedback.

### 3.3 Series memory
On approve: `podcast_memory` task (Memory Scribe) → `memory_summary` {concepts_taught, analogies_used (spine + where it broke), callbacks_planted, open_loops, running_jokes, listener_promises} — **upsert by episode_id**; show `memory_json` rebuilt from all episode summaries (never incremental append). Injected into passes A + C of the next episode. Editable/prunable in show settings.

### 3.4 Editor API (rewrite-with-reference from archived `scripts.controller.ts`; new namespace, turnId-addressed)
```
POST   /api/v1/podcasts/:showId/episodes/:epId/script/generate     (202; optional {notes})
GET    .../script?version=      + .../script/versions
PATCH  .../script/:v/turns/:turnId          (text w/ inline tags, speaker, overlap, pause_after_ms)
POST   .../script/:v/turns/:turnId/regenerate   (hint + 2-neighbor context window)
PUT    .../script/:v/turns                  (insert/delete/reorder/split/merge)
POST   .../script/:v/approve                (idempotent; sets content_hash)
POST   .../script/:v/turns/:turnId/preview  (Phase 3; 3-input context synth, §4)
```
Editing an approved version auto-forks (§1). All endpoints hand-mirrored in `client-v1.ts` (~15–20 methods; name types `PodcastShow/PodcastEpisode/PodcastTurn` — avoid colliding with legacy `Host`/`Corpus` exports).

---

## 4. Backend — audio export (Phase 3): the de-dead-air stitcher

Job `podcast_render` (CAS on claimed_at, staged progress, startup recovery). **Whole pipeline at 44.1 kHz** (no 48k round-trip).

```
1. CHUNK     pure function of BEAT: one chunk per beat (split oversize beats at internal seams
             WITHIN the beat only — never pack across beats ⇒ an edit invalidates exactly one beat's chunks).
             ≤1,800 chars incl. injected tags + context turns (margin under 2,000).
             overlap:true turns are EXCLUDED from chunk inputs (separate backchannel synth, step 2b).
2a. SYNTH    per chunk: POST /v1/text-to-dialogue/with-timestamps
             { inputs: [ ...context: last 1–2 turns of previous chunk (audio discarded later)...,
                         {text (tags inline), voice_id}, ... ],
               model_id:'eleven_v3', seed: episode.tts_seed, settings:{stability:0.5},
               language_code, apply_text_normalization:'off' }        // compiler already normalized; keeps char indices stable
             output_format: pcm_44100 if plan allows, else mp3_44100_128.
             VALIDATE: voice_segments.length === inputs.length, every dialogue_input_index present,
             per-segment chars/sec in ~8–30 (catches v3 dropped/merged lines), tag-vocalization check
             (alignment chars of "[tag]" mapping to >200 ms audio ⇒ model spoke the tag) → retry seed+1 (budget 10–20%).
             Cache by chunk_hash = sha256(exact request payload). Concurrency 2–4 (plan-tier), backoff.
2b. BACKCHANNELS  each overlap turn = its own 1-input dialogue call, cached as kind='backchannel'
             keyed by (voice, text, tags, seed) — a reusable per-show micro-library ("Mm-hmm", "[laughs] Right").
3. RECUT     decode chunk → wav 44.1k mono; slice per voice_segments WITH GUARD BANDS
             (±100–150 ms, clamped to inter-segment gap midpoint — protects word onsets from mp3
             encoder-delay uncertainty); drop context-turn segments; defensive: if segments overlap in time,
             treat the pair as one atomic clip.
4. TRIM      per clip: silencedetect (noise=-45dB:d=0.15) two-pass → atrim + asetpts=PTS-STARTPTS,
             keep 50–80 ms pads. PLUS intra-clip dead-air compression: internal silences >500–600 ms
             cut to 200–300 ms (15 ms crossfade at joins) — exempt turns with intentional [pause]/ellipsis.
             ("kill dead air WITHIN turns", per owner spec.)
5. LEVEL     per-clip gain to −18…−20 LUFS (loudnorm pass-1 measure → volume=XdB in the graph) —
             hides chunk-seam loudness jumps and creates overlap headroom. Backchannels −7 dB further.
6. TIMELINE  (Node) absolute starts: question→answer 120–200 ms · normal 200–350 ms ±75 jitter ·
             same-speaker 50–150 ms · beat bridge 400–600 ms · after-laugh ~400 ms ·
             after scripted-interruption text ("—") 0–80 ms · pause_after_ms overrides.
             Overlaps: start = prevEnd − 300–700 ms, clamped ≤50% of prev clip duration;
             next turn start = max(prevMainEnd + gap, overlapEnd − 250 ms);
             if backchannel speaker == next speaker: end backchannel ≥150 ms before their next clip (or drop).
             40/60 ms fades on overlays. Persist timeline_json.
7. MIX       ONE ffmpeg graph, inputs = the ~14–18 chunk WAVs (not 170 clip files):
             per chunk asplit → per-segment atrim(guard-banded)+asetpts+volume+adelay → amix
             inputs=N:normalize=0 → room-tone bed (pre-rendered 30 s brown-noise loop asset, ~−65 dBFS)
             → alimiter=0.97 (belt-and-braces only). All via runFfmpegLimited + -filter_complex_script.
8. LOUDNESS  two-pass loudnorm I=-16:TP=-1.5:LRA=11:linear=true (all measured_* + offset), -ar 44100.
9. ENCODE    MP4 aac mono 96k +faststart (primary, single channel) + MP3 libmp3lame 96k mono.
10. PUBLISH  Supabase `podcasts/{episodeId}/{renderId}/master.{mp4,mp3}` (write-once keys ⇒ immutable
             Cache-Control), presigned download; update podcast_renders.
```

**Per-turn preview** (editor ▶): 3-input dialogue call (prev + target + next), slice middle via voice_segments, cached; UI label "approximate — final render varies" (v3 <250-char single-turn calls are inconsistent by design).

Cost, honest math: 20-min ≈ 19–22k chars → 14–18 requests + context (+15%) + retries (+10–20%) ≈ **$2.30–2.80 TTS**; 8-min ≈ ~$1. LLM ≈ $2–4/episode (opus-4-8 max). Surface per-episode cost + plan-tier note (Creator 100k credits ≈ 4–5 twenty-min episodes/month) in telemetry.
Interim fallback mode (if Phase 3 slips): `silenceremove=stop_periods=-1:stop_duration=0.35:stop_threshold=-45dB` over stitched chunks — kills dead air, loses typed gaps/overlaps; ship only as a flag.

---

## 5. Frontend (client-web)

Conventions §9 binding (typed client, portals+ConfirmDialog, focus-ring, theme tokens, pendingKey polling, data-tour).

- **Home**: `HomeSidebar` "Podcasts" block (mirror playlists block); `HomeHero` CTA.
- **Show page**: episodes list (status chips); show settings modal (hosts/personas/voices/language/niche/style knobs/`user_instructions` extra-prompt slot/memory viewer+pruning).
- **Episode workspace**:
  - *Brief*: textarea (points/ideas/**analogy** — hint text: "יש לך אנלוגיה? כתוב אותה — היא תהיה עמוד השדרה של הפרק"), file upload (presigned; PDF/MD/TXT → extract), **URL field** (backend fetch over 443 + readability-extract), length 3–20, niche pack, generate (+notes on regenerate).
  - *Script*: stage progress (Architect → Materials → Playwright → Review → Rewrite → Compile; SSE or poll) → **per-turn editor**: ElevenLabs-style speaker-colored cards; editable text with **inline tag chips** (tags render as removable atoms inside the text flow; add from documented list or free tag flagged experimental); `dir="auto"` on turn text (Hebrew bidi: chips are LTR atoms outside the RTL run); overlap toggle; pause-after stepper; swap speaker; insert/delete/merge/split; per-turn 🔁 regen with hint; ▶ preview (Phase 3); version dropdown; Approve bar. Editing an approved version shows "forked to v(N+1)" feedback.
  - *Audio*: render progress (chunk counter) → player (mp4) + downloads + render history + changed-since-render banner → cheap re-export; "re-roll voices" (bumps episode seed, invalidates cache — confirm dialog).
- **Voice picker** (Phase 4): search + filters (gender/age/accent/language/category/use-case) via backend proxy of `GET /v1/shared-voices`, ▶ `preview_url`, select → backend `voices/add` (idempotent) → store voice_id.

admin-web: llm-config page + `LlmConfigSchema` gain `podcast_model`/`podcast_effort`; system-prompts page auto-lists `podcast_*` keys; feature flag `podcast_studio_enabled`.

---

## 6. STORY ENGINE (the brilliance layer — embedded in prompts A/C/D)

Research-grounded (Ira Glass, Blumberg/Gimlet, Radiolab/99PI, Loewenstein curiosity-gap, Gentner structure-mapping, PodBench/PodEval + prompt lines lifted from NVIDIA blueprint/neuralnoise/open-notebooklm):

1. **XY gate** — "about X; the interesting thing is Y (a surprise, not a theme)". Reject topic-shaped Y.
2. **Focus sentence** — "someone does something because... but..."; one concept; every beat serves it or dies.
3. **Cold open ≤90 words** — mid-scene or the most counterintuitive true sentence; value promise; open a loop; no greetings.
4. **Anecdote→reflection loop** — alternate ACTION and ≤3-line MEANING beats; never two reflections in a row.
5. **One story world** — a single analogy spine rides the whole episode (epsold-01: cinema → seats → addresses → pixels). **User's analogy = the spine, mandatory.**
6. **Curiosity ledger** — ≥2 loops open mid-episode; all closed by end; the cold-open promise pays off by name.
7. **Forward motion** — beats connect causally ("which meant... which brings us to"), never additively ("also...").
8. **Transition menu (mandatory per beat change), meta-navigation banned**: question bridge · open-loop handoff · consequence chain · recap-in-dialogue (learner replays; the correction IS the next topic) · objection pivot · zoom shift (ladder move) · stakes escalation · callback pivot · analogy-break transition. Banned: "Welcome back", "Now let's discuss", "Moving on", section announcements, turn-opening "Exactly,".
9. **Learner = audience surrogate** — asks the question the listener formed 5 seconds ago; moment-stems ("Wait, what happened when...?"); ≥2 genuine objections; never a nodding machine.
10. **Conflict-then-converge** — real disagreement / wrong guess resolved by evidence, not authority.
11. **Turn cap** — ≤3 sentences; 1-2-word reaction turns for rhythm; no monologues.
12. **Ladder rule** — never >2 consecutive turns at one abstraction level; every principle gets a bottom-rung instance.
13. **Declared simplification** — every lie-to-children flagged on air ("that's 90% true — the missing part matters when..."); learner never repeats a simplification as exact.
14. **Stakes checkpoint** — by 25% runtime, "why should I care" answered concretely.
15. **Ending = callback + elevation** — return to the opening image, one memorable takeaway sentence; never a recap list. `closing_return` is a required Architect output.
16. **Two-pass + judge** — scratchpad plan → draft → rewrite → PodBench-rubric judge quoting the weakest transition verbatim before TTS.

Few-shot anchor: excerpt of `epsold-01.txt` **re-labeled `TEACHER:`/`LEARNER:`** (in the original Titan teaches — feeding it raw would contaminate the required role reversal) + "in this show TEACHER={{teacher_name}}" adjacent.
Language-aware packs: Hebrew gets the v3-spec Hebrew-math-aloud rules (words-not-digits, gender agreement, nikud only for ambiguity); English gets CAPS/punct emphasis. **Phase-2 DoD includes one full Hebrew episode** (script quality is the stated priority).

---

## 7. Phases

| Phase | Scope | Key deliverables |
|---|---|---|
| **1. Foundation** | Migration 044 + CRUD + home section | tables; `podcastAccess.ts`; shows/episodes/sources controllers (+URL extract); RESERVED_SLUGS fix; **voice verify+add seed for Titan/Brittney**; client-v1 methods; HomeSidebar block; show page; episode shell + Brief tab |
| **2. Writers' room + editor** *(owner: do first)* | LLM upgrade + pipeline + script UI | ClaudeProvider/LLMService/LLMProvider fixes (incl. pricing, refusal branch, creative-tier no-escalation); 11 seeded prompts (STORY ENGINE embedded); ScriptRoom job (CAS/claimed_at/recovery) + progress; per-turn editor (inline tag chips, bidi, fork-on-edit, versions, approve, director-notes regen); memory scribe + injection; **Hebrew episode in DoD** |
| **3. Audio export** | The stitcher | ElevenLabs dialogue client (+validation/retries); per-beat chunking + payload-hash cache + episode seed; backchannel library; recut w/ guard bands; trim + intra-turn compression; leveling; timeline (collision rules); single-graph mix; loudnorm; MP4/MP3; player+downloads; re-export; 3-input preview |
| **4. Voices + polish** | Library + admin + hardening | voice search/preview/add picker; admin model/effort + feature flag; cost telemetry UI; tour steps; QA Hebrew + English episodes end-to-end |

DoD per phase: `pnpm --filter shared build` + typecheck green; `db:migrate`+`db:check` (backfill check-db list 034→044); endpoints exercised end-to-end; a real generated episode reviewed.

---

## 8. Risks & mitigations (from adversarial review)

- **v3 line drop/merge/duplication** → per-chunk segment validation + seed+1 retry budget (10–20%).
- **Chunk-seam emotional discontinuity** → context turns (+15% chars) + per-clip leveling.
- **Native crosstalk breaking recut** → compiler bans it; stitcher owns ALL overlaps; atomic-clip fallback.
- **Preview ≠ render** → contextual 3-input preview + explicit "approximate" label.
- **Inline jobs die on deploy** → CAS + claimed_at + 45–60 min stale window + startup recovery (durable worker remains the roadmap item).
- **Fable-5 ZDR 400s** → graceful admin error; opus-4-8 default.
- **Seed ≠ consistency guarantee** — seed is cache determinism only; never promise byte-identical re-renders.

## 9. Conventions checklist (binding)

1. Migration `044_podcast_studio.sql` + append to `migrate.ts` array + `check-db.ts` (backfill 034–043); `db:migrate`+`db:check` before restart.
2. Routes: `registerPodcastRoutes(app)` in `server.ts`; zod bodies; `firebaseAuthMiddleware`; access via `podcastAccess.ts` only.
3. Jobs: types.ts + registry.ts + `enqueueJob`; idempotent CAS (claimed_at) + stale window + startup recovery; polled status; SSE only via `lib/sse.ts` (`?token=`).
4. LLM only via `LLMService.sendStructured`; prompts in `system_prompts` (key,name,content) + hardcoded fallback.
5. ffmpeg via `runFfmpegLimited()`; `mkdtemp`/`rm` finally; storage via `getStorageAdapter()`, prefix `podcasts/`, write-once keys immutable Cache-Control, presigned downloads.
6. Client: hand-mirror every endpoint in `client-v1.ts`/`admin-v1.ts` + rebuild shared; UI per design system (tokens/portals/ConfirmDialog/focus-ring/polling/data-tour; rose accent).
7. ESM `.js` suffixes; pino; `AppError`; never read `.env`; fiji read-only.
