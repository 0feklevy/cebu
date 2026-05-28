import { task } from '@trigger.dev/sdk/v3';
import { CorpusBuilder } from '../services/ingestion/CorpusBuilder.js';

export const corpusIngestTask = task({
  id: 'corpus.ingest',
  maxDuration: 300,
  retry: { maxAttempts: 3, factor: 2, minTimeoutInMs: 5000 },
  run: async (payload: { corpus_id: string }) => {
    const builder = new CorpusBuilder();
    await builder.ingest(payload.corpus_id);
    return { corpus_id: payload.corpus_id, status: 'ready' };
  },
});
