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
 * Hosts that charge money. Listing them by NAME rather than looking for an "api key" pattern is
 * deliberate: a key can be read for a free endpoint, and what matters here is the invoice.
 */
const PAID_VENDOR_HOSTS = [
  'api.elevenlabs.io',
  'api.anthropic.com',
  'api.openai.com',
  'api.groq.com',
  'generativelanguage.googleapis.com',
  'api.anam.ai',
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
];

/**
 * Modules that touch a paid HOST but only on a FREE endpoint.
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
const FREE_ENDPOINT_ONLY = [
  // GET /v1/user — key validation on save. No credits.
  'controllers/admin/v1/llm-config.controller.ts',
];

/**
 * KNOWN GAPS, 2026-08-23. Every line is money leaving the account with no row behind it.
 *
 * Ordered by what they cost. The renderer synthesises a whole episode; the preview and re-voice
 * paths synthesise once per click, which is unbounded by construction and is the shape of the
 * burn that prompted this file.
 */
const UNMETERED_TODAY = [
  // ── The speech-synthesis paths. This is where the 22 August money went. ────────────────────
  // `PodcastRenderer` came OFF this list once it started metering: every synthesis, retries
  // included, is counted and one row is written per render — in `finally`, so a render that dies
  // halfway is not recorded as free.
  'services/podcast/audio/chunker.ts',           // splits a turn, then synthesises each piece
  'controllers/v1/podcast.controller.ts',

  // ── The Anam avatar surface. Some of these only READ (listing or fingerprinting a persona),
  // which costs nothing — but nothing in the code says which, and "probably free" is exactly the
  // assumption this file exists to stop making. They stay listed until each is checked.
  'controllers/admin/v1/avatar.controller.ts',
  'services/avatar/displayIdentity.ts',
  'services/avatar/personaBake.ts',
  'services/avatar/personaFingerprint.ts',
  'services/transcriptPropagation.ts',
  'scripts/tag-circle-voices.ts',                // an operator script, and it still spends
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
    for (const m of text.matchAll(/from\s+'(\.[^']+)'/g)) {
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
  if (FREE_ENDPOINT_ONLY.includes(client)) return [];
  if (!METERED_BY_CALLER.includes(client)) {
    return g.meters.has(client) ? [] : [client];
  }
  const callers = [...new Set(g.importers.get(client) ?? [])];
  return callers.filter((c) => !g.meters.has(c)).sort();
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
    for (const p of [...UNMETERED_TODAY, ...METERED_BY_CALLER, ...FREE_ENDPOINT_ONLY]) {
      expect(() => statSync(join(SRC, p)), `${p} does not exist`).not.toThrow();
    }
  });
});

describe('what the gap costs, stated rather than implied', () => {
  it('keeps the podcast renderer OUT of the gap list — it is metered now', () => {
    // It used to be the largest line on this list: a whole episode of synthesis with no row behind
    // it. It meters every call including the three retry paths, and writes one row per render in
    // `finally`, so a render that dies halfway is not recorded as free. Asserted from the other
    // side now: putting it back on the list means the metering was removed.
    expect(UNMETERED_TODAY).not.toContain('services/podcast/audio/PodcastRenderer.ts');
  });

  it('keeps the per-click synthesis paths OUT of the list — they meter now', () => {
    // Previously the loudest entries here, and described as "one synthesis per click, unbounded".
    // BOTH HALVES OF THAT WERE WRONG in the same direction: they are cached by a hash over the
    // inputs, the seed and the format, so re-listening to an unchanged line costs nothing. What
    // costs is editing a line and listening again — real, and invisible until they metered, but
    // never unbounded. Recorded here rather than quietly dropped, because the first version of
    // this file was written from the overstatement.
    expect(UNMETERED_TODAY).not.toContain('services/podcast/audio/previewTurn.ts');
    expect(UNMETERED_TODAY).not.toContain('services/podcast/audio/revoiceTurn.ts');
  });

  it('keeps guidance publishing out too', () => {
    // Accumulates across the cues it actually synthesises — the unchanged ones hit a cue-level
    // cache and never reach the vendor — and writes one row per publish.
    expect(UNMETERED_TODAY).not.toContain('services/simulation/GuidanceService.ts');
  });

  it('shrinks — the list is smaller than the day it was written', () => {
    // Thirteen on 2026-08-23. A ratchet whose number never moves is a list, not a ratchet.
    expect(UNMETERED_TODAY.length).toBeLessThan(9);
  });
});
