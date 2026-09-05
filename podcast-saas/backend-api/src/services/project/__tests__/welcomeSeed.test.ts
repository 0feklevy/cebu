/**
 * Welcome seeding (085) — what stops it from ever running by accident, and what makes it
 * safe when it does. The expensive mistakes here are all silent: seeding with the flag off
 * (every signup clones a project nobody asked for), double-seeding a user, seeding the
 * template's own author, or copying the heavy bytes per user.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = {
  user: { id: 'u1', welcome_project_id: null, welcome_playlist_id: null } as Record<string, unknown> | undefined,
  template: { id: 'tpl', created_by: 'system-user', title: 'Welcome to Flow Video' } as Record<string, unknown> | undefined,
  orphan: undefined as Record<string, unknown> | undefined,
  settings: { welcome_seed_enabled: false } as Record<string, unknown> | undefined,
  templatePlaylist: undefined as Record<string, unknown> | undefined,
  playlistItems: [] as Array<Record<string, unknown>>,
  userUpdates: [] as Array<Record<string, unknown>>,
  playlistInserts: [] as Array<Record<string, unknown>>,
  itemInserts: [] as Array<Record<string, unknown>>,
  // The projects.findFirst fake serves two different lookups (template by id, then the orphan
  // scan); this ping-pong marker says which answer is next.
  pendingProjectLookup: 'template' as 'template' | 'orphan',
};

vi.mock('../../../db/index.js', () => ({
  db: {
    query: {
      users: { findFirst: async () => state.user },
      projects: {
        findFirst: async (q: { where?: unknown } = {}) => {
          // Two different lookups arrive here: by template id, and by (created_by, is_welcome_seed).
          // The fake distinguishes them by which fixture the test armed.
          if (state.pendingProjectLookup === 'template') { state.pendingProjectLookup = 'orphan'; return state.template; }
          state.pendingProjectLookup = 'template';
          return state.orphan;
        },
      },
      admin_settings: { findFirst: async () => state.settings },
      playlists: { findFirst: async () => state.templatePlaylist },
    },
    select: () => ({ from: () => ({ where: async () => state.playlistItems }) }),
    insert: (table: { _name?: string }) => ({
      values: (v: Record<string, unknown> | Array<Record<string, unknown>>) => {
        const arr = Array.isArray(v) ? v : [v];
        if ('autoplay' in arr[0]) { state.playlistInserts.push(...arr); return { returning: async () => [{ id: 'pl-new' }] }; }
        state.itemInserts.push(...arr);
        return { returning: async () => arr };
      },
    }),
    update: () => ({ set: (p: Record<string, unknown>) => ({ where: async () => { state.userUpdates.push(p); return []; } }) }),
  },
}));
vi.mock('../../../db/schema.js', () => ({
  users: { id: 'id', welcome_project_id: 'welcome_project_id', welcome_playlist_id: 'welcome_playlist_id' },
  projects: { id: 'id', created_by: 'created_by', is_welcome_seed: 'is_welcome_seed' },
  playlists: { id: 'id' },
  playlist_items: { playlist_id: 'playlist_id', position: 'position' },
  admin_settings: {},
}));
vi.mock('drizzle-orm', () => ({
  and: vi.fn(() => ({})), eq: vi.fn(() => ({})), isNull: vi.fn(() => ({})),
}));
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../ProjectDuplicationService.js', () => ({ ProjectDuplicationService: class {} }));

const { seedWelcomeProject, __resetWelcomeSeedMemo } = await import('../WelcomeSeedService.js');

/** A duplication stub that records how it was driven. */
function fakeDup() {
  const calls: Record<string, unknown[]> = { loadSnapshot: [], buildPlan: [], copyBytes: [], retarget: [], commitRows: [] };
  return {
    calls,
    loadSnapshot: async (id: string) => { calls.loadSnapshot.push(id); return { project: state.template }; },
    buildPlan: (_s: unknown, opts: unknown) => { calls.buildPlan.push(opts); return { plan: { storage: [] }, ids: {}, posters: [] }; },
    copyBytes: async (plan: unknown) => { calls.copyBytes.push(plan); return 0; },
    retargetCopiedPackages: async () => { calls.retarget.push(1); return {}; },
    commitRows: async (_s: unknown, _p: unknown, requestedBy: string, opts: unknown) => {
      calls.commitRows.push({ requestedBy, opts });
      return 'clone-1';
    },
  };
}

const seed = (dup = fakeDup()) =>
  seedWelcomeProject({ id: 'u1', default_org_id: 'org-u1' }, { dup: dup as never }).then(() => dup);

beforeEach(() => {
  __resetWelcomeSeedMemo();
  vi.unstubAllEnvs();
  vi.stubEnv('WELCOME_TEMPLATE_PROJECT_ID', 'tpl');
  vi.stubEnv('WELCOME_SEED_ENABLED', 'true');
  vi.stubEnv('WELCOME_TEMPLATE_PLAYLIST_ID', '');
  state.user = { id: `u1-${Math.random()}`, welcome_project_id: null, welcome_playlist_id: null };
  state.template = { id: 'tpl', created_by: 'system-user', title: 'Welcome to Flow Video' };
  state.orphan = undefined;
  state.settings = { welcome_seed_enabled: false };
  state.templatePlaylist = undefined;
  state.playlistItems = [];
  state.userUpdates = [];
  state.playlistInserts = [];
  state.itemInserts = [];
  state.pendingProjectLookup = 'template';
});

describe('the gates — off means NOTHING runs', () => {
  it('does nothing without a template id', async () => {
    vi.stubEnv('WELCOME_TEMPLATE_PROJECT_ID', '');
    const dup = await seed();
    expect(dup.calls.loadSnapshot).toEqual([]);
    expect(state.userUpdates).toEqual([]);
  });

  it('does nothing when env says false — even with the admin flag on', async () => {
    vi.stubEnv('WELCOME_SEED_ENABLED', 'false');
    state.settings = { welcome_seed_enabled: true };
    const dup = await seed();
    expect(dup.calls.loadSnapshot).toEqual([]);
  });

  it('falls back to the admin flag when env is unset', async () => {
    vi.stubEnv('WELCOME_SEED_ENABLED', '');
    state.settings = { welcome_seed_enabled: true };
    const dup = await seed();
    expect(dup.calls.commitRows).toHaveLength(1);
  });

  it('never seeds a user who already has a welcome project', async () => {
    state.user = { id: 'u1', welcome_project_id: 'existing', welcome_playlist_id: null };
    const dup = await seed();
    expect(dup.calls.loadSnapshot).toEqual([]);
  });

  it("never seeds the template's own author", async () => {
    state.template = { id: 'tpl', created_by: 'u1', title: 'Welcome' };
    const dup = await seed();
    expect(dup.calls.loadSnapshot).toEqual([]);
  });
});

describe('the clone is driven in SHARE mode, into the user’s org', () => {
  it('passes shareHeavyBytes to both plan and commit, and the user org/title/stamp to commit', async () => {
    const dup = await seed();
    expect(dup.calls.buildPlan[0]).toMatchObject({ shareHeavyBytes: true });
    const commit = dup.calls.commitRows[0] as { requestedBy: string; opts: Record<string, unknown> };
    expect(commit.requestedBy).toBe('u1');
    expect(commit.opts).toMatchObject({
      shareHeavyBytes: true,
      orgId: 'org-u1',
      isWelcomeSeed: true,
      title: 'Welcome to Flow Video',
    });
  });

  it('stamps users.welcome_project_id with the clone id', async () => {
    await seed();
    expect(state.userUpdates.find((u) => u.welcome_project_id === 'clone-1')).toBeDefined();
  });

  it('adopts an orphaned clone instead of cloning again', async () => {
    state.orphan = { id: 'orphan-clone' };
    const dup = await seed();
    expect(dup.calls.loadSnapshot, 'a second clone was built for a user who already has one').toEqual([]);
    expect(state.userUpdates.find((u) => u.welcome_project_id === 'orphan-clone')).toBeDefined();
  });

  it('a duplication failure is swallowed — the auth path must never pay for it', async () => {
    const dup = fakeDup();
    dup.commitRows = async () => { throw new Error('unique index says no'); };
    await expect(seed(dup)).resolves.toBeDefined();
    expect(state.userUpdates).toEqual([]);
  });
});

describe('the playlist rides along', () => {
  it('clones the template playlist with the template project swapped for the user clone', async () => {
    vi.stubEnv('WELCOME_TEMPLATE_PLAYLIST_ID', 'tpl-pl');
    state.templatePlaylist = { id: 'tpl-pl', org_id: 'sys-org', title: 'Welcome to Flow Video', description: null, autoplay: true, show_sidebar: true, allow_shuffle: false };
    state.playlistItems = [
      { playlist_id: 'tpl-pl', project_id: 'tpl', position: 0 },
      { playlist_id: 'tpl-pl', project_id: 'film3', position: 1 },
      { playlist_id: 'tpl-pl', project_id: 'film4', position: 2 },
    ];
    await seed();
    expect(state.playlistInserts[0]).toMatchObject({ created_by: 'u1', org_id: 'org-u1', allow_shuffle: false });
    expect(state.itemInserts.map((i) => i.project_id)).toEqual(['clone-1', 'film3', 'film4']);
    expect(state.userUpdates.find((u) => u.welcome_playlist_id === 'pl-new')).toBeDefined();
  });
});
