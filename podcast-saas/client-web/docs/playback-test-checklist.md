# Playback Test Checklist

Manual tests to run after any change to video playback hooks or components.

## Setup

- Backend running on port 8080
- Client dev server running: `pnpm dev`
- A project with ≥2 video clips loaded
- A project that includes at least one simulation section and one broll section

## Editor Tests (`/projects/<id>/editor`)

Run each test in the editor preview panel.

### 1. Play clip 1 into clip 2
- [ ] Press Play
- [ ] Clip 1 plays to completion
- [ ] Transition to clip 2 is seamless (no flash, no black frame)
- [ ] Progress bar advances continuously across the clip boundary
- [ ] `currentClipIdx` updates from 0 → 1

### 2. Scrub from clip 2 back to clip 1
- [ ] While playing in clip 2, drag the seek bar back into clip 1's time range
- [ ] Video snaps to the correct point in clip 1 (not still showing clip 2)
- [ ] Timeline panel highlights clip 1

### 3. Scrub rapidly across a clip boundary
- [ ] Drag the seek bar quickly back and forth across the clip 1/2 boundary multiple times
- [ ] No video freeze, no stuck progress bar, no wrong-clip playback
- [ ] After stopping scrub, video plays from the correct position

### 4. Scrub into a simulation section
- [ ] Seek the progress bar to land inside a simulation section
- [ ] Simulation iframe loads and is visible in the editor preview
- [ ] Global time updates correctly

### 5. Scrub out of a simulation section
- [ ] From inside a simulation section, drag the seek bar back to a video clip
- [ ] Simulation iframe hides; video clip plays from the seeked position

### 6. Play through a broll section
- [ ] Press Play through a section that has broll overlays
- [ ] Broll displays at the correct global time offset
- [ ] Main clip audio continues correctly under the broll

### 7. Editor vs viewer comparison
- [ ] Open the same project in `/projects/<id>/view` in another tab
- [ ] Play the same clip sequence in both
- [ ] Transition timing matches (same clip starts at same global time)
- [ ] Seek to the same global time in both — both show the same frame

## Viewer Tests (`/projects/<id>/view`)

Run the same scrub/play tests above in the full-screen viewer.

### 8. Play through entire sequence
- [ ] Plays from clip 1 through to the last clip without manual interaction
- [ ] No freeze, no 404 on HLS segments

### 9. Keyboard seek (left/right arrows)
- [ ] Arrow keys move by ±10s
- [ ] Seeking across clip boundaries works correctly

## Known Shared vs Duplicated Logic

### Shared via `useSegmentedPlaybackCore.ts`
Used by `useEditorPlayback.ts` only.

| Export | Purpose |
|--------|---------|
| `HLS_OPTS` | ABR/buffer config — same quality for both |
| `HLS_OPTS_STANDBY` | Standby element config |
| `computeSegmentOffset(actualDurs, fallbackDurs, idx)` | Sum durations[0..idx-1] for global offset |
| `globalToLocal(globalSec, actualDurs, fallbackDurs, count)` | Map global time → (segIdx, localTime) |
| `attachHlsSource(el, hlsUrl, rawUrl, hls, HlsLib)` | HLS attach with error handler dedup |
| `safePlay(v)` | Swallow play() promise rejections |
| `fmtTime(s)` | Format seconds as m:ss |

### NOT yet shared — `useProjectPlayer.ts` duplicates these inline

| Duplicated concept | Viewer implementation | Editor/shared implementation |
|---|---|---|
| HLS config | `const HLS_OPTS = {...}` at top of file | `HLS_OPTS` from shared core |
| Segment offset | `makeTimeline()` pre-computes `offset` for each segment | `computeSegmentOffset()` from shared core |
| Global→local time | Scan `tl[i].offset <= targetGlobal` | `globalToLocal()` from shared core |
| HLS attach | `attachHlsSource(el, segIdx, hls)` inline | `attachHlsSource(el, hlsUrl, rawUrl, hls, HlsLib)` from shared core |

**Why `useProjectPlayer.ts` is not yet on the shared core:**
- It's an 888-line hook with broll, sim overlays, keyboard nav, and mobile touch — refactoring it touches live production code
- Its timeline model (`timelineRef` objects with `{id, duration, offset}`) differs from the editor's `actualDursRef` flat array
- The math is equivalent (verified: `makeTimeline` sum = `computeSegmentOffset`; offset scan = `globalToLocal`) but the data structures differ
- Safe migration requires dedicated testing, not a side-effect of another change
