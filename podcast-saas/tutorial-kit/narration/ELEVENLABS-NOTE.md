# Production narration — ElevenLabs

Last run: 2026-09-05T18:37:20.682Z · `synthesize-elevenlabs.mjs` · 0 synthesized, 48 kept, 0 failed · 48 lines in lines.json, 48 on record

The pick and the audition behind it: `AUDITION-EL.md`. The same files, made by the free Edge voices, are the fallback
(`audio-edge/`, see the end). Nobody who produced this could hear it; every number below is a measurement.

## Runs (this manifest)

| when | scope | synthesized | requests | chars sent | vendor ledger (character-cost Σ) |
|---|---|---|---|---|---|
| 2026-09-05T13:11:45.498Z | all --force | 48 | 58 | 4168 | 2291 |
| 2026-09-05T13:16:47.509Z | f2-s2, f3-s5 --force | 2 | 6 | 585 | 321 |
| 2026-09-05T13:19:19.857Z | f2-s2, f3-s5 --refit | 2 | 4 | 375 | 205 |
| 2026-09-05T13:21:38.262Z | all | 0 | 0 | 0 | — |
| 2026-09-05T18:23:30.856Z | all | 17 | 20 | 1437 | 791 |
| 2026-09-05T18:26:59.953Z | f1-s4, f3-s5 --refit | 2 | 3 | 233 | 127 |
| 2026-09-05T18:29:13.186Z | all | 0 | 0 | 0 | — |
| 2026-09-05T18:34:29.296Z | all | 2 | 2 | 126 | 69 |
| 2026-09-05T18:35:57.893Z | all | 0 | 0 | 0 | — |
| 2026-09-05T18:36:23.279Z | all | 0 | 0 | 0 | — |
| 2026-09-05T18:37:20.682Z | all | 0 | 0 | 0 | — |

## Voices, model, settings

- Liam `TX3LPaxmHKxFdv7VOQHJ` (narrator)
- Sarah `EXAVITQu4vr4xnSDxMaL` (viewer)
- model: `eleven_multilingual_v2`
- voice_settings (narrator · multilingual_v2): `{"stability":0.45,"similarity_boost":0.8,"style":0.4,"use_speaker_boost":true,"speed":1.05}`
- voice_settings (viewer · multilingual_v2): `{"stability":0.45,"similarity_boost":0.8,"style":0.4,"use_speaker_boost":true,"speed":1}`
- output `mp3_44100_128`; previous_text / next_text = neighbouring lines of the same film and role; endpoint with-timestamps
- spoken text = lines.json text for every clip (no punctuation overrides needed)

## Per film

"narration s" is the sum of the clips as the assembler measures them (ffprobe). "over" = seconds a clip runs
past its budget (slot − 0.5s pad); the assembler stretches that scene, so a film longer than its target
is explained here, not in the edit. Clips over by more than 0.8s were refit (see below).

| film | title | clips | narration s | viewer s | words | wpm | target s | slots s | model | chars sent (incl. retakes) | clips over budget |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Touch This Video | 10 | 44.5 | — | 115 | 155 | 58 | 58 | multilingual_v2 | 928 | f1-s3 +0.21s, f1-s4 +0.08s, f1-s7 +0.78s, f1-s10 +0.70s |
| 2 | Make Yours | 12 | 71.8 | — | 174 | 145 | 83 | 83 | multilingual_v2 | 1589 | f2-s1 +0.24s, f2-s2 +0.63s, f2-s3 +0.78s, f2-s5 +0.21s, f2-s7 +0.77s, f2-s10 +0.42s |
| 3 | Drop In Anything | 8 | 41.5 | — | 89 | 129 | 51 | 51 | multilingual_v2 | 1227 | f3-s4 +0.68s, f3-s5 +0.13s |
| 4 | Viewer Superpowers | 11 | 39.3 | 2.2 | 84 | 128 | 57 | 51 | multilingual_v2 | 798 | f4-s1 +0.38s, f4-s4 +0.17s, f4-s6 +0.57s, f4-s7 +0.33s |
| 5 | One Link, Three Doors | 7 | 37.3 | — | 84 | 135 | 45 | 45 | multilingual_v2 | 587 | f5-s5 +0.45s |

Characters of text sent for the current set: **5129** (every attempt counted, incl. retakes; 69 generations for 48 clips). This run: 0 chars sent, quota counter moved 0.
Quota after this run: 25997/194830 used, **168833 remaining** (tier creator, resets 2026-09-22T15:05:09.000Z).

How the vendor meters this (measured 2026-09-05): every response carries a `character-cost` header, and `/v1/history` records
exactly that figure per generation — ≈0.55 per character of text sent on this account for these models. The
`/v1/user/subscription` counter is batch-updated (it read 289 at the start of the session while the history already held ~12k of
earlier use on the same key) and the key is shared, so the counter cannot meter one run; the ledger can.

## Over-slot clips and what was done

Rule: a clip more than 0.8s over its budget is trimmed to its words (80ms before the first, 200ms after the last, by the
alignment the API returns — never a word), then retaken faster (speed ≤ 1.12), each take trimmed, the shortest kept.
Nothing inside tolerance is touched, so most clips carry the 0.2–0.9s tail the voice delivered; the assembler pads 0.5s anyway.

- **f1-s1** (1.11s raw → 1.11s, budget 3.5s, now inside): loudnorm linear -23.39 → -18.99 LUFS (gain +4.39 dB, TP -4.33 dBTP)
- **f1-s2** (5.67s raw → 5.67s, budget 7.5s, now inside): loudnorm linear -23.73 → -20.74 LUFS (gain +3.13 dB, TP -3.02 dBTP); target backed off 1.6 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly
- **f1-s3** (4.32s raw → 3.71s, budget 3.5s, now +0.21s over): trim by alignment 4.32→3.71s · loudnorm linear -24.74 → -20.52 LUFS (gain +3.74 dB, TP -3.05 dBTP); target backed off 2.0 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly
- **f1-s4** (5.39s raw → 3.58s, budget 3.5s, now +0.08s over): trim lead/tail silence 5.39→4.55s · loudnorm linear -24.74 → -22.65 LUFS (gain +1.94 dB, TP -3.05 dBTP); target backed off 3.8 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly · --refit pass · retake 1 at speed 1.12 (+53 chars) · trim by alignment 3.67→3.58s · loudnorm linear -24.46 → -20.47 LUFS (gain +3.86 dB, TP -3.03 dBTP); target backed off 1.6 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly
- **f1-s5** (3.39s raw → 3.39s, budget 4.5s, now inside): loudnorm linear -26.19 → -20.01 LUFS (gain +5.79 dB, TP -3.07 dBTP); target backed off 1.4 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly
- **f1-s6** (5.76s raw → 5.76s, budget 7.5s, now inside): loudnorm linear -24.07 → -24.01 LUFS (gain +0.27 dB, TP -3.11 dBTP); target backed off 4.8 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly
- **f1-s7** (3.76s raw → 3.28s, budget 2.5s, now +0.78s over): trim by alignment 3.76→3.28s · loudnorm linear -25.01 → -19.25 LUFS (gain +5.51 dB, TP -3.23 dBTP); target backed off 0.5 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly
- **f1-s8** (10.82s raw → 8.44s, budget 8.5s, now inside): trim by alignment 10.82→10.21s · retake 1 at speed 1.12 (+125 chars) · trim by alignment 10.31→9.74s · retake 2 at speed 1.12 (+125 chars) · trim by alignment 8.92→8.44s · loudnorm linear -25.39 → -23.37 LUFS (gain +1.69 dB, TP -3.07 dBTP); target backed off 4.7 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly
- **f1-s9** (3.39s raw → 3.39s, budget 6.5s, now inside): loudnorm linear -24.19 → -21.54 LUFS (gain +2.69 dB, TP -3.06 dBTP); target backed off 2.5 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly
- **f1-s10** (6.32s raw → 6.20s, budget 5.5s, now +0.70s over): trim by alignment 6.32→6.20s · loudnorm linear -24.65 → -22.01 LUFS (gain +2.55 dB, TP -3.08 dBTP); target backed off 3.1 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly
- **f2-s1** (7.01s raw → 5.74s, budget 5.5s, now +0.24s over): trim lead/tail silence 7.01→6.41s · re-synth speed 1.05→1.12 (+85 chars) · trim 6.32→5.74s · loudnorm linear -24.75 → -21.18 LUFS (gain +3.35 dB, TP -3.08 dBTP); target backed off 2.4 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly
- **f2-s2** (8.54s raw → 7.13s, budget 6.5s, now +0.63s over): trim by alignment 8.54→8.00s · retake 1 at speed 1.12 (+105 chars) · trim by alignment 8.59→8.00s · retake 1 not shorter — kept the 8.00s take · retake 2 at speed 1.12 (+105 chars) · trim by alignment 8.13→7.47s · --refit pass · retake 1 at speed 1.12 (+105 chars) · trim by alignment 7.71→7.13s · loudnorm linear -24.4 → -21.13 LUFS (gain +3.3 dB, TP -3.08 dBTP); target backed off 2.1 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly
- **f2-s3** (7.80s raw → 6.28s, budget 5.5s, now +0.78s over): trim by alignment 7.80→7.28s · retake 1 at speed 1.12 (+86 chars) · trim by alignment 6.55→6.28s · loudnorm linear -23.87 → -20.67 LUFS (gain +3.37 dB, TP -3.11 dBTP); target backed off 1.5 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly
- **f2-s4** (5.67s raw → 5.67s, budget 7.5s, now inside): loudnorm linear -24 → -21.07 LUFS (gain +2.8 dB, TP -3.02 dBTP); target backed off 2.2 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly
- **f2-s5** (7.71s raw → 7.71s, budget 7.5s, now +0.21s over): loudnorm linear -24.48 → -20.52 LUFS (gain +3.48 dB, TP -3.12 dBTP); target backed off 2.0 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly
- **f2-s6** (5.15s raw → 5.15s, budget 7.5s, now inside): loudnorm linear -23.98 → -22.56 LUFS (gain +1.58 dB, TP -3.06 dBTP); target backed off 3.4 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly
- **f2-s7** (10.54s raw → 8.27s, budget 7.5s, now +0.77s over): trim lead/tail silence 10.54→10.54s · re-synth speed 1.05→1.12 (+110 chars) · trim 8.27→8.27s · loudnorm linear -25.11 → -21.64 LUFS (gain +3.41 dB, TP -3.08 dBTP); target backed off 2.7 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly
- **f2-s8** (3.58s raw → 3.58s, budget 5.5s, now inside): loudnorm linear -23.95 → -21.05 LUFS (gain +2.75 dB, TP -3.06 dBTP); target backed off 2.2 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly
- **f2-s9** (4.27s raw → 4.27s, budget 5.5s, now inside): loudnorm linear -23.49 → -21.87 LUFS (gain +1.49 dB, TP -3.09 dBTP); target backed off 3.0 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly
- **f2-s10** (6.92s raw → 6.92s, budget 6.5s, now +0.42s over): loudnorm linear -24.48 → -21.12 LUFS (gain +3.28 dB, TP -3.11 dBTP); target backed off 2.2 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly
- **f2-s11** (5.76s raw → 5.76s, budget 6.5s, now inside): loudnorm linear -24.08 → -19.57 LUFS (gain +4.48 dB, TP -3.17 dBTP); target backed off 0.6 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly
- **f2-s12** (5.34s raw → 5.34s, budget 5.5s, now inside): loudnorm linear -23.83 → -21.77 LUFS (gain +1.63 dB, TP -3.14 dBTP); target backed off 3.2 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly
- **f3-s1** (3.81s raw → 3.81s, budget 5.5s, now inside): loudnorm linear -23.88 → -21.25 LUFS (gain +2.08 dB, TP -3.09 dBTP); target backed off 2.8 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly
- **f3-s2** (4.50s raw → 4.50s, budget 5.5s, now inside): loudnorm linear -24.3 → -21.82 LUFS (gain +2.5 dB, TP -3.05 dBTP); target backed off 2.8 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly
- **f3-s3** (7.29s raw → 7.29s, budget 7.5s, now inside): loudnorm linear -24.2 → -20.45 LUFS (gain +3.6 dB, TP -3.04 dBTP); target backed off 1.6 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly
- **f3-s4** (8.64s raw → 6.18s, budget 5.5s, now +0.68s over): trim lead/tail silence 8.64→8.64s · re-synth speed 1.05→1.12 (+72 chars) · trim 6.18→6.18s · loudnorm linear -25.07 → -22.48 LUFS (gain +2.57 dB, TP -3.05 dBTP); target backed off 3.5 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly
- **f3-s5** (6.55s raw → 5.63s, budget 5.5s, now +0.13s over): trim by alignment 6.55→6.44s · retake 1 at speed 1.12 (+90 chars) · trim by alignment 7.57→6.91s · retake 1 not shorter — kept the 6.44s take · retake 2 at speed 1.12 (+90 chars) · trim by alignment 7.80→7.11s · retake 2 not shorter — kept the 6.44s take · --refit pass · retake 1 at speed 1.12 (+90 chars) · trim by alignment 8.22→7.56s · retake 1 not shorter — kept the 6.44s take · retake 2 at speed 1.12 (+90 chars) · trim by alignment 10.03→9.23s · retake 2 not shorter — kept the 6.44s take · retake 3 at speed 1.12 (+90 chars) · trim by alignment 7.11→6.62s · retake 3 not shorter — kept the 6.44s take · loudnorm linear -24.28 → -22.06 LUFS (gain +2.08 dB, TP -3.08 dBTP); target backed off 3.2 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly · --refit pass · retake 1 at speed 1.12 (+90 chars) · trim by alignment 9.47→8.51s · retake 1 not shorter — kept the 6.44s take · retake 2 at speed 1.12 (+90 chars) · trim by alignment 5.76→5.63s · loudnorm linear -25.02 → -23.52 LUFS (gain +1.22 dB, TP -3.11 dBTP); target backed off 4.8 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly
- **f3-s6** (3.44s raw → 3.44s, budget 5.5s, now inside): loudnorm linear -24.82 → -21.4 LUFS (gain +3.12 dB, TP -3.05 dBTP); target backed off 2.7 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly
- **f3-s7** (4.46s raw → 4.46s, budget 5.5s, now inside): loudnorm linear -24.8 → -22.59 LUFS (gain +2.2 dB, TP -3.07 dBTP); target backed off 3.6 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly
- **f3-s8** (6.22s raw → 6.22s, budget 6.5s, now inside): loudnorm linear -23.72 → -21.07 LUFS (gain +2.02 dB, TP -3.03 dBTP); target backed off 2.7 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly
- **f4-s1** (2.88s raw → 2.88s, budget 2.5s, now +0.38s over): loudnorm linear -24.45 → -19.5 LUFS (gain +5.45 dB, TP -3 dBTP)
- **f4-s2** (7.48s raw → 5.32s, budget 5.5s, now inside): trim lead/tail silence 7.48→7.48s · re-synth speed 1.05→1.12 (+73 chars) · trim 5.80→5.32s · loudnorm linear -24.78 → -23.32 LUFS (gain +1.48 dB, TP -3.1 dBTP); target backed off 4.3 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly
- **f4-s3** (2.28s raw → 2.28s, budget 5.5s, now inside): loudnorm linear -24.35 → -19.89 LUFS (gain +5.35 dB, TP -3 dBTP)
- **f4-s4** (3.67s raw → 3.67s, budget 3.5s, now +0.17s over): loudnorm linear -24.03 → -22.6 LUFS (gain +1.43 dB, TP -3.03 dBTP); target backed off 3.6 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly
- **f4-s5-viewer** (2.18s raw → 2.18s, budget 5.5s, now inside): loudnorm linear -16.14 → -19 LUFS (gain -2.86 dB, TP -4.34 dBTP)
- **f4-s6** (3.07s raw → 3.07s, budget 2.5s, now +0.57s over): loudnorm linear -24.39 → -19.18 LUFS (gain +4.89 dB, TP -3.33 dBTP); target backed off 0.5 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly
- **f4-s7** (7.85s raw → 6.83s, budget 6.5s, now +0.33s over): trim lead/tail silence 7.85→7.85s · re-synth speed 1.05→1.12 (+79 chars) · trim 6.83→6.83s · loudnorm linear -25.51 → -20.66 LUFS (gain +4.51 dB, TP -3.11 dBTP); target backed off 2.0 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly
- **f4-s8** (5.02s raw → 5.02s, budget 5.5s, now inside): loudnorm linear -24.71 → -21.6 LUFS (gain +3.01 dB, TP -3.18 dBTP); target backed off 2.7 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly
- **f4-s9** (4.18s raw → 4.18s, budget 4.5s, now inside): loudnorm linear -24.16 → -23.72 LUFS (gain +0.16 dB, TP -4.48 dBTP)
- **f4-s10** (5.48s raw → 4.87s, budget 5.5s, now inside): trim lead/tail silence 5.48→5.42s · re-synth speed 1.05→1.12 (+85 chars) · trim 4.97→4.87s · loudnorm linear -24.79 → -21.05 LUFS (gain +3.79 dB, TP -3 dBTP); target backed off 2.0 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly
- **f4-s11** (1.21s raw → 1.21s, budget 4.5s, now inside): loudnorm linear -24.66 → -20.83 LUFS (gain +5.66 dB, TP -3 dBTP)
- **f5-s1** (1.95s raw → 1.95s, budget 2.5s, now inside): loudnorm linear -24.93 → -19.89 LUFS (gain +5.93 dB, TP -3 dBTP)
- **f5-s2** (8.87s raw → 8.87s, budget 9.5s, now inside): loudnorm linear -23.8 → -20.58 LUFS (gain +3 dB, TP -3.03 dBTP); target backed off 1.8 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly
- **f5-s3** (4.97s raw → 4.97s, budget 6.5s, now inside): loudnorm linear -24.22 → -21.66 LUFS (gain +2.62 dB, TP -3.03 dBTP); target backed off 2.6 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly
- **f5-s4** (5.71s raw → 5.71s, budget 6.5s, now inside): loudnorm linear -24.43 → -23.95 LUFS (gain +0.43 dB, TP -4.12 dBTP)
- **f5-s5** (6.59s raw → 5.95s, budget 5.5s, now +0.45s over): trim lead/tail silence 6.59→5.95s · loudnorm linear -25.49 → -21.72 LUFS (gain +3.49 dB, TP -3.07 dBTP); target backed off 3.0 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly
- **f5-s6** (7.11s raw → 4.94s, budget 5.5s, now inside): trim lead/tail silence 7.11→6.51s · re-synth speed 1.05→1.12 (+74 chars) · trim 5.39→4.94s · loudnorm linear -25.02 → -23.13 LUFS (gain +1.92 dB, TP -3.08 dBTP); target backed off 4.1 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly
- **f5-s7** (4.88s raw → 4.88s, budget 5.5s, now inside): loudnorm linear -25.25 → -20.22 LUFS (gain +4.75 dB, TP -3.07 dBTP); target backed off 1.5 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly

**Every clip is inside its budget + tolerance.**

## Loudness — delivery level

**Policy: uniform -24 LUFS integrated, true peak ≤ -3 dBTP, two-pass `loudnorm`, linear only.**
Owner ruling 2026-09-05: consistency over level. One level for every clip, because the assembler applies a single measured
static gain to the whole film — a spread between clips would become a voice that jumps from beat to beat, while a uniform
set just moves that one number. The target is `--uniform auto`: the loudest level the most peak-constrained clip in the set
can still reach with a pure gain, so no clip is ever compressed to keep up with the others.

- **48/48 clips normalized linearly** (`normalization_type: linear` asserted on the second pass); none fell back to `dynamic`, so nothing is compressed.
- Measured on the files: **-24.6 … -23.8 LUFS — spread 0.8 dB**, true peak max **-3.4 dBTP** (ceiling -3); nothing clips.
- Narrator mean **-24.3** LUFS vs viewer **-24.4** — a **0.1 dB** gap, from **8.4 dB** on the raw takes.
- The level is set by the most constrained clips (f1-s6, f3-s5, f1-s8); every other clip was attenuated to meet them.

The policy is stored in the manifest (`loudness`), so later runs hold new clips to it — a drift re-synthesis lands at the
same level instead of quietly re-levelling the set. A clip that cannot reach it is reported and asks for a re-level:

```
node narration/synthesize-elevenlabs.mjs --uniform auto                 # re-level the whole set (local, no key, no spend)
node narration/synthesize-elevenlabs.mjs --uniform -22 --target-tp -1   # a hotter set if the bus ever wants it
```

**Why the clips are not at the -19 LUFS mix target.** Linear normalization is one gain, so it can only hit a loudness
target if the clip's crest factor (true peak − integrated) fits under (ceiling − target). This narration measures
**14.6–21.2 dB of crest** (median 18; worst f1-s6 21.2, f3-s5 20.6, f1-s8 20.3) — ElevenLabs delivers speech with big plosive
transients over a gated-average loudness. Putting every clip at -19 LUFS linearly would need a ceiling of
-19 + 21.2 = **+2.2 dBTP** — peaks above 0 dBFS. So **-19 LUFS is unreachable by linear gain on this
material at any peak ceiling**; the only route would be the loudnorm limiter, i.e. a dynamic process reshaping each clip.

That is why the level is handled downstream instead: the assembler limits the **voice bus** — after the voices are summed,
before the bed — which is what an ad mix does, and it keeps the voice/music balance intact. These clips therefore deliver
**consistency**, and one measured static gain downstream supplies the level. Do not chase a hotter target here.

What a ceiling would buy, worst-case clip, uniform across all 48:

| true-peak ceiling | loudest uniform target every clip can reach linearly |
|---|---|
| -3 dBTP | -24.3 LUFS |
| -2 dBTP | -23.3 LUFS |
| -1 dBTP | -22.3 LUFS |
| -0.5 dBTP | -21.8 LUFS |

## What the measurements can and cannot say

- **LRA is not meaningful on a single clip.** ebur128's loudness range uses 3s short-term windows; on the 1–3s clips it reports 0 or
  ~20 LU — artifacts, not the audio (their word timings are clean). Read LRA on the assembled film, or on the audition's combined
  files (Liam v2: 2.3 LU over 19s).
- **True peak** is held under the ceiling on every clip by the normalization pass above: no clipping.
- **eleven_v3** was auditioned and not adopted: two of six clips fell outside ±20% of the v2 length (both closes, 1.23–1.28×), it
  refuses previous_text/next_text (HTTP 400), and it ignores speed — no lever for an over-slot clip. It is the one expressive
  read measured (LRA 7.1 vs 2.3): `--film-model 1=eleven_v3` if the owner wants it for the teaser, at a timing cost.

## The four-beat close (f1-s10)

Spoken text: "That was you. Now pick what's next. — Touch it. Ask it. Steer it. — Flow Video." · method alignment+silencedetect · **FOUR DISTINCT BEATS**

| beat | preceded by | gap by alignment (ms) | silence detected −35dB (ms) |
|---|---|---|---|
| Touch | next.. — | 685 | 722 |
| Ask | it.. | 383 | 500 |
| Steer | it.. | 406 | 421 |
| Flow | it.. — | 441 | 472 |

All inner silences ≥150ms in the clip: [521, 722, 500, 421, 472] ms · lead 0ms · tail 232ms.

## Every clip

| clip | role | model | chars sent | raw s | final s | wpm | slot s | budget s | over | LUFS | TP dBTP | norm target | inner gaps ≥150ms (ms) | actions |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| f1-s1 | narrator | multilingual_v2 | 24 | 1.11 | 1.11 | 269 | 4 | 3.5 |  | -24.4 | -9.8 | -24 | [] | loudnorm linear -23.39 → -18.99 LUFS (gain +4.39 dB, TP -4.33 dBTP) |
| f1-s2 | narrator | multilingual_v2 | 70 | 5.67 | 5.67 | 138 | 8 | 7.5 |  | -24.6 | -6.9 | -24 | [806, 329, 436, 594] | loudnorm linear -23.73 → -20.74 LUFS (gain +3.13 dB, TP -3.02 dBTP); target backed off 1.6 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly |
| f1-s3 | narrator | multilingual_v2 | 70 | 4.32 | 3.71 | 194 | 4 | 3.5 | +0.21 | -24 | -6.5 | -24 | [410] | trim by alignment 4.32→3.71s; loudnorm linear -24.74 → -20.52 LUFS (gain +3.74 dB, TP -3.05 dBTP); target backed off 2.0 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly |
| f1-s4 | narrator | multilingual_v2 | 106 | 5.39 | 3.58 | 151 | 4 | 3.5 | +0.08 | -24.3 | -6.8 | -24 | [330, 692] | trim lead/tail silence 5.39→4.55s; loudnorm linear -24.74 → -22.65 LUFS (gain +1.94 dB, TP -3.05 dBTP); target backed off 3.8 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly; --refit pass; retake 1 at speed 1.12 (+53 chars); trim by alignment 3.67→3.58s; loudnorm linear -24.46 → -20.47 LUFS (gain +3.86 dB, TP -3.03 dBTP); target backed off 1.6 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly |
| f1-s5 | narrator | multilingual_v2 | 44 | 3.39 | 3.39 | 159 | 5 | 4.5 |  | -23.9 | -7.2 | -24 | [586] | loudnorm linear -26.19 → -20.01 LUFS (gain +5.79 dB, TP -3.07 dBTP); target backed off 1.4 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly |
| f1-s6 | narrator | multilingual_v2 | 64 | 5.76 | 5.76 | 125 | 8 | 7.5 |  | -24.6 | -3.4 | -24 | [324, 472, 872, 497] | loudnorm linear -24.07 → -24.01 LUFS (gain +0.27 dB, TP -3.11 dBTP); target backed off 4.8 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly |
| f1-s7 | narrator | multilingual_v2 | 52 | 3.76 | 3.28 | 183 | 3 | 2.5 | +0.78 | -24.2 | -8.2 | -24 | [515, 240] | trim by alignment 3.76→3.28s; loudnorm linear -25.01 → -19.25 LUFS (gain +5.51 dB, TP -3.23 dBTP); target backed off 0.5 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly |
| f1-s8 | narrator | multilingual_v2 | 375 | 10.82 | 8.44 | 156 | 9 | 8.5 |  | -24.1 | -3.8 | -24 | [742, 200, 481, 622, 503, 859] | trim by alignment 10.82→10.21s; retake 1 at speed 1.12 (+125 chars); trim by alignment 10.31→9.74s; retake 2 at speed 1.12 (+125 chars); trim by alignment 8.92→8.44s; loudnorm linear -25.39 → -23.37 LUFS (gain +1.69 dB, TP -3.07 dBTP); target backed off 4.7 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly |
| f1-s9 | narrator | multilingual_v2 | 44 | 3.39 | 3.39 | 142 | 7 | 6.5 |  | -24.5 | -6 | -24 | [307, 477] | loudnorm linear -24.19 → -21.54 LUFS (gain +2.69 dB, TP -3.06 dBTP); target backed off 2.5 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly |
| f1-s10 | narrator | multilingual_v2 | 79 | 6.32 | 6.20 | 145 | 6 | 5.5 | +0.70 | -24.3 | -5.3 | -24 | [521, 722, 500, 421, 472] | trim by alignment 6.32→6.20s; loudnorm linear -24.65 → -22.01 LUFS (gain +2.55 dB, TP -3.08 dBTP); target backed off 3.1 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly |
| f2-s1 | narrator | multilingual_v2 | 170 | 7.01 | 5.74 | 157 | 6 | 5.5 | +0.24 | -24.2 | -6 | -24 | [573, 456, 672, 771] | trim lead/tail silence 7.01→6.41s; re-synth speed 1.05→1.12 (+85 chars); trim 6.32→5.74s; loudnorm linear -24.75 → -21.18 LUFS (gain +3.35 dB, TP -3.08 dBTP); target backed off 2.4 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly |
| f2-s2 | narrator | multilingual_v2 | 420 | 8.54 | 7.13 | 151 | 7 | 6.5 | +0.63 | -24.5 | -6.5 | -24 | [730, 637, 217, 335] | trim by alignment 8.54→8.00s; retake 1 at speed 1.12 (+105 chars); trim by alignment 8.59→8.00s; retake 1 not shorter — kept the 8.00s take; retake 2 at speed 1.12 (+105 chars); trim by alignment 8.13→7.47s; --refit pass; retake 1 at speed 1.12 (+105 chars); trim by alignment 7.71→7.13s; loudnorm linear -24.4 → -21.13 LUFS (gain +3.3 dB, TP -3.08 dBTP); target backed off 2.1 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly |
| f2-s3 | narrator | multilingual_v2 | 172 | 7.80 | 6.28 | 143 | 6 | 5.5 | +0.78 | -24.6 | -7 | -24 | [601, 714, 527, 586] | trim by alignment 7.80→7.28s; retake 1 at speed 1.12 (+86 chars); trim by alignment 6.55→6.28s; loudnorm linear -23.87 → -20.67 LUFS (gain +3.37 dB, TP -3.11 dBTP); target backed off 1.5 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly |
| f2-s4 | narrator | multilingual_v2 | 83 | 5.67 | 5.67 | 159 | 8 | 7.5 |  | -24.3 | -6.3 | -24 | [596, 836] | loudnorm linear -24 → -21.07 LUFS (gain +2.8 dB, TP -3.02 dBTP); target backed off 2.2 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly |
| f2-s5 | narrator | multilingual_v2 | 84 | 7.71 | 7.71 | 101 | 8 | 7.5 | +0.21 | -24 | -6.5 | -24 | [1095, 1019, 949] | loudnorm linear -24.48 → -20.52 LUFS (gain +3.48 dB, TP -3.12 dBTP); target backed off 2.0 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly |
| f2-s6 | narrator | multilingual_v2 | 71 | 5.15 | 5.15 | 163 | 8 | 7.5 |  | -24.6 | -5.1 | -24 | [834] | loudnorm linear -23.98 → -22.56 LUFS (gain +1.58 dB, TP -3.06 dBTP); target backed off 3.4 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly |
| f2-s7 | narrator | multilingual_v2 | 220 | 10.54 | 8.27 | 131 | 8 | 7.5 | +0.77 | -24.4 | -5.8 | -24 | [346, 497, 709, 499, 659] | trim lead/tail silence 10.54→10.54s; re-synth speed 1.05→1.12 (+110 chars); trim 8.27→8.27s; loudnorm linear -25.11 → -21.64 LUFS (gain +3.41 dB, TP -3.08 dBTP); target backed off 2.7 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly |
| f2-s8 | narrator | multilingual_v2 | 42 | 3.58 | 3.58 | 134 | 6 | 5.5 |  | -24.3 | -6.4 | -24 | [300, 337, 489] | loudnorm linear -23.95 → -21.05 LUFS (gain +2.75 dB, TP -3.06 dBTP); target backed off 2.2 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly |
| f2-s9 | narrator | multilingual_v2 | 72 | 4.27 | 4.27 | 183 | 6 | 5.5 |  | -24.3 | -5.6 | -24 | [406, 493] | loudnorm linear -23.49 → -21.87 LUFS (gain +1.49 dB, TP -3.09 dBTP); target backed off 3.0 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly |
| f2-s10 | narrator | multilingual_v2 | 94 | 6.92 | 6.92 | 147 | 7 | 6.5 | +0.42 | -24.4 | -6.3 | -24 | [884, 483, 425] | loudnorm linear -24.48 → -21.12 LUFS (gain +3.28 dB, TP -3.11 dBTP); target backed off 2.2 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly |
| f2-s11 | narrator | multilingual_v2 | 84 | 5.76 | 5.76 | 146 | 7 | 6.5 |  | -24.4 | -7.9 | -24 | [847, 494] | loudnorm linear -24.08 → -19.57 LUFS (gain +4.48 dB, TP -3.17 dBTP); target backed off 0.6 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly |
| f2-s12 | narrator | multilingual_v2 | 77 | 5.34 | 5.34 | 157 | 6 | 5.5 |  | -24 | -5.3 | -24 | [543, 566, 594] | loudnorm linear -23.83 → -21.77 LUFS (gain +1.63 dB, TP -3.14 dBTP); target backed off 3.2 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly |
| f3-s1 | narrator | multilingual_v2 | 59 | 3.81 | 3.81 | 173 | 6 | 5.5 |  | -23.9 | -5.9 | -24 | [379] | loudnorm linear -23.88 → -21.25 LUFS (gain +2.08 dB, TP -3.09 dBTP); target backed off 2.8 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly |
| f3-s2 | narrator | multilingual_v2 | 51 | 4.50 | 4.50 | 133 | 6 | 5.5 |  | -24.5 | -5.6 | -24 | [764, 508, 531] | loudnorm linear -24.3 → -21.82 LUFS (gain +2.5 dB, TP -3.05 dBTP); target backed off 2.8 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly |
| f3-s3 | narrator | multilingual_v2 | 93 | 7.29 | 7.29 | 132 | 8 | 7.5 |  | -24.3 | -6.9 | -24 | [1207, 260, 282, 852] | loudnorm linear -24.2 → -20.45 LUFS (gain +3.6 dB, TP -3.04 dBTP); target backed off 1.6 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly |
| f3-s4 | narrator | multilingual_v2 | 144 | 8.64 | 6.18 | 107 | 6 | 5.5 | +0.68 | -24.4 | -4.9 | -24 | [553, 806, 560, 877] | trim lead/tail silence 8.64→8.64s; re-synth speed 1.05→1.12 (+72 chars); trim 6.18→6.18s; loudnorm linear -25.07 → -22.48 LUFS (gain +2.57 dB, TP -3.05 dBTP); target backed off 3.5 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly |
| f3-s5 | narrator | multilingual_v2 | 720 | 6.55 | 5.63 | 138 | 6 | 5.5 | +0.13 | -24.2 | -3.6 | -24 | [513, 552, 158, 327, 315] | trim by alignment 6.55→6.44s; retake 1 at speed 1.12 (+90 chars); trim by alignment 7.57→6.91s; retake 1 not shorter — kept the 6.44s take; retake 2 at speed 1.12 (+90 chars); trim by alignment 7.80→7.11s; retake 2 not shorter — kept the 6.44s take; --refit pass; retake 1 at speed 1.12 (+90 chars); trim by alignment 8.22→7.56s; retake 1 not shorter — kept the 6.44s take; retake 2 at speed 1.12 (+90 chars); trim by alignment 10.03→9.23s; retake 2 not shorter — kept the 6.44s take; retake 3 at speed 1.12 (+90 chars); trim by alignment 7.11→6.62s; retake 3 not shorter — kept the 6.44s take; loudnorm linear -24.28 → -22.06 LUFS (gain +2.08 dB, TP -3.08 dBTP); target backed off 3.2 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly; --refit pass; retake 1 at speed 1.12 (+90 chars); trim by alignment 9.47→8.51s; retake 1 not shorter — kept the 6.44s take; retake 2 at speed 1.12 (+90 chars); trim by alignment 5.76→5.63s; loudnorm linear -25.02 → -23.52 LUFS (gain +1.22 dB, TP -3.11 dBTP); target backed off 4.8 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly |
| f3-s6 | narrator | multilingual_v2 | 44 | 3.44 | 3.44 | 140 | 6 | 5.5 |  | -24.2 | -5.8 | -24 | [861, 321] | loudnorm linear -24.82 → -21.4 LUFS (gain +3.12 dB, TP -3.05 dBTP); target backed off 2.7 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly |
| f3-s7 | narrator | multilingual_v2 | 51 | 4.46 | 4.46 | 108 | 6 | 5.5 |  | -24.4 | -4.9 | -24 | [417, 339, 206] | loudnorm linear -24.8 → -22.59 LUFS (gain +2.2 dB, TP -3.07 dBTP); target backed off 3.6 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly |
| f3-s8 | narrator | multilingual_v2 | 65 | 6.22 | 6.22 | 116 | 7 | 6.5 |  | -23.8 | -5.7 | -24 | [851, 889, 1218] | loudnorm linear -23.72 → -21.07 LUFS (gain +2.02 dB, TP -3.03 dBTP); target backed off 2.7 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly |
| f4-s1 | narrator | multilingual_v2 | 48 | 2.88 | 2.88 | 167 | 3 | 2.5 | +0.38 | -24.4 | -7.9 | -24 | [237] | loudnorm linear -24.45 → -19.5 LUFS (gain +5.45 dB, TP -3 dBTP) |
| f4-s2 | narrator | multilingual_v2 | 146 | 7.48 | 5.32 | 146 | 6 | 5.5 |  | -24.5 | -4.2 | -24 | [396, 499, 238, 354, 443] | trim lead/tail silence 7.48→7.48s; re-synth speed 1.05→1.12 (+73 chars); trim 5.80→5.32s; loudnorm linear -24.78 → -23.32 LUFS (gain +1.48 dB, TP -3.1 dBTP); target backed off 4.3 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly |
| f4-s3 | narrator | multilingual_v2 | 20 | 2.28 | 2.28 | 79 | 6 | 5.5 |  | -24.5 | -7.6 | -24 | [563] | loudnorm linear -24.35 → -19.89 LUFS (gain +5.35 dB, TP -3 dBTP) |
| f4-s4 | narrator | multilingual_v2 | 39 | 3.67 | 3.67 | 98 | 4 | 3.5 | +0.17 | -24.4 | -4.9 | -24 | [436, 316, 303, 151] | loudnorm linear -24.03 → -22.6 LUFS (gain +1.43 dB, TP -3.03 dBTP); target backed off 3.6 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly |
| f4-s5-viewer | viewer | multilingual_v2 | 42 | 2.18 | 2.18 | 220 | 6 | 5.5 |  | -24.4 | -9.7 | -24 | [] | loudnorm linear -16.14 → -19 LUFS (gain -2.86 dB, TP -4.34 dBTP) |
| f4-s6 | narrator | multilingual_v2 | 35 | 3.07 | 3.07 | 117 | 3 | 2.5 | +0.57 | -24.1 | -8.3 | -24 | [735] | loudnorm linear -24.39 → -19.18 LUFS (gain +4.89 dB, TP -3.33 dBTP); target backed off 0.5 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly |
| f4-s7 | narrator | multilingual_v2 | 158 | 7.85 | 6.83 | 114 | 7 | 6.5 | +0.33 | -24.1 | -6.6 | -24 | [424, 703, 789, 837] | trim lead/tail silence 7.85→7.85s; re-synth speed 1.05→1.12 (+79 chars); trim 6.83→6.83s; loudnorm linear -25.51 → -20.66 LUFS (gain +4.51 dB, TP -3.11 dBTP); target backed off 2.0 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly |
| f4-s8 | narrator | multilingual_v2 | 69 | 5.02 | 5.02 | 120 | 6 | 5.5 |  | -24.4 | -5.8 | -24 | [345, 484, 437] | loudnorm linear -24.71 → -21.6 LUFS (gain +3.01 dB, TP -3.18 dBTP); target backed off 2.7 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly |
| f4-s9 | narrator | multilingual_v2 | 51 | 4.18 | 4.18 | 115 | 5 | 4.5 |  | -24.2 | -4.9 | -24 | [510, 222] | loudnorm linear -24.16 → -23.72 LUFS (gain +0.16 dB, TP -4.48 dBTP) |
| f4-s10 | narrator | multilingual_v2 | 170 | 5.48 | 4.87 | 160 | 6 | 5.5 |  | -24.5 | -6.5 | -24 | [185, 195, 203, 652] | trim lead/tail silence 5.48→5.42s; re-synth speed 1.05→1.12 (+85 chars); trim 4.97→4.87s; loudnorm linear -24.79 → -21.05 LUFS (gain +3.79 dB, TP -3 dBTP); target backed off 2.0 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly |
| f4-s11 | narrator | multilingual_v2 | 20 | 1.21 | 1.21 | 199 | 5 | 4.5 |  | -24.4 | -6.6 | -24 | [] | loudnorm linear -24.66 → -20.83 LUFS (gain +5.66 dB, TP -3 dBTP) |
| f5-s1 | narrator | multilingual_v2 | 28 | 1.95 | 1.95 | 154 | 3 | 2.5 |  | -24.4 | -7.6 | -24 | [390] | loudnorm linear -24.93 → -19.89 LUFS (gain +5.93 dB, TP -3 dBTP) |
| f5-s2 | narrator | multilingual_v2 | 123 | 8.87 | 8.87 | 129 | 10 | 9.5 |  | -24.2 | -6.6 | -24 | [569, 254, 436, 520, 542, 178] | loudnorm linear -23.8 → -20.58 LUFS (gain +3 dB, TP -3.03 dBTP); target backed off 1.8 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly |
| f5-s3 | narrator | multilingual_v2 | 86 | 4.97 | 4.97 | 181 | 7 | 6.5 |  | -24.5 | -5.9 | -24 | [394, 494] | loudnorm linear -24.22 → -21.66 LUFS (gain +2.62 dB, TP -3.03 dBTP); target backed off 2.6 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly |
| f5-s4 | narrator | multilingual_v2 | 75 | 5.71 | 5.71 | 147 | 7 | 6.5 |  | -24.4 | -4.5 | -24 | [486, 264, 293, 321] | loudnorm linear -24.43 → -23.95 LUFS (gain +0.43 dB, TP -4.12 dBTP) |
| f5-s5 | narrator | multilingual_v2 | 68 | 6.59 | 5.95 | 101 | 6 | 5.5 | +0.45 | -24.2 | -5.4 | -24 | [837, 831, 408] | trim lead/tail silence 6.59→5.95s; loudnorm linear -25.49 → -21.72 LUFS (gain +3.49 dB, TP -3.07 dBTP); target backed off 3.0 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly |
| f5-s6 | narrator | multilingual_v2 | 148 | 7.11 | 4.94 | 146 | 6 | 5.5 |  | -24.5 | -4.4 | -24 | [268, 408, 489, 486] | trim lead/tail silence 7.11→6.51s; re-synth speed 1.05→1.12 (+74 chars); trim 5.39→4.94s; loudnorm linear -25.02 → -23.13 LUFS (gain +1.92 dB, TP -3.08 dBTP); target backed off 4.1 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly |
| f5-s7 | narrator | multilingual_v2 | 59 | 4.88 | 4.88 | 111 | 6 | 5.5 |  | -24.2 | -7.1 | -24 | [498, 302, 660] | loudnorm linear -25.25 → -20.22 LUFS (gain +4.75 dB, TP -3.07 dBTP); target backed off 1.5 dB from -19 — the true-peak ceiling -3 dBTP allows no more gain linearly |

## Regenerating

With a permanent key in a JSON file OUTSIDE the repo (`{ "xi_api_key": "sk_..." }` — never in the repo, never on a command line):

```
node narration/synthesize-elevenlabs.mjs --auth /path/to/el-auth.json            # only the clips that are missing
node narration/synthesize-elevenlabs.mjs --auth /path/to/el-auth.json --force    # the whole set, same pick, same settings
node narration/synthesize-elevenlabs.mjs --auth /path/to/el-auth.json --force --only f1-s10   # one clip
node narration/synthesize-elevenlabs.mjs --auth /path/to/el-auth.json --refit --retakes 3     # faster retakes for clips still over tolerance only
node narration/synthesize-elevenlabs.mjs --dry-run                                # the plan and the char cost, no key needed
node narration/synthesize-elevenlabs.mjs --verify                                 # THE GATE: exit 1 if any clip is missing or no longer says its line
```

**`--verify` is the assembler's gate, and it needs no key.** It fails when a line of `lines.json` has no mp3, has no manifest entry,
or when the manifest's `textSha1` no longer matches the line — the case where the scripts were rewritten and the audio was not.
A plain run then re-synthesizes exactly those clips (with the NEW neighbours as previous_text/next_text) and nothing else;
`--keep-drift` suppresses that if you want the old audio kept deliberately. Run it before every assemble:

```
node narration/synthesize-elevenlabs.mjs --verify && node assembly/assemble-film.mjs 1
```

Then `node assembly/assemble-film.mjs <n>` per film. Flags: `--narrator/--viewer <voiceId>`, `--model <id>`,
`--film-model 1=eleven_v3`, `--speed/--style/--stability/--similarity`, `--no-boost`, `--no-fit`, `--refit`, `--retakes N`, `--out <dir>`.
Any run — full or partial — rewrites this note from `audio/MANIFEST.json`, so it always describes the whole set.
Ids and labels of the premade voices are in `VOICES` at the top of the script; the audition that made this
pick is `AUDITION-EL.md` (clips in `audition-el/`).

**`narration/audio-manifest.json` is the canonical record** — every clip's settings, request id, chars sent, `textSha1`,
word timings from the alignment, loudness and QC measurements, plus the set's `loudness` policy. It lives BESIDE `lines.json`,
not inside `audio/`, because `audio/` is gitignored and `--verify` has to work on a fresh checkout; a mirror copy is still
written to `audio/MANIFEST.json` for convenience, and either is read back (canonical wins).

## Fallback

`narration/audio-edge/` is the free, keyless Edge-neural take (Andrew +12% / Emma; `synthesize-edge.mjs`,
record in `EDGE-VOICE-NOTE.md`). To assemble with it, point the assembler at it or copy it over `audio/`;
no key, no spend. It is the review-pass voice the owner heard, not the production read.
