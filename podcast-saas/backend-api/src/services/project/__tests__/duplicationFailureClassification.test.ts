/**
 * What a failed duplication is allowed to tell the user.
 *
 * THE DEFECT THIS PINS. Every failure used to collapse into one sentence — "Duplication failed.
 * Nothing was created; you can try again." — for a missing source project, a storage gateway with
 * no server-side copy, an object too large to fall back on, a row pointing at another project, and
 * a transient socket timeout alike. Four of those five cannot be fixed by trying again, which is
 * the one thing the sentence told the user to do. And because the commit rolls back, the attempt
 * destroyed the only evidence of itself: nobody could answer "why won't this project copy?",
 * including us. A real user sat on exactly that for a published project.
 *
 * The property under test is therefore not "the message is nice". It is:
 *   • a permanent condition is never reported as retryable, and
 *   • an unrecognised condition IS reported as retryable.
 * The second is not a hedge. Telling someone to give up on a copy that would have worked is worse
 * than letting them press a button twice, so the unknown case fails in that direction on purpose.
 */
import { describe, it, expect } from 'vitest';

import { classifyDuplicationFailure, DuplicationRefused } from '../ProjectDuplicationService.js';
import { CrossProjectReference } from '../duplicationPlan.js';
import { PermanentStorageError } from '../../storage/s3Copy.js';

describe('classifyDuplicationFailure', () => {
  it('carries a refusal’s own verdict rather than re-deciding it', () => {
    const over = new DuplicationRefused('This project is over the limit.', 413, 'over_size_limit', false);
    const v = classifyDuplicationFailure(over);
    expect(v.code).toBe('over_size_limit');
    expect(v.retryable).toBe(false);
    expect(v.userMessage).toBe('This project is over the limit.');
  });

  it('lets a genuinely retryable refusal stay retryable', () => {
    // Superseded/reaped is the one refusal where the same button really can succeed.
    const v = classifyDuplicationFailure(
      new DuplicationRefused('Taken over by another attempt.', 409, 'superseded', true));
    expect(v.retryable).toBe(true);
  });

  it('passes a storage refusal through VERBATIM — its wording is the actionable part', () => {
    // These messages name the operator action ("enable server-side copy…"). The generic catch
    // deleting them was the single biggest loss of information in the old behaviour.
    const err = new PermanentStorageError(
      'COPY_TOO_LARGE_FOR_FALLBACK',
      'This project has a file too large for this storage gateway to copy server-side.');
    const v = classifyDuplicationFailure(err);
    expect(v.userMessage).toBe(err.message);
    expect(v.retryable).toBe(false);
    expect(v.code).toContain('copy_too_large_for_fallback');
  });

  it('treats a cross-project reference as permanent, and keeps the id for the operator', () => {
    const v = classifyDuplicationFailure(
      new CrossProjectReference('branch_edges.dest_simulation_id', 'sim-from-another-project'));
    expect(v.code).toBe('cross_project_reference');
    expect(v.retryable).toBe(false);
    // The user sentence must not leak an internal id; the stored detail must keep it.
    expect(v.userMessage).not.toContain('sim-from-another-project');
    expect(v.detail).toContain('sim-from-another-project');
  });

  it('keeps the escape scan’s own list as the detail — that list IS the diagnosis', () => {
    // The scan computes exactly which table.column still names the original, then the old catch
    // threw it away at the moment it was known, for a condition where retrying is provably useless.
    const v = classifyDuplicationFailure(new Error(
      'duplication: copied rows reference the original — sim_revisions.metadata pointing at the source: 1'));
    expect(v.code).toBe('escaping_reference');
    expect(v.retryable).toBe(false);
    expect(v.detail).toContain('sim_revisions.metadata');
  });

  it('reports an UNRECOGNISED failure as retryable — the safe direction', () => {
    const v = classifyDuplicationFailure(new Error('ECONNRESET'));
    expect(v.code).toBe('unknown');
    expect(v.retryable).toBe(true);
    expect(v.detail).toContain('ECONNRESET');
  });

  it('survives a thrown non-Error without losing the classification', () => {
    const v = classifyDuplicationFailure('just a string');
    expect(v.retryable).toBe(true);
    expect(v.detail).toContain('just a string');
  });

  it('never reports a permanent cause as retryable — the whole point, stated once', () => {
    const permanent: unknown[] = [
      new DuplicationRefused('x', 404, 'source_missing', false),
      new DuplicationRefused('x', 413, 'over_size_limit', false),
      new DuplicationRefused('x', 413, 'object_too_large', false),
      new PermanentStorageError('COPY_SOURCE_MISSING', 'x'),
      new CrossProjectReference('what', 'id'),
      new Error('duplication: copied rows reference the original — a.b: 1'),
    ];
    for (const err of permanent) {
      expect(classifyDuplicationFailure(err).retryable, `${String(err)} was called retryable`).toBe(false);
    }
  });
});
