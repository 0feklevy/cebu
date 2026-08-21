# Interactive Podcast — Research, Idea Catalogue, Architecture, Work Plan

> Share a FlowVid project as a podcast people can talk to. This is the complete design package: category research with verified prices, a sixteen-idea product catalogue with per-idea token discipline, the technical architecture verified against the current codebase, and a phased work plan whose first phase ships alone.

**Date:** 2026-08-20
**Branch:** `feat/library-share-minisite` (checked out, zero commits over `main` — this design is that branch's content)
**Paths:** repo-relative to `podcast-saas/` (the monorepo root inside `/Users/ofeklevy/cebu`)
**Companion docs:** `md-files/LIBRARY-SHARE-MINISITE-PLAN.md`, `md-files/podcast-pipeline-architecture.md`, `md-files/podcast-studio-plan.md`

---

## 1. Vision

FlowVid already generates complete two-host podcasts end to end: per-episode brief and sources, a multi-agent writers' room (`backend-api/src/services/podcast/ScriptRoom.ts`), ElevenLabs `eleven_v3` text-to-dialogue with per-line timestamps, a content-addressed chunk cache so edits re-bill only changed beats, ffmpeg mastering to MP4/MP3/WAV, and a Web Audio timeline studio whose preview is guaranteed to match the server export via the shared `layoutMix`. What it cannot do today: bridge a video project into an episode (the schema is explicitly commented "NOT related to video projects"), share an episode with anyone (every podcast route is Firebase-auth + ownership; masters live behind 6-hour presigned URLs), or let a listener do anything but listen.

**The feature in one sentence: pick a project → "Share as podcast" → the writers' room drafts an episode grounded in the project's actual content → render → a public URL anyone can play — and interrupt.** Hold the talk button; the hosts stop, take the question, answer in character grounded in the episode transcript and the project's sources, and pick the show back up exactly where it paused.

Why this is not another linear AI podcast, and why FlowVid specifically wins:

- **Linear AI podcasts are commoditizing.** Inception Point AI plans 3,000 generated episodes per week (Hollywood Reporter). Wondercraft, Jellypod, ElevenLabs GenFM, and Google Illuminate all turn documents into linear audio. Generation is a race to the floor; interactivity is the defensible axis, and the field's only real precedents are NotebookLM's Interactive Mode and a Hume tech demo.
- **NotebookLM validated the interaction and fenced it in.** Join → hosts pause → grounded answer → resume is proven UX — but it is BETA, Deep-Dive-format-only, voice-only, English-only, has no API (AutoContent API exists as a third-party wrapper because of that gap), and deliberately discards every interjection: the conversation leaves no trace on the artifact, and the downloadable audio is a dead file. Each of those is a gap this design occupies: a shareable public URL, typed and voice input, opt-in persistence that compounds into a per-show question graph, and a real project corpus behind every episode.
- **The simulation moat is audio-translatable.** FlowVid projects carry interactive simulations no other podcast product has. A publish-time sweep can sonify a sim into an instrument the listener steers by voice mid-episode (Sonic Sims), or the sim can open on the listener's phone while the episode audio becomes a live guide track reacting to what they do (Second Screen) — both built on guidance/capture infrastructure that already ships.
- **The economics only recently started working — if the architecture enforces discipline.** Connect-on-interject on `gpt-realtime-2.1-mini` puts a fully interactive listener-hour at ~$0.06–0.07. The naive design — an always-open flagship realtime session — runs $3–5/hour. Listening itself costs $0.00 by construction here, because no session exists while the episode plays; cost discipline is structural, not behavioral.
- **The pipeline reuse ratio is extreme.** Script generation, TTS rendering, chunk caching, mastering, per-turn clips with waveform peaks, guidance TTS with text-hash reuse, SSE streaming, the Anam ephemeral-token mint pattern, the avatar audio visualizer — all exist in production today. The genuinely new surface is: a project→episode source bridge, an episode share token + public endpoints, a public player page, and a realtime session broker with a minutes ledger.

One product rule governs everything, imported from the BBC's Inspection Chamber post-release survey (listeners split into two irreconcilable camps — one wanted more interaction, one refused to interact at all once a story was in motion): **the episode must be complete and excellent when never interrupted; interaction is a door left open, not a toll gate.** Every idea in the catalogue respects it. Playback is never gated, metered, or interrupted by cost controls, and the static RSS export exists precisely so the never-interrupt camp gets a pristine linear show.

---

## 2. What the research found

### 2.1 The closest product: NotebookLM Interactive Mode

- Mechanics: during Audio Overview playback you press **Join**; the two AI hosts stop and "call on you"; you ask by voice; they answer **from your uploaded sources only**; the scripted overview resumes (Google support docs, futurepedia course notes, Muttadrij/Medium).
- Measured weaknesses (xda-developers, Tom's Guide): noticeable response latency after joining; hosts miss or misinterpret unusually phrased questions; **voice-input-only** (users beg for typed questions); English-only; works only on newly generated overviews; answers hard-bounded by the notebook's sources.
- Deliberate non-features, equally instructive: interjections are **not saved** ("your voice and transcribed interactions won't be stored" — privacy framing), so Q&A never alters the artifact and never persists for relisten; the downloadable audio is a static file — interactivity exists only inside Google's app; **no public API** (AutoContent API is a third-party wrapper, from EUR 29/mo credits).
- Formats: Deep Dive (two-host banter — the only interactive one), Brief (single narrator, <2 min), Critique, Debate; Shorter/Default/Longer length control (English-only); 80+ languages (9to5google, nerdschalk).
- Pricing: free tier 3 Audio Overviews/day; paid $4.99 (Plus) / $19.99 (Pro) / $99.99 (Ultra, 100/day) per month (felloai.com, elephas.app).

### 2.2 The rest of the field (all linear or consumption-side)

- **Wondercraft** — from $49/mo; broad audio studio (podcasts, ads, audiobooks).
- **Jellypod** — Starter $25/mo; podcast-first; persistent named AI hosts with backstories; direct Spotify/Apple/YouTube publishing (jellypod.ai).
- **ElevenLabs GenFM/Studio** — PDFs/URLs/YouTube → two-co-host discussions in 32 languages with editable transcripts.
- **Google Illuminate** — research-paper audio discussions; still a Labs experiment.
- **Snipd** — $9.99/mo ($5.99 annual), 900 AI-processing-minutes/mo cap; auto transcripts, AI chapters, triple-tap headphone highlights, chat-with-the-episode grounded in the transcript with timestamped quotes (snipd.com/pricing). Proof that listeners will interact with podcasts **when the player, not the feed, carries the intelligence**.
- **Hume "Chatter"** — "first interactive voice AI podcast" demo on their Empathic Voice Interface: interrupt the host, switch topics, live web search. A tech demo, not a product — the category is open (hume.ai/blog).
- **Inception Point AI** — plans 3,000 AI episodes/week (Hollywood Reporter). Linear AI audio is commoditizing fast.

### 2.3 Interaction traditions worth stealing

- **Audible Choose Your Own Adventure on Alexa (2019)** — professional voice actors, saved your place, allowed doubling back to explore branches; Amazon shipped **Skill Flow Builder**, a no-code branching-audio authoring tool (audible.com newsroom, voicebot.ai).
- **BBC The Inspection Chamber** — the richest lesson. It deliberately did NOT fully branch: it **"bubbled out"** — diverting on your answer, then returning to one canonical spine — to contain production cost. BBC built a graphical story editor plus a story server tracking listener position. Producer Henry Cooke's post-release survey found two irreconcilable listener camps (game-like more-interaction vs never-interrupt), yielding the governing product rule above (ibc.org).
- **Game audio** — the vocabulary: **horizontal re-sequencing** (reshuffling pre-composed segments by player choice) and **vertical re-orchestration** (layer mixing), with Wwise/FMOD as authoring-middleware precedent. An interactive podcast is horizontal re-sequencing of pre-rendered segments plus live-generated interludes.
- **Balance (meditation app)** — assembles each session from thousands of pre-recorded clips selected by a daily mood/goal check-in. Commercial proof that branching "configured playback" works **with zero live TTS** (balanceapp.com, driftinward.com).
- **Pimsleur challenge-and-response** — the "principle of anticipation": the listener SPEAKS the answer aloud on cue into a timed pause and hears confirmation immediately after, with graduated-interval recall spacing the repetitions. Research-validated audio interaction that works open-loop — **no ASR needed** — ideal while driving (pimsleur.com, artofmemory.com).
- **Volley Question of the Day** (2020 Gaming Voice Experience of the Year) — the pure-audio quiz engagement loop: one daily question; a bonus question unlocked by a correct answer; points inversely scaled to the share who answer correctly (5 pts at 50%, 8 pts at 20%); leaderboards; a paid trivia club (volleygames.com).

### 2.4 Learning science

- **Retrieval practice improves retention on the order of 50% versus restudy** and benefits transfer of complex concepts over multi-day delays (PMC3983480; ScienceDirect S0959475225001434).
- A medical-trainee study found **podcast learning beat textbook reading** on learning gain with equivalent retention (PMC9733582).
- **Passive listening is the worst modality** for mind-wandering and memory versus reading (PMC3842750). An unmodified linear podcast is the low-retention baseline; inserting retrieval prompts is the single highest-leverage intervention this product can make.

### 2.5 Context and safety: where people actually listen

- Edison Research corrects the folklore: **67% of podcast listening happens AT HOME** (chores, cooking), not in the car; Super Listeners average **11.2 hrs/week**. Eyes-busy/hands-busy is the shared context; driving is the hardest subset.
- A 2026 study of an LLM-powered in-vehicle conversational agent (arXiv 2601.15034) measured cognitive and visual demand **comparable to hands-free calls**, stable across multi-turn conversations, with glances well under the 2-second safety threshold. But cognitive secondary tasks raise crash risk **2–6x** and poorly executed voice UIs elevate workload — so interjections must be **short, system-paced, voice-only with zero screen dependency, and skippable** (the Hands-Busy Mode spec, verbatim).

### 2.6 Distribution mechanics

- **RSS is a static file format with no interactivity primitive.** Podcasting 2.0 namespace adds chapters (500K+ episodes), transcripts, person tags, and cross-app comments — nothing conversational (podcasting2.org).
- **Spotify Q&A/Polls**: 9M+ unique users engaged, +80% YoY interaction growth — but it lives on the episode page, not inside the audio (newsroom.spotify.com).
- Conclusion — the **dual-artifact architecture**: the canonical interactive episode lives in FlowVid's web player (like NotebookLM, interactivity dies on export), while a linear render exports to RSS for reach, with Podcasting 2.0 chapter markers deep-linking listeners from the static file into the interactive version at fork points. The feed is the trailer; the mini-site is the show (idea 9, The Static Decoy).

### 2.7 Realtime voice economics (August 2026)

#### OpenAI Realtime API — current state

`gpt-realtime-2.1` and `gpt-realtime-2.1-mini` (released July 6, 2026 per MarkTechPost): speech-to-speech models supporting **WebRTC, WebSocket, and SIP** transports, function calling, image input, MCP, and configurable reasoning effort (minimal→xhigh, default low for latency).

Pricing per 1M tokens (OpenAI model pages, relayed by layer3labs.io and MarkTechPost — the model pages themselves render behind JS):

| Model | Audio in | Audio cached in | Audio out | Text in | Text cached in | Text out |
|---|---|---|---|---|---|---|
| gpt-realtime-2.1 | $32 | $0.40 | $64 | $4 | $0.40 | $24 |
| gpt-realtime-2.1-mini | $10 | $0.30 | $20 | $0.60 | $0.06 | $2.40 |

Audio tokenization (developers.openai.com realtime-costs guide): **1 token per 100ms of user audio (600 tokens/min); 1 token per 50ms of assistant audio (1,200 tokens/min)**. Per-minute equivalents: 2.1 ≈ $0.019/min listening and $0.077/min speaking; mini ≈ $0.006/min in and $0.024/min out.

#### The cost mechanics that decide the architecture

- **Conversation re-send compounds cost.** The entire conversation is re-sent as input on every turn (OpenAI's own cost guide). latent.space's "Missing Manual" measured **$0.11 at 1 min growing to $5.28 at 15 min** on the prior-gen model; Layer3Labs reports real bills run **2–5x base estimates** without caching; Deepgram/Gradium put speech-to-speech at roughly **10x** the cost of a chained pipeline. Session length is the enemy; short sessions are the design.
- **Silence is free under server VAD.** 60 seconds of silence billed **zero** input tokens — only VAD-committed speech becomes billable conversation input (community.openai.com threads: realtime-api-cost-anomaly, realtime-api-pricing-vad-and-token-accumulation). But OpenAI's VAD is noise-sensitive (latent.space) — an open mic near a playing podcast risks false triggers and junk billed turns, which is why this design gates the mic client-side rather than trusting VAD.
- **Prompt caching**: automatic; requires an **exact byte-stable prefix ≥1024 tokens**, hits in 128-token increments (OpenAI Prompt Caching 201 cookbook); covers instructions + session preamble; **cached audio is ~99% off** ($0.40 vs $32). Realtime context is currently **32k tokens, ~28,224 usable** before truncation; `retention_ratio` and manual item deletion / summary replacement exist for context control.
- **Sessions**: GA max **60 minutes** (up from 30 — community/Azure docs). Ephemeral `client_secret` tokens expire in **~1 minute** but only gate connection start.
- **Turn detection**: `server_vad` (threshold, prefix_padding_ms, silence_duration_ms; default trailing silence ~500ms) or `semantic_vad` with eagerness low/medium/high/auto that waits longer after hesitations. Default is server_vad.
- **Out-of-band responses**: `response.create` with `conversation:"none"` plus a custom input array answers without appending to the billable conversation (developers.openai.com realtime-conversations) — used here for the Your Outro recap.
- **On interruption you must send `conversation.item.truncate`** so server context matches the audio the user actually heard — otherwise unheard audio is re-billed in every subsequent turn (latent.space / Pipecat pattern).

#### The chained alternative and the open-source floor

- Chained STT→LLM→TTS: **gpt-4o-transcribe ~$0.006/min**, **gpt-4o-mini-transcribe ~$0.003/min**, **gpt-4o-mini-tts ~$0.015/min of speech** ($0.60/1M text in, $12/1M audio out) (gate.ai, tokenmix.ai, costgoat.com). Well-tuned cascades reach ~1s voice-to-voice (Modal + Pipecat) vs measured realtime TTFT of 0.82s; the tradeoff is latency and losing prosody-aware listening.
- **Gemini Live API** (gemini-2.5-flash-native-audio-preview-12-2025): $3/1M audio in, $12/1M audio out, billed at 25 tokens/sec of audio → ≈$0.0045/min in, $0.018/min out (ai.google.dev pricing) — cheaper than OpenAI's flagship, near mini. Automatic VAD (`realtimeInputConfig.automaticActivityDetection`). Disqualifiers for this UX: **audio-only sessions cap at 15 minutes** (Vertex docs) and independent April-2026 TTFT measurements put it at **2.98s vs OpenAI 0.82s** (gradium.ai; xAI measured 0.78s).
- **Gemini TTS** for episode generation: gemini-2.5-flash-preview-tts $10/1M audio out (≈$0.015/min, $0.0075 batch); gemini-3.1-flash-tts-preview $20/1M (ai.google.dev, fetched Aug 2026).
- **ElevenLabs Agents**: $0.08–0.10/min ($0.08 Business annual), **explicitly excluding LLM costs** which ElevenLabs "currently absorbs" (elevenlabs.io pricing blog, cekura.ai). ElevenLabs TTS: $0.10/1k chars (Multilingual v2/v3, ≈$0.09/min of speech at ~900 chars/min) or $0.05/1k (Flash/Turbo).
- **Open-source floor**: Kokoro-82M TTS at $0.65–0.80/1M chars hosted (**<$0.06 per HOUR of audio**), self-hostable on 2–3GB VRAM (huggingface.co/hexgrad/Kokoro-82M, tryspeakeasy.io); Whisper/whisper-streaming for STT; **Silero VAD v5 free in-browser** via ONNX Runtime Web WASM + AudioWorklet (@ricky0123/vad-web, web-vad); Pipecat **Smart Turn v2/v3** open semantic end-of-turn model (360MB, 12ms inference on an L40S) (daily.co blog).

#### Platform economics (build vs buy the orchestration)

- Vapi: $0.05/min headline → **$0.23–0.33/min all-in** real. Retell: $0.07 → $0.13–0.31/min. Pipecat Cloud / LiveKit Cloud agents: **~$0.01/min orchestration** with model costs passed through. Self-hosting on LiveKit/Pipecat saves 60–80% above ~50k min/month (cekura.ai, softcery.com calculator). Typical cascaded production agents run $0.05–0.30/min all-in.
- FlowVid's take: self-orchestrate. The interjection broker is a token mint + ledger (the Anam pattern already in the repo); WebRTC media flows browser↔OpenAI directly, so there is no per-minute middleman to pay and nothing for the 2-vCPU VM to relay.

#### Latency and UX numbers that gate the design

- Perceived-natural conversation: **<~800ms voice-to-voice** (gold standard ~500ms; human-like Moshi hits 200–300ms) (prodinit.com, sparkco.ai).
- **Barge-in must stop agent audio within ~200ms** and simultaneously cancel LLM generation, tear down TTS, and flush buffered audio (softcery.com/lab).
- A misconfigured trailing-silence VAD window (500–800ms defaults) silently adds half a second to every exchange.
- Connect-on-demand: cold WebRTC connect + first token **~1.4s**, dropping to **~600ms** with a pre-warmed peer connection and a token endpoint near the user (webrtcHacks/forasoft/HiTek guides). Mask the gap with a pre-generated earcon ("Mm-hm?" — cached TTS, ≈$0).
- **Browser AEC gotcha**: `getUserMedia` echoCancellation:true only cancels audio the browser itself routes (audio elements / WebRTC tracks). PCM chunks hand-decoded from a WebSocket are **invisible to AEC** — the agent hears itself and the podcast (dev.to/remi_etien). This design sidesteps it twice: playback pauses during interjection, and transport is WebRTC — which latent.space recommends over WebSocket for browsers anyway (Opus FEC, timestamps for truncation math, congestion control, built-in AEC).
- Pre-generation economics: 40–60% TTS savings from pre-generating known audio, and cached-phrase first-word latency drops 380ms→40ms (Quantum Automations / LiveKit docs) — the argument for pre-rendering every predictable line (bubbles, feedback branches, coaching lines, earcons).

#### The money-leak checklist (Layer3Labs / Cekura)

1. Unstable prompt prefixes breaking the cache (volatile data must go at the END of instructions).
2. Verbose tool outputs re-billed every turn.
3. Dead-air sessions left open — cap session length, idle-disconnect.
4. VAD false triggers from ambient noise (an open mic near a playing episode is the worst case — solved by gating the mic, not tuning thresholds).
5. Platform per-minute fees dwarfing raw model cost at scale.

#### Script-generation pricing (verified via claude-api skill, cached 2026-06-24)

Claude Haiku 4.5 $1/$5 per MTok in/out; Sonnet 4.6 $3/$15; Sonnet 5 $3/$15 ($2/$10 intro through 2026-08-31); Opus 5 $5/$25. A 15-min two-host episode is ~2,200 words (~13–15K chars, ~3–4K output tokens) plus 20–50K source-input tokens → **~$0.02–0.07/episode on Haiku, ~$0.10–0.25 on Sonnet**. Script cost is negligible; TTS dominates.

### 2.8 Ground truth: what the repo has and lacks

What exists (all verified against source):

- **Podcast Studio** (migration 044/045, standalone, auth-only): `podcast_shows` → `podcast_episodes` → `podcast_sources` / `podcast_scripts` / `podcast_renders` / `podcast_clips` / `podcast_mixes` / `podcast_mix_snapshots` / `podcast_chunk_audio` (`backend-api/src/db/schema.ts` ~1105–1267). Writers'-room script jobs (`runPodcastScript.ts`/`ScriptRoom.ts`), chunk-cached eleven_v3 renderer (`PodcastRenderer.ts` → `ElevenLabsDialogue.ts`, ≤2000 chars / ≤10 voices per request), full ffmpeg mastering (`ffmpegAudio.ts`: guard-banded extractClip, timeline mix over room tone, two-pass loudnorm, 200-bucket peaks), per-turn immutable clips, one mutable mix draft per episode, WYSIWYG via the shared `layoutMix`.
- **LLM layer**: provider union `'claude' | 'openai' | 'gemini'` with streaming, fractional-cent accounting into `token_usage` (schema.ts:308), tier routing, per-user rolling caps, `generation_paused` kill switch (`services/llm/LLMService.ts`). The OpenAI SDK (^4.86.0) is wired — **chat completions only**; no OpenAI audio/realtime calls exist anywhere.
- **TTS**: ElevenLabs by raw fetch in three places — `services/audio/GuidanceTTSService.ts` (guidance narration, text-hash reuse explicitly to avoid re-billing), `services/podcast/audio/ElevenLabsDialogue.ts` (dialogue with timestamps), `controllers/v1/audio.controller.ts` (sound-generation SFX/music). **STT**: Groq whisper-large-v3 (`services/ingestion/AudioIngester.ts`, `services/captions/CaptionService.ts` with whisper.cpp fallback; 24MB upload cap ≈ 50 min audio).
- **Realtime transport**: SSE only, production-proven (`lib/sse.ts`; sections/simulations controllers stream today). **No WebSocket server dependency exists.** The only live voice is the Anam avatar: `services/avatar/anamService.ts` mints single-use session tokens server-side with fully server-controlled personaConfig; the browser's WebRTC media flows directly to Anam's cloud, never touching the VM — the exact pattern the realtime feature copies. Nginx already forwards Upgrade headers globally; 300s proxy timeouts; single 2-vCPU VM with no TURN/SFU; all server audio work funnels through the global ffmpeg cap (`services/ffmpegLimit.ts`).
- **Sharing machinery** on projects (schema.ts:174) and playlists (:713) only: `share_token` + `share_enabled_at`, visibility, permalink slugs; public routes `app/v/[shareToken]`, `app/pl/[shareToken]`, `app/[slug]`; `share.controller.ts` optional-auth + paywall stub; `permalinkService.ts` RESERVED_SLUGS already parks `podcasts`, `podcast`, `feed`, `rss` (lines 27, 35).

What does not exist (each is a workstream in this plan):

- No project→podcast bridge (no FK, no conversion path; new surface by design).
- No episode share token, no public podcast endpoint, no public player page (`client-web/middleware.ts` matcher covers only `/c`, `/v`, `/pl`; all podcast protection is API-side).
- No RSS feed generation anywhere.
- Masters expire: 6-hour presigned URLs (`DL_TTL`, `podcast-render.controller.ts:24`). Studio clips already use the stable public-bucket hashed-key model (`storage.getPublicUrl`, `podcast-studio.controller.ts:72`).
- TTS/STT spend is completely unmetered (`token_usage` records LLM chat only, token-denominated, no duration column); billing is one-time Stripe Checkout (`BillingService.ts`) — no subscriptions, no metered usage-records.

Constraints imported into every design decision below:

1. `services/podcastAccess.ts` is the ONE ownership seam — sharing extends it (mirroring `collabAccess.ts`); controllers never inline `created_by` checks.
2. Shows are personal to `created_by` in v1; `org_id` exists but is not consulted.
3. The podcast↔project decoupling is deliberate; the bridge must not add an episode→project FK.
4. Any public player/RSS enclosure needs a stable-URL strategy; presigned links cannot back it.
5. `podcast_clips` are immutable, content-addressed, never deleted — the existing unauthenticated-bearer threat model for public audio.
6. One mutable mix draft per episode (unique `episode_id`); exports freeze via snapshots; client/server lockstep only via shared `layoutMix`.
7. New public pages need new unauthenticated endpoints, not just client routes.
8. Renders are CAS-claimed with a 30-minute stale window (`runPodcastRender.ts`) — long additions must respect `STALE_MS`.
9. Episode/script statuses are plain text columns; new states must update every client-side status set (e.g. `PodcastStudioTab.tsx`).
10. eleven_v3 dialogue is batch-only here (no ElevenLabs streaming/WS TTS in use); caps: 2000 chars, 10 voices per request.

---

## 3. The core experience

### 3.1 The loop, as a user story

Maya opens `flowvid.app/podcast/8fk2…` from a link in a course Discord. No login, no app. A player page: cover, chapter rail, a follow-along transcript, and a pulsing avatar-circle visualizer. She presses play. Two hosts — the show's configured teacher and learner personas — walk through the project the episode was generated from. **For FlowVid this moment costs $0.00: a plain `<audio>` element playing a CDN-cached public mp3. No AI is running. No session exists. No mic is open.**

Twelve minutes in, a claim confuses her. She holds the Talk button (Space on desktop, long-press on mobile). Three things happen inside ~300ms: playback pauses (killing the echo problem before it exists), a pre-cached earcon plays — one of the hosts going "Mm-hm?" — and, invisibly, the client has already begun pre-warming a WebRTC connection using an ephemeral token minted by the backend. She asks her question out loud and releases.

About a second later the host's voice answers — in persona, grounded in the episode transcript and the project's sources, referencing "what we said a minute ago" because the prompt knows she paused at 12:34 in chapter 3. The avatar circles animate with the answer. She interrupts halfway ("wait, so it's NOT the same as—") and the voice stops within a fifth of a second and takes the follow-up; behind the scenes the client sent `conversation.item.truncate` so the model's context matches only the audio she actually heard, and unheard audio is never re-billed. Satisfied, she says "got it, thanks" — the session closes, the ledger records ~$0.03, and playback resumes exactly where it paused, stitched with a pre-rendered "anyway — where were we" transition.

She never interjects again for the rest of the episode. Total cost of her 25-minute listen: about three cents. A listener who never presses the button costs exactly zero and hears a complete, uninterrupted show.

Visitors without a mic (or without the inclination) get the same power in text: an Ask panel streams grounded answers over SSE, each citing timestamps rendered as seek links. Typed is the default tier for every visitor; voice is the premium the owner enables.

### 3.2 The technical beats behind the story

1. **Play** — public content-hashed mp3, `cache-control: immutable`, plain `<audio>`. Zero AI, zero session, zero mic.
2. **Barge-in** — push-to-talk only in v1. No wake word, no open mic, no VAD listening to a room with a podcast playing. This deletes the VAD-false-trigger money leak outright rather than mitigating it.
3. **Pause + connect** — pause first (AEC gotcha sidestepped: podcast audio and mic never coexist), earcon masks the connect gap, backend mints an ephemeral OpenAI `client_secret` after budget checks (the Anam mint pattern). Cold connect ~0.6–1.4s; pre-warm begins at button-press.
4. **Session** — `gpt-realtime-2.1-mini`, WebRTC, `semantic_vad`; config 100% server-controlled; instructions = byte-stable prefix (personas + grounding rules + full episode transcript, ~6k tokens for 30 min) with the volatile position line appended at the END so caching survives.
5. **Answer** — streamed, animating the existing `AvatarCirclesOverlay` visualizer; `conversation.item.truncate` on interruption.
6. **Close + resume** — teardown on answer-end + 15s idle; usage reconciled to the minutes ledger; playback resumes at the paused position.

Latency budget: mint 200–400ms + connect 0.6–1.4s cold, overlapped with the question itself and masked by the earcon → first host audio **~0.8–1.5s** after the question ends (measured realtime TTFT 0.82s) — inside the <800ms-to-~1.5s perceived-natural window for a "called on you" turn exchange.

### 3.3 Hands-busy mode (driving, cooking)

The screen-never protocol (full spec: idea 2): the hosts run the show and open short **invited listening windows** at chapter ends — earcon, "tangent on X, quick question, or roll on?" — three seconds of mic, then onward. **Silence always means continue.** On-device Silero VAD (WASM, free) arms the mic only inside windows; a tiny on-device command grammar (continue / again / deeper / question / numbered choices) routes without any LLM; "question" opens a capped voice-only Raise Your Hand exchange that always ends with "back to it." Short, system-paced, voice-only, skippable — the exact profile the in-vehicle safety study (arXiv 2601.15034) found comparable to hands-free calls. A silent listener costs $0.00 for the entire episode by construction.

---

## 4. Idea catalogue

Sixteen ideas in five groups. Effort: M < L < XL (dev-scale, not calendar). Wow: 1–5. Every idea obeys the governing rule (linear spine complete on its own) and carries its token discipline as a first-class field.

| # | Idea | Group | Effort | Wow | Marginal cost at listen time |
|---|---|---|---|---|---|
| 1 | Raise Your Hand | Core loop | XL | 5 | $0 listening; ~$0.014–0.017/interjection |
| 2 | Hands-Busy Mode | Core loop | M | 4 | $0 silent; ~$0.0005 per spoken window |
| 3 | Call It | Core loop | M | 4 | $0 (open-loop) to ~$0.0005 (scored) |
| 4 | The Echo | Core loop | L | 4 | ~$0.002 per echo per listener |
| 5 | Your Outro | Core loop | M | 4 | ~$0.002–0.016 once per completing interactor |
| 6 | Pull the Thread | Non-linear structure | L | 4 | $0 (pre-rendered bubbles) |
| 7 | The Episode Map | Non-linear structure | L | 4 | $0 (rare $0.0002 fuzzy-match fallback) |
| 8 | Lenses | Non-linear structure | L | 3 | $0 (lazy one-time render per variant) |
| 9 | The Static Decoy | Non-linear structure | M | 3 | $0 (pure artifact transform) |
| 10 | Second Screen | Simulation bridge | L | 5 | $0 (optional $0.002 escape hatch) |
| 11 | Sonic Sims (audacious swing #1) | Simulation bridge | XL | 5 | $0 (publish-time sound bank) |
| 12 | Clip It | Social & analytics | M | 3 | ~$0.0002 per clip title, memoized |
| 13 | The Question Wall | Social & analytics | L | 5 | $0 (nightly batch cents) |
| 14 | Season Brain | Social & analytics | M | 3 | ~$0.001–0.01 per show per week |
| 15 | Call the Show (audacious swing #2) | Audacious | XL | 5 | ~$0.05–0.10 per 3-min call |
| 16 | The Listening Party (audacious swing #3) | Audacious | XL | 5 | ~$0.004 per student per class session |

### Group A — Core loop

#### 1. Raise Your Hand — XL · Wow 5

- **What it is.** The core barge-in loop on a public shared episode page: while the episode plays, hold Space (long-press on mobile) to talk. Playback pauses instantly, the hosts "call on you," answer in-character grounded in the episode transcript plus the project's sources, then the player resumes the master exactly where it paused with a pre-rendered "anyway — where were we" transition. Unlike NotebookLM, the exchange can persist (opt-in) and typed questions are accepted too.
- **Why it matters.** Linear AI podcasts are commoditizing (Inception Point: 3,000 eps/week); NotebookLM validated join-the-hosts but locked it inside their app — no API, no persistence, voice-only, source-bounded. FlowVid ships the same magic on a shareable public URL tied to a real project corpus. This is the category-defining move everything else in the catalogue builds on.
- **How it works.** Foundation: `share_token` on episodes through `podcastAccess.ts` (the designated ownership seam, mirroring the projects-table machinery), new unauthenticated GET endpoints modeled on `share.controller.ts`, a public player page riding the Library-share mini-site; masters move to stable hashed public-bucket URLs (the model `podcast_clips` already uses) because 6h presigned links cannot back a public player. Interjection path: backend mints an ephemeral OpenAI Realtime `client_secret` exactly the way `anamService.ts` mints Anam session tokens; browser connects over WebRTC (built-in AEC, and playback is paused anyway); session config is `gpt-realtime-2.1-mini` + semantic_vad, instructions = show personas + full episode transcript as a byte-stable prefix with the playback timestamp appended at the END. The answer animates the existing avatar-circle visualizer. A per-session minutes row mirrors `token_usage`.
- **Token discipline.** Zero cost while listening: no session exists during playback and the mic only opens on hold-to-talk — silence costs nothing **by construction**, not by trusting server VAD. Sessions open per interjection and hard-close after the answer plus a 10s grace (3-min cap, idle disconnect). The ~6k-token transcript prefix is byte-stable so prompt caching kicks in: ~$0.017 first exchange, ~$0.014 follow-ups on mini; the timestamp lives at the end of the prompt so the cache never breaks. `conversation.item.truncate` fires on user barge-in so unheard audio is never re-billed. Four interjections per listener-hour ≈ $0.06 vs $3–5/hr for an always-open flagship session — which this design structurally forbids.
- **Inspiration.** NotebookLM Interactive Mode (join → pause → grounded answer → resume); `anamService.ts` ephemeral session-token pattern already in the repo; latent.space "Missing Manual" caching + truncate discipline.

#### 2. Hands-Busy Mode — M · Wow 4

- **What it is.** A screen-never protocol for driving and cooking: the hosts run the show and open short "listening windows" at chapter ends — earcon, "tangent on X, quick question, or roll on?" — three seconds of mic, then onward. Silence always means continue. No wake word, no button, no glance; saying "question" opens a capped voice-only exchange that always ends with "back to it."
- **Why it matters.** 67% of listening happens hands-busy at home and the hardest subset is driving, where in-vehicle LLM agents measure like hands-free calls precisely when interactions are short, system-paced, and skippable — which is this protocol verbatim. It also serves the BBC's never-interrupt camp: stay silent and you get a pristine linear show.
- **How it works.** The invited-window schedule ships in `timeline_json` at chapter boundaries. Client: Silero VAD (WASM, on-device, free) arms the mic ONLY inside windows; captured speech first hits a tiny on-device command grammar (continue / again / deeper / question / numbered choices) with a Whisper one-shot for anything else. Always-listening wake words were deliberately rejected — invited windows eliminate the false-trigger cost the research flags as the top money leak. "Question" triggers the Raise Your Hand flow in a voice-only variant with a 45s answer cap; the session pre-warms during the earcon so the first token lands inside the natural pause.
- **Token discipline.** The mic is physically gated to invited 3-second windows — nothing streams during playback, so a silent listener costs $0.00 for the whole episode by construction, with zero exposure to VAD false triggers near a playing speaker. Command routing is on-device; Whisper one-shots (~$0.0005) fire only when a window actually captures speech. Realtime opens only on the explicit "question" branch, capped at 45 seconds of answer, auto-closed on resume.
- **Inspiration.** Pimsleur system-paced audio interaction; arXiv 2601.15034 in-vehicle agent safety measurements; Silero VAD in-browser via @ricky0123/vad-web.

#### 3. Call It — M · Wow 4

- **What it is.** Before every reveal the hosts make you commit: "Doubling the coil turns — what happens to the field? Say it out loud… locked in?" A four-second beat, then the reveal, then feedback. Three tiers: open-loop (no mic at all — pure Pimsleur), scored (one-shot transcription and match), and streak-tracked across episodes.
- **Why it matters.** Retrieval practice beats restudy by roughly 50% and passive listening is the single worst-retention modality — this is the highest-leverage learning intervention available, and Pimsleur proved the zero-ASR version works eyes-free while driving. It also gives the episode a pulse: a linear show that periodically turns to face you.
- **How it works.** The writers' room marks reveal beats and authors the prompt line, the timed pause, and BOTH feedback branches ("Exactly —" / "Most people guess that. Here's the twist —") as ordinary script turns, so everything renders through the normal pipeline. Scored tier: the player records only the 5-second answer window and calls Groq Whisper one-shot (the exact infra `CaptionService`/`AudioIngester` already use), then matches against pre-generated expected-answer patterns; only ambiguous answers get a single Haiku grade. Choosing which feedback branch plays is a client-side switch between two cached mp3s.
- **Token discipline.** Tier one is literally zero marginal cost — authored pauses inside a pre-rendered file. Scored tier: 5s of Whisper ≈ $0.0005; pattern matching resolves ~80% of answers without any LLM; feedback audio is pre-rendered both ways so nothing is synthesized at answer time. No realtime session in any tier; the mic only opens inside the answer window.
- **Inspiration.** Pimsleur's principle of anticipation and timed pauses; retrieval-practice literature (PMC3983480); Volley Question of the Day feedback loops.

#### 4. The Echo — L · Wow 4

- **What it is.** Two days after you finish an episode, a 90-second sequel appears in your feed and inbox: the same hosts, addressing you. "Quick check on Tuesday's episode — three questions, then we're gone." Answer by voice; intervals stretch 2 → 7 → 21 days, and a missed question makes the next Echo re-explain just that concept.
- **Why it matters.** It converts a podcast from a one-shot listen into a retention system — the measurable-learning story no competitor has — and it re-opens the product on a schedule, the cheapest retention loop available. Graduated-interval recall is the most validated trick in audio pedagogy.
- **How it works.** At publish, ScriptRoom emits a per-chapter quiz bank (question line, expected answers, correct/incorrect feedback lines, plus a 30-second re-explain), all rendered once into a clip pool. A queue job on the existing jobs table schedules per-listener Echoes; assembly is Balance-style ffmpeg concat of cached clips selected by the listener's miss history, served on the mini-site using Call It's scoring path. Interval state is one small per-listener row.
- **Token discipline.** The entire clip pool is generated once per episode (a few hundred TTS characters per question — cents). Per-listener Echoes are concatenation of cached clips: zero synthesis, with an optional name-drop line via a Kokoro-class voice at ~$0.001, skippable. Grading is 5-second Whisper one-shots; scheduling is cron with no LLM anywhere. Marginal cost ≈ $0.002 per Echo per listener.
- **Inspiration.** Pimsleur graduated-interval recall; Balance clip-assembled sessions; spaced retrieval-practice studies (PMC9733582).

#### 5. Your Outro — M · Wow 4

- **What it is.** The last sixty seconds of the episode are yours alone: "You took the deep dive on futexes, you asked about starvation — and you called both predictions. The one thing to keep is this…" Non-interactors hear the standard pre-rendered outro; interactors get a recap synthesized from THEIR trace, saved to their history, and it seeds the next episode's cold open — "last time, YOU asked…"
- **Why it matters.** It is proof the episode listened back — the moment interactivity stops being a player gimmick and becomes a relationship. Per-listener memory across a series is a compounding feature no RSS app can copy, and it directly answers "what did I actually retain?"
- **How it works.** The player already accumulates a structured event log (forks taken, Call It results, stored question texts). On completion, a queue job runs one Haiku call over that compact log to draft a 120-word recap in the hosts' voices, renders it via the existing `previewTurn`-style one-shot TTS path, appends it as a personal node on the Episode Map, and stores it per (listener, episode). A per-listener memory row mirrors the show-level `memory_json` pattern already in the schema.
- **Token discipline.** Generated once per completing interactive listener, never during playback: one small text call over a structured event log (~500 tokens in, ~$0.0008) plus ~60 seconds of TTS ($0.015 on mini-tts, ~$0.001 on Kokoro-class). Non-interactors trigger nothing and get the cached generic outro. If a realtime session happens to be open at episode end, the recap is requested out-of-band (`conversation:"none"`) so it never grows the billable conversation. Stored forever, so relistens are free.
- **Inspiration.** NotebookLM's refusal to persist interjections, inverted; Spotify-Wrapped-style personal artifacts; `memory_json`/`memory_summary` columns already in the podcast schema.

### Group B — Non-linear structure

#### 6. Pull the Thread — L · Wow 4

- **What it is.** Every episode ships with 4–8 pre-rendered "bubble" segments — one-to-three-minute optional deep dives the writers' room predicts listeners will want (the derivation, the counterexample, the history, the "okay but what about…"). At fork points a host offers: "Want the three-minute version of why that works, or shall we move on?" Saying "go deeper" plays a cached mp3; silence continues the spine.
- **Why it matters.** BBC's Inspection Chamber proved bubble-out beats full branching: production cost stays contained and the spine stays canonical. It makes the episode feel non-linear to both listener camps — the never-interrupt camp just hears a complete linear show — and it converts the most predictable realtime questions into zero-marginal-cost audio before anyone asks them.
- **How it works.** ScriptRoom gets a tangent pass: after spine approval it drafts the N likeliest tangents as standalone segments with entry/exit lines matched to each fork's tone; they render through the normal pipeline into `podcasts/{episodeId}/segments/` and register as nodes in `timeline_json`. Fork routing: with no session open, an on-page intent match ("deeper", "skip", segment titles) routes with zero LLM; if a Raise Your Hand session happens to be open, it gets a `play_segment` tool so the model can route instead of re-explaining. A nightly job clusters stored listener questions per fork; when a novel question recurs K times, it auto-drafts a new bubble for creator approval.
- **Token discipline.** Bubbles are TTS-once, CDN-forever (~$0.05–0.09 per branch-minute on ElevenLabs, cents on Flash), and `podcast_chunk_audio`'s content-addressed cache means adding a bubble to a shipped episode only synthesizes the new beats — verbatim existing renderer behavior. Fork routing without a session is client-side matching: zero tokens. The promotion loop is the discipline flywheel: any question asked repeatedly migrates from ~$0.017-per-ask realtime to $0 playback forever.
- **Inspiration.** BBC Inspection Chamber "bubble out then return to the spine"; game-audio horizontal re-sequencing (Wwise/FMOD); Balance's configured playback from pre-recorded clips.

#### 7. The Episode Map — L · Wow 4

- **What it is.** Kill the timeline scrubber: on the shared page the episode renders as a subway-map graph — spine chapters as big stops, bubbles and deep dives as loops off the line, quizzes as diamonds. Tap any node, or say "take me to where they explain backpressure." Your progress lights up the track, and you can see which detours 82% of listeners took.
- **Why it matters.** A graph makes non-linearity legible and enticing — doors you can see are doors you open — and reframes the podcast from a duration to endure into a place to explore. It is also the natural chrome for forks, lenses, and quizzes, and Snipd proved player-side intelligence (not feed-side) is what listeners actually engage with.
- **How it works.** `timeline_json` on `podcast_renders` extends from a flat clip list to nodes + edges (id, title, one-line summary, audio span, edge conditions); the writers' room already produces titled beats, so node metadata falls out of the existing script structure. The client draws the graph in SVG with per-node waveforms from stored `peaks_json`. Voice jumps resolve by local fuzzy match against node titles/summaries, with a single utility-tier text call as fallback for odd phrasings. Aggregate per-node listen counters light up the most-explored paths.
- **Token discipline.** Pure navigation of pre-rendered audio — no realtime session exists in this feature at all. Voice jumps hit on-device fuzzy match first; the LLM fallback is one Haiku-class call (~$0.0002) only on low match confidence, memoized per (episode, phrase-hash) so repeated phrasings are free forever. The map itself is a JSON transform of data the render already produces.
- **Inspiration.** Transit-map information design; Audible CYOA save-your-place and double-back; Snipd AI chapters.

#### 8. Lenses — L · Wow 3

- **What it is.** One episode, several tellings: ELI5, Standard, Expert — or persona lenses like The Skeptic or Debate mode. Pick before play, or say "make it simpler" mid-episode and the player crossfades to the same beat in the simpler render without losing your place.
- **Why it matters.** Difficulty choice is the cheapest personalization with the largest felt effect. NotebookLM ships fixed formats and length control but cannot switch mid-stream; beat-aligned switching turns "this is too hard / too basic" from a churn moment into a knob.
- **How it works.** ScriptRoom generates variants structurally locked to the spine's beat IDs — same beat boundaries, different prose — parameterized by the `personas`/`niche_pack`/`style_config` columns that already exist on `podcast_shows`. Variants materialize lazily: the first listener to request Expert triggers a normal render job through the existing status machinery; everyone after hits cache. Because `timeline_json` is beat-aligned across variants, a mid-episode switch is a seek, not a synthesis. "Make it simpler" is an entry in the on-device command grammar.
- **Token discipline.** Script variants are text-cheap (~$0.02–0.07 per variant on Haiku). TTS renders once per variant, lazily — a lens nobody requests costs exactly zero — and `podcast_chunk_audio` dedupes beats that survive verbatim (intros, transitions, outros). Switching lenses is playback of cached audio, never generation, and nothing here opens a realtime session.
- **Inspiration.** NotebookLM's Deep Dive / Brief / Critique / Debate formats; Balance per-user session assembly; existing `personas` + `style_config` columns on `podcast_shows`.

#### 9. The Static Decoy — M · Wow 3

- **What it is.** Every interactive episode also exports a plain mp3 to a real RSS feed for Apple/Spotify reach — but the render is authored to sell its own upgrade: Podcasting 2.0 chapter markers sit on every fork ("Door: the deep dive on X — open it in the interactive version"), and a ten-second baked-in sting at each fork names what you're missing. The feed is the trailer; the mini-site is the show.
- **Why it matters.** RSS has no interactivity primitive, so the dual-artifact architecture is the only workable distribution: a complete, excellent linear listen for the never-interrupt camp, and chapter deep links that convert every podcast app on earth into a funnel toward the interactive player. NotebookLM's downloadable audio is a dead file — this one has doors drawn on it.
- **How it works.** A new unauthenticated `/feeds` route serves per-show RSS — conveniently, RESERVED_SLUGS already parks `feed`, `rss`, and `podcast`, so the namespace is clear. Enclosures need stable public URLs, the same strategy Raise Your Hand introduces (hashed public keys or a permanent redirect route), because 6-hour presigned links cannot live in a feed. Chapters JSON generates from `timeline_json` fork nodes with links to the shared player at `?node=`; the linear master is the existing spine render, and the fork stings are ordinary script beats rendered once.
- **Token discipline.** Zero marginal generation: the linear master already exists as a normal render, chapters are a pure JSON transform of `timeline_json`, and the stings are pre-rendered beats the chunk cache dedupes across re-renders. The feed converts existing artifacts into acquisition — not one new token per subscriber, per download, or per listen.
- **Inspiration.** Podcasting 2.0 chapters namespace (500K+ episodes); the dual-artifact architecture from the category research; RESERVED_SLUGS already holding `feed`/`rss` for platform routes.

### Group C — Simulation bridge (the moat)

#### 10. Second Screen — L · Wow 5

- **What it is.** At a sim chapter the hosts say "grab your phone — flowvid.app/s/XK2 — we'll wait." The project's interactive simulation opens on the phone while the episode audio becomes the guide track: the hosts react to what you actually do — "you found the resonance peak — now break it on purpose."
- **Why it matters.** It solves audio's display problem with hardware every listener is already holding, and it is the bridge that makes a shared podcast episode sell the underlying FlowVid project, because the sim IS the project asset. NotebookLM has banter; nobody has a lab bench.
- **How it works.** Mostly wiring of shipped parts: sims already carry `guidance.js`, which postMessages guidanceCue events and plays cached narration mp3s, and `GuidanceService` already reuses audio for unchanged text by design. New pieces: a pairing channel over SSE (the transport this stack already runs in production) linking the episode player and the phone sim page via short code/QR; sim events route through a writers'-room-authored rules table (event → coaching line) that selects which pre-rendered host line plays next; a stuck-for-60s timer offers a hint line; "done" forks back into the episode spine.
- **Token discipline.** Every coaching and reaction line is pre-rendered through the existing textHash-cached guidance TTS path — the cache whose stated purpose is avoiding TTS re-billing. Event-to-line selection is a deterministic client-side table: zero LLM during play. The only optional spend is an "explain what I'm seeing" escape hatch — one text call plus one cached line, ~$0.002, rate-capped. No realtime session; pairing is SSE messages.
- **Inspiration.** Existing `GuidanceService`/`guidance.js` infrastructure; second-screen TV companion apps; NotebookLM's missing screen.

#### 11. Sonic Sims — XL · Wow 5 (audacious swing #1)

- **What it is.** FlowVid's simulations become instruments you play by voice inside the audio. At publish, the pipeline sweeps the project's simulation across its parameter range and renders each state as SOUND — pitch, tempo, texture mapped to output variables. In-episode: "This is the reactor at 300 kelvin — listen. Now tell me where to take it." Listener: "higher… higher… now dump the coolant." The player morphs through the states and the hosts narrate what you just heard.
- **Why it matters.** No podcast product on earth can do this — it is FlowVid's simulation moat translated into an audio-native form. Sonification upgrades "interactive" from Q&A to PLAY, and the two seconds where the system answers your voice with a rising whine instead of words is the demo clip that markets the whole product.
- **How it works.** FlowVid generates its own sims, so the sim-generation prompt gains a small contract: declare tunable params and an output-series hook (a `window.flowvidParams` postMessage channel, sibling to the existing `guidance.js` channel). A publish-time job reuses the headless sim-capture runner to sweep the declared range into N output series; a sonifier maps series to audio via offline WebAudio/ffmpeg synthesis (oscillators and granular textures — no TTS involved) into a state bank keyed by param hash. The client is a sampler crossfading states; voice steering uses the on-device grammar ("up", "more", param names) with Whisper one-shot fallback. Landmark narration ("that whine is resonance") is pre-rendered guidance-style lines selected by state.
- **Token discipline.** The entire sound bank is synthesized numerically once at publish — no per-listener TTS and no LLM in the loop while playing; it is an audio sampler, not a conversation. Voice steering is on-device grammar with rare $0.0005 Whisper one-shots. Landmark narration reuses the GuidanceTTS textHash cache, which exists explicitly to avoid re-billing unchanged lines. Nothing in this feature ever opens a realtime session.
- **Inspiration.** Scientific sonification (Geiger counters, LIGO chirps); game-audio vertical re-orchestration; existing `guidance.js` postMessage channel + headless sim capture.

### Group D — Social & analytics

#### 12. Clip It — M · Wow 3

- **What it is.** Say "clip that" — or triple-tap your headphones — and the last exchange becomes a shareable audiogram: waveform, captions, host avatars, and a deep link into the episode at that exact node. The killer variant: clipping YOUR interjection — your question and the hosts' answer — shareable proof the show talked to you.
- **Why it matters.** Distribution. Every listener becomes a promoter armed with 15-second artifacts, Snipd proved gesture-capture works, and the interjection clip is an asset only FlowVid can mint — no other podcast has your voice in the episode.
- **How it works.** `podcast_clips` are already immutable per-turn takes with `peaks_json`, so "clip that" snaps to turn boundaries straight from `timeline_json` with no re-cutting. An ffmpeg template job (existing mastering pipeline plus stored peaks) composites the captioned video; the card publishes to the episode's public page on the mini-site with a `t=node` deep link. Interjection clips mix the consented stored question audio with the answer track using the existing `extractClip`/`mixTimeline` toolkit. One cached Haiku call titles the clip.
- **Token discipline.** Zero LLM in the capture path — boundaries, transcript text, and waveform peaks all already sit in the database, and the audiogram is ffmpeg over stored assets. The title call is ~$0.0002, memoized by turn-hash. Interjection audio was already paid for at ask time; clipping re-monetizes spent tokens into marketing.
- **Inspiration.** Snipd triple-tap highlights; Headliner-style audiograms; `podcast_clips` + `peaks_json` tables already in the schema.

#### 13. The Question Wall — L · Wow 5

- **What it is.** With consent, interjections persist as timestamped questions pinned to the Episode Map on the public page — upvotable, browsable ("what did others ask here?"), each replayable with its original answer audio. The creator dashboard clusters them by beat ("28 people got confused at 12:40") and offers one button: "Answer this for everyone" — which drafts a bubble segment, incrementally re-renders only the new beats, and name-checks the asker in-audio.
- **Why it matters.** NotebookLM deliberately throws interjections away; making them a public, compounding layer is the moat. For creators it is analytics gold — a confusion heatmap by beat — and a content engine where the audience literally writes the next segment's brief. Spotify's 9M-user Q&A engagement proves the appetite, but theirs lives outside the audio.
- **How it works.** Store consented exchange transcripts and audio keyed to (episode, node, timestamp); public read endpoints extend the new share-token surface through `podcastAccess.ts`, and upvotes follow the playlist-style public interaction pattern. A nightly embeddings job clusters questions per node. "Answer for everyone" feeds the top cluster into ScriptRoom as a bubble brief via Pull the Thread's machinery; `podcast_chunk_audio`'s content-addressed cache means the re-render synthesizes only the added turns. Replayed answers are the stored mp3s.
- **Token discipline.** Questions were paid for at ask time — the wall is storage, not generation. Clustering is a nightly batch embedding pass costing fractions of a cent per episode. Patch segments convert recurring realtime spend into one-time render spend: one script call plus incremental TTS for only the new beats, which is verbatim existing chunk-cache behavior. Browsing, upvoting, and replaying cost zero tokens.
- **Inspiration.** NotebookLM's non-persistence as a gap to invert; Spotify Q&A/Polls engagement numbers; `podcast_chunk_audio` content-addressed cache.

#### 14. Season Brain — M · Wow 3

- **What it is.** A weekly digest to the creator: "Your audience's top unanswered threads — 41 questions about X, 17 about Y. Draft briefs attached." One tap sends a brief into the normal episode pipeline. The series roadmap becomes a living artifact of audience curiosity, and listeners hear their questions become episodes: "so many of you asked…"
- **Why it matters.** It closes the loop from consumption back to creation. The defensible compounding asset is the question graph — which exists only because FlowVid persists interjections — and for creators it kills the what-do-I-make-next blank page with evidence instead of guesses.
- **How it works.** A weekly batch job aggregates unresolved question clusters across the show (embeddings already computed nightly per episode by the Question Wall), scores them by volume, recency, and upvotes, and runs one Haiku pass to draft two or three episode briefs in the show's existing brief format. The digest lands in the creator dashboard and email; accepting a brief creates a draft episode with the source questions attached as `podcast_sources` notes, and the writers' room takes over like any other episode.
- **Token discipline.** Entirely batch and entirely text: it reuses the nightly embeddings and adds one small LLM call per show per week (~$0.001–0.01). No audio is synthesized until the creator commissions a real episode through the normal, already cost-accounted pipeline. Zero listener-side cost, zero realtime anything.
- **Inspiration.** Subreddit-driven content programming; NotebookLM's missing feedback loop; existing brief/sources tabs on episodes.

### Group E — Audacious

#### 15. Call the Show — XL · Wow 5 (audacious swing #2)

- **What it is.** Every show gets a phone number. Listeners call from the car, talk with the hosts for up to three minutes about any episode, and hang up. The best calls — consent captured in-call — return as next episode's mailbag segment: the caller's real voice intercut with freshly rendered host responses. AM talk radio, resurrected with AI hosts, fully async.
- **Why it matters.** It needs no app, no login, no screen — the podcast that answers the phone — and it reaches listeners of the static RSS copy, whose show notes can literally say "call the show." Mailbag segments are community-flywheel content that makes every episode partially audience-authored.
- **How it works.** OpenAI Realtime supports SIP natively; a Twilio number routes into a realtime session configured with the show's personas and a RAG tool over the show corpus (episode scripts already exist as structured text). Hard 3-minute cap, in-call consent question, recording stored like a `podcast_source`. The creator dashboard queues calls; "add to mailbag" drafts host response turns in ScriptRoom, renders incrementally through the chunk cache, and splices caller audio with the existing `extractClip`/`mixTimeline` toolkit.
- **Token discipline.** Connect-on-demand is structural — a phone call IS the interjection, and the session exists only for the capped call. Grounding is a lean RAG tool call over the corpus, never a stuffed 32k context, and the per-show instruction prefix is byte-stable for caching. ~$0.05–0.10 per 3-minute call on mini; the creator sets a monthly minutes budget enforced through the same admission-control pattern as `generation_limit_enabled`, and overflow rolls to voicemail-transcribe (Whisper at $0.006/min) which still feeds the mailbag. Mailbag production is batch script + incremental TTS.
- **Inspiration.** Talk-radio call-in format; OpenAI Realtime SIP transport; Vapi/Retell all-in economics, avoided by self-orchestrating.

#### 16. The Listening Party — XL · Wow 5 (audacious swing #3)

- **What it is.** A synced group listen on the shared page — a classroom, an onboarding cohort, a Discord crew. Everyone's player is locked together; anyone raises a hand; the hosts pause for the ROOM, take the question by name ("Maya asks—"), answer once for everyone, and resume. A live class taught by the episode itself.
- **Why it matters.** It amortizes interactivity's cost across N listeners while multiplying its social value — teacher-plays-episode-to-class is a direct wedge into education, and a party is an event you can schedule and invite people to, so acquisition is built into the format.
- **How it works.** Room state (position, play/pause, hand queue) syncs over SSE — the transport already proven in production here — with the room owner's client as clock master and joiners entering via the public episode page plus a room code. A hand-raise pauses all players by SSE fanout; ONE realtime session opens for the exchange with only the asker's mic unmuted; the answer audio relays into the room's shared position; the session closes on resume. Every exchange lands on the Question Wall automatically.
- **Token discipline.** Playback costs zero tokens at any room size — sync is SSE messages, not media. Exactly one realtime session per Q&A moment serves the entire room, so per-listener cost divides by N: a 25-student class asking six questions ≈ $0.10 total, ~$0.004 per student. Session lifecycle matches Raise Your Hand (open on hand, close on resume, cached transcript prefix, 3-minute cap), and the hand QUEUE batches several questions into one session window instead of many cold starts.
- **Inspiration.** Twitch watch parties; classroom read-alouds; existing production SSE infrastructure + BBC's interaction-must-be-optional rule.

---

## 5. Architecture

All load-bearing claims verified against the repo. Verified anchors: `podcastAccess.ts` is the sole ownership seam; `share_token` exists only on projects (`schema.ts:174`) and playlists (`:713`); masters are 6h-presigned (`podcast-render.controller.ts:24`); clips are public-bucket hashed keys (`podcast-studio.controller.ts:72`); `podcast`/`podcasts`/`feed`/`rss` are reserved slugs (`permalinkService.ts:27,35`); the middleware matcher is only `/c`,`/v`,`/pl`. Branch: `feat/library-share-minisite` (currently checked out, zero commits over main — the episode mini-site is this branch's work). Paths relative to `podcast-saas/`.

### 5.1 Episode generation path (once per episode, amortized across all listeners)

- **Bridge, new surface**: `POST /api/v1/podcasts/shows/:showId/episodes/from-project` in `backend-api/src/controllers/v1/podcast.controller.ts` creates an episode plus a `podcast_sources` row with new kind `'project'` (beside file|url|note).
  - New `backend-api/src/services/podcast/ProjectSourceIngester.ts` (sibling of PDFIngester/WebIngester) compiles `extracted_md` from: `projects.title/description`, `scenes` rows (speaker/transcript/start_ms per script_version, `schema.ts:354`), `timeline_sections` labels/notes/sim_prompt (`:634`), and captions VTT.
  - Provenance: nullable `project_id` on `podcast_sources` only — `podcast_episodes` gets **no** project FK, preserving the deliberate domain decoupling; re-import is a new source row.
- **Script**: unchanged writers' room — `podcast_script` job → `runPodcastScript.ts`/`ScriptRoom.ts` via LLMService creative tier (pinned Claude). Cost ≈ $0.10–0.25/ep Sonnet-class ($0.02–0.07 Haiku). Negligible.
- **TTS render**: unchanged `podcast_render` job → `PodcastRenderer.ts` → `ElevenLabsDialogue.ts` (eleven_v3, chunk-cached in `podcast_chunk_audio` so edits re-bill only changed beats). ≈ $0.09/min of speech → **~$1.35 per 15-min episode, ~$2.70 per 30-min** — TTS dominates generation cost. Levers held in reserve: ElevenLabs Flash halves it; gpt-4o-mini-tts ($0.015/min ≈ $0.23/ep) would abandon the dialogue-timestamp pipeline — not now.
- **Publish artifacts**: new `backend-api/src/services/podcast/publishEpisode.ts`, run on share-enable and on each ready render:
  - Copies the master mp3 to a stable content-hashed **public** key `podcasts/{episodeId}/public/{sha256}.mp3` (the exact unauthenticated-bearer model `podcast_clips` already uses via `storage.getPublicUrl`) — 6h presigned URLs cannot back a public player.
  - Derives `transcript.json` (speaker/text/start/end per turn) and `chapters.json` from `timeline_json` — PodcastRenderer already writes `{placements, totalMs}` (`PodcastRenderer.ts:124`) and every timeline entry carries `beat` (`timeline.ts:29`), so chapters fall out of beat boundaries. New columns on `podcast_renders`: `public_mp3_key`, `public_transcript_key`.
- **Storage cost note**: chunks/clips/masters are never deleted; a 30-min episode ≈ 60–90MB at rest incl. the public copy — cents on R2. The real risk is **egress** on a viral public page: serve public keys with `cache-control: public, max-age=31536000, immutable` (keys are content-hashed) and prefer the R2 adapter (zero egress) for the public bucket.

### 5.2 The interaction loop

1. **Play**: plain `<audio>` element on the share page, CDN-cached public mp3. No session, no mic, no AI spend — **$0.00 while listening**.
2. **Barge-in**: push-to-talk (hold or tap) in v1. Nothing streams while listening; no wake word, no open mic — this deletes the VAD-false-trigger money leak outright.
3. **Pause + connect**: on press, playback pauses (sidestepping the browser-AEC echo gotcha — podcast audio never coexists with the mic), a pre-cached earcon ("Mm-hm?") plays, and the client calls `POST /api/v1/public/podcast/:shareToken/voice-session`. New `backend-api/src/services/podcast/realtime/RealtimeVoiceService.ts` checks budgets, then mints an ephemeral OpenAI **client_secret** by raw fetch to `/v1/realtime/client_secrets` with the key from `ApiKeyService.getSystemKey('openai')` (verified union) — the exact analogue of `anamService.ts` minting single-use Anam session tokens. Secrets die in ~1 min; they only gate connection start.
4. **Session** (config 100% server-controlled): `gpt-realtime-2.1-mini`, **WebRTC transport** — media flows browser↔OpenAI directly, nothing touches the 2-vCPU VM or nginx (the proven Anam pattern; no @fastify/websocket needed). semantic_vad; hard caps: 5-min session, max_output_tokens ≈ 60s of speech per answer.
   - **Context**: instructions = byte-stable prefix [show personas from `podcast_shows` teacher/learner/personas/style_config + grounding rules + full transcript as text (~6k tokens for 30 min — fits the 32k window)], with the volatile line — "listener paused at 12:34 in chapter X" — appended **after** the prefix. Automatic prompt caching (stable prefix ≥1024 tokens) makes follow-up context ~99% off. RAG-via-tool only later, when a show corpus outgrows 32k.
5. **Answer**: streamed in the host persona (closest OpenAI voice + persona prompt — see open decision 1), animating the existing `AvatarCirclesOverlay`/`avatarAudioGraph` visualizer. On listener interruption the client sends `conversation.item.truncate` so unheard audio is never re-billed in later turns.
6. **Close + resume**: on answer end + 15s idle (or release), the client tears down the peer connection and posts `.../voice-session/:id/close` with usage from `response.done`; the ledger reconciles; playback resumes at the paused position.

**Latency budget**: mint 200–400ms + WebRTC connect 0.6–1.4s cold; pre-warm starts at button-press and the earcon masks the gap → first host audio **~0.8–1.5s** after the question ends (measured realtime TTFT 0.82s) — inside the perceived-natural window.

**Real numbers (mini, 15s question / 30s answer)**: first interjection ≈ **$0.017** (transcript prefix billed once), cached follow-ups ≈ **$0.014**. Flagship 2.1 ≈ $0.067/exchange. **20-min listen with 5 questions ≈ $0.07** ($0 listening + $0.017 + 4×$0.014). Keeping a flagship session open for the whole listen would run $1–2 (talk-time dependent, $3–5/hr) — this design is ~50–70x cheaper per listener-hour.

### 5.3 Fallback ladder + where metering attaches

- **Tier 0 — typed (default, every visitor, no mic)**: `POST /api/v1/public/podcast/:shareToken/ask`, streamed over SSE via `lib/sse.ts` (the transport `sections.controller.ts` already proves in production). Runs through LLMService with new TaskType `podcast_public_qa` in the utility tier (`TASK_TIER`, `LLMService.ts:54`), same cached transcript prompt; answers cite timestamps the player renders as seek links. ≈ $0.001–0.01/exchange. Optional "read aloud": one-shot ElevenLabs TTS cached by answer hash exactly like `previewTurn.ts:57–90` (`podcast_chunk_audio` + `podcasts/{ep}/previews/{hash}.mp3`).
- **Tier 1 — chained voice (phase 4)**: record question → Groq whisper-large-v3 one-shot (`AudioIngester` pattern, ~$0.006/min) → utility LLM → cached TTS. ≈ $0.01/exchange at 1–2s latency.
- **Tier 2 — realtime (premium / owner-enabled)**: section 5.2.
- **Metering**: the typed path records via existing `UsageTrackingService.record` → `token_usage` insert (`:19`), attributed to the **owner's** user_id so `RateLimitService` 7/30-day budgets backstop automatically. Realtime minutes get new `backend-api/src/services/usage/VoiceUsageService.ts` writing new table `podcast_voice_sessions` (episode_id, share_token, ip_hash, model, seconds_in/out, audio+text tokens, cost_cents, created_at/closed_at) — the duration-denominated ledger `token_usage` lacks. Kill switch `podcast_voice_paused` + default budgets in `admin_settings` (mirrors `generation_paused`). Billing: creator-prepaid **interaction-credit packs** through the existing one-time Stripe Checkout path (`BillingService.grantPurchase`) — no subscription plumbing required.

### 5.4 Endpoints + components

Backend (`backend-api/src/`):

- **Migration 046**: `podcast_episodes` + `share_token` unique / `share_enabled_at` / `public_render_id` (mirror projects `:174–175`); `podcast_renders` + `public_mp3_key`/`public_transcript_key`; `podcast_sources` + `project_id`; new `podcast_voice_sessions`; `admin_settings` flags/budgets.
- `services/podcastAccess.ts` — the mandated seam: add `episodeByShareToken(token)` resolving episode+show iff share enabled and a ready public render exists. All public reads route through it; controllers never inline token checks.
- New `controllers/v1/podcast-share.controller.ts` (namespace per `public-courses.controller.ts`): `GET /api/v1/public/podcast/:shareToken` (meta + public URLs + transcript + chapters; `firebaseAuthOptionalMiddleware` like `share.controller.ts:16`), `POST .../ask` (SSE), `POST .../voice-session`, `POST .../voice-session/:id/close`.
- `controllers/v1/podcast.controller.ts` (changed): `POST .../episodes/from-project`; `POST .../episodes/:episodeId/share` (enable/rotate/disable via `ownedEpisodeInShow`).
- New services: `podcast/ProjectSourceIngester.ts`, `podcast/publishEpisode.ts`, `podcast/realtime/RealtimeVoiceService.ts`, `usage/VoiceUsageService.ts`.

Frontend (`client-web/`):

- `app/podcast/[shareToken]/page.tsx` — thin server component mirroring `app/v/[shareToken]/page.tsx`. `podcast` is already in RESERVED_SLUGS so permalinks can't shadow it; `middleware.ts` stays untouched (public page; matcher remains `/c`,`/v`,`/pl`).
- New `components/podcast/share/`: `SharedEpisodePage.tsx`, `EpisodePlayer.tsx` (`<audio>` + chapter rail + follow-along transcript; reuse `AvatarCirclesOverlay` via `MediaElementAudioSourceNode`), `AskPanel.tsx` (uses `lib/sse-client.ts`), `TalkControl.tsx` + `lib/podcastRealtime.ts` (mint, WebRTC, truncate, usage post).
- `components/podcast/PodcastEpisodePage.tsx` (changed): Share panel — toggle, copy link, usage/credit readout; `lib/api.ts` gains the new calls.

### 5.5 Security / abuse: anonymous listeners cannot drain the owner's wallet

- **Tokens**: crypto-random `share_token` (same as projects); owner rotate/disable takes effect immediately via the seam; public audio keys are content-hashed (existing clips threat model) and re-keyed on next publish after a disable.
- **The wallet rule**: a voice session is never opened on the client's word. Mint-time enforcement in RealtimeVoiceService: per-link daily budget (default 30 realtime min + 60 typed questions), per-`ip_hash`-per-link caps (default 3 sessions / 10 min / 10 typed per day), global kill switch — all checked **before** minting. Each mint debits the ledger for the worst-case session (5-min cap, ~$0.15 on mini); honest close reports refund the remainder — a client that never reports still cannot overdraw.
- **In-session caps ride in server-set config** (client can't alter model/instructions/caps — the Anam personaConfig precedent): 5-min session, ~60s max answer, secret dead in ~1 min unused. OpenAI's 60-min hard cap is moot.
- **At the cap**: 429 + Retry-After; UI degrades voice → typed → "Q&A is resting — playback unaffected." Playback itself is never gated, metered, or interrupted.
- **Typed tier**: per-IP Fastify rate limit, 500-char question cap, grounding-only system prompt (transcript-bounded, no tools), optional `ContentModerationService` pass; owner-attributed `RateLimitService` budget is the final backstop.
- **Prompt injection**: listeners contribute only speech/text content; instructions, tools, and caps are minted server-side; the cached prefix is creator-authored.

### 5.6 Cost model

All rates verified (section 2.7 sources); volumes are stated assumptions.

| Line item | Rate basis | Cost |
|---|---|---|
| Script generation, 15-min episode | Claude Sonnet-class creative tier | $0.10–0.25 ($0.02–0.07 Haiku) |
| TTS master, 15-min episode | ElevenLabs eleven_v3 ≈ $0.09/min speech | ~$1.35 (Flash: ~$0.68) |
| TTS master, 30-min episode | same | ~$2.70 (Flash: ~$1.35) |
| Publish artifacts (public copy, transcript.json, chapters.json) | ffmpeg copy + JSON transforms | ~$0 |
| **Fully-loaded generated episode** | | **~$0.75–3.00, once, amortized across all listeners** |
| Extra pre-rendered branch minute (bubbles, lenses, stings) | eleven_v3 / Flash | ~$0.05–0.09 |
| Listening (any duration, any listener count) | no session exists | **$0.00** |
| Typed Q&A exchange | utility-tier LLM + cached transcript prefix | $0.001–0.01 |
| Chained voice exchange (tier 1) | Whisper $0.006/min + utility LLM + cached TTS | ~$0.01 |
| Realtime interjection, first (15s Q / 30s A) | gpt-realtime-2.1-mini | **~$0.017** |
| Realtime interjection, follow-up (cache hit) | mini, cached transcript prefix | **~$0.014** |
| Same exchange on flagship gpt-realtime-2.1 | | ~$0.067 |
| **20-min listen with 5 voice questions** | mini | **~$0.07** |
| Listener-hour with 4 interjections | mini | ~$0.06–0.07 |
| 1,000 listeners/mo — worst case (every listener 20 min + 5 voice Qs) | mini | **~$73/mo** |
| 1,000 listeners/mo — realistic (20% interact, avg 2 voice Qs; 500 typed Qs) | mini + utility tier | **~$9/mo** |
| + 4 new 30-min episodes that month | script + eleven_v3 | ~$12/mo |
| Same 1,000 listeners on an always-open flagship session | $3–5/hr, ~333 listener-hours | **~$1,000–1,700/mo — the design this architecture structurally forbids** |
| Storage, per 30-min episode at rest (incl. public copy) | R2 | 60–90MB, cents; egress $0 on R2 + immutable cache headers |

Levers that keep the model honest: byte-stable prompt prefix (position/timestamp at the END), lean tool outputs, `conversation.item.truncate` on barge-in, idle timeout + hard session cap, mini-by-default with per-show escalation to flagship as config, and RAG-via-tool-call only when a series' corpus outgrows the 32k window.

---

## 6. Work plan

### Phase 1 — bridge + public episode page (shippable alone, zero listen-time AI)

- **Scope**: migration 046 share columns + public keys; `ProjectSourceIngester`; from-project + share endpoints; `publishEpisode`; `episodeByShareToken` in the seam; public GET; `/podcast/[shareToken]` player with chapters + transcript; Share panel in `PodcastEpisodePage`.
- **Effort**: ~5–6 dev-days.
- **Demo**: pick a video project → "Share as podcast" → episode arrives pre-briefed with the project source attached → approve script → render → toggle Share → open `/podcast/{token}` in incognito: it plays, chapter-seeks, and the link still works 7+ hours later (public key, not presigned).

### Phase 2 — typed Q&A

- **Scope**: `podcast_public_qa` TaskType; `/ask` SSE endpoint + per-link/per-IP budgets; AskPanel with timestamp-cite seek links; owner-attributed `token_usage` rows.
- **Effort**: ~3–4 dev-days.
- **Demo**: anonymous visitor asks "what was the point about X?" → streamed grounded answer citing 12:34 as a jump link; the 11th same-IP question that day hits the cap message; owner sees the `cost_cents` rows.

### Phase 3 — realtime voice

- **Scope**: `RealtimeVoiceService` mint + worst-case-debit ledger (`podcast_voice_sessions`); TalkControl (pause → earcon → pre-warmed WebRTC → truncate-on-interrupt → resume); `VoiceUsageService`; kill switch; cap-degrade UX.
- **Effort**: ~6–7 dev-days.
- **Demo**: mid-playback hold Talk, ask aloud; the host-persona voice answers ~1s after you stop; playback resumes; the session row shows ≈$0.02; a 4th session from the same IP is refused and the UI falls back to typed.

### Phase 4 — economics + hardening

- **Scope**: interaction-credit packs (BillingService one-time Checkout); owner usage dashboard in the Share panel; R2/immutable-cache pass on public assets; chained voice tier; consented question log + stable chapter-node ids in `publishEpisode` (groundwork for Question Wall / Episode Map / Static Decoy RSS without schema churn).
- **Effort**: ~4–5 dev-days.
- **Demo**: owner buys a 300-min pack; dashboard shows per-episode spend and a >90% cache-hit ratio on follow-up interjections.

**Total: ~18–22 dev-days across four phases**, each independently demoable, phase 1 shippable on its own.

### Beyond phase 4 — how the catalogue lands on this foundation

| Idea | Rides on | Incremental surface |
|---|---|---|
| Pull the Thread (6) | chapter-node ids + chunk cache (P4 groundwork) | ScriptRoom tangent pass; segment nodes in `timeline_json` |
| The Episode Map (7) | nodes/edges `timeline_json`, `peaks_json` | SVG graph client; per-node counters |
| The Question Wall (13) | consented question log (P4), share seam | public read endpoints, upvotes, nightly embedding job |
| The Static Decoy (9) | stable public URLs (P1) | `/feeds` RSS route + chapters JSON |
| Call It (3) / The Echo (4) | script-authored beats + Whisper one-shots | quiz bank emit; scheduler job; interval rows |
| Lenses (8) | beat-aligned `timeline_json` | variant pass + lazy render trigger |
| Second Screen (10) | `guidance.js` + SSE | pairing channel + rules table |
| Hands-Busy (2) | window schedule in `timeline_json` | Silero WASM + command grammar |
| Sonic Sims (11), Call the Show (15), Listening Party (16) | everything above | dedicated projects; scope separately |

---

## 7. Open decisions (recommended defaults)

1. **Host-voice fidelity.** Realtime answers use the closest OpenAI voice + persona prompt, not the episode's ElevenLabs voice. **Default: accept in v1** (the pause frames it as the host "stepping out of the recording"); revisit ElevenLabs Agents ($0.08/min flat, LLM absorbed) only if listener tests reject the mismatch.
2. **Realtime provider.** **Default: `gpt-realtime-2.1-mini`** (TTFT 0.82s, ~$0.014–0.017/exchange). Gemini Live is marginally cheaper but 2.98s TTFT + 15-min audio session cap disqualify it. Per-show escalation to flagship 2.1 is config, not code.
3. **Public route.** **Default: `/podcast/[shareToken]`** under the already-reserved slug, vs a new `/p` namespace requiring a RESERVED_SLUGS addition.
4. **Public master URL.** **Default: content-hashed copy in the public bucket**, vs a redirect route that re-presigns per hit — the redirect keeps one copy but adds latency and defeats range requests/CDN caching.
5. **Interjection persistence.** **Default: NOT stored** (NotebookLM privacy precedent); transcript text only behind an explicit consent checkbox; anonymous aggregate counters always on.
6. **Who pays.** **Default: creator-prepaid credits with a free monthly allowance**; listener-pays premium can reuse the existing share paywall stub later.
7. **Provenance column.** **Default: `project_id` on `podcast_sources`** (preserves domain decoupling; re-import = new source row), vs on `podcast_episodes`.
8. **Mic UX.** **Default: push-to-talk only in v1**; Silero VAD WASM "invited windows" (Hands-Busy Mode) deferred until the pause/earcon loop is proven in production.

---

## 8. Relationship to in-flight work

- **This design IS the `feat/library-share-minisite` branch's content.** The branch is checked out with zero commits over `main`; the public episode page (phase 1) is the mini-site work, and the plan aligns with `md-files/LIBRARY-SHARE-MINISITE-PLAN.md` rather than duplicating it.
- **It rides the existing podcast surface, changing nothing about how episodes are made.** Writers' room, renderer, chunk cache, mix studio, clips, and status machinery are consumed as-is. The generation pipeline gains exactly one new source kind (`'project'`) and one post-render publish step.
- **It extends, never bypasses, the mandated seams.** All ownership and share-token resolution goes through `services/podcastAccess.ts` (the file's own contract anticipates this retrofit); public endpoints mirror `share.controller.ts`; the ephemeral-token mint mirrors `anamService.ts`; typed Q&A streams over the production-proven `lib/sse.ts`; metering mirrors `UsageTrackingService`/`token_usage` and admission control mirrors `generation_limit_enabled`/`generation_paused`.
- **It adds zero load-bearing infrastructure to the VM.** No WebSocket server, no TURN/SFU, no realtime media through nginx — WebRTC flows browser↔OpenAI exactly as Anam media flows browser↔Anam today. The 2-vCPU host and its global ffmpeg cap (see the export-capture throughput history) are untouched at listen time; the only new server work is batch publish artifacts and the usual render jobs.
- **It respects the deliberate project↔podcast decoupling**: provenance is a nullable `project_id` on `podcast_sources` only; no episode→project FK; the bridge is acknowledged new surface, not wiring.
- **Namespace and routing are pre-cleared**: `podcast`/`podcasts`/`feed`/`rss` already sit in RESERVED_SLUGS, `middleware.ts` stays untouched, and the public page ships as new unauthenticated endpoints — the only correct option given that `/podcasts` protection is entirely API-side today.
