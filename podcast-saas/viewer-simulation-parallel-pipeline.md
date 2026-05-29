# Interactive Viewer — How Simulations Run in Parallel with Video

## Overview

The viewer at `/projects/:id/view` plays a sequence of video clips and — at specific time ranges defined in the editor — pauses the video, fades in an interactive simulation inside an iframe, runs the AI-generated bridge script, and then fades back to video when the section ends. All of this is driven by a single `timeupdate` listener watching the video's current time.

---

## The Data Model: What the Player Receives

The viewer fetches `GET /api/v1/projects/:id/player-config` (no auth required — the viewer is public/shareable). The response is:

```typescript
interface PlayerConfig {
  project_id: string;
  title: string | null;
  segments: PlayerSegment[];   // one per video file, in upload order
}

interface PlayerSegment {
  id: string;
  label: string;               // filename
  duration_sec: number;        // from DB (updated after HLS transcoding)
  hls_url: string | null;      // master.m3u8 or 360p.m3u8 if master not ready
  fallback_url: string | null; // same as hls_url (for native HLS)
  hls_status: string;          // 'pending' | 'processing' | 'ready' | 'failed'
  simulations: SimulationOverlay[];  // ALL sections of this video (simulation and broll)
}

interface SimulationOverlay {
  id: string;
  start_sec: number;           // local time within this video clip
  end_sec: number;
  simulation_url: string | null;  // URL to section_{id}.html (null if no bridge generated)
  simulation_id: string | null;
  sim_script: string | null;   // which SCRIPTS entry to call (usually 'main')
  label: string | null;
  type: string;                // 'simulation' | 'broll' | 'highlight' etc.
}
```

**Key point**: `start_sec` / `end_sec` are LOCAL times within a single video clip — not global times across the whole project. The player maps them to global time by adding the segment's `offset`.

**What counts as a "simulation section" at runtime?**  
Any `SimulationOverlay` where `type === 'simulation'` AND `simulation_url !== null`. A section that has a simulation selected but no bridge generated yet will have `simulation_url: null` and the player ignores it.

---

## Component Architecture

```
ViewerPage.tsx
  │  polls /player-config every 5s until a segment has hls_status='ready'
  │  then renders:
  ▼
HLSPlayerShell.tsx
  │  creates all DOM refs (2 video elements, iframe, progress bar DOM nodes)
  │  passes config to:
  ▼
useProjectPlayer(config, refs)
  │  returns { state, actions }
  │  manages ALL playback logic — video loading, sim overlays, scrubbing, HLS
  │
  ├─ VideoLayer.tsx          — two <video> elements stacked (A on top, B below)
  ├─ SimOverlayDynamic.tsx   — single <iframe> with CSS fade
  └─ ControlsBar.tsx         — progress bar with segment markers + sim markers
```

---

## The Global Timeline

The player builds a single unified timeline across all segments:

```typescript
function makeTimeline(segments: PlayerSegment[]): { segs: TimelineSeg[]; total: number } {
  const segs: TimelineSeg[] = [];
  let off = 0;
  for (const seg of segments) {
    segs.push({ id: seg.id, duration: seg.duration_sec, offset: off });
    off += seg.duration_sec;
  }
  return { segs, total: off };
}
```

So if you have three clips of 10s, 15s, 20s:
- Segment 0: offset=0, duration=10
- Segment 1: offset=10, duration=15
- Segment 2: offset=25, duration=20
- total = 45s

**Global time** = `segment.offset + video.currentTime`

The progress bar fill is drawn as: `(globalTime / totalDuration) * 100%`

Simulation section markers on the progress bar are drawn as:
```typescript
globalStart = segment.offset + section.start_sec
globalEnd   = segment.offset + section.end_sec
left  = (globalStart / total) * 100 + '%'
width = ((globalEnd - globalStart) / total) * 100 + '%'
```

When the actual HLS video loads and reports its real duration (which may differ slightly from the DB value), `syncActualDuration()` rebuilds offsets from that segment forward and updates all markers.

---

## The Dual Video Architecture

Two `<video>` elements exist at all times:
- **videoRef** — currently playing, zIndex 2 (visible)
- **standbyRef** — preloading the next segment, zIndex 1 (underneath)

When a segment ends (or the user scrubs to a different segment), `swapVideos()` just swaps their zIndex references. There is no DOM insertion/removal — both elements exist the whole time. The HLS.js instances also swap (active↔standby).

**Pre-warming**: When the current clip has less than 30 seconds remaining, `prewarm(nextIdx)` loads the next segment's HLS source into the standby video. This means segment transitions are nearly seamless — the next video is already buffered.

```typescript
const prewarm = (segIdx: number) => {
  const id = config.segments[segIdx]?.id;
  if (!id || standbyIdRef.current === id || !standbyRef.current) return;
  standbyIdRef.current = id;
  attachHlsSource(standbyRef.current, segIdx, hlsStandbyRef.current);
};
```

---

## How Simulations Activate in Parallel with Video

### The core loop: `onTick()`

Every time the active `<video>` fires a `timeupdate` event (~4x per second), `onTick()` runs:

```typescript
const onTick = () => {
  if (scrubbingRef.current) return;  // skip while user is scrubbing
  const gt = globalTime();           // compute global time
  setProgress(gt);                   // update progress bar
  const t   = videoRef.current?.currentTime ?? 0;  // local time in current segment
  const idx = curIdxRef.current;                    // which segment we're in

  if (seg.duration - t < 30) prewarm(idx + 1);     // buffer next clip

  if (!userPausedRef.current && !swappingRef.current)
    updateSimOverlay(idx, t);         // ← THIS is where simulations activate
};
```

### `updateSimOverlay(segmentIdx, localTime)` (useProjectPlayer.ts:234–283)

This is the central decision function. It runs every timeupdate event:

```typescript
const updateSimOverlay = (segmentIdx: number, localTime: number) => {
  const seg = config.segments[segmentIdx];

  // Find the section active at this exact local time
  const section = seg.simulations.find(
    (s) => localTime >= s.start_sec && localTime < s.end_sec
  ) ?? null;

  // Only treat it as a simulation if it has a simulation_url
  const simSection = section?.simulation_url ? section : null;

  // If the same simulation is already active — do nothing
  if (simSection !== null && simSection?.id === activeSimRef.current?.id) return;

  // Stop the previous simulation if there was one
  if (activeSimRef.current) {
    sendToSim({ type: 'stopScript' });
    setTimeout(() => merge({ showSimOverlay: false }), 350);  // 350ms CSS fade-out
  }
  activeSimRef.current = simSection;

  if (simSection) {
    const script  = simSection.sim_script ?? 'auto';      // usually 'main'
    const sameUrl = simSection.simulation_url === activeSimUrlRef.current;
    activeSimUrlRef.current = simSection.simulation_url;
    merge({ activeSimUrl: simSection.simulation_url });   // set iframe src

    if (sameUrl && simReadyRef.current) {
      // Same section visited again — iframe is still loaded and ready
      merge({ showSimOverlay: true });
      sendToSim({ type: 'startScript', script });
    } else {
      // New section URL — iframe will reload or hasn't fired SIM_READY yet
      simReadyRef.current   = false;
      pendingSimRef.current = { script };  // hold startScript until SIM_READY arrives
      startSimPoll();                      // begin polling for SIM_READY
    }
  }

  // Update badge text (section label or segment filename)
  merge({
    badgeText: section ? (section.label ?? section.type) : (seg.label ?? ''),
    badgeMode: section?.type === 'simulation' ? 'sim' : section ? 'free' : '',
  });
};
```

**What "active" means**: The system tracks one `activeSimRef` at a time. As the video plays through sections, the active section changes. The simulation iframe is mounted continuously — only the URL (and therefore the bridge script) changes.

---

## The SIM_READY Handshake Protocol

This is the protocol that ensures the bridge script is ready before the player tries to run it.

### The problem
When the player sets `activeSimUrl` (the iframe src), the iframe starts loading. This takes time — the browser fetches the HTML and JS, parses them, executes them. Meanwhile, `onTick` is still running. If the player sent `startScript` immediately, the bridge script wouldn't exist yet.

### The solution: `pendingSimRef` + polling

```
Player sets iframe src to new simulation URL
    │
    ▼
iframe starts loading (HTML + simulation JS + bridge script)
    │
    ▼
startSimPoll() begins:
  setInterval(every 300ms):
    sendToSim({ type: 'PING_SIM_READY' })
    → if bridge already fired, it replies with { type: 'SIM_READY' }
    → if bridge not loaded yet, the message is ignored (nobody is listening)
  maxAttempts = 40 (12 seconds total before giving up)
    │
    ▼
Bridge script finishes executing (DOMContentLoaded fires):
  _fireReady() runs → posts { type: 'SIM_READY' } to parent
    │
    ▼
Player's postMessage listener catches SIM_READY:
  simReadyRef.current = true
  clearInterval(simPollRef.current)       // stop the ping loop
  const pending = pendingSimRef.current   // retrieve the held-back startScript
  pendingSimRef.current = null
  if (pending && !userPausedRef.current):
    merge({ showSimOverlay: true })       // fade in overlay (350ms CSS transition)
    sendToSim({ type: 'startScript', script: pending.script })
```

### `startSimPoll()` code:
```typescript
const startSimPoll = useCallback(() => {
  if (simPollRef.current) clearInterval(simPollRef.current);
  let attempts = 0;
  simPollRef.current = setInterval(() => {
    if (simReadyRef.current || ++attempts > 40) {
      if (simPollRef.current) clearInterval(simPollRef.current);
      return;
    }
    sendToSim({ type: 'PING_SIM_READY' });
  }, 300);
}, []);
```

### The iframe's load event as a reset trigger:

```typescript
useEffect(() => {
  const frame = refs.simFrame.current;
  const onLoad = () => {
    simReadyRef.current = false;  // reset readiness — bridge hasn't fired yet
    startSimPoll();                // begin pinging
  };
  frame.addEventListener('load', onLoad);
  return () => frame.removeEventListener('load', onLoad);
}, [startSimPoll]);
```

This fires when the iframe finishes loading a NEW url. It resets `simReadyRef` to false (because the new page hasn't fired SIM_READY yet) and starts pinging.

---

## How Each Section Has Different UI and Script

### Different `simulation_url` per section

Each section, after "Generate with AI", gets its own unique HTML file:
```
section_a.html → includes section_a.js (bridge for section A's prompt)
section_b.html → includes section_b.js (bridge for section B's prompt)
```

Both HTML files are variants of the same `index.html`, but with different bridge scripts. The simulation assets (JS, CSS, data) are shared — only the bridge differs.

When the video crosses from section A's time range into section B's time range:
1. Player sends `stopScript` to the current iframe
2. Player changes `activeSimUrl` to section B's URL
3. iframe src attribute changes → browser navigates the iframe to the new URL
4. The NEW bridge script loads (section_b.js) with section B's `SCRIPTS.main()`
5. SIM_READY fires → player sends `startScript` → section B's behavior runs

### Different `sim_script` per section

The `sim_script` field (stored on each `timeline_sections` row, always `'main'` for AI-generated bridges) tells the player which SCRIPTS entry to call. This allows a single bridge to have multiple named behaviors if a developer adds them manually:

```js
const SCRIPTS = {
  main:     function() { /* default demo */ return () => {}; },
  advanced: function() { /* advanced variant */ return () => {}; },
};
```

The player always calls `sendToSim({ type: 'startScript', script: section.sim_script ?? 'auto' })`. If `sim_script` is `'main'`, Claude's `SCRIPTS.main` runs.

---

## What `startScript` Does Inside the Bridge

When the player sends `{ type: 'startScript', script: 'main' }`:

```js
// Inside the bridge IIFE
window.addEventListener('message', e => {
  const { type, script } = e.data || {};
  if (type === 'startScript') startScript(script || 'main');
});

function startScript(name) {
  stopScript();                           // cancel any running interval
  window._setScriptedMode?.(true);       // some sims have a "scripted mode" flag
  const fn = SCRIPTS[name] ?? SCRIPTS['main'];
  if (fn) _cancelFn = fn();              // run the function, store its cancel fn
}
```

`SCRIPTS.main()` is Claude's generated function. It:
1. (if simpleUi) hides irrelevant controls, switches to relevant panel
2. (if autoScript) starts a setInterval animation loop
3. Returns a cancel function that clears the interval

The returned cancel function is stored in `_cancelFn`. When `stopScript` is called (either by the player or when the section ends), `_cancelFn()` runs to clean up.

---

## What `stopScript` Does

When the video leaves a simulation section:

```typescript
// Player side:
sendToSim({ type: 'stopScript' });
setTimeout(() => merge({ showSimOverlay: false }), 350);  // 350ms CSS fade-out
activeSimRef.current = null;
```

```js
// Bridge side:
function stopScript() {
  if (_cancelFn) { _cancelFn(); _cancelFn = null; }  // clears setInterval
  window._setScriptedMode?.(false);
  window.setSimSection?.('default');  // reset sim UI to its default state
}
```

The 350ms delay on `showSimOverlay: false` matches the CSS transition duration on `.sim-overlay` — the overlay fades out gracefully before the iframe is hidden.

**Why not unload the iframe?** The iframe stays mounted with its URL set. If the video scrubs back into the same section, `sameUrl && simReadyRef.current` is true and the bridge is already ready — the overlay fades in instantly without any loading delay.

---

## User Interaction: When the Viewer Touches the Simulation

When a real user (not the animation script) touches or clicks anything inside the simulation iframe:

```js
// Bridge side (always present):
document.addEventListener('pointerdown', () => {
  window.parent?.postMessage({ type: 'userInteraction' }, '*');
}, { capture: true });
```

Why `pointerdown` and not `mousedown`? Claude's animation code fires synthetic `MouseEvent` objects to simulate slider drags. A real `pointerdown` is NEVER synthesized this way — it only fires from genuine hardware input. So this listener captures only real user clicks, not the animation.

```typescript
// Player side:
if (type === 'userInteraction') {
  videoRef.current?.pause();      // pause the video immediately
  userPausedRef.current = true;   // prevent updateSimOverlay from re-triggering
  merge({ showResumeBtn: true, badgeMode: 'free' });
}
```

The simulation stays visible and fully interactive. `userPausedRef.current = true` blocks `onTick` from calling `updateSimOverlay` — so even if the video playhead is still technically within a section, the overlay won't be touched while the user is exploring.

**"Resume video →" button** (`resumeFromSim()`):
```typescript
const resumeFromSim = () => {
  userPausedRef.current = false;
  merge({ showResumeBtn: false });
  safePlay(videoRef.current!);    // resume from where it paused
};
```

---

## simpleUi in the Viewer Runtime

`simpleUi` is a generation-time flag that shapes what Claude writes into `SCRIPTS.main`. At runtime, the viewer doesn't know or care about `simpleUi` — it just calls `startScript('main')`. The hiding of controls is baked into Claude's generated code and runs automatically when `SCRIPTS.main()` executes.

So:
- **simpleUi=true** → Claude generated code that hides tabs, control groups, irrelevant sliders when `SCRIPTS.main()` starts
- **simpleUi=false** → `SCRIPTS.main()` leaves all controls visible
- The viewer calls `startScript` either way — the UI reduction is already in the bridge

When `stopScript` is called at section end, `window.setSimSection?.('default')` restores the simulation to its full UI (if the sim supports that function).

---

## autoScript in the Viewer Runtime

Same as simpleUi — `autoScript` is a generation-time flag. Claude wrote an animation `setInterval` into `SCRIPTS.main`. At runtime:

1. Player calls `startScript('main')`
2. `SCRIPTS.main()` runs — starts the setInterval, e.g. `setInterval(() => { el.value = ...; el.dispatchEvent(new Event('input', {bubbles:true})); window.redraw?.(); }, 60)`
3. Returns `() => clearInterval(interval)` as the cancel function
4. Player later calls `stopScript` → `_cancelFn()` → `clearInterval(interval)` → animation stops

The animation running inside the iframe is completely independent of the player's React state. It's pure browser JS running in the iframe's JS context, communicating only via `postMessage` for the pause/resume interaction.

---

## The iframe: Always Mounted, URL-Driven

The `<SimOverlayDynamic>` component:

```tsx
export function SimOverlayDynamic({ simulationUrl, visible, iframeRef }: Props) {
  if (!simulationUrl) return null;  // not rendered at all if no sim in this project
  return (
    <div className={`sim-overlay${visible ? ' visible' : ''}`}>
      <iframe
        ref={iframeRef}
        src={simulationUrl}         // ← changes when section changes
        sandbox="allow-scripts allow-same-origin allow-forms"
        title="Interactive simulation"
      />
    </div>
  );
}
```

**The iframe is never unmounted** (as long as `simulationUrl` is set). When the URL changes, the browser navigates the iframe in-place — the DOM element stays, only the content changes. This prevents the flash that would occur from mounting/unmounting the iframe element.

**CSS visibility**: The `.sim-overlay` div uses a CSS class toggle (`.visible`) for fade in/out. The iframe itself is always rendered inside it — hiding it via CSS does not unload the content, keeping the simulation warm for re-entry.

---

## Scrubbing Into a Simulation Section

When the user drags the progress bar to a position inside a simulation section:

```typescript
const endScrub = (cx: number) => {
  // Determine which segment and local time the user scrubbed to
  const targetGlobal = getPct(cx) * totalDurRef.current;
  // find targetIdx, localTime from timeline

  if (targetIdx === curIdxRef.current) {
    // Same segment — just seek the video
    videoRef.current!.currentTime = localTime;
    if (userPausedRef.current) { userPausedRef.current = false; merge({ showResumeBtn: false }); }
    updateSimOverlay(targetIdx, localTime);   // ← immediately check if sim should activate
    if (wasPlayingRef.current) safePlay(videoRef.current!);
  } else {
    // Different segment — swap video, then check sim
    loadSegment(targetIdx, localTime, wasPlayingRef.current);
    // loadSegment calls updateSimOverlay(idx, localTime) after the swap completes
  }
};
```

If the user scrubs into a section with a simulation, `updateSimOverlay` fires immediately, starts the SIM_READY poll, and the simulation fades in as soon as the bridge responds.

---

## Timeline Markers on the Progress Bar

The `ControlsBar` renders two layers of markers:

```
Progress bar track
  ├── videoMarkers   — all non-simulation sections (white, subtle)
  └── simMarkers     — simulation sections (blue, protruding above/below bar)
```

Each marker is positioned using global start/end times. Simulation markers help the viewer understand where the interactive parts are before reaching them.

Segment transition dividers (vertical lines) are drawn at each segment's `offset`:
```typescript
timeline.slice(1).map((seg) => (
  <div style={{ left: `${(seg.offset / tot) * 100}%` }} />
))
```

---

## End-to-End: Video Plays Through a Simulation Section

```
Video is at t=0, segment 0
    │
    ▼ (timeupdate fires ~4x/sec)
onTick() → localTime = 4.2s
updateSimOverlay(0, 4.2):
  no section found between 4.0s and 8.0s  → no change (video continues)
    │
    ▼ (time passes...)
onTick() → localTime = 10.0s
updateSimOverlay(0, 10.0):
  section found: { start_sec:10, end_sec:25, simulation_url:'https://.../section_A.html', sim_script:'main' }
  simSection.id !== activeSimRef (null) → new simulation
    │
    ▼
Stop previous sim: (none, this is the first)
Set activeSimRef = this section
Set activeSimUrl = 'https://.../section_A.html'
  → SimOverlayDynamic: iframe src changes → browser loads section_A.html
  → simReadyRef = false (reset by iframe 'load' event)
  → startSimPoll() begins: ping every 300ms
    │
    ▼ (~1–3 seconds)
section_A.html loads → section_A.js executes → _fireReady() fires
  → posts { type: 'SIM_READY' } to parent
    │
    ▼
postMessage handler catches 'SIM_READY':
  simReadyRef = true
  clearInterval(simPollRef)
  pending = { script: 'main' }
  merge({ showSimOverlay: true })   → .sim-overlay fades in (350ms CSS)
  sendToSim({ type: 'startScript', script: 'main' })
    │
    ▼
Inside iframe:
  startScript('main') → stops any previous → runs SCRIPTS['main']()
  SCRIPTS.main():
    - window.setSimSection?.('relevant-panel')
    - hide irrelevant DOM elements
    - start setInterval animation (60ms) → slider moves, sim redraws
  Returns () => clearInterval → stored as _cancelFn
    │
    ▼ (video continues playing, simulation animates simultaneously)
    │
    ▼ (t=25.0s — section ends)
onTick() → localTime = 25.0s
updateSimOverlay(0, 25.0):
  no section found at 25.0s  → simSection is null
  activeSimRef !== null → there WAS a sim running
    │
    ▼
sendToSim({ type: 'stopScript' })
  → bridge: _cancelFn() → clearInterval → animation stops
  → window.setSimSection?.('default') → simulation resets UI
setTimeout 350ms → merge({ showSimOverlay: false }) → overlay fades out
activeSimRef = null
    │
    ▼
Video continues playing normally, overlay is hidden
```

---

## Summary of All postMessage Types

| Message | Direction | Meaning |
|---------|-----------|---------|
| `{ type: 'SIM_READY' }` | iframe → player | Bridge loaded and ready |
| `{ type: 'PING_SIM_READY' }` | player → iframe | "Are you ready yet?" poll |
| `{ type: 'startScript', script: 'main' }` | player → iframe | Run SCRIPTS['main']() |
| `{ type: 'stopScript' }` | player → iframe | Cancel animation, reset UI |
| `{ type: 'pauseScript' }` | player → iframe | Cancel animation but keep panel visible |
| `{ type: 'userInteraction' }` | iframe → player | Real user touched sim, pause video |

---

## Summary of All Key Refs in `useProjectPlayer`

| Ref | Type | Purpose |
|-----|------|---------|
| `videoRef` | `HTMLVideoElement` | Currently playing video (swaps with standby) |
| `standbyRef` | `HTMLVideoElement` | Preloading next segment |
| `simFrame` (from props) | `HTMLIFrameElement` | The single simulation iframe |
| `activeSimRef` | `SimulationOverlay \| null` | Which section is currently showing |
| `activeSimUrlRef` | `string \| null` | URL currently loaded in iframe |
| `simReadyRef` | `boolean` | Whether bridge has fired SIM_READY |
| `simPollRef` | `setInterval handle` | The PING_SIM_READY polling interval |
| `pendingSimRef` | `{ script: string } \| null` | startScript held until SIM_READY |
| `userPausedRef` | `boolean` | User manually paused (blocks auto-sim trigger) |
| `swappingRef` | `boolean` | Segment swap in progress (blocks onTick sim check) |
| `curIdxRef` | `number` | Which segment is currently active |
| `hlsRef` | `Hls \| null` | HLS.js instance for active video |
| `hlsStandbyRef` | `Hls \| null` | HLS.js instance for standby video |
