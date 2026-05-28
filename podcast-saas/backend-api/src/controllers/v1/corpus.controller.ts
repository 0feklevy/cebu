import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { corpora, projects } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { firebaseAuthMiddleware } from '../../middleware/firebase-auth.js';
import { R2StorageAdapter } from '../../services/storage/R2StorageAdapter.js';
import { CorpusBuilder } from '../../services/ingestion/CorpusBuilder.js';
import { MARKITDOWN_EXTENSIONS } from '../../services/ingestion/DocumentIngester.js';

const storage = new R2StorageAdapter();

type FileSourceType = 'pdf' | 'audio' | 'image' | 'document';

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
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const contentType = request.headers['content-type'] ?? '';

      if (contentType.includes('multipart/form-data')) {
        // File upload
        const data = await request.file();
        if (!data) return reply.code(400).send({ message: 'No file provided' });

        const buffer = await data.toBuffer();
        const filename = data.filename;
        const mime = data.mimetype;

        const sourceType = detectSourceType(filename, mime);
        const storagePath = `projects/${project.id}/corpus/${Date.now()}_${filename}`;
        const storageUrl = await storage.uploadFile(storagePath, buffer, mime);

        const [corpus] = await db
          .insert(corpora)
          .values({
            project_id: project.id,
            source_type: sourceType,
            source_url: filename,
            storage_url: storageUrl,
            metadata: { filename, mime, file_size: buffer.length },
            ingestion_status: 'pending',
          })
          .returning();

        // Async ingest — don't await
        const builder = new CorpusBuilder();
        builder.ingest(corpus.id).catch((err) => {
          console.error('Corpus ingest error:', err);
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
          console.error('Corpus ingest error:', err);
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
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
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
