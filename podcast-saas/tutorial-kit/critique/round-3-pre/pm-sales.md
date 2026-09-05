# Round 3 pre-assembly critique — PM + sales read of the five Welcome films

Read: CREATIVE-BRIEF.md (v4), CREATIVE-DIRECTION-v3.md, scripts/SCRIPT-1…5 (narration tables as
spoken), seeding/layout-v3.json, overlay/scenes/film1–5.json, seeding/proof/*.png, plus the two
product files the direction cites (`client-web/components/VideoPlayer.tsx:962`,
`client-web/components/viewer/HLSPlayerShell.tsx:666`) and the seeding code that builds the teaser's
end choice (`seeding/build-template.mjs:1085–1116`). Persona: US B2B SaaS product marketing + sales.
Every replacement line below is within ±20% of the original word count so the beat timing holds.

## Verdict (5 lines)

1. The grammar is the product's whole advantage and the scripts mostly honour it — but the screen does not: the six window chips ("Touch the motor", "Fly to a planet", "Steer the flock", "It's live — touch it", "Your package, live", "Launch a planet") exist only in `layout-v3.json`. The player renders a section label as a 12 px chip that is hidden while the sim overlay shows (`VideoPlayer.tsx:962`), and no invitation layer exists; every proof frame shows a sim, its own settings panel, an "Ask!" button and (on exit) "Go back to video". On mute — how an ad autoplays in a US feed — the first 8 s of the teaser are a CGI molecule with a slider.
2. The copy is about 80% marketing-strong (verbs, second person, scripted air, no filler) — but the ad's final line, "The doors below are live.", uses a word nobody has heard, the ad has no CTA at all if it runs off-platform, and "you" means the viewer, then the creator, then the viewer, then the creator inside 58 s.
3. The hook window is a legal coin-flip (kinesin is cleared for the LOCAL build only) whose imperative names nothing on screen: "Grab the motor… spin it" plays over a panel headed "ASSET PROOF · Walking cycle · Teaching playback 1.75×".
4. The buyer's biggest objection — "I don't have a simulation; my content isn't science" — is answered by no film, and Film 3's first line ("You built something interactive…") tells 90% of US SMB and education buyers "not for you" at 0:02. The product already ships the answer (ready-made sims in the Library) and no film says so.
5. Playlist: the one decision point in five films offers the three niche films and "Watch again" — not the tutorial that turns a viewer into a creator; the persuasion film (F4, the only audible voice answer) sits fourth; two end cards cannot be read or acted on. All of it is fixable in scripts, layout and one seeding line before a frame is captured.

## MUST-FIX (ESSENTIAL — changes whether a viewer understands or wants it), ranked

**1. All films, every window — the viewer is never told what to touch, on screen.**
Wrong: the labels in `layout-v3.json` are stored as section labels; the player's label chip is `text-xs` (12 px) and is suppressed while the sim overlay shows (`VideoPlayer.tsx:962`: `sectionLabel && !showSimOverlay && …`). No proof frame (midroll-kinesin, -solarSystem, -murmuration, -powers-orbitLab, -heavy-kinesin, -tutorial-solarSystem) shows a chip, a ring or a countdown. Orbit Lab (`midroll-powers-orbitLab.png`) shows no control at all — "drag empty space" is knowable only from the narrator. The murmuration window shows the sim's own 17 px guidance caption instead, truncated behind the logo ("…your pointer — the flock follows. Tap to startle it."), which contradicts the narrator's "find the scatter button".
Fix: ship the window-invitation layer (direction §4 W2–W6: 40–44 px verb chip anchored to the first control, two-pulse ring, 3 px countdown bar, no "Go back to video", sim guidance caption OFF) BEFORE assembly, and gate assembly on a 360p contact sheet where the chip is legible in every window. Zero-engineering fallback if the layer slips: make the Simple UI panel title the imperative via the Generate mini model prompt ("…title the panel 'Steer the flock'") — the panel is the one text element visible top-right in every frame. Not a substitute, but better than a settings panel.

**2. F1 beat 10 + `film1.json` end card — the ad's last line is unintelligible and there is no CTA.**
Wrong: "doors" is first heard in the final sentence of the film; in F5 the same word means share links, here it means a "What next?" card choice. A cold viewer parses nothing. And "below" points at nothing when the teaser runs as an ad outside the product — no button, no URL.
Fix (in-product cut): narration "Now you pick what's next. — Touch it. Ask it. Steer it. — Flow Video." (12 words vs 12); end line **"Your turn."** + ▼, so the choice prompt "What next?" that appears right under it completes the sentence. Fix (ad cut, same master, a 6 s card swap at assembly): line **"Make yours."** + the real sign-up verb as the button + the URL (off-platform the product is not the page; E2's no-URL rule does not apply). No price or "free" claim unless the owner states the offer.

**3. F1 end choice (`build-template.mjs:1092–1104`) — the tutorial is not a door.**
Wrong: the "What next?" choice has four cards: Drop In Anything, Viewer Superpowers, One Link Three Doors, Watch again. Each niche card navigates to another project, so a viewer who picks one skips "Make yours — the basics" — the film that converts. `behavior: 'pause'` means the film stalls at the choice for anyone who doesn't click (muted, distracted, phone in pocket).
Fix: door #1 = "Make yours" → the tutorial project; cap at three cards (Vimeo's own ceiling, direction 1.13) — "Make yours" · "What viewers can do" · "Drop in your own"; drop "Watch again" (the player already replays). Give the choice a default that continues the playlist on timeout if the branch API allows it; if it cannot, that is a product gap to log, because the playlist's auto-advance is broken at film one.

**4. F1 beat 2 (window kinesin [2,10]) — the hook window is license-blocked and its imperative names nothing on screen.**
Wrong: (a) kinesin is cleared for the LOCAL build only (script HARD RULES; direction W12); the ad's first 8 s ride on an asset that cannot be seeded publicly. (b) The generated Simple UI (`midroll-kinesin.png`) shows a "Teaching playback" speed slider, not the "scrub the walking cycle" the prompt asked for; the narration says "Grab the motor… spin it", the chip says "Touch the motor", the panel says "Teaching playback" — three instructions, none matching. (c) The panel header reads **"ASSET PROOF"** — a dev label in the hero shot of the ad. That string is not in this repo; it is the kinesin package's own panel.
Fix — decide now, not at ship: EITHER clearance in hand before assembly → keep kinesin, regenerate the mini model so the first control is the cycle slider, strip "ASSET PROOF" in the package (or have Simple UI drop the panel header), narration "It isn't. Go on — touch it. Grab that molecule… spin it." (11 vs 11), chip "Drag to spin"; OR open on Murmuration — the most legible touch there is (pointer moves, flock follows, a finger works, zero explanation): narration "It isn't. Go on — touch it. Drag across it… they follow you." (12 vs 11), chip "Steer the flock", beat 3 "You're steering a living flock inside an ad. This is Flow Video." (12 vs 12); kinesin (if cleared) or Orbit Lab takes the 45–52 s slot. Sales view: the flock is the stronger cold hook regardless of the license; kinesin's story ("your heavy package, live") is told properly in F3 where it belongs.

**5. F1 beats 5 and 7 — "you" changes identity four times.**
Wrong: beats 1–4 and 6 address the viewer ("touch it", "you're driving", "tap any planet"); beat 5 "your viewers steer" and beat 7 "They fly… you keep teaching" address the creator; beat 8 turns to the creator for real ("Want one?"). At 0:20 the watcher — who has just been driving — is told they are being sold to, 16 s before the pitch and before windows two and three have converted them.
Fix: beat 5 "And when the story forks… you pick the road." (8 vs 8). Beat 7 "There you go. You flew… and the video never stopped." (9 vs 8) — this also states the one differentiator no competitor has (H5P/Vimeo pause to interact; this keeps rolling). Beat 8's "Want one?" becomes the single, clean turn.

**6. F1 beat 4 — the ad's voice-Q&A proof is chips-only.**
Wrong: "Questions? Ask out loud. It answers from this lesson." plays over a mic waveform and caption chips. That is a claim. The only audible answer in the playlist is F4 beat 5 — film four of five, which most ad viewers never reach. Also "this lesson": the ad is watching a video, not a lesson.
Fix: narrator "Questions? Ask out loud." (4 words, ~1.3 s) then YIELDS: a real viewer voice asks about the sim just touched (~1.4 s) → the answer's first clause is audible (~2.3 s) → cut. The answer IS "it answers from this lesson", so the clause goes. Fits the 5 s beat. Same ElevenLabs dependency as all narration.

**7. F3 beat 1–2 and F2 beat 3 — "I don't have a simulation" is never answered; F3 makes it worse.**
Wrong: F3 opens "You built something interactive… and it's trapped in a folder." Most US SMB, marketing and education buyers have built nothing — the third film in the playlist says "not for you" at 0:02. F2 beat 3 "That zip? Just a folder somebody built." raises the question (who? not me) and leaves it. Meanwhile the product already ships the answer: the welcome project's Library holds ready-made sims (`layout-v3.json` `library_extras` + the three window packages); the tutorial project gets none (`build-template.mjs:296` `extraSims: []`).
Fix: F3 beat 1 "Anything that runs in a browser… can run inside your video." (11 vs 10); beat 2 "Got one? Zip it. Drop it. That's the entire import." (10 vs 9). Verify "anything that runs in a browser" against the package contract (controls in the initial DOM) before recording; if it is not literally true, say "Any web page with buttons…". F2 beat 3 "It sorts itself. That zip? Someone's folder — or one already in your Library. No code." (15 vs 14) — and seed `library_extras` into the tutorial project too, so the shot shows them and the claim is literally true on camera.

**8. F2 window chip + beat 8; F3 window chip + beat 6 — chips are not imperatives and the first real instruction arrives late.**
Wrong: F2 chip "It's live — touch it" (4 words, no target; the first target, "Tap a planet", is spoken at 0:57, six seconds after the window opens at 0:51 — half the proof wasted). F3 chip "Your package, live" is a caption, not an instruction; "Go on — scrub it" is editor jargon to a non-video buyer. F1 chip "Fly to a planet" names the outcome, not the gesture.
Fix: F2 chip "Tap a planet"; beat 8 "Done. …That's not a preview. Tap a planet." (8 vs 7); beat 9 "Now speed up time. Your viewers get exactly this — nothing in their way." (12 vs 14). F3 chip "Drag the slider" (the Simple UI's one slider is "Cycle position"); beat 6 "And here's what your viewers get. Go on — drag the slider." (11 vs 10). F1 solar chip "Tap a planet".

**9. F4 beats 1 and 11 (`film4.json`) — a 3 s end card nobody can read, bought with 6 s of nothing.**
Wrong: the end card is 3 s (t0 54, dur 3) against the direction's 5 s floor, carrying a line, a lockup and a five-word pointer ("Next: One Link, Three Doors") that also hard-codes the playlist order. Meanwhile beat 1 spends 6 s on "a shared video playing, clean and ordinary" — the trap F1 already sprang three films earlier.
Fix: beat 1 to 3 s (same line, 8 words); window `orbitLab [6,18]` → `[3,15]` in layout-v3 + script; beats 4–10 shift −3 s; end card 51–57 = 6 s. Line "Four powers. One link." keeps; pointer ▼ only — the player shows the next title.

## Objections — who answers, who doesn't

| Objection a US buyer raises | Answered | Not answered / made worse |
|---|---|---|
| What does it cost? | Nowhere — by design (F5 beat 5 frame rule keeps money off camera). Fine in-product; the AD cut needs an honest offer verb on its card (MUST 2) once the owner states the offer. | F1–F5 |
| How much work is it? | F2 (five build beats in 90 s is the proof; "No code. Watch."), F3 beat 2 ("That's the entire import"), F1 beat 8 implies it ("Tell the AI"). | F1 never says "No code" — see SHOULD 1 |
| My content isn't science / I have no simulation | — | Nobody. F3 beat 1 excludes the buyer (MUST 7) |
| Does it work on phones? | F5 beat 6 (sim touched on a real phone — the true answer), F4 beat 8 (crop only). | F1, the ad, is cursor-only — SHOULD 4 |
| Do my viewers need an app/account? | F5 beat 6 ("No app. No account. No download.") — excellent; F1 "One link." implies it. | — |
| What if my viewer never touches it? | F2 beat 7 ("Auto Script — it performs for the ones who only watch"); every window's auto-script fallback. | — |
| Will the AI make things up? | F4 beat 6 ("From this lesson. Not the internet."). | F1 claims it, proves nothing (MUST 6) |
| Am I locked in / can I change it? | F2 beat 12 ("Change one word"), F3 beat 5 ("It remembers — and rewires"). | — |

## Playlist and end cards

| | Now | Fix |
|---|---|---|
| Order | teaser → tutorial → Drop In → Powers → Share | teaser → tutorial → **Powers** → Drop In → Share. F4 persuades (and holds the only audible answer); F3 serves people already persuaded and equipped. |
| Teaser choice | 3 niche films + Watch again, pauses forever | MUST 3 |
| F1 card | "The doors below are live." ▼, no CTA off-platform | MUST 2 |
| F2 card | "Change one word." + "Edit this section" + "New project" | Best card of the five. Keep. |
| F3 card | script "Drop in anything." vs overlay "Drop yours in." | Ship "Drop yours in." (echoes the spoken "drop it in", second person); sync the script. Button "Add a simulation" keeps. |
| F4 card | 3 s, ▼ + hard-coded next title | MUST 9 |
| F5 card | "Ship yours." + "Create link" | Keep. |
| All cards | — | E6/E7 at QC: every button a real deep-link, ▼ honest within 2 s. |

## SHOULD (strong, cheap; not existential)

1. F1 beat 8 — the ad never says the two words a US SMB buyer waits for. "Want one? Drop in footage — and anything interactive. Tell the AI what viewers touch. No code. One link. That's a Flow Video." (22 vs 20). Also kills "a simulation", the word that triggers "not me".
2. F1 window times disagree between binding documents: script + layout `[2,10]/[25,33]/[45,52]`; direction §9 + H6 `[4,12]/[24,32]/[44,51]` with risers computed for the latter. Mixed sources put every riser 2 s off. Recommend the direction's: "This looks like a video." needs to finish as a sentence over an ordinary frame before the turn at 3.0 s; at 2.0 s the sim is fading in on the last word and the trap has no time to be a trap. Same for F2 `[51,63]` vs `[52,64]`.
3. F1 beat 6 — "Tap any planet" is a lie on a phone: Mercury, Venus and Mars are 3–5 px dots in `midroll-solarSystem.png`. "Round two — a solar system. Tap Jupiter. Go ahead… I'll wait." (10 vs 11). Direction W2's own example, "Tap Mars", picks a dot.
4. F1 beat 4 — stage the ask on a phone with a real finger (C7). "Ask out loud" is a phone gesture; it answers "does it work on phones" inside the ad for free, the only film that currently never shows one.
5. F2 beat 10 duplicates F5 beat 2 almost verbatim and is the only jargon in the basics film ("a podcast that answers voice questions"). "Hit Create link. That one link is the whole thing — the video, an audio edition, your library." (16 vs 17). Let F5 own the three doors.
6. F5 beat 2 — same phrase: "Hit Create link. One link — three doors: your video… an audio edition that answers questions out loud… your whole library, browsable." (21 vs 19).
7. F4 beat 8 — "the frame chases your speaker": a US ear hears an audio speaker. "Four: anywhere. Phones stay vertical — the frame follows whoever's talking." (10 vs 10).
8. F4 beat 10 — the fourth power is spoken as "anywhere", recapped as "Their way." and the grid labels are undefined (`film4.json` `four-grid-labels` props `{}`). One set of four words everywhere: "Touch. Ask. Choose. Anywhere. Give your viewers powers — they'll give you attention." (12 vs 13).
9. F3 window — the Simple UI kept a paragraph of biochemistry ("Compare plus-end kinesin with the structurally distinct minus-end dynein", `midroll-heavy-kinesin.png`) in a 51 s marketing film. Add "no descriptions" to the stored prompt, or hide help text under Simple UI.
10. Murmuration window — the sim's own guidance caption is ON and truncated behind the logo; W7 says off. Disable sim guidance audio and caption for every film window (the direction says so; the proof frame shows it isn't done).

## NICE (polish)

- Music BPM disagrees between script and direction (F1 112 vs 120; F2 96 vs 100). The beds are being re-rendered anyway — pick the direction's numbers and fix the script headers.
- `SCRIPT-2` says "14 beats"; the table has 12. `film2.json` total 96 s vs the script's 1:23 — the overlay re-times at assembly, but the stated total should match.
- CREATIVE-BRIEF v4 still calls Film 3 "The Heavy Simulation" and describes teaser + tutorial on one timeline; SCRIPT-2 is "its OWN project now". One paragraph in the brief is stale relative to scripts + layout.
- `midroll-kinesin-exit.png` shows two "Ask!" buttons in frame (the player's and the page's) and the FULL control panel (Pause, Cycle position, Teaching playback, Advanced background) — an un-simplified UI over the video. Whatever that capture is, it must not be a source shot.
- F2 beat 2 "…and a whole simulation, as one zip" can be heard as everything in one zip: "…and a whole simulation — that's one zip." (same count).
- F2 beat 7 "Simple UI — only your buttons": "only the buttons you named" is what it does (+2 words, fits).
- "Flow Video" spoken 3× is only met by F1; F2–F5 say it once. One mention per 50 s film is right for a playlist; drop the 3× rule outside the teaser rather than stuffing it in.

## What already works — do not touch

The mid-roll grammar itself — the real sim mounting over a film that keeps talking, then handing back — is the product, and the scripts trust it: scripted air ("Go ahead… I'll wait."), consequence lines ("…That was you.", "You're driving a molecular machine inside an ad."), and the hook pair "This looks like a video." / "It isn't. Go on — touch it." are exactly the register a US trailer needs. Film 2's spine is the best creator pitch in the set: the prompt typed verbatim and read aloud, "Two switches. Simple UI — only your buttons. Auto Script — it performs for the ones who only watch. …Generate.", "Done. …That's not a preview. Touch it.", the meta handover "This project? Already yours.", and the end card "Change one word." + "Edit this section" — a CTA that is a two-second action, not a slogan. Film 3 beat 5 ("Second thoughts? Type them… It remembers — and rewires.") is a real differentiator said plainly. Film 4's power one ("Grab empty space… drag… let go. — Watch gravity fight for it."), the narrator-silent real exchange, "From this lesson. Not the internet." and "Give your viewers powers — they'll give you attention." are the strongest thirty seconds of proof in the playlist. Film 5's "the slide, the bio, the syllabus", "No app. No account. No download.", and "Ship yours." + "Create link" close the sale. And the honesty rules — verbatim stored prompts, no money on camera, no interactivity-in-MP4 claims, no "same voice" dub claim — are a sales asset, not a constraint; keep every one.
