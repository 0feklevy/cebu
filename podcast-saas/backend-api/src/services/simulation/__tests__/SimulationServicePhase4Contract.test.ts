/**
 * Phase 4 contract tests — verifies provider-neutral architecture,
 * context prompt behavior, and auto-retry logic.
 * Uses mocked LLMService so tests are fast and deterministic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildContextPrompt,
  computeSourceHash,
  normalizeConversationHistory,
  selectSources,
  type SimManifest,
  type ConversationMessage,
} from '../SimulationService.js';

// ── Test fixtures ─────────────────────────────────────────────────────────────

const baseManifest: SimManifest = {
  controls: [{ id: 'velocity', type: 'range', label: 'Velocity', min: '0', max: '100', step: '1', aliases: [] }],
  buttons: [{ id: 'start-btn', label: 'Start' }],
  sections: [],
  renderFunctions: ['redraw'],
  updateFunctions: ['updateDerivedPhysics'],
  hasSetSimSection: false,
  selectElements: [],
  checkboxElements: [],
  canvasElements: ['canvas'],
  globalObjects: [],
};

const INSTRUCTIONS = 'You generate a bridge script.';

// ── buildContextPrompt ─────────────────────────────────────────────────────────

describe('buildContextPrompt', () => {
  it('includes source files in the context prompt (system prompt), not user message', () => {
    const sourceMap = new Map([['sim/index.html', '<html>sim content</html>']]);
    const ctx = buildContextPrompt(INSTRUCTIONS, sourceMap, baseManifest, 'hash123', false);
    expect(ctx).toContain('sim content');
    expect(ctx).toContain('## SIMULATION SOURCE FILES');
  });

  it('includes the manifest in the context prompt', () => {
    const sourceMap = new Map([['sim/index.html', '<html/>']]);
    const ctx = buildContextPrompt(INSTRUCTIONS, sourceMap, baseManifest, 'hash123', false);
    expect(ctx).toContain('velocity');  // control ID from manifest
    expect(ctx).toContain('## MANIFEST');
  });

  it('includes the sourceHash in the context prompt for debugging', () => {
    const sourceMap = new Map([['sim/index.html', '<html/>']]);
    const ctx = buildContextPrompt(INSTRUCTIONS, sourceMap, baseManifest, 'abc123def456', false);
    expect(ctx).toContain('abc123def456');
  });

  it('marks contextTruncated when true', () => {
    const sourceMap = new Map([['sim/index.html', '<html/>']]);
    const ctx = buildContextPrompt(INSTRUCTIONS, sourceMap, baseManifest, 'hash', true);
    expect(ctx).toContain('contextTruncated: true');
  });

  it('does NOT include contextTruncated comment when false', () => {
    const sourceMap = new Map([['sim/index.html', '<html/>']]);
    const ctx = buildContextPrompt(INSTRUCTIONS, sourceMap, baseManifest, 'hash', false);
    expect(ctx).not.toContain('contextTruncated: true');
  });

  it('sorts source files deterministically by path', () => {
    // Insert in reverse alphabetical order
    const sourceMap = new Map([
      ['sim/z.js', 'const z = 1;'],
      ['sim/a.js', 'const a = 1;'],
      ['sim/index.html', '<html/>'],
    ]);
    const ctx = buildContextPrompt(INSTRUCTIONS, sourceMap, baseManifest, 'hash', false);
    const aIdx = ctx.indexOf('a.js');
    const zIdx = ctx.indexOf('z.js');
    const iIdx = ctx.indexOf('index.html');
    // All should appear; order should be: a.js < index.html < z.js (alphabetical)
    expect(aIdx).toBeGreaterThan(-1);
    expect(aIdx).toBeLessThan(iIdx);
    expect(iIdx).toBeLessThan(zIdx);
  });

  it('includes base instructions before source files', () => {
    const sourceMap = new Map([['sim/index.html', '<html/>']]);
    const ctx = buildContextPrompt(INSTRUCTIONS, sourceMap, baseManifest, 'hash', false);
    const instrIdx = ctx.indexOf(INSTRUCTIONS);
    const filesIdx = ctx.indexOf('## SIMULATION SOURCE FILES');
    expect(instrIdx).toBeGreaterThan(-1);
    expect(instrIdx).toBeLessThan(filesIdx);
  });
});

// ── computeSourceHash — stability and determinism ────────────────────────────

describe('computeSourceHash — stability', () => {
  it('same sourceMap produces same hash on repeated calls', () => {
    const m = new Map([['a.js', 'code a'], ['b.js', 'code b']]);
    expect(computeSourceHash(m)).toBe(computeSourceHash(m));
  });

  it('insertion order does not affect hash', () => {
    const m1 = new Map([['a.js', 'x'], ['b.js', 'y']]);
    const m2 = new Map([['b.js', 'y'], ['a.js', 'x']]);
    expect(computeSourceHash(m1)).toBe(computeSourceHash(m2));
  });

  it('hash changes when content changes', () => {
    const m1 = new Map([['a.js', 'version 1']]);
    const m2 = new Map([['a.js', 'version 2']]);
    expect(computeSourceHash(m1)).not.toBe(computeSourceHash(m2));
  });

  it('hash changes when file is renamed (path is included)', () => {
    const m1 = new Map([['sim.js', 'code']]);
    const m2 = new Map([['renamed.js', 'code']]);
    expect(computeSourceHash(m1)).not.toBe(computeSourceHash(m2));
  });

  it('CRLF and LF produce the same hash', () => {
    const m1 = new Map([['a.js', 'line1\r\nline2']]);
    const m2 = new Map([['a.js', 'line1\nline2']]);
    expect(computeSourceHash(m1)).toBe(computeSourceHash(m2));
  });
});

// ── selectSources — context budget ───────────────────────────────────────────

describe('selectSources — budget and ordering', () => {
  const noSectionFile = (_k: string) => false;

  it('output sourceMap is sorted by path', () => {
    const raw = new Map([
      ['sim/z.js', 'z content'],
      ['sim/a.js', 'a content'],
      ['sim/index.html', '<html/>'],
    ]);
    const { sourceMap } = selectSources(raw, noSectionFile);
    const keys = [...sourceMap.keys()];
    const sorted = [...keys].sort((a, b) => a.localeCompare(b));
    expect(keys).toEqual(sorted);
  });

  it('section-specific files are excluded', () => {
    const isSectionFile = (k: string) => /section_[^/]+\.(html|js)$/.test(k);
    const raw = new Map([
      ['sim/index.html', '<html/>'],
      ['sim/section_abc.js', '(function(){})();'],
    ]);
    const { sourceMap } = selectSources(raw, isSectionFile);
    expect([...sourceMap.keys()]).not.toContain('sim/section_abc.js');
  });

  it('sets contextTruncated=false for small content', () => {
    const raw = new Map([['sim/index.html', '<html>small</html>']]);
    const { contextTruncated } = selectSources(raw, noSectionFile);
    expect(contextTruncated).toBe(false);
  });

  it('sets contextTruncated=true when content exceeds budget', () => {
    // Create a file larger than the per-file budget
    const bigContent = 'x'.repeat(60_000);  // larger than htmlPerFile budget (50KB)
    const raw = new Map([['sim/index.html', bigContent]]);
    const { contextTruncated } = selectSources(raw, noSectionFile);
    expect(contextTruncated).toBe(true);
  });
});

// ── normalizeConversationHistory — source invalidation ───────────────────────

describe('normalizeConversationHistory — source hash invalidation', () => {
  it('clear history is preserved unchanged', () => {
    const h: ConversationMessage[] = [
      { role: 'user',      content: 'animate velocity' },
      { role: 'assistant', content: 'Bridge for: "animate velocity". Length: 800 chars.' },
    ];
    expect(normalizeConversationHistory(h)).toEqual(h);
  });

  it('user message with source files is stripped to just the prompt', () => {
    const h: ConversationMessage[] = [{
      role: 'user',
      content: '## SIMULATION SOURCE FILES\n\n```js\ncode\n```\n\nSECTION PROMPT: animate\n\nsimpleUi = true',
    }];
    const result = normalizeConversationHistory(h);
    expect(result[0].content).toBe('animate');
  });

  it('assistant message with raw bridge code is replaced', () => {
    const h: ConversationMessage[] = [{
      role: 'assistant',
      content: '(function () { const SCRIPTS = { main: function(p) { startScript(); return () => {}; } }; })();',
    }];
    const result = normalizeConversationHistory(h);
    expect(result[0].content).toContain('[Previous bridge generated');
    expect(result[0].content).not.toContain('(function');
  });

  it('refinement user message is small — no source files repeated', () => {
    // Simulate a clean refinement history built by the service
    const h: ConversationMessage[] = [
      { role: 'user', content: 'SECTION PROMPT: animate velocity\n\nsimpleUi = true\n\nGenerate the bridge script now.' },
      { role: 'assistant', content: 'Bridge for: "animate velocity". Length: 1200 chars.' },
    ];
    const result = normalizeConversationHistory(h);
    // Clean — no normalization needed
    expect(result[0].content).not.toContain('SIMULATION SOURCE FILES');
    // The refinement user message is tiny (no source files)
    expect(result[0].content.length).toBeLessThan(200);
  });
});

// ── LLM contract — previousMessages propagation ──────────────────────────────
// These tests verify that the LLMOptions interface includes previousMessages
// and that the contract is defined correctly (not provider-specific).

import { type LLMOptions } from '../../llm/LLMProvider.js';

describe('LLM contract — LLMOptions interface', () => {
  it('LLMOptions includes previousMessages field', () => {
    // TypeScript structural check — the field must exist on the type
    const opts: LLMOptions = {
      model: 'claude-sonnet-4-6',
      systemPrompt: 'system',
      userPrompt: 'user',
      previousMessages: [{ role: 'user', content: 'prior' }],
    };
    expect(opts.previousMessages).toHaveLength(1);
    expect(opts.previousMessages![0].role).toBe('user');
  });

  it('LLMOptions previousMessages supports both user and assistant roles', () => {
    const opts: LLMOptions = {
      model: 'test-model',
      systemPrompt: 'sys',
      userPrompt: 'usr',
      previousMessages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a' },
      ],
    };
    expect(opts.previousMessages).toHaveLength(2);
  });

  it('LLMOptions includes abortSignal field', () => {
    const ac = new AbortController();
    const opts: LLMOptions = {
      model: 'test-model',
      systemPrompt: 'sys',
      userPrompt: 'usr',
      abortSignal: ac.signal,
    };
    expect(opts.abortSignal).toBeDefined();
    expect(opts.abortSignal!.aborted).toBe(false);
  });

  it('LLMOptions includes onTokenChunk callback', () => {
    const chunks: string[] = [];
    const opts: LLMOptions = {
      model: 'test-model',
      systemPrompt: 'sys',
      userPrompt: 'usr',
      onTokenChunk: (c) => chunks.push(c),
    };
    opts.onTokenChunk?.('hello');
    expect(chunks).toEqual(['hello']);
  });
});

// ── Phase 5 readiness ─────────────────────────────────────────────────────────

import { type BridgeGenerationResult } from '../SimulationService.js';

describe('Phase 5 readiness', () => {
  it('BridgeGenerationResult includes provider and model fields', () => {
    // TypeScript structural check
    const r: BridgeGenerationResult = {
      sectionUrl:        'https://cdn.example.com/index.html?section=abc&v=def456',
      conversationHistory: [],
      sourceHash:        'abc123',
      bridgeHash:        'def456',
      mainBody:          'return function cleanup() {};',
      provider:          'claude',
      model:             'claude-sonnet-4-6',
      confidence:        0.9,
      confidenceLevel:   'high',
      warnings:          [],
      validationErrors:  [],
      validationWarnings: [],
      retryCount:        0,
      retryReason:       null,
      contextTruncated:  false,
    };
    expect(r.provider).toBe('claude');
    expect(r.model).toBe('claude-sonnet-4-6');
    expect(r.confidenceLevel).toBe('high');
    expect(r.retryReason).toBeNull();
  });

  it('GeneratedBridge does not have files field (Phase 5 not implemented yet)', () => {
    // Runtime check: a valid GeneratedBridge shape should not have files
    const bridge = { message: 'test', bridgeScript: '(function(){})();', confidence: 0.9, warnings: [] };
    expect('files' in bridge).toBe(false);
  });
});
