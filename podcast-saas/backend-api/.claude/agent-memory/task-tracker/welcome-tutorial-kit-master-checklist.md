---
name: welcome-tutorial-kit-master-checklist
description: Master checklist for the overnight Welcome-playlist production run (feat/welcome-tutorial-kit) — 13 owner requirements broken into ~50 atomic items with verdicts; living doc, re-audit as the night progresses
metadata:
  type: project
---

Full checklist lives at `podcast-saas/tutorial-kit/CHECKLIST.md` (13 requirement sections, ~50
atomic sub-items, each with a verdict + file:line evidence) — that is the artifact to re-read and
update, this memory is the pointer plus the findings worth NOT re-discovering from scratch.

**Snapshot basis: 2026-09-05 01:31 EEST**, branch `feat/welcome-tutorial-kit`, 2 commits
(`07df44c`, `77bf941`) + substantial uncommitted work. This run is autonomous/overnight and was
**actively changing while being audited** — 5 new files appeared in a single `git status` re-check
(SCRIPT-3/4/5, a capture-prop staging script + its output). Re-verify current state before trusting
any row in the checklist as still accurate; don't assume staleness OR freshness without checking
(see [[feedback_reverify-live-state-before-flagging-stale]] in the git-root memory dir).

**The one finding worth flagging hardest: the plan's assumed word-timed-caption mechanism is
wrong.** `GuidanceTTSService.ts:38-39` (backend-api) explicitly does NOT support ElevenLabs word
timing by design ("we don't need word alignment for guidance, only the audio clip"). The
timing-capable code (`ForcedAlignmentService.ts`) lives in `backend-api/src/_archive/
v1-podcast-pipeline/`, excluded from the build (`tsconfig.json:12`) and imported by nothing live.
The REAL reachable path for word-timed VTT is: TTS audio → assemble into the film → upload through
the normal video pipeline → `CaptionService.ts`'s Groq STT auto-transcribes it
(`runVideoTranscode.ts:14 → enqueueCaptionsForProject`). Same shape as [[key-rotation-needs-a-reader]]
— fix the thing at the READ/actual-mechanism site, not the one that sounds right from the plan doc.

**Second load-bearing finding**: `seeding/DESIGN.md`'s own PRE-BUILD FIX #1 (`ProjectDuplicationService`
must carry `sim_files` on clone) is still unaddressed — re-verified fresh with a direct grep
(`grep -n "sim_files" ProjectDuplicationService.ts` → zero hits), not assumed from the design doc's
own claim. Building the seeding service before this lands ships a known, self-documented bug.

**Status in one line per requirement area** (13 owner requirements from tonight's brief — full
detail in CHECKLIST.md):
1. Playlist structure/teaser/niche scripts: scripted (5/5 scripts exist as of this snapshot,
   niche scripts 3-5 appeared mid-audit), zero produced footage.
2. Demo project (playlist entry #1, live sections): designed only, nothing built — the two sims
   (Murmuration, Wave Lab) are real, functional, license-clean and independently verified, but not
   yet wired into any authored project section.
3. Real captures: local stack confirmed live; sim b-roll actually captured via Playwright
   (`record-sim-footage.mjs` → real mp4s, but only in scratchpad, no repo manifest); the
   comprehensive UI-walkthrough capture script (`capture-all.mjs`) doesn't exist yet.
4. Narration: TTS path real but unused; spend-recording wiring re-verified still correct
   (`GuidanceService.ts:637`, `VoiceQuestionService.ts:121`); captions — see finding above.
5. Assembly: ffmpeg is installed; `assembly/` dir is empty; nothing assembled.
6. Critique gates: G1-pre table says "✅ ran (3 critics)" then six lines later admits the third
   (PM/accuracy) is "still running" — an unresolved self-contradiction in the plan doc itself, the
   same failure shape `CLAUDE.md §3b` calls out by name. G1-post never run.
7. Real-API build: a capture-PROP project ("Standing Waves 101") is being built live via real
   local APIs as of the snapshot (confirmed via a live-tailed backend log, not just the script's
   existence) — but that's content the films SHOW being built, not the actual seeded demo project.
8. Seeding mechanism: migration 085 does not exist (last migration is 084); zero seeding code
   anywhere; design doc is thorough but 100% unimplemented.
9. Script honesty constraints (PM critic): all 4 sub-constraints genuinely satisfied at the script
   text level, independently verified by reading, not by trusting the script's own claims.
10. Device sweep: existing sweep scripts/screenshots in scratchpad predate this branch's first
    commit by hours — leftover from the prior library/playlist PR's own verification, not this
    playlist. Zero sweep of the actual deliverable (which doesn't exist yet either).
11. Regeneration docs: README's contract is genuinely well-written; DECISIONS.md has ZERO entries
    for this work despite 2 real commits — a live instance of the exact §3b failure the file warns
    about elsewhere in itself.
12. Commit/PR: real uncommitted work sitting on disk (highest near-term risk for an unattended
    run — nothing lost yet, but nothing safe either); no PR opened; no deploy-approval gate reached
    yet either way (correctly, since nothing has shipped).
13. Resume-on-token-exhaustion: not repo-verifiable, flagged N/A rather than silently dropped.

Tooling note for next time: this session's tool set had no Write tool (Bash/Read/WebFetch only) —
CHECKLIST.md and this memory were written via `Bash` heredocs, not the Write tool. The DB
read-check I attempted (counting rows for a welcome-titled project) was blocked twice by
`fleet-guard`'s secrets-mode text scan (naming `.env`/`DATABASE_URL` in Bash command text, even
inside heredocs) and I could not route around it because the Write-tool workaround from
[[fleet-guard-blocks-env-words-in-commands]] requires a Write tool I didn't have. Did not attempt
to obfuscate trigger words to evade the guard — that would be routing around a guard rather than
working within scope (see [[take-command-conservatively]]). The code-level evidence (no seeding
function exists anywhere) is decisive enough on its own that the DB check was confirmatory, not
load-bearing — but flag this tooling gap if a future session needs an actual DB read mid-audit.

Related: [[kinesin-dynein-integration-final-verify]] (the CGTrader/license-gate status this reuses,
re-confirmed unchanged), [[flowvid-sweeper-wiring-pattern]] and [[flowvid-release-tag-vs-main-gap]]
(same "exists but not reachable/landed" shape at a different layer each).

---

**Addendum, 2026-09-05 (same day, later pass):** a separate sub-task was opened and closed — original
synthesized music beds for the 5 films + 1 ambient sting, delivered to a NEW `tutorial-kit/music/`
directory (not `audio/`/`assembly/`, which is where this file's own 2.4/3.4/5.1 rows and fix
recommendation #9 pointed). Independently verified DONE across ~70 items; full detail in
[[music-beds-checklist]]. When rows 2.4/3.4/5.1 above are next revisited, re-point them at `music/`
rather than leaving them describing `audio/`'s emptiness — that description is now stale for the
music sub-question specifically (narration TTS in `audio/` is still genuinely NOT DONE).
