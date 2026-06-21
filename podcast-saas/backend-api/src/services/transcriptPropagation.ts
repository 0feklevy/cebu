/**
 * Propagates a video's caption transcript to the two places that should "know
 * what the video is about" once captions are ready:
 *
 *   1. SEO — summarises the transcript into projects.seo_description +
 *      projects.seo_keywords, which feed the public course/lesson meta tags.
 *   2. Ask-the-Avatar — uploads the transcript as a DEFAULT knowledge document
 *      (RAG) on the video's Anam knowledge group, so the avatar can answer from
 *      the actual spoken content. User-added documents are preserved; only the
 *      auto transcript doc (tracked by avatar_config.transcriptDocId) is replaced.
 *
 * Everything here is best-effort: a failure never affects caption generation.
 */
import OpenAI from 'openai';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { projects, video_files } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { vttToPlainText } from './course/transcript.js';
import { resolveAnamKeyForProject } from './avatar/anamKey.js';
import {
  ANAM_ENV,
  ensureKnowledgeGroup,
  ensureKnowledgeTool,
  uploadKnowledgeDocument,
  deleteKnowledgeDocument,
  upsertVideoPersona,
  type AvatarPersonaConfig,
} from './avatar/anamService.js';
import { DEFAULT_CHARACTER_ID } from './avatar/characters.js';

type VideoRow = typeof video_files.$inferSelect;

const MIN_TRANSCRIPT_CHARS = 40;
const SEO_PROMPT_MAX_CHARS = 8000;   // bound the tokens sent to the LLM
const DOC_MAX_CHARS = 200_000;       // safety bound on the uploaded transcript doc

/** Entry point: forward a freshly-ready transcript. Fire-and-forget; never throws. */
export function propagateTranscript(video: Pick<VideoRow, 'id' | 'project_id' | 'is_broll'>, vtt: string): void {
  if (video.is_broll || !video.project_id) return;
  const transcript = vttToPlainText(vtt);
  if (transcript.length < MIN_TRANSCRIPT_CHARS) return;
  const projectId = video.project_id;
  setImmediate(() => {
    runPropagation(projectId, transcript).catch((err) =>
      logger.warn({ projectId, err: (err as Error).message?.slice(0, 200) }, '[transcript-propagation] failed'),
    );
  });
}

async function runPropagation(projectId: string, transcript: string): Promise<void> {
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!project) return;

  // The two sinks are independent — one failing must not block the other.
  await Promise.allSettled([
    propagateToSeo(project, transcript),
    propagateToAvatar(project, transcript),
  ]);
}

// ── 1. SEO ──────────────────────────────────────────────────────────────────────

async function propagateToSeo(project: typeof projects.$inferSelect, transcript: string): Promise<void> {
  const { description, keywords } = await summariseForSeo(transcript, project.title);
  if (!description) return;
  await db.update(projects).set({
    seo_description: description,
    ...(keywords ? { seo_keywords: keywords } : {}),
    // Seed the human description too, but never clobber one the user wrote.
    ...(project.topic?.trim() ? {} : { topic: description }),
    updated_at: new Date(),
  }).where(eq(projects.id, project.id));
  logger.info({ projectId: project.id }, '[transcript-propagation] SEO description updated');
}

/** LLM summary of the transcript → {description, keywords}. Falls back to a plain excerpt. */
async function summariseForSeo(transcript: string, title: string | null): Promise<{ description: string; keywords: string | null }> {
  const apiKey = process.env.OPENAI_API_KEY;
  const clipped = transcript.slice(0, SEO_PROMPT_MAX_CHARS);
  if (!apiKey) return { description: excerpt(transcript), keywords: null };
  try {
    const client = new OpenAI({ apiKey });
    const res = await client.chat.completions.create({
      model: process.env.SEO_MODEL || 'gpt-4o-mini',
      max_tokens: 300,
      temperature: 0.3,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You write SEO metadata for a video given its transcript. Respond ONLY with JSON ' +
            '{"description": string, "keywords": string}. description: a compelling meta description of ' +
            'what the video is about, max 160 characters, plain sentence, no quotes. keywords: 5-10 ' +
            'comma-separated lowercase search keywords/phrases, no hashtags.',
        },
        {
          role: 'user',
          content: `${title ? `Title: ${title}\n` : ''}Transcript:\n${clipped}`,
        },
      ],
    });
    const raw = res.choices[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(raw) as { description?: string; keywords?: string };
    const description = (parsed.description ?? '').trim().slice(0, 320) || excerpt(transcript);
    const keywords = (parsed.keywords ?? '').trim().slice(0, 500) || null;
    return { description, keywords };
  } catch (err) {
    logger.warn({ err: (err as Error).message?.slice(0, 120) }, '[transcript-propagation] SEO summary fell back to excerpt');
    return { description: excerpt(transcript), keywords: null };
  }
}

/** First ~155 chars of the transcript, cut on a word boundary. */
function excerpt(transcript: string, max = 155): string {
  const t = transcript.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…';
}

// ── 2. Ask-the-Avatar knowledge document ─────────────────────────────────────────

/** Re-read the current avatar_config and overwrite only `patch`'s keys (narrows the
 *  read-modify-write window against concurrent user saves). Returns the merged config. */
async function patchAvatarConfig(projectId: string, patch: Partial<AvatarPersonaConfig>): Promise<AvatarPersonaConfig> {
  const row = await db.query.projects.findFirst({ where: eq(projects.id, projectId), columns: { avatar_config: true } });
  const current = (row?.avatar_config as AvatarPersonaConfig | null) ?? {};
  const merged = { ...current, ...patch };
  await db.update(projects).set({ avatar_config: merged, updated_at: new Date() }).where(eq(projects.id, projectId));
  return merged;
}

async function propagateToAvatar(project: typeof projects.$inferSelect, transcript: string): Promise<void> {
  const apiKey = (await resolveAnamKeyForProject(project.id).catch(() => undefined)) || ANAM_ENV.ANAM_API_KEY;
  if (!apiKey) return; // No Anam configured → no knowledge-document system to push to.

  const existing = (project.avatar_config as AvatarPersonaConfig | null) ?? {};
  const title = project.title?.trim() || 'Video';

  let merged: AvatarPersonaConfig;
  try {
    const groupId = await ensureKnowledgeGroup(`${title} knowledge`, apiKey, existing.knowledgeGroupId);
    // Replace only the previous auto transcript doc — leave user-uploaded docs intact.
    if (existing.transcriptDocId) {
      await deleteKnowledgeDocument(existing.transcriptDocId, apiKey).catch(() => false);
    }
    const filename = `${title.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'video'}-captions.txt`;
    const uploaded = await uploadKnowledgeDocument(groupId, Buffer.from(transcript.slice(0, DOC_MAX_CHARS), 'utf8'), filename, 'text/plain', apiKey);
    const transcriptDocId = extractDocId(uploaded);
    const toolId = await ensureKnowledgeTool(groupId, title, apiKey, existing.knowledgeToolId);

    // Re-read avatar_config right before writing (the Anam calls above take
    // seconds; a concurrent user save must not be clobbered with a stale copy).
    // Only the keys this job owns are overwritten onto the freshest config.
    merged = await patchAvatarConfig(project.id, {
      knowledgeGroupId: groupId,
      knowledgeToolId: toolId,
      ...(transcriptDocId ? { transcriptDocId } : {}),
    });
    logger.info({ projectId: project.id, groupId }, '[transcript-propagation] avatar knowledge document uploaded');
  } catch (err) {
    logger.warn({ projectId: project.id, err: (err as Error).message?.slice(0, 160) }, '[transcript-propagation] avatar knowledge upload failed');
    return;
  }

  // If a persona already exists, re-bake it so the RAG tool is attached to live
  // sessions immediately (otherwise it takes effect on the next avatar save).
  if (merged.personaId && merged.avatarId && merged.voiceId) {
    try {
      const characterId = merged.characterId ?? DEFAULT_CHARACTER_ID;
      const personaId = await upsertVideoPersona(characterId, merged, apiKey, merged.personaId);
      if (personaId && personaId !== merged.personaId) {
        await patchAvatarConfig(project.id, { personaId });
      }
    } catch (err) {
      logger.warn({ projectId: project.id, err: (err as Error).message?.slice(0, 120) }, '[transcript-propagation] persona refresh skipped');
    }
  }
}

/** Pull a document id out of Anam's (loosely-typed) upload response. */
function extractDocId(resp: unknown): string | undefined {
  if (!resp || typeof resp !== 'object') return undefined;
  const r = resp as Record<string, unknown>;
  const candidate = r.id ?? r.documentId ?? (r.data as Record<string, unknown> | undefined)?.id;
  return typeof candidate === 'string' ? candidate : undefined;
}
