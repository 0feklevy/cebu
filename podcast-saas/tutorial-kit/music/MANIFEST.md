# Tutorial-film music beds — manifest

Six original pieces for the five FlowVid tutorial films plus the standalone ambient sting,
synthesized entirely by `music/synthesize.mjs` (node stdlib + ffmpeg encode). Modern minimal
SaaS scoring: warm add9 pad chords in the I–V–vi–IV family, a soft filtered pulse, occasional
detuned-sine shimmer, nothing harder than a soft noise tick, and no melody lines — built to sit
under narration, not compete with it.

All files: 48 000 Hz · stereo · 24-bit PCM WAV · ~1.5 s fade-in · clean fade-out to true silence.

| File | Duration | Integrated | True peak | LRA | BPM | Key | Character |
|---|---|---|---|---|---|---|---|
| `bed-teaser.wav` | 80.0 s | −32.0 LUFS | −20.2 dBFS | 1.9 LU | 100 | C major | Optimistic, forward 8th-note pulse; subtle build from ~72% (octave pad + shimmer + sparkle), held Cadd9 resolve tail. |
| `bed-tutorial.wav` | 140.0 s | −32.0 LUFS | −21.1 dBFS | 2.1 LU | 92 | F major | The calm workhorse: slow two-bar pads, barely-there quarter pulse, one faint late shimmer. Steady, unobtrusive. |
| `bed-heavy.wav` | 85.0 s | −32.0 LUFS | −20.8 dBFS | 1.9 LU | 96 | A minor | Darker/techy for the heavy-WebGL-sim film: low-cutoff minor pads over an A–E drone, squarish pulse with 16th ghosts. |
| `bed-powers.wav` | 78.0 s | −32.0 LUFS | −20.8 dBFS | 1.5 LU | 104 | D major | Brighter and playful: gentle 1-5-8-5 sine-pluck texture, present shimmer, light pulse. |
| `bed-share.wav` | 70.0 s | −32.0 LUFS | −21.2 dBFS | 2.1 LU | 92 | G major | Warm closer energy: Em–C–G–D, IV–V lift into a long held Gadd9 with shimmer and a generous tail. |
| `sting-ambient.wav` | 8.0 s | −24.0 LUFS | −12.0 dBFS | 15.9 LU | rubato | F (Fmaj9) | Standalone ambient sting — pad bloom + sub + staggered shimmer into a long reverb tail. Also the seeded demo project's A2 asset. |

## Levels

The five beds are normalized to **−32 LUFS integrated (±1)** — roughly 13 dB under a −19 LUFS
narration track, inside the 12–18 dB music-under-voiceover window, so they can be laid under the
films at unity gain. `sting-ambient.wav` plays alone and is normalized to **−24 LUFS integrated**.
No file peaks above −12 dBFS; nothing clips.

## License

All six pieces are **original works synthesized from first principles** at render time by
`synthesize.mjs` in this directory: sine/polyBLEP-saw oscillators, seeded-PRNG noise, envelopes,
one-pole filters, a ping-pong feedback delay and a comb/allpass reverb. **No samples, no
third-party loops or presets, no quoted melodies, no copyrighted material of any kind.**
License-clean by construction: use, modification, distribution and commercial use are
unrestricted, no attribution required.

## Regenerate / verify

```bash
node synthesize.mjs            # re-renders all six files, bit-identical (seeded PRNG)
node synthesize.mjs teaser     # or a subset: teaser tutorial heavy powers share sting

# loudness:  ffmpeg -i <file> -af ebur128=peak=true -f null -      (summary I: / Peak:)
# format:    ffprobe -show_entries stream=sample_rate,channels <file>
```

Loudness calibration lives in `TRACK_GAIN_DB` inside the script (measured with ffmpeg ebur128
against the −6 dBFS peak-normalized first pass, then baked in). Verified 2026-09-05 with
ffmpeg/ffprobe 8.1.2: durations exact, 48 kHz/2ch, integrated loudness on target, MP3
listen-proxy excerpts non-silent and unclipped, end-of-file tails below −130 dB RMS.
