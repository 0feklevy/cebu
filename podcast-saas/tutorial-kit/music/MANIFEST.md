# Tutorial-film music beds — manifest

Five original DRIVING beds for the FlowVid tutorial films plus the standalone ambient sting,
synthesized entirely by `music/synthesize.mjs` (node stdlib + ffmpeg encode). v2 rework
(2026-09-05): modern kinetic US-SaaS-ad energy — four-on-the-floor synthesized kick,
sidechain-pumped pads, punchy filtered saw stabs, moving 8th-note basslines, tight synthesized
claps/hats/ticks, noise risers into section lifts, and hard button endings. Built to carry energy
under speech, not to wallpaper behind it.

All files: 48 000 Hz · stereo · 24-bit PCM WAV. The four driving beds end on a clean button hit
(no fade-out); `bed-share` resolves on a rung chord. `bed-teaser` opens with a 4-second rise that
crests exactly at 0:04 (the first live-window moment).

| File | Duration | Integrated | True peak | LRA | BPM | Key | Character |
|---|---|---|---|---|---|---|---|
| `bed-teaser.wav` | 62.4 s | −27.0 LUFS | −15.9 dBFS | 1.7 LU | 108 | A minor | Kinetic opener: 4 s riser into the drop at 0:04, offbeat filtered stabs pumping against the kick, momentum lift every 4 bars (~8.9 s), half-bar breath at ~0:31 then slam, da-da-DUM hard button end for the triple-tap close. |
| `bed-tutorial.wav` | 101.2 s | −27.0 LUFS | −13.2 dBFS | 2.1 LU | 98 | D minor | Driving workhorse, narration-friendly: the moving 8th-note bassline is the lead voice, tight soft-edged drums, section lifts every 8 bars, quiet offbeat comps, soft button end. |
| `bed-heavy.wav` | 51.4 s | −27.0 LUFS | −15.6 dBFS | 1.1 LU | 104 | E minor | 'Drop In Anything' — confident and practical: chunky groove with an extra kick on the and-of-3, square-shouldered on-beat stabs over Em–C–G–D, one-bar build-in, tight button end. |
| `bed-powers.wav` | 56.3 s | −27.0 LUFS | −14.9 dBFS | 1.9 LU | 112 | C major | Playful-energetic and bright: swung 16th plucks, octave-bounce bass, offbeat house stabs, pentatonic bloops, a stutter-fill bar, button end with a cheeky upward bloop. |
| `bed-share.wav` | 46.8 s | −27.0 LUFS | −13.7 dBFS | 0.9 LU | 100 | F major | Warm but forward: plucked-string arps and strums over a soft four-on-the-floor, F–Dm–Bb–C with a Bb–C lift, resolving on a rung Fmaj9 (clean stop, short natural ring). |
| `sting-ambient.wav` | 8.0 s | −24.0 LUFS | −12.0 dBFS | 15.9 LU | rubato | F (Fmaj9) | KEPT AS-IS from v1 (unchanged bytes) — standalone ambient sting, pad bloom + sub + staggered shimmer into a long reverb tail. Also the seeded demo project's A2 asset. |

## Levels

The five beds are normalized to **−27 LUFS integrated (±1)** — hot enough to carry energy under a
−19 LUFS narration track (~8 dB under) while leaving the voice on top. Each render self-measures
with an internal ITU-R BS.1770-4 meter and lands on target exactly (confirmed by ffmpeg ebur128:
I = −27.0 for all five). True peaks sit between −15.9 and −13.2 dBFS — far inside the **≤ −2 dBTP**
ceiling — and nothing clips (mix headroom ≥ 11 dB, flat factor 0). `sting-ambient.wav` plays alone
and remains at **−24 LUFS integrated**.

## License

All six pieces are **original works synthesized from first principles** at render time by
`synthesize.mjs` in this directory: sine and polyBLEP-saw oscillators, seeded-PRNG noise,
Karplus-Strong plucked strings excited by seeded noise, biquad/one-pole/state-variable filters,
synthesized kick/clap/hat/shaker percussion, a ping-pong feedback delay, tanh saturation and a
comb/allpass reverb (sting only). **No samples, no third-party loops or presets, no quoted
melodies, no copyrighted material of any kind** — harmonic material is generic diatonic
progressions with procedurally generated chord-tone riffs. License-clean by construction: use,
modification, distribution and commercial use are unrestricted, no attribution required.

## Regenerate / verify

```bash
node synthesize.mjs            # re-renders the FIVE BEDS, bit-identical (seeded PRNG)
node synthesize.mjs teaser     # or a subset: teaser tutorial heavy powers share
node synthesize.mjs sting      # legacy v1 sting path — only runs when explicitly asked

# loudness:  ffmpeg -i <file> -af ebur128=peak=true -f null -      (summary I: / Peak:)
# format:    ffprobe -show_entries stream=sample_rate,channels <file>
```

Loudness is self-calibrating: each bed measures itself with the built-in BS.1770-4
integrated-loudness meter and normalizes to −27 LUFS (per-track `TRIM_DB` exists for
reconciliation but is 0 everywhere — the internal meter matches ffmpeg 8.1.2 to 0.0 LU).

Verified 2026-09-05 with ffmpeg/ffprobe 8.1.2: durations/format per ffprobe (48 kHz/2ch/24-bit),
integrated loudness −27.0 LUFS on all five beds, true peak ≤ −13.2 dBFS, re-render bit-identical
(sha256), `sting-ambient.wav` bytes unchanged from v1. Listen-proxy checks on `bed-teaser`: 10 s
MP3 excerpt astats non-silent/unclipped with healthy spectral tilt (low/mid/air RMS
−29.4/−38.2/−43.9 dB — kick foundation plus real top end, not mud); ~9–10 dB beat-rate RMS
pumping (the sidechain groove); momentary loudness rises −38 → −26.6 LUFS into the 0:04 drop;
button end profile −27.7 dB groove → −23.4 dB hit → −40.9 dB within 0.35 s (hard stop, no fade).
