# Narrator audition — ElevenLabs premade voices

Generated 2026-09-05T13:09:48.022Z by `narration/audition-elevenlabs.mjs`. **Nobody who wrote this could hear the clips**;
every column is a measurement (ffprobe / ffmpeg astats / ebur128 / silencedetect) or the vendor's own label. Clips in
`narration/audition-el/<Voice>-<model>-<line>.mp3`, raw as delivered (no trims, no pause editing — unlike the Edge audition,
ElevenLabs speaks the punctuation itself). Each clip was rendered with the SAME previous_text/next_text the film sends.

Lines (verbatim from lines.json): hook = f1-s2 "It isn't. Go on — touch it. Grab the motor… spin it." (11 words) ·
tutorial = f2-s5, the longest film-2 line, "Pick Simulation. Choose your package. Open Generate mini model — and tell it, in plain words, what this moment's for:" (19 words) ·
close = f1-s10 "The doors below are live. — Touch it. Ask it. Steer it. — Flow Video." (13 words) · viewer = f4-s5-viewer "Why doesn't the moon crash into the earth?".

Settings — v2 (`eleven_multilingual_v2`): stability 0.45 · similarity 0.8 · style 0.4 · speaker boost · speed 1.05.
v3 (`eleven_v3`): stability 0.5 (natural preset) · similarity 0.8 · style 0.4 · speaker boost · no speed (v3 ignores it). Viewer: v2, speed 1.0.
Spend (three passes: 20 + 9 purchased clips, then a measurement-only pass): 29 requests, 2,226 chars of text sent, Σ character-cost
headers 1,225 (= the vendor's `/v1/history` ledger for these generations; see the spend note at the end).

## Criteria (a kinetic US SaaS trailer, imperative lines)

1. **Pace** — overall wpm (words ÷ clip length). Hook target 165–185, never under 150; the tutorial line is the sustained-pace check.
   "artic." = words ÷ time actually speaking (clip minus lead, tail and every silence ≥150ms at −35dB) — the voice's tempo apart from its pauses.
2. **Dynamic range** — LRA (loudness range, LU) per clip: 6–12 reads as expressive, under 4 flat. Averaged over the three lines, with the three shown.
3. **No clipping** — true peak (ebur128) must stay under 0 dBFS; astats sample peak alongside.
4. **Four beats** — the close must break into "Touch it." / "Ask it." / "Steer it." / "Flow Video.": the gap before each beat after the first
   must register as a silence ≥150ms at −35dB (silencedetect), located by the word alignment the API returns.
5. **Label fit** — confident / energetic for a marketing read, not comforting: Liam *energetic, confident, social media, young* · Brian *deep, resonant,
   classy* · Eric *smooth, trustworthy* · Adam *dominant, firm* · Bill *advertisement, older, crisp* · Sarah *mature, reassuring, confident, TV*.
6. **eleven_v3 sanity** — v3 is the expressive model but can hallucinate on short lines: a v3 clip counts as clean only if its length is within
   ±20% of the same voice's v2 clip, never under 0.4s, never 3× too long.

## Narrators

wpm is shown **as delivered** / trimmed (lead cut to ≤80ms, tail to ≤200ms — what a refit trim keeps, and the figure the Edge
audition reported). ElevenLabs clips start on the word (lead 0 on every clip here) and carry a 0–0.9s tail.

| voice | model @speed | hook s | hook wpm / trimmed | artic. | tutorial s | tut. wpm / trimmed | artic. | close s (wpm) | close beats (silence ms before Ask / Steer / Flow) | LUFS | LRA mean (h/t/c) | true peak dBFS |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Liam | multilingual_v2 @1.05 | 4.60 | **144** / 153 | 282 | 7.43 | **153** / 160 | 212 | 5.67 (138) | OK [516, 460, 674] | -24.2 | **1.4** (1.0/1.0/2.3) | -4.7 |
| Brian | multilingual_v2 @1.05 | 3.81 | **173** / 182 | 284 | 7.94 | **144** / 144 | 201 | 5.53 (141) | OK [286, 199, 691] | -24.0 | **1.1** (0.3/1.5/1.5) | -4.7 |
| Eric | multilingual_v2 @1.05 | 4.27 | **154** / 167 | 258 | 8.45 | **135** / 143 | 200 | 4.55 (171) | RUN-ON [0, 0, 419] | -23.6 | **1.4** (1.2/1.6/1.3) | -5.0 |
| Adam | multilingual_v2 @1.05 | 4.55 | **145** / 147 | 254 | 8.36 | **136** / 136 | 179 | 7.29 (107) | OK [680, 724, 928] | -16.8 | **2.9** (1.1/2.0/5.6) | -0.9 |
| Bill | multilingual_v2 @1.05 | 5.90 | **112** / 127 | 267 | 10.08 | **113** / 121 | 180 | 7.80 (100) | OK [714, 604, 909] | -24.0 | **2.4** (1.6/2.7/3.0) | -4.3 |
| Sarah | multilingual_v2 @1.05 | 4.50 | **147** / 147 | 191 | 8.17 | **139** / 139 | 153 | 4.50 (173) | RUN-ON [0, 0, 418] | -17.0 | **1.3** (1.8/0.9/1.3) | -1.3 |
| Liam | multilingual_v2 @1.12 | 4.04 | **163** / 182 | 353 | 8.13 | **140** / 150 | 237 | 6.27 (124) | OK [634, 809, 1006] | -24.7 | **1.8** (0.4/1.4/3.5) | -5.2 |
| Liam | v3 | 4.08 | **162** / 162 | 267 | 8.56 | **133** / 133 | 183 | 7.28 (107) | OK [540, 382, 1022] | -23.7 | **3.1** (0.5/2.4/6.5) | -2.6 |
| Brian | v3 | 4.32 | **153** / 153 | 232 | 8.96 | **127** / 127 | 164 | 6.80 (115) | OK [557, 323, 650] | -19.0 | **1.4** (1.4/1.4/1.5) | -0.9 |

## One file per candidate — hook · tutorial · close, 0.7s apart (listen to these)

LRA measured over the ~17s of the three lines together — the only loudness-range figure here with enough audio under it.
wpm = 43 words ÷ (length − the two 0.7s joins).

| voice | model @speed | file | s | wpm | LUFS | LRA (LU) | true peak dBFS |
|---|---|---|---|---|---|---|---|
| Liam | multilingual_v2 @1.05 | `Liam-multilingual_v2.mp3` | 19.09 | 146 | -24.7 | **2.3** | -5.2 |
| Brian | multilingual_v2 @1.05 | `Brian-multilingual_v2.mp3` | 18.68 | 149 | -24.5 | **3.5** | -5.2 |
| Eric | multilingual_v2 @1.05 | `Eric-multilingual_v2.mp3` | 18.68 | 149 | -24.1 | **2.8** | -5.5 |
| Adam | multilingual_v2 @1.05 | `Adam-multilingual_v2.mp3` | 21.60 | 128 | -17.5 | **4.9** | -1.3 |
| Bill | multilingual_v2 @1.05 | `Bill-multilingual_v2.mp3` | 25.18 | 109 | -24.2 | **5.0** | -4.8 |
| Sarah | multilingual_v2 @1.05 | `Sarah-multilingual_v2.mp3` | 18.58 | 150 | -17.6 | **2.4** | -1.7 |
| Liam | multilingual_v2 @1.12 | `Liam-multilingual_v2-speed1.12.mp3` | 19.84 | 140 | -25.0 | **3.4** | -5.6 |
| Liam | v3 | `Liam-v3.mp3` | 21.32 | 130 | -24.2 | **7.1** | -3.1 |
| Brian | v3 | `Brian-v3.mp3` | 21.48 | 128 | -19.5 | **1.8** | -1.3 |

## eleven_v3 against eleven_multilingual_v2 @1.05, same voice, same line

v3 refuses previous_text / next_text (HTTP 400 unsupported_model, measured), so its clips are rendered without film context.

| voice | line | v2 s | v3 s | ratio | wpm v2 → v3 | LRA v2 → v3 | beats | verdict |
|---|---|---|---|---|---|---|---|---|
| Liam | hook | 4.60 | 4.08 | 0.89 | 144 → 162 | 1.0 → 0.5 |  | clean |
| Liam | tutorial | 7.43 | 8.56 | 1.15 | 153 → 133 | 1.0 → 2.4 |  | clean |
| Liam | close | 5.67 | 7.28 | 1.28 | 138 → 107 | 2.3 → 6.5 | OK → OK | OUTSIDE ±20% |
| Brian | hook | 3.81 | 4.32 | 1.13 | 173 → 153 | 0.3 → 1.4 |  | clean |
| Brian | tutorial | 7.94 | 8.96 | 1.13 | 144 → 127 | 1.5 → 1.4 |  | clean |
| Brian | close | 5.53 | 6.80 | 1.23 | 141 → 115 | 1.5 → 1.5 | OK → OK | OUTSIDE ±20% |

## Viewer question (f4-s5-viewer, v2, speed 1.0)

| voice | labels | s | wpm | RMS dBFS | true peak | LUFS | LRA |
|---|---|---|---|---|---|---|---|
| Sarah | female · mature, reassuring, confident · TV | 2.28 | 211 | -17.5 | -3.6 | -17.0 | 0.0 |
| Bella | female · professional, bright, warm | 2.32 | 207 | -18.9 | -4.0 | -18.8 | 0.0 |

## Every clip

| file | clip | words | s | wpm | trimmed wpm | artic. | RMS dBFS | peak | true peak | LUFS | LRA | lead / tail ms | inner silences ≥150ms (ms) | beats: gap by alignment / silence (ms) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `Liam-multilingual_v2-hook.mp3` | f1-s2 | 11 | 4.60 | 144 | 153 | 282 | -25.6 | -5.6 | -5.5 | -24.4 | 1.0 | 0 / 481 | [704, 308, 526, 236] |  |
| `Liam-multilingual_v2-tutorial.mp3` | f2-s5 | 19 | 7.43 | 153 | 160 | 212 | -25.1 | -5.5 | -5.5 | -24.4 | 1.0 | 0 / 512 | [315, 460, 393, 372] |  |
| `Liam-multilingual_v2-close.mp3` | f1-s10 | 13 | 5.67 | 138 | 140 | 258 | -25.2 | -4.8 | -4.7 | -23.9 | 2.3 | 0 / 284 | [710, 516, 460, 674] | Touch 592/710 · Ask 430/516 · Steer 383/460 · Flow 615/674 |
| `Brian-multilingual_v2-hook.mp3` | f1-s2 | 11 | 3.81 | 173 | 182 | 284 | -23.7 | -6.4 | -6.4 | -23.3 | 0.3 | 0 / 383 | [442, 413, 249] |  |
| `Brian-multilingual_v2-tutorial.mp3` | f2-s5 | 19 | 7.94 | 144 | 144 | 201 | -24.8 | -5.9 | -5.8 | -24.1 | 1.5 | 0 / 0 | [487, 563, 496, 716] |  |
| `Brian-multilingual_v2-close.mp3` | f1-s10 | 13 | 5.53 | 141 | 145 | 233 | -25.2 | -4.7 | -4.7 | -24.5 | 1.5 | 0 / 336 | [673, 286, 199, 691] | Touch 568/673 · Ask 209/286 · Steer 174/199 · Flow 627/691 |
| `Eric-multilingual_v2-hook.mp3` | f1-s2 | 11 | 4.27 | 154 | 167 | 258 | -24.7 | -6.6 | -6.6 | -24.0 | 1.2 | 0 / 520 | [660, 314, 222] |  |
| `Eric-multilingual_v2-tutorial.mp3` | f2-s5 | 19 | 8.45 | 135 | 143 | 200 | -24.2 | -5.9 | -5.9 | -23.3 | 1.6 | 0 / 667 | [377, 723, 992] |  |
| `Eric-multilingual_v2-close.mp3` | f1-s10 | 13 | 4.55 | 171 | 178 | 253 | -24.4 | -5.0 | -5.0 | -23.4 | 1.3 | 0 / 362 | [689, 419] | Touch 546/689 · Ask 58/0 · Steer 105/0 · Flow 301/419 |
| `Adam-multilingual_v2-hook.mp3` | f1-s2 | 11 | 4.55 | 145 | 147 | 254 | -17.5 | -1.1 | -1.1 | -16.4 | 1.1 | 0 / 273 | [440, 629, 357, 250] |  |
| `Adam-multilingual_v2-tutorial.mp3` | f2-s5 | 19 | 8.36 | 136 | 136 | 179 | -17.9 | -1.7 | -1.7 | -17.1 | 2.0 | 0 / 0 | [549, 425, 376, 191, 441] |  |
| `Adam-multilingual_v2-close.mp3` | f1-s10 | 13 | 7.29 | 107 | 108 | 205 | -19.5 | -0.9 | -0.9 | -17.0 | 5.6 | 0 / 295 | [864, 680, 724, 928] | Touch 731/864 · Ask 627/680 · Steer 743/724 · Flow 918/928 |
| `Bill-multilingual_v2-hook.mp3` | f1-s2 | 11 | 5.90 | 112 | 127 | 267 | -26.3 | -7.9 | -7.9 | -24.3 | 1.6 | 0 / 885 | [592, 590, 715, 643] |  |
| `Bill-multilingual_v2-tutorial.mp3` | f2-s5 | 19 | 10.08 | 113 | 121 | 180 | -24.0 | -6.3 | -6.3 | -23.0 | 2.7 | 0 / 865 | [881, 724, 411, 318, 531] |  |
| `Bill-multilingual_v2-close.mp3` | f1-s10 | 13 | 7.80 | 100 | 102 | 184 | -26.2 | -4.5 | -4.3 | -24.6 | 3.0 | 0 / 372 | [154, 808, 714, 604, 909] | Touch 661/808 · Ask 615/714 · Steer 580/604 · Flow 870/909 |
| `Sarah-multilingual_v2-hook.mp3` | f1-s2 | 11 | 4.50 | 147 | 147 | 191 | -17.1 | -1.3 | -1.3 | -16.7 | 1.8 | 0 / 0 | [360, 305, 235, 154] |  |
| `Sarah-multilingual_v2-tutorial.mp3` | f2-s5 | 19 | 8.17 | 139 | 139 | 153 | -17.4 | -1.5 | -1.5 | -17.5 | 0.9 | 0 / 0 | [270, 191, 261] |  |
| `Sarah-multilingual_v2-close.mp3` | f1-s10 | 13 | 4.50 | 173 | 174 | 219 | -17.0 | -1.4 | -1.4 | -16.7 | 1.3 | 0 / 230 | [291, 418] | Touch 371/291 · Ask 58/0 · Steer 104/0 · Flow 325/418 |
| `Liam-multilingual_v2-speed1.12-hook.mp3` | f1-s2 | 11 | 4.04 | 163 | 182 | 353 | -26.6 | -5.3 | -5.3 | -25.3 | 0.4 | 0 / 607 | [801, 185, 410, 169] |  |
| `Liam-multilingual_v2-speed1.12-tutorial.mp3` | f2-s5 | 19 | 8.13 | 140 | 150 | 237 | -25.3 | -5.2 | -5.2 | -24.1 | 1.4 | 0 / 723 | [472, 794, 703, 258, 359] |  |
| `Liam-multilingual_v2-speed1.12-close.mp3` | f1-s10 | 13 | 6.27 | 124 | 126 | 292 | -26.7 | -5.3 | -5.3 | -24.7 | 3.5 | 0 / 286 | [862, 634, 809, 1006] | Touch 754/862 · Ask 511/634 · Steer 731/809 · Flow 918/1006 |
| `Liam-v3-hook.mp3` | f1-s2 | 11 | 4.08 | 162 | 162 | 267 | -24.1 | -2.9 | -2.8 | -23.1 | 0.5 | 0 / 172 | [598, 165, 399, 276] |  |
| `Liam-v3-tutorial.mp3` | f2-s5 | 19 | 8.56 | 133 | 133 | 183 | -23.7 | -2.6 | -2.6 | -23.0 | 2.4 | 0 / 0 | [621, 558, 216, 538, 195, 214] |  |
| `Liam-v3-close.mp3` | f1-s10 | 13 | 7.28 | 107 | 107 | 199 | -26.5 | -6.6 | -6.6 | -24.9 | 6.5 | 0 / 0 | [223, 1193, 540, 382, 1022] | Touch 1080/1193 · Ask 450/540 · Steer 240/382 · Flow 1024/1022 |
| `Brian-v3-hook.mp3` | f1-s2 | 11 | 4.32 | 153 | 153 | 232 | -19.0 | -1.0 | -0.9 | -18.7 | 1.4 | 0 / 0 | [345, 317, 470, 342] |  |
| `Brian-v3-tutorial.mp3` | f2-s5 | 19 | 8.96 | 127 | 127 | 164 | -19.4 | -1.7 | -1.7 | -19.1 | 1.4 | 0 / 0 | [485, 430, 443, 257, 408] |  |
| `Brian-v3-close.mp3` | f1-s10 | 13 | 6.80 | 115 | 115 | 179 | -19.8 | -1.1 | -1.1 | -19.1 | 1.5 | 0 / 0 | [265, 648, 557, 323, 650] | Touch 760/648 · Ask 280/557 · Steer 400/323 · Flow 704/650 |
| `Sarah-multilingual_v2-viewer.mp3` | f4-s5-viewer | 8 | 2.28 | 211 | 216 | 237 | -17.5 | -3.6 | -3.6 | -17.0 | 0.0 | 0 / 252 | [] |  |
| `Bella-multilingual_v2-viewer.mp3` | f4-s5-viewer | 8 | 2.32 | 207 | 214 | 235 | -18.9 | -4.0 | -4.0 | -18.8 | 0.0 | 0 / 279 | [] |  |
## Judgment — and the pick

**Narrator: Liam `TX3LPaxmHKxFdv7VOQHJ` on `eleven_multilingual_v2`, stability 0.45 · similarity 0.8 · style 0.4 · speaker boost · speed 1.05.
Viewer question: Sarah `EXAVITQu4vr4xnSDxMaL`, same model, speed 1.0. eleven_v3 NOT adopted for film 1.** Set as the defaults of
`synthesize-elevenlabs.mjs`; every clip in `audio/` was made with it. Listen to `Liam-multilingual_v2.mp3` first, then `Brian-multilingual_v2.mp3`.

The measurements, against the brief's criteria (kinetic US SaaS trailer: hook 165–185 wpm, never under 150; LRA 6–12 expressive,
under 4 flat; no clipping; confident/energetic labels, not comforting):

- **Pace is a tie between Liam and Brian, split by line.** Over the three lines together Liam runs 146 wpm and Brian 149 (Eric 149,
  Sarah 150, Adam 128, Bill 109). On the hook alone Brian hits the target (173 as delivered, 182 trimmed) and Liam misses it
  (144 as delivered — under the floor — 153 with its 481ms tail cut to 200ms); on the sustained tutorial line it is the other way
  round, Liam 153/160 and Brian 144 under the floor. Both articulate at the same speed (hook: 282 vs 284 wpm of actual speech) —
  Brian is quicker on the hook only because he pauses less there (1.1s of gaps vs Liam's 1.8s). Nobody reaches 165 on the hook
  as delivered: the line has two performed pauses ("Go on — touch it. Grab the motor… spin it.") and every voice honours them.
- **Speed is not a reliable lever on v2.** Liam at 1.12 shortened the hook (4.60 → 4.04s) but LENGTHENED the tutorial (7.43 → 8.13s)
  and the close (5.67 → 6.27s): take-to-take variance is bigger than the 7% the setting asks for, and articulation jumped to
  353 wpm on the hook (fast words, long gaps). 1.05 stays. The synthesizer still tries speed ≤ 1.12 on an over-slot clip, then trims.
- **Every v2 read is flat by the LRA criterion.** Per clip 0.3–3.0 LU (Adam's close 5.6); over the three lines together Liam 2.3,
  Brian 3.5, Eric 2.8, Sarah 2.4, Adam 4.9, Bill 5.0. That is the model at these settings, not one voice. The only read in the
  expressive band is **Liam on eleven_v3: 7.1 LU** — see below for why it still lost.
- **No clipping anywhere.** True peak −0.9 to −7.9 dBFS. Adam and Sarah are ~7 dB louder than Liam/Brian (−16.4/−16.7 vs −24.4/−23.3
  LUFS); the assembler's loudnorm levels the mix, but note the Edge take sat at −21 LUFS, so Liam's clips are ~3 dB quieter than
  what the music beds were balanced against.
- **The four beats.** Liam, Brian, Adam and Bill break "Touch it. Ask it. Steer it. — Flow Video." into four beats on the first take
  (silence before Ask/Steer/Flow: Liam 516/460/674ms, Brian 286/199/691ms). **Eric and Sarah run "Touch it. Ask it. Steer it." together**
  (0/0ms) — a narrator disqualifier for the tagline, and the reason the film synthesizer carries a beat check with an ellipsis
  retake. Liam's beats are the safest margin above the 150ms threshold; Brian's 199ms is one take away from a run-on.
- **Labels decide the tie.** Liam is *Energetic, Social Media Creator* (vendor name), *energetic, confident, young* (labels) — the
  brief's "Touch it. Ask it. Steer it." register. Brian's vendor name is *Deep, Resonant and Comforting*: "comforting" is the one
  word the brief rules out for a marketing read. Eric (*smooth, trustworthy*) and Bill (*older, crisp*, 109 wpm) read as narration,
  not a trailer; Adam (*dominant, firm*) is the loudest and slowest of the men.
- **Runner-up: Brian** (`--narrator nPczCjzI2devNBz1zQrb`) if Liam reads too young by ear — same pace overall, tighter beats, a
  shade more range (3.5 vs 2.3 LU).

**Why not eleven_v3 for the ten teaser lines.** The rule was: prefer v3 for film 1 if its clips are clean — within ±20% of the v2
length, never under 0.4s, never 3× long. Four of six pass; **both closes fail** (Liam 7.28s vs 5.67s = 1.28×, Brian 6.80s vs 5.53s =
1.23×) because v3 makes the beat pauses ~1s each. v3 is also slower across the board (Liam 130 wpm vs 146 over the three lines;
tutorial 133 vs 153), **refuses previous_text/next_text (HTTP 400 unsupported_model)** so the teaser would lose line-to-line
continuity, and ignores speed, so an over-slot v3 clip has no lever but trimming — and its clips have no tail to trim (0ms). On
film 1's tight slots (s1 budget 1.5s, s7 2.5s, s10 5.5s — the v3 close alone would stretch scene 10 by 1.8s) that is a timing cost
with no fix. The upside is real and measured — Liam v3 is the one expressive read here (LRA 7.1) — so it is a one-flag owner
choice, not a default: `node synthesize-elevenlabs.mjs --auth <file> --force --only f1-s1,…,f1-s10 --film-model 1=eleven_v3`.

**Viewer: Sarah.** 2.28s for the 8-word question (211 wpm — a question asked, not read), −17 LUFS (7 dB above the narrator, so it cuts
through mid-video), true peak −3.6, a clearly different person from Liam. Bella is the alternate (`--viewer hpp4J3VqNfWAUOO0d1Us`,
2.32s, −18.8 LUFS): interchangeable by the numbers, a taste call by ear.

**Spend for this audition:** 29 requests, 2,226 characters of text sent; the vendor's ledger (`/v1/history` character_count_change =
the `character-cost` response header) recorded 1,225 for them — this account is billed ≈0.55 per character on these models. The
`/v1/user/subscription` counter is batch-updated (it read 289 at the start of the session while the history already held ~12k of
earlier v3 use) — read the history, not the counter, to meter a run.
