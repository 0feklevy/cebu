/**
 * No raw Date may ever be bound into the slot pool's raw SQL.
 *
 * WHY THIS TEST LOOKS AT PARAMETERS AND NOT AT RESULTS. The bug it pins was invisible to every
 * result-shaped test in this repo: `db.execute(sql\`…\`)` hands its parameters to postgres-js
 * `unsafe()`, which infers no types, so a Date object reaches Buffer.byteLength() unserialised and
 * throws `The "string" argument must be of type string… Received an instance of Date` — on EVERY
 * call, before any log line. PGlite's JS driver serialises Dates itself, so the same code passes
 * against every test database this repo can run. The dubbing feature shipped completely dead in
 * production behind a green suite; the only record of the failure was `pgboss.job.output`.
 *
 * So the assertion is on the QUERY the functions build: mock the db layer, capture what execute
 * receives, and refuse any parameter that is a Date. That is the invariant, stated at the one
 * layer where the production driver and the test driver genuinely differ.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const executeCalls: unknown[] = [];

vi.mock('../../../db/index.js', () => ({
  db: {
    execute: vi.fn(async (query: unknown) => {
      executeCalls.push(query);
      return [{ slot_no: 1 }];
    }),
  },
}));

const { acquireDubbingSlot, renewDubbingSlot, releaseDubbingSlot } = await import('../dubbingSlots.js');

/**
 * Every bound parameter of a drizzle SQL template.
 *
 * `sql\`…\`` stores its pieces in `queryChunks`: StringChunk objects for the literal SQL text,
 * and the interpolated VALUES as themselves, verbatim. That verbatim storage is exactly why the
 * assertion works — a Date bound into the template is still a Date here, before any driver gets a
 * chance to hide or mangle it.
 */
function boundParams(query: unknown): unknown[] {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks.filter((c) => (c as { constructor?: { name?: string } })?.constructor?.name !== 'StringChunk');
}

beforeEach(() => { executeCalls.length = 0; });

describe('dubbing slot SQL never binds a Date', () => {
  it('acquire binds only strings and numbers', async () => {
    await acquireDubbingSlot('dub-1');
    expect(executeCalls.length).toBe(1);
    const params = boundParams(executeCalls[0]);
    expect(params.length).toBeGreaterThan(0);
    for (const p of params) expect(p).not.toBeInstanceOf(Date);
  });

  it('renew binds only strings and numbers', async () => {
    await renewDubbingSlot({ slotNo: 1 }, 'dub-1');
    const params = boundParams(executeCalls[0]);
    expect(params.length).toBeGreaterThan(0);
    for (const p of params) expect(p).not.toBeInstanceOf(Date);
  });

  it('release binds only strings and numbers', async () => {
    await releaseDubbingSlot({ slotNo: 1 }, 'dub-1');
    const params = boundParams(executeCalls[0]);
    for (const p of params) expect(p).not.toBeInstanceOf(Date);
  });

  it('the expiry parameter is a full ISO timestamp, so the cast has something real to parse', async () => {
    await acquireDubbingSlot('dub-1');
    const params = boundParams(executeCalls[0]);
    const iso = params.filter((p): p is string =>
      typeof p === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(p));
    expect(iso.length).toBe(1);
    // …and it is in the future, which is the property a LEASE expiry actually needs.
    expect(new Date(iso[0]!).getTime()).toBeGreaterThan(Date.now());
  });
});
