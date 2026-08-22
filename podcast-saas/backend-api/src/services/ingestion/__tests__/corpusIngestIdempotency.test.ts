/**
 * The short-circuit that stands between a lost acknowledgement and a second vendor bill.
 *
 * Corpus ingest is on the durable queue now (job-queue-015), and a durable queue re-delivers a job
 * whose completion it never saw — a worker killed between finishing the work and acknowledging it,
 * which a deploy makes routine. For an AUDIO corpus this method runs a billed speech-to-text pass,
 * so a re-delivery that redid the work would be a second invoice for bytes already in the row.
 *
 * The extractors are mocked to THROW. That is the assertion: if the short-circuit stops working,
 * the test does not fail on a subtle expectation about a call count — it fails because the code
 * reached a paid extractor it should never have reached.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const findFirst = vi.fn();
const update = vi.fn();

vi.mock('../../../db/index.js', () => ({
  db: {
    query: { corpora: { findFirst: (...a: unknown[]) => findFirst(...a) } },
    update: (...a: unknown[]) => update(...a),
  },
}));
vi.mock('../../../db/schema.js', () => ({ corpora: {} }));
vi.mock('../../storage/getStorageAdapter.js', () => ({ getStorageAdapter: () => ({}) }));

const paid = (name: string) => {
  throw new Error(`${name} ran — the short-circuit did not hold, and this attempt costs money`);
};
vi.mock('../PDFIngester.js', () => ({ PDFIngester: class { extract() { return paid('pdf'); } } }));
vi.mock('../WebIngester.js', () => ({ WebIngester: class { extract() { return paid('web'); } } }));
vi.mock('../YouTubeIngester.js', () => ({ YouTubeIngester: class { extract() { return paid('youtube'); } } }));
vi.mock('../AudioIngester.js', () => ({ AudioIngester: class { transcribe() { return paid('audio STT'); } } }));
vi.mock('../ImageIngester.js', () => ({ ImageIngester: class { caption() { return paid('image caption'); } } }));
vi.mock('../DocumentIngester.js', () => ({ DocumentIngester: class { extract() { return paid('document'); } } }));

const { CorpusBuilder } = await import('../CorpusBuilder.js');

/** A `db.update(...).set(...).where(...)` chain that records nothing and resolves. */
const updateChain = () => ({ set: () => ({ where: async () => undefined }) });

const readyRow = (over: Record<string, unknown> = {}) => ({
  id: 'corpus-1',
  source_type: 'audio',
  source_url: 'lecture.m4a',
  storage_url: 'https://storage.invalid/lecture.m4a',
  metadata: {},
  extracted_md: '# Lecture\n\nThe transcript that was already paid for.',
  ingestion_status: 'ready',
  ...over,
});

beforeEach(() => {
  findFirst.mockReset();
  update.mockReset().mockImplementation(updateChain);
});

describe('a re-delivery of an ingest that already succeeded', () => {
  it('does no work at all — the extractors are never reached', async () => {
    findFirst.mockResolvedValue(readyRow());
    await expect(new CorpusBuilder().ingest('corpus-1')).resolves.toBeUndefined();
  });

  it('writes nothing, so it cannot move a finished row back to `processing`', async () => {
    // The first statement in the non-short-circuit path sets `processing`. Reaching it would take
    // a row that is READY and mark it in-flight — and if the process then died, the recovery sweep
    // would mark a perfectly good corpus FAILED.
    findFirst.mockResolvedValue(readyRow());
    await new CorpusBuilder().ingest('corpus-1');
    expect(update).not.toHaveBeenCalled();
  });

  it('still emits corpus_ready, because a reconnected client is waiting for it', async () => {
    // The client that reconnected mid-ingest has no other way to learn the work is finished.
    findFirst.mockResolvedValue(readyRow());
    const events: Array<{ type: string }> = [];
    await new CorpusBuilder().ingest('corpus-1', { emit: (e: { type: string }) => { events.push(e); } } as never);
    expect(events.map((e) => e.type)).toEqual(['corpus_ready']);
  });
});

describe('what does NOT count as already done', () => {
  // A `web` row for these: it reaches its extractor immediately, with no storage presign in
  // between, so a failure to short-circuit shows up as the extractor running rather than as a
  // mock gap further down. The claim being tested — "this state is not finished work" — does not
  // depend on the source type.
  const notDone = (over: Record<string, unknown> = {}) =>
    readyRow({ source_type: 'web', source_url: 'https://example.invalid/article', ...over });

  it('a row marked ready with EMPTY extracted_md is re-ingested', async () => {
    // A bug or a partial write, not a finished ingest. Short-circuiting on the status flag alone
    // would make that state permanent and the corpus would silently never have content.
    findFirst.mockResolvedValue(notDone({ extracted_md: '' }));
    await expect(new CorpusBuilder().ingest('corpus-1')).rejects.toThrow(/web ran/);
  });

  it('a row marked ready with NULL extracted_md is re-ingested', async () => {
    findFirst.mockResolvedValue(notDone({ extracted_md: null }));
    await expect(new CorpusBuilder().ingest('corpus-1')).rejects.toThrow(/web ran/);
  });

  it('a row still `processing` is re-ingested — that is the crash this queue exists for', async () => {
    findFirst.mockResolvedValue(notDone({ ingestion_status: 'processing' }));
    await expect(new CorpusBuilder().ingest('corpus-1')).rejects.toThrow(/web ran/);
  });

  it('a row marked `failed` is re-ingested', async () => {
    findFirst.mockResolvedValue(notDone({ ingestion_status: 'failed' }));
    await expect(new CorpusBuilder().ingest('corpus-1')).rejects.toThrow(/web ran/);
  });

  it('`force` overrides a finished row, for a deliberate re-ingest', async () => {
    findFirst.mockResolvedValue(notDone());
    await expect(new CorpusBuilder().ingest('corpus-1', undefined, { force: true }))
      .rejects.toThrow(/web ran/);
  });
});

describe('a corpus that is not there', () => {
  it('throws rather than short-circuiting into silence', async () => {
    // A missing row is a real failure and the queue should see it. Returning quietly would let the
    // job report success for work that never happened.
    findFirst.mockResolvedValue(undefined);
    await expect(new CorpusBuilder().ingest('gone')).rejects.toThrow(/not found/);
  });
});
