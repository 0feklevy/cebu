import { z } from 'zod';

export const HostSchema = z.object({
  id: z.string().uuid(),
  org_id: z.string().uuid(),
  name: z.string().min(1),
  role: z.string().min(1),
  persona_text: z.string(),
  portrait_ref_urls: z.array(z.string().url()).nullable(),
  voice_id: z.string().nullable(),
  seed: z.number().nullable(),
  prompt_lock: z.string().nullable(),
  created_at: z.string().datetime(),
});
export type Host = z.infer<typeof HostSchema>;

export const CreateHostSchema = z.object({
  name: z.string().min(1),
  role: z.string().min(1),
  persona_text: z.string().min(1),
  portrait_ref_urls: z.array(z.string().url()).optional(),
  voice_id: z.string().optional(),
});
export type CreateHost = z.infer<typeof CreateHostSchema>;
