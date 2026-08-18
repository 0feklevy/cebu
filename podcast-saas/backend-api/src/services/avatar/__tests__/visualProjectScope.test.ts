/**
 * OWNER BUG (first-visual): "the FIRST time, the avatar ALWAYS shows the same visual —
 * 'A diagram illustrating points as fundamental elements in geometry…' — regardless of the
 * project." The reporting project is about chaos theory and birds.
 *
 * WHAT THIS SUITE PROVES, against a REAL Postgres engine (PGlite) so the actual WHERE clause runs
 * rather than a mock of it:
 *
 *  1. The runtime WRITE path stores every generated visual with `project_id = NULL` — one global
 *     bucket shared by every project on the platform.
 *  2. The runtime READ path (`projectScope`) matched `project_id = $1 OR project_id IS NULL`, so
 *     every project read that global bucket. On a project's FIRST visual its own library is empty,
 *     so the global bucket is the ONLY candidate pool and something from a stranger's project is
 *     served.
 *  3. It is the SAME visual every time because `findRelevantLibraryVisual` lets an "extended" row
 *     qualify on `overlap >= 2` tokens, and a row's token bag includes its `lookup_key` — which for
 *     a runtime-generated image is a 300-char slice of the ORIGINATING project's conversation. Two
 *     connective English words ("simply", "everything") are enough. Three unrelated projects with
 *     three unrelated first messages therefore all land on the same row, deterministically.
 *
 * This is the runtime half of the bug c1219ad only half-fixed: that commit scoped the EDITOR-created
 * library rows and both library LIST endpoints (`includeGlobal: false`) to their project, but never
 * touched `libraryService.projectScope` or the runtime write paths — so the library UI shows the
 * project its own visuals while the avatar keeps serving other projects' at conversation time.
 *
 * MUTATION NOTES — revert either half of the fix and this suite goes red:
 *   • put `or(..., isNull(project_id))` back in `projectScope`  → "serves another project's visual"
 *     and "never serves another project's visual" fail.
 *   • put `projectId: null` back in `storeFast` / the image store → "stores under the project that
 *     generated it" and "a project still reuses its OWN visual" fail.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import * as schema from '../../../db/schema.js';

const h = vi.hoisted(() => ({
  dbRef: { current: null as unknown as Record<string, unknown> },
  /** JSON bodies the stubbed classifier hands back, consumed in order; the tail repeats. */
  classifyScript: [] as string[],
  classifyCalls: 0,
}));

vi.mock('../../../db/index.js', () => ({
  db: new Proxy({} as Record<string, unknown>, {
    get: (_t, prop: string) => {
      const target = h.dbRef.current;
      const v = target[prop];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }),
}));
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../llm/systemAi.js', () => ({
  isGenerationPaused: vi.fn(async () => false),
  getOpenAIClient: vi.fn(async () => ({
    chat: {
      completions: {
        create: vi.fn(async () => {
          h.classifyCalls += 1;
          const body = h.classifyScript.length > 1 ? h.classifyScript.shift()! : (h.classifyScript[0] ?? '{"type":"none"}');
          return { choices: [{ message: { content: body }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
        }),
      },
    },
    images: { generate: vi.fn(async () => ({ data: [{ b64_json: 'ZmFrZQ==' }] })) },
  })),
  recordChatUsage: vi.fn(async () => undefined),
  recordImageUsage: vi.fn(async () => undefined),
}));
vi.mock('../../storage/getStorageAdapter.js', () => ({
  getStorageAdapter: () => ({
    getSimPublicUrl: (k: string) => `https://cdn.test/${k}`,
    readObject: async () => Buffer.from('<!DOCTYPE html></html>'),
    uploadFile: async () => undefined,
    deleteFile: async () => undefined,
    deleteWithPrefix: async () => undefined,
  }),
}));
vi.mock('../../storage/uploadWithFallback.js', () => ({
  uploadWithFallback: vi.fn(async (key: string) => `https://cdn.test/${key}`),
}));

const { analyzeVisual } = await import('../visualService.js');
const { analyzeAndGenerateImage } = await import('../imageService.js');
const { insertVisual } = await import('../libraryService.js');

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'db', 'migrations');

let pg: PGlite;

// ── The owner's exact reported visual ─────────────────────────────────────────────────────────
const GEOMETRY_CAPTION =
  'A diagram illustrating points as fundamental elements in geometry, showing points as precise locations without size or dimension.';
// What `imageService` stores as `lookup_key`: `(conversationContext ?? userMessage).slice(0, 300)`
// — i.e. a raw slice of the ORIGINATING project's conversation, carried into the shared pool.
const GEOMETRY_LOOKUP_KEY =
  'So the first thing to understand is that a point really has no size at all — it simply marks a location, and everything else we build later depends on that one idea.';

/**
 * Three unrelated projects' FIRST utterances. None shares a single TOPIC word with the geometry
 * visual; each shares exactly the two connective words "simply" and "everything", which is all
 * `findRelevantLibraryVisual`'s `overlap >= 2` bar asks of an extended row.
 * None of them trips `detectVisualIntent`, so `intent.explicit` is false on all three (the plain
 * conversational path the owner is on).
 */
const FIRST_UTTERANCES: Record<string, string> = {
  chaosAndBirds:
    'Something I find genuinely wonderful is that a starling flock has no leader. Each bird simply watches its nearest neighbours, and everything you see in the sky comes out of that one little rule.',
  sourdough:
    'Everything about a sourdough starter is slower than people expect. You simply feed it, wait, and let the wild yeast decide when the loaf is ready.',
  harbourTides:
    'The tide here is simply relentless. Everything on this shore — the boats, the weed, the smell of the mud — runs on a rhythm the moon sets and nobody argues with.',
};

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await pg.query<T>(sql, params);
  return r.rows[0];
}

async function newProject(title: string): Promise<string> {
  const org = await one<{ id: string }>(`INSERT INTO orgs (name) VALUES ($1) RETURNING id`, [`org-${title}`]);
  const row = await one<{ id: string }>(
    `INSERT INTO projects (org_id, title) VALUES ($1,$2) RETURNING id`, [org.id, title]);
  return row.id;
}

/** The library writes are fire-and-forget; wait for the row instead of racing it. */
async function waitForRows(where: string, params: unknown[] = [], timeoutMs = 5_000): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await pg.query<Record<string, unknown>>(`SELECT * FROM avatar_visuals WHERE ${where}`, params);
    if (r.rows.length) return r.rows;
    if (Date.now() > deadline) return [];
    await new Promise((res) => setTimeout(res, 25));
  }
}

/** Seed the visual the owner keeps seeing, exactly as the runtime image path writes it today. */
async function seedGlobalGeometryVisual(useCount = 12): Promise<string> {
  const row = await insertVisual({
    projectId: null,                 // ← the runtime write path's hardcoded global bucket
    scope: 'extended',
    source: 'generated',
    characterId: 'einstein',
    visualType: 'image',
    lookupKey: GEOMETRY_LOOKUP_KEY,
    caption: GEOMETRY_CAPTION,
    altText: GEOMETRY_CAPTION.split('.')[0] ?? '',
    imageUrl: 'https://cdn.test/images/avatar/global/geometry-points.png',
    imageKey: 'images/avatar/global/geometry-points.png',
    visualSpec: { dallePrompt: 'points in geometry', imageType: 'diagram' },
  });
  await pg.query(`UPDATE avatar_visuals SET use_count = $2 WHERE id = $1`, [row!.id, useCount]);
  return row!.id;
}

beforeAll(async () => {
  pg = new PGlite();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => /^\d{3}_[^.]+\.sql$/.test(x)).sort()) {
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
  }
  h.dbRef.current = drizzle(pg, { schema }) as unknown as Record<string, unknown>;
}, 120_000);

afterAll(async () => { await pg.close(); });

beforeEach(async () => {
  await pg.exec('TRUNCATE orgs, users CASCADE');
  h.classifyScript = ['{"type":"none"}'];
  h.classifyCalls = 0;
});

// ── 1. The read half: the owner's symptom ─────────────────────────────────────────────────────

describe('a project\'s first visual', () => {
  it('never serves another project\'s visual, however the topics happen to overlap', async () => {
    const geometryId = await seedGlobalGeometryVisual();
    const projectId = await newProject('chaos theory and birds');

    // First turn of a fresh session: the client passes no context (`lastUserMsgRef` is still empty),
    // so this is exactly the request the owner's very first visual comes from.
    const result = await analyzeVisual(FIRST_UTTERANCES.chaosAndBirds, 'einstein', undefined, { projectId });

    expect((result as { bankId?: string }).bankId).not.toBe(geometryId);
    expect(result.type === 'image_ready' ? result.caption : '').not.toContain('geometry');
    expect((result as { _fromBank?: boolean })._fromBank).not.toBe(true);
  });

  it('is the SAME leaked visual for every unrelated project — the owner\'s "always the same"', async () => {
    const geometryId = await seedGlobalGeometryVisual();

    const served: Record<string, string | undefined> = {};
    for (const [name, utterance] of Object.entries(FIRST_UTTERANCES)) {
      const projectId = await newProject(name);
      const result = await analyzeVisual(utterance, 'einstein', undefined, { projectId });
      served[name] = (result as { bankId?: string }).bankId;
    }

    // Pre-fix every one of these is `geometryId`. Post-fix none of them is.
    expect(Object.values(served)).not.toContain(geometryId);
  });

  it('produces nothing at all when the project library is empty and nothing can be generated', async () => {
    await seedGlobalGeometryVisual();
    const projectId = await newProject('chaos theory and birds');
    h.classifyScript = ['{"type":"none"}'];   // the classifier declines

    const result = await analyzeVisual(FIRST_UTTERANCES.chaosAndBirds, 'einstein', undefined, { projectId });

    expect(result.type).toBe('none');
    expect(h.classifyCalls).toBeGreaterThan(0);   // it fell through to generation, not to a stranger's row
  });
});

// ── 2. The write half: what put a stranger's visual in reach in the first place ────────────────

describe('a visual the avatar generates during a conversation', () => {
  it('is stored under the project that generated it, not in a global bucket', async () => {
    const projectId = await newProject('chaos theory and birds');
    h.classifyScript = [JSON.stringify({
      type: 'chart', chartType: 'bar',
      title: 'Starling turn latency', labels: ['inner', 'outer'],
      datasets: [{ label: 'ms', data: [40, 70] }],
      caption: 'Turn latency across a starling flock, measured from the innermost bird outward.',
    })];

    const result = await analyzeVisual(FIRST_UTTERANCES.chaosAndBirds, 'einstein', undefined, { projectId });
    expect(result.type).toBe('chart');

    const rows = await waitForRows(`visual_type = 'chart'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].project_id).toBe(projectId);
  });

  it('is stored under the project when it comes from the image path', async () => {
    const projectId = await newProject('chaos theory and birds');
    h.classifyScript = [JSON.stringify({
      should_generate: true, image_type: 'realistic',
      caption: 'A starling murmuration folding over a winter reedbed at dusk.',
      dalle_prompt: 'a vast starling murmuration over a reedbed, photorealistic',
    })];

    const result = await analyzeAndGenerateImage(FIRST_UTTERANCES.chaosAndBirds, 'einstein', undefined, projectId);
    expect(result.shouldGenerate).toBe(true);

    const rows = await waitForRows(`visual_type = 'image'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].project_id).toBe(projectId);
  });
});

// ── 3. The fix must not simply switch the Library off ──────────────────────────────────────────

describe('the project\'s own Library', () => {
  it('is still reused for that project, and still only for that project', async () => {
    const owner = await newProject('chaos theory and birds');
    const stranger = await newProject('sourdough');
    h.classifyScript = [JSON.stringify({
      type: 'chart', chartType: 'bar',
      title: 'Starling turn latency', labels: ['inner', 'outer'],
      datasets: [{ label: 'ms', data: [40, 70] }],
      caption: 'Turn latency across a starling flock, measured from the innermost bird outward.',
    })];

    await analyzeVisual(FIRST_UTTERANCES.chaosAndBirds, 'einstein', undefined, { projectId: owner });
    const rows = await waitForRows(`visual_type = 'chart'`);
    expect(rows).toHaveLength(1);
    const chartId = rows[0].id as string;
    expect(rows[0].project_id).toBe(owner);

    // A later turn in the SAME project, on the same subject → the project's own row comes back.
    const followUp = 'The latency between one starling and the next is what makes the flock look like a single animal.';
    const ownerHit = await analyzeVisual(followUp, 'einstein', undefined, { projectId: owner });
    expect((ownerHit as { _fromBank?: boolean })._fromBank).toBe(true);
    expect((ownerHit as { bankId?: string }).bankId).toBe(chartId);

    // The identical utterance in a DIFFERENT project must not reach it.
    const strangerMiss = await analyzeVisual(followUp, 'einstein', undefined, { projectId: stranger });
    expect((strangerMiss as { bankId?: string }).bankId).not.toBe(chartId);
  });
});
