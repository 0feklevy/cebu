import { describe, it, expect } from 'vitest';
import { signMemoryTokenWith, verifyMemoryTokenWith } from '../memoryToken.js';

const SECRET = 'test-secret-abc';
const NOW = 1_700_000_000_000;

describe('memoryToken sign/verify', () => {
  it('round-trips a valid token (binds projectKey + sessionKey)', () => {
    const t = signMemoryTokenWith(SECRET, 'proj-1', 'sess-xyz', NOW);
    const p = verifyMemoryTokenWith(SECRET, t, NOW);
    expect(p).not.toBeNull();
    expect(p?.p).toBe('proj-1');
    expect(p?.s).toBe('sess-xyz');
  });

  it('rejects a token signed with a different secret (forgery)', () => {
    const t = signMemoryTokenWith('other-secret', 'proj-1', 'sess-xyz', NOW);
    expect(verifyMemoryTokenWith(SECRET, t, NOW)).toBeNull();
  });

  it('rejects a tampered body', () => {
    const t = signMemoryTokenWith(SECRET, 'proj-1', 'sess-xyz', NOW);
    const tampered = Buffer.from(JSON.stringify({ p: 'proj-1', s: 'sess-EVIL', e: NOW + 1000 })).toString('base64url') + '.' + t.split('.')[1];
    expect(verifyMemoryTokenWith(SECRET, tampered, NOW)).toBeNull();
  });

  it('rejects a tampered signature', () => {
    const t = signMemoryTokenWith(SECRET, 'proj-1', 'sess-xyz', NOW);
    expect(verifyMemoryTokenWith(SECRET, t.split('.')[0] + '.abcd', NOW)).toBeNull();
  });

  it('rejects an expired token', () => {
    const t = signMemoryTokenWith(SECRET, 'proj-1', 'sess-xyz', NOW - 13 * 60 * 60 * 1000); // TTL 12h
    expect(verifyMemoryTokenWith(SECRET, t, NOW)).toBeNull();
  });

  it('rejects empty / malformed tokens', () => {
    expect(verifyMemoryTokenWith(SECRET, null, NOW)).toBeNull();
    expect(verifyMemoryTokenWith(SECRET, '', NOW)).toBeNull();
    expect(verifyMemoryTokenWith(SECRET, 'no-dot', NOW)).toBeNull();
    expect(verifyMemoryTokenWith(SECRET, '.justmac', NOW)).toBeNull();
  });
});
