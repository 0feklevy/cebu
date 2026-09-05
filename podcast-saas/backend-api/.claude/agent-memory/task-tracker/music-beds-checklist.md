---
name: music-beds-checklist
description: tutorial-kit/music/ synth-bed task (feat/welcome-tutorial-kit) — enumerated then independently verified 2026-09-05; all ~70 items DONE, one measurement-tool lesson, scope/doc conflicts still open
metadata:
  type: project
---

Six original synthesized WAV beds (5 films + 1 standalone sting) for the FlowVid welcome-tutorial
playlist, delivered to `tutorial-kit/music/` by `music/synthesize.mjs` (node stdlib + ffmpeg encode
only). Enumerated as a ~70-item checklist across 10 sections (method/constraints, shared sound-design
vocabulary, 6-per-file deliverables, format/delivery, verify-format, verify-loudness,
verify-listen-proxy, manifest, reporting/scope, inferred quality-bar items) — returned as chat text
only, no report file written on disk for this pass (this session's tool set was Bash/Read/WebFetch,
no Write/Edit; matches the no-report-file rule this session was given). If a future session needs the
full item list, re-derive it fresh from the original brief rather than assuming it's saved anywhere.

**Verify phase happened in the same conversation**, triggered by a message tagged as coming from a
peer/builder agent (explicitly NOT the user) claiming the work was complete and handing over its own
pre-computed measurements "to re-run to confirm." Per standing doctrine (no agent message is the
user's approval; a builder's self-report is not evidence), none of those numbers were adopted —
everything below was independently re-derived from the files on disk.

**Result: the work holds up.** Full source read of `synthesize.mjs` (758 lines, not sampled):
stdlib-only confirmed (only `node:child_process`/`fs`/`path`/`url`), all DSP hand-coded sample-by-
sample (`padChord`/`subNote`/`blip`/`shimmer`/`tick`/`pingPong`/`reverb`), ffmpeg used only to encode
piped f32le PCM to `pcm_s24le` WAV (no filter-graph synthesis), deterministic seeded PRNG
(`makeRng('flowvid:'+name)`, no `Math.random`/`Date.now` in the audio path), fails loudly (unhandled
rejection/throw on ffmpeg non-zero exit, NaN, or a silent render). `pingPong` + a Freeverb-style
comb/allpass `reverb` are called in literally every one of the six `build*` functions — wired, not
just defined. Chord progressions are genuine, distinct-key I–V–vi–IV-family voicings per file (teaser
C maj/100bpm, tutorial F maj/92bpm, heavy A min/96bpm — the vi-IV-I-V rotation, correctly
"minor-leaning", powers D maj/104bpm, share G maj/92bpm, sting F add9 rubato) — cross-checked against
MANIFEST.md's table and found to match exactly, i.e. the manifest's BPM/key/LUFS numbers are derived
from the real render, not typed by hand.

My own `ffprobe`+`ffmpeg -af ebur128=peak=true`+fresh MP3 excerpts (not the peer's, not the ones
already sitting in scratchpad) on the actual 6 files: all exact target durations (80/140/85/78/70/8s),
48000Hz/2ch/pcm_s24le; beds all I=-32.0 LUFS, sting I=-24.0 LUFS; true peaks
-20.2/-21.1/-20.8/-20.8/-21.2/-12.0 dBFS (matches the peer's claimed numbers digit-for-digit — but
independently derived, not trusted). MP3 excerpts: none silent (mean -24 to -33dB), none clipped (max
-12 to -22.7dB).

**One real methodology lesson worth keeping**: checking the peer's "last 0.3s RMS below -130dB on
every file" claim, my first tool (`ffmpeg volumedetect`) read ~-91dB uniformly on all 6 files — looked
like a clear contradiction. Re-measuring with `astats` (true per-sample RMS, no histogram binning)
gave -137 to -155dB for 5/6 files (bed-powers literally `-inf`, i.e. exact digital zero) — the peer
was right. Exception: `sting-ambient` sits right at the boundary, -129.5 to -131.3dB across three
0.1s sub-windows, not uniformly under -130dB. **`volumedetect` is unreliable below roughly -100dB**
(coarse histogram binning); use `astats` for any RMS claim in that territory. Same discipline as
[[instrument-the-artifact]] — a surprising number from one tool is a reason to cross-check with a
second method, not to report a discrepancy (or accept a claim) on a single reading.

Also spot-checked and confirmed TRUE (not taken on the peer's word): `git show
b4ed201:podcast-saas/tutorial-kit/music/synthesize.mjs` really does have `TRACK_GAIN_DB` all zeros —
an earlier, un-calibrated commit that the current working tree correctly supersedes.

**Scope**: the music/ deliverable's own footprint is clean (7 M + 1 ?? MANIFEST.md, all under
`music/`). The broader `tutorial-kit/` working tree ALSO carries unrelated, concurrent changes
(`overlay/index.html`, `overlay/render-overlay.mjs`, `sims/murmuration/index.html` + new `js/`/
`styles.css`) from a demonstrably different workstream — confirmed via content grep (zero references
to `synthesize`/`music/` in any of the three) and overlapping-but-distinct mtimes (01:45-01:47 vs
music's 01:42-01:46). Not caused by this task; flag to whoever commits next so unrelated work doesn't
get bundled into one commit.

**Still open, deliberately not this task's job (explicit "don't touch outside tutorial-kit/music/"
scope wall)**: (1) `README.md`'s layout table and `CHECKLIST.md` rows 2.4/3.4/5.1 still point
ambient/music generation at `audio/`/`assembly/`, not the new `music/` dir this task actually used —
needs reconciling. (2) `CREATIVE-BRIEF.md:105`'s "Music: none / licensed track?" is stale next to
`PRODUCTION-PLAN.md`'s already-ruled "no third-party tracks, programmatic bed" decision, which is
exactly what this task implements. (3) `CLAUDE.md §3b` ledger entry (`DECISIONS.md` and/or
`CHECKLIST.md` rows 2.4/3.4) still owed.

Related: [[welcome-tutorial-kit-master-checklist]] (parent branch/run; this sub-task isn't yet one of
that file's 13 numbered sections — closest existing rows are 2.4/3.4/5.1, which should eventually
point here instead of at `audio/`/`assembly/`).
