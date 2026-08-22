/**
 * EVERY PAID VENDOR CALL LEAVES A RECORD — the contract, and the list of places it does not yet.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────────────────────────
 * On 22 August 2026 four ElevenLabs Auto Top-Up invoices fired in three and a half hours, and
 * nothing in this product could say what bought them. The owner ranked spend visibility above all
 * routine work the next morning. The first thing that has to be true is not a dashboard — it is
 * that the data behind one exists at all.
 *
 * `token_usage` is written from fourteen modules and covers the LLM providers, dubbing, avatar and
 * video generation. It does not cover the podcast renderer's speech synthesis, nor the preview and
 * re-voice paths, which synthesise once per CLICK. A dashboard built today would show a confident,
 * incomplete number — which is worse than showing nothing, because a number gets believed.
 *
 * ── A RATCHET, NOT A CLEAN ASSERTION ──────────────────────────────────────────────────────────
 * Wiring metering through six paths is real work with real decisions in it (TTS bills per
 * character, dubbing per source-minute, and neither is a "token"). Demanding all of it today means
 * a red suite on day one, and a red suite on day one is a suite people learn to skip. So the rule
 * is the same one the env-var contract and the typecheck ratchet use: NOTHING NEW GETS WORSE.
 *
 *   • a module that reaches a paid vendor host and is not on the list below must record usage
 *   • the list is expected only to shrink
 *   • an entry naming a module that no longer calls a vendor fails, because a stale allow-list
 *     makes the gap look bigger than it is, and that is how ratchets stop being trusted
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * How a module reaches a vendor that charges — by hostname, or by the vendor's own SDK.
 *
 * Listed by NAME rather than by an "api key" pattern, deliberately: a key can be read for a free
 * endpoint, and what matters here is the invoice.
 */
const PAID_VENDOR_HOSTS = [
  'api.elevenlabs.io',
  'api.anthropic.com',
  'api.openai.com',
  'api.groq.com',
  'generativelanguage.googleapis.com',
  'api.anam.ai',

  // ── AND THE SDKs, WHICH THE HOST LIST COULD NOT SEE ───────────────────────────────────────
  // A whole class of spend was invisible while this list held only URLs: a module using the
  // vendor's own package never types the hostname. `groq-sdk` is speech-to-text billed per audio
  // minute, `openai` covers image generation billed per image, and the LLM SDKs are the largest
  // recurring spend in the product.
  //
  // Found while checking whether the gap list could honestly be called empty. It could not, and
  // the difference between "no gaps" and "no gaps I can see" is the whole value of this file.
  "from 'groq-sdk'",
  "from '@anthropic-ai/sdk'",
  "from 'openai'",
  "from '@google/genai'",
];

/**
 * The ways this codebase records a billable event — matched as CALLS, not as names.
 *
 * The first version matched `UsageTrackingService` anywhere in a file, so deleting the call and
 * leaving the import behind kept it green. Mutation-testing found that; it is the same failure as
 * a mask that matches text instead of behaviour.
 *
 * FOUR SHAPES, because there are four. A module may call `.record(` itself, use the shared
 * `recordTtsSpend(` helper, insert into the table directly, or CONSTRUCT the recorder and hand it
 * to a service that writes — `new LLMService(new ApiKeyService(), new UsageTrackingService())` is
 * metering, and the stricter pattern flagged three modules doing exactly that before this line
 * accounted for it. A rule that calls correct code a gap trains people to silence it.
 *
 * Still a text match, and still limited — a call in dead code would satisfy it — which is why
 * `renderSpendMetering.test.ts` asserts the renderer's accounting by behaviour. The job here is
 * narrower: catch a module that reaches a paid vendor and never reaches a recorder at all.
 */
const RECORDS_USAGE =
  /\.record\(|insert\(token_usage\)|recordUsage\(|trackUsage\(|recordTtsSpend\(|new UsageTrackingService\(/;

/**
 * Modules that call a paid vendor and DO NOT record usage themselves — because their caller does.
 *
 * A client wrapper is not the right place to meter: it does not know the user, the project, or
 * which of several callers is spending. `ElevenLabsDubbingClient` is metered by `DubbingService`,
 * `anamService` by the avatar controller, `VideoGenerationService` by the video-generate job.
 */
const METERED_BY_CALLER = [
  'services/dubbing/ElevenLabsDubbingClient.ts',
  'services/avatar/anamService.ts',
  'services/video-generation/VideoGenerationService.ts',
  'services/podcast/audio/ElevenLabsDialogue.ts',
  'services/podcast/PodcastVoiceService.ts',
  'services/audio/GuidanceTTSService.ts',
  // The three LLM provider wrappers. `LLMService` constructs them and records every call, with the
  // token counts and the model — which is exactly the context a provider wrapper does not have.
  'services/llm/ClaudeProvider.ts',
  'services/llm/GeminiProvider.ts',
  'services/llm/OpenAIProvider.ts',
];

/**
 * Modules that reach a paid vendor's code but never a BILLABLE operation.
 *
 * Two shapes live here and the name covers both: a free ENDPOINT on a paid host, and an import
 * that reaches no vendor call at all. Renamed from `FREE_ENDPOINT_ONLY` when the second kind
 * arrived, because a list whose name describes only half its contents is where wrong entries get
 * added without anyone noticing.
 *
 * This file's own header says a key can be read for a free endpoint and that what matters is the
 * invoice — and then the first strict run flagged exactly that. `llm-config.controller` validates
 * a pasted ElevenLabs key with `GET /v1/user`, which returns the account and consumes no credits.
 * Metering it would put a $0.00 row in the spend surface every time an operator saves a key.
 *
 * Every entry names the endpoint, because "it is probably free" is the assumption this whole file
 * exists to stop making. If a vendor starts charging for one, the entry is where that gets
 * re-opened.
 */
const NO_BILLABLE_CALL = [
  // GET /v1/user — key validation on save. No credits.
  'controllers/admin/v1/llm-config.controller.ts',

  // ── ANAM PERSONA CONFIGURATION ────────────────────────────────────────────────────────────
  // Anam bills SESSION MINUTES, and this product's own billing model enumerates the ops that
  // cost: `start`, `visual`, `image`, `memory` (`usage/avatarBudget.ts`). Persona CRUD is not
  // among them — `upsertVideoPersona`, `getPersona` and `peekAvatarLook` configure a character
  // that costs nothing until somebody talks to it, and the talking is metered by
  // `controllers/v1/avatar.controller.ts`.
  //
  // DERIVED FROM OUR MODEL, NOT FROM AN INVOICE. If an Anam bill ever shows a line for persona
  // writes, this block is where the argument re-opens — which is the point of writing the
  // reasoning down instead of deleting the entries.
  'services/avatar/displayIdentity.ts',
  'services/avatar/personaBake.ts',
  'services/transcriptPropagation.ts',
  // Imports `isAnamConfigured`, a LOCAL predicate over environment variables. No vendor call at
  // all — the import graph cannot see the difference between importing a module and calling the
  // part of it that spends.
  'controllers/admin/v1/avatar.controller.ts',
];

/**
 * KNOWN GAPS, 2026-08-23. Every line is money leaving the account with no row behind it.
 *
 * Ordered by what they cost. The renderer synthesises a whole episode; the preview and re-voice
 * paths synthesise once per click, which is unbounded by construction and is the shape of the
 * burn that prompted this file.
 */
const UNMETERED_TODAY = [
  'controllers/v1/podcast.controller.ts',

  // ── FOUND BY LOOKING FOR SDKs, NOT HOSTNAMES ──────────────────────────────────────────────
  // None of these types a vendor URL, so the original host-only scan could not see any of them.
  // They were not "known gaps" that had been triaged and deferred — they were invisible, which is
  // worse, and they are the reason the list grew when it looked ready to reach zero.
  //
  // Speech-to-text, billed per minute of AUDIO. `AudioIngester` is the one that matters most:
  // it runs inside corpus ingest, which is now on a durable queue with a retry — so a failure
  // after transcription costs a second transcription, and nothing records either.
  'services/captions/CaptionService.ts',
  'services/captions/transcribeAudioFile.ts',
  'services/ingestion/AudioIngester.ts',

  // Image generation, billed per IMAGE. A unit `token_usage` can already express (migration 073),
  // which is what makes these the cheapest of the remaining gaps to close.
  'services/generateAiThumbnail.ts',
  'services/avatar/imageService.ts',

  // OpenAI text, on the metadata path.
  'services/generateVideoMetadata.ts',
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules' || entry === '_archive') continue;
      out.push(...walk(full));
    } else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

const rel = (abs: string): string => relative(SRC, abs).split('\\').join('/');

/**
 * ── WHY THIS FOLLOWS IMPORTS INSTEAD OF GREPPING FOR A HOSTNAME ───────────────────────────────
 * The first version of this file matched modules containing `api.elevenlabs.io`. It found the
 * CLIENTS and missed every SPENDER: `PodcastRenderer` synthesises a whole episode and does not
 * contain the string, because it spends through `ElevenLabsDialogue`. Its own stale-entry check
 * caught that, which is the only reason this is not a green file asserting nothing.
 *
 * Spend is a property of the CALL GRAPH. A module spends money if it can reach a vendor client
 * through imports, and the question this file asks is whether somebody on that path records it.
 */
interface Graph {
  files: string[];
  importers: Map<string, string[]>;
  paid: Set<string>;
  meters: Set<string>;
}

function buildGraph(): Graph {
  const files = walk(SRC).map(rel);
  const importers = new Map<string, string[]>();
  const paid = new Set<string>();
  const meters = new Set<string>();
  const bySpecifier = new Map<string, string>();
  for (const f of files) bySpecifier.set(f.replace(/\.ts$/, ''), f);

  for (const f of files) {
    const text = readFileSync(join(SRC, f), 'utf8');
    if (PAID_VENDOR_HOSTS.some((host) => text.includes(host))) paid.add(f);
    if (RECORDS_USAGE.test(text)) meters.add(f);

    // Relative imports only. A package import cannot be a module of ours, and resolving one would
    // add a dependency on the module graph of node_modules for no gain.
    //
    // TYPE IMPORTS ARE STRIPPED FIRST. `import type` is erased at compile time and cannot make a
    // network call — `scripts/tag-circle-voices.ts` imports one interface from the Anam client and
    // was flagged as an unmetered spender for it. Counting an erased edge is not conservatism, it
    // is a false positive, and false positives are what teach people to add allow-list entries to
    // silence a gate.
    const runtimeText = text.replace(/import\s+type\s+[^;]*?;/g, '');
    for (const m of runtimeText.matchAll(/from\s+'(\.[^']+)'/g)) {
      const spec = m[1]!.replace(/\.js$/, '');
      const abs = join(dirname(join(SRC, f)), spec);
      const target = bySpecifier.get(rel(abs)) ?? bySpecifier.get(`${rel(abs)}/index`);
      if (!target) continue;
      importers.set(target, [...(importers.get(target) ?? []), f]);
    }
  }
  return { files, importers, paid, meters };
}

/**
 * Is this module's spending recorded by somebody?
 *
 * A client is covered when every module that imports it is covered, and a module is covered when
 * it meters. Walking UP the importers is what makes the answer actionable: the failure names the
 * caller that has to change, not the client, and metering inside a shared client is the wrong
 * answer anyway — it does not know the user, the project, or which caller is spending.
 *
 * A paid module with NO importers is a leaf nobody calls; it spends nothing until someone does.
 */
/**
 * Who has to record this client's spending, and are they doing it?
 *
 * TWO KINDS OF PAID MODULE, and conflating them produced a useless answer twice. A module that
 * IS the spend site — a controller synthesising audio on a route — must meter itself; walking up
 * from it reports `server.ts`, which registers routes and spends nothing. A WRAPPER shared by
 * several callers must NOT meter itself: it does not know the user, the project, or which caller
 * is spending, so the obligation belongs one level up and the answer names those callers.
 *
 * `METERED_BY_CALLER` is that distinction, written down. Everything else is its own spend site.
 *
 * Depth one, deliberately. The direct caller of a vendor client is the last place that still has
 * the context a usage row needs; anything further up has lost it.
 */
function unmeteredFor(g: Graph, client: string): string[] {
  if (NO_BILLABLE_CALL.includes(client)) return [];
  if (!METERED_BY_CALLER.includes(client)) {
    return g.meters.has(client) ? [] : [client];
  }
  const callers = [...new Set(g.importers.get(client) ?? [])];
  // The exemption applies to CALLERS too, not only to clients. `anamService` is metered by its
  // caller, and most of its callers only configure a persona — which this product's own billing
  // model says costs nothing. Exempting the client alone would have left them looking unmetered.
  return callers.filter((c) => !g.meters.has(c) && !NO_BILLABLE_CALL.includes(c)).sort();
}

describe('every module that spends money is accounted for', () => {
  const g = buildGraph();

  it('finds the vendor clients at all — the scan must not silently match nothing', () => {
    // The failure that would make every other assertion here vacuous: a moved directory or a
    // changed host string turns the whole file into a green no-op.
    expect(g.paid.size, 'the paid-vendor scan matched nothing — host list or SRC path drifted')
      .toBeGreaterThan(4);
    expect([...g.paid], 'the ElevenLabs dubbing client is the canonical call site')
      .toContain('services/dubbing/ElevenLabsDubbingClient.ts');
  });

  it('resolves the import graph — a spender must be reachable from its client', () => {
    // Proves the graph is wired before it is trusted: PodcastRenderer contains no vendor host and
    // must still be found as a caller of the dialogue client.
    const callers = g.importers.get('services/podcast/audio/ElevenLabsDialogue.ts') ?? [];
    expect(callers, 'the import scan did not resolve the dialogue client\'s callers')
      .toContain('services/podcast/audio/PodcastRenderer.ts');
  });

  it('records usage somewhere on every path from a paid client to its callers', () => {
    const offenders = new Set<string>();
    for (const client of g.paid) {
      for (const caller of unmeteredFor(g, client)) {
        if (!UNMETERED_TODAY.includes(caller)) offenders.add(caller);
      }
    }
    expect(
      [...offenders].sort(),
      'these reach a paid vendor and nothing on the path records it — meter them, or add them to ' +
      `UNMETERED_TODAY with a reason: ${[...offenders].join(', ')}`,
    ).toEqual([]);
  });

  it('has no stale entries — a gap list that over-reports stops being trusted', () => {
    const stillUncovered = new Set<string>();
    for (const client of g.paid) {
      for (const caller of unmeteredFor(g, client)) stillUncovered.add(caller);
    }
    const stale = UNMETERED_TODAY.filter((p) => !stillUncovered.has(p));
    expect(stale, `these are metered now — delete the entries: ${stale.join(', ')}`).toEqual([]);
  });

  it('keeps every listed path pointed at a real file', () => {
    for (const p of [...UNMETERED_TODAY, ...METERED_BY_CALLER, ...NO_BILLABLE_CALL]) {
      expect(() => statSync(join(SRC, p)), `${p} does not exist`).not.toThrow();
    }
  });
});

describe('what the gap costs, stated rather than implied', () => {
  it('keeps every metered path OFF the list', () => {
    // Six came off by being metered: the renderer, the two per-click preview paths, guidance
    // publishing and sound-effect generation. Putting one back means its metering was removed.
    for (const closed of [
      'services/podcast/audio/PodcastRenderer.ts',
      'services/podcast/audio/previewTurn.ts',
      'services/podcast/audio/revoiceTurn.ts',
      'services/simulation/GuidanceService.ts',
      'controllers/v1/audio.controller.ts',
    ]) {
      expect(UNMETERED_TODAY, closed).not.toContain(closed);
    }
  });

  it('names the speech-to-text paths, which are billed per minute of AUDIO', () => {
    // The most expensive of the remaining gaps, and the ones the host-only scan could not see at
    // all. `AudioIngester` runs inside corpus ingest, which is on a durable queue with a retry —
    // so a failure after transcription buys a second transcription and neither is recorded.
    expect(UNMETERED_TODAY).toContain('services/ingestion/AudioIngester.ts');
    expect(UNMETERED_TODAY).toContain('services/captions/CaptionService.ts');
  });

  it('names the image-generation paths, billed per image', () => {
    expect(UNMETERED_TODAY).toContain('services/generateAiThumbnail.ts');
    expect(UNMETERED_TODAY).toContain('services/avatar/imageService.ts');
  });

  it('is honest that the list GREW when the scan got sharper', () => {
    // It stood at one entry and looked ready to reach zero. Then the SDK patterns went in and six
    // modules appeared that had never been triaged, only unseen. A ratchet is allowed to grow when
    // the measurement improves — pretending otherwise is how a gate starts flattering itself.
    expect(UNMETERED_TODAY.length).toBeGreaterThan(1);
    expect(UNMETERED_TODAY.length).toBeLessThan(8);
  });
});
