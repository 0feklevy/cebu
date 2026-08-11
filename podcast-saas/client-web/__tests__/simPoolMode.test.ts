/**
 * `?simpool` is DOWNGRADE-ONLY outside dev (KILLSW).
 *
 * The audited defect: the old inline check (`if (q === 'single' || q === 'adaptive') mode = q`)
 * let any production URL carrying `?simpool=adaptive` UPGRADE a server-side 'single' — i.e. a
 * shared link could silently defeat the kill switch an operator threw during an incident. The
 * rule now lives in one pure function; this table pins every combination so the asymmetry
 * (downgrade always, upgrade only in dev) cannot regress to symmetry unnoticed.
 */
import { describe, it, expect } from 'vitest';
import { resolveSimPoolMode, type SimPoolMode } from '../lib/simPoolMode';

describe('resolveSimPoolMode — every server × query × env combination', () => {
  const table: Array<{
    server: SimPoolMode;
    query: string | null;
    isDev: boolean;
    expected: SimPoolMode;
    why: string;
  }> = [
    // ── query 'single': the escape hatch — always honoured ──
    { server: 'adaptive', query: 'single', isDev: false, expected: 'single', why: 'downgrade allowed in prod' },
    { server: 'adaptive', query: 'single', isDev: true,  expected: 'single', why: 'downgrade allowed in dev' },
    { server: 'single',   query: 'single', isDev: false, expected: 'single', why: 'no-op downgrade' },
    { server: 'single',   query: 'single', isDev: true,  expected: 'single', why: 'no-op downgrade (dev)' },

    // ── query 'adaptive': an UPGRADE — dev only. The prod 'single' row is THE kill-switch case. ──
    { server: 'single',   query: 'adaptive', isDev: false, expected: 'single',   why: 'KILLSW: prod URL must not defeat a server-side kill switch' },
    { server: 'single',   query: 'adaptive', isDev: true,  expected: 'adaptive', why: 'dev may upgrade for diagnostics' },
    { server: 'adaptive', query: 'adaptive', isDev: false, expected: 'adaptive', why: 'no-op upgrade' },
    { server: 'adaptive', query: 'adaptive', isDev: true,  expected: 'adaptive', why: 'no-op upgrade (dev)' },

    // ── absent / unrecognised queries: the server value stands ──
    { server: 'adaptive', query: null,      isDev: false, expected: 'adaptive', why: 'no query' },
    { server: 'single',   query: null,      isDev: false, expected: 'single',   why: 'no query' },
    { server: 'adaptive', query: null,      isDev: true,  expected: 'adaptive', why: 'no query (dev)' },
    { server: 'single',   query: null,      isDev: true,  expected: 'single',   why: 'no query (dev)' },
    { server: 'adaptive', query: '',        isDev: false, expected: 'adaptive', why: 'empty value' },
    { server: 'single',   query: '',        isDev: true,  expected: 'single',   why: 'empty value (dev)' },
    { server: 'adaptive', query: 'bogus',   isDev: false, expected: 'adaptive', why: 'garbage value' },
    { server: 'single',   query: 'bogus',   isDev: true,  expected: 'single',   why: 'garbage value (dev)' },
    { server: 'single',   query: 'SINGLE',  isDev: false, expected: 'single',   why: 'values are case-sensitive, like the old inline check' },
    { server: 'adaptive', query: 'ADAPTIVE', isDev: true, expected: 'adaptive', why: 'case-sensitive: not a recognised upgrade token' },
  ];

  for (const { server, query, isDev, expected, why } of table) {
    it(`server='${server}' query=${query === null ? 'null' : `'${query}'`} isDev=${isDev} → '${expected}' (${why})`, () => {
      expect(resolveSimPoolMode(server, query, isDev)).toBe(expected);
    });
  }

  it('never invents a third mode (output is one of the two inputs)', () => {
    for (const server of ['single', 'adaptive'] as const) {
      for (const query of [null, '', 'single', 'adaptive', 'x'] as const) {
        for (const isDev of [true, false]) {
          expect(['single', 'adaptive']).toContain(resolveSimPoolMode(server, query, isDev));
        }
      }
    }
  });
});
