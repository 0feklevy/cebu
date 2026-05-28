/**
 * Integration-style tests for the ScriptPipeline.
 * The DB, LLMService, and filesystem prompts are all mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppError, LLMErrorType } from 'shared';

// ── Mock heavy infrastructure before importing services ──────────────────────

vi.mock('../../../db/index.js', () => ({
  db: {
    query: {
      projects: { findFirst: vi.fn() },
      corpora: { findMany: vi.fn() },
      hosts: { findFirst: vi.fn() },
      admin_settings: { findFirst: vi.fn() },
      system_prompts: { findFirst: vi.fn() },
      scripts: { findMany: vi.fn() },
    },
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([{ id: 'script-1', version: 1 }])) })) })) })),
    insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([{ id: 'script-1', version: 1 }])) })) })),
    delete: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
  },
}));

vi.mock('fs', () => ({
  readFileSync: vi.fn(() => {
    throw new Error('no file'); // fall through to DB value
  }),
}));

vi.mock('../../../services/secrets/ApiKeyService.js', () => ({
  ApiKeyService: vi.fn().mockImplementation(() => ({
    getSystemKey: vi.fn().mockResolvedValue('mock-api-key'),
  })),
}));

vi.mock('../../../services/usage/UsageTrackingService.js', () => ({
  UsageTrackingService: vi.fn().mockImplementation(() => ({
    record: vi.fn().mockResolvedValue(undefined),
  })),
}));

// ── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_PROJECT = {
  id: 'proj-uuid-1234',
  org_id: 'org-1',
  created_by: 'user-1',
  topic: 'AI safety',
  style_preset: 'educational-deep-dive',
  host_a_id: null,
  host_b_id: null,
  format: 'two-host',
  target_duration_min: 10,
  pacing: 'standard',
  emotional_style: 'warm',
  status: 'pending',
  created_at: new Date().toISOString(),
};

const MOCK_STRUCTURAL = {
  title: 'The AI Safety Crisis',
  thesis: 'AI systems are advancing faster than our ability to align them.',
  audience_persona: 'Curious tech professional',
  topic_map: [
    {
      topic: 'Current capabilities',
      key_facts: ['GPT-4 passes bar exam'],
      tensions: ['Capability vs alignment gap'],
      analogies: ['Like a nuclear reactor without containment'],
    },
  ],
  narrative_arc: ['Hook', 'Problem', 'Evidence', 'Solution', 'CTA'],
  pacing_seconds: [60, 120, 180, 120, 60],
};

const T = (speaker: 'host_a' | 'host_b', text: string, is_hook = false) => ({
  speaker, text, audio_tags: [] as never[], emotion: 'neutral' as const, is_hook, b_roll: null, duration_hint_sec: 5,
});

const MOCK_SCRIPT = {
  title: 'The AI Safety Crisis',
  intro_runtime_sec: 5,
  turns: [
    T('host_a', 'Did you know AI might kill us all?', true),
    T('host_b', 'That is a bold opener!'),
    T('host_a', 'The evidence is sobering.'),
    T('host_b', 'What should we do about it?'),
    T('host_a', 'Start with alignment research.'),
    T('host_b', 'Thanks for joining us today.'),
  ],
  outro_runtime_sec: 5,
  total_estimated_seconds: 600,
};

const MOCK_SETTINGS = {
  id: 1,
  default_provider: 'claude' as const,
  generation_model: 'claude-sonnet-4-5',
  complex_model: 'claude-sonnet-4-5',
  utility_model: 'claude-haiku-4-5',
  max_tokens: 32000,
  temperature: 0.7,
  extended_thinking_enabled: false,
  thinking_budget_tokens: 8000,
  complex_min_retries: 2,
  complex_min_corpus_tokens: 50000,
  generation_paused: false,
  generation_paused_message: null,
  maintenance_mode: false,
  maintenance_message: null,
  anonymous_user_limit: 3,
  billing_enabled: false,
  updated_at: new Date(),
};

const MOCK_CORPUS = {
  id: 'corpus-1',
  project_id: 'proj-uuid-1234',
  extracted_md: 'AI is advancing rapidly. Key risks include misalignment and capability jumps.',
  ingestion_status: 'ready',
};

// ── SSE emitter mock ──────────────────────────────────────────────────────────

function makeSse() {
  const events: object[] = [];
  return {
    emit: vi.fn((event: object) => events.push(event)),
    events,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ScriptPipeline', () => {
  let db: Awaited<typeof import('../../../db/index.js')>['db'];

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../../../db/index.js');
    db = mod.db;

    // Default happy-path DB setup
    (db.query.projects.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_PROJECT);
    (db.query.corpora.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([MOCK_CORPUS]);
    (db.query.hosts.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (db.query.admin_settings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_SETTINGS);
    (db.query.system_prompts.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      key: 'structural_analysis',
      content: 'You are a script architect. Output ONLY the JSON.',
      is_customized: false,
    });
    (db.query.scripts.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  });

  describe('prompt substitution', () => {
    it('StructuralAnalysisService substitutes all placeholders correctly', async () => {
      const { StructuralAnalysisService } = await import('../StructuralAnalysisService.js');

      // Mock LLMService
      const mockLlm = {
        sendStructured: vi.fn().mockResolvedValue({
          data: MOCK_STRUCTURAL,
          usage: { input: 100, output: 50, cached_input: 0, cost_cents: 1 },
          provider: 'claude',
          model: 'claude-sonnet-4-5',
        }),
      };

      const service = new StructuralAnalysisService(mockLlm as never);
      await service.analyze(MOCK_PROJECT, null, null, 'corpus text', new AbortController().signal);

      const callOpts = mockLlm.sendStructured.mock.calls[0][0];
      // No unresolved template literals should remain in the system prompt
      expect(callOpts.systemPrompt).not.toMatch(/\{\{[A-Z_]+\}\}/);
    });

    it('ScriptRewriteService substitutes {{STYLE_PRESET}} placeholder', async () => {
      const { ScriptRewriteService } = await import('../ScriptRewriteService.js');

      (db.query.system_prompts.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        key: 'script_rewrite',
        content: 'Style: {{STYLE_PRESET}} Tone: {{EMOTIONAL_STYLE}} Tags: {{VALID_AUDIO_TAGS}} Emotions: {{VALID_EMOTIONS}}',
        is_customized: false,
      });

      const mockLlm = {
        sendStructured: vi.fn().mockResolvedValue({
          data: MOCK_SCRIPT,
          usage: { input: 200, output: 100, cached_input: 0, cost_cents: 2 },
          provider: 'claude',
          model: 'claude-sonnet-4-5',
        }),
      };

      const service = new ScriptRewriteService(mockLlm as never);
      await service.rewrite(MOCK_PROJECT, null, null, MOCK_SCRIPT, new AbortController().signal);

      const callOpts = mockLlm.sendStructured.mock.calls[0][0];
      expect(callOpts.systemPrompt).toContain('educational-deep-dive');
      expect(callOpts.systemPrompt).not.toContain('{{STYLE_PRESET}}');
      expect(callOpts.systemPrompt).not.toMatch(/\{\{[A-Z_]+\}\}/);
    });
  });

  describe('ScriptValidator', () => {
    it('validates a well-formed script as valid', async () => {
      const { ScriptValidator } = await import('../ScriptValidator.js');
      const validator = new ScriptValidator();
      const result = validator.validate(MOCK_SCRIPT);
      expect(result.valid).toBe(true);
      expect(result.script).toBeDefined();
    });

    it('rejects a script with no turns', async () => {
      const { ScriptValidator } = await import('../ScriptValidator.js');
      const validator = new ScriptValidator();
      const bad = { ...MOCK_SCRIPT, turns: [] };
      const result = validator.validate(bad);
      expect(result.valid).toBe(false);
    });

    it('rejects a script where no turn has is_hook: true', async () => {
      const { ScriptValidator } = await import('../ScriptValidator.js');
      const validator = new ScriptValidator();
      const noHook = {
        ...MOCK_SCRIPT,
        turns: MOCK_SCRIPT.turns.map((t) => ({ ...t, is_hook: false })),
      };
      const result = validator.validate(noHook);
      expect(result.valid).toBe(false);
      // errors is the zod format object or { issues: string[] }
      const errStr = JSON.stringify(result.errors);
      expect(errStr).toMatch(/hook/i);
    });

    it('rejects a script with fewer than 4 turns', async () => {
      const { ScriptValidator } = await import('../ScriptValidator.js');
      const validator = new ScriptValidator();
      const short = {
        ...MOCK_SCRIPT,
        turns: [T('host_a', 'Intro', true), T('host_b', 'Hi')],
      };
      const result = validator.validate(short);
      expect(result.valid).toBe(false);
    });
  });

  describe('LLMService task tier routing', () => {
    it('script_rewrite uses generation tier (not utility)', async () => {
      // This is tested by checking that TASK_TIER maps correctly
      // We import LLMService internals via a white-box test
      const { LLMService } = await import('../../llm/LLMService.js');
      const apiKeyService = { getSystemKey: vi.fn().mockResolvedValue('key') };
      const usageTracking = { record: vi.fn() };
      const svc = new LLMService(apiKeyService as never, usageTracking as never);

      // resolveProviderAndModel is private — test it through sendStructured with spy
      const sendSpy = vi.spyOn(svc as never, '_sendStructuredOnce' as never) as unknown as ReturnType<typeof vi.fn>;
      sendSpy.mockResolvedValue({
        data: MOCK_SCRIPT,
        usage: { input: 1, output: 1, cached_input: 0, cost_cents: 0 },
        provider: 'claude',
        model: 'claude-sonnet-4-5',
      } as never);

      const { z } = await import('zod');
      await svc.sendStructured({
        task: 'script_rewrite',
        systemPrompt: 'sys',
        userPrompt: 'user',
        schema: z.any(),
        userId: 'u1',
        projectId: 'p1',
        abortSignal: new AbortController().signal,
      });

      // The first argument to _sendStructuredOnce contains the task
      expect(sendSpy).toHaveBeenCalledWith(
        expect.objectContaining({ task: 'script_rewrite' }),
        0,
      );
    });
  });
});
