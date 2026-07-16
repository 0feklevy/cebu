import { describe, expect, it } from 'vitest';
import { evaluateGate, finding, sortFindings } from '../severity.js';

const critical = finding('a.crit', 'CRITICAL', 'csp', 'CSP blocks Firebase auth iframe');
const high = finding('b.high', 'HIGH', 'backfill', 'data repair would null 2 rows');
const warning = finding('c.warn', 'WARNING', 'lint', '3 lint warnings');

describe('evaluateGate policy', () => {
  it('any CRITICAL blocks, and post-deploy demands rollback', () => {
    const pre = evaluateGate([critical], 'pre-deploy');
    expect(pre.blocked).toBe(true);
    expect(pre.shouldRollback).toBe(false);

    const post = evaluateGate([critical], 'post-deploy');
    expect(post.blocked).toBe(true);
    expect(post.shouldRollback).toBe(true);
  });

  it('HIGH blocks unless explicitly approved', () => {
    expect(evaluateGate([high], 'pre-deploy').blocked).toBe(true);
    expect(evaluateGate([high], 'pre-deploy', { approveHigh: true }).blocked).toBe(false);
    // Approval of HIGH never excuses a CRITICAL.
    expect(evaluateGate([high, critical], 'pre-deploy', { approveHigh: true }).blocked).toBe(true);
  });

  it('WARNING reports but does not block unless configured', () => {
    expect(evaluateGate([warning], 'pre-deploy').blocked).toBe(false);
    expect(evaluateGate([warning], 'pre-deploy', { blockOnWarning: true }).blocked).toBe(true);
  });

  it('clean run passes', () => {
    const d = evaluateGate([], 'post-deploy');
    expect(d.blocked).toBe(false);
    expect(d.shouldRollback).toBe(false);
    expect(d.counts).toEqual({ CRITICAL: 0, HIGH: 0, WARNING: 0, INFO: 0 });
  });
});

describe('sortFindings', () => {
  it('orders most severe first', () => {
    expect(sortFindings([warning, high, critical]).map((f) => f.severity)).toEqual(['CRITICAL', 'HIGH', 'WARNING']);
  });
});
