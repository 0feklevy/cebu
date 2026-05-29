# AI Simulation Bridge Script Generation Pipeline

## What Is This?

Every simulation section in the video editor is backed by two things:
1. A **ZIP archive** the user uploaded — a self-contained HTML/JS simulation (a physics sim, a calculator, a diagram, etc.)
2. A **bridge script** — a generated JavaScript IIFE that tells the simulation what to do when the video reaches that time range, and how to communicate with the video player

When you click **"✦ Generate with AI"**, the system reads the simulation's source code, sends it to Claude Sonnet 4.6 along with your prompt, and gets back a custom bridge script tailored to exactly what your section should demonstrate.

---

## The ZIP — What Happens at Upload

### What you upload
A `.zip` file containing a complete, self-contained interactive simulation — typically a physics demo, a data visualization, or a math explorer. The ZIP can contain: HTML, JavaScript, CSS, images, JSON data files, fonts. It must have at least one `.html` file (ideally `index.html`).

### What `processUpload()` does (SimulationService.ts:185–228)

```
User uploads ZIP
    │
    ▼
extractZip(buf)                     — strips __MACOSX/ and .DS_Store junk, returns Map<relPath, Buffer>
    │
    ▼
findEntryHtml(files)                — prefers root-level index.html; falls back to shortest HTML path
    │
    ▼
injectBridge(rawHtml, [])           — inserts BRIDGE_TEMPLATE right before </body> (or appends)
    │                                 bridgeFunctions = [] (empty, no AI call during upload)
    ▼
Upload all files to storage         — uploaded under simulations/{projectId}/{simId}/{relPath}
    │
    ▼
Store storage KEY in DB             — simulations.entry_file = "simulations/p/s/index.html"
                                       (not a URL — computed fresh per request)
```

**Why is `bridgeFunctions` empty?** At upload time we used to call Claude Haiku to auto-discover callable functions in the JS files. This blocked uploads for 20–40 seconds. It was removed because per-section AI bridge generation (the "Generate with AI" button) is better — Claude reads the full source with your specific prompt and generates much more accurate code.

### The BRIDGE_TEMPLATE (SimulationService.ts:12–43)

Every uploaded simulation gets this minimal script injected into its HTML:

```js
;(function(){
  var _ready=false, _cancel=null, _scripts={};

  // 1. Fire SIM_READY as soon as the DOM is ready (or after 3s timeout as fallback)
  function fireReady(){
    if(_ready)return; _ready=true; window._simReadyFired=true;
    window.parent && window.parent.postMessage({type:'SIM_READY'}, '*');
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', fireReady);
  else fireReady();
  setTimeout(fireReady, 3000);

  // 2. _discovered = [] (empty — no auto-discovered functions)
  var _discovered = [];

  // 3. 'auto' script calls all discovered functions (no-op since list is empty)
  _scripts['auto'] = function(){
    _discovered.forEach(function(fn){ var f=window[fn.windowFn]; if(typeof f==='function'){ try{f();}catch(e){} } });
  };

  // 4. Listen for player messages
  function startScript(name){
    if(_cancel){ try{_cancel();}catch(e){} _cancel=null; }
    var fn = _scripts[name] || _scripts['auto'];
    if(fn){ try{ _cancel = fn() || null; }catch(e){} }
  }
  window.addEventListener('message', function(e){
    var d = e.data || {};
    if(d.type==='startScript')      startScript(d.script || 'auto');
    if(d.type==='stopScript' && _cancel){ try{_cancel();}catch(e){} _cancel=null; }
    if(d.type==='PING_SIM_READY' && _ready)
      window.parent && window.parent.postMessage({type:'SIM_READY'}, '*');
  });

  // 5. Notify player when user touches the simulation
  document.addEventListener('pointerdown', function(){
    window.parent && window.parent.postMessage({type:'userInteraction'}, '*');
  }, {capture:true});
})();
```

**Purpose of the template:**
- Makes the simulation "player-aware" even before any section bridge is generated
- `SIM_READY` fires when DOM is ready — player listens for this before sending `startScript`
- `PING_SIM_READY` → `SIM_READY` = the handshake protocol for when player sends ping before sim loaded
- `userInteraction` → tells the player "a human clicked, pause the video"
- `stopScript` → cleans up any running animation loops
- The `_cancel` mechanism allows any script to register a cleanup function

---

## "Generate with AI" — The Full Pipeline

### 1. Frontend: `handleGenerateScript()` (SectionEditor.tsx:214–238)

When you click the button:

```
1. Validate: simId must be selected, prompt must not be empty
2. setGenerating(true)  — disables button, shows spinner
3. If section.type !== 'simulation' OR section.simulation_id !== current simId:
       PATCH the section first (api.updateSection) to commit the simulation selection
4. POST /api/v1/projects/{projectId}/sections/{sectionId}/generate-sim-script
       body: { prompt, simple_ui, auto_script }
5. Response is the updated TimelineSection with new simulation_url
6. onUpdate(updated) — parent re-renders with the new section data
7. setGenerating(false)
```

**State variables involved:**
```typescript
const [simPrompt, setSimPrompt]   = useState(section.sim_prompt ?? '');  // your typed prompt
const [simpleUi, setSimpleUi]     = useState(section.simple_ui ?? false); // toggle state
const [autoScript, setAutoScript] = useState(section.auto_script ?? true);// toggle state
const [generating, setGenerating] = useState(false);                       // spinner state
```

---

### 2. Backend Controller (sections.controller.ts:169–213)

```
POST /api/v1/projects/:id/sections/:sid/generate-sim-script
    │
    ▼
Guards:
  - project must belong to this user
  - section.type must === 'simulation'
  - section.simulation_id must be set
    │
    ▼
new SimulationService(storageAdapter, ANTHROPIC_API_KEY)
.generateBridgeScript({ simId, sectionId, projectId, prompt, simpleUi, autoScript })
    │
    ▼
Returns { sectionUrl }
    │
    ▼
UPDATE timeline_sections SET:
  simulation_url = sectionUrl,  ← new section-specific HTML page
  sim_prompt     = prompt,
  simple_ui      = simple_ui,
  auto_script    = auto_script,
  sim_script     = 'main'       ← tells player which SCRIPTS entry to call
WHERE id = sectionId
    │
    ▼
Return updated section row to frontend
```

---

### 3. SimulationService.generateBridgeScript() (SimulationService.ts:307–431)

This is the core of the pipeline. It runs in ~30–60 seconds because it makes an API call to Claude.

#### Step 1: Gather simulation source files

```
List all keys in storage under "simulations/{projectId}/{simId}/"
    │
    ▼
Filter: keep only .js, .mjs, .ts, .html, .htm, .css files
Filter: skip previously generated section_*.html and section_*.js files
Sort: JS files first (most important for understanding logic), then HTML/CSS
Take: up to 10 files
    │
    ▼
For each file:
  - Download its content from storage
  - Strip any previously-injected bridge block (regex removes /* sim-bridge ... */)
  - Truncate to 12,000 characters (enough for Claude to see wireUI() and slider IDs)
    │
    ▼
Join into one big string: "=== File: simulations/p/s/sim.js ===\n<content>\n=== File: ..."
```

**Why strip old bridge blocks?** On the second (or later) generation, the HTML already contains a previously-generated bridge. Sending it to Claude would confuse the model — it would see its own prior output and get distracted by it.

**Why JS files first?** The slider IDs, global functions like `updateDerivedPhysics()`, `redraw()`, and `setSimSection()` are defined in the JS. Claude needs to see these to write correct animation code.

**Why 12,000 chars per file?** The first session used 7,000 which was too short — `wireUI()` (where slider IDs are defined) was getting cut off. 12,000 chars covers most simulation files completely.

---

#### Step 2: Build the user message for Claude

```
SIMULATION SOURCE FILES:
=== File: simulations/p/s/sim.js ===
<first 12000 chars of sim.js>

=== File: simulations/p/s/index.html ===
<first 12000 chars of index.html>

---
SECTION PROMPT (what to show/demo in this section):
<your typed prompt, e.g. "Show the initial velocity Y slider animated from 0 to 20">

---
TOGGLES:
simpleUi=true — YES: Hide controls not relevant to the prompt. In SCRIPTS.main:
  (1) call window.setSimSection?.('name') if that function exists in the source;
  (2) also directly hide irrelevant DOM control groups/tabs using style.setProperty('display','none').
  Keep only the controls the prompt mentions.

autoScript=true — YES: Animate using setInterval (return clearInterval cleanup).
  Pattern: find slider IDs from HTML → in callback:
    el.value=String(v); el.dispatchEvent(new Event('input',{bubbles:true}));
    window.updateDerivedPhysics?.(); window.redraw?.();
  — cycle min→max→min smoothly. Also call window.showOptimal=true so derived paths render.

Generate the complete bridge script IIFE now. Output ONLY the JavaScript — no prose, no markdown.
```

---

#### Step 3: Claude generates the bridge script

**Model**: `claude-sonnet-4-6`  
**Max tokens**: 4,096  
**System prompt**: `BRIDGE_GEN_SYSTEM_PROMPT` — a detailed template defining the exact IIFE structure Claude must follow

Claude is instructed to produce a **single self-contained IIFE** that always includes these fixed sections verbatim:

```js
(function () {
  'use strict';

  // ── SIM_READY block ── ALWAYS present, verbatim ──────────────────────────
  let _ready = false;
  function _fireReady() {
    if (_ready) return; _ready = true; window._simReadyFired = true;
    window.parent?.postMessage({ type: 'SIM_READY' }, '*');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _fireReady);
  else _fireReady();
  setTimeout(_fireReady, 3000);

  // ── Script lifecycle ─────────────────────────────────────────────────────
  let _cancelFn = null;

  function stopScript() {
    if (_cancelFn) { _cancelFn(); _cancelFn = null; }
    window._setScriptedMode?.(false);
    window.setSimSection?.('default');  // reset to full UI
  }

  function pauseScript() {
    if (_cancelFn) { _cancelFn(); _cancelFn = null; }
    window._setScriptedMode?.(false);
    // Does NOT call setSimSection — keeps current panel visible
  }

  function startScript(name) {
    stopScript();
    window._setScriptedMode?.(true);
    const fn = SCRIPTS[name] ?? SCRIPTS['main'];
    if (fn) _cancelFn = fn();
  }

  // ── SCRIPTS — Claude fills this in based on your prompt ─────────────────
  const SCRIPTS = {
    main: function () {
      // ... Claude's custom code goes here ...
      return () => {};  // cancel function — MUST clean up all intervals/timeouts
    },
  };

  // ── Public API ───────────────────────────────────────────────────────────
  window.SimAPI = { start: startScript, stop: stopScript };

  // ── postMessage listener ─────────────────────────────────────────────────
  window.addEventListener('message', e => {
    const { type, script } = e.data || {};
    if (type === 'startScript')  startScript(script || 'main');
    if (type === 'stopScript')   stopScript();
    if (type === 'pauseScript')  pauseScript();
    if (type === 'PING_SIM_READY' && window._simReadyFired)
      window.parent?.postMessage({ type: 'SIM_READY' }, '*');
  });

  // ── userInteraction — real pointer (not synthetic) ───────────────────────
  document.addEventListener('pointerdown', () => {
    window.parent?.postMessage({ type: 'userInteraction' }, '*');
  }, { capture: true });

})();
```

**The SCRIPTS.main function is what Claude customizes based on your prompt.**

---

#### What Claude generates for `simpleUi=true`

Claude reads the simulation source to find:
1. Does `window.setSimSection` exist? If yes, call it with the most relevant panel name
2. Which DOM control groups, tabs, or sliders are NOT mentioned in the prompt? Hide them

Example output for `simpleUi=true` with prompt "Show initial Y velocity slider":
```js
main: function () {
  // Switch to the relevant panel if the sim supports it
  window.setSimSection?.('kinematics');

  // Hide all control groups not relevant to initial Y velocity
  document.querySelector('.tabs')?.style.setProperty('display', 'none');
  document.getElementById('mass')?.closest('.control-group')?.style.setProperty('display', 'none');
  document.getElementById('angle')?.closest('.control-group')?.style.setProperty('display', 'none');
  document.getElementById('v0x')?.closest('.control-group')?.style.setProperty('display', 'none');
  // Keep: #v0y control group — that's the prompt target

  return () => {
    // On stop: restore everything
    document.querySelector('.tabs')?.style.removeProperty('display');
    // ... etc
  };
}
```

**Why `style.setProperty('display','none')` and not `el.style.display = 'none'`?** Some sims use `!important` in their CSS. `setProperty` can override that; shorthand assignment cannot.

---

#### What Claude generates for `autoScript=true`

Claude reads the HTML to find the exact input element IDs, then generates a pingpong animation:

Example output for `autoScript=true` with prompt "Animate the initial Y velocity":
```js
main: function () {
  const el = document.getElementById('v0y');  // found this ID in the HTML source
  if (!el) return () => {};

  const min = parseFloat(el.min) || 0;
  const max = parseFloat(el.max) || 20;
  let val = min;
  let dir = 1;

  const interval = setInterval(() => {
    val += dir * 0.3;
    if (val >= max) { val = max; dir = -1; }
    if (val <= min) { val = min; dir = 1; }

    el.value = String(val);
    el.dispatchEvent(new Event('input', { bubbles: true }));  // trigger sim's input handler
    window.updateDerivedPhysics?.();   // call sim's derived-state updater
    window.redraw?.();                 // call sim's draw loop
    window.draw?.();                   // fallback draw name
    window.render?.();                 // another common name
  }, 60);

  window.showOptimal = true;  // if sim has this flag, show derived optimal path
  window.redraw?.();

  return () => clearInterval(interval);  // cancel function
}
```

**The critical pattern**: `el.value = v` alone doesn't work — the sim's JS listens for the `'input'` event. And in some sims, `dispatchEvent` alone doesn't trigger the redraw — the global `updateDerivedPhysics()` / `redraw()` must also be called directly. Claude is instructed to do both.

---

#### Step 4: Upload generated files

```
Generated JS code from Claude
    │
    ├─ Upload to: simulations/{projectId}/{simId}/section_{sectionId}.js
    │             (at the simId level — one directory ABOVE the simulation subfolder)
    │
    └─ Build section HTML:
         - Download original index.html from storage
         - Strip any existing sim-bridge <script> block
         - Calculate relative depth:
             entryDir = "simulations/p/s/hamiltons"
             prefix   = "simulations/p/s"
             depth    = 1  →  relPath = "../section_{sectionId}.js"
         - Add: <script src="../section_{sectionId}.js"></script> before </body>
         - Upload to: simulations/{projectId}/{simId}/{subdir}/section_{sectionId}.html
    │
    ▼
Compute public URL for section HTML → return as sectionUrl
```

**Why two files?**
- The `.js` file is the bridge script — Claude's pure JavaScript IIFE
- The `.html` file is the original simulation HTML with the bridge script added as an external `<script src>` tag (not inline)
- The HTML file lives in the same directory as `index.html` so all relative asset paths (`./sim.js`, `./style.css`, etc.) still resolve correctly
- The JS file lives one level up (at `simId/` level) to avoid being confused with the simulation's own JS

**Why a relative path?** The simulation may be served from different origins in development vs production. A relative path (`../section_xxx.js`) always resolves correctly regardless of the domain.

---

#### Storage layout after generation

```
R2 / local storage:
simulations/
  {projectId}/
    {simId}/
      section_{sectionId}.js          ← Claude's generated bridge (referenced by HTML below)
      {simSubfolder}/                  ← the extracted ZIP contents (e.g. "hamiltons/")
        index.html                     ← original sim entry with BRIDGE_TEMPLATE injected
        section_{sectionId}.html       ← copy of index.html + <script src="../section_...js">
        sim.js                         ← simulation's own JavaScript
        style.css                      ← simulation's stylesheet
        data.json                      ← any data files
```

---

### What gets saved to the database

After generation, the `timeline_sections` row is updated:

| Column | Value | Meaning |
|--------|-------|---------|
| `simulation_url` | public URL to `section_{sectionId}.html` | What the player loads in the iframe |
| `sim_script` | `'main'` | Which SCRIPTS entry the player calls |
| `sim_prompt` | your typed prompt | Stored for display and re-generation |
| `simple_ui` | true/false | Stored for re-generation |
| `auto_script` | true/false | Stored for re-generation |

---

## Summary: The Full Click-to-Play Path

```
User clicks "✦ Generate with AI"
    │
    ▼ (frontend, ~instant)
handleGenerateScript() → PATCH section type+sim_id if needed → POST generate-sim-script
    │
    ▼ (backend, 30–60 seconds)
sections.controller: validate → SimulationService.generateBridgeScript()
    │
    ▼
Read up to 10 source files from storage (JS first, 12k chars each)
Strip old bridge blocks
Build user message with source + prompt + simpleUi/autoScript flags
    │
    ▼
Claude Sonnet 4.6 generates IIFE bridge script (30–60s)
    │
    ▼
Upload section_{sectionId}.js to storage
Build section HTML: original index.html + <script src="../section_xxx.js">
Upload section_{sectionId}.html to storage
    │
    ▼
UPDATE timeline_sections: simulation_url = public URL to section HTML
    │
    ▼ (frontend response)
section.simulation_url now points to the section-specific HTML page
section.sim_script = 'main'

→ When the video reaches this section's time range, the player loads this URL in an iframe
  and sends { type: 'startScript', script: 'main' } → SCRIPTS.main() runs → Claude's code executes
```

---

## Why the Simulation Stays Responsive to Users

**The `pointerdown` listener** in every bridge (both BRIDGE_TEMPLATE and generated) fires `userInteraction` on the FIRST real pointer event. This uses `{ capture: true }` so it intercepts before the simulation itself handles it.

**Why `pointerdown` and not `mousedown`?** Claude's generated bridges use synthetic `MouseEvent` for animation (simulating slider drags). A real `pointerdown` event is always triggered by an actual user touch or mouse click — never by synthetic events. So only genuine user interaction reaches the player.

**What happens then:** The video player pauses immediately. The simulation stays visible and fully interactive. The user can freely explore. A "Resume video →" button appears. When they click it, the video resumes from where it paused.
