# ElevenLabs Dubbing v2 — Implementation Brief for the FlowVid Fastify/TypeScript Backend

**Researched:** 2026-08-20
**Audience:** the engineer who will write `DubbingService.ts`. Follow this literally; every claim is tagged VERIFIED (with source) or UNVERIFIED.

**Primary source of truth for all endpoint shapes below:** the *live* production OpenAPI document, fetched during this research:

```
curl -s https://api.elevenlabs.io/openapi.json      # HTTP 200, 2,073,429 bytes, fetched 2026-08-20
```

Where this brief and the prose docs disagree, the OpenAPI document wins — it is generated from the running service. Re-fetch it before you start coding; ElevenLabs ships endpoints faster than it ships docs pages.

---

## 0. Fact-check of the product owner's assumptions

| PO claim | Verdict | Detail |
|---|---|---|
| Dubbing v2 reached the public API on 2026-08-06 | **VERIFIED, with nuance** | The launch blog post is dated **August 6, 2026**. The model itself launched **May 28, 2026** but only inside the UI products; API access came on Aug 6. The *changelog entry documenting the new endpoints* is dated **August 10, 2026**. So: model May 28, API Aug 6, endpoint docs Aug 10. Sources: [blog/dubbing-api](https://elevenlabs.io/blog/dubbing-api), [changelog/2026/8/10](https://elevenlabs.io/docs/changelog/2026/8/10) |
| 90+ target languages | **VERIFIED** | Marketing and docs both say "90+". The Dubbing v2 help-center language table appears to enumerate **111** languages. Treat "90+" as the safe public number; the exact 111 count is **UNVERIFIED** (read off a summarised fetch of the table, not counted row by row). Source: [dubbing-api](https://elevenlabs.io/dubbing-api), [which-languages-are-supported-in-dubbing-v-2](https://elevenlabs.io/docs/help-center/product/content-production/dubbing/which-languages-are-supported-in-dubbing-v-2) |
| Preserves source pacing, tone, emotion, delivery | **VERIFIED** | "It translates audio and video into more than 90 languages while preserving each speaker's voice, tone and pacing." The model conditions on the source *audio* rather than routing through text, which is why prosody survives. Source: [changelog/2026/8/10](https://elevenlabs.io/docs/changelog/2026/8/10) |
| Sync-aware audio timing | **VERIFIED** | "Sync-aware translation logic means that starts and stops align with the original out of the box." Source: [blog/dubbing-api](https://elevenlabs.io/blog/dubbing-api) |
| **NO lip-sync; video frames are not altered** | **VERIFIED** | ElevenLabs does not offer lip-sync as part of Dubbing. Lip sync is available separately in Image & Video, Flows, and Studio via third-party models. Dubbing replaces the audio and does not change the video frames — so a talking head keeps mouth shapes from the source language. Source: [help center — Do you offer lip sync in Dubbing?](https://help.elevenlabs.io/hc/en-us/articles/23793433149073-Do-you-offer-lip-sync-in-Dubbing) (the article itself 403s to automated fetchers; content confirmed via search-result extraction — **the underlying page was not read directly**, so treat the exact wording as UNVERIFIED while the substance is VERIFIED and corroborated by the product page, which uses "sync-aware" and never "lip sync") |

**Net: the PO's three facts are all correct.** The only correction is a nuance on the date — Aug 6 is API GA, but the model predates it by ten weeks, and you will find May-dated material describing v2 that does *not* apply to the API.

---

## 1. Endpoints and lifecycle

### 1.1 There are TWO dubbing API surfaces. Choose deliberately.

This is the single most important architectural fact in this brief, and it is easy to miss because both live under `/v1/dubbing`.

| | **A. Classic dubbing** | **B. Dubbing v2 "project" API** |
|---|---|---|
| Create | `POST /v1/dubbing` | `POST /v1/dubbing/project` |
| Shape | one call does everything | project → language targets |
| Content type | `multipart/form-data` | `multipart/form-data` |
| Model selector | **none** | `model_id: dubbing_v1 \| dubbing_v2` |
| Webhooks | **none** | `webhook_ids[]` |
| Output | **MP3 *or* MP4** (muxed video!) | **lossless audio only** |
| Subtitles | **SRT / WebVTT / JSON** | **JSON segments only** |
| Editing | via `/v1/dubbing/resource/...` | segment-level PATCH (enterprise) |

**VERIFIED (OpenAPI)** — both surfaces exist concurrently; 30 dubbing paths total.

The trap: **surface B (the "v2" one) does not return a dubbed video, and does not return SRT/VTT.** Surface A does both. See §1.5 and §2.

### 1.2 Full endpoint inventory — VERIFIED (OpenAPI, 2026-08-20)

```
Classic surface
  POST   /v1/dubbing                                                  create (multipart)
  GET    /v1/dubbing                                                  list dubs (cursor paged)
  GET    /v1/dubbing/{dubbing_id}                                     status / metadata
  DELETE /v1/dubbing/{dubbing_id}                                     delete
  GET    /v1/dubbing/{dubbing_id}/audio/{language_code}               download MP3 or MP4
  GET    /v1/dubbing/{dubbing_id}/transcript/{language_code}          DEPRECATED
  GET    /v1/dubbing/{dubbing_id}/transcripts/{language_code}/format/{format_type}
                                                                      srt | webvtt | json   <-- captions
Dubbing v2 project surface
  POST   /v1/dubbing/project                                          create project
  GET    /v1/dubbing/project                                          list projects
  GET    /v1/dubbing/project/{project_id}                             project status
  DELETE /v1/dubbing/project/{project_id}                             delete project
  POST   /v1/dubbing/project/{project_id}/language                    add language target
  GET    /v1/dubbing/project/{project_id}/language                    list language targets
  GET    /v1/dubbing/project/{project_id}/language/{language_id}      language status + outputs
  DELETE /v1/dubbing/project/{project_id}/language/{language_id}      delete language target
  GET    /v1/dubbing/project/{project_id}/transcript                  source transcript (JSON)
  POST   /v1/dubbing/project/{project_id}/transcript/segment          add source segment
  PATCH  /v1/dubbing/project/{project_id}/transcript/segment/{segment_id}
  DELETE /v1/dubbing/project/{project_id}/transcript/segment/{segment_id}
  PATCH  /v1/dubbing/project/{project_id}/transcript/segments         bulk source edit
  GET    /v1/dubbing/project/{project_id}/language/{language_id}/transcript      target transcript (JSON)
  PATCH  /v1/dubbing/project/{project_id}/language/{language_id}/transcript/segment/{segment_id}
  PATCH  /v1/dubbing/project/{project_id}/language/{language_id}/transcript/segments
  POST   /v1/dubbing/project/{project_id}/language/{language_id}/transcript/regenerate
Dubbing Studio "resource" surface (only when dubbing_studio=true)
  GET    /v1/dubbing/resource/{dubbing_id}
  POST   /v1/dubbing/resource/{dubbing_id}/dub
  POST   /v1/dubbing/resource/{dubbing_id}/language
  POST   /v1/dubbing/resource/{dubbing_id}/render/{language}          mp4|aac|mp3|wav|aaf|zip...
  POST   /v1/dubbing/resource/{dubbing_id}/transcribe
  POST   /v1/dubbing/resource/{dubbing_id}/translate
  POST   /v1/dubbing/resource/{dubbing_id}/speaker
  PATCH  /v1/dubbing/resource/{dubbing_id}/speaker/{speaker_id}
  POST   /v1/dubbing/resource/{dubbing_id}/speaker/{speaker_id}/segment
  GET    /v1/dubbing/resource/{dubbing_id}/speaker/{speaker_id}/similar-voices
  PATCH  /v1/dubbing/resource/{dubbing_id}/segment/{segment_id}/{language}
  DELETE /v1/dubbing/resource/{dubbing_id}/segment/{segment_id}
  POST   /v1/dubbing/resource/{dubbing_id}/migrate-segments
```

Auth on every call: header `xi-api-key: <key>`. **VERIFIED (OpenAPI)** — it is an optional-typed header in the schema, but required in practice.

Regional base URLs — **VERIFIED (OpenAPI servers block):** `https://api.elevenlabs.io` (default), `api.us.elevenlabs.io`, `api.eu.residency.elevenlabs.io`, `api.in.residency.elevenlabs.io`, `api.sg.residency.elevenlabs.io`.

### 1.3 Classic create — `POST /v1/dubbing`

**`multipart/form-data`.** Takes **either** a file upload (`file`) **or** a URL (`source_url`). **VERIFIED (OpenAPI).**

Every field, verbatim from the spec:

| Field | Type | Default | Notes |
|---|---|---|---|
| `file` | binary | – | the source media |
| `csv_file` | binary | – | transcription/translation metadata |
| `foreground_audio_file` | binary | – | CSV input only |
| `background_audio_file` | binary | – | CSV input only |
| `name` | string | – | project name |
| `source_url` | string | – | URL of the source video/audio |
| `source_lang` | string | `"auto"` | "valid iso639-1 or iso639-3 language code" |
| `target_lang` | string | – | **the one field you must always send** |
| `target_accent` | string | – | `[Experimental]` |
| `num_speakers` | integer | `0` | 0 = auto-detect |
| `watermark` | boolean | `false` | **false costs 1.5x credits — see §4** |
| `start_time` | integer | – | trim start |
| `end_time` | integer | – | trim end |
| `highest_resolution` | boolean | `false` | |
| `drop_background_audio` | boolean | `false` | "can improve dub quality where it's known that audio shouldn't have a background track such as for speeches or monologues" |
| `use_profanity_filter` | boolean | – | `[BETA]`, censors to `[censored]` |
| `dubbing_studio` | boolean | `false` | true → editable resource, **2.5x–3.3x the credits** |
| `disable_voice_cloning` | boolean | `false` | uses a Voice Library voice; **counts against the workspace custom-voice limit and the dub FAILS if no slots are free** |
| `mode` | `automatic` \| `manual` | `automatic` | "manual mode is experimental and production use is strongly discouraged" |
| `csv_fps` | number | – | inferred from timecodes if omitted |

Note `target_lang` is typed `anyOf[string, null]` in the spec — i.e. **not** marked required at the schema level, even though the prose calls it required. Send it always.

**There is no `model_id` on this endpoint.** **VERIFIED (OpenAPI).** Which v2/v1 model the classic endpoint runs is not selectable and not documented — **UNVERIFIED**. If you need `dubbing_v2` explicitly, use the project API (§1.4).

Response 200 — `DoDubbingResponseModel`:

```json
{
  "dubbing_id": "21m00Tcm4TlvDq8ikWAM",
  "expected_duration_sec": 127.5
}
```

Both fields required. `expected_duration_sec` is your ETA hint for the polling backoff.

### 1.4 v2 create — `POST /v1/dubbing/project`

**`multipart/form-data`**, "Create a dubbing project from an uploaded file or a source URL." **VERIFIED (OpenAPI).**

| Field | Type | Notes (verbatim descriptions) |
|---|---|---|
| `file` | binary | "The source media file to dub. Provide this or source_url." |
| `source_url` | string | "Public URL to fetch the source media from. Provide this or file." |
| `reference` | string | "Optional free-form string (max 500 characters) to identify the project on your end." **← put the FlowVid `video_file_id` here** |
| `source_language` | string | "BCP-47 language tag... Any region or script subtag is ignored, since transcription is per-language. Omit to auto-detect." |
| `model_id` | `dubbing_v1` \| `dubbing_v2` | "Default dubbing model id... for the project's language targets; a target may override it. Omit to use the system default." |
| `keyterms` | string[] | "Key terms to bias transcription/translation toward (e.g. product or brand names). At most 1000 terms; each term at most 50 characters and 5 words; the characters `<>{}[]\` are not allowed." |
| `webhook_ids` | string[] | "Ids of workspace webhooks to notify when this project becomes ready or fails, and when any of its languages completes or fails. At most 3." |
| `target_language` | string | "Optional shortcut: also create a language target in this BCP-47 language, queued to start once the project is ready." |
| `transcript` | binary (JSON) | **Enterprise only.** BYO transcript; `source_language` becomes required. |

Response 200 — `DubbingProjectResponse`:

```json
{
  "project_id": "proj_...",
  "status": "preparing",
  "reference": "flowvid:video:9f3c...",
  "source_language": "en",
  "model_id": "dubbing_v2",
  "media": {
    "filename": "lesson-04.mp4",
    "duration_s": 612.4,
    "has_video": true,
    "mime_type": "video/mp4"
  },
  "language_ids": ["lang_..."]
}
```

`status` enum — **VERIFIED**: `queued` | `preparing` | `processing` | `ready` | `failed`.
`media` is **null until the project is ready**.

**`status: "ready"` means transcription finished, NOT that a dub exists.** This is the #1 integration mistake. Dubbing happens per language target.

### 1.5 v2 add language target — `POST /v1/dubbing/project/{project_id}/language`

**`application/json`** (note: unlike the two create endpoints). **VERIFIED (OpenAPI).**

```jsonc
// request
{
  "target_language": "he",              // required; BCP-47; region tag must be a supported dialect
  "voice_settings": { /* VoiceSettings; cloning strength etc. */ },
  "translations": { "seg_1": "..." }    // Enterprise only; must cover every source segment exactly once
}
```

Response 200 — `DubbingLanguageResponse`:

```json
{
  "language_id": "lang_...",
  "project_id": "proj_...",
  "target_language": "he",
  "status": "queued",
  "model_id": "dubbing_v2",
  "voice_settings": null,
  "outputs": null,
  "revision": 1,
  "output_revision": null,
  "error": null,
  "warnings": [],
  "created_at": "2026-08-20T10:00:00Z",
  "updated_at": "2026-08-20T10:00:00Z"
}
```

`status` enum — **VERIFIED**: `queued` | `processing` | `completed` | `stale` | `failed`.
- `queued` = "waiting on the project"
- `stale` = "source/transcript changed"

**`outputs` — the critical limitation.** `DubbingLanguageOutputs` has exactly **one** property:

```json
{ "lossless_audio": "https://signed-url..." }
```

> "Signed URL of the dubbed lossless audio track." — **VERIFIED (OpenAPI)**

**There is no video output on the v2 project surface.** If you want a dubbed *video*, you must either (a) use the classic surface, whose `/audio/{language_code}` endpoint returns "a streamed MP3 or MP4 file" depending on source, or (b) download `lossless_audio` and mux it onto the original video yourself with ffmpeg. FlowVid already has ffmpeg plumbing (§8), so (b) is cheap for us and gives us control over the container.

Signed URL lifetime: **"expires about an hour after it is issued"** — re-`GET` the language resource for a fresh one. **VERIFIED** ([dubbing quickstart](https://elevenlabs.io/docs/eleven-api/guides/cookbooks/dubbing)).

Revision tracking — **VERIFIED (OpenAPI)**: `revision` is "a monotonic counter incremented whenever this target's transcript changes"; `output_revision` is "the `revision` the current dubbed output was generated from". Compare them to detect a stale output. `outputs` is retained while `stale`, so a naive "outputs is non-null ⇒ fresh" check is wrong.

### 1.6 Status endpoints

**Classic** — `GET /v1/dubbing/{dubbing_id}` → `DubbingMetadataResponse`:

```json
{
  "dubbing_id": "...",
  "name": "lesson-04",
  "status": "dubbed",
  "source_language": "en",
  "target_languages": ["he", "es"],
  "editable": false,
  "created_at": "2026-08-20T10:00:00Z",
  "media_metadata": { "content_type": "video/mp4", "duration": 612.4 },
  "error": null
}
```

`status` is typed as a **bare `string`** in the spec — "The state this dub is in" — with **no enum**. **VERIFIED (OpenAPI)** that it is unconstrained. Observed/documented values are `dubbing`, `dubbed`, `failed` — **UNVERIFIED as an exhaustive set**. Do not write an exhaustive switch; treat unknown as "still running" and rely on a timeout.

**v2** — `GET /v1/dubbing/project/{project_id}` and `GET /v1/dubbing/project/{project_id}/language/{language_id}`, both with the enums above. Prefer these; they are properly typed.

### 1.7 Download

- **Classic:** `GET /v1/dubbing/{dubbing_id}/audio/{language_code}` → "a streamed MP3 or MP4 file". **VERIFIED.** Caveat from the docs: *"If this dub has been edited using Dubbing Studio you need to use the resource render endpoint as this endpoint only returns the original automatic dub result."*
- **v2:** signed `outputs.lossless_audio` URL from the language resource (audio only).
- **Studio render:** `POST /v1/dubbing/resource/{dubbing_id}/render/{language}` with `render_type` ∈ `mp4 | aac | mp3 | wav | aaf | tracks_zip | clips_zip | zip` and `normalize_volume` (default false) → `{ "version": 1, "render_id": "..." }`. This is async — you then poll the resource. **VERIFIED (OpenAPI).**

### 1.8 Deletion

- `DELETE /v1/dubbing/{dubbing_id}` — "Deletes a dubbing project." → `DeleteDubbingResponseModel`.
- `DELETE /v1/dubbing/project/{project_id}` and `DELETE /v1/dubbing/project/{project_id}/language/{language_id}`.

**VERIFIED (OpenAPI).** Whether deletion refunds credits: **UNVERIFIED** — nothing in the docs says so; assume it does not.

### 1.9 Listing

`GET /v1/dubbing` accepts `cursor`, `page_size`, `dubbing_status`, `dubbing_statuses`, `dubbing_models`, `target_language_codes`, `creation_sources`. `GET /v1/dubbing/project` accepts `cursor`, `page_size`, `status`, `sort_direction`. **VERIFIED (OpenAPI).** Useful for a reconciliation sweep after a worker crash.

---

## 2. Transcripts / captions — the product-critical section

### 2.1 Short answer

**Yes — the classic surface returns ready-to-use WebVTT and SRT, per language, including the source language.**

```
GET /v1/dubbing/{dubbing_id}/transcripts/{language_code}/format/{format_type}
```

**VERIFIED (OpenAPI + [changelog 2026/1/12](https://elevenlabs.io/docs/changelog/2026/1/12)).**

- `language_code` — "ISO-693 language code to retrieve the transcript for. **Use `'source'` to fetch the transcript of the original media.**"
- `format_type` — enum **`srt` | `webvtt` | `json`**. "For subtitles use either 'srt' or 'webvtt', and for a full transcript use 'json'. **The 'json' format is not yet supported for Dubbing Studio.**"

This endpoint **replaced** the now-**deprecated** `GET /v1/dubbing/{dubbing_id}/transcript/{language_code}`. Do not use the deprecated one.

### 2.2 The response is a JSON envelope, not a raw file — do not pipe it straight to disk

`DubbingTranscriptsResponseModel`:

```json
{
  "transcript_format": "webvtt",
  "srt": null,
  "webvtt": "WEBVTT\n\n1\n00:00:01.120 --> 00:00:04.300\nשלום, ברוכים הבאים\n\n2\n...",
  "json": null
}
```

Only `transcript_format` is required; the other three are nullable and **only the one matching `transcript_format` is populated**. So:

```ts
const r = await res.json();
const vtt = r.webvtt;           // NOT await res.text()
```

**VERIFIED (OpenAPI).** This is a real foot-gun — the docs prose says "a string with formatted subtitles is returned", which reads as if the body *is* the VTT. It is not.

### 2.3 Are the timings usable as closed captions directly?

**Yes, for the `webvtt` format — it is already a WebVTT document with cues.** It drops straight into a `<track kind="captions" src="...">`. **VERIFIED** that the format is WebVTT; **UNVERIFIED** whether ElevenLabs emits a `WEBVTT` header line, cue identifiers, or any styling blocks, because no verbatim sample response is published.

**Defensive requirement:** FlowVid already validates VTT before persisting (`generateVttValidate` in `CaptionService.ts` requires a leading `WEBVTT` and at least one `-->`). Run ElevenLabs output through the *same* validator, and reuse the existing `normalizeVtt()` helper, which prepends `WEBVTT\n\n` when it is missing. That single line of reuse makes the header question moot.

**No conversion is needed** for the classic surface. VTT is offered natively.

### 2.4 The v2 project surface does NOT offer SRT/VTT — you must build it

`GET /v1/dubbing/project/{project_id}/transcript` → `DubbingSourceTranscriptResponse`
`GET /v1/dubbing/project/{project_id}/language/{language_id}/transcript` → `DubbingTargetTranscriptResponse`

Both return **JSON only**. **VERIFIED (OpenAPI).** The target shape:

```json
{
  "source_language": "en",
  "target_language": "he",
  "revision": 3,
  "segments": [
    {
      "id": "seg_1",
      "speaker_id": "spk_0",
      "start_s": 1.12,
      "end_s": 4.30,
      "source_text": "Hello and welcome",
      "translation": "שלום, ברוכים הבאים"
    }
  ]
}
```

`translation` is nullable — "null if not translated yet (needs translation)".

**Conversion required, and it is trivial for us:** `segments[]` carries `start_s` / `end_s` in **seconds as numbers** — which is exactly the `{ start, end, text }` shape that FlowVid's existing `segmentsToVtt()` in `CaptionService.ts` already consumes. Mapping is a one-liner:

```ts
segmentsToVtt(segments
  .filter(s => s.translation)
  .map(s => ({ start: s.start_s, end: s.end_s, text: s.translation! })))
```

The source transcript (`DubbingTranscriptSegment`) is the same but with `text` instead of `source_text`/`translation`, plus an optional caller-supplied `external_id`.

### 2.5 Open ambiguity you must resolve empirically before committing

**Can a v2 `project_id` be passed to the classic `/v1/dubbing/{dubbing_id}/transcripts/.../format/webvtt` route?**

**UNVERIFIED — and this decides the whole captions design.** The two surfaces use differently-named identifiers (`project_id` vs `dubbing_id`) and nothing in the OpenAPI document or the changelog states whether the ID spaces are shared. Do not assume either way.

**Resolve it with one throwaway script on day one:** create a project via `POST /v1/dubbing/project`, then `GET /v1/dubbing/{project_id}/transcripts/he/format/webvtt`.

- If it works → use the v2 project API for everything and get VTT for free.
- If it 404s → either use the classic surface (which gives VTT *and* MP4 but no `model_id` control), or use v2 and build VTT from segments with `segmentsToVtt` (§2.4). **Given FlowVid already owns `segmentsToVtt`, option (b) costs ~10 lines and keeps `model_id: dubbing_v2` and webhooks. That is the recommended default.**

---

## 3. Async behaviour

### 3.1 Lifecycle and polling

Documented v2 flow — **VERIFIED** ([quickstart](https://elevenlabs.io/docs/eleven-api/guides/cookbooks/dubbing)): create project → poll project until `ready` (transcription done) → add language target → poll language until `completed` → download from `outputs.lossless_audio`.

Official code samples poll on a **5-second** interval. **VERIFIED.** Use that as the floor; back off for long media.

### 3.2 Webhooks — supported, on the v2 surface only

**VERIFIED (OpenAPI).** `POST /v1/dubbing/project` accepts `webhook_ids[]`: *"Ids of workspace webhooks to notify when this project becomes ready or fails, and when any of its languages completes or fails. At most 3; each must be a webhook configured in your workspace."*

Webhooks are **workspace-level objects** you create first via `POST /v1/workspace/webhooks` (see [Create Workspace Webhook](https://elevenlabs.io/docs/api-reference/webhooks/create)); only workspace admins can configure them. Auth is **HMAC**: store the shared secret issued at creation and verify the `ElevenLabs-Signature` header. **VERIFIED** ([Webhooks](https://elevenlabs.io/docs/eleven-api/resources/webhooks)).

The **exact dubbing webhook event names and payload schema are UNVERIFIED** — not published in the OpenAPI document or the changelog. Plan for **webhook-plus-polling-fallback**, not webhook-only: treat the webhook as an early-wake signal and keep a reconciling poll (a `stale`/timeout sweep) as the authority. That is the same belt-and-braces shape `CaptionService` already uses with its `STALE_CLAIM_MS` reclaim.

The classic `POST /v1/dubbing` has **no webhook parameter** — polling only. **VERIFIED (OpenAPI).**

### 3.3 Processing duration

**UNVERIFIED — no published SLA or duration table anywhere.** ElevenLabs publishes no per-minute processing estimate for dubbing.

What you *do* get: `expected_duration_sec` in the classic create response, and `media.duration_s` once a v2 project is ready. Neither is a processing-time estimate — both describe the **media length**. Do not present them to users as an ETA.

**Action:** instrument your own p50/p95 of wall-clock-per-source-minute from the first week of real jobs and drive the UI estimate off that. Do not hard-code a guess into the brief-derived code.

### 3.4 Limits — VERIFIED ([Dubbing capabilities](https://elevenlabs.io/docs/overview/capabilities/dubbing))

| Limit | Value |
|---|---|
| Max file size (API) | **3 GB per source file** |
| Max size/duration (app) | 1 GB and 180 minutes |
| Dubbing Studio (v1) | 1 GB and 45 minutes |
| Max unique speakers | **32 per file** |
| Concurrent jobs, self-serve (Free→Business) | **3** |
| Concurrent jobs, Enterprise | **10** (default) |

Concurrency is **per workspace and counted per model — v1 and v2 do not share a pool.** Exceeding it returns a **`too_many_concurrent_requests`** error. **VERIFIED.**

**This 3-job ceiling is the binding constraint on FlowVid's throughput**, and it is a *workspace* limit — every tenant's dubs contend for the same 3 slots. It must be enforced in our queue (§8), not discovered at the API.

### 3.5 Supported input formats

**Partly UNVERIFIED.** The docs say only: *"All audio and video content types are supported"* and *"Videos and audio can be dubbed from various sources, including YouTube, TikTok, direct URLs, or file uploads."* **No explicit container/codec allowlist is published.** MP4 in / MP3 or MP4 out is confirmed by the download endpoint description. Assume standard MP4/MOV/WebM/MP3/WAV work; validate empirically for anything exotic.

### 3.6 Rate limits

Beyond the 3/10 concurrency ceiling, **no dubbing-specific request-rate limit is documented — UNVERIFIED.** General ElevenLabs rate limiting applies. Implement 429/`too_many_concurrent_requests` handling with exponential backoff regardless.

---

## 4. Pricing and quota

### 4.1 Credit cost — VERIFIED ([pricing](https://elevenlabs.io/pricing))

> "Dubbing 2,000 credits per minute (automatic with watermark), 3,000 (automatic without watermark), 5,000 (Dubbing Studio with watermark) or 10,000 (Dubbing Studio without watermark)."

| Mode | Credits / minute |
|---|---|
| Automatic, **with** watermark | **2,000** |
| Automatic, **without** watermark | **3,000** |
| Dubbing Studio, with watermark | 5,000 |
| Dubbing Studio, without watermark | 10,000 |

Two levers with a **1.5x** and **up to 5x** cost impact:
- `watermark: false` (the API default!) costs **1.5x** what `watermark: true` costs.
- `dubbing_studio: true` costs **2.5x–3.3x** the automatic equivalent. **Never set it unless a human will actually edit the dub.**

Since the API defaults are `watermark: false, dubbing_studio: false`, the **default cost is 3,000 credits/min**.

**Billing is per minute of SOURCE media, per target language.** Dubbing into `he` + `es` from one 10-minute source = 2 × 10 × 3,000 = 60,000 credits. **VERIFIED** that dubbing is "billed per minute of source media" ([dubbing-api](https://elevenlabs.io/dubbing-api)); the per-language multiplication is a direct consequence and is **UNVERIFIED as an explicit statement** — confirm on your first two-language job before trusting a quota projection.

### 4.2 Dollar cost

> "Dubbing is billed per minute of source media, with **Dubbing v2 starting at $2.20 per minute**." — **VERIFIED** ([dubbing-api](https://elevenlabs.io/dubbing-api))

Third-party analyses put the effective range at **$0.33–$2.20/minute** depending on plan (higher tiers buy credits more cheaply). **UNVERIFIED** (secondary source, [diyai.io](https://diyai.io/ai-tools/audio-generation/elevenlabs-pricing/)) — but directionally it tells you the headline $2.20 is the *worst* case, not the typical one.

### 4.3 Plan tiers — VERIFIED (pricing page)

| Plan | $/mo | Credits/mo | ≈ minutes of automatic dubbing @3,000/min |
|---|---|---|---|
| Free | 0 | 10,000 | ~3 |
| Starter | 6 | 30,000 | ~10 |
| Creator | 22 | 121,000 | ~40 |
| Pro | 99 | 600,000 | ~200 |
| Scale | 299 | 1,800,000 | ~600 |
| Business | 990 | 6,000,000 | ~2,000 |
| Enterprise | custom | custom | – |

**All ElevenLabs products draw on one shared credit pool** — TTS, STT, voice cloning and dubbing. FlowVid already spends this pool on `GuidanceTTSService`. **A heavy dubbing month will silently starve guidance narration.** Budget and alert on the pool as a whole, not per feature.

### 4.4 Do transcripts/captions cost extra?

**UNVERIFIED, but almost certainly no.** The pricing page lists no separate line item for dubbing transcripts, and the transcript endpoints are plain `GET`s against an already-paid-for dub — you are reading an artifact the dub already produced. **The cost of "translated captions via ElevenLabs" is the cost of the dub itself.** There is no cheaper captions-only door on the dubbing API. (If you want captions *without* paying for a dub, that is §5.)

### 4.5 Failed jobs

*"Dubbing v2 ... is not charged for failed jobs"*, and cancelled/failed Dubbing Studio jobs are auto-refunded; a job stuck in Queued/Loading can be cancelled and resubmitted without losing credits. **UNVERIFIED** — this comes from secondary summarisation of the help centre, not a page read directly. Verify against your own credit balance on the first deliberate failure; do not build refund logic on it.

---

## 5. Free / cheaper caption alternatives for the same job

The PO asked for free CC "if possible, but accurate". Here is the honest comparison.

### (a) ElevenLabs transcript-for-dub

- **Cost:** effectively **free *given* you are already paying ~3,000 credits/min for the dub**; ~$0.33–$2.20/min if the dub is the only reason you are calling.
- **Accuracy:** the highest available, and for a *specific structural reason* — the caption text is the **exact same translated text that was spoken in the dubbed audio**, produced by the same model, with the same segment boundaries. Captions and audio cannot disagree.
- **Verdict:** the only option that guarantees caption/audio agreement. **If you are dubbing anyway, always take these captions.** Using a separate transcription of the dubbed audio instead would be strictly worse and cost more.

### (b) Groq Whisper + a translation pass — **FlowVid already has 90% of this built**

- **Cost — VERIFIED** ([tokenmix](https://tokenmix.ai/blog/whisper-api-pricing), [apio](https://apio.sh/apis/groq-speech-to-text)): `whisper-large-v3` **$0.111/hour** ≈ **$0.00185/min**; `whisper-large-v3-turbo` **$0.04/hour** ≈ **$0.00067/min**. Groq free tier: **28,800 audio-seconds/day (8 hours) and 2,000 requests/day**. Billing has a **10-second minimum per request**.
- **That is roughly 1,000x cheaper than ElevenLabs dubbing per minute** — and for source-language captions it is what FlowVid already runs in production today.
- Translation pass: run the VTT cue text through the existing `LLMService` (Claude/OpenAI/Gemini providers are already wired). Cost is a few cents per hour of media — negligible next to the transcription.
- **Accuracy trade-off, stated honestly:**
  - Whisper's *source-language* transcription is strong and its timings are usable — FlowVid ships them already.
  - The **translation** is where it degrades. A cue-by-cue LLM translation loses cross-cue context, so pronouns, gender agreement and idiom suffer — **this matters especially for Hebrew**, which is heavily gendered and where a mistranslated verb form is immediately wrong to a native speaker. Mitigate by translating the whole transcript in one call with cue markers, not cue-by-cue.
  - Whisper has **no speaker diarization** in this path, so multi-speaker captions lose speaker attribution.
  - Critically: **if you are also producing a dub, Whisper-translated captions will NOT match the dubbed audio.** Two independent translations of the same source diverge. Viewers with captions on will see one wording and hear another. **Never mix path (b) captions with path (a) audio.**
- **Verdict:** the right choice for **captions-only** languages — where you want `/he` and `/es` subtitles but no dubbed audio. Near-free, good enough, already built.

### (c) Free tiers

- Groq: 8 audio-hours/day free — genuinely useful for FlowVid's volume. **VERIFIED.**
- ElevenLabs Free: 10,000 credits/mo ≈ **3 minutes** of dubbing. Not a viable free captions source. **VERIFIED.**

### Recommended policy

| Product need | Path | Cost |
|---|---|---|
| Source-language CC | existing Groq Whisper `CaptionService` | ~free |
| Translated CC **only** (no dubbed audio) | Groq Whisper + one whole-document LLM translation | ~free |
| Dubbed audio **+** CC | ElevenLabs dub, and take its transcript as the CC | dub price; captions free |

The rule that prevents the worst bug: **captions must come from whatever produced the audio the user is hearing.**

---

## 6. Language codes

**The two surfaces specify different code standards. This is a real inconsistency, verbatim from the spec.**

| Surface | Field | Spec text |
|---|---|---|
| Classic `POST /v1/dubbing` | `source_lang`, `target_lang` | "Expects a valid **iso639-1 or iso639-3** language code" |
| Classic transcripts | `language_code` | "**ISO-693** language code" *(sic — a typo for ISO-639 in the published spec)* |
| v2 project | `source_language`, `target_language` | "**BCP-47** language tag" |

**VERIFIED (OpenAPI, verbatim).** For the three languages FlowVid needs, the distinction is moot — `he`, `es`, `en` are valid in all three schemes.

### The codes you need — VERIFIED ([Dubbing v2 languages](https://elevenlabs.io/docs/help-center/product/content-production/dubbing/which-languages-are-supported-in-dubbing-v-2))

| Language | Base code | Supported dialects |
|---|---|---|
| **Hebrew** | **`he`** | — (no dialects) |
| **Spanish** | **`es`** | `es-AR`, `es-CL`, `es-ES`, `es-MX` |
| **English** | **`en`** | `en-AU`, `en-CA`, `en-GB`, `en-US` |

**The planned URL suffixes `/he` `/es` `/en` map 1:1 onto the API's base language codes. No mapping table is needed.**

Rules that will bite you:
1. **A region-qualified tag must be one of the listed dialects.** `es-419` is *not* in the Dubbing v2 dialect list above (a secondary source claimed it is — **that claim is UNVERIFIED and contradicted by the help-centre table**; use `es-MX` for Latin American Spanish). Sending an unsupported region tag is an error, not a silent fallback to the base language.
2. **Hebrew has no dialects — never send `he-IL`.** It will not match the supported-dialect list.
3. On `source_language`, "any region or script subtag is **ignored**, since transcription is per-language" — so `en-GB` as a *source* is silently treated as `en`. **VERIFIED (OpenAPI).**

FlowVid's schema already enforces a compatible shape: `courses.language` carries a check constraint `^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$` (`backend-api/src/db/schema.ts:979`), which accepts exactly these BCP-47 tags. Reuse that regex for any new dubbing language column.

---

## 7. Gotchas — what actually breaks

1. **`status: "ready"` on a v2 project does not mean you have a dub.** It means transcription finished. The dub lives on the *language target* and has its own `completed` status. Polling the project and then downloading will get you nothing. **VERIFIED (OpenAPI).**

2. **The v2 project API never returns video.** `DubbingLanguageOutputs` has exactly one field, `lossless_audio`. If your product promise is "dubbed video", you must mux it yourself or use the classic surface. Discovering this after building the whole v2 pipeline is the expensive version of this brief. **VERIFIED (OpenAPI).**

3. **The transcripts response is a JSON envelope, not a VTT file.** `await res.text()` yields `{"transcript_format":"webvtt","webvtt":"WEBVTT..."}`— which passes a naive "does it contain WEBVTT" check and writes a corrupt caption file. Read `.webvtt`. **VERIFIED (OpenAPI).**

4. **Signed output URLs expire in ~1 hour.** A job that queues behind a long ffmpeg render will find a dead URL. Re-fetch the language resource at download time; never persist the signed URL. **VERIFIED.**

5. **`stale` targets keep their old `outputs`.** `outputs != null` does **not** mean fresh. You must compare `output_revision === revision`. A naive check silently serves the pre-edit dub forever. **VERIFIED (OpenAPI).**

6. **`disable_voice_cloning: true` consumes workspace custom-voice slots and *fails the dub* when none are free** — "if there aren't enough available slots the dub will fail". A quota unrelated to dubbing takes your dubbing pipeline down. **VERIFIED (OpenAPI).**

7. **Concurrency is 3 per workspace, shared across all FlowVid tenants**, and counted per model. Tenant A's 90-minute course blocks tenant B. Must be gated in our queue. **VERIFIED.**

8. **The `watermark: false` default costs 1.5x.** The API's default is the expensive one. Anyone who forgets to think about it pays 3,000 rather than 2,000 credits/min. **VERIFIED.**

9. **Speaker diarization:** `num_speakers: 0` (auto) is the default; max 32 unique speakers. Docs claim multi-speaker detection works "even with overlapping speech". **Real-world diarization failure modes on overlapping or similar-sounding speakers are UNVERIFIED** — no error taxonomy is published. Mitigation where you know the answer: **pass an explicit `num_speakers`.** For FlowVid's single-presenter lesson videos, `num_speakers: 1` removes an entire class of failure and is strictly better than auto-detect.

10. **What a dub returns when the source has no speech: UNVERIFIED.** Nothing in the documentation covers it. It is genuinely unclear whether you get a `failed` status, an empty transcript, or a silent-but-billed output. **This matters for FlowVid because B-roll and screen-recording segments frequently have no speech.** Guard *before* you spend credits: FlowVid already computes `waveform_peaks` on every video (`schema.ts:421`) — use it as a cheap silence pre-check, and skip the dub entirely for a flat waveform.

11. **Re-dubbing idempotency: it bills again.** There is **no idempotency key on any dubbing create endpoint** — **VERIFIED (OpenAPI)**: neither `POST /v1/dubbing` nor `POST /v1/dubbing/project` accepts one. A retried create is a *new*, separately-billed job. A crashed worker that retries on restart double-bills silently. **You must implement idempotency yourself** — see §8; FlowVid's existing `captions_source_hash` pattern is exactly the right precedent. The `reference` field on v2 projects plus `GET /v1/dubbing/project?status=` gives you a way to *find* an in-flight job before creating a duplicate.

12. **`mode: "manual"` is documented as "experimental and production use is strongly discouraged."** Do not use it. **VERIFIED (OpenAPI).**

13. **`DubbingError.code` is an open string set** — "New codes are added over time, so treat an unrecognized value as `internal_error`." Also: a language target failing with code `project_failed` means the *parent* failed and you must read the project for the real cause. There is **no published enumeration of error codes — UNVERIFIED**. Never write an exhaustive switch. Do branch on `error.retryable`, which is a required boolean: `false` means "the failure describes the input or the account, so an identical retry will fail the same way" — i.e. do not burn retries. **VERIFIED (OpenAPI).**

14. **ElevenLabs docs pages return 403 to automated fetchers** (the help-centre articles especially). If you build any doc-scraping tooling around this, it will fail. Use `https://api.elevenlabs.io/openapi.json` instead — it is public, complete, and machine-readable.

---

## 8. How this attaches to FlowVid

All paths below were read during this research and are real.

### 8.1 The ElevenLabs integration surface that already exists

| File | What it gives you |
|---|---|
| `/Users/ofeklevy/cebu/podcast-saas/backend-api/src/services/audio/GuidanceTTSService.ts` | **The pattern to copy.** Defines `ELEVENLABS_API_BASE = 'https://api.elevenlabs.io/v1'`, resolves the key as `apiKeyService.getSystemKey('elevenlabs') ?? process.env.ELEVENLABS_API_KEY`, calls with `xi-api-key`, and logs failures with a truncated body. A `DubbingService` should mirror this exactly. |
| `/Users/ofeklevy/cebu/podcast-saas/backend-api/src/services/secrets/ApiKeyService.ts` | `getSystemKey('elevenlabs')` — AES-256-GCM encrypted, 5-minute TTL cache, admin-rotatable. **`'elevenlabs'` is already in the provider union**, so dubbing needs **no change here at all**. |
| `/Users/ofeklevy/cebu/podcast-saas/backend-api/src/services/podcast/audio/ElevenLabsDialogue.ts` | A second, richer ElevenLabs client (multi-speaker dialogue). Worth reading for retry/chunking conventions. |
| `/Users/ofeklevy/cebu/podcast-saas/backend-api/src/_archive/v1-podcast-pipeline/services/audio/ElevenLabsTTSProvider.ts` | Archived; the `/with-timestamps` variant, if you ever need word alignment. |

**Seam:** add `DubbingService.ts` beside `GuidanceTTSService.ts` in `backend-api/src/services/audio/`, or a new `backend-api/src/services/dubbing/`. No new secret plumbing required.

### 8.2 The caption service to extend — this is the highest-leverage reuse in the whole brief

`/Users/ofeklevy/cebu/podcast-saas/backend-api/src/services/captions/CaptionService.ts`

Already implemented and directly reusable:
- **`segmentsToVtt(segments: {start,end,text}[])`** — consumes exactly the `{start_s, end_s, translation}` shape the v2 target-transcript endpoint returns (§2.4). This is the conversion the brief calls for, already written and unit-tested.
- **`vttTimestamp()`**, **`normalizeVtt()`** — prepends a missing `WEBVTT` header, which neutralises the §2.3 ambiguity.
- **`generateVttValidate()`** — rejects non-`WEBVTT` / cue-less output before it is persisted. Run ElevenLabs VTT through this too.
- **The whole job-safety pattern**: `captions_source_hash` idempotency, the atomic cluster-safe claim via `UPDATE ... RETURNING`, `STALE_CLAIM_MS` reclaim of crashed workers, `FAILED_RETRY_MS` backoff, and `shouldSkipCaption()` extracted as a **pure, testable function**.

**That last item is the answer to gotcha #11.** Dubbing has no idempotency key, so a duplicate create is real money. Copy `shouldSkipCaption`'s shape verbatim into a `shouldSkipDub()` pure function, keyed on a `dub_source_hash` + `target_language`, and claim atomically before calling ElevenLabs. Do not invent a new concurrency scheme; this one already survived a review finding (`arch-008`, cited in the file).

Existing engine selection (`pickEngine()`, `GROQ_API_KEY` → `whisper-large-v3`, `GROQ_MAX_BYTES = 24 MB` ≈ 50 min) is the **§5(b) cheap-captions path, already in production.** A translated-caption path reuses `generateVtt()` unchanged and adds one LLM translation step via `backend-api/src/services/llm/LLMService.ts`.

### 8.3 The data model seam — this needs a migration

`/Users/ofeklevy/cebu/podcast-saas/backend-api/src/db/schema.ts`, table `video_files` (line ~407):

```
storage_key, duration_sec, waveform_peaks, is_broll
hls_status / hls_master_key / hls_current_tier / hls_360p_key / hls_started_at / hls_finished_at / hls_error
captions_status | captions_vtt_key | captions_vtt | captions_source_hash | captions_error | captions_updated_at
```

**The blocking structural fact: captions are single-language.** `captions_vtt` is one `text` column holding one WebVTT document per video. There is no language dimension anywhere in `video_files`. The `/he` `/es` `/en` product plan **cannot** be expressed in the current schema.

**Required:** a new child table, not more columns. Sketch:

```
video_dubs(
  id, video_file_id → video_files.id ON DELETE CASCADE,
  target_language text,              -- reuse the courses.language check regex (schema.ts:979)
  provider text,                     -- 'elevenlabs' | 'whisper+llm'
  el_project_id text, el_language_id text,   -- v2 ids; el_dubbing_id for the classic surface
  status text,                       -- mirror queued|processing|completed|stale|failed
  audio_key text,                    -- dubbed audio in object storage
  muxed_video_key text,              -- after the ffmpeg mux (gotcha #2)
  captions_vtt text,                 -- translated VTT — mirrors captions_vtt exactly
  source_hash text,                  -- idempotency, mirrors captions_source_hash (gotcha #11)
  revision int, output_revision int, -- staleness (gotcha #5)
  error text, updated_at timestamptz,
  UNIQUE(video_file_id, target_language, provider)
)
```

The `UNIQUE(video_file_id, target_language, provider)` constraint is your last line of defence against double-billing.

Precedent for the column-set shape: `hls_retired_runs` (schema.ts:455) shows how this repo models a per-video child table with a GC sweep.

### 8.4 Serving seam

`/Users/ofeklevy/cebu/podcast-saas/backend-api/src/controllers/v1/player.controller.ts`

- `GET /api/v1/videos/:videoId/captions.vtt` (line 117) — reads `captions_vtt` from the DB and serves it with `text/vtt`. **The per-language route is a near-copy:** `GET /api/v1/videos/:videoId/captions/:lang.vtt` reading `video_dubs.captions_vtt`.
- `GET /api/v1/projects/:id/captions` (line 86) and `POST /api/v1/projects/:id/captions/retry` (line 150) are the status/retry pair to mirror.
- `captionUrlForVideo()` / `captionVttRouteUrl()` in `CaptionService.ts` are what the player uses to build the `<track>` URL — extend these to take a language.

### 8.5 Queue and concurrency seam

`/Users/ofeklevy/cebu/podcast-saas/backend-api/src/queue/pgBoss.ts` + `enqueueJob` (already imported by `CaptionService`).

**Non-negotiable:** ElevenLabs allows **3 concurrent dubbing jobs per workspace, across all FlowVid tenants** (§3.4). Register the dub job with a **global concurrency cap of ≤3** (leave headroom: 2). The existing `runFfmpegLimited` in `backend-api/src/services/ffmpegLimit.ts` is the in-repo precedent for a global concurrency gate — read it before inventing one.

### 8.6 Media/mux seam

Because the v2 API returns audio only (gotcha #2), the dubbed video is *our* ffmpeg job. `CaptionService.ts` already shells ffmpeg through `runFfmpegLimited()` with timeouts and `maxBuffer` set — reuse that wrapper rather than calling `execFile` directly. The mux is a stream-copy of the source video plus the new audio track (no re-encode), so it is cheap.

### 8.7 Metering seam — needs a small extension

`/Users/ofeklevy/cebu/podcast-saas/backend-api/src/services/usage/UsageTrackingService.ts` writes to `token_usage` (schema.ts:308) with `input_tokens` / `cached_input_tokens` / `output_tokens` / `cost_cents` (`doublePrecision`, fractional cents since migration 046).

**The table is token-shaped; dubbing is minute-shaped.** Two options:
- **Cheap:** record with `provider:'elevenlabs'`, `model:'dubbing_v2'`, `task:'dub'`, zeros in the token columns, and the real money in `cost_cents` (computed as `minutes × credits_per_min × credit_cost`). Works today, no migration, but "tokens" columns lie.
- **Correct:** add a nullable `units` + `unit_kind` pair so minute-metered work is honestly represented.

Given the PO says "this feature will be metered", and that `cost_cents` is already fractional and correct, **the cheap option is defensible for v1** — but write the minutes into `task` or a new column rather than losing them, because per-minute is the number you will be reconciling against ElevenLabs' invoice.

Note also `AvatarBudgetService.ts` / `RateLimitService.ts` in the same directory — the existing precedent for capping spend per user. Dubbing at ~$0.33–2.20/min is **by far the most expensive per-unit operation in FlowVid** and needs a budget gate before launch, not after.

### 8.8 Suggested build order

1. Throwaway script: resolve the §2.5 ambiguity (does `project_id` work on the classic transcripts route?). One hour, decides the architecture.
2. Migration: `video_dubs` table with the unique constraint.
3. `DubbingService.ts` modelled on `GuidanceTTSService` + `CaptionService`'s claim/hash pattern.
4. Global-concurrency-capped queue job; poll first, add webhooks later.
5. ffmpeg mux step via `runFfmpegLimited`.
6. Per-language caption route in `player.controller.ts`.
7. Metering + budget gate **before** exposing it to users.

---

## Appendix: reproduce this research

```bash
curl -s https://api.elevenlabs.io/openapi.json -o el-openapi.json
node -e 'const s=require("./el-openapi.json");
  Object.keys(s.paths).filter(p=>/dub/i.test(p)).sort()
    .forEach(p=>console.log(Object.keys(s.paths[p]).filter(m=>["get","post","patch","delete"].includes(m)).join(",").toUpperCase().padEnd(12),p));'
```

**Sources**
- [Live OpenAPI document](https://api.elevenlabs.io/openapi.json) — authoritative for every endpoint shape
- [Dubbing v2 is now available via ElevenAPI](https://elevenlabs.io/blog/dubbing-api)
- [Changelog, August 10 2026](https://elevenlabs.io/docs/changelog/2026/8/10)
- [Dubbing capabilities](https://elevenlabs.io/docs/overview/capabilities/dubbing)
- [Dub a video or audio file](https://elevenlabs.io/docs/api-reference/dubbing/create)
- [Retrieve a transcript](https://elevenlabs.io/docs/api-reference/dubbing/transcripts/get)
- [Get dubbed audio](https://elevenlabs.io/docs/api-reference/dubbing/audio/get)
- [Dubbing quickstart](https://elevenlabs.io/docs/eleven-api/guides/cookbooks/dubbing)
- [Which languages are supported in Dubbing v2?](https://elevenlabs.io/docs/help-center/product/content-production/dubbing/which-languages-are-supported-in-dubbing-v-2)
- [Pricing](https://elevenlabs.io/pricing) · [Dubbing API product page](https://elevenlabs.io/dubbing-api)
- [Webhooks](https://elevenlabs.io/docs/eleven-api/resources/webhooks)
- [Do you offer lip sync in Dubbing?](https://help.elevenlabs.io/hc/en-us/articles/23793433149073-Do-you-offer-lip-sync-in-Dubbing)
- [Whisper API pricing](https://tokenmix.ai/blog/whisper-api-pricing) · [Groq speech-to-text](https://apio.sh/apis/groq-speech-to-text)
