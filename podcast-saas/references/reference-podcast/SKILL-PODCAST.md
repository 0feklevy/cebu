---
name: linalg-podcast-studio
description: >
  Multi-agent podcast writers' room that turns a linear-algebra lesson brief
  (plus optional interactive HTML simulations) into a production-ready,
  Eleven v3 Text-to-Dialogue script for a two-host Hebrew podcast that teaches
  linear algebra through intuition, analogies, stories and worked numeric
  examples. MANDATORY TRIGGERS: "הפק פרק" (produce the episode), "תריץ את האולפן"
  (run the studio), "בנה תסריט לפרק" (build a script for the episode),
  "run the studio", "produce the episode".
  STRONG TRIGGERS: user attaches a lesson brief / simulation files and asks
  for a podcast script, dialogue script, or ElevenLabs script. Requires
  companion files HOSTS.md (host personas) and ELEVEN-V3-SPEC.md (TTS
  compilation rules); if they are attached they are authoritative. Pipeline:
  Episode Architect → Analogy & Numbers Hunter + Simulation Weaver (parallel)
  → Playwright → parallel review (Math Auditor, Ear Editor, Sim continuity)
  → rewrite → v3 Compiler → deliverables.
---

# The Studio: LinAlg Podcast Studio

The goal: a podcast episode that sounds like two real people who are crazy about linear algebra — not like a lecture split between two voices. The listener knows basic math, wants *intuition*, and arrives via a video that integrates interactive simulations. The final deliverable is a precise script ready for production in Eleven v3 (Text to Dialogue), at NotebookLM level and above.

The problem everyone who has tried to write such a script knows: when one agent tries to be pedagogue, comedian, mathematician, and TTS engineer at once — everything comes out mediocre. Pedagogy gets forgotten mid-joke, the calculation comes out wrong because focus was on flow, and the script "looks" good but sounds like text. That's why the work is split among seven specialists.

---



## Companion Files (Attached Together With This File)

- `HOSTS.md` — Persona cards for James and Emma and dynamic rules. **Exclusive source of authority** for character, speaking ratios, guess protocol, teach-back, and interruption budget.
- `ELEVEN-V3-SPEC.md` — TTS compilation rules: format, chunks, audio tags, Hebrew-and-math-spoken-aloud. **Exclusive source of authority** for Stage 6.

If one of them is not attached — work from the summaries embedded here, and note this to the user.

## Expected Input for Each Episode

1. **Lesson brief** (required) — the topics, examples, and emphases of the episode (usually a section from the course syllabus document). This is the content source; do not teach a concept that is not in the brief.
2. **HTML simulation files** (optional but recommended) — the simulations to be integrated in the video.
3. **Episode number + summaries of previous episodes** (optional) — for callbacks and open-loop continuity.
4. **Target length** (optional) — default: 8–12 minutes ≈ 1,400–1,900 words of dialogue. Brief bigger than the time? Better to cut a whole topic than to compress — "don't dig" is a core value.

---



## Five Pedagogical Pillars (Binding Contract for All Agents)

Distilled from the course master plan. Every episode must satisfy all of them:

1. **Headache before aspirin (necessity principle):** No rule, concept, or formula appears before a concrete problem is built that they solve. The listener must *feel* the need.
2. **Concrete before abstract:** Always in this order — everyday story ← concrete numeric example ← mathematical idea/name, which enters last as a "shortcut" for what was already understood.
3. **Breaking moment (Productive Failure):** At least one point where Emma's (and the listener's) intuition fails out loud — and the new concept saves the day.
4. **Open loop:** The episode plants one curiosity gap that closes only in a future episode, and closes a loop from a previous episode if one exists (callbacks — "remember when...?").
5. **One core concept per episode:** One transformation. Everything else serves it or gets cut.

---



## The Seven Specialists



### 1. Episode Architect

Translates the lesson brief into a beat sheet: cold open from everyday life, building the pain, the beats, the breaking moment, the teach-back, the closing, and the open loop — with a time budget per beat. They guard the threshold of the five pillars and "one concept per episode".

### 2. Analogy & Numbers Hunter

Generates the concrete raw materials: 2–3 candidate analogies with an explicit mapping table (what maps to what, and where the analogy breaks — so you can abandon it in time), and 2–4 numeric examples worked through to the end, in small friendly numbers that are pleasant to the ear.

### 3. Simulation Weaver

Reads the attached HTML files and builds a "sync map": at which beat each simulation appears, exactly what happens on screen, and what the hosts say to direct attention to it. Radio principle: speech describes what is happening ("watch what happens when you drag the arrow — the whole grid stretches with it") so even a listener without a screen understands everything. May suggest new simulations that serve the storytelling better.

### 4. The Playwright

The only one who writes dialogue. Receives the beat sheet, analogy package, sync map, and `HOSTS.md` — and writes the full episode in the voices of James and Emma, including `[SIM: ...]` markers in the right places. They write for the ear: short turns, guesses, reactions, and zero "now let's move to the next topic".

### 5. Math Auditor

Goes over every claim, calculation, and analogy with one standard: **simplified — yes; wrong — never.** Marks wrong calculation (🔴), simplification that will create a future misconception (🟠, with an alternative phrasing like "for now think of it this way..."), and analogy stretched past its breaking point.

### 6. Ear Editor

"Listens" to the script: hook density (at least one intriguing moment every ~90 seconds), real spoken Hebrew, turn monotony, tics ("exactly!" in a row), compliance with HOSTS.md rules, and compliance with time budget. They are the one who kills "lecture mode" wherever it sneaks in.

### 7. Production Engineer (v3 Compiler)

Applies `ELEVEN-V3-SPEC.md` to the locked script: audio tags in proper dosage, conversion of all numbers and symbols to Hebrew-spoken-aloud, splitting into chunks ≤1,800 characters at beat boundaries, separating production markers into a sync sheet. They do not change content — only compile.

---



## Workflow



### Stage 0 — Intake

Read the brief, simulations, and summaries of previous episodes. Determine: core concept, target length, which callbacks are available. If the user wrote "all the way through" — run in sequence; otherwise stop once only after Stage 1.

### Stage 1 — Beat Sheet (Architect) + Approval Gate

**Prompt template — Episode Architect:**

```
You are the Episode Architect for a two-host linear algebra podcast.
---
[Lesson brief] [Previous episode summaries if any] [Five pedagogical pillars]
[List of available simulations — names and one-line description]
---
Build a beat sheet for a [X]-minute episode:
1. Core concept in one sentence + what the listener will know at the end that they didn't at the start.
2. Cold open (30–60 sec): everyday moment everyone recognizes, from which the pain is born.
   No "hello and welcome" before there is a hook.
3. Numbered beat sequence; for each beat — pedagogical role, two-line content, time
   budget, and which pedagogical pillar it satisfies.
4. Breaking moment: what question Emma will get wrong, what the natural mistake is, and how the concept saves.
5. Placement of Emma's teach-back.
6. Closing: return to the open + the open loop for the next episode (the teaser sentence itself).
7. Callbacks: which moments from previous episodes close here.
8. "What won't go in": topics from the brief that are cut to avoid digging, with rationale.
Ensure: one concept only; no term before its pain; concrete before abstract always.
```

**Gate**: Present the beat sheet to the user in 8–10 lines and ask whether to run. (Skip if they asked "all the way through".)

### Stage 2 — Raw Materials (Two Agents in Parallel)

**Prompt template — Analogy & Numbers Hunter:**

```
You are the Analogy & Numbers Hunter. Before you: the beat sheet and lesson brief.
Supply the Playwright a hardware package:
a. For each conceptual beat — 2–3 candidate analogies from Israeli everyday life
   (Excel, cinema, Waze, supermarket...). For each analogy: explicit mapping table
   (mathematical component ↔ analogy component), its breaking point (where it stops
   working — so you can abandon it in time), and a reasoned recommendation for the winner.
   Analogies from the brief itself always take precedence — open and upgrade them before inventing new ones.
b. 2–4 numeric examples worked through to the end, step by step, in single-digit
   friendly numbers. For each example: how it sounds aloud (including intermediate results),
   and exactly what it proves. If there is a relevant simulation — match the numbers
   to what the simulation shows.
c. "Misconception minefield": 2–3 common learner mistakes on this topic,
   for use in the breaking moment and in Emma's guesses.
```

**Prompt template — Simulation Weaver:**

```
You are the Simulation Weaver. Before you: the beat sheet and HTML simulation files.
Read the code and understand what each simulation actually shows and what is interactive in it.
Build a sync map:
- For each pairing: beat number → file name → screen script (what is seen, what is dragged/clicked,
  what changes) → "pointer sentence" the host says → radio principle: how speech
  describes the visuals so a listener-only audience understands everything.
- Ensure numbers in dialogue match numbers in the simulation.
- If a beat needs visuals and there is no suitable simulation — suggest a new asset: a
  one-two-line simulation description + why it serves the storytelling.
- Mark attached simulations that are better not integrated in this episode, with rationale.
```



### Stage 3 — Script Writing (Playwright)

```
You are the Playwright. Write Episode [N] in full as dialogue between James and Emma.
---
[beat sheet] [analogy and numbers package] [sync map] [HOSTS.md in full]
---
Rules:
- HOSTS.md is contract: speaking ratios, turn lengths, guess protocol, interruption
  budget, teach-back, "exactly!" prohibitions — all binding.
- Write for the ear: spoken Hebrew, sentences that end before you run out of air,
  real reactions. A little um.../wait allowed, in human dosage.
- Every calculation spoken aloud step by step including intermediate results; the listener sees nothing.
- Place [SIM: file → action] on its own line exactly at the right moment, per the sync map.
- Forbidden: "in summary", "next topic", "as we said", term before its pain,
  fake enthusiasm.
- Open with a hook, not greetings; podcast name and introductions enter only after the cold open.
- Mark each beat with a header <!-- BEAT n: name -->.
Length: [X] words of dialogue.
```



### Stage 4 — Triple Review (In Parallel)

**Math Auditor** (receives: script + brief + numbers package):

```
You are the Math Auditor. Go line by line. Report:
🔴 calculation/factual error (+fix) | 🟠 simplification that will seed wrong understanding
(+alternative yes phrasing in the spirit of "for now, in this course...") | 🟡 analogy stretched
past its declared breaking point (+where to abandon it).
Standard: simplified — yes; wrong — never. Check every calculation twice yourself.
```

**Ear Editor** (receives: script + HOSTS.md + target length):

```
You are the Ear Editor. "Listen" to the script from the start:
1. Hook meter: mark every point where ~90 seconds passed without an intriguing/funny/surprising moment.
2. Lecture meter: every turn over 4 sentences, every stretch where Emma is too quiet.
3. Tic meter: serial affirmations, repeated words, identical turn openers.
4. Speech meter: sentences that don't survive being spoken aloud; overly written Hebrew.
5. Persona meter: contradictions vs HOSTS.md.
6. Time meter: estimated minutes vs target; if long — suggest what to cut (whole beats,
   not uniform dilution).
For each finding: quote → problem → concrete suggestion.
```

**Simulation Weaver (continuity check)** — verifies every `[SIM]` is faithful to the map, dialogue numbers = screen numbers, and the radio principle is preserved.

### Stage 5 — Rewrite (Playwright, Second Round)

```
Before you: the script and three reports. Write full version 2:
- Every 🔴 and 🟠 from the Math Auditor is addressed. Not negotiable.
- Ear Editor notes addressed; may reject a stylistic note with a one-line rationale.
- Sync corrections applied.
Keep what works; don't rewrite for its own sake.
```

If 🔴 remain after version 2 — one additional round, focused on them only.

### Stage 6 — Compilation (Production Engineer)

```
You are the Production Engineer. Before you: the locked script and ELEVEN-V3-SPEC.md.
Apply the spec in full and produce three files (detailed in "Deliverables" below).
Do not change content; may split an overly long sentence for TTS purposes.
Go through the checklist at the end of the spec and attach it marked complete.
```



### Stage 7 — Delivery

Write to the output folder:

1. `epNN-production-script.md` — the full script for reading, with beats, `[SIM]`, and timings.
2. `epNN-elevenlabs.txt` — the TTS file: numbered chunks, `Speaker: [tag] text` lines only, clean of all production markers.

In chat: short summary + what to listen to first.

---



## Important Notes

- **Stage 2 and Stage 4 — always in parallel.** Analogies and simulations don't depend on each other; the three reviewers need independent judgment.
- **The Playwright is the only voice.** No reviewer writes a full alternative dialogue — only notes and suggestions. Otherwise the episode comes out in three voices.
- **The brief is the content boundary.** Even if agents know more linear algebra — don't teach what isn't in the brief. Open loop planting is allowed; advancing material — not.
- **Each episode's meta file is the series memory.** Attach the accumulated meta to every run — so callbacks and loops actually work across a season.
- **Shorter and sharper is better.** If the Ear Editor says the episode is long — cut a beat, don't dilute everything. "Don't dig" beats "cover everything".
- **The user is the director.** At any stage they can ask: "swap the analogy", "let Emma make a mistake elsewhere", "another round of Ear Editor" — run only the relevant agent, not the whole pipeline.