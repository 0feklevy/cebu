# Multi-language dubbing (ElevenLabs Dubbing v2) — implementation report

**Branch:** `feat/dubbing-multilang`, based on `origin/main` @ 6c7f9bb. Not pushed, no PR, not merged.
**Migration used:** **067** (`067_video_dubs.sql` + `.rollback.sql`)
**Date:** 2026-08-21

---

## 0. The headline caveat

**Nothing in this branch has been exercised against the live ElevenLabs API.** There is no API key
and no network in the environment it was written in. Every request and response shape is typed from
`ELEVENLABS-DUBBING-API-BRIEF.md`, which is machine-verified against the vendor's live OpenAPI
document, and covered by fixture tests. §7 lists exactly what remains unverified.

---

## 1. Stage status

| Stage | Verdict | Evidence |
|---|---|---|
| **S1 Backend core** | **DONE** | Migration 067 + schema; `DubbingService` behind a `DubbingProvider` interface; typed v2 client; `dub` pg-boss job with a cluster-wide concurrency gate; language mapping; cost metering. 19 migration tests, 54 service/client tests. |
| **S2 API surface** | **DONE** | Owner list/create/delete behind `editableProject` with 404-not-403; public per-language caption route; `buildPlayerConfig` carries `language` + `available_languages` and swaps segment URLs. 16 route tests, 14 player-config tests. |
| **S3 Creator UI** | **DONE** | `DubbingSettings.tsx` as a `ProjectSettingsPanel` sub-page: multi-select, per-language status, pre-run cost estimate, delete. |
| **S4 Viewer UI** | **DONE** | Language radio group inside the existing caption menu. 20 a11y/behaviour tests. Playback position **not** preserved — §6. |
| **S5 Routing** | **DONE** | `/{slug}/{lang}` route; `?lang=` on share links; `PERMALINK_LANGUAGE_SUFFIXES` added additively beside `RESERVED_SLUGS`. |

---

## 2. Migration number

**067.** Not the next number that appears free from a clean checkout.

- `065` — claimed by `feat/library-share-impl` (`library_shares`), uncommitted but real.
- `066` — reserved for `feat/crop-v2`.
- `067` — first genuinely free number.

Registered in `backend-api/src/db/migrate.ts` and `backend-api/src/scripts/check-db.ts` (the house
convention pairs both; `migration067.test.ts` asserts it).

### What it creates

`video_dubs` — one row per `(video_file_id, target_language, provider)`, with
`UNIQUE(video_file_id, target_language, provider)`, `ON DELETE CASCADE` from `video_files`, a status
CHECK matching the vendor's language-target enum, and the same BCP-47 regex `courses.language`
carries.

`dubbing_slots` — three seeded rows, the vendor's per-workspace concurrency ceiling made
cluster-wide. See §4.

---

## 3. The captions ambiguity, resolved

Two sources disagreed. **The brief is correct; the pessimistic reading is a conflation.** Both are
right about the *file format* and only one is right about whether *segment data* exists.

| Claim | Verdict |
|---|---|
| "v2 returns a single lossless audio file, and no SRT/VTT" | **True, and the brief says the same thing** (§2.4's heading is literally *"The v2 project surface does NOT offer SRT/VTT — you must build it"*). `DubbingLanguageOutputs` has exactly one property. |
| "…therefore v2 hands you no transcript at all" | **False.** |

**Evidence for the correction**, all from the OpenAPI-derived inventory in brief §1.2:

- Five v2 transcript routes exist, including
  `GET /v1/dubbing/project/{project_id}/language/{language_id}/transcript`.
- Two named response schemas: `DubbingSourceTranscriptResponse` and
  `DubbingTargetTranscriptResponse`, the latter documented field-by-field with
  `segments[].start_s`, `end_s`, `source_text`, `translation`, plus the note that `translation` is
  *"null if not translated yet"*.

Schema **identifiers** like `DubbingTargetTranscriptResponse` are artifacts of a generated OpenAPI
document. A prose docs page or blog post does not produce them. That is the provenance signal that
settles it.

### Built anyway: the documented fallback

Per the instruction, and because it costs little:

1. **Primary** — fetch the target transcript, filter to translated segments, feed through the
   existing `segmentsToVtt()`. The caption text is then the *exact text spoken in the dubbed audio*.
2. **Fallback** — if that route 404s, errors, or yields no translated segments, transcribe **the
   dubbed audio itself** with the existing Groq Whisper path
   (`captions/transcribeAudioFile.ts`, extracted from `CaptionService` so both share one
   implementation).
3. **Never** — an independent translation of the source. Two translations diverge and the viewer
   reads one wording while hearing another.

The integrity rule holds under either reading, which is the point.

---

## 4. Double-billing defence and concurrency

The vendor accepts **no idempotency key on any dubbing create endpoint**, so a retried create is a
new invoice at roughly 3,000 credits per source-minute. Four layers, in the order they fire:

1. **Atomic CAS claim** — `UPDATE … RETURNING`, copied from `CaptionService`'s `arch-008` pattern.
   An empty result means another worker won.
2. **`el_project_id` persisted before anything else can throw** — a retry *resumes* rather than
   re-creates.
3. **Pre-create reconciliation** — covers the one window layer 2 cannot: a worker that died between
   the vendor's HTTP response and our database write. `reference` is `flowvid:dub:{id}`, and
   `GET /v1/dubbing/project` is searched for it before spending. Best-effort by design.
4. **`UNIQUE(video_file_id, target_language, provider)`** — holds if the other three are bypassed.

Plus a **free silence pre-check**: `hasAudibleSpeech()` reads the already-computed `waveform_peaks`
and skips the dub entirely for a flat waveform, before any credits are spent. B-roll and screen
recordings hit this constantly.

### Concurrency: why not `localConcurrency`

The ceiling is **3 per workspace, across all tenants**. pg-boss's `localConcurrency` is a
**per-process** number — two worker containers each set to "one at a time" are two concurrent jobs.
A limit belonging to an *account* cannot live in a *process*.

`dubbing_slots` holds three fixed rows, claimed with `FOR UPDATE SKIP LOCKED LIMIT 1`. That is
atomic in a way "count the busy ones, then take one if there is room" is not. Slots are **leases**
that expire on their own, so a crashed worker costs one lease period rather than permanently
shrinking the pool. A worker finding none throws `DubSlotUnavailable`, the row stays `queued`
and unbilled, and the queue retries — which is why `retryLimit` is 8 rather than 2.

---

## 5. Cost metering, and the figure the UI shows

**The UI leads with `$2.20 per minute, per language`**, then shows a running total as languages are
ticked.

**Where it comes from:** vendor pricing page, automatic-without-watermark = **3,000 credits/min**
(the API default, and the 1.5× row — the expensive option is the one you get by not thinking about
it). The vendor's own headline is *"Dubbing v2 starting at $2.20 per minute"*. So
`DEFAULT_USD_PER_CREDIT = 2.20 / 3000`.

**$2.20 is deliberately the worst case.** Higher plans buy credits more cheaply (third-party
analyses put the effective range at $0.33–$2.20/min). An estimate that comes in *under* the invoice
is a bug; over it is a pleasant surprise. `DUBBING_USD_PER_CREDIT` overrides it once the account's
real rate is known, and every figure in the product moves with it.

Metering goes through the existing `UsageTrackingService` → `token_usage`: `provider:'elevenlabs'`,
`model:'dubbing_v2'`, zeros in the token columns, real money in `cost_cents` (already fractional).
The minutes are preserved in `task` as `dub:{lang}:{N.NNN}min`, because per-minute is what gets
reconciled against the invoice and a cents figure alone cannot be re-derived once the rate moves.
`video_dubs.billed_minutes` / `cost_cents` carry it per row too.

### The watermark gate

The vendor documents dubbing on every plan *"including the free plan"*, but free-plan dubs are
automatically watermarked, and a watermarked dub is not shippable. **The v2 surface exposes no
watermark field** — not on create, not on the language resource — so this cannot be read off a
response. It is a property of the plan the key belongs to, and therefore a **config fact**:

- `ELEVENLABS_DUBBING_WATERMARKED` — **defaults to `true`**, deliberately the inconvenient default.
  An unset variable blocks publication and someone notices; defaulting to `false` would silently
  ship watermarked video to real viewers, which is the failure nobody detects until a customer
  complains.
- A watermarked dub is still produced and stored (the credits are spent either way) but is written
  `status = 'failed'` with a plain-language reason, and `watermarked = true` on the row.
- `isDubServable()` — not `status === 'completed'` — gates **every** read path.
- The creator UI disables the run button and shows the reason.

**The owner still has to confirm the plan tier.** Setting `ELEVENLABS_DUBBING_WATERMARKED=false` is
the only thing standing between this feature and its first published dub.

---

## 6. Playback position across a language switch — NOT preserved

**Recommended default: restart from zero, which is what it does.**

Switching is a **full document load** (`window.location.assign`), not `router.push`. Two reasons:

1. The player owns live hls.js instances attached to two `<video>` elements. A soft navigation
   would hand the shell a new config while those attachments survive — the exact shape of bug where
   the picture changes and the audio does not. A real load rebuilds every media element.
2. `useRouter` requires a mounted app router and broke 11 existing tests.

Preserving position would need the offset written to the URL and the player seeking on mount.
**There is no initial-seek entry point today**: `useProjectPlayer` starts every segment at 0 and its
only seek path is the progress bar's pointer handler. Adding one is a real change to a
heavily-tested module and was out of scope here.

**Mitigation that costs nothing:** the switcher lives inside a menu the viewer must deliberately
open, so this is never an accidental click.

**If it is wanted later:** add `?t=` to the language URL, and an `initialSeekSec` prop on
`HLSPlayerShell` that seeks once on first `loadedmetadata`. Roughly a day including tests.

---

## 7. What remains unverified against the live API

Ranked by how much it would cost to be wrong.

1. **`POST /v1/dubbing/project` multipart field names and the create response.** The billable call.
   Typed from the OpenAPI document; never sent. If `reference` or `model_id` is rejected, the first
   dub fails loudly (good) — but if `reference` is silently *dropped*, defence layer 3 goes quiet
   without any error.
2. **Whether the target-transcript route accepts a v2 `project_id` + `language_id` pair and returns
   populated `translation` fields.** §3 argues strongly that it does. If not, every dub silently
   takes the Whisper fallback — captions still match the audio, but quality drops and nothing
   announces it. **Watch the `[dubbing] target transcript unavailable` warning on the first run.**
3. **The `GET /v1/dubbing/project` list shape** (`projects` / `has_more` / `next_cursor`). Only
   defence layer 3 depends on it, and it fails soft.
4. **`GET …/language` list shape** — both a bare array and an envelope are accepted, so this is
   probably already covered.
5. **Whether `outputs.lossless_audio` is WAV.** It is stored as `audio/wav` and ffmpeg is
   format-agnostic on input, so a different container works; only the stored content-type would be
   wrong.
6. **Per-language billing multiplication** — the brief flags this as an inference, not an explicit
   vendor statement. **Confirm on the first two-language job before trusting a quota projection.**
7. **What a speechless source returns.** Guarded by the waveform pre-check, not by knowledge.
8. **Whether deletion refunds credits.** Assumed not.
9. **The `too_many_concurrent_requests` error body.** Matched by substring; the slot pool should
   mean it is never seen.
10. **Webhooks — not implemented.** Polling only. `webhook_ids[]` is typed on the create request but
    unused, since the payload schema is unpublished. Documented seam.

**Also deliberately not depended on:** the classic surface. `video_dubs.el_dubbing_id` exists as the
documented seam and nothing writes it.

---

## 8. Shared files touched — the merge-conflict surface

Ordered by likelihood of conflict.

| File | Change | Risk |
|---|---|---|
| `backend-api/src/db/migrate.ts` | one entry appended: `'067_video_dubs.sql'` | **Likely** — every branch adding a migration touches this line. Trivial to resolve; keep all entries, sorted. |
| `backend-api/src/services/permalinkService.ts` | **added below** `RESERVED_SLUGS`, which is untouched | **Low** — `feat/library-share-impl` edits the set's *contents*; this appends a new export after it. |
| `backend-api/src/db/schema.ts` | two tables appended at end of file | **Low** — append-only. |
| `backend-api/src/server.ts` | one import + one `registerDubbingRoutes(app)` | **Low** — two adjacent lines. |
| `shared/src/generated/client-v1.ts` | 4 interfaces + 3 methods appended | **Low** — hand-maintained and drifts silently (CLAUDE.md §5), so it is updated here. |
| `backend-api/src/queue/{types,registry,pgBoss,pgBossDriver}.ts` | one `dub` entry in each of 6 exhaustive maps | **Low** — the maps are exhaustive by type, so a conflict fails the build rather than going quiet. |
| `deploy/docker-compose.yml` | `dub` appended to `WORKER_QUEUES` | **Low** — one line. Required: `deployTopology.test.ts` asserts every queue has exactly one consumer, and caught this. |
| `backend-api/src/scripts/check-db.ts` | one migration entry | **Low** |
| `backend-api/src/services/captions/CaptionService.ts` | 3 helpers changed from private to `export` | **Low** — no behaviour change. |
| `backend-api/src/services/buildPlayerConfig.ts` | optional 4th param, dub lookup, 2 emitted fields | **Medium** — hot file, but all changes additive. |
| `client-web/components/viewer/{ControlsBar,HLSPlayerShell,SharedViewerPage,types.ts,viewer.css}` | switcher + plumbing | **Low** — confirmed no overlap with the other two branches. |
| `client-web/components/ProjectSettingsPanel.tsx` | sub-page + entry card | **Low** — confirmed no overlap. |
| `client-web/app/v/[shareToken]/page.tsx` | reads `?lang=` | **Low** |
| 4 × `buildPlayerConfig.*.test.ts` | `video_dubs` added to hand-built `db.query` mocks | **Low** — mechanical. |
| `backend-api/src/queue/__tests__/singletonPolicy.test.ts` | one sample payload | **Low** |

**New files** (no conflict risk): the migration pair, `services/dubbing/*` (6 files),
`captions/transcribeAudioFile.ts`, `controllers/v1/dubbing.controller.ts`,
`client-web/components/dubbing/DubbingSettings.tsx`, `client-web/app/[slug]/[lang]/page.tsx`,
and 5 test files.

### On `RESERVED_SLUGS` specifically

Language codes are **not** added to it, and that is deliberate. They appear only as *second* path
segments (`/{slug}/he`), so reserving them at the top level would forbid a perfectly good permalink
(`/en` for a project about England) to prevent a collision that cannot occur. Instead
`PERMALINK_LANGUAGE_SUFFIXES` and `isDubbingLanguageSuffix()` are exported so any future
`/{slug}/{something}` route can check whether a name is already spoken for by a translation.

**`feat/library-share-impl` adds `app/[slug]/library/**`.** These coexist: `/[slug]/[lang]`
validates against a closed three-code set and 404s anything else, and Next.js prefers the static
`library` segment over the dynamic `[lang]` one. No change to their branch is needed.

---

## 9. Test results

Run on this branch, all green.

| Suite | Result |
|---|---|
| `pnpm -w typecheck` (all 6 packages) | **PASS** |
| `backend-api` full suite | **3,634 passed / 18 skipped / 247 files** |
| `client-web` full suite | **1,621 passed / 87 files** |
| `backend-api` queue suites | **58 passed** |
| `migration067.test.ts` | **19 passed** |
| `services/dubbing` (core + client) | **54 passed** |
| `dubbing.routes.test.ts` | **16 passed** |
| `buildPlayerConfig.*` (5 files, incl. new dubs) | **92 passed** |
| `viewerLanguageSwitcher.test.tsx` | **20 passed** |

**New tests: 109.** Nothing left failing at any point — both full suites are green on the final tree.

### Two tests that earned their place

- **`deployTopology.test.ts`** failed on `{ queue: 'dub', consumers: 0 }` — the new queue had no
  consumer in `docker-compose.yml`. Exactly the drift it was written to catch.
- **`singletonPolicy.test.ts`** failed on an exhaustive payload map, forcing an explicit answer to
  "do two sends of this mean one piece of work?" (yes — keyed on `dubId`, `short` policy).

### One thing PGlite cannot prove

`migration067.test.ts` does **not** assert that `FOR UPDATE SKIP LOCKED` excludes a concurrent
claimer. PGlite is a single in-process Postgres with one connection — there is no second session to
be excluded, and a nested query inside an open transaction deadlocks against itself rather than
skipping. Re-verifying it would be testing Postgres, not this migration. What *is* asserted is the
free-slot predicate: a held-and-unexpired slot is not re-offered, an expired lease is, and a full
pool offers nothing.

---

## 10. Configuration the owner must set

| Variable | Default | Meaning |
|---|---|---|
| `ELEVENLABS_DUBBING_WATERMARKED` | **`true`** | **Must be set to `false` before any dub can be published.** See §5. |
| `DUBBING_USD_PER_CREDIT` | `2.20/3000` | The account's real per-credit rate. Sharpens every estimate. |
| `DUBBING_NUM_SPEAKERS` | `1` | Explicit speaker count removes a class of diarization failure for single-presenter lessons. |
| `DUBBING_SOURCE_LANGUAGE` | unset (auto-detect) | Region subtags are stripped — the vendor ignores them on source. |
| `ELEVENLABS_API_KEY` | — | Already wired; `ApiKeyService`'s admin-managed key takes precedence. |

`WORKER_QUEUES` already includes `dub` in `deploy/docker-compose.yml`.

---

## 11. Known gaps

1. **Webhooks not implemented** — polling only, per §7.10.
2. **No per-user budget gate.** Dubbing is the most expensive per-unit operation in the product and
   `AvatarBudgetService` is the in-repo precedent for capping spend. The cost is metered and shown
   before the run, and the run needs `editableProject`, but there is no ceiling.
   **This should exist before the feature reaches untrusted users.**
3. **HLS tree deletion is partial.** Deleting a dub removes the audio, the muxed MP4 and the HLS
   master (making the rendition unplayable), but the segment objects need the storage sweep. The
   adapter deletes by key, not by prefix.
4. **A language is all-or-nothing per project.** Offered only when *every* main video has a servable
   dub. Correct for viewers; a creator with one failed lesson sees the language disappear for
   everyone until it is retried. The creator UI shows the per-video truth (`3/4`).
5. **Playlists have no language dimension.** `/{slug}/{lang}` serves projects only.
6. **`stale` is modelled but never set.** The vendor sets it when a transcript is edited; nothing in
   this product edits one, so no code path produces it. Reads treat it correctly (not servable).
