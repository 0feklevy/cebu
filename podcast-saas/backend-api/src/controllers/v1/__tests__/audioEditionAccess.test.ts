/**
 * P3-B / A2.1 — who may hear a project's audio edition.
 *
 * One rule, and it is the whole reason this file exists: an edition is a DERIVED form of a
 * project, so it is exactly as public as that project is and never more. That sounds too obvious
 * to test, which is precisely why it is worth testing — this codebase has already made the
 * inverse mistake twice. `podcasts/` was modelled as a public storage prefix for immutable studio
 * clips; user source documents were added to it later and became readable by anyone holding the
 * URL, with no credential (security-016).
 *
 * The failure mode has no symptom. A private project whose audio is world-readable serves every
 * request successfully, logs nothing unusual, and is discovered only when someone reports it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = {
  project: null as Record<string, unknown> | null,
  edition: null as Record<string, unknown> | null,
  enqueued: [] as Array<{ name: string; payload: unknown }>,
};

vi.mock('../../../db/index.js', () => ({
  db: {
    query: {
      projects: { findFirst: async () => state.project },
      project_audio_editions: { findFirst: async () => state.edition },
      video_files: { findMany: async () => [{ storage_key: 'k', duration_sec: 10 }] },
    },
  },
}));
vi.mock('../../../db/schema.js', () => ({
  project_audio_editions: { project_id: 'project_id', language: 'language' },
  projects: { id: 'id' },
  video_files: { project_id: 'project_id' },
}));
vi.mock('drizzle-orm', () => ({ and: vi.fn(() => ({})), eq: vi.fn(() => ({})), isNull: vi.fn(() => ({})) }));
vi.mock('../../../middleware/firebase-auth.js', () => ({
  firebaseAuthMiddleware: vi.fn(),
  firebaseAuthOptionalMiddleware: vi.fn(),
}));
vi.mock('../../../lib/uuidParam.js', () => ({ requireUuidParams: () => vi.fn() }));
vi.mock('../../../services/collabAccess.js', () => ({
  editableProject: async () => (state.project?.editable ? state.project : null),
}));
vi.mock('../../../services/storage/getStorageAdapter.js', () => ({
  getStorageAdapter: () => ({ getPresignedDownloadUrl: async (k: string) => `https://signed.example/${k}` }),
}));
vi.mock('../../../queue/index.js', () => ({
  enqueueJob: (name: string, payload: unknown) => { state.enqueued.push({ name, payload }); },
}));

const { registerAudioEditionRoutes } = await import('../audioEdition.controller.js');

interface Captured { code: number; body: unknown; headers: Record<string, string> }

/** Register the routes, then invoke one by method+path. */
async function call(
  method: 'GET' | 'POST',
  path: string,
  opts: { user?: { id: string } | null; query?: Record<string, string>; body?: unknown } = {},
): Promise<Captured> {
  const routes: Array<{ method: string; path: string; handler: (req: unknown, reply: unknown) => Promise<unknown> }> = [];
  const app = {
    get: (p: string, _o: unknown, h: never) => routes.push({ method: 'GET', path: p, handler: h }),
    post: (p: string, _o: unknown, h: never) => routes.push({ method: 'POST', path: p, handler: h }),
  };
  await registerAudioEditionRoutes(app as never);

  const route = routes.find((r) => r.method === method && r.path === path);
  if (!route) throw new Error(`no ${method} ${path} route is registered`);

  const captured: Captured = { code: 200, body: undefined, headers: {} };
  const reply = {
    code(c: number) { captured.code = c; return reply; },
    header(k: string, v: string) { captured.headers[k] = v; return reply; },
    send(b: unknown) { captured.body = b; return reply; },
  };
  await route.handler(
    { params: { id: 'p1' }, query: opts.query ?? {}, body: opts.body, dbUser: opts.user ?? null },
    reply,
  );
  return captured;
}

const READY_EDITION = {
  status: 'ready', m4a_key: 'editions/p1/source-abc.m4a', duration_ms: 1000,
  chapters_json: [], captions_vtt: 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhi\n',
  language: null, error: null, updated_at: new Date(0),
};

beforeEach(() => {
  state.project = null;
  state.edition = null;
  state.enqueued = [];
});

describe('an edition is exactly as public as its project', () => {
  it('serves a PUBLIC project’s audio to an anonymous listener', () => {
    state.project = { id: 'p1', visibility: 'public', created_by: 'owner' };
    state.edition = READY_EDITION;
    return call('GET', '/api/v1/projects/:id/audio').then((r) => {
      expect(r.code).toBe(200);
      expect((r.body as { audio_url: string }).audio_url).toContain('editions/p1/');
    });
  });

  it('does NOT serve a private project’s audio to a stranger', async () => {
    // The whole file. This request succeeding is the security-016 shape exactly: a successful
    // response, a normal log line, and a customer's content readable by anyone with the URL.
    state.project = { id: 'p1', visibility: 'private', created_by: 'owner' };
    state.edition = READY_EDITION;
    const r = await call('GET', '/api/v1/projects/:id/audio', { user: { id: 'someone-else' } });
    expect(r.code, 'a private project’s audio was served to a stranger').toBe(404);
    expect((r.body as { audio_url?: string }).audio_url).toBeUndefined();
  });

  it('answers 404, not 403, so existence is not leaked', async () => {
    // To an unauthorised requester, "there IS audio here but you may not have it" is itself
    // information about a private project.
    state.project = { id: 'p1', visibility: 'private', created_by: 'owner' };
    state.edition = READY_EDITION;
    expect((await call('GET', '/api/v1/projects/:id/audio', { user: { id: 'x' } })).code).toBe(404);
  });

  it('serves the owner their own private project’s audio', async () => {
    state.project = { id: 'p1', visibility: 'private', created_by: 'owner' };
    state.edition = READY_EDITION;
    const r = await call('GET', '/api/v1/projects/:id/audio', { user: { id: 'owner' } });
    expect(r.code).toBe(200);
  });

  it('honours the same share token the rest of the mini-site does', async () => {
    // A shared-but-private project's audio link has to work for the people the creator gave it
    // to, or "share" means something different on this surface than everywhere else.
    state.project = { id: 'p1', visibility: 'private', created_by: 'owner', share_token: 'tok' };
    state.edition = READY_EDITION;
    expect((await call('GET', '/api/v1/projects/:id/audio', { query: { share: 'tok' } })).code).toBe(200);
    expect((await call('GET', '/api/v1/projects/:id/audio', { query: { share: 'wrong' } })).code).toBe(404);
  });

  it('applies the identical rule to the captions track', async () => {
    // A caption file is a transcript. Leaking it leaks the lesson's content just as surely as
    // leaking the audio, and it is the kind of route that gets access checks added last.
    state.project = { id: 'p1', visibility: 'private', created_by: 'owner' };
    state.edition = READY_EDITION;
    const r = await call('GET', '/api/v1/projects/:id/audio/captions.vtt', { user: { id: 'stranger' } });
    expect(r.code, 'the transcript was served to a stranger').toBe(404);
  });

  it('serves captions as text/vtt, or the browser silently ignores the track', async () => {
    state.project = { id: 'p1', visibility: 'public', created_by: 'owner' };
    state.edition = READY_EDITION;
    const r = await call('GET', '/api/v1/projects/:id/audio/captions.vtt');
    expect(r.headers['content-type']).toContain('text/vtt');
  });
});

describe('an edition that is not ready yet', () => {
  it('reports a status rather than a broken URL', async () => {
    state.project = { id: 'p1', visibility: 'public', created_by: 'owner' };
    state.edition = { status: 'processing', m4a_key: null, error: null };
    const r = await call('GET', '/api/v1/projects/:id/audio');
    expect(r.code).toBe(200);
    expect(r.body).toMatchObject({ status: 'processing', audio_url: null, chapters: [] });
  });

  it('reports "none" when no edition has ever been built', async () => {
    state.project = { id: 'p1', visibility: 'public', created_by: 'owner' };
    const r = await call('GET', '/api/v1/projects/:id/audio');
    expect(r.body).toMatchObject({ status: 'none', audio_url: null });
  });

  it('never hands out a URL for a FAILED edition', async () => {
    // The key may still be set from a previous successful build; the status is what decides.
    state.project = { id: 'p1', visibility: 'public', created_by: 'owner' };
    state.edition = { status: 'failed', m4a_key: 'editions/p1/old.m4a', error: 'ffmpeg exploded' };
    const r = await call('GET', '/api/v1/projects/:id/audio');
    expect((r.body as { audio_url: null }).audio_url).toBeNull();
    expect((r.body as { error: string }).error).toBe('ffmpeg exploded');
  });
});

describe('building costs money, so building needs edit rights', () => {
  it('refuses a viewer who is not an editor', async () => {
    // A route any viewer could trigger is a route any viewer could use to spend the owner's
    // compute by reloading a page.
    state.project = { id: 'p1', visibility: 'public', created_by: 'owner', editable: false };
    const r = await call('POST', '/api/v1/projects/:id/audio', { user: { id: 'viewer' }, body: {} });
    expect(r.code).toBe(404);
    expect(state.enqueued, 'a non-editor queued work').toEqual([]);
  });

  it('refuses an anonymous caller outright', async () => {
    state.project = { id: 'p1', visibility: 'public', created_by: 'owner', editable: true };
    const r = await call('POST', '/api/v1/projects/:id/audio', { user: null, body: {} });
    expect(r.code).toBe(401);
    expect(state.enqueued).toEqual([]);
  });

  it('queues the work for an editor and answers 202, not 200', async () => {
    // 202 is the honest code: the work is accepted, not done. A 200 with no artifact behind it
    // is what makes a client stop polling and show a broken player.
    state.project = { id: 'p1', visibility: 'public', created_by: 'owner', editable: true };
    const r = await call('POST', '/api/v1/projects/:id/audio', { user: { id: 'owner' }, body: { language: 'he' } });
    expect(r.code).toBe(202);
    expect(state.enqueued).toEqual([
      { name: 'audio_edition', payload: { projectId: 'p1', language: 'he', force: false } },
    ]);
  });

  it('normalises a blank language to null — the source edition', async () => {
    // `''` and `null` must not become two different editions of the same audio, each with its own
    // row and its own object in the bucket.
    state.project = { id: 'p1', visibility: 'public', created_by: 'owner', editable: true };
    await call('POST', '/api/v1/projects/:id/audio', { user: { id: 'owner' }, body: { language: '  ' } });
    expect((state.enqueued[0].payload as { language: null }).language).toBeNull();
  });
});
