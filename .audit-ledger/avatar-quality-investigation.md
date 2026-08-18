# Ask-the-Avatar — QUALITY investigation

Branch `fix/night-audit-2026-08-15` @ `ef651a9`. Read-only: no file was modified, no server started,
no vendor called, no database connected to. Every claim is derived from source, schema DDL and git
history, and carries a `path:line` that resolves from the repo root.

Scope is **answer quality and generation soundness**, not latency. The latency work already on this
branch (`d3200f3`, `cac5066`) is taken as given and is not re-reported.

Labels used throughout, as requested:
**BUG** = wrong today · **LIMIT** = correct today, fails at scale · **COST** = works, but expensive.

---

## 0. The one-paragraph verdict

The weakest link is **retrieval — and specifically the visual retrieval, not the text retrieval.**

For *text*, there is no app-side retrieval at all and that is a defensible choice: the whole
transcript (head-truncated at 24 000 chars) is pasted into the persona's system prompt, and a second
copy (head-truncated at 200 000 chars) is handed to Anam's own knowledge/RAG tool. There is no
ranking because there is nothing to rank — it is "send everything". That is fine up to about a
30-minute video and silently wrong above it.

For *visuals* there IS a retrieval algorithm, it IS the thing the viewer sees, and it is unsound in
three independent ways: the candidate set is chosen by **popularity before relevance** (§2.1), the
cache key is **the previous user utterance while the cached content came from the avatar's reply**
(§2.2), and the pool is **global across every tenant** while the fix that was supposed to make it
per-project only changed the two editor paths and the two list endpoints (§2.3). The net effect is
that after roughly the first hour of real traffic the avatar stops showing a project's own curated
media and starts showing whatever image happened to be generated most often across the whole
platform, with no gate and no owner-visible surface to remove it.

Second-weakest link: **the prompt**, in one specific respect — the classifier is told "image — USE
BY DEFAULT" and charts are permitted with model-invented numbers and no grounding to the transcript
(§3.4). An educational product that renders fabricated quantitative data as a Chart.js bar chart
with a confident caption is a correctness problem, not a polish problem.

The model itself is not the bottleneck.

**Two things that must be said loudly:**

1. **The fail-open moderation finding is STILL TRUE on this branch.** See §5. It is a live P1.
2. **None of the avatar paths call moderation at all**, so even if §5 were fixed, viewer text would
   still reach `gpt-image-1` unscreened on an unauthenticated endpoint. See §5.2.

---

## 1. What the avatar knows, and how it got there

### 1.1 The knowledge path, end to end

There are exactly two channels, and both are populated by the same function.

```
video_files.captions_vtt
  └─ vttToPlainText()                 services/course/transcript.ts:7-25
      ├─ getProjectTranscript()       services/transcriptPropagation.ts:46-58     [longest non-broll wins]
      │   ├─ withTranscriptKnowledge()  services/avatar/personaBake.ts:38-48      [head 24 000 chars]
      │   │   └─ persona.systemPrompt  services/avatar/anamService.ts:727-741     [flat, in every turn]
      │   └─ hashTranscript()          services/avatar/personaFingerprint.ts:33-36
      └─ propagateToAvatar()          services/transcriptPropagation.ts:170-231
          └─ uploadKnowledgeDocument() services/avatar/anamService.ts:814-825     [head 200 000 chars]
              └─ Anam knowledge group + RAG tool → attached via toolIds
```

**There is no ranking, no scoring, no chunking, no embedding, and no selection anywhere on the text
path.** The only thing that resembles retrieval is the vendor-side knowledge tool, whose ranking is
a black box this repo cannot see or tune. `RAG_DESC` (`anamService.ts:772`) is the entire instruction
the model gets about when to use it.

Size bound: `TRANSCRIPT_KNOWLEDGE_MAX_CHARS = 24_000` (`personaBake.ts:27`), `DOC_MAX_CHARS = 200_000`
(`transcriptPropagation.ts:38`), plus user `knowledge` capped at 40 000 chars by the zod schema
(`avatar.controller.ts:763`) and `systemPrompt` at 20 000 (`:760`).

### 1.2 BUG — the transcript is silently truncated and still described as "the exact spoken content"

`personaBake.ts:44-46` builds the block as:

> `VIDEO TRANSCRIPT — the exact spoken content of the video the viewer is watching. Base your answers about the video on it:` + `transcript.slice(0, 24_000)`

`.slice()` is a head-truncation on a character boundary, mid-word. Nothing tells the model that the
tail is missing. So for any video whose transcript exceeds 24 000 chars the avatar is handed a
partial script *labelled as complete* and will confidently answer "the video does not cover that"
about material that is in the video.

At what scale: 24 000 characters ≈ 4 300 words ≈ **28–32 minutes of speech at 140–160 wpm**. Every
video longer than roughly half an hour is affected, and the affected region is always the end — the
conclusion, the summary, the call to action.

The 200 000-char RAG copy partially covers this *only if* the knowledge tool is actually attached
and Anam actually retrieves from it. On the stateful fast path the persona carries `toolIds`
(`anamService.ts:744-746`); on the ephemeral path the mint retries **without** `toolIds` after a
vendor 400 (`mintWithToolFallback`, `anamService.ts:587-595`), and the comment at `:584-586` says the
knowledge "still rides inline in the systemPrompt" — which is the truncated 24 k copy. So the
degraded path is exactly the path where truncation matters most.

*Cannot tell from the repo:* the real distribution of transcript lengths. **Measurement that settles
it:**
```sql
BEGIN READ ONLY;
SELECT count(*) FILTER (WHERE n > 24000) AS truncated,
       count(*)                          AS with_captions,
       percentile_disc(0.5)  WITHIN GROUP (ORDER BY n) AS p50,
       percentile_disc(0.95) WITHIN GROUP (ORDER BY n) AS p95, max(n)
FROM (SELECT length(captions_vtt) AS n FROM video_files
      WHERE NOT is_broll AND captions_vtt IS NOT NULL) s;
ROLLBACK;
```
(`length(captions_vtt)` over-counts vs. the plain text by the timing lines — roughly 1.6–2×. Divide
by ~1.8 for the plain-text estimate, or run `vttToPlainText` offline over a sample.)

### 1.3 BUG — a multi-segment project's avatar knows only ONE segment, and the two channels disagree about WHICH

`getProjectTranscript` (`transcriptPropagation.ts:46-58`) iterates every non-broll `video_files` row
of the project and keeps **the longest**. A project is not one video: `video_files.sequence_id`
(`db/schema.ts:439`) points at `branch_sequences` (`db/schema.ts:1044`), so a branching project is a
graph of many non-broll segments in one project row.

Now trace the two writers:

| Writer | Which transcript | Line |
|---|---|---|
| `propagateToAvatar` — RAG doc + re-bake | **the video that just finished captioning** | `transcriptPropagation.ts:192`, `:221` |
| `propagateToAvatar` — `transcriptHash` | **the video that just finished captioning** | `transcriptPropagation.ts:175` |
| `PUT /avatar/config` — bake + `transcriptHash` | **the longest** (`getProjectTranscript`) | `avatar.controller.ts:846`, `:852` |
| `/avatar/start` fallback inline | **the longest** (`getProjectTranscript`) | `avatar.controller.ts:219` |

Three consequences, all provable from those four lines:

1. `deleteKnowledgeDocument(existing.transcriptDocId)` at `transcriptPropagation.ts:189` deletes the
   *previous* segment's document before uploading this one. A five-segment project therefore ends
   with **exactly one** segment in its knowledge group — whichever finished captioning last.
2. On the fast path the persona was baked with segment *last*, while `getProjectTranscript` says the
   video is segment *longest*. If they differ, the avatar's knowledge is a segment the viewer may
   not even be watching.
3. **The self-heal can never fire again.** `personaBake.ts:119`:
   `if (fresh.transcriptHash && fresh.transcriptHash !== transcriptHash) return;` — `fresh.transcriptHash`
   was written by propagation as `hash(last-captioned)`; `transcriptHash` here is
   `hashTranscript(input.transcript)` where `input.transcript` came from `getProjectTranscript` =
   `hash(longest)`. When those differ the background bake returns early **every time, forever**, so
   the project is permanently pinned to the slow ephemeral path — which is the exact latency
   regression `d3200f3` was written to eliminate.

The regression test does not catch this: `services/avatar/__tests__/transcriptRebake.test.ts:32`
mocks `video_files.findMany` as `async () => []`, so `getProjectTranscript` is never exercised with
more than zero rows.

*Cannot tell from the repo:* how many production projects have >1 non-broll video with captions.
**Measurement:**
```sql
BEGIN READ ONLY;
SELECT count(*) FROM (
  SELECT project_id FROM video_files
  WHERE NOT is_broll AND captions_vtt IS NOT NULL
  GROUP BY project_id HAVING count(*) > 1) s;
ROLLBACK;
```
If that number is 0, this is latent. If it is non-zero, item 3 is a live latency bug on those rows.

### 1.4 BUG (design-level) — the avatar has no idea where in the video the viewer is

Nothing on either side sends a playhead position. `vttToPlainText` (`transcript.ts:16`) explicitly
drops every `-->` timing line, so the timestamps are destroyed *before* the text ever reaches the
avatar — the model could not localise an answer even if asked. `AvatarPopup` (`AvatarPopup.tsx:30-45`)
pauses every `<video>` on the page and passes only `projectId` and `videoTitle`; grep for
`currentTime` across `client-web/components/avatar/**` returns zero hits outside CSS `position`
strings.

So "what were they just talking about?" is answered against the whole flat script, and "explain that
again" has no referent. This is a hard quality ceiling, and it is cheap to lift — the VTT already
has the cue times, they are simply thrown away one function too early.

### 1.5 COST — the per-turn system prompt is 12–25 k tokens and is re-sent every turn

Measured from source: character prompt 4 000–7 000 chars (`characters.ts`, 20 805 chars for four
characters), plus user `knowledge` ≤ 40 000, plus transcript ≤ 24 000 → up to ~84 000 chars ≈
**21 000 tokens** of system prompt, resident on the Anam-side brain for every single utterance of
every session.

*Cannot tell from the repo:* whether Anam applies prompt caching, and what Anam bills per input
token — the repo records **zero** cost for Anam sessions (`token_usage` has no Anam rows;
`recordChatUsage` is never called on the `/avatar/start` path). **Measurement:** one Anam invoice line
for a known session, against `maxSessionLengthSeconds` (default 600, `anamService.ts:487`).

---

## 2. The visual retrieval algorithm — this is where the quality is lost

Order of operations in `analyzeVisual` (`services/avatar/visualService.ts:157-350`):

```
0. detectVisualIntent(message)                 visualIntent.ts:30-52      pure regex, deterministic
1a. findVisual(topic, requestedType)           libraryService.ts:44-72    exact key, then ILIKE '%head%'
1b. findVisual(context ?? message)             libraryService.ts:44-72    exact key, then ILIKE '%head%'
1c. findRelevantLibraryVisual(message,context)  libraryService.ts:113-160  token overlap over TOP-400-BY-USE_COUNT
2. gpt-4.1-mini classify                        visualService.ts:220-237   model-judged
3-4. generate + store to project_id = NULL      visualService.ts:258-347
```

Only step 1c has anything resembling relevance scoring, and it is bag-of-words token overlap with
hand-written stopword and "type word" lists (`libraryService.ts:77-101`) — no IDF, no stemming, no
embeddings, no threshold beyond an integer count.

### 2.1 BUG — the candidate set is chosen by POPULARITY, then filtered by relevance. Not the other way round.

`libraryService.ts:120-125`:

```ts
const candidates = await db.select().from(avatar_visuals)
  .where(and(...conds))
  .orderBy(desc(avatar_visuals.use_count), desc(avatar_visuals.created_at))
  .limit(400);
```

The `WHERE` is scope only (`project_id = P OR project_id IS NULL`, plus an optional type). **Nothing
in the SQL knows what the viewer asked.** Relevance is applied in JavaScript at `:128-158`, to
whatever those 400 rows happen to be.

Three failures fall straight out of that ordering:

- **The `basic` preference silently stops working.** The comment at `:74-76` and `:143-153` promises
  "editor-curated items outrank avatar-generated items". That preference is applied *inside* the
  loop over the 400 rows. A project's `basic` rows are inserted once by `syncBasicLibrary` with
  `use_count = 0` (`libraryService.ts:351-369`). Global generated rows accumulate continuously and
  are newer. Once ~400 rows in scope outrank a project's basic rows on `(use_count DESC, created_at DESC)`,
  **the project's own curated media is not in the candidate set at all** and the ranking code never
  sees it.
- **Popularity lock-in.** Every hit calls `incrementUseCount` (`libraryService.ts:172-178`), so a row
  that once made the window climbs and stays. Rows created after the window fills start at
  `use_count = 0` and can only enter via the `created_at` tiebreak — briefly, until 400 newer rows
  push them out. The library converges on a fixed set of a few hundred visuals shown forever.
- **No index supports the query.** `028_avatar.sql:31-35` creates btree indexes on `project_id`,
  `visual_type`, `character_id`, `lookup_key`, `scope`. There is **none on `use_count`** and none
  composite. So every call is a scan of the in-scope rows plus a full sort, then 400 full rows
  (`select()` = every column, including the `visual_spec` jsonb) come back over the transaction
  pooler.

**At what scale does this break?** The candidate window fills at 400 in-scope rows. Generated rows are
written on essentially every image analysis (see §2.2 — the cache almost never hits), and
`/image/analyze` is rate-limited to 10/min/IP (`avatar.controller.ts:339`). So **~40 viewer-minutes of
conversation, platform-wide, is enough** to make a given project's `basic` library unreachable through
step 1c. That is inside the first hour of any real traffic. Curated media then only reaches the
viewer via the exact/ILIKE key match in 1a/1b, which keys on filenames (§2.4).

Cost side of the same line: 400 rows × ~0.4–1.5 KB (a stored `diagram` spec is the full
`buildMermaidHtml` output, ~950 bytes; an uploaded `simulation` spec is a whole HTML file,
`avatar.controller.ts:141-143`) ≈ **160 KB–600 KB per `/visual/analyze` call**, at up to 30 calls/min
per IP. On a 2-vCPU host talking to Supabase through the transaction pooler that is the dominant
byte cost of the whole feature.

### 2.2 BUG — the image cache is keyed on the PREVIOUS USER UTTERANCE while the cached image was generated from the AVATAR'S REPLY

This is the mechanism behind "a bad or irrelevant image shown to the viewer with no gate", and it is
exact.

`imageService.ts:91`:
```ts
const lookupKey = (conversationContext ?? userMessage).slice(0, 300);
```
`imageService.ts:186-193` stores the generated row under **that same `lookupKey`**.

Now look at what the client sends. `AvatarConversation.tsx:267-268` (persona turn) and `:150-151`
(auto-visual) call `triggerImage(snippet, ctx)` where `snippet` is **the avatar's reply**
(`content.slice(0, 400)`) and `ctx` is `lastUserMsgRef.current` — **the viewer's previous utterance**.
`avatarApi.ts:248-252` maps them to `userMessage` and `conversationContext` respectively.

So: the image is generated from the *avatar's reply*, and filed under a key that is the *user's
question*. Combined with `normalizeKey` (`libraryService.ts:18-25`, lowercase + strip punctuation) and
the `project_id IS NULL` global scope, the consequence is:

> A viewer says **"hi"**. The avatar replies with a 400-character greeting. The classifier sees the
> greeting, says `should_generate: true`, generates an image, and stores it globally under
> `lookup_key = 'hi'`. From then on, **every viewer on every video on the platform who says "hi"**
> gets that image returned at `imageService.ts:95-105` — a bank hit that **returns before the
> classifier runs at all**, so the `should_generate: false` gate for greetings and meta-questions is
> bypassed entirely.

`findVisual` orders by `use_count DESC` (`libraryService.ts:56`), so once a short common key like
`hi`, `yes`, `tell me more`, `what do you mean`, `can you explain that` acquires an image, it
accumulates uses and is locked in permanently. Short keys skip the ILIKE branch (`head.length >= 8`
guard at `:62`) but they exact-match perfectly, which is worse.

Two more defects in the same 60 lines:

- **The prompt-level dedup is dead code.** Step 2 (`imageService.ts:143`) looks up
  `lookupKey: c.dalle_prompt`, but nothing ever *writes* a row whose `lookup_key` is a DALL·E prompt
  — the prompt goes to its own `dalle_prompt` column (`:191`), which `findVisual` does not search. So
  step 2 is a guaranteed miss, an extra DB round-trip, and the intended "we already made this exact
  image" saving never happens. Identical prompts regenerate forever.
- **The step-0 cache almost never hits for long keys** (a 300-char conversation context is
  near-unique) and hits **too easily for short ones**. Both failure directions at once.

### 2.3 BUG — the "per-project Extended Library" fix was applied to the editor paths only; the runtime path is still global

`git show c1219ad` says, in its own words: *"the Extended (Avatar) Library was a GLOBAL pool —
generated visuals were saved with project_id=null and every project's library query used
includeGlobal:true, so a visual made in one project showed up in every other project."*

What that commit actually changed: `generateLibraryImage`, `generateLibrarySimulation`, and the two
list endpoints. What it did not change:

| Site | Still writes | Line |
|---|---|---|
| viewer image generation | `projectId: null` | `imageService.ts:187` |
| viewer sim generation | `projectId: null` | `visualService.ts:292` |
| `storeFast` (equation/chart/diagram) | `projectId: null` | `visualService.ts:361` |
| retrieval scope | `or(eq(project_id, P), isNull(project_id))` | `libraryService.ts:28-33` |

So the leak the commit describes is **still fully live on the path viewers actually exercise**. Worse,
because the two list endpoints now pass `includeGlobal: false` (`avatar.controller.ts:371`, `:463`),
the fix removed the *visibility* of the leak without removing the leak: **a project owner can no
longer see, edit or delete the global visuals their own avatar will show to their viewers.** Only a
platform admin can, via `/api/admin/v1/avatar/gallery` (`controllers/admin/v1/avatar.controller.ts:130-137`).

Concretely, what crosses the tenant boundary: `image_url` (a rendered image), `sim_entry_url` (a
full interactive HTML document loaded in an iframe), `caption` and `alt_text` — and the captions are
model-written summaries of *another customer's conversation about another customer's video*.

There is a second, smaller hole in the same area: `findManageableVisual`
(`avatar.controller.ts:447-451`) matches `or(project_id = thisProject, project_id IS NULL)`, so any
authenticated project owner can `PATCH` or `DELETE` **any global visual** by id — a cross-tenant
write. Exploitability is low (UUIDs), but the authorization predicate is simply wrong.

### 2.4 BUG — for editor media the entire retrieval signal is the raw filename, and one 4-letter token is enough to show it

`syncBasicLibrary` (`libraryService.ts:351-358`) inserts each project image as:
```ts
lookupKey: img.filename, caption: img.filename, altText: img.filename
```
`findRelevantLibraryVisual` then tokenises `caption + alt_text + lookup_key` (`:135`) — i.e. the
filename, three times — and for a `basic` row the qualifying bar is `overlap >= 1` (`:147-149`),
outranking every extended row (`rank = 0` at `:152`).

`tokenize` (`:95-101`) keeps any alphanumeric run of ≥4 chars that is not in the 60-word stopword
list or the 24-word type list. So `final_v3_edited.png` → `{final, edited}`. A viewer who says
*"so what's the final answer"* contributes the token `final`, overlap = 1, the row qualifies, rank 0
beats everything, and `final_v3_edited.png` is displayed full-bleed over the avatar with the caption
`final_v3_edited.png`.

This is not hypothetical — it is the *designed* behaviour for basic items, and the comment at
`:144-146` states the intent ("a single topic word is enough"). It is sound only if filenames are
topical. Nothing enforces or encourages that, and `AvatarImageOverlay.tsx:31` renders `caption`
verbatim to the viewer.

`findRelevantLibraryVisual` also **does not filter by `character_id`** (`:117`), while `findVisual`
does (`:48`). So the relevance path crosses characters and the exact path does not — an inconsistency
that means a Napoleon-generated visual can surface in a Darwin session but not vice-versa.

---

## 3. The generation fan-out — how often it fires, who decides, and what happens when it fails

### 3.1 The trigger graph (client)

Four independent call sites, all in `AvatarConversation.tsx`:

| # | Trigger | Line | Guard |
|---|---|---|---|
| 1 | `MESSAGE_STREAM_EVENT_RECEIVED`, `role === 'user'`, `endOfSpeech` | `:256-264` | first calls `resetVisual()` — which **zeroes `lastShownAt`**, disabling the 8 s throttle |
| 2 | `MESSAGE_STREAM_EVENT_RECEIVED`, `role === 'persona'`, `endOfSpeech` | `:265-269` | none of its own |
| 3 | `MESSAGE_HISTORY_UPDATED` → 1 s debounce | `:273-290` | dedupes on exact content equality |
| 4 | `setInterval(2 500)` auto-visual | `:133-155` | fires once per distinct persona message, ≥10 s since last shown |

Each of the four may be followed by an `/image/analyze` call when `analyzeVisual` returns
`type: 'none'` or `type: 'image'` (`useVisualTrigger.ts:101-104` → `fallback_image_allowed`).

So **2 to 4 `/visual/analyze` calls per conversational turn**, plus up to 1 `/image/analyze` per 5 s
(`useImageTrigger.ts:49`).

### 3.2 BUG — the visual throttle is disarmed exactly when the conversation is boring

`useVisualTrigger.ts:76` throttles on `lastShownAt`, and `lastShownAt` is only updated when a visual
was **actually shown** (`:110`, `:115`). When the classifier returns `none` — which is the common case
for greetings, opinions and meta-questions, by the prompt's own instruction at
`visualService.ts:57` — the throttle never arms. Combined with `resetVisual()` at
`AvatarConversation.tsx:260` zeroing it on every user turn, a conversation in which nothing is
visualisable makes the **maximum** number of classifier calls, not the minimum.

### 3.3 LIMIT — the client's own fan-out exceeds the server's own rate limit

`/image/analyze` is capped at **10 requests / 60 s / IP** (`avatar.controller.ts:339`), fixed-window,
in-process (`lib/rateLimit.ts:11-21`), keyed on the real client IP (`trustProxy: 1`,
`config/trustProxy.ts:28`). The client's image trigger permits **one per 5 s = 12/min**
(`useImageTrigger.ts:49`).

So a single engaged viewer whose conversation keeps falling through to the image path starts getting
`429`s roughly 50 seconds in. `avatarApi.ts:252` swallows the failure into
`{shouldGenerate:false}`, so images simply stop appearing with no message and no log. Behind a NAT
(school, office, one household) the whole building shares the bucket.

### 3.4 BUG — chart data is invented by the model and rendered with no validation whatsoever

`visualService.ts:316-328`:
```ts
labels:   (classification.labels   as string[])    ?? [],
datasets: (classification.datasets as ChartDataset[]) ?? [],
...
if (!result.labels.length) return BLANK;
```
That `labels.length` check is the **only** validation. Nothing checks that `datasets[].data` is an
array, that it contains numbers, that its length matches `labels.length`, or — the important one —
that the numbers came from anywhere. `ChartRenderer.tsx:41` passes the object straight into Chart.js
with a `as unknown as` cast.

The classify prompt asks for `"chart" — comparing numbers (with actual numbers)`
(`visualService.ts:53`) and supplies a colour palette, but supplies **no source**: the transcript is
not in the classifier's context (the classifier sees only `message`, `context` and `characterId`,
`:227`). The numbers are therefore hallucinated by construction, rendered as an authoritative bar
chart with a one-to-two-sentence caption in present tense, over an avatar impersonating a named
historical scientist, on an educational platform. Then `storeFast` (`:326`) publishes it to the
**global** library for reuse on other customers' videos.

The same applies more weakly to equations: `EquationRenderer.tsx:13` renders with
`throwOnError: false`, so a malformed or simply wrong LaTeX formula renders as authoritative output
rather than being suppressed.

### 3.5 The gates that exist, and the ones that do not

| Question | Answer | Evidence |
|---|---|---|
| Is the *type* decision deterministic? | Partly. A regex pass decides "explicit intent" first (`visualIntent.ts:30-52`), then a model decides the rest (`visualService.ts:220`). | — |
| Is the *whether to generate* decision deterministic? | No — model-judged, by a prompt that says "Show a visual for almost every substantive topic" (`imageService.ts:53`) and "image — USE BY DEFAULT" (`visualService.ts:52`). | — |
| Is there a relevance gate before showing a generated image? | **No.** `useImageTrigger.ts:57` shows whatever came back. The only gate is `isVisualShowing()`. | — |
| Is there a relevance gate before showing a *cached* image? | **No**, and the cached path skips the classifier entirely (`imageService.ts:95-105`). | §2.2 |
| Is there a content-safety gate on the generated image? | **No** app-side gate. Only OpenAI's own refusals. | §5.2 |
| Bound on generations per question? | Yes, weak: ≤1 image / 5 s / client, ≤10/min/IP server. **No per-project, per-session, per-day or per-account bound at all.** | `useImageTrigger.ts:49`, `avatar.controller.ts:339` |
| Failure mode when generation fails? | Silent everywhere: `return BLANK` (`imageService.ts:168`, `:171`, `:215`), `catch {}` in the client (`useImageTrigger.ts:67`). Viewer sees nothing, no message, no retry. | — |
| Failure mode when generation is slow? | The 5 s/8 s throttles are wall-clock; a slow generation holds `inFlightRef` and simply drops subsequent triggers. A `simulation` generation is `max_tokens: 6000` on `gpt-4.1` (`visualService.ts:264`) — tens of seconds — and the client's staleness window allows it 2 generations of drift (`useVisualTrigger.ts:95`), so a simulation can surface long after the topic moved on. | — |

### 3.6 COST — the real number

`gpt-image-1` at `low` = 2 ¢, at `high` = 25 ¢ (`services/llm/systemAi.ts:154-156`). Every viewer
image generation runs **both**: `low` returned to the viewer (`imageService.ts:158`) and a `high`
background upgrade fired at `setTimeout(..., 0)` (`:199-209`). **27 ¢ per generated image.**

- At the server cap of 10/min/IP: **$2.70 per minute per IP**, uncapped in duration.
- One 10-minute engaged session: ~100 images ≈ **$27 for one anonymous viewer**.
- The upgrade the viewer never sees is 25 ¢ of the 27 ¢, and pays off only on a future cache hit —
  which §2.2 shows is rare for long keys and wrong for short ones.
- The low-quality object is never deleted when the row is repointed at the high one
  (`imageService.ts:205` updates `image_url`/`image_key` only), so every generation orphans a
  1536×1024 PNG in R2 forever.
- An image the client then discards because a visual is showing (`useImageTrigger.ts:58`) has already
  been paid for, twice.

**None of this is attributable or capped.** `recordImageUsage` is called with `userId: null`
(`imageService.ts:159`, `:165`, `:202`) — the comment at `imageService.ts:127` says "viewer sessions
are anonymous" — and the rolling-24 h generation cap in `assertGenerationAllowed`
(`systemAi.ts:72-90`) keys on `user_id`, so a NULL user is never capped. `analyzeAndGenerateImage`
does not call `assertGenerationAllowed` at all; it checks only `isGenerationPaused()`
(`imageService.ts:87`), which is the global kill switch.

Classifier cost, measured from source: `CLASSIFY_PROMPT` = 2 148 chars ≈ 537 tokens
(`visualService.ts:38-68`), image `SYSTEM_PROMPT` = 1 603 chars ≈ 400 tokens
(`imageService.ts:53-71`), sim prompt = 1 797 chars ≈ 449 tokens. At 2–4 classify calls per turn on
`gpt-4.1-mini` this is small change next to the images — roughly 0.005 ¢/call — but it is 2–4 extra
network round-trips and 3 extra Postgres queries per turn, on a 2-vCPU box.

### 3.7 LIMIT — `isGenerationPaused()` is an uncached DB round-trip on every analyze call

`systemAi.ts:94-97` does `db.query.admin_settings.findFirst()` per call, no cache. At 30
`/visual/analyze` + 10 `/image/analyze` per minute per viewer that is 40 extra pooled connections'
worth of round-trips per viewer-minute for a row that changes maybe monthly.

---

## 4. Conversation memory

### 4.1 Keying — checked carefully; no cross-viewer leak by construction

`useConversationMemory.ts:24`: `sessionKey = \`${anonId()}:${projectId ?? 'global'}:${characterId}\``
where `anonId()` (`:8-18`) is a `crypto.randomUUID()` persisted in `localStorage` under
`avatar_anon_id`. Storage is `avatar_conversations.session_key` / `avatar_profiles.session_key`
(`db/schema.ts:862-877`), both keyed on that string alone.

Verdict: **no leak between viewers** — the key contains 122 bits of entropy that never leaves the
browser except in the request. Two same-browser viewers of the same project *do* share memory (one
family laptop = one avatar memory), which is a product decision, not a bug.

Two residual observations:

- **LIMIT** — `sessionKey` travels in the **query string** of `GET /api/v1/avatar/memory`
  (`avatarApi.ts:259`), so it is written verbatim into nginx access logs. Anyone with log access can
  replay it and read that viewer's turns and extracted facts. The POST correctly requires an HMAC
  capability token (`memoryToken.ts`), but the GET requires only the key it is about to mint a token
  for.
- **BUG (privacy)** — `extractAndSaveFacts` (`memoryService.ts:50-84`) asks `gpt-4.1-nano` to
  extract *"durable personal facts about the user (name, interests, profession, goals,
  preferences)"* from **anonymous viewers**, merges them into `avatar_profiles.facts` with
  `{...existing, ...facts}` (`:76`) and no size bound, no key bound and no TTL. Nothing in the repo
  ever deletes an `avatar_profiles` row: the only writers are `memoryService.ts:78-80` and the only
  other references are counts in the admin controller (`controllers/admin/v1/avatar.controller.ts:58`).
  `ProjectDuplicationService.ts:683` even records the fact that the table has no `project_id`, so a
  project deletion cascades `avatar_conversations` away but leaves the extracted personal facts
  behind forever.

### 4.2 BUG — the remembered conversation is replayed to the avatar in ARBITRARY ORDER

`saveTurns` (`memoryService.ts:29-48`) deletes the whole window and re-inserts it in **one**
`INSERT`:

```ts
await db.delete(avatar_conversations).where(eq(session_key, sessionKey));
await db.insert(avatar_conversations).values(recent.map(...));
```

`created_at` defaults to `now()` (`028_avatar.sql:44`), and Postgres `now()` is
*transaction* timestamp — **identical for all rows of one INSERT**. `getTurns` (`:14-22`) then does
`ORDER BY created_at DESC LIMIT 20` with no tiebreak column, so all 20 rows tie and the order is
whatever the executor returns. `.reverse()` on an arbitrary order is still arbitrary.

The result is injected into the live session as
`"Recent conversation:\nVisitor: … You: … "` (`memoryService.ts:95`, and again client-side at
`useConversationMemory.ts:39`), and `slice(-6)` picks an arbitrary six of the twenty. So the avatar's
memory of the previous session is a **shuffled** transcript in which the viewer's questions and its
own answers are interleaved in the wrong order. There is no `sequence` column and no `id`-based
tiebreak to fix it with.

### 4.3 BUG/COST — `POST /api/v1/avatar/memory` is the one unauthenticated avatar endpoint with no rate limit

`avatar.controller.ts:416` — no `preHandler`, and unlike `/visual/analyze` (`:318`) and
`/image/analyze` (`:339`) it calls no `rateLimit(...)`. Each accepted POST runs a `gpt-4.1-nano`
completion (`memoryService.ts:56`) plus a DELETE + 20-row INSERT. The capability token is minted
freely by the GET for *any* `sessionKey` on any public/unlisted project (`:394-413`), so obtaining one
is not a barrier.

Also `MemorySchema.turns[].content` is `z.string()` with **no `.max()`** (`:391`), while every other
field in that schema is bounded. The only backstop is Fastify's body limit.

---

## 5. Moderation — the earlier finding is STILL TRUE. This is a live P1.

### 5.1 The prompt asks for `flagged`, the validator reads `allowed`, and both halves succeed

Three files, verified on this branch:

1. **The prompt actually used in production**, seeded by migration 001 and never overwritten:
   `db/migrations/001_initial.sql:199` —
   > `'You are a content moderation system. … Respond with JSON: {"flagged": boolean, "reason": string | null}'`

2. **The loader prefers that row over the built-in prompt.** `ContentModerationService.ts:49-52`:
   ```ts
   const row = await db.query.system_prompts.findFirst({ where: eq(system_prompts.key, 'content_moderation') });
   const systemPrompt = row?.content?.trim() || DEFAULT_MODERATION_PROMPT;
   ```
   The row exists in every database that ran migration 001. Nothing re-seeds it: grepping
   `content_moderation` across `db/`, `scripts/`, `services/` and `controllers/` returns only this
   migration, this service and the task-name constants in `LLMService.ts` / `LLMProvider.ts`. So
   `DEFAULT_MODERATION_PROMPT` (`:28-33`, the one that asks for `allowed`) is **dead code in
   production**.

3. **The validator accepts the wrong schema without complaint.** `ContentModerationService.ts:18-21`:
   ```ts
   const VerdictSchema = z.object({ allowed: z.boolean().optional(), reason: z.string().optional() });
   ```
   Both fields are `.optional()`, so `{"flagged": true, "reason": "hate speech"}` **parses
   successfully** — `parsed.success === true`, `verdict = { reason: 'hate speech' }`, `allowed === undefined`.
   The rejection test at `:76` is `if (verdict && verdict.allowed === false)`, which is `false`.

**Therefore: `moderateGenerationInput` returns silently for 100 % of inputs, including inputs the
model explicitly flagged.** It does not even take the "malformed verdict → fail open" branch at
`:66`, which would at least be visible; it takes the *success* branch and then decides the content is
fine. The only log line emitted is nothing at all.

Blast radius — every caller believes it is screened: `projects.controller.ts:268`, `:327`;
`broll.controller.ts:70`; `podcast-script.controller.ts:135`; `playlists.controller.ts:416`.

**Why nobody noticed:** `services/llm/__tests__/contentModeration.test.ts:49` sets
`mocks.findFirst.mockResolvedValue(undefined)` in `beforeEach`, with the comment *"Default: no admin
override → the service uses its built-in prompt."* Every one of the five tests therefore exercises the
`allowed`-shaped prompt that production never uses. The one configuration that exists in production —
a `content_moderation` row present, asking for `flagged` — has no test. The suite is green and the
feature is inert.

Minimal fix has two halves and needs both: (a) make `VerdictSchema` accept `flagged` as well and
require *some* recognised verdict field, treating an unrecognised shape as a loud failure rather than
a pass; and (b) re-seed / migrate the `content_moderation` row to the `allowed` schema. Doing only
(b) leaves any operator who edited the prompt through
`controllers/admin/v1/system-prompts.controller.ts:29-36` back in the same hole.

### 5.2 BUG — no avatar path calls moderation at all

Independent of §5.1: grep `moderateGenerationInput` across `controllers/` and `services/avatar/`.
It is called from `projects`, `broll`, `podcast-script` and `playlists`. It is **not** called from
`avatar.controller.ts`, `visualService.ts` or `imageService.ts`.

So the highest-risk surface in the product — a **completely unauthenticated** endpoint
(`avatar.controller.ts:333`, no `preHandler`) that takes 4 000 characters of viewer-supplied text and
pipes it through a prompt-builder into `gpt-image-1` — is the one surface with no pre-screen. The
resulting image is then stored **globally** (§2.3) and can be served to viewers on other customers'
videos. The only safety is OpenAI's own refusal behaviour, which is not a policy this product
controls or logs.

---

## 6. Access control on the two analyze endpoints (quality-adjacent, but it is a hole)

`app.post('/api/v1/avatar/visual/analyze', ...)` (`avatar.controller.ts:314`) and
`app.post('/api/v1/avatar/image/analyze', ...)` (`:333`) have **no `preHandler`** and perform **no
project visibility check**. Both take `projectId` from the body and pass it straight into
`syncBasicLibrary` (`:322`, `:344`) and into the library scope of `findVisual` /
`findRelevantLibraryVisual`.

Every other avatar endpoint that touches a project gates it: `/avatar/start` (`:190`),
`/avatar/projects/:id/library` (`:361-366`, comment "review security-004"), `/avatar/memory`
(`:399-405`). These two were missed.

Consequence: an anonymous caller who knows a **private** project's UUID can (a) read its `basic`
library — the project's own images and simulation URLs — by sending a message whose tokens overlap a
filename, and (b) force a `syncBasicLibrary` write/delete pass on it. UUID guessing is not feasible,
but project ids appear in editor URLs, share links and support tickets. Label: **BUG**, low
exploitability, wrong-by-construction authorization.

---

## 7. Smaller true things, for completeness

- **BUG** — `buildBankResult` returns a stored `simulation` row as `{ type:'simulation', html:'', simulationUrl }`
  (`visualService.ts:135`). `SimulationOverlay.tsx:99` then chooses
  `sandbox="allow-scripts allow-same-origin"` for the `src` case vs `allow-scripts` for the `srcDoc`
  case. A globally-stored, model-generated simulation therefore runs **with same-origin privileges**
  against the sim-serving origin, while a freshly generated one does not. Same content, two
  different sandboxes, and the more-trusted one is the one that came from another tenant.
- **BUG** — `buildMermaidHtml` (`visualService.ts:70-81`) interpolates model output into HTML
  unescaped (`<div class="mermaid">${mermaidCode}</div>`) and loads
  `https://cdn.jsdelivr.net/npm/mermaid@10/…`. The frame is `sandbox="allow-scripts"` with an opaque
  origin (`DiagramRenderer.tsx:26`), so the blast radius is contained — but the CSP permits it
  (`script-src … https:`, `shared/src/csp.ts:109`), the diagram is stored globally, and the parent's
  `message` listener has **no origin check** (`VisualPanel.tsx:25-31`).
- **BUG** — `visualService.ts:400-402` carries the comment *"Library-generated sims are scoped to the
  project that created them"* directly above `storeSimulationHtml(html, null)`. The **row** is
  project-scoped; the **storage object** is not. Same in `imageService.ts:256-258`. Harmless today
  (the prefix is opaque) but the comment asserts something the line below it does not do.
- **LIMIT** — `syncBasicLibrary`'s throttle is a module-level `Map` (`libraryService.ts:320-325`), so
  it is per-process. It also *deletes* orphaned basic rows (`:371-375`); two instances racing the
  same project could interleave insert and delete passes.
- **COST** — `findVisual`'s loose branch is `lookup_key ILIKE '%head%'` (`libraryService.ts:66`). A
  leading wildcard cannot use `idx_avatar_visuals_lookup`, so each is a sequential scan. `analyzeVisual`
  can run three of them per call (1a, 1b, plus `isDuplicateVisual` on store).
- **LIMIT** — `avatar_visuals`, `avatar_conversations` and `avatar_profiles` have **no retention job,
  no TTL and no pruning** anywhere in `scripts/` or `services/`. The global library is the fastest
  grower and the one every retrieval query scans.
- Not a defect, but worth recording: `detectVisualIntent` (`visualIntent.ts:30-52`) is genuinely good
  — pure, synchronous, deterministic, zero-latency, and it correctly takes priority over the model.
  The problem is everything downstream of it, not it.

---

## 8. What I could not determine from the repo

| Question | Measurement that settles it |
|---|---|
| How many videos exceed the 24 000-char inline cap? | The `percentile_disc` query in §1.2. |
| How many projects have >1 captioned non-broll video (does §1.3 fire in production)? | The `HAVING count(*) > 1` query in §1.3. |
| How large is the global library today, and how much of it is `use_count = 0`? | `SELECT count(*), count(*) FILTER (WHERE use_count = 0) FROM avatar_visuals WHERE project_id IS NULL;` — and `SELECT min(use_count) FROM (SELECT use_count FROM avatar_visuals WHERE project_id IS NULL ORDER BY use_count DESC, created_at DESC LIMIT 400) s;` gives the exact cut-off described in §2.1. |
| What fraction of `/image/analyze` calls hit the bank vs. generate? | No counter exists. `avatar_visuals` row-creation rate is a proxy: `SELECT date_trunc('hour', created_at), count(*) FROM avatar_visuals WHERE source='generated' GROUP BY 1 ORDER BY 1 DESC LIMIT 48;` |
| Actual avatar image spend | `SELECT sum(cost_cents)/100.0, count(*) FROM token_usage WHERE task = 'avatar_image' AND occurred_at > now() - interval '30 days';` (attribution is `user_id IS NULL` by design, so this is the only view of it). |
| Does Anam cache the ~21 k-token system prompt across turns? | One Anam invoice line for a session of known length; the repo records nothing. |
| Does Anam's knowledge tool actually get invoked, and how does it rank? | Vendor-side. A session log with tool-call visibility, or a controlled question about material present only in the 24 k–200 k window of a long transcript. |
| Whether the mermaid CDN load actually succeeds inside the sandboxed frame | Open a diagram visual in a real browser and check the console/network. Static reading says the CSP permits it. |

---

## 9. DILEMMAS — for the reviewer, deliberately unresolved

### D1. Should the extended visual library be global at all?

**Problem.** Every visual a viewer's conversation generates is written with `project_id = NULL`
(`imageService.ts:187`, `visualService.ts:292`, `:361`) and every project's retrieval reads
`project_id = P OR project_id IS NULL` (`libraryService.ts:28-33`). Commit `c1219ad` set out to end
exactly this and only changed the editor paths and the list endpoints, so the leak is live on the
viewer path and now invisible to owners.

**Verified.** The four write sites and the one scope predicate above; `includeGlobal: false` at
`avatar.controller.ts:371` and `:463`; the admin gallery is the only surface that can see or delete a
global row (`controllers/admin/v1/avatar.controller.ts:88-137`); `findManageableVisual`
(`avatar.controller.ts:447-451`) lets any project owner delete any global row.

**Options.**
- *(a) Make it per-project, matching the commit's stated intent.* Every write takes the caller's
  `projectId`; `projectScope` drops the `isNull` branch. Cache hit-rate falls to near zero at first
  (each project rebuilds its own library), so image spend rises before it falls. Owners regain full
  visibility and a delete button. Existing global rows become orphans needing a backfill decision.
- *(b) Keep it global but make it a curated, admin-owned pool.* Viewer-generated rows land
  project-scoped; an admin promotes good ones to global. Retrieval keeps the global branch. Requires
  an admin workflow that does not exist and a reviewer for it.
- *(c) Keep it global but scope by tenant/org rather than project.* `avatar_visuals` has no `org_id`
  column; `projects` does. Reuse within one customer's catalogue is the case that actually makes
  sense (a series of lessons on the same subject), and it is the case (a) would break.
- *(d) Leave it and accept cross-tenant reuse as a feature.* Defensible only if captions are
  scrubbed of source-video content, which they are not — captions are model summaries of another
  customer's conversation.

**Lean.** (c), with (a) as the fallback if `org_id` is too invasive. (c) preserves the only reuse
that has a real quality argument, removes the tenant boundary violation, and keeps the cache warm
inside a customer's own catalogue. It needs a migration (`avatar_visuals.org_id`, backfilled from
`projects.org_id`, NULL for legacy globals) and a decision about the legacy rows.

**Evidence that would decide it.** (1) The bank hit-rate: if global reuse is already near zero
(likely, given §2.2), the "we lose the cache" objection to (a) evaporates and (a) is simply correct.
Measure with the `avatar_visuals` creation-rate query in §8 against `/image/analyze` request volume.
(2) A read of ~50 random global captions: if they name another customer's subject matter, this stops
being an architecture question and becomes a contractual one.

### D2. Does an ungrounded chart belong in this product at all?

**Problem.** §3.4 — chart numbers are invented by a model that has never seen the transcript, are
validated only for `labels.length > 0`, and are rendered as an authoritative bar chart under a
historical scientist's name, then stored globally.

**Verified.** `visualService.ts:316-328` (the whole validation), `:227` (the classifier's context
contains no transcript), `ChartRenderer.tsx:41` (`as unknown as` straight into Chart.js), `:326`
(global store).

**Options.**
- *(a) Remove `chart` from the classifier's type list.* One line in `CLASSIFY_PROMPT`. Loses a
  feature; loses nothing true.
- *(b) Ground it.* Only allow `chart` when numbers can be extracted from the transcript window, and
  pass that window to the classifier. Real work, and the transcript is not currently in the
  classifier's context at all.
- *(c) Keep it, label it.* Render an explicit "illustrative figures, not data from this video"
  affordance on every chart, and never store charts globally. Cheap; relies on viewers reading a
  label under an image that appears for 14 seconds.
- *(d) Keep it and validate the shape only* (`datasets[].data.length === labels.length`, all finite
  numbers). Fixes malformed charts, does nothing about false ones.

**Lean.** (a) now, (b) later if charts are wanted back. The failure mode of (c) is that a viewer
remembers the number and not the disclaimer, and this is a teaching product. But this is squarely a
product decision about what the feature is for, and I should not make it.

**Evidence that would decide it.** How often `chart` is actually chosen: `SELECT count(*) FROM
avatar_visuals WHERE visual_type = 'chart';` against the other types. If it is under a few percent,
(a) costs nothing. If charts are a headline demo feature, (b) is the only honest option.

### D3. What is the right shape for transcript context — flat, chunked, or playhead-scoped?

**Problem.** §1.2 and §1.4. Today: flat, head-truncated at 24 000 chars, timestamps destroyed before
the avatar sees them, and no notion of where the viewer is.

**Verified.** `personaBake.ts:38-48`; `transcript.ts:16` (timing lines dropped); no `currentTime`
anywhere in `client-web/components/avatar/**`; the persona is baked once per transcript revision
(`personaFingerprint.ts:66-85`), so anything playhead-dependent cannot live in the persona.

**Options.**
- *(a) Just raise the cap.* One constant. Costs input tokens on every turn (§1.5) and does not solve
  a 2-hour video. Zero architectural change.
- *(b) Summarise the tail.* Keep the 24 k head verbatim, append an LLM-generated outline of the
  remainder. Bounded prompt, avatar stops claiming ignorance of the ending. One extra background
  generation per transcript revision, cached by `transcriptHash`.
- *(c) Chunk + retrieve app-side.* Real chunking with timestamps and an app-owned index. Best
  answers, most work, and it duplicates what Anam's knowledge tool is already supposed to do — with
  the advantage that this repo could actually see and tune the ranking.
- *(d) Playhead-scoped context injection.* Keep the persona as-is; have the client send
  `video.currentTime` and inject a ±N-minute window through the SDK's `addContext` — the same
  mechanism memory already uses (`useConversationMemory.ts:54`). This is the smallest change that
  gets "where the viewer is" into the model, and it composes with (a), (b) or (c).

**Lean.** (d) + (b). (d) is genuinely cheap — the plumbing exists, `addContext` is already called
once per session — and it addresses the ceiling described in §1.4 without touching the persona
fingerprint. (b) closes the truncation lie for long videos at one background generation per
revision. (c) only becomes worth it if measurement shows Anam's knowledge tool is not retrieving
well, which the repo cannot tell.

**Evidence that would decide it.** (1) The transcript-length distribution (§1.2) — if p95 is under
24 000 chars, (a) alone is enough and (b) is premature. (2) A controlled probe: ask a live avatar
about material that exists only after character 24 000 of a long transcript. If it answers, Anam's
RAG is working and this is a smaller problem than it looks; if it says the video does not cover it,
the RAG channel is not doing its job and (c) moves up the list.

### D4. Should moderation fail open, once it is fixed?

**Problem.** §5.1 fixes *whether the verdict is read*. It does not answer what should happen when the
screen itself fails — timeout, provider down, unparseable output. Today every one of those is a
silent pass (`ContentModerationService.ts:68-74`), which is deliberate and documented at `:1-4`.

**Verified.** The fail-open branches at `:66` and `:73`; the 20-second timeout at `:60`; that the
screen runs on the cheap "utility" tier and is exempt from both the pause switch and the quota
(`LLMService.ts:124`, `:141`).

**Options.**
- *(a) Keep fail-open everywhere.* An OpenAI outage never blocks a paying customer's generation.
  Also means a targeted outage is a bypass.
- *(b) Fail closed on the unauthenticated, viewer-facing paths (the avatar, once §5.2 is fixed);
  fail open on the authenticated editor paths.* The asymmetry matches the risk: an anonymous viewer
  driving an image model is the exposure; an authenticated customer generating their own podcast
  script is not.
- *(c) Fail closed everywhere, with a short timeout and a visible operator alarm.* Safest and most
  disruptive.
- *(d) Fail open but make it loud* — a metric and an alert on the fail-open rate, so a silent
  permanent bypass (which is what §5.1 is) can never happen again unnoticed.

**Lean.** (b) + (d). (d) is non-negotiable regardless of the rest: the reason §5.1 survived this long
is that a 100 % bypass produced no signal whatsoever.

**Evidence that would decide it.** The real failure rate of the utility tier — `SELECT count(*)
FROM token_usage WHERE task = 'content_moderation'` against the number of calls the four call sites
should have produced. If failures are rare, (c) costs nothing and (b) is a needless distinction.

### D5. Should the visual triggers fire on the avatar's speech at all, or only on the viewer's question?

**Problem.** §3.1: three of the four trigger sites fire on the *avatar's* output (`:265`, `:273`,
`:133`), only one on the viewer's (`:256`). That is what makes the classifier see a 400-char snippet
of the avatar talking, which is what makes the image "about" the reply while the cache key is the
question (§2.2), and it is what multiplies the per-turn call count by 2–4×.

**Verified.** The four call sites; the throttle disarm at `:260` + `useVisualTrigger.ts:60`, `:76`; the key
mismatch at `imageService.ts:91` vs. `AvatarConversation.tsx:267`.

**Options.**
- *(a) Trigger only on the viewer's utterance.* Cuts calls per turn to 1, makes message and key the
  same string, and fixes §2.2's key mismatch as a side effect. Loses the "avatar mentions the
  Galápagos → a Galápagos image appears mid-sentence" effect, which is plausibly the most impressive
  thing the feature does.
- *(b) Keep persona-driven triggers but fix the key* — file the row under the text the image was
  generated from, not the previous question. One line. Kills the "hi" pathology; does not reduce the
  call count.
- *(c) Keep both, arm the throttle on every attempt* rather than only on success
  (`useVisualTrigger.ts:110`, `:115`) and stop `resetVisual()` zeroing it at `:60`. Bounds the fan-out
  without removing the effect.
- *(d) One visual per turn, chosen after the avatar finishes speaking*, using the question and the
  full reply together — one call, best context, slightly later.

**Lean.** (b) + (c) as the immediate fix — both are small, both are strictly improvements, and
neither removes a feature. (d) is the better end state and is a real redesign. (a) I would not
choose: it trades away the demo value for a problem that (b) solves directly.

**Evidence that would decide it.** Whether persona-triggered visuals are the ones viewers actually
see. `use_count` distribution split by which path stored the row would show it, but the schema does
not record the trigger path — adding that column is itself the measurement.
