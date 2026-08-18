import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { corpora } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { firebaseAuthMiddleware } from '../../middleware/firebase-auth.js';
import { editableProject } from '../../services/collabAccess.js';
import { uploadFileFromDisk } from '../../services/storage/uploadFromDisk.js';
import {
  declaredTooLarge,
  PROXY_BODY_LIMIT_BYTES,
  tooLargeMessage,
  UPLOAD_MAX_BYTES,
  UploadTooLargeError,
  withBoundedTempFile,
} from '../../services/security/uploadLimits.js';
import { CorpusBuilder } from '../../services/ingestion/CorpusBuilder.js';
import { MARKITDOWN_EXTENSIONS } from '../../services/ingestion/DocumentIngester.js';
import { logger } from '../../lib/logger.js';

type FileSourceType = 'pdf' | 'audio' | 'image' | 'document';

/**
 * The leaf name a corpus object is stored under, given the name the browser sent.
 *
 * THE KEY IS INTERPOLATED INTO A URL, AND THE URL IS THE ONLY POINTER. `corpora.storage_url` has no
 * shadow key column, so everything downstream — `CorpusBuilder.ingest`'s presign, a duplication's
 * copy plan — has to recover the key by INVERTING that URL (`keyFromPublicUrl`). A filename
 * carrying `?` or `#` makes that inversion ambiguous with URL grammar, and a `/` makes the "leaf"
 * a directory. Both are removed HERE, at the one place that mints the key, rather than guessed at
 * by every reader: a key that never needs escaping cannot be recovered wrongly.
 *
 * REMOVED, NOT ENCODED. Percent-encoding would be undone by nothing (the inverse deliberately does
 * not decode), so it would only move the ambiguity into the key itself. The user-facing name is
 * untouched — `corpora.source_url` and `metadata.filename` still carry exactly what was uploaded.
 */
export function corpusObjectName(filename: string): string {
  const leaf = filename.split(/[\\/]/).pop() ?? '';
  const cleaned = leaf
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[?#]/g, '_')
    // A leading dot makes `.`/`..` and hidden-file names; the segment must name a file.
    .replace(/^\.+/, '')
    .trim();
  // Object stores accept long keys, but a 4 kB filename is a denial of service dressed as a name.
  return cleaned.length > 0 ? cleaned.slice(0, 200) : 'upload';
}

function detectSourceType(filename: string, mime: string): FileSourceType {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'pdf') return 'pdf';
  if (MARKITDOWN_EXTENSIONS.has(ext) && ext !== 'pdf') return 'document';
  if (mime.startsWith('audio/') || mime.startsWith('video/')) return 'audio';
  if (mime.startsWith('image/')) return 'image';
  // Fallback: treat unknown binary as document (MarkItDown will reject gracefully)
  return 'document';
}

export async function registerCorpusRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/v1/projects/:id/corpus
  app.post<{ Params: { id: string } }>(
    '/api/v1/projects/:id/corpus',
    // NO `bodyLimit` HERE, DELIBERATELY. It looks like the obvious guard and it is the opposite
    // of one: Fastify's multipart parser bypasses `bodyLimit` entirely — which is exactly why the
    // declared-size check and the bounded spool below exist — while RAISING the ceiling for every
    // other content type on this route from Fastify's 1 MiB default to the proxy limit. And the
    // body is parsed BEFORE preHandler runs, so an anonymous caller gets a 401 with the payload
    // already materialised in the heap. An adversarial reviewer demonstrated it with a standalone
    // app: 401 returned, `req.body` already at 4 MiB. Adding it bought nothing and opened a hole.
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await editableProject(request.params.id, user);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const contentType = request.headers['content-type'] ?? '';

      if (contentType.includes('multipart/form-data')) {
        // File upload.
        //
        // BOUNDED AND SPOOLED TO DISK (performance-002). `detectSourceType` accepts `audio/*` and
        // `video/*`, so this route takes MEDIA, and it used to take it with `await
        // data.toBuffer()` and no ceiling at all — a whole video into the Node heap on a 2-vCPU
        // host, then handed to the uploader as a second reference to the same bytes. The part now
        // streams to a temp file, cut off at the ceiling as it goes, and the upload reads back
        // from that file; peak heap is one chunk, and `file_size` comes from the bytes actually
        // written rather than from a buffer we no longer keep.
        const declared = declaredTooLarge(request.headers['content-length'], UPLOAD_MAX_BYTES.corpusSource);
        if (declared !== null) {
          return reply
            .code(413)
            .send({ message: tooLargeMessage('Corpus source', declared, UPLOAD_MAX_BYTES.corpusSource) });
        }

        const data = await request.file();
        if (!data) return reply.code(400).send({ message: 'No file provided' });

        const filename = data.filename;
        const mime = data.mimetype;

        const sourceType = detectSourceType(filename, mime);
        // The name the USER chose is kept on the row; the name the OBJECT gets is sanitised, because
        // the key has to survive a round trip through a public URL. See `corpusObjectName`.
        const storagePath = `projects/${project.id}/corpus/${Date.now()}_${corpusObjectName(filename)}`;

        let storageUrl: string;
        let fileSize: number;
        try {
          const uploaded = await withBoundedTempFile(
            data.file,
            { limitBytes: UPLOAD_MAX_BYTES.corpusSource, what: 'Corpus source' },
            async ({ path, bytes }) => ({
              url: await uploadFileFromDisk(storagePath, path, mime),
              bytes,
            }),
          );
          storageUrl = uploaded.url;
          fileSize = uploaded.bytes;
        } catch (err) {
          if (err instanceof UploadTooLargeError) return reply.code(413).send({ message: err.message });
          return reply.code(500).send({ message: `Failed to upload file: ${(err as Error).message}` });
        }

        const [corpus] = await db
          .insert(corpora)
          .values({
            project_id: project.id,
            source_type: sourceType,
            source_url: filename,
            storage_url: storageUrl,
            metadata: { filename, mime, file_size: fileSize },
            ingestion_status: 'pending',
          })
          .returning();

        // Async ingest — don't await
        const builder = new CorpusBuilder();
        builder.ingest(corpus.id).catch((err) => {
          logger.error({ err }, 'Corpus ingest failed');
        });

        return reply.code(202).send({
          corpus_id: corpus.id,
          ingestion_status: corpus.ingestion_status,
        });
      } else {
        // JSON body: URL or text
        const body = z
          .object({
            source_type: z.enum(['web', 'youtube', 'text']),
            source_url: z.string().url().optional(),
            text: z.string().optional(),
          })
          .safeParse(request.body);
        if (!body.success) return reply.code(400).send({ message: body.error.message });

        const [corpus] = await db
          .insert(corpora)
          .values({
            project_id: project.id,
            source_type: body.data.source_type,
            source_url: body.data.source_url ?? null,
            metadata: body.data.text ? { text: body.data.text } : null,
            ingestion_status: 'pending',
          })
          .returning();

        // Async ingest
        const builder = new CorpusBuilder();
        builder.ingest(corpus.id).catch((err) => {
          logger.error({ err }, 'Corpus ingest failed');
        });

        return reply.code(202).send({
          corpus_id: corpus.id,
          ingestion_status: corpus.ingestion_status,
        });
      }
    },
  );

  // GET /api/v1/projects/:id/corpus/:corpus_id
  app.get<{ Params: { id: string; corpus_id: string } }>(
    '/api/v1/projects/:id/corpus/:corpus_id',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await editableProject(request.params.id, user);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const corpus = await db.query.corpora.findFirst({
        where: and(
          eq(corpora.id, request.params.corpus_id),
          eq(corpora.project_id, project.id),
        ),
      });
      if (!corpus) return reply.code(404).send({ message: 'Corpus not found' });

      return reply.send({
        ...corpus,
        extracted_md_preview: corpus.extracted_md?.slice(0, 500) ?? null,
        extracted_md: undefined,
      });
    },
  );
}
