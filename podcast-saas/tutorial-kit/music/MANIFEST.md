# Welcome-film music — manifest

Five music beds for the FlowVid "Welcome" films plus the SFX pack, **generated with ElevenLabs
Music v1 (`POST /v1/music`) and ElevenLabs Sound Generation (`POST /v1/sound-generation`) through
the owner's ElevenLabs Creator account on 2026-09-05; commercial use is covered by that plan's
terms.** The pure-synthesis engine `synthesize.mjs` remains the keyless regenerable fallback: its
v2 beds were moved, byte-for-byte, to `synth-v2/`. `sting-ambient.wav` is untouched (v1 bytes,
sha256 `3fa3b4c3…0d57`).

All files: 48 000 Hz · stereo · 24-bit PCM WAV. Beds are normalized to **−27 LUFS integrated
(±0.5)** with ffmpeg `loudnorm` two-pass in linear mode (true peak ≤ −1 dBTP); SFX to **−20 LUFS**
with a peak-safe linear gain (−1 dBTP ceiling). The assembler (`assembly/assemble-film.mjs`) trims
each bed to its film's length, ducks it −97 % inside the live windows, fades the last 1.2 s and mixes
the −19 LUFS narration on top — so every bed is deliberately longer than its film and everything
after the film's end is never heard.

**Lengths are a moving target.** Film totals come from the assembler's derived timelines
(`assembly/work/film*/timeline.json`), and they change with every script re-cut and VO re-record:
film 1 alone read 59.25 → 62.93 → 61.90 s inside one hour on 2026-09-05. A bed longer than its film
costs nothing (it is trimmed); a bed that ends early is fatal and needs regenerating. So selection
requires **body ≥ film + 3 s** and prefers **≥ film + 5 s** (`VO_DRIFT` = 2 s in the generator), and
the film-1 row of the table carries the largest total observed rather than the latest. Actual margins
are 7.9–19.5 s: every bed survives a re-time of several seconds without being touched.

## Beds

| File | Duration | Margin over film | Integrated | True peak | LRA | BPM (as prompted) | Key | Character | Prompt used |
|---|---|---|---|---|---|---|---|---|---|
| `bed-teaser.wav` — film 1 "Touch This Video" (62.93 s) | 70.83 s | +7.90 s | −27.0 LUFS | −15.2 dBTP | 1.2 LU | 120 | A minor | Punchy kinetic opener: riser into the drop with the kick landing at **0:04.0**, on film 1's first live window (head aligned, see below), momentum lifts every 8 bars, wide-open peak for the 0:35–0:45 montage, hard button ending. | take 3 · P-teaser below |
| `bed-tutorial.wav` — film 2 "Make Yours" (86.71 s) | 106.24 s | +19.53 s | −27.0 LUFS | −16.8 dBTP | 0.6 LU | 100 | D minor | Continuous, narration-friendly: bass and drums lead, sparse mids, one layer added or swapped every 8 bars, no breakdowns, soft button ending. | take 6 · P-tutorial |
| `bed-heavy.wav` — film 3 "Drop In Anything" (53.10 s) | 62.98 s | +9.88 s | −27.0 LUFS | −15.2 dBTP | 0.7 LU | 108 | E minor | Confident, practical, chunky groove: extra kick on the and-of-3, on-beat stabs, lift every 8 bars, fuller peak 0:36–0:48, tight button ending. | take 3 · P-heavy |
| `bed-powers.wav` — film 4 "Viewer Superpowers" (59.19 s) | 74.33 s | +15.14 s | −27.0 LUFS | −13.6 dBTP | 2.6 LU | 114 | C major | Playful, bright, plucky: hook from the first beat, lift every 8 bars, peak 0:42–0:54, button ending with a small upward flourish (a pause before that flourish sits at 68–74 s, beyond the film). | take 3 · P-powers |
| `bed-share.wav` — film 5 "One Link, Three Doors" (45.45 s) | 58.28 s | +12.83 s | −26.9 LUFS | −10.7 dBTP | 1.3 LU | 100 | F major | Warm but forward: pluck arps and strummed synth chords over a soft four-on-the-floor, lift every 8 bars, resolves on a sustained final chord with a short ring. | take 1 · P-share |
| `sting-ambient.wav` (unchanged) | 8.00 s | — | −24.0 LUFS | −12.0 dBTP | 15.9 LU | rubato | F (Fmaj9) | Standalone ambient sting from v1 — synthesized, not ElevenLabs. Also the seeded demo project's A2 asset. | — |

Measured with ffmpeg 8.1.2 `ebur128=peak=true` on the shipped WAVs (2026-09-05); the same figures
are reprinted by `generate-elevenlabs.mjs` and stored, per take, in `takes/report.json`.

### Prompts used (verbatim, from the chosen takes' `takes/<bed>-take<N>.request.json`)

Every request: `model_id: "music_v1"`, `force_instrumental: true`, `?output_format=mp3_44100_192`;
`music_length_ms` = 1.25 × the target length (see "What the API did" below).

- **P-teaser** (take 3, `music_length_ms` 78000): "Punchy, kinetic modern electronic music for a tech
  product launch film — the energy of an Apple, Linear or Figma launch video. 120 BPM, key of A minor,
  dark-bright. Four-on-the-floor kick with a driving sidechained synth bass, tight claps and hi-hats,
  punchy filtered synth stabs, wide analog chords. Structure: opens with a 2-second noise riser and
  pitch sweep with no drums, then a confident drop exactly at 0:02 where the kick and bass hit
  together; momentum lifts every 8 bars with added layers; a big, open, high-energy section from 0:35
  to 0:45 with wide chords and full percussion; then back to the driving groove, ending with a hard
  clean button hit on the downbeat — a sudden stop, no fade-out. Dynamics: the first groove after the
  drop is smaller and quieter (kick, bass and one filtered stab); every 8-bar lift adds a layer and
  more loudness, so the energy clearly grows into the wide-open peak at 0:35–0:45, which is the
  loudest part. Drums and bass keep going in every section — never a dropout, never a breakdown to
  silence — right up to the final hit. Instrumental only, no vocals, no singing, no spoken word. No
  lo-fi hip hop, no ukulele, no acoustic guitar, not corporate stock music. Clear downbeats throughout."
- **P-tutorial** (take 6, 110000): "Continuous, driving, narration-friendly modern electronic music
  bed for a software tutorial film — a steady evolving groove that can run under a narrator for 90
  seconds. 100 BPM, key of D minor. Bass and drums lead: a moving eighth-note synth bass with a steady
  four-on-the-floor kick, tight hi-hats and soft claps; sparse midrange so a voice can sit on top — no
  lead melody, only short rhythmic plucks and low filtered chords. Structure: the groove is established
  from the first beat and never stops; every 8 bars one layer is added or swapped (plucks, then
  filtered pads, then brighter hats) so it keeps evolving, a fuller final stretch, and a soft button
  ending — one clean final hit with a short ring, no long fade-out. Continuity is essential: no drops,
  no breakdowns, no silent bar, no pause before the final section — the kick and bass play through
  every single bar from the first beat to the final hit. Instrumental only, …" (same closing sentence).
- **P-heavy** (take 3, 69000): "Confident, practical, chunky modern electronic groove for a product
  feature film. 108 BPM, key of E minor. Heavy four-on-the-floor kick with an extra kick on the
  and-of-3, chunky square-shouldered synth bass, tight claps and hats, short on-beat synth chord stabs,
  subtle risers into each section. Structure: groove from the first beat, a momentum lift every 8
  bars, a fuller peak section from 0:36 to 0:48, then a tight clean button ending — one final hit on
  the downbeat and a sudden stop, no fade-out. Dynamics: the opening groove is stripped back and
  quieter (kick, chunky bass, one stab under a low-pass filter); every lift adds a layer and more
  loudness, so the energy clearly grows to the peak, which is the loudest part. Drums and bass keep
  going in every section — never a dropout, never a breakdown to silence — right up to the final hit.
  Instrumental only, …"
- **P-powers** (take 3, 78000): "Playful, bright, energetic modern electronic music for a fun product
  feature film. 114 BPM, key of C major. Bouncy four-on-the-floor kick, octave-bouncing synth bass,
  bright plucky synths and pizzicato-style synth plucks, snappy claps and crisp hats, cheerful synth
  stabs with occasional pitch-bend bloops. Structure: the hook is in from the first beat, a momentum
  lift every 8 bars, a fuller peak section from 0:42 to 0:54, then a button ending with a quick small
  upward synth flourish on the final hit and a clean stop, no fade-out. Dynamics: the opening is
  lighter and quieter (kick, bouncing bass and the pluck hook); every lift adds a layer and more
  loudness, so the energy clearly grows to the peak, which is the loudest part. Drums and bass keep
  going in every section — never a dropout, never a breakdown to silence — right up to the final hit.
  Instrumental only, …"
- **P-share** (take 1, 60000 — the round-1 wording, without the "Dynamics" sentence): "Warm but
  forward modern electronic music for a product film about sharing. 100 BPM, key of F major. Plucked
  and arpeggiated synths (warm pluck arps, gentle strummed synth chords), a soft steady
  four-on-the-floor kick, round warm bass, light hats and soft claps. Structure: arpeggio and pulse
  from the first beat, a momentum lift every 8 bars getting brighter and fuller, then the final
  progression resolves cleanly on a sustained final chord with a short natural ring — a clean stop,
  no long fade-out. Instrumental only, …"

The current table in `generate-elevenlabs.mjs` carries the latest wording of each prompt (the
tutorial's continuity version, the "Dynamics" sentence elsewhere); a fresh run reproduces the recipe,
not the bytes — the model is stochastic.

### How each take was chosen (by measurement; nothing was auditioned)

Gates, per take: body (non-silent length) ≥ film + 3 s · no silence > 1 s (`silencedetect −40 dB`)
inside the audible film + 3 s · true peak ≤ −1 dBTP · `loudnorm` stayed linear · integrated within
−27 ± 0.5. Then: LRA inside 3–9 LU (10 pts per LU outside) and any shortfall against the drift-safe
length film + 3 + `VO_DRIFT` (20 pts per second). **Being longer than needed is never penalized** —
the assembler trims, so the only length risk is ending early. Full numbers per take:
`takes/report.json`; raw audio: `takes/*.mp3`.

| Bed | Takes | Chosen | Why |
|---|---|---|---|
| teaser | 3 (all prompt; the plan take was refused — 2 s riser under the API's 3 s section floor — and fell back to prompt) | **3** | Take 2's body is 63.06 s: it clears today's 65.93 s gate only if film 1 stops moving, and film 1 is still moving. Take 1 vs 3 both drift-safe → LRA 0.5 vs 1.2 → 3 (score 18 vs 25). |
| tutorial | 6 | **6** | 1: 7.8 s near-silent breakdown at 38–46 s. 2 (plan): music stopped at 58 s of 88. 3 and 4: a silent bar at 59.9–61.8 / 55.5–57.6 s (inside the 86.7 s film). 5 and 6 (continuity prompt): clean; 6 has the higher LRA (0.6 vs 0.3), body 106.2 s. |
| heavy | 3 | **3** | 2 (plan): body 53.7 s < 56.1 gate. 1 vs 3 near tie (LRA 0.6 vs 0.7, bodies 62.6 vs 63.0) → 3 (23 vs 24). |
| powers | 3 | **3** | 2 (plan): body 62.0 s < 62.2 gate, plus silence 55.3–60.0 s inside the film. 3: LRA 2.6 (closest to the window) vs take 1's 1.5; its pre-flourish pause at 68.2–73.7 s lies beyond the 62.2 s audible region. |
| share | 3 | **1** | 2 (plan): music over at 39.7 s of 48. 3 is a big arc (LRA 11.7: −39 → −24 LUFS over 32 s) — too much movement under speech and near-inaudible for its first 8 s; 1 is steady at −27 (LRA 1.3): 1.7 LU outside the window beats 2.7. **Take 3 is the alternative if a bed that grows door-by-door is wanted** (`takes/bed-share-take3.wav`, already normalized). |

**Known deviation — LRA.** No shipping bed reaches the 3–9 LU window (0.6–2.6 LU). Across 19 takes
the generator mastered flat — momentary loudness pinned to −27 for a whole minute (LRA 0.3–2.9),
with the only exceptions being takes with a hole (15.6) or a slow build from near-silence (11.7,
8.1) — and the explicit "quieter opening → loudest peak" wording changed nothing. The beds move
through arrangement (layers, stabs, lifts) rather than level, which is also the safest behaviour under
a −19 LUFS narrator. A fader-automation arc (bed lower under dense narration, blooming at the teaser
montage) could be added as a deterministic post-process if the owner wants measurable movement; it
was not done here because it would manufacture the metric.

### Head and tail processing

- **Drop alignment (teaser only).** The generator renders "a 2-second riser" as a 7.9 s intro. The
  kick's first sustained arrival is detected in the sub-150 Hz band (a riser has no sub; a
  four-on-the-floor drop is all sub) and the head is trimmed (3.9 s) so it lands at **4.0 s** —
  the moment film 1's first live window opens and the assembler ducks the bed −97 %. What remains
  before it is the riser's last 4 s. A broadband-loudness detector fired 0.9 s early on the riser's
  own crest; hence the low band. Measured on the shipped file: the kick band jumps −59 → −21 dBFS
  at 4.00 s.
  **`dropAt` must track `seeding/layout-v3.json`.** The window moved from [2,10] to [4,12] in the
  v3.1 re-cut; a bed still aligned to 2.0 s would fire its crest two seconds before the window and
  be ducked as it arrives. If that window moves again, change `dropAt` and re-run — no new
  generation is needed, the trim is applied at normalize time from the cached master.
- **Leading digital silence** (> 0.1 s at −50 dB) is removed so beds start at level on frame 0
  (only powers take 3 had any: 2.1 s).
- **Trailing digital silence** is cut to 0.3 s (the model ends early and pads with silence), so a
  file's duration is its musical length; the hard button endings are intact.

## SFX (`sfx/`)

Generated with `POST /v1/sound-generation` (`prompt_influence` as listed, `?output_format=mp3_44100_192`),
trimmed to the exact length (leading silence removed, 20 ms fade at the cut), normalized to −20 LUFS
(integrated, measured with 2 s of padding so the gate has something to gate) with a peak-safe linear
gain — no limiter on transients. Quiet by design; the films must not feel overwhelming.

| File | Duration | Integrated | True peak | Prompt (influence) | Notes |
|---|---|---|---|---|---|
| `ui-click.wav` | 0.40 s | −20.0 LUFS | −2.7 dBTP | "A single soft, modern app UI click — one short clean gentle tap, subtle, dry, no reverb, no echo." (0.6) | API floor is 0.5 s; generated 0.5, trimmed to 0.4. One clean transient. |
| `whoosh-in.wav` | 0.68 s | −20.0 LUFS | −5.2 dBTP | "A quick, light, airy whoosh swishing in — soft air movement rising into place, short, clean, no impact, no rumble." (0.5) | API returned 0.68 s for a 0.7 s request. Fast onset, 0.6 s decay into place. |
| `whoosh-out.wav` | 0.68 s | −20.0 LUFS | −5.7 dBTP | "A quick, light, airy whoosh swishing away — soft air movement falling off and disappearing, short, clean, no impact, no rumble." (0.5) | Faster decay (0.3 s), brightness rising as it leaves. |
| `riser-1200ms.wav` | 1.20 s | −20.0 LUFS | −15.8 dBTP | "A short tonal noise riser: a smooth filtered noise sweep rising in pitch for one second, ending on a soft gentle hit — tasteful, cinematic, not loud, no long tail." (0.5) | Centroid climbs 1.8 → 11.6 kHz over 1.15 s, then the soft hit. Plays when the bed returns after a live window (CREATIVE-DIRECTION v3 M4). |
| `chime-generate.wav` | 0.88 s | −20.0 LUFS | −7.6 dBTP | "A success chime made of exactly two short bell notes played one after the other, 'ding-ding', the second note higher than the first (a fifth up). Two separate clean glassy synth-bell notes, bright and pleasant, modern app notification, short tails, no reverb wash." (0.85) | **Composed:** two rolls came back as one bell note, so the second note is the same note pitched a fifth up (resample ratio 2^(7/12)) entering 220 ms later — see `compose` in the table. Two attacks, centroid 2.9 → 6.1 kHz. |
| `type-burst.wav` | 1.48 s | −20.3 LUFS | −1.0 dBTP | "A quick mechanical keyboard typing burst — fast tactile keystrokes for one and a half seconds, close-miked, clean, no room echo." (0.6) | Peak-limited: the −1 dBTP ceiling is reached 0.3 LU before −20. Keystrokes occupy the first ~1.0 s. |

## What the API did (2026-09-05, Creator tier)

- `POST /v1/music` with `{ prompt, music_length_ms, model_id: "music_v1", force_instrumental: true }`
  and `?output_format=mp3_44100_192` → 200 `audio/mpeg` (192 kbps) every time.
- **Rejected:** `force_instrumental` together with `composition_plan` — 422 "`force_instrumental`
  can only be used with `prompt`" (the script omits it in plan mode; a plan whose sections carry no
  `lines` is instrumental anyway). `composition_plan.sections[].duration_ms` outside **3000–120000**
  → 422 (the 2 s riser section had to become 3 s). Nothing else was refused.
- **Length is a ceiling, not a length.** Prompt mode filled 84–97 % of `music_length_ms` (a 48 s
  request gave 40.3 s of music), so prompt takes request 1.25× the target. Plan mode, despite exact
  section durations, filled worse (an 88 s plan stopped at 58 s; a 62 s plan went silent 55–60 s
  before its flourish) — all four plan takes were disqualified, and new takes default to prompt mode.
- **Credits** (`GET /v1/user/subscription`, `character_count`): 289 → 25 010 of 194 830 over the
  session, i.e. **24 721 credits** for one `/v1/music/plan` call, 19 music generations (18 candidate
  takes + one superseded 48 s probe), and 7 SFX generations (≈ 13.8 credits per second of music).
  The 289 was read by hand before anything was generated; `takes/report.json`'s ledger starts at
  1 781 because the plan probe (289 → 1 037) and the superseded 48 s probe take (1 037 → 1 697) ran
  before the first logged run. The counter posts asynchronously, so per-run deltas do not sum exactly.

## Files

```
music/
  bed-*.wav                 the five shipped beds (gitignored, like every WAV here)
  sting-ambient.wav         unchanged v1 sting
  sfx/*.wav                 the SFX pack
  takes/<bed>-take<N>.mp3   raw API audio — the irreplaceable masters (a re-run without --force
                            re-normalizes from these and spends nothing)
  takes/<bed>-take<N>.request.json   exact request per take;  takes/<bed>-take<N>.wav  normalized candidates
  takes/sfx-*.mp3 (+ .request.json, .trim.wav, .composed.wav)
  takes/report.json         every measurement, score and choice; the credit ledger per run
  synth-v2/bed-*.wav        the previous synthesized beds (keyless fallback; `node synthesize.mjs` re-renders them)
  .gitignore                synth-v2/*.wav, sfx/*.wav, takes/ — the kit's root rule covers music/*.wav only
```

`takes/` is ~400 MB and gitignored; the raw MP3s in it cannot be regenerated identically. Back them
up if the takes matter beyond this machine.

## Regenerate / verify

```bash
# key in a JSON file OUTSIDE the repo: {"xi_api_key": "..."}  — never in the env, never on a command line
node generate-elevenlabs.mjs --auth /path/to/el-auth.json                 # re-normalize + re-select from cached takes (no credits)
node generate-elevenlabs.mjs --auth … --only bed-share --takes 4          # one more take for one bed
node generate-elevenlabs.mjs --auth … --only chime-generate --force       # re-roll one SFX
node generate-elevenlabs.mjs --auth … --force                             # everything from scratch (~25 k credits)
node generate-elevenlabs.mjs --dry-run                                    # print the table, call nothing

node synthesize.mjs --outdir=synth-v2      # keyless fallback: re-render the synthesized beds

# verify:  ffmpeg -i <file> -af ebur128=peak=true -f null -     (Summary: I / LRA / True peak)
#          ffprobe -show_entries stream=sample_rate,channels,codec_name:format=duration <file>
```

Verified 2026-09-05 with ffmpeg/ffprobe 8.1.2, film lengths re-read live from the assembler's
timelines: all twelve files 48 kHz / 2 ch / pcm_s24le; beds −27.0 LUFS (share −26.9), true peak
−16.8 … −10.7 dBTP, no silence > 1 s inside any film's audible span, margins over the films
7.90 / 19.53 / 9.88 / 15.14 / 12.83 s (all ≥ 5 s, so all survive a 2 s re-time with ≥ 3 s to spare);
`bed-teaser` kick onset measured at 4.00 s against film 1's 4.0 s window; SFX −20.0 LUFS
(type-burst −20.3), true peak ≤ −1.0 dBTP; `sting-ambient.wav` bytes unchanged.
