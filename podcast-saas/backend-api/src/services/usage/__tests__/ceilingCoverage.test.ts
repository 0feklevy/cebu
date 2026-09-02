/**
 * Every path that SPENDS with a ceilinged provider must CONSULT the ceiling.
 *
 * ── THE GAP THIS CLOSES, AND HOW IT WAS FOUND ─────────────────────────────────────────────────
 * `spendContract.test.ts` is a metering ratchet: it walks the import graph from every paid vendor
 * client and fails if a spend path records nothing. It says nothing about CEILINGS. So on
 * 2026-08-25 three ElevenLabs paths — previewTurn, revoiceTurn and guidance publishing — were
 * fully metered and completely unbounded, and the only thing that found them was somebody
 * grepping by hand.
 *
 * Hand-grepping is not a guarantee. A sixth ElevenLabs path added next month with metering and no
 * ceiling would ship green, and the failure would look exactly like the 22 August incident: money
 * leaving per click, recorded faithfully, stopped by nothing.
 *
 * ── WHY THIS IS SCOPED TO ELEVENLABS, AND WHY THAT IS NOT AN OVERSIGHT ────────────────────────
 * A ceiling only exists for a provider whose limit is configured, and the design deliberately
 * treats an unset limit as "no ceiling" rather than "refuse everything". Groq STT (captions,
 * transcription, corpus ingestion) is metered and has no ceiling ANYWHERE, which is a decision
 * about a materially cheaper, upload-driven provider — not a hole. Listing it as required here
 * would make this test permanently red, and a permanently-red gate is an ignored gate.
 *
 * So the rule is: for the provider that HAS a ceiling, every spending module consults it. When
 * Groq gets a ceiling, its modules join the list below and this test starts guarding them too.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Modules that spend with ElevenLabs. Each must call `evaluateSpendCeiling` before it does.
 *
 * A new one appearing means this list needs a line — which is the point: adding it is a moment
 * where somebody has to decide whether the new path is bounded.
 */
const ELEVENLABS_SPENDERS = [
  'services/podcast/audio/PodcastRenderer.ts',
  'services/podcast/audio/previewTurn.ts',
  'services/podcast/audio/revoiceTurn.ts',
  'services/simulation/GuidanceService.ts',
  // Both found BY THIS TEST on the day it was written, and neither by hand: they record through
  // `UsageTrackingService.record` rather than the `recordTtsSpend` helper, so every grep for the
  // helper name had missed them.
  'controllers/v1/audio.controller.ts',   // ElevenLabs sound-generation (SFX + music), per click
  'services/dubbing/DubbingService.ts',   // per MINUTE of video — the most expensive call here
  // The spoken answer to a listener's question (car mode, night run 2026-09-03 §4): an anonymous
  // caller, so the ceiling is consulted before every synthesis.
  'services/audio/VoiceQuestionService.ts',
];

/** Modules that reach ElevenLabs but are METERED AND BOUNDED BY THEIR CALLER, with the reason. */
const BOUNDED_BY_CALLER: Record<string, string> = {
  // Mentions the provider in comments and column notes; spends nothing.
  'db/schema.ts': 'schema definitions and comments, not a call site',
  'controllers/v1/simulations.controller.ts': 'mentions the provider in a comment; no vendor call',
  // The vendor client itself. It has no idea what it is being asked for or on whose behalf —
  // the ceiling belongs where the decision to spend is made.
  'services/podcast/audio/ElevenLabsDialogue.ts': 'vendor client; every caller checks first',
  'services/podcast/PodcastVoiceService.ts': 'voice ops driven by the render/preview paths',
  'services/audio/GuidanceTTSService.ts': 'driven by GuidanceService.publishGuidance',
  'services/dubbing/ElevenLabsDubbingClient.ts': 'dubbing has its own per-job cost gate',
};

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (['node_modules', '__tests__', 'dist'].includes(entry)) continue;
      walk(full, out);
    } else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
};

const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

/** Files that mention ElevenLabs AND record spend — i.e. plausibly spend with that provider. */
function elevenLabsSpenders(): string[] {
  const hits: string[] = [];
  for (const file of walk(SRC)) {
    const rel = relative(SRC, file).replace(/\\/g, '/');
    if (rel.startsWith('services/usage/')) continue;          // the recorders themselves
    const t = readFileSync(file, 'utf8');
    const mentionsVendor = /elevenlabs|ElevenLabs/.test(t);
    const spends = /recordTtsSpend\s*\(|usage\.record\s*\(|UsageTrackingService/.test(t);
    if (mentionsVendor && spends) hits.push(rel);
  }
  return hits.sort();
}

describe('ceiling coverage for ElevenLabs', () => {
  it('every listed spender consults the ceiling before spending', () => {
    // The assertion that would have caught previewTurn, revoiceTurn and guidance on the day they
    // were written, instead of months later by hand.
    for (const rel of ELEVENLABS_SPENDERS) {
      // The CALL, not the name: checking for the bare identifier is satisfied by an unused
      // import, and a mutation replacing the call with a literal left the import in place and
      // sailed through. `await evaluateSpendCeiling(` is the shape that actually spends nothing
      // until it answers.
      expect(read(rel), `${rel} spends with ElevenLabs and never CALLS the ceiling`)
        .toMatch(/await\s+evaluateSpendCeiling\s*\(/);
    }
  });

  // A position check was drafted here twice — "the ceiling must appear before the spend" — and
  // removed. Textual order is not call order once a file is a CLASS: `PodcastRenderer` records
  // through a helper defined above the method that guards, so both a whole-file comparison and a
  // narrower after-the-check scan called a correct file a violation. A rule that cannot
  // distinguish those cannot be trusted to fail for the right reason, and a test that cries wolf
  // gets muted — which would take the two checks that DO work down with it.
  //
  // Placement is instead pinned per path by its own suite, where the vendor doubles fail loudly
  // if reached: clickPathCeiling.test.ts and guidanceSpendMetering.test.ts assert that a refused
  // call never touches the vendor, which is the property this could only approximate.

  it('no ElevenLabs spender is missing from the list', () => {
    // The ratchet half. A new path with metering and no ceiling would otherwise ship green — and
    // would fail exactly like the 22 August incident: money per click, recorded faithfully,
    // stopped by nothing.
    const unlisted = elevenLabsSpenders()
      .filter((f) => !ELEVENLABS_SPENDERS.includes(f))
      .filter((f) => !(f in BOUNDED_BY_CALLER));
    expect(
      unlisted,
      'these reach ElevenLabs and record spend. Does the path check the ceiling first? If yes, add '
      + 'it to ELEVENLABS_SPENDERS. If it is bounded by whoever calls it, add it to '
      + `BOUNDED_BY_CALLER with the reason: ${unlisted.join(', ')}`,
    ).toEqual([]);
  });

  it('the list is not vacuous — it names files that exist and really spend', () => {
    // A guard over an empty or stale set is decoration.
    expect(ELEVENLABS_SPENDERS.length).toBeGreaterThan(3);
    for (const rel of ELEVENLABS_SPENDERS) {
      expect(() => read(rel), `${rel} is listed but does not exist`).not.toThrow();
    }
  });

  it('Groq STT is deliberately UNCEILINGED, and that is recorded rather than forgotten', () => {
    // Not a hole: a materially cheaper, upload-driven provider whose limit nobody has set. Stated
    // here so the absence is a decision somebody can revisit, not a gap nobody wrote down.
    const groqSpenders = ['services/captions/CaptionService.ts', 'services/ingestion/CorpusBuilder.ts'];
    for (const rel of groqSpenders) {
      expect(read(rel), `${rel} now has a ceiling — move it into the guarded list above`)
        .not.toContain('evaluateSpendCeiling');
    }
  });
});
