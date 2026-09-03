/**
 * The whole-prefix sweeps a project's deletion performs — including the two the 2026-09-03 bucket
 * census found stranded: every video's dubs (~3.2 GiB, the largest prefix) and the podcast editions.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../db/index.js', () => ({ db: {} }));
vi.mock('../../../db/schema.js', () => ({}));
vi.mock('../../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const { projectGcPrefixes } = await import('../projects.controller.js');

describe('projectGcPrefixes', () => {
  it('sweeps thumbnails, captions, corpus, exports, avatar circles, editions — and dubs per video', () => {
    expect(projectGcPrefixes('p1', ['v1', 'v2'])).toEqual([
      'thumbnails/p1', 'captions/p1', 'projects/p1/corpus', 'exports/p1', 'avatar-circles/p1', 'editions/p1',
      'dubs/v1', 'dubs/v2',
    ]);
  });

  it('a project without videos still sweeps its editions and never a bare dubs/ prefix', () => {
    const prefixes = projectGcPrefixes('p1', []);
    expect(prefixes).toContain('editions/p1');
    expect(prefixes.some((p) => p === 'dubs/' || p === 'dubs')).toBe(false);
  });
});
