# Sound & technical critique — round 3, PRE-assembly

Read-only review of the five Welcome films as they will be BUILT, not as they are described. Every
claim below was checked against the code path that produces the film (`assembly/assemble-film.mjs`,
`seeding/build-template.mjs`), the assets on disk (probed with ffprobe/ebur128), the product's own
player code (`client-web/components/viewer/useProjectPlayer.ts`, `HLSTranscoder.ts`), and one A/B
render of the assembler's exact audio chain on the real bed + Edge clips. Numbers are measured unless
marked "spec". Written 2026-09-05 by the sound/mix + post TD pass; re-checked at 16:35 after the tree
moved mid-review (ElevenLabs beds and VO landed; `--vo-dir`, `voDelay`, `silence`, `zoom`,
`fallbackIn`, viewer-line mixing and auto-risers added to the assembler; every EDL, `lines.json` and
the layout rewritten; films 1–2 re-rendered) — every number below is against the tree at that time.

---

## Verdict (5 lines)

1. **The mix plan is right in intent and wrong in mechanism:** a 30 dB step-cut evaluated per audio
   frame, a single-pass `loudnorm` that is a dynamic processor (measured: +3 dB lift on the bed whenever
   the VO stops, +7 dB on the intro), and an `alimiter` whose default `level=1` adds +1 dB of makeup.
   None of the −27/−19/−6 dB relationships the direction specifies survive the chain as written.
2. **"Music cuts dead" should become "music goes behind the glass":** −8 dB in 120 ms, then −11 dB with
   a 1.4 kHz low-pass — the drop is still an event, but the film is audibly still running (which is the
   product's actual claim). A true cut is right in exactly one place: film 4's ask exchange.
3. **Three ways the assembler will hand the seeder a wrong film with exit code 0:** a VO clip is
   trusted by filename — `lines.json` was rewritten at 16:32, eleven minutes after the production
   ElevenLabs clips were cut, and **17 of 48 clips no longer say their line**; the clips also measure
   **−24.5 LUFS** (5.5 dB under target) with no normalization anywhere; the answer half of film 4's ask
   exchange has no path into the mix (captures carry no audio; the viewer's question now is mixed);
   and the seeder pairs whatever `timeline.json` it finds with whatever `filmN.mp4` it finds (films
   3–5 still carry v2 timelines without `windows`).
4. **Continuity is good where it is mechanical** (EDL kinds == lines.json kinds for every window; sim
   keys match the layout; derived windows land within 0–2.9 s of the layout with the production voice,
   because the ElevenLabs read runs +0.68 s per clip over Edge; no window is near the post-roll rule)
   **and broken where humans disagree** (F1's first window moved to 4.0 s in lines/scripts/layout at
   16:29–16:32 — the direction's number — but the ElevenLabs bed is still head-aligned to drop at
   2.0 s; F4's window moved to [3,15] while the direction says [6,18]; the shipped beds run 114/100 BPM
   for F4/F5 where the direction says 108/96; F2 has two target lengths).
5. **Of the six SFX, three earn a place** (riser, chime-as-Generate/hit, a rationed click), one is a
   texture (type-burst), two are noise (both whooshes). The pack is normalized to −20 LUFS "integrated"
   on 0.4–1.5 s files, which makes the click and the burst peak at −2.7/−1.0 dBFS — hotter than the
   narrator; every SFX needs a trim of −10 to −20 dB before it can sit in the mix.

---

## MUST-FIX (ranked; all ESSENTIAL — each one ships a wrong film without an error)

### M1 — VO clips are trusted by filename alone; nothing checks that a clip says its line
**Where:** `assembly/assemble-film.mjs` §1 (`lines` filter, `voFile`/`voDur`, `voScenes`); `--vo-dir`
(added 16:18 today) selects the folder but not the identity.
**Problem:** a missing clip yields `voDur = 0` → the scene renders at slot length with no VO and no
error (F1's kinesin window would still sit at exactly [2,10]). Two VO sets now exist — the Edge review
voice in `narration/audio-edge/` (48 clips) and the ElevenLabs production voice in `narration/audio/`
(49 clips + `MANIFEST.json`, landed 16:19) — and the only record of which one a film carries is the
`voFile` paths inside `work/filmN/timeline.json` (the 16:21/16:23 renders of films 1 and 2 used
`audio-edge`). `--scratch` still resolves v3 scene ids to v2-era clips by NAME COINCIDENCE: film 1
scenes 1,2,4,5,6,7,8 get v2 TEXT (3,9,10 silent), film 4 gets 4 of 10, film 2 gets 9 of 12 with the
wrong words. The production manifest already carries `text`, per-word `t0/t1` timestamps and
`measure.lufs` per clip — exactly the sidecar the assembler needs — and the assembler does not read it.
Live example: `lines.json` was rewritten at 16:32 — eleven minutes after the production clips were cut
(manifest run 16:21) — and **17 of 48 clips no longer match their line** (f1-s2 says "Grab the motor…
spin it." where the line now reads "Drag the slider…"; f1-s10 still says "The doors below are live."
where the line is "That was you. Now pick what's next."; f3-s1 is a different sentence entirely). A
build right now mixes them without a word of complaint.
**Fix (exact):**
1. Refuse to build with any narrator/viewer line missing: `if (!existsSync(voFile)) throw`.
2. Read `<voDir>/MANIFEST.json` when present (and make `synthesize-edge.mjs` write the same shape —
   it already has `spoken` word boundaries from `edge-tts.mjs`); assert
   `sha1(manifest.clips[id].text) === sha1(line.text)`; a clip that does not match its line is a hard
   error. Record `voDir` + the manifest's run id in `timeline.json` and print it in the final JSON.
3. Assert `voScenes.length === lines.length` before mixing (also catches `amix=inputs=1`).

### M2 — The film 4 ask exchange is half-wired: the question is mixed, the answer has no path
**Where:** `assemble-film.mjs` §4 (`viewerLines` mixed at beat start + 0.4, added 16:27; `sfx: [{file,
at}]` per cut, unity gain); §3 `-an` on every part; `assembly/edl/film4.json` scene "5" (`slot [19,25]`,
`silence: true`); every `captures/out/*.webm` has no audio stream.
**Problem:** SCRIPT-4 beat 5 is "the typed question + the answer starting to stream" with "clean
audio". The 16:27 assembler now mixes the viewer clip (`f4-s5-viewer.mp3`, **−16.1 LUFS, peak −1.5
dBFS** — 8 dB hotter than the narrator, unnormalized) and drops the bed under the beat via `silence`
(the same per-frame 30 dB step as the windows). The product's spoken ANSWER — the second half of the
exchange, the thing the beat exists to prove — has no source: captures are rendered `-an` and carry no
audio anyway, and nothing in the EDL names an answer stem. Beat 5 today = question at +0.4 s, then
~3.5 s of near-silence over a muted capture, then "From this lesson."
**Fix (exact):**
- Record the answer as a file (the ask surface's own TTS reply, captured once) and place it through the
  existing `sfx` hook with a gain field: `"sfx": [{ "file": "captures/props/f4-ask-answer.wav",
  "at": 3.1, "gain": 0 }]`; add `volume=${s.gain ?? 0}dB` to the sfx chain (it is needed for the
  riser/click trims in S7 anyway).
- Normalize the viewer clip like every other clip (M3) — a viewer 8 dB louder than the narrator is a
  level jump on a phone speaker.
- Derive beat 5's duration from the stems like VO: `dur = max(slot, 0.4 + viewerDur + 0.6 + answerDur
  + 0.5)`; today `slot [19,25]` is a guess the answer's length will have to fit.
- Music: this is the one place a true cut is right — keep `silence`, but as −30 dB with 250 ms ramps
  (M4's envelope), bed back with beat 6.

### M3 — The audio chain is a dynamic processor, not a mix
**Where:** `assemble-film.mjs` §4: `amix … alimiter=limit=0.891,loudnorm=I=-19:TP=-1.5:LRA=11`
(unchanged in the 16:27 version).
**Problem, measured (A/B on `bed-teaser` + `f1-s2` @2 s + `f1-s3` @10 s, window [2,10]):**
| region | current chain (momentary max) | static chain | meaning |
|---|---|---|---|
| intro 0–1.5 s (bed alone) | −31.7 → −28.7 | −38.6 → −35.2 | loudnorm lifts the quiet intro **+7 dB**, then pulls it down when VO arrives |
| window floor 6.5–9.5 s (bed ducked, no VO) | −50 to −55 | −57 | the "dead" floor is lifted 5–7 dB and drifts upward |
| 13.5–19.5 s (bed alone after VO) | −23 to −24.7 | −26 to −27 | the −27 bed becomes a −24 bed the moment the narrator stops: VO/bed separation shrinks 8 → 5 dB and BREATHES |
Single-pass `loudnorm` (no `measured_*`) is documented dynamic mode with a 3 s window; it cannot hold a
static bed/VO relationship. Second defect: `alimiter` in ffmpeg 8.1.2 defaults to `level=1`
("auto level… normalizes audio back to 0 dB") — `limit=0.891` clamps at −1 dBFS and then multiplies by
1/0.891, so the limiter output peaks at 0 dBFS going into loudnorm. Third: no per-clip normalization
anywhere. Edge narrator clips measure **−21.0 / −20.8 / −20.6 LUFS**; the production ElevenLabs
narrator measures **−24.7 / −24.6 / −24.3 / −24.5 LUFS** (mono, 44.1 kHz, peaks −4 to −6.4) — 5.5 dB
under the −19 target and only 2.5 dB above the bed — while the ElevenLabs viewer clip is **−16.1 LUFS,
peak −1.5 dBFS** (8 dB hotter than the narrator). The VO level is whatever the vendor delivered, and
only the dynamic loudnorm was hiding it. Confirmed on the shipping artifact: `assembly/out/film1.mp4`
rendered 16:21 (ElevenLabs bed, Edge voice, this chain) measures I −19.2 / TP −2.4, window-1 floor
−50…−53 LUFS-M (the bed alone would be −57), and the bed at 13.5–14.5 s — narrator silent — sits at
−23.7…−24.8 instead of −27.
**Fix (exact):**
```js
// per-clip gain to −19 LUFS, measured once (ebur128), then a peak guard on the VO bus
const lufs = f => Number(/I:\s+(-?[\d.]+) LUFS/.exec(execSync(`ffmpeg -nostats -i "${f}" -af ebur128 -f null - 2>&1`))[1]);
voScenes.forEach((t, i) => fc.push(`[${i+1}:a]volume=${(-19 - lufs(t.voFile)).toFixed(2)}dB,` +
  `alimiter=limit=-3dB:level=0:attack=3:release=60,adelay=${Math.round((t.start + (t.cut.voOffset ?? 0)) * 1000)}:all=1[vo${i}]`));
// static sum; true-peak safety only; NO loudnorm in the render path
fc.push(`${mixIn}amix=inputs=${n}:normalize=0,aresample=192000,alimiter=limit=-2dB:level=0:attack=2:release=40,aresample=48000[mix]`);
```
Then MEASURE the result (`ffmpeg -i audio.m4a -af ebur128=peak=true -f null -`) and assert
I within ±1 LU of target and TP ≤ −2.0 dBTP; fail the build otherwise. If loudnorm must stay, run it
two-pass (`print_format=json` → `measured_I/measured_TP/measured_LRA/measured_thresh/offset`,
`linear=true`) and assert the JSON says `"normalization_type":"linear"` — linear mode silently falls
back to dynamic when `measured_TP + gain > TP`, which is exactly the case with a −27 bed under a −19 VO.

### M4 — The window duck is a per-frame step with no shape, no speech duck, no return, and it fires before the sim is visible
**Where:** `assemble-film.mjs` §4 (`duckExpr`, `volume=eval=frame`, the end `afade`).
**Problem:** `volume=eval=frame:volume='1-0.97*min(1,between(...))'` evaluates once per 1024-sample
frame → the bed drops 30.5 dB inside one frame boundary (a click on any non-zero waveform), comes back
the same way, has no −6 dB duck under speech (M3 in the direction asks for 80/400 ms), no riser, no hit,
and the bed is faded out over the last 1.2 s (`afade=t=out:st=total-1.2`) so the end card — where E3
puts "the hit" and the spoken brand — lands on a dying bed. Timing against the product: the section is
detected on `timeupdate` (~4 Hz, ~125 ms late on average, `useProjectPlayer.ts:3067`) and the frame
fades in over `SIM_FADE_MS = 200` (`lib/sim/protocol.ts:123`), so the sim is fully opaque ≈0.3–0.45 s
after `start_sec`. Cutting the bed AT `start_sec` kills the music 0.3–0.45 s before anything changes on
screen — it reads as a dropout on an ordinary video frame, the opposite of the intended event.
**Fix (exact envelope; numbers in Appendix A):**
```js
const c01 = x => `min(1,max(0,${x}))`;
const W = wins.map(([a,b]) => `${c01(`(t-${(a+0.10).toFixed(2)})/0.30`)}*${c01(`(${(b+0.20).toFixed(2)}-t)/0.15`)}`).join('+') || '0';
const S = voSpans.map(([s,e]) => `${c01(`(t-${s.toFixed(2)})/0.08`)}*${c01(`(${(e+0.40).toFixed(2)}-t)/0.40`)}`).join('+') || '0';
fc.push(`[0:a]atrim=0:${total},asetnsamples=256,equalizer=f=2800:t=q:w=1.1:g=-3,asplit=2[bd][bw]`);
fc.push(`[bd]volume=eval=frame:volume='(1-min(1,${W}))*(1-0.5*min(1,${S}))'[dry]`);          // full-range bed; −6 dB under speech
fc.push(`[bw]highpass=f=120,lowpass=f=1400,equalizer=f=800:t=q:w=1:g=4,volume=eval=frame:volume='0.28*min(1,${W})'[wet]`); // −11 dB "behind the glass"
fc.push(`[dry][wet]amix=inputs=2:normalize=0[bed]`);
wins.forEach(([a,b],k) => fc.push(`[${riserIdx}:a]volume=3dB,adelay=${Math.round((b-1.0)*1000)}:all=1[riser${k}]`));
```
Drop the end `afade`; the bed runs to `total` and ends on its button (see S6). `voSpans` are known
exactly (`t.start + voDelay`, `+ voDur`), so no `sidechaincompress` is needed — the duck is
deterministic and identical on every render. `silence: true` beats (F4's exchange, added 16:27) take
the same envelope at −30 dB instead of the shared 30 dB step.

### M5 — A bed shorter than the film produces a silent tail, silently
**Where:** `assemble-film.mjs` §4 (`BEDS`, `atrim=0:${total}`); `music/`.
**Problem:** `atrim=0:${total}` never checks that the bed reaches `total`. The five ElevenLabs beds
that landed at `music/` (16:18–16:20: 68.86 / 106.24 / 62.98 / 74.33 / 58.28 s) clear the
production-voice totals (59.25 / 86.71 / 53.10 / 59.18 / 45.45 s) by 9.6–19.5 s, so the shipping set
is safe. The keyless fallback set (`music/synth-v2/`, the documented regenerable path) is not:
`bed-powers.wav` is **56.33 s** against a 59.18 s film → the last 2.9 s (end card + "That's a Flow
Video.") have no music; `bed-heavy` (51.45 s) is 1.7 s short of film 3 (53.10 s). Nothing would say so.
**Fix (exact):** `const bedDur = probe(bed); if (bedDur < total + 0.5) throw new Error(\`bed
${BEDS[film]} ${bedDur}s < film ${total}s\`)`; make the bed set explicit (`--beds .|synth-v2`); keep
the ElevenLabs rule "bed ≥ target + 8 s with a button ending" and edit the excess out inside a window
(S6 formula) so both the frame-0 downbeat and the end hit land.

### M6 — Nothing ties the film the seeder uploads to the timeline it seeds windows from
**Where:** `seeding/build-template.mjs` lines 237–244 (`filmPath`), 303–319 (`cutWindowsFor`),
688–700 (`fitWindow`); `assembly/work/film*/timeline.json`.
**Problem (state on disk at 16:30):** films 1 and 2 were re-assembled at 16:19–16:23 from the Edge
review voice, so their `timeline.json` carry `windows` (F1 [2,10] [25,33] [45.43,52.43]; F2
[51.7,63.7]); films 3–5 still carry v2 timelines (10:55–12:49, totals 78/72/64 s, no `windows` key) →
`cutWindowsFor` returns `undefined ?? null` and the seeder silently uses the LAYOUT windows for them
while `filmPath()` uploads whatever `filmN(.SCRATCH).mp4` exists (a non-scratch file always wins, even
when the SCRATCH is newer). Nothing links the uploaded bytes to the timeline used. The same films
re-cut with the production voice move F2's window to [53.94,65.94] (+2.2 s) and F1's third to
[45.76,52.76]; a seed run between the two assemblies places every window on the wrong picture, and
every D1 assert passes (they compare the section to the layout, not to the film).
**Fix (exact):** stamp `timeline.json` with `{ output, sha256(output), total, voDir, sha1(lines.json),
sha1(edl) }` at the end of assembly; in `cutWindowsFor` return `null` unless `sha256(film.path) ===
tl.sha256`; after HLS, `assert(Math.abs(hls.duration_sec - tl.total) < 0.15)`; refuse to place a window
(hard fail, not `partial`) when the stamp is missing. Also prefer the NEWER of `filmN.mp4` /
`filmN.SCRATCH.mp4`, never the non-scratch by default.

### M7 — Window ends collide with the product's exit latency and with the riser
**Where:** `assemble-film.mjs` §2 (`dur = max(minDur, voDur + (padAfter ?? 0.5))`, window end = scene
end), §4 (`voDelay`, added 16:27, read for the VO placement but NOT for `dur`; riser auto-placed at
`w.end − 1.2` at unity gain); `useProjectPlayer.ts:1930,1944,1861–1871`, `protocol.ts:123`.
**Problem:** the seeded `end_sec` equals the next scene's start. The player exits when a `timeupdate`
tick sees `playhead >= end_sec` (avg +125 ms, up to +250), hands off to the coordinated exit, then
fades 200 ms — so a post-window line starting at the cut plays its first 0.3–0.45 s under the sim.
The EDLs now carry `voDelay: 0.4` on every post-window scene (F1 s3/s7/s10, F2 s10, F3 s8, F4 s4) and
the assembler places the VO at `start + voDelay` — the right idea — but `dur` still ignores it, so the
scene is not lengthened: the pad after a delayed line shrinks from 0.5 s to 0.1 s and any line that
already fills its slot now runs into the next cut. The riser is auto-placed at `end − 1.2` so it ENDS
at `end_sec` — 0.2–0.45 s before the picture is actually back — and it starts at `lastVoEnd + pad −
1.2`: a pad of 0.5 puts it over the narrator's last 0.7 s whenever a window's closing line fills its
slot (W10 demands ≥1.5 s of air after every imperative anyway). With the production voice the collision is already there: air after the last window line =
3.45 / 2.25 / **0.87 s** (F1 — the murmuration riser overlaps "…That was you." by 0.33 s), **0.98 s**
(F2 — riser over "…nothing in their way." by 0.22 s), 1.54 (F3), 1.26 (F4); with the Edge voice it
was 3.94/3.30/2.71, 1.39, 2.79, 1.99.
**Fix (exact):**
```js
const isLastWindowBeat = i => edl.cuts[i].kind === 'LIVE-WINDOW' && edl.cuts[i+1]?.kind !== 'LIVE-WINDOW';
const afterWindow     = i => edl.cuts[i-1]?.kind === 'LIVE-WINDOW' && edl.cuts[i].kind !== 'LIVE-WINDOW';
const pad     = cut.padAfter ?? (isLastWindowBeat(i) ? 1.5 : 0.5);
const voDelay = cut.voDelay ?? (afterWindow(i) ? 0.45 : 0);        // VO waits for the sim to be gone
const dur     = Math.max(minDur, voDelay + voDur + pad);           // today: voDur + pad, voDelay ignored
```
Riser `adelay = end − 1.0` (crest at end + 0.2, mid-fade) with `volume=3dB`; bed return ramp lands at
end + 0.2; next VO at end + 0.45. Keep the picture cut at the scene boundary (the fade then uncovers
the new shot, which is the "swell back" the script wants) — do NOT move `end_sec` earlier, or the fade
uncovers the plate.

### M8 — The window map moved at 16:29–16:32; the music and the direction did not move with it
**Where:** `narration/lines.json` (16:32: F1 s1 [0,4], s2 [4,12]; F4 s2 [3,9], s3 [9,15]),
`scripts/SCRIPT-1/4` WINDOW MAP (16:29: kinesin [4,12]; orbitLab [3,15]), `seeding/layout-v3.json`
(16:30: same) vs `music/bed-teaser.wav` (16:20: head-trimmed so the kick lands at **2.0 s**,
`music/MANIFEST.md` "Drop alignment") and `CREATIVE-DIRECTION-v3.md` §9 (F4 orbitLab **[6,18]**, F2
[52,64]).
**Problem:** F1 now opens its first window at 4.0 everywhere the cut is built — the direction's number
— but the bed was aligned to the previous map: measured, its first two seconds are a drumless riser
(−35.9 → −25.0 LUFS-M) into a drop at 2.0, which now lands in the middle of beat 1 ("This looks like a
video.") with two seconds of full groove before the window ducks it. M4's "bed starts on frame 0 at
full level" is false for this bed either way. F4's window moved to [3,15] (derived [3.38,15.38] — the
3 s first slot is already overrun by the 2.88 s production clip + pad) while the direction still says
[6,18]; nobody re-briefed the powers bed's "hook from the first beat" for a window that now opens 3 s in.
**Fix:** re-run the teaser's drop alignment with the kick at **4.0** (raw take in `music/takes/`,
`generate-elevenlabs.mjs`), or re-trim the head so 0–4 s is groove and the drop is the duck; amend the
direction's §9 skeleton to the new map (F1 [4,12] [25,33] [45,52], F2 [51,63], F4 [3,15]) so §12's
checklist and the cut measure the same film; and make the assembler print the bed's detected drop
against the first window's start (0.25 s tolerance) so the next re-map cannot silently leave the music
behind.

### M9 — `renderPart` can shorten, repeat, or empty a shot without failing
**Where:** `assemble-film.mjs` §3 (`renderPart`, the `got < each − 0.25` retry).
**Problem (in order of damage):**
- (b) a source that is short by >0.25 s is re-rendered with `-stream_loop -1` regardless of mode — a UI
  capture that ends early REPEATS its click sequence (the new frame-clone; R4 says "cut to the next
  shot"). With `-ss in` before `-i`, the loop restarts at 0, not at `in`, so the repeat is also a jump.
- (e) a source short by ≤0.25 s is kept as is → the concat runs short → every later scene's picture
  arrives EARLY relative to VO, overlay cues and the seeded windows, cumulatively.
- (d) `in` past the source length → an empty part → `probe()` returns NaN → `NaN < each − 0.25` is false
  → no retry, no error; the concat either fails later or drops the part.
- (a) `-t` rounds to the nearest frame (measured on the v2 parts: +15/−15/+13/−9/−5 ms) — a random walk
  that stayed within one frame over ten parts, but it is why `film1.mp4` is 79.900 s of video over
  79.868 s of audio. Not a shipper by itself; it becomes one when (e) adds to it.
With the 16:28 EDLs and the production voice the policy already fires twice in film 2: s4
`f2-s3-mark-section` (`in 9.6` on a 15.92 s capture — 6.32 s available for an 8.00 s beat) and s12
`f2-s9-zoomout` (`in 5` on the new 8.56 s capture — 3.56 s for 6.00 s). Both would be re-rendered
LOOPED from frame 0: the section drag repeats, the zoom-out plays twice.
**Fix (exact):** quantize once, render by frame count, assert:
```js
const FPS = 30, q = s => Math.round(s * FPS) / FPS;         // apply to dur/start in the timeline loop
// renderPart: replace ['-t', String(dur)] with ['-frames:v', String(Math.round(dur * FPS))]
const got = probeFrames(part), want = Math.round(each * FPS);
if (got !== want) {
  if ((sub.mode ?? t.cut.mode) === 'loop') renderPart(src, each, sub.in ?? 0, true, part);
  else throw new Error(`scene ${t.scene}.${i}: ${got}/${want} frames from in=${sub.in ?? 0} — cut to the next shot or mark mode:'loop'`);
}
```

### M10 — Design conflict before W6 is built: an early exit uncovers a BLACK plate
**Where:** `assembly/plates/under-window.mp4` (20 s, near-black `0x0b0f17`, verified frames at 0.1 s
and 6.1 s); `CREATIVE-DIRECTION-v3.md` W6 ("Keep watching →" early exit); W12.
**Problem:** the film under every window is a black card. That is right while the sim covers it, and it
makes mid-window plate restarts invisible (F2/F3/F4 render two plate parts per window). But any exit
before the beat ends — W6's early exit, a `script-error`, a slow mount past `SIM_PAINT_DEADLINE_MS`
with no poster — shows black with a narrator saying "Go on — touch it" and a ducked bed for the rest of
the beat (8–12 s). This is the failure the direction calls the one it cannot survive.
**Fix:** either (i) no early exit for scripted film windows (the countdown bar is the exit), or (ii) make
the plate the dimmed public page (UI, not sim footage — the grammar allows it) so the fallback reads as
"the film" rather than "the stream died". Decide before the invitation layer is built.

---

## SHOULD

- **S1 [ESSENTIAL] Web loudness target.** −19 LUFS is a broadcast-shaped compromise: the product's own
  podcast edition masters to `loudnorm=I=-16:TP=-1.5` (`backend-api/src/services/podcast/audio/
  ffmpegAudio.ts:211`), so the film plays 3 dB under the audio edition of the same project and ~5 dB
  under YouTube-normalized neighbours (YouTube turns loud content DOWN, never quiet content up).
  Recommend **I −16 LUFS, TP −2.0 dBTP** for the film master. Keep the internal ratios (VO 0 dB ref, bed
  −8 → −14 under speech, windows −11) and shift the whole mix. If −19 is kept, keep it knowingly.
- **S2 [ESSENTIAL] HLS re-encode headroom.** The product re-encodes audio to AAC-LC at **96 k (360p) /
  128 k (480p, 720p) / 192 k (1080p), 44.1 kHz** (`HLSTranscoder.ts:32–35, 262–264`) with no loudness
  processing. AAC overshoot on a second generation is up to ~1 dB, so a −1.5 dBTP master can leave the
  encoder at −0.5; deliver at −2.0 dBTP. At 96 k, sharp transients over dense noise smear (pre-echo):
  land the hit 30–50 ms AFTER the riser's end, never on top of its crest.
- **S3 [ESSENTIAL] Phones.** Measured on the beds (synth + the ElevenLabs share bed): the 300–1500 Hz
  band — what a phone speaker reproduces — carries **−39 to −40 LUFS** of a −27 bed, i.e. the bed is
  already ~18 dB under the VO on a phone before any duck. Consequences: (a) −27 is NOT too hot for
  intelligibility on phones — the −6 dB speech duck is for headphones/laptops; (b) "room tone at −45
  LUFS" is digital silence on a phone; (c) the "behind the glass" path in M4 keeps a +4 dB bump at
  800 Hz for exactly this reason; (d) on phones, liveness inside a window is carried by the narrator's
  cadence and the invitation layer's motion (W4/W5), not by the bed — keep window air ≤ 3 s between
  lines (F1 kinesin currently has 3.94 s after "…spin it.").
- **S4 [ESSENTIAL] Cut on the grid, with one BPM per film in code.** Off-grid cuts with the
  production voice: F1 3/9 (237 ms), F2 7/11 (74–290 ms), F3 5/7 (65–269), F4 8/10 (67–253), F5 5/6
  (77–298) — R5 allows ±60 ms. `dur = Math.ceil((dur - 1e-6) / beat) * beat` with
  `beat = 60 / BPM[film]`, and window ends snapped to the bar so the return lands on a downbeat. The
  BPM must come from the bed that shipped — ElevenLabs as prompted: **120 / 100 / 108 / 114 / 100** —
  not from the direction (120/100/108/**108**/**96**) or the scripts (~112 for F1, ~96 for F2). Put
  that table in `assemble-film.mjs` and the direction, and verify each bed's tempo actually holds
  (generative music drifts; snap to MEASURED beats if it does — the MANIFEST records LRA and silence
  gates for every take but no beat grid).
- **S5 [ESSENTIAL] VO prep.** Edge clips have PLR 16–18 dB (I −21, peaks −3 to −5.4); at −19 LUFS the
  peaks sit at −1…−3 dBFS and the final limiter works on every plosive. Add
  `acompressor=threshold=-24dB:ratio=2.5:attack=5:release=80:makeup=0` before the per-clip gain (then
  re-measure), target VO bus TP −4. Trim the 123 ms of leading silence (measured on f1-s2) to a fixed
  60 ms so "type lands on the spoken beat" is true to ±20 ms rather than ±120.
- **S6 [ESSENTIAL] Bed ending.** No `afade` at `total − 1.2`. Brief every ElevenLabs bed to end on a
  button and be `total + 8 s` long; remove the excess INSIDE the first window where the bed is at −11 dB
  and low-passed: `excessBars = round((bedDur − total) / bar)`; segment A = `bed[0, a1]`, segment B =
  `bed[a1 + excessBars·bar, bedDur]` delayed to `a1`; residue `< bar/2` is absorbed by S4's bar snap of
  the window end. Frame 0 keeps its downbeat, the end card gets the button, and nobody hears the splice.
- **S7 [ESSENTIAL] SFX trims and cue sheet** (Appendix B). The 16:27 assembler auto-places the riser
  at every return and accepts per-cut `sfx: [{ file, at }]` — at unity gain, with no `gain` field, so
  every sound lands at its authored level. The pack is all 48 k/24-bit/stereo, riser exactly 1.200 s
  — good. But "−20 LUFS integrated" on files ≤ 1.5 s is not a level spec (BS.1770 gating
  needs ≥ 400 ms blocks): the click peaks −2.7 dBFS, type-burst **−1.0**, whooshes −5.2/−5.7, the
  re-rolled two-note chime (16:21) −7.6, riser −15.8. At unity a UI click would be the loudest
  transient in the film. Trims: click −18 dB (peak ≈ −21), type-burst −20 (peak ≈ −21, RMS ≈ −47),
  chime −6 (peak ≈ −13.6), riser +3 (crest ≈ −12.7), whooshes: not used. The riser was generated
  "ending on a soft gentle hit", so the return already has its hit if the riser ENDS at end + 0.2 —
  no separate stem needed there. The end-card and number hits still want the missing `hit-300ms`
  (M4/M5 asked for it; the pack skipped it) — until then use the chime trimmed
  `atrim=0:0.3,afade=t=out:st=0.24:d=0.06`.
- **S8 [ESSENTIAL] Overlay retimer guards.** `assemble-film.mjs` §5 (cue retiming): (a) refuse any cue that
  intersects a window (`c.t0 < w.end && c.t0 + c.dur > w.start − 0.3` → throw) — today only end cards
  and the F4 grid exist so nothing intersects, but H3's hook super in F1 s1 (≥1.2 s hold + 250 ms fade
  from ~0.8 s) would run into a 2.0 s open; (b) add `anchorVoEnd` so the lockup lands on the spoken
  brand (E3): F1 `f1-logo-outro` is anchored at s10 + 2.4 s while "Flow Video" begins ≈ s10 + 4.0 s
  (voDur 4.97, brand ≈ last 0.9 s) — use `anchorVoEnd: -0.9`.
- **S9 [TRIVIAL] Merged windows render as one plate part.** F2 s8+s9, F3 s6+s7, F4 s2+s3 each render two
  plate parts from `in 0`; invisible while the plate is black, a visible restart the day the plate
  becomes content (M10 ii). Render one part per derived window.
- **S10 [TRIVIAL→ESSENTIAL if the plate changes] Captures are 25 fps, converted with `fps=30`** → five
  duplicated frames per second, visible as cursor judder on every eased move (C2). Record at 30 or 60,
  or master the film at 25. And `f5-s5-phone.webm` is **390×844** → scaled to 499×1080 and pillarboxed
  with `0x0b0f17` bars (F4 s8/s9, F5 s6) — the Z5 letterbox ban, plus a 2.8× upscale. Composite the
  phone into a designed frame or crop-to-cover.
- **S11 [TRIVIAL] W7 guard in the seeder.** The 20 % duck (`useProjectPlayer.ts:1426`) fires on any
  `guidanceCue`, including a TEXT-ONLY cue (3.5 s at 0.2 volume, `:1434`). It is off for the seeded
  windows by omission — guidance is a paid "Approve & generate voice" step (`GuidanceService.ts:604`)
  and the generated `guidance.js` is inert while `autoScript` is on (`_active(){ return _gate &&
  !_autoScript; }`). Add a D1 assert that the served package has no `guidance.js`, so W7 is enforced,
  not assumed.
- **S12 [TRIVIAL] Document drift.** F2 target: 83 s (`films.json`, SCRIPT-2 as edited 16:22) vs 90 s
  (direction §9); the stale 96 survives only as `overlay/scenes/film2.json` `total` (overwritten at
  assembly) — and the film derives to 86.7 s with the production voice. F3 end-card line: "Drop yours
  in." (`overlay/scenes/film3.json`) vs "Drop in anything." (script, E4). Fallback census (visual, for
  the director):
  with the current manifest, F1 s3/s7 and F2 s1/s11/s12 all resolve to `f4-s1-public-page` (at `in`
  2/5/0/0/5), F1's five montage shots all resolve to F2 captures, F5 s4/s5 to `f2-s8-share`.

---

## NICE

- `asetnsamples=256` before `volume=eval=frame` (already in the M4 snippet) — 5 ms gain steps instead
  of 21 ms; inaudible zipper on an 80 ms attack.
- Automatic QC in `assemble-film.mjs` after the mux: `ebur128` (I, TP, LRA), `silencedetect=n=-50dB:
  d=1.5` (no silence ≥ 1.5 s outside windows; no silent tail), and a printed per-window table
  (open, last VO end, riser start, return) — the numbers this review had to derive by hand.
- Word timings in the sidecar (M1) unlock `"at": "voWord:Generate"` for SFX and `anchorVoWord` for
  overlay cues — exact rather than "voEnd − 0.7".
- Mono fold check as part of the bed acceptance: all three measured beds fold to mono at −3.1…−3.5 dB
  (fully correlated, no phase loss) — write that assertion down so a wide ElevenLabs bed is caught.
- `renderPart` could take `-ss` AFTER `-i` (output seek) when `in` is used with a loop, so the loop
  restarts at `in`; moot once M9 forbids looping non-loop sources.
- The overlay `colorkey` on a green-ground webm will fringe anti-aliased type; render the overlay with
  alpha (VP9 `yuva420p`) and use `overlay` directly. Visual lane; noting it.

---

## What already works

- **Kinds and keys agree.** For every LIVE-WINDOW beat the EDL `kind` equals `lines.json` `kind`
  (F1 s2/s6/s9, F2 s8/s9, F3 s6/s7, F4 s2/s3); every EDL scene has a line or an explicit slot; sim keys
  (`kinesin`, `solarSystem`, `murmuration`, `orbitLab`) match `layout-v3.json` exactly, so
  `cutWindowsFor` will pair them once M6 is in.
- **Derived windows track the layout** with the production voice and the 16:32 map: F1 [4,12]
  [26.91,34.91] [47.63,54.63] (8/8/7 s, W1 satisfied), F2 [53.94,65.94], F3 [34.1,46.1], F4
  [3.38,15.38]; F5 45.45 s, no windows. Totals 61.12 / 86.71 / 53.10 / 59.19 / 45.45 s (F1 is now 3.1 s
  over its 58 s target).
- **The 16:27 assembler already carries half of this report's fixes in embryo:** `--vo-dir`, the
  viewer line mixed at beat + 0.4, `silence: true` for the exchange, `voDelay` on post-window scenes,
  the riser auto-placed at every return, a per-cut `sfx` hook, `fallbackIn`, `zoom` punch-ins and an
  explicit `aformat=channel_layouts=stereo` on every voice input. What remains is the arithmetic around
  them (M3, M4, M7, S7).
- **No window is near the post-roll rule.** Margins to the film end: 6.5 / 20.8 / 7.0 / 43.8 s; the
  seeder refuses a start ≥ `duration − 1.5` (stricter than the product's `duration − 0.05`,
  `sectionInterval.ts:29`) and clamps ends to `duration − 0.5`; none of the current windows can trip it.
- **The product keeps the film playing under a mid-roll window** (`useProjectPlayer.ts:2119`), matches
  sections on `[start_sec, end_sec)` (`:1930`), exits through `deactivateSim({exitToVideo:true})`
  (`:1944`) with a 200 ms fade — a baked duck is therefore compatible with seeking into a window, and the
  D2 verification records first-visible latency and `script-error` per window.
- **`amix=normalize=0`** — no gain pumping as clips end (`input_scale` stays 1). libavfilter
  auto-inserts `aresample` for the 24 kHz mono Edge clips, a 44.1 kHz ElevenLabs clip, or 48 kHz stereo
  SFX (mono → stereo at −3 dB per channel, loudness preserved); the stereo/mono and sample-rate
  "mismatches" are not defects, and `-ar 48000` on the output already handles loudnorm's 192 kHz.
- **Beds are on spec:** the five ElevenLabs beds at `music/` (and the synth-v2 fallback set) at
  −27.0/−26.9 LUFS, true peaks −16.8 to −10.7 dBTP, LRA 0.6–2.6 LU, 48 kHz/24-bit/stereo, 9.6–19.5 s
  longer than their films, no silence > 1 s inside any film (the MANIFEST's own gates), mono-compatible
  (fold −3.1…−3.6 dB); the teaser's drop is aligned to the 2.0 s open that scripts/lines/layout/EDL
  agree on.
- **The SFX pack is format-clean** (48 k/24-bit/stereo, riser exactly 1.200 s) — only levels need work.
- **Frame rounding is nearest-frame** and measured within one frame over ten parts; the plate is black,
  so today's per-scene plate restarts are invisible; the only overlay cues are end cards and the F4
  grid, so nothing intersects a window in the current cue sheets.
- **`--vo-dir` exists** (added 16:18) and the production VO set ships with a manifest that carries
  `text`, per-word timestamps and per-clip loudness — the identity check and the word-anchored SFX in
  M1/S7 are a read, not a new pipeline.
- **Riser clearance was fine with the Edge voice** (1.39–3.94 s of air after the last window line);
  the production voice already breaks it in two windows — M7 makes it a rule instead of luck.

---

## Appendix A — the mix plan in numbers

**Reference levels (per film, before the master trim):** VO −19 LUFS per clip, VO bus TP −4; bed −27
LUFS integrated, `−3 dB @ 2.8 kHz` (q 1.1) carve; bed −6 dB under speech (attack 80 ms, release
400 ms, keyed from the known VO spans); bed inside windows −11 dB + `highpass 120 / lowpass 1400 /
+4 dB @ 800 Hz` (reads as "the film went behind the glass" on headphones, stays faintly audible on a
phone); F4 ask exchange only: −30 dB, 250 ms ramps. Master: I −16 (or −19 if ruled), TP −2.0 dBTP,
static gain + true-peak limiter, measured and asserted — no dynamic normalizer in the render path.

**Window open (t = start_sec of the seeded section):** bed duck begins at **+0.10 s**, reaches full
depth at **+0.40 s** (linear ramp in amplitude, so ~−8 dB happens in the last 120 ms — it still reads as
a cut). Matches the product: detection ≤ 250 ms late, 200 ms fade → sim fully opaque at ≈ +0.33 s.
Window VO starts at +0.0 (voice leads the picture — natural). No SFX at the open; the drop is the event.
If a hit is wanted (M5), `hit-300ms` at +0.35 s, peak −13 dBFS, never a whoosh.

**Window return (t = end_sec):** riser `adelay = end − 1.0` (crest at **end + 0.20**, i.e. mid-fade of
the product's exit, which starts ≈ 125 ms after end_sec); bed ramps −11 → 0 dB across [end + 0.05,
end + 0.20]; hit (if authored) at end + 0.25 (30–50 ms after the riser crest — S2); next beat's VO at
**end + 0.45** (`voOffset`). The last window line must end ≥ 1.5 s before `end` (`padAfter` 1.5).

**Why not a true cut:** the sim is silent, the film picture is hidden, ≤ 35 % of the window is narrated,
and the exit/entry are 0.3–0.45 s late — a full cut produces 2–4 s stretches of digital silence that
begin before the sim appears and end after it is gone; on a phone "room tone at −45" is silence. The
product's claim is that the film is still running; the soundtrack should agree with it. The one place a
true cut is right is film 4 beat 5 (a recording moment, filled by two voices).

**If the direction insists on the cut:** replace room tone with a designed window stem (a slow pad in
the bed's key, −34 LUFS, 300 Hz–2 kHz) and re-enter the bed on a bar boundary at the return (S4/S6),
because a continuous bed resumed at an arbitrary phase can never "come back on beat 1 with the hit".

## Appendix B — SFX cue sheet (anchors are relative to the DERIVED timeline; `voEnd` = scene VO end)

| film · beat | sound | anchor | trim | note |
|---|---|---|---|---|
| F1 s2/s6/s9 windows | riser | windowEnd − 1.0 | +3 dB | crest at end + 0.2; no other SFX in windows |
| F1 s8 montage (5 × 1.8 s) | click · type-burst · chime · click | shot2 + 0.9 · shot3 + 0.0 (1.5 s) · shot4 + 0.9 · shot5 + 0.6 | −18 · −24 · −10 · −18 | four sounds in 9 s, never one per cut |
| F1 s10 end card | chime (as hit) | scene start + 0.0 | −8 | the line "lands on the hit" (E3); lockup at voEnd − 0.9 |
| F2 s2 | click | voStart + 0.3 ("New project") | −18 | |
| F2 s5 | click ×2 | "Pick" onset · "Choose" onset | −18 | |
| F2 s6 | type-burst (loop ×4, 80 ms fade) | caret start → caret stop (71 chars / 12 c·s⁻¹ = 5.9 s) | −20 | follows the CARET, not the VO (VO is 4.3 s) |
| F2 s7 | click · click · chime | "Simple" onset · "Auto" onset · "Generate" onset (≈ voEnd − 0.7) | −18 · −18 · −10 | the flip-flip-hit |
| F2 s8/s9 window | riser | windowEnd − 1.0 | +3 | |
| F2 s10 | click | "Create" onset | −18 | |
| F2 s12 end card | chime (as hit) | anchor t0 | −8 | no second chime on the spoken "Hit Generate" |
| F3 s2 | click | "Drop it" onset | −18 | |
| F3 s3 | type-burst | "Then tell it" onset, 4.3 s (52 chars) | −20 | |
| F3 s4 | click · click · chime | "Simple" · "Auto" · "Generate" | −18 · −18 · −10 | |
| F3 s5 | type-burst | "Type them" onset, 2.5 s | −22 | |
| F3 s6/s7 window | riser | windowEnd − 1.0 | +3 | |
| F3 s8 end card | chime | anchor t0 (+0.6) | −8 | |
| F4 s2 / s4 / s7 / s8 | hit-300ms (stand-in: chime 0–0.3 s) | "One:" · "Two:" · "Three:" · "Four:" onsets | −10 | the script's number hits; "One:" is inside the window at the ducked bed |
| F4 s5 exchange | none | — | — | bed −30 dB, 250 ms ramps, two voices carry it |
| F4 s9 | click | voStart + 0.3 (gear) | −18 | |
| F4 s10 grid | click ×4 (optional) | each label stamp (stagger 0.55) | −22 | the one place a sound-per-motion is right |
| F4 s11 end card | hit | anchor t0 | −8 | |
| F5 s2 | click ×4 | "Create" · "video" · "podcast" · "library" onsets | −18 / −20 ×3 | "every beat a door" |
| F5 s3 / s4 | click | "publish" onset · "Invite" onset | −18 | |
| F5 s5 | click ×3 | Access modes as named | −22 | |
| F5 s7 end card | chime | anchor t0 (+0.4) | −8 | |
| any | whoosh-in / whoosh-out | — | — | **cut**: the product's crossfade is silent; whooshes make a live surface read as an edit effect |

Chime/hit trims in this table assume the 16:08 chime (peak −2.8 dBFS); for the re-rolled 16:21
two-note chime (peak −7.6) add +4 dB to every chime/hit trim (−10 → −6, −8 → −4).

Rules: a click only where the cursor visibly presses a control AND the narration names the verb; never
inside a window (the viewer's own touch is silent — a click there would be a lie about the product);
≤ 6 clicks per film (F5 ≤ 8); every SFX resolved from the derived timeline (`"at": "voWord:…" |
"voEnd±x" | number`), never from script slots.

## Appendix C — continuity table (production ElevenLabs voice; Edge review voice in parentheses)

| film | script/lines/layout window | derived window — production (Edge) | direction §9 | total (script target) | bed on disk vs total |
|---|---|---|---|---|---|
| 1 | [4,12] [25,33] [45,52] (16:29–16:32; was [2,10]…) | [4,12] [26.91,34.91] [47.63,54.63] (Edge cut of 16:21: [2,10] [25,33] [45.43,52.43]) | [4,12] [24,32] [44,51] | 61.12 (58) | EL 68.86 ✓ but drop aligned to 2.0 · synth 62.43 ✓ |
| 2 | [51,63] | [53.94,65.94] ([51.7,63.7]) | [52,64] | 86.71 (83 / 90) | EL 106.24 ✓ · synth 101.2 ✓ |
| 3 | [32,44] | [34.1,46.1] ([32.67,44.67]) | [32,44] | 53.10 (51) | EL 62.98 ✓ · synth 51.45 **short 1.7** |
| 4 | [3,15] (16:29–16:32; was [6,18]) | [3.38,15.38] ([6,18.81]) | **[6,18]** | 59.19 (57) | EL 74.33 ✓ · synth 56.33 **short 2.9** |
| 5 | none | none | none | 45.45 (45) | EL 58.28 ✓ · synth 46.75 ✓ |

ElevenLabs clips run **+0.68 s longer than Edge on average** (max +2.56 s, f3-s2; f4-s2 is the one
that got shorter, −0.99 s), so every derived number above moves again if the voice is re-recorded —
which is why M6's stamp exists.

Drift points, in the order they bite: VO dir empty/mismatched (M1) → viewer line dropped (M2) →
`padAfter 0.5` too short for the riser and the exit latency (M7) → nearest-frame rounding ±17 ms per
part (M9a) → short-source tolerance 0.25 s (M9e) → stale `timeline.json` vs preferred stale film (M6)
→ `fitWindow` clamp (harmless today) → overlay cues anchored to scene ends (safe today, unguarded).

## Appendix D — evidence

- A/B render: `bed-teaser` + `f1-s2` @ 2 s + `f1-s3` @ 10 s, duck [2,10], (A) the assembler's chain
  verbatim vs (B) `volume=+2dB` per clip, `amix normalize=0`, `alimiter=limit=0.891:level=0`; momentary
  loudness per 0.5 s via `ebur128=metadata=1`; results in M3.
- `ffmpeg -h filter=alimiter` (8.1.2): `level … (default true)`; `loudnorm … linear (default true)`;
  `amix normalize (default true)`; `volume eval (default once)`.
- Clip loudness: Edge f1-s2 −21.0 / f1-s8 −20.8 / f2-s9 −20.6 LUFS, viewer −17.7, scratch −17.1;
  leading silence 123 ms (silencedetect −45 dB).
- Parts: v2 `work/film1/scene-*.mp4` frame counts vs `timeline.json` durations: 0/+15/−15/0/+13/0/0/
  −9/−5/0 ms; final `film1.mp4` video 79.900 s (2397 f) vs audio 79.868 s.
- Player: `useProjectPlayer.ts:56` (`SIM_PAINT_DEADLINE_MS = 1200`), `:1930`, `:1944`, `:1861–1871`,
  `:3067` ("~4 Hz … late by ~125 ms"), `:1426/:1434` (guidance duck 0.2 / 3.5 s), `lib/sim/
  protocol.ts:123` (`SIM_FADE_MS = 200`), `lib/sectionInterval.ts:29` (epsilon 0.05).
- Transcode: `HLSTranscoder.ts:32–35, 262–264`; podcast target `ffmpegAudio.ts:211`.
- Assets: beds/SFX/plate/captures probed with ffprobe; beds mono-fold −3.1…−3.5 dB; 300–1500 Hz band
  −39.3…−40.0 LUFS; captures 25 fps, no audio streams; phone capture 390×844; plate frames at 0.1 s
  and 6.1 s are uniform `0x0b0f17`.
- Derivation: `scratchpad/derive.mjs` replicating `assemble-film.mjs` §2 against `narration/audio-edge`
  and then `narration/audio`, with `captures/out/MANIFEST.json` — all 46 sub-cuts resolve; 14 resolve
  through FALLBACK.
- Tree moved during the review (checked 16:30): `--vo-dir` added to the assembler (16:18); ElevenLabs
  beds at `music/` (16:18–16:20: 68.86/106.24/62.98/74.33/58.28 s, all −27.0 LUFS except share −26.9,
  TP −16.8…−10.7, mono-fold −3.1…−3.6 dB, 300–1500 Hz band −36.7…−43.7 LUFS); `music/MANIFEST.md`
  rewritten (16:24); ElevenLabs VO in `narration/audio/` (16:19; narrator −24.3…−24.7 LUFS, viewer
  −16.1, mono 44.1 kHz, +0.68 s mean vs Edge); chime re-rolled (16:21, peak −7.6); `layout-v3.json`
  labels/prompts (16:17); films 1–2 re-rendered from `audio-edge` (16:21/16:23).
- Shipping-artifact check, `assembly/out/film1.mp4` (16:21): I −19.2 LUFS, LRA 5.1, TP −2.4; window-1
  floor −50…−53 LUFS-M; bed at 13.5–14.5 s (no VO) −23.7…−24.8; teaser bed head 0–2 s −35.9 → −25.0.
- Second move (checked 16:35): `assemble-film.mjs` 16:27 (`viewerLines`, `voDelay`, `silence`, `sfx`,
  auto-riser, `fallbackIn`, `zoom`, `aformat` stereo — `dur` still `voDur + pad`); all five EDLs
  16:28–16:29; `lines.json` + `films.json` 16:32 (17/48 texts changed vs the 16:21 clips; F1 s1/s2 →
  [0,4]/[4,12]; F4 s2/s3 → [3,9]/[9,15]); SCRIPT-1/4 WINDOW MAP 16:29; `layout-v3.json` windows 16:30;
  `captures/out/MANIFEST.json` 16:33 (new `f2-s9-zoomout`, 8.56 s). Derivation re-run against
  `narration/audio` with the 16:28 EDLs for Appendix C and M9.
