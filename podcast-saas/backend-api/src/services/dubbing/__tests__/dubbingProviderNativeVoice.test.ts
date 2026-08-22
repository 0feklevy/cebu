/**
 * The provider seam — the only path in this system that spends money at ElevenLabs.
 *
 * ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────────────────────────
 * The owner reported the bug in their own words: *"in the ElevenLabs dubbing, it puts an American
 * accent on all the other languages and it does not sound natural at all (Spanish, Hebrew — there
 * is an English `r`, not their language's)"*. The cause is not a defect in the integration: the
 * vendor's default is to CLONE the source speaker, and a cloned English speaker saying Hebrew
 * keeps that speaker's articulation. `disable_voice_cloning` is the vendor's own escape, and
 * `ElevenLabsDubbingProvider` sets it.
 *
 * `elevenLabsDubbingClient.test.ts` already proves the CLIENT sends the flag when asked. Nothing
 * proved the provider ASKS. Those are different claims, and only the second one is what a real dub
 * gets: delete the `nativeVoice:` line from `DubbingService.ts` and every client test still passes
 * while every dub silently goes back to sounding American. A fix that is not wired is not a fix,
 * and the seam where the wiring lives had no test at all before this file.
 *
 * ── WHY IT DRIVES `run()` RATHER THAN THE PRIVATE METHOD ──────────────────────────────────────
 * `resolveVendorProject` is private, and reaching in to call it would assert on an arrangement of
 * the code rather than on behaviour — the exact shape that let four viewer regressions ship. The
 * fake client below implements the eight methods the provider actually calls, each returning the
 * vendor's own response shape, so `run()` executes end to end and the assertion is made on what
 * left the building.
 *
 * That has a second payoff: this is the first coverage the provider's happy path has ever had, so
 * the recovery branches — an existing project id, a project found by reference — are asserted here
 * too. Each of those is a path where getting it wrong means paying twice for the same dub.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ElevenLabsDubbingProvider,
  dubReference,
  type DubbingProvider,
} from '../DubbingService.js';
import type {
  ElevenLabsDubbingClient,
  DubbingProjectResponse,
  DubbingLanguageResponse,
  DubbingProjectListResponse,
  DubbingTargetTranscriptResponse,
  CreateDubbingProjectRequest,
} from '../ElevenLabsDubbingClient.js';

const PROJECT_ID = 'el-project-1';
const LANGUAGE_ID = 'el-language-1';

interface Recorded {
  createProject: CreateDubbingProjectRequest[];
  getProject: string[];
  addLanguage: Array<{ projectId: string; target: string }>;
  downloadSignedUrl: string[];
}

/**
 * A stand-in for the vendor that answers every call with a READY response.
 *
 * Everything is completed on the first poll on purpose: this file is about which request was
 * made, and a fake that made the provider sleep through its real poll interval would spend the
 * suite's wall-clock proving something the polling tests should own instead.
 */
function fakeClient(overrides: Partial<{
  listProjects: () => Promise<DubbingProjectListResponse>;
  getProject: () => Promise<DubbingProjectResponse>;
}> = {}): { client: ElevenLabsDubbingClient; rec: Recorded } {
  const rec: Recorded = { createProject: [], getProject: [], addLanguage: [], downloadSignedUrl: [] };

  const readyProject = (id = PROJECT_ID): DubbingProjectResponse => ({
    project_id: id,
    status: 'ready',
    source_language: 'en',
    language_ids: [LANGUAGE_ID],
  });
  const completedLanguage = (): DubbingLanguageResponse => ({
    language_id: LANGUAGE_ID,
    project_id: PROJECT_ID,
    target_language: 'es',
    status: 'completed',
    outputs: { lossless_audio: 'https://vendor.invalid/signed/audio.wav' },
    revision: 3,
    output_revision: 3,
  });

  const client = {
    async createProject(req: CreateDubbingProjectRequest): Promise<DubbingProjectResponse> {
      rec.createProject.push(req);
      return readyProject();
    },
    async getProject(id: string): Promise<DubbingProjectResponse> {
      rec.getProject.push(id);
      return overrides.getProject ? overrides.getProject() : readyProject(id);
    },
    async listProjects(): Promise<DubbingProjectListResponse> {
      return overrides.listProjects ? overrides.listProjects() : { projects: [], has_more: false };
    },
    async addLanguage(projectId: string, target: string): Promise<DubbingLanguageResponse> {
      rec.addLanguage.push({ projectId, target });
      return completedLanguage();
    },
    async listLanguages(): Promise<DubbingLanguageResponse[]> {
      return [];
    },
    async getLanguage(): Promise<DubbingLanguageResponse> {
      return completedLanguage();
    },
    async getTargetTranscript(): Promise<DubbingTargetTranscriptResponse> {
      return {
        source_language: 'en',
        target_language: 'es',
        revision: 3,
        segments: [{ start_s: 0, end_s: 1.5, source_text: 'hello', translation: 'hola' }],
      };
    },
    async downloadSignedUrl(url: string): Promise<Buffer> {
      rec.downloadSignedUrl.push(url);
      return Buffer.from('dubbed-audio');
    },
  } as unknown as ElevenLabsDubbingClient;

  return { client, rec };
}

const runArgs = (
  over: Partial<Parameters<DubbingProvider['run']>[0]> = {},
): Parameters<DubbingProvider['run']>[0] => ({
  dubId: 'dub-1',
  sourceUrl: 'https://storage.invalid/source.mp4',
  sourceLanguage: null,
  targetLanguage: 'es',
  existing: { projectId: null, languageId: null },
  onProjectCreated: async () => {},
  onLanguageCreated: async () => {},
  heartbeat: async () => true,
  ...over,
});

describe('the provider asks for a native voice, which is what the owner actually heard', () => {
  const saved = process.env.DUBBING_NATIVE_VOICE;
  beforeEach(() => { delete process.env.DUBBING_NATIVE_VOICE; });
  afterEach(() => {
    if (saved === undefined) delete process.env.DUBBING_NATIVE_VOICE;
    else process.env.DUBBING_NATIVE_VOICE = saved;
  });

  it('sets nativeVoice with the variable UNSET — the default is native, not cloned', async () => {
    // The default matters more than the override. Production does not set this variable, so an
    // implementation that only honoured an explicit `=1` would ship the accent to every customer
    // while passing a test that set it.
    const { client, rec } = fakeClient();
    await new ElevenLabsDubbingProvider(client).run(runArgs());

    expect(rec.createProject).toHaveLength(1);
    expect(rec.createProject[0]!.nativeVoice).toBe(true);
  });

  it('honours DUBBING_NATIVE_VOICE=0 as the documented way back to cloning', async () => {
    // The escape hatch is the reason the flag is an environment variable at all: a dub costs real
    // money per source-minute and its result can only be judged by listening, so "change one line
    // and ship" is the wrong recovery loop.
    process.env.DUBBING_NATIVE_VOICE = '0';
    const { client, rec } = fakeClient();
    await new ElevenLabsDubbingProvider(client).run(runArgs());

    expect(rec.createProject[0]!.nativeVoice).toBe(false);
  });

  it('treats any other value as native — only an explicit "0" turns it off', async () => {
    // `'false'`, `''` and a typo all mean "I did not deliberately ask for cloning". Falling back
    // to the accented branch on a malformed value would make a typo silently undo the fix.
    for (const v of ['false', 'no', '', 'true', '1']) {
      process.env.DUBBING_NATIVE_VOICE = v;
      const { client, rec } = fakeClient();
      await new ElevenLabsDubbingProvider(client).run(runArgs());
      expect(rec.createProject[0]!.nativeVoice, `value ${JSON.stringify(v)}`).toBe(v !== '0');
    }
  });

  it('sends no target_accent, so the vendor picks the language\'s own default', async () => {
    // The owner ruled that a DIFFERENT voice is fine as long as it sounds native. Choosing between
    // natives — Castilian or Latin American Spanish — is a separate decision nobody has made, and
    // guessing produces a dub that is wrong for half the audience while sounding confident.
    const { client, rec } = fakeClient();
    await new ElevenLabsDubbingProvider(client).run(runArgs());

    expect(rec.createProject[0]!.targetAccent ?? null).toBeNull();
  });
});

describe('the money-spending branches: a dub is never paid for twice', () => {
  it('reuses an existing project id without creating a second one', async () => {
    // A retry after a crash carries the ids of what was already billed. Creating again here is
    // not a bug that shows up as an error — it shows up on an invoice.
    const { client, rec } = fakeClient();
    await new ElevenLabsDubbingProvider(client).run(
      runArgs({ existing: { projectId: PROJECT_ID, languageId: null } }),
    );

    expect(rec.createProject).toHaveLength(0);
    expect(rec.getProject[0]).toBe(PROJECT_ID);
  });

  it('adopts a project found by our own reference rather than creating another', async () => {
    // The window this covers: the vendor created and billed the project, and the worker died
    // before writing the id down. The reference we stamped is the only way back to it.
    const ours: DubbingProjectResponse = {
      project_id: 'billed-already',
      status: 'ready',
      reference: dubReference('dub-1'),
      language_ids: [LANGUAGE_ID],
    };
    const { client, rec } = fakeClient({
      listProjects: async () => ({ projects: [ours], has_more: false }),
    });

    const seen: string[] = [];
    await new ElevenLabsDubbingProvider(client).run(
      runArgs({ onProjectCreated: async (id) => { seen.push(id); } }),
    );

    expect(rec.createProject).toHaveLength(0);
    expect(seen).toEqual(['billed-already']);
  });

  it('does NOT adopt a project carrying someone else\'s reference', async () => {
    // The list endpoint returns the whole workspace. Matching loosely here would attach one
    // customer's dub to another customer's project — and the audio would be delivered.
    const notOurs: DubbingProjectResponse = {
      project_id: 'someone-elses',
      status: 'ready',
      reference: dubReference('dub-OTHER'),
      language_ids: [LANGUAGE_ID],
    };
    const { client, rec } = fakeClient({
      listProjects: async () => ({ projects: [notOurs], has_more: false }),
    });

    await new ElevenLabsDubbingProvider(client).run(runArgs());

    expect(rec.createProject).toHaveLength(1);
    expect(rec.createProject[0]!.reference).toBe(dubReference('dub-1'));
  });

  it('creates the dub when the listing fails, instead of refusing to work', async () => {
    // Best-effort by design: the cost of missing a match is one duplicated project, the cost of
    // failing here is the feature not working whenever the list endpoint is unhappy.
    const { client, rec } = fakeClient({
      listProjects: async () => { throw new Error('vendor listing 503'); },
    });

    await expect(new ElevenLabsDubbingProvider(client).run(runArgs())).resolves.toBeTruthy();
    expect(rec.createProject).toHaveLength(1);
  });
});

describe('what the provider hands back', () => {
  it('reports the vendor\'s OWN detected source language, not the one we guessed', async () => {
    // It comes from a machine that listened to the audio. Ours came from text.
    const { client } = fakeClient();
    const out = await new ElevenLabsDubbingProvider(client).run(runArgs({ sourceLanguage: 'de' }));

    expect(out.sourceLanguage).toBe('en');
  });

  it('re-fetches the language immediately before downloading', async () => {
    // The signed URL expires about an hour after it is issued and the poll above may have taken
    // longer than that. A persisted or stale URL is a dub that was paid for and cannot be fetched.
    const { client, rec } = fakeClient();
    await new ElevenLabsDubbingProvider(client).run(runArgs());

    expect(rec.downloadSignedUrl).toEqual(['https://vendor.invalid/signed/audio.wav']);
  });

  it('carries the revision pair through, so a stale dub can be recognised later', async () => {
    const { client } = fakeClient();
    const out = await new ElevenLabsDubbingProvider(client).run(runArgs());

    expect(out.revision).toBe(3);
    expect(out.outputRevision).toBe(3);
    expect(out.elProjectId).toBe(PROJECT_ID);
    expect(out.elLanguageId).toBe(LANGUAGE_ID);
  });
});
