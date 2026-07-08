# ELEVEN-V3-SPEC.md — Compilation Spec for Eleven v3

This file is the rulebook for the "Production Engineer" — the agent that converts the final script into the format produced in ElevenLabs with the **Eleven v3** model in **Text to Dialogue** mode. Every rule here comes from the model's actual behavior.

---

## 1. Output Format

### 1a. Format for the UI (Studio / Text to Dialogue UI)

Each turn on its own line, speaker name, colon, then the text with audio tags embedded:

```text
Ido: [curious] Okay Noga, question. You open Excel. What do you see?
Noga: Um... cells? Lots of empty cells judging me.
Ido: [laughs] The cells that judge you — perfect. Hold on to that picture.
```



### 1b. Format for the API (create dialogue)

`model_id: "eleven_v3"`, an `inputs` array where each turn has its own `text` and `voice_id`. Audio tags stay inside the `text` of the turn they affect.

```json
{
  "model_id": "eleven_v3",
  "inputs": [
    {"voice_id": "VOICE_IDO",  "text": "[curious] Okay Noga, question. You open Excel. What do you see?"},
    {"voice_id": "VOICE_NOGA", "text": "Um... cells? Lots of empty cells judging me."}
  ]
}
```

---



## 2. Chunk Rule (Critical)

The total text in a single request must stay **under 2,000 characters** for reliable production. Therefore:

- Split each episode into **scenes** of up to **1,800 characters** (safety margin).
- Cut only at natural emotional boundaries (end of a beat, end of a moment), never in the middle of rapid back-and-forth.
- Each chunk is labeled with a header `=== CHUNK N/M — [beat name] ===` (the header is not sent to ElevenLabs — it is for the producer).
- Because v3 reads emotional context from surrounding text, each chunk must "stand alone" emotionally: if a scene opens mid-excitement, open the first turn with the appropriate tag ([excited]) even if the previous scene made the mood clear.
- For consistency across productions: use a fixed `seed` parameter per episode.

---



## 3. Audio Tags — Approved List for This Podcast

Tags are written **in English, in square brackets**, and placed immediately before the text they target. v3 does not support SSML — there is no `<break>`; silence and punctuation are managed in the text itself (Section 4).

**Emotion:** `[curious]` `[excited]` `[surprised]` `[amazed]` `[suspicious]` `[playfully]` `[deadpan]` `[warmly]` `[thoughtful]`

**Reactions:** `[laughs]` `[laughs softly]` `[chuckles]` `[giggles]` `[sighs]` `[gasps]` `[exhales]`

**Pace and delivery:** `[slowly]` `[pause]` `[hesitates]` `[whispers]` `[emphasized]`

**Dialogue dynamics:** `[interrupting]` `[overlapping]` (budget: 1–3 per episode, per HOSTS.md)

### Dosage — The Golden Rule

- At most **one tag per turn**, and no more than one tag per **2–3 turns** on average. The main emotion should come from the words and punctuation; tags are seasoning, not sauce.
- A tag must match the baseline of the chosen voice (a calm voice won't "shout" well). If the desired delivery is far from the voice — change the text, not just the tag.
- Do not invent tags outside the list without marking them for the producer as "experimental".

---



## 4. Silence, Pace, and Emphasis — Without SSML

- **Short pause:** three dots `...` within a sentence. ("And that's... exactly the point.")
- **Dramatic pause:** `[pause]` or a line break to a new turn by the same speaker.
- **Pace:** short sentences = fast; clauses with commas = slow. Write the pace into the syntax.
- **Emphasis in Hebrew:** there are no capital letters in Hebrew, so the CAPS trick doesn't exist. Instead: `[emphasized]` before the critical word, or isolating the word in its own short sentence. ("And that's it. Two numbers. Done.")

---



## 5. Hebrew and Math Spoken Aloud — Mandatory Writing Rules

This is the section that saves productions most. All text sent to TTS:

1. **Numbers in words, never digits.** "Four rows", not "4 rows". Including correct gender agreement: "three chairs", "three rows", "minus five". Fractions: "zero point five" or "half".
2. **Mathematical symbols — phonetically:** x → "x", v → "vector v", λ → "lambda", Aᵀ → "A transpose" (and preferably in general: "the matrix transposed along the diagonal" if already explained). Do not leave Latin letters or symbols like ×, =, − in the text.
3. **A matrix cell is spoken as a story, not as notation:** "row two, seat four" not "(2,4)".
4. **Computational expressions are read as action:** "three times two, plus one times five — six plus five — eleven." Intermediate results must be included aloud; the listener sees nothing.
5. **Helper vowel marks (nikud)** only for ambiguous words: מִסְפָּרִים/מְסַפְּרִים, סְפָרוֹת. Do not vowel-mark entire text.
6. **Foreign words** in Hebrew transliteration: e.g. אֶמְבֶּדִינְג (embedding), פִּיקְסֶל (pixel). Well-known product names (Excel, Netflix) — in regular Hebrew.

---



## 6. Recommended Production Settings (Alongside the Producer)

- **Voice selection:** the most important parameter in v3. Choose voices whose baseline is close to the persona (Ido: warm and calm; Noga: energetic and fast). At this stage, Instant Voice Clone or Designed Voice is preferable over PVC, which is not fully optimized for v3.
- **Stability:** Creative or Natural — so audio tags actually take effect. Robust dulls them.
- **Regenerations are part of the process:** v3 is not deterministic; if a line comes out wrong — run it again (there are free regenerations in the dashboard for the exact same text).

---



## 7. Production Markers Not Sent to ElevenLabs

The production script includes markers for the video producer. **The engineer removes all of them from the TTS file** and consolidates them in a separate sync sheet:

- `[SIM: sim-name → action on screen]` — what happens in the simulation at that moment.
- `[SCREEN: ...]` — graphics/caption.
- `[BEAT]`, `[MUSIC: ...]` — editing markers.
- Chunk headers and `<!-- -->` comments.



## 8. Pre-Delivery Checklist

- [ ] Zero digits, zero Latin letters, zero mathematical symbols in the sent text.
- [ ] Tag dosage within limits; all tags from the list; interruptions within budget.
- [ ] Every calculation read aloud includes the result.
- [ ] All production markers removed from the TTS file and moved to the sync sheet.
- [ ] Read a random chunk aloud — sounds like two people, not like text.