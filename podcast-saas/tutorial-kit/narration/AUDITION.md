# Narration voice audition — Edge neural voices (review phase)

Generated 2026-09-05T12:29:48.173Z by `narration/audition.mjs`. **Nobody who wrote this could hear the
clips.** Every column below is a measurement or a documented voice trait; the owner picks by ear from
`narration/audition/*.mp3`. Each `<voice>-<rate>.mp3` plays the hook, the longest tutorial line and
the four-beat close, in that order, 0.7s apart. `<voice>-+8%-raw.mp3` is the same read with
the pauses exactly as the voice spoke them — the A/B for what the pause editor does.

Lines: hook = "This looks like a video. It isn't. Go on — touch it." · tutorial = lines.json film 2 scene 5 (19 words: "Pick Simulation. Choose your package. Open Generate mini model — and tell it, in plain words, what this moment's for:") · close = "Touch it. Ask it. Steer it. — Flow Video." · viewer question = "Why doesn't the moon crash into the earth?".
Pace preset `trailer`: sentence 420ms · question 500ms · colon 320ms · beat 560ms · brand 720ms · ellipsis 620ms · dash 250ms · lead 80ms · tail 200ms.

## What the endpoint can and cannot do (measured, 41 probe requests)

- **Not served:** `en-US-DavisNeural`, `en-US-JasonNeural` — the socket closes without audio; they are Azure-only.
  Stand-ins with the same brief (warm confident male / casual younger male): **Andrew**, **Brian** — the newest
  conversational generation Microsoft ships, and the two voices with the tightest native pauses.
- **No inner SSML:** `<break>`, `<emphasis>`, `<mstts:express-as style>`, `<say-as>`, `<sub>`, nested
  `<prosody>` all kill the request. Only the outer `<prosody rate pitch volume>` is honored. Punctuation cannot
  lengthen a pause either ("Touch it..." = "Touch it." = 863ms on Guy), a sentence-initial "…" adds nothing, and
  Guy/Brian run straight through " — " (23–91ms of gap).
- **Therefore the beats are edited, not spoken:** the word-boundary metadata the service streams with the audio
  locates every gap; the pause editor resizes the sentence / question / colon / beat / brand / ellipsis / dash gaps
  in the decoded PCM. It removes or inserts *silence only*, cutting in the middle of the measured silent span
  (or, where the voice ran the words together, dropping the beat at the quietest 5ms of the boundary with fades).
  Speech is never time-stretched, so there is no chipmunk path except `pitch`, which is why pitch stays ≤ +4% here.
- Word-boundary timeline vs decoded audio: 79 clips, speech-onset delta median 79ms,
  max |Δ| 140ms (the cuts are placed from the decoded audio; the metadata only says WHICH gap).

## Judgment criteria

1. **Overall wpm** (words ÷ clip length, after pause editing). A US product-trailer read sits around 155–175;
   the scripts were written for "~150 wpm in bursts", and the air lives between beats, not inside a line.
2. **Articulated wpm** (words ÷ time actually speaking) — the voice's intrinsic tempo; short lines inflate it.
   Compare voices on the tutorial line rather than the hook.
3. **Energy proxy:** integrated loudness (LUFS) and RMS (dBFS) — how much level the voice puts out at the same
   volume setting; **LRA** (loudness range, LU) — how much it moves within the read (flat = monotone).
4. **Pause naturalness:** the median sentence gap *as the voice spoke it* (the "native gap"). ~870ms is the
   audiobook cadence the owner rejected; ~400ms is trailer cadence. The close-beats column shows the
   "Touch it. Ask it. Steer it. — Flow Video." gaps before → after the editor (target [420, 420, 720]).
5. **Documented character** (Microsoft's own VoicePersonalities tags): Guy *Passion* · Andrew *Warm, Confident,
   Authentic* · Brian *Approachable, Casual* · Aria *Positive, Confident* · Jenny *Friendly, Considerate* ·
   Emma *Cheerful, Clear* · Ava *Expressive, Friendly* · Roger *Lively* · Christopher *Reliable, Authority* ·
   Steffan *Rational*.
6. **Artifact risk:** rate is a duration-model change (safe to +15%); pitch shifts formants (kept ≤ +4%).

## The rejected take, for reference (Guy, +4%, pauses as spoken)

| clip | dur | RMS dBFS | LUFS | LRA | inner gaps (ms) |
|---|---|---|---|---|---|
| `before-guy+4pct-f1-s2.mp3` | 10.15 | -21.5 | -20.2 | 3.8 | [950, 965, 180, 970, 165] |
| `before-guy+4pct-f1-s8.mp3` | 6.29 | -23.7 | -20.3 | 1.1 | [950, 970, 1000] |
| `before-guy+4pct-f2-s4.mp3` | 25.37 | -20.7 | -19.7 | 3.2 | [165, 940, 160, 960, 935, 200, 1005, 1025, 970] |

Whole-film narration of that take: f1 66.7s · f2 121.1s · f3 68.1s · f4 55.8s · f5 50.5s (39 clips, v2.1 scripts).

## Matrix — narrator candidates

dur = hook / tutorial / close after pause editing; "raw → edited" = the three lines' total before → after.

| voice | rate | file | dur h/t/c (s) | raw → edited (s) | wpm | artic. wpm | RMS dBFS | LUFS | LRA | native gap (ms) | close beats raw → edited (ms) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Guy | +8% | `Guy-+8%.mp3` | 4.07 / 7.12 / 4.07 | 20.18 → 15.25 | 149 | 225 | -21.9 | -20.9 | 3.5 | 910 | [910, 940, 960] → [415, 425, 720] |
| Guy | +15% | `Guy-+15%.mp3` | 3.87 / 6.77 / 3.94 | 18.98 → 14.58 | 156 | 239 | -22.1 | -20.9 | 3.6 | 860 | [855, 885, 905] → [415, 415, 715] |
| Aria | +8% | `Aria-+8%.mp3` | 4.20 / 7.38 / 4.19 | 20.83 → 15.77 | 145 | 212 | -23.1 | -21.9 | 4.2 | 910 | [925, 940, 1025] → [415, 415, 715] |
| Aria | +15% | `Aria-+15%.mp3` | 4.03 / 7.00 / 4.04 | 19.58 → 15.07 | 151 | 227 | -23.2 | -22.0 | 4.5 | 855 | [875, 885, 960] → [415, 415, 715] |
| Jenny | +8% | `Jenny-+8%.mp3` | 3.83 / 7.22 / 3.99 | 20.40 → 15.04 | 152 | 224 | -23.0 | -22.2 | 3.4 | 915 | [910, 920, 935] → [415, 415, 720] |
| Jenny | +15% | `Jenny-+15%.mp3` | 3.68 / 6.90 / 3.86 | 19.15 → 14.45 | 158 | 239 | -23.1 | -22.3 | 3.4 | 855 | [855, 865, 880] → [415, 415, 720] |
| Andrew | +8% | `Andrew-+8%.mp3` | 3.29 / 7.12 / 3.27 | 13.85 → 13.69 | 167 | 270 | -21.9 | -21.1 | 4.7 | 400 | [440, 400, 475] → [440, 400, 720] |
| Andrew | +15% | `Andrew-+15%.mp3` | 3.19 / 6.75 / 3.14 | 13.03 → 13.08 | 174 | 289 | -22.0 | -21.2 | 4.7 | 380 | [420, 385, 440] → [420, 385, 720] |
| Brian | +8% | `Brian-+8%.mp3` | 3.81 / 7.07 / 3.71 | 14.62 → 14.59 | 156 | 234 | -22.1 | -21.6 | 4.3 | 420 | [510, 475, 570] → [415, 415, 715] |
| Brian | +15% | `Brian-+15%.mp3` | 3.60 / 6.72 / 3.62 | 13.73 → 13.95 | 163 | 250 | -22.2 | -21.7 | 4.9 | 395 | [480, 450, 545] → [415, 450, 715] |
| Emma | +8% | `Emma-+8%.mp3` | 3.92 / 6.97 / 3.92 | 14.47 → 14.81 | 154 | 223 | -19.7 | -19.2 | 4.8 | 400 | [415, 385, 405] → [415, 385, 720] |
| Emma | +15% | `Emma-+15%.mp3` | 3.75 / 6.69 / 3.83 | 13.63 → 14.28 | 160 | 237 | -19.8 | -19.3 | 5.0 | 380 | [390, 365, 380] → [390, 420, 720] |
| Ava | +8% | `Ava-+8%.mp3` | 3.73 / 7.42 / 3.86 | 15.43 → 15.01 | 152 | 226 | -22.9 | -21.9 | 4.0 | 450 | [485, 450, 520] → [415, 475, 715] |
| Ava | +15% | `Ava-+15%.mp3` | 3.59 / 6.99 / 3.73 | 14.50 → 14.30 | 159 | 242 | -23.0 | -22.0 | 4.0 | 440 | [450, 440, 500] → [450, 440, 720] |
| Roger | +8% | `Roger-+8%.mp3` | 3.85 / 7.69 / 3.74 | 19.34 → 15.28 | 149 | 227 | -26.4 | -25.2 | 4.6 | 710 | [725, 710, 710] → [415, 415, 710] |
| Roger | +15% | `Roger-+15%.mp3` | 3.68 / 7.30 / 3.65 | 18.17 → 14.63 | 156 | 242 | -26.6 | -25.3 | 4.6 | 665 | [665, 670, 670] → [415, 415, 725] |
| Christopher | +8% | `Christopher-+8%.mp3` | 3.72 / 7.51 / 3.99 | 20.74 → 15.22 | 150 | 226 | -21.8 | -21.0 | 3.6 | 905 | [910, 920, 955] → [420, 410, 710] |
| Christopher | +15% | `Christopher-+15%.mp3` | 3.55 / 7.11 / 3.85 | 19.49 → 14.51 | 157 | 241 | -21.9 | -21.0 | 3.1 | 860 | [865, 860, 895] → [420, 415, 715] |
| Steffan | +8% | `Steffan-+8%.mp3` | 3.62 / 7.18 / 3.86 | 18.34 → 14.66 | 156 | 239 | -21.2 | -20.4 | 4.4 | 695 | [690, 700, 745] → [415, 420, 745] |
| Steffan | +15% | `Steffan-+15%.mp3` | 3.48 / 6.82 / 3.67 | 17.21 → 13.97 | 163 | 255 | -21.2 | -20.5 | 4.5 | 655 | [655, 665, 705] → [415, 420, 705] |

## Pitch lift (primaries, hook + close)

| voice | rate | pitch | file | dur h/c (s) | RMS | LUFS | LRA |
|---|---|---|---|---|---|---|---|
| Guy | +12% | +4% | `Guy-+12%-pitch+4%.mp3` | 3.97 / 3.99 | -23.0 | -21.4 | 2.2 |
| Aria | +12% | +4% | `Aria-+12%-pitch+4%.mp3` | 4.09 / 4.10 | -24.1 | -22.5 | 3.2 |
| Jenny | +12% | +4% | `Jenny-+12%-pitch+4%.mp3` | 3.76 / 3.92 | -23.4 | -22.2 | 2.5 |
| Andrew | +12% | +4% | `Andrew-+12%-pitch+4%.mp3` | 3.24 / 3.21 | -22.8 | -21.5 | 4.1 |
| Brian | +12% | +4% | `Brian-+12%-pitch+4%.mp3` | 3.69 / 3.69 | -23.0 | -22.2 | 4.8 |

## Viewer voice (the in-film question, film 4 beat 5), +0%

| voice | file | dur (s) | RMS | LUFS | LRA |
|---|---|---|---|---|---|
| Ava | `viewer-Ava.mp3` | 1.91 | -21.5 | -21.0 | 0.0 |
| Emma | `viewer-Emma.mp3` | 2.39 | -17.8 | -17.7 | 0.0 |
| Jenny | `viewer-Jenny.mp3` | 2.00 | -21.9 | -21.9 | 0.0 |
| Aria | `viewer-Aria.mp3` | 2.00 | -19.1 | -18.6 | 0.0 |
| Michelle | `viewer-Michelle.mp3` | 2.08 | -19.0 | -18.9 | 0.0 |

## Judgment — and the pick

**Default pairing: narrator `en-US-AndrewNeural` at `+12%`, pitch +0Hz · viewer `en-US-EmmaNeural` at +0%.**
Hear exactly that as one file: `pick-Andrew-+12%.mp3` (hook · tutorial · close · viewer question;
3.25 / 6.88 / 3.18 / 2.39 s, -20.5 LUFS). It is set as the defaults in
`synthesize-edge.mjs`; every film clip in `audio/` was made with it.

Why Andrew, over the three requested voices that are served (Guy, Aria, Jenny):

- **The "stuck" is measurable, and it is not the words per minute — it is dead air.** Guy, Aria and Jenny (with
  Christopher, Eric and Michelle) are the older voice generation and hard-code ~910ms after every
  sentence; the rejected take's gaps were 950–1025ms. Andrew, Brian, Emma and Ava are the current conversational
  generation: ~380–450ms native, and a faster, more varied articulation. On the hook, raw, Andrew takes
  3.24s to Guy's 5.54s.
- **The editor equalizes the beats, so the old voices become usable — but it cannot change how a voice moves
  inside a sentence.** Andrew has the quickest intrinsic tempo of the candidates (the "talking with your hands
  full" the teaser direction asks for) while its overall pace after editing sits inside the 155–175 trailer band.
  Across the five films at +12% the whole-film pace lands between ~143 and ~172 wpm (per-film figures in
  EDGE-VOICE-NOTE.md; film 4 is the slow one by design — the count-along beats are punctuation-heavy).
- **Davis and Jason — the two the brief named for exactly this quality — are not on the free endpoint.** Andrew is
  Microsoft's own successor to that brief (*Warm, Confident, Authentic*); Brian is the casual one. **Brian is the
  runner-up**: same generation, ~5–10% slower, a shade more relaxed — `--narrator en-US-BrianNeural` if Andrew
  reads too keen by ear.
- **Rate +12%, not +15%.** On Andrew the two differ by ~3% in overall wpm because the editor holds the beats
  constant, so the extra speed buys nothing measurable and only costs consonants. If the owner prefers Guy, Aria
  or Jenny by ear, +15% is the right setting for them (`--narrator en-US-GuyNeural --rate +15%`).
- **Pitch stays +0Hz.** The +4% lift files are there to hear; the measurements barely move (RMS within 0.5dB), so it
  is a pure taste call — and pitch is the one control on this endpoint that CAN chipmunk.

Why Emma for the viewer: it has to be a different person (Andrew is male; every viewer candidate is female), it has
to cut through mid-video (Emma is the loudest voice in the set by 2–4dB RMS — *Cheerful, Clear*), and the newer
generation asks a question the way a person does rather than reading one. Ava is the alternate
(`--viewer en-US-AvaNeural`): softer and warmer.

**The owner picks by ear.** These proxies rank pace, level and dead air; they do not hear timbre, sibilance, or
whether a read smiles. The short list to play: `pick-Andrew-+12%.mp3`, then `Brian-+8%.mp3`,
then `Guy-+15%.mp3` (the requested voice at its best setting), then `Andrew-+8%-raw.mp3` against
`Andrew-+8%.mp3` to judge the editor itself, then the three `before-*.mp3` for what was rejected. To hear a
different pairing on the real lines: `node synthesize-edge.mjs --force --narrator <voice> --rate <r> --viewer <voice>`.
