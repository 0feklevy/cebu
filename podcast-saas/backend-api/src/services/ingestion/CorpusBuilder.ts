import { createHash } from 'crypto';
import { PDFIngester } from './PDFIngester.js';
import { WebIngester } from './WebIngester.js';
import { YouTubeIngester } from './YouTubeIngester.js';
import { AudioIngester } from './AudioIngester.js';
import { ImageIngester } from './ImageIngester.js';
import { DocumentIngester } from './DocumentIngester.js';
import { R2StorageAdapter } from '../storage/R2StorageAdapter.js';
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
  private storage = new R2StorageAdapter();

  async ingest(
    corpusId: string,
    sse?: SSEEmitter,
  ): Promise<void> {
    const corpus = await db.query.corpora.findFirst({ where: eq(corpora.id, corpusId) });
    if (!corpus) throw new Error(`Corpus ${corpusId} not found`);

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
          const url = await this.storage.getPresignedDownloadUrl(
            corpus.storage_url.replace(/^https?:\/\/[^/]+\//, ''),
            600,
          );
          const resp = await fetch(url);
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
