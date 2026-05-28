import { z } from 'zod';

export const CorpusSourceTypeSchema = z.enum([
  'pdf',
  'web',
  'youtube',
  'audio',
  'image',
  'text',
]);
export type CorpusSourceType = z.infer<typeof CorpusSourceTypeSchema>;

export const CorpusIngestionStatusSchema = z.enum([
  'pending',
  'processing',
  'ready',
  'failed',
]);
export type CorpusIngestionStatus = z.infer<typeof CorpusIngestionStatusSchema>;

export const CorpusSchema = z.object({
  id: z.string().uuid(),
  project_id: z.string().uuid(),
  source_type: CorpusSourceTypeSchema,
  source_url: z.string().nullable(),
  storage_url: z.string().nullable(),
  extracted_md: z.string().nullable(),
  hash: z.string().nullable(),
  metadata: z.record(z.unknown()).nullable(),
  ingestion_status: CorpusIngestionStatusSchema,
  error: z.string().nullable(),
  created_at: z.string().datetime(),
});
export type Corpus = z.infer<typeof CorpusSchema>;

export const CreateCorpusSchema = z.object({
  source_type: CorpusSourceTypeSchema,
  source_url: z.string().url().optional(),
  text: z.string().optional(),
});
export type CreateCorpus = z.infer<typeof CreateCorpusSchema>;
