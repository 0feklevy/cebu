import { createHash } from 'crypto';
import { PDFIngester } from './PDFIngester.js';
import { WebIngester } from './WebIngester.js';
import { YouTubeIngester } from './YouTubeIngester.js';
import { AudioIngester } from './AudioIngester.js';
import { ImageIngester } from './ImageIngester.js';
import { DocumentIngester } from './DocumentIngester.js';
import { getStorageAdapter } from '../storage/getStorageAdapter.js';
import type { StorageService } from '../storage/StorageService.js';
import { db } from '../../db/index.js';
import { corpora } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { logger } from '../../lib/logger.js';
import type { SSEEmitter } from '../../lib/sse.js';

export class CorpusBuilder {
  private pdf = new PDFIngester();
  private web = new WebIngester();
  private youtube = new YouTubeIngester();
  private audio = new AudioIngester();
  private image = new ImageIngester();
  private document = new DocumentIngester();
  private get storage(): StorageService {
    return getStorageAdapter();
  }

  async ingest(
    corpusId: string,
    sse?: SSEEmitter,
    opts: { force?: boolean } = {},
  ): Promise<void> {
    const corpus = await db.query.corpora.findFirst({ where: eq(corpora.id, corpusId) });
    if (!corpus) throw new Error(`Corpus ${corpusId} not found`);

    // ALREADY DONE — return without redoing paid work.
    //
    // This became load-bearing when ingest moved onto the durable queue (job-queue-015). pg-boss
    // re-delivers a job whose completion was lost — a worker killed between finishing the work and
    // acknowledging it, which a deploy makes routine — and for an AUDIO corpus this method runs a
    // billed speech-to-text pass. Without this line, a lost acknowledgement is a second invoice for
    // bytes that are already in the row.
    //
    // The condition asks for both the status and the CONTENT. A row marked `ready` with an empty
    // `extracted_md` is not a finished ingest, it is a bug or a partial write, and short-circuiting
    // on the flag alone would make it permanent.
    //
    // The SSE event is still emitted, because a client that reconnected mid-ingest is waiting for
    // exactly this and has no other way to learn the work is finished.
    if (!opts.force && corpus.ingestion_status === 'ready' && (corpus.extracted_md?.length ?? 0) > 0) {
      logger.info({ corpusId }, 'Corpus already ingested — skipping (idempotent re-delivery)');
      sse?.emit({
        type: 'corpus_ready',
        corpus_id: corpusId,
        extracted_md_preview: corpus.extracted_md!.slice(0, 500),
      });
      return;
    }

    // From here until the `ready`/`failed` writes below, this row is `processing` and the ONLY
    // things that will ever move it off again are the happy path and the catch at the bottom of
    // this method. Neither runs when the process dies — and ingestion is fire-and-forget off the
    // upload request (`corpus.controller.ts` does not await it) — so a crash or a deploy here used
    // to strand the row at `processing` for the life of the database, with the upload UI polling
    // that column forever. `services/ingestion/corpusRecovery.ts` is the sweep that now clears
    // those rows; `server.ts` starts it (observability-002).
    await db.update(corpora).set({ ingestion_status: 'processing' }).where(eq(corpora.id, corpusId));

    sse?.emit({
      type: 'status',
      stage: 'corpus_ingest',
      message: `Ingesting ${corpus.source_type}: ${corpus.source_url ?? 'uploaded file'}`,
    });

    try {
      let extractedMd: string;

      switch (corpus.source_type) {
        case 'web':
          if (!corpus.source_url) throw new Error('Web corpus missing source_url');
          extractedMd = await this.web.extract(corpus.source_url);
          break;

        case 'youtube':
          if (!corpus.source_url) throw new Error('YouTube corpus missing source_url');
          extractedMd = await this.youtube.extract(corpus.source_url);
          break;

        case 'text':
          extractedMd = corpus.metadata
            ? (corpus.metadata as { text?: string }).text ?? ''
            : '';
          break;

        case 'pdf':
        case 'audio':
        case 'image':
        case 'document': {
          // For file-based types, the storage_url must be set from the upload step
          if (!corpus.storage_url) throw new Error(`${corpus.source_type} corpus missing storage_url`);
          // ASK THE ADAPTER TO INVERT ITS OWN URL. Stripping `https://host/` recovers the key only
          // for an adapter whose public URL is `{origin}/{key}` — on Supabase it leaves
          // `storage/v1/object/public/{bucket}/…`, and on a dev origin it leaves the route prefix,
          // so the presign names an object that does not exist and ingestion fails on a file that
          // uploaded perfectly. `keyFromPublicUrl` is the documented inverse of the two forward
          // builders and lives beside them, where the pair cannot drift.
          const key = this.storage.keyFromPublicUrl(corpus.storage_url);
          if (!key) {
            throw new Error(
              `${corpus.source_type} corpus storage_url is not a URL this storage published: ${corpus.storage_url}`,
            );
          }
          const url = await this.storage.getPresignedDownloadUrl(key, 600);
          const resp = await fetch(url);
          if (!resp.ok) throw new Error(`Storage download failed: ${resp.status} ${resp.statusText}`);
          const buf = Buffer.from(await resp.arrayBuffer());
          const filename = corpus.source_url ?? 'file';
          const fileSize = buf.length;
          const sha256 = createHash('sha256').update(buf).digest('hex');
          const mime = (corpus.metadata as { mime?: string } | null)?.mime ?? 'application/octet-stream';

          if (corpus.source_type === 'pdf') {
            extractedMd = await this.pdf.extract(buf, filename);
          } else if (corpus.source_type === 'audio') {
            extractedMd = await this.audio.transcribe(buf, filename);
          } else if (corpus.source_type === 'image') {
            extractedMd = await this.image.caption(buf, mime);
          } else {
            // document
            extractedMd = await this.document.extract(buf, filename);
          }

          // Enrich metadata with ingestion stats for file-based sources
          const existingMeta = (corpus.metadata as Record<string, unknown> | null) ?? {};
          await db.update(corpora).set({
            metadata: {
              ...existingMeta,
              filename,
              mime,
              file_size: fileSize,
              sha256,
              md_length: extractedMd.length,
            },
          }).where(eq(corpora.id, corpusId));
          break;
        }

        default:
          throw new Error(`Unknown source_type: ${corpus.source_type}`);
      }

      const hash = createHash('sha256').update(extractedMd).digest('hex');

      await db.update(corpora).set({
        extracted_md: extractedMd,
        hash,
        ingestion_status: 'ready',
      }).where(eq(corpora.id, corpusId));

      sse?.emit({
        type: 'corpus_ready',
        corpus_id: corpusId,
        extracted_md_preview: extractedMd.slice(0, 500),
      });

      logger.info({ corpusId, source_type: corpus.source_type, chars: extractedMd.length }, 'Corpus ingested');
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await db.update(corpora).set({
        ingestion_status: 'failed',
        error,
      }).where(eq(corpora.id, corpusId));
      throw err;
    }
  }
}
