/**
 * Tests that ScriptPipeline falls back to the draft when the rewrite pass
 * throws a PARSING_ERROR, but still throws on hard errors (abort, LLM down).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppError, LLMErrorType } from 'shared';

// ── Mock heavy infrastructure ─────────────────────────────────────────────────

vi.mock('../../../db/index.js', () => ({
  db: {
    query: {
      projects: { findFirst: vi.fn() },
      corpora: { findMany: vi.fn() },
      hosts: { findFirst: vi.fn() },
      scripts: { findMany: vi.fn() },
    },
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([{ id: 's-1', version: 1 }])) })) })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([{ id: 's-1', version: 1 }])) })),
    })),
    delete: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
  },
}));

vi.mock('fs', () => ({ readFileSync: vi.fn(() => { throw new Error('no file'); }) }));
vi.mock('../../../services/secrets/ApiKeyService.js', () => {
  function ApiKeyService() {}
  ApiKeyService.prototype.getSystemKey = vi.fn().mockResolvedValue('k');
  return { ApiKeyService };
});
vi.mock('../../../services/usage/UsageTrackingService.js', () => {
  function UsageTrackingService() {}
  UsageTrackingService.prototype.record = vi.fn().mockResolvedValue(undefined);
  return { UsageTrackingService };
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MOCK_PROJECT = {
  id: 'proj-1', org_id: 'org-1', created_by: 'user-1',
  topic: 'AI', style_preset: 'educational-deep-dive',
  host_a_id: null, host_b_id: null, format: 'two-host',
  target_duration_min: 5, pacing: 'standard', emotional_style: 'warm',
  status: 'pending', created_at: new Date().toISOString(),
};

const T = (speaker: 'host_a' | 'host_b', text: string, is_hook = false) => ({
  speaker, text, audio_tags: [] as never[], emotion: 'neutral' as const, is_hook, b_roll: null, duration_hint_sec: 5,
});

const MOCK_SCRIPT = {
  title: 'Test',
  intro_runtime_sec: 5,
  turns: [T('host_a', 'Hook!', true), T('host_b', 'Yep'), T('host_a', 'Right'), T('host_b', 'OK'), T('host_a', 'Wow'), T('host_b', 'End')],
  outro_runtime_sec: 5,
  total_estimated_seconds: 300,
};

const MOCK_STRUCTURAL = {
  title: 'AI',
  thesis: 'AI is important',
  audience_persona: 'techie',
  topic_map: [{ topic: 'Topic', key_facts: ['fact'], tensions: ['tension'], analogies: ['analogy'] }],
  narrative_arc: ['intro', 'body', 'outro'],
  pacing_seconds: [60, 180, 60],
};

const MOCK_SETTINGS = {
  id: 1, default_provider: 'claude' as const,
  generation_model: 'claude-sonnet-4-5', complex_model: 'claude-sonnet-4-5', utility_model: 'claude-haiku-4-5',
  max_tokens: 32000, temperature: 0.7, extended_thinking_enabled: false, thinking_budget_tokens: 8000,
  complex_min_retries: 2, complex_min_corpus_tokens: 50000,
  generation_paused: false, generation_paused_message: null,
  maintenance_mode: false, maintenance_message: null,
  anonymous_user_limit: 3, billing_enabled: false, updated_at: new Date(),
};

const MOCK_CORPUS = {
  id: 'c-1', project_id: 'proj-1',
  extracted_md: 'Source material about AI.',
  ingestion_status: 'ready',
};

function makeSse() {
  const events: object[] = [];
  return { emit: vi.fn((e: object) => events.push(e)), events };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ScriptPipeline rewrite fallback', () => {
  let db: Awaited<typeof import('../../../db/index.js')>['db'];

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../../../db/index.js');
    db = mod.db;
    (db.query.projects.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_PROJECT);
    (db.query.corpora.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([MOCK_CORPUS]);
    (db.query.hosts.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (db.query.scripts.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  });

  it('uses draft as final script when rewrite throws PARSING_ERROR', async () => {
    const { ScriptPipeline } = await import('../ScriptPipeline.js');
    const pipeline = new ScriptPipeline();

    // Patch the internal services
    (pipeline as never)['moderation'] = { check: vi.fn().mockResolvedValue(undefined) };
    (pipeline as never)['structural'] = {
      analyze: vi.fn().mockResolvedValue({
        data: MOCK_STRUCTURAL, model: 'm', inputTokens: 0, outputTokens: 0, costCents: 0,
      }),
    };
    (pipeline as never)['draft'] = {
      draft: vi.fn().mockResolvedValue({
        data: MOCK_SCRIPT, model: 'm', inputTokens: 0, outputTokens: 0, costCents: 0,
      }),
    };
    (pipeline as never)['rewrite'] = {
      rewrite: vi.fn().mockRejectedValue(
        new AppError(LLMErrorType.PARSING_ERROR, 'bad json', 422),
      ),
    };

    const sse = makeSse();
    await pipeline.run('proj-1', sse as never, new AbortController().signal);

    // Pipeline should complete, not throw
    const doneEvent = sse.events.find((e) => (e as { type: string }).type === 'done');
    expect(doneEvent).toBeDefined();
  });

  it('still throws when rewrite fails with LLM_ERROR (non-parse failure)', async () => {
    const { ScriptPipeline } = await import('../ScriptPipeline.js');
    const pipeline = new ScriptPipeline();

    (pipeline as never)['moderation'] = { check: vi.fn().mockResolvedValue(undefined) };
    (pipeline as never)['structural'] = {
      analyze: vi.fn().mockResolvedValue({
        data: MOCK_STRUCTURAL, model: 'm', inputTokens: 0, outputTokens: 0, costCents: 0,
      }),
    };
    (pipeline as never)['draft'] = {
      draft: vi.fn().mockResolvedValue({
        data: MOCK_SCRIPT, model: 'm', inputTokens: 0, outputTokens: 0, costCents: 0,
      }),
    };
    (pipeline as never)['rewrite'] = {
      rewrite: vi.fn().mockRejectedValue(
        new AppError(LLMErrorType.LLM_ERROR, 'provider down', 502),
      ),
    };

    const sse = makeSse();
    await expect(
      pipeline.run('proj-1', sse as never, new AbortController().signal),
    ).rejects.toMatchObject({ error_type: LLMErrorType.LLM_ERROR });
  });

  it('completes successfully when both draft and rewrite succeed', async () => {
    const { ScriptPipeline } = await import('../ScriptPipeline.js');
    const pipeline = new ScriptPipeline();

    (pipeline as never)['moderation'] = { check: vi.fn().mockResolvedValue(undefined) };
    (pipeline as never)['structural'] = {
      analyze: vi.fn().mockResolvedValue({
        data: MOCK_STRUCTURAL, model: 'm', inputTokens: 0, outputTokens: 0, costCents: 0,
      }),
    };
    (pipeline as never)['draft'] = {
      draft: vi.fn().mockResolvedValue({
        data: MOCK_SCRIPT, model: 'm', inputTokens: 0, outputTokens: 0, costCents: 0,
      }),
    };
    (pipeline as never)['rewrite'] = {
      rewrite: vi.fn().mockResolvedValue({
        data: MOCK_SCRIPT, model: 'm', inputTokens: 100, outputTokens: 50, costCents: 1,
      }),
    };

    const sse = makeSse();
    await pipeline.run('proj-1', sse as never, new AbortController().signal);

    const doneEvent = sse.events.find((e) => (e as { type: string }).type === 'done');
    expect(doneEvent).toBeDefined();
    const readyEvent = sse.events.find((e) => (e as { type: string }).type === 'script_ready');
    expect(readyEvent).toBeDefined();
  });
});
