/**
 * types-005 — PATCH /projects/:id/branch/edges/:eid took `Record<string, unknown>` and copied
 * whitelisted KEYS straight into the UPDATE without ever looking at their VALUES.
 *
 * The whitelist is a column filter, not a validator. It answers "may this key be written?" and
 * says nothing about what is in it, so every one of these reached Postgres:
 *
 *   • `destination_type: null` / `123` / `['sequence']` — the enum guard is written
 *     `typeof b.destination_type === 'string' && !DESTINATION_TYPES.includes(...)`, so ANY
 *     non-string short-circuits it to false and skips the check entirely. `null` then violates
 *     the NOT NULL on the column; a non-string violates `branch_edges_dest_type_chk`. Both are
 *     SQLSTATE errors with no `statusCode`, which server.ts renders as a 500 "Internal server
 *     error" — an author's typo reported as a server fault.
 *   • `sort_order: 'first'` — an `integer NOT NULL` column, 22P02 at bind time.
 *   • `label: { a: 1 }` — a `text` column handed an object.
 *
 * The POST sibling on the same resource rejects a bad `destination_type` with a 400 before
 * touching the database. These tests pin the PATCH to that same contract: a 400 whose body names
 * the field, and — the stronger half — NO UPDATE issued at all. Asserting only the status would
 * pass against a route that writes first and fails second.
 *
 * The last case is the guard against over-correction: a well-formed patch must still write
 * exactly the fields it names and nothing else.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const mocks = vi.hoisted(() => ({
  branch_edges:         { findFirst: vi.fn(), findMany: vi.fn() },
  branch_sequences:     { findFirst: vi.fn(), findMany: vi.fn() },
  branch_choice_points: { findFirst: vi.fn(), findMany: vi.fn() },
  projects:             { findFirst: vi.fn() },
  video_files:          { findFirst: vi.fn(), findMany: vi.fn() },
  branch_path_events:   { findFirst: vi.fn(), findMany: vi.fn() },
}));

/** Every `.set()` this route issues, so "the route did not write" is an assertion and not a hope. */
const writes = vi.hoisted(() => ({ sets: [] as unknown[] }));

vi.mock('../../../db/index.js', () => ({
  db: {
    query: mocks,
    update: () => ({
      set: (v: unknown) => {
        writes.sets.push(v);
        return { where: () => ({ returning: async () => [{ id: 'edge-1', ...(v as object) }] }) };
      },
    }),
    insert: () => ({ values: () => ({ returning: async () => [{ id: 'edge-1' }] }) }),
    delete: () => ({ where: async () => undefined }),
  },
}));
vi.mock('../../../db/schema.js', () => ({
  projects: Symbol('projects'), video_files: Symbol('video_files'),
  branch_sequences: Symbol('branch_sequences'),
  branch_choice_points: Symbol('branch_choice_points'),
  branch_edges: Symbol('branch_edges'),
  branch_path_events: Symbol('branch_path_events'),
}));
vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({ type: 'eq' })), and: vi.fn(() => ({ type: 'and' })),
  asc: vi.fn(() => ({ type: 'asc' })),
}));
vi.mock('../../../middleware/firebase-auth.js', () => ({
  firebaseAuthMiddleware: (req: Record<string, unknown>, _reply: unknown, done: () => void) => {
    req.dbUser = { id: 'user-1' };
    done();
  },
  firebaseAuthOptionalMiddleware: (_req: unknown, _reply: unknown, done: () => void) => done(),
}));
vi.mock('../../../services/collabAccess.js', () => ({
  editableProject: vi.fn(async () => ({ id: 'proj-1', created_by: 'user-1', visibility: 'private' })),
  isCollaborator: vi.fn(async () => false),
}));

const { registerBranchRoutes } = await import('../branch.controller.js');

const EXISTING_EDGE = {
  id: 'edge-1', project_id: 'proj-1', choice_point_id: 'cp-1', label: 'Left',
  description: null, thumbnail_url: null, sort_order: 0, destination_type: 'sequence',
  dest_sequence_id: '22222222-2222-4222-8222-222222222222', dest_project_id: null,
  dest_playlist_id: null, dest_url: null, dest_simulation_id: null, dest_quiz_id: null,
  trigger_event: null, trigger_match: null,
};

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerBranchRoutes(app);
  // server.ts's shape: a driver error carries no `statusCode`, so it renders as a 500.
  app.setErrorHandler((err, _req, reply) => {
    const statusCode = (err as { statusCode?: number }).statusCode ?? 500;
    reply.code(statusCode).send({ message: statusCode >= 500 ? 'Internal server error' : err.message });
  });
  await app.ready();
  return app;
}

async function patchEdge(body: Record<string, unknown>) {
  const app = await buildApp();
  const res = await app.inject({
    method: 'PATCH',
    url: '/api/v1/projects/proj-1/branch/edges/edge-1',
    payload: body,
  });
  await app.close();
  return res;
}

beforeEach(() => {
  writes.sets.length = 0;
  for (const table of Object.values(mocks)) {
    for (const fn of Object.values(table)) (fn as ReturnType<typeof vi.fn>).mockReset();
  }
  mocks.branch_edges.findFirst.mockResolvedValue(EXISTING_EDGE);
  mocks.branch_sequences.findFirst.mockResolvedValue({ id: EXISTING_EDGE.dest_sequence_id, project_id: 'proj-1' });
  mocks.branch_choice_points.findFirst.mockResolvedValue({ id: 'cp-1', project_id: 'proj-1' });
});

describe('PATCH branch edge — value-level validation', () => {
  const REJECTED: Array<[string, Record<string, unknown>]> = [
    ['destination_type null (NOT NULL column; typeof-guard skips it)', { destination_type: null }],
    ['destination_type a number (enum guard skipped, CHECK constraint would fire)', { destination_type: 123 }],
    ['destination_type an array (enum guard skipped)', { destination_type: ['sequence'] }],
    ['destination_type an unknown string', { destination_type: 'teleport' }],
    ['sort_order a word (integer column)', { sort_order: 'first' }],
    ['sort_order a float (integer column)', { sort_order: 1.5 }],
    ['label an object (text column)', { label: { a: 1 } }],
    ['dest_url a number (text column)', { dest_url: 42 }],
    ['trigger_match a bare string (declared Record | null)', { trigger_match: 'not-an-object' }],
    ['choice_point_id a boolean (uuid column)', { choice_point_id: true }],
  ];

  for (const [name, body] of REJECTED) {
    it(`400s on ${name} and issues no UPDATE`, async () => {
      const res = await patchEdge(body);
      expect(res.statusCode).toBe(400);
      expect(writes.sets).toEqual([]);
    });
  }

  it('still applies a well-formed patch, writing only the named fields', async () => {
    const res = await patchEdge({ label: 'Right', sort_order: 3, destination_type: 'end' });
    expect(res.statusCode).toBe(200);
    expect(writes.sets).toEqual([{ label: 'Right', sort_order: 3, destination_type: 'end' }]);
  });

  it('accepts the nullable columns as explicit null', async () => {
    const res = await patchEdge({ label: null, dest_url: null, trigger_match: null });
    expect(res.statusCode).toBe(200);
    expect(writes.sets).toEqual([{ label: null, dest_url: null, trigger_match: null }]);
  });

  it('ignores keys outside the updatable column set', async () => {
    const res = await patchEdge({ label: 'Right', project_id: 'someone-elses-project', id: 'edge-9' });
    expect(res.statusCode).toBe(200);
    expect(writes.sets).toEqual([{ label: 'Right' }]);
  });
});
