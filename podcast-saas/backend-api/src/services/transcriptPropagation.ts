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
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { projects, video_files } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { getOpenAIClient, isGenerationPaused, recordChatUsage } from './llm/systemAi.js';
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
import { bakedStateFor, hashTranscript } from './avatar/personaFingerprint.js';
import { withTranscriptKnowledge } from './avatar/personaBake.js';
import { sanitizeAvatarPersonaConfig } from './avatar/sanitizeAvatarConfig.js';

type VideoRow = typeof video_files.$inferSelect;

const MIN_TRANSCRIPT_CHARS = 40;
const SEO_PROMPT_MAX_CHARS = 8000;   // bound the tokens sent to the LLM
const DOC_MAX_CHARS = 200_000;       // safety bound on the uploaded transcript doc

/**
 * The project's caption transcript as plain text (longest non-broll transcript wins),
 * or null when captions aren't ready. This is the avatar's DEFAULT knowledge source:
 * /avatar/start inlines it so the avatar knows the video even when the RAG document
 * pipeline hasn't run (or its persona was baked without the knowledge tool).
 */
export async function getProjectTranscript(projectId: string): Promise<string | null> {
  const rows = await db.query.video_files.findMany({
    where: eq(video_files.project_id, projectId),
    columns: { captions_vtt: true, is_broll: true },
  });
  let best = '';
  for (const r of rows) {
    if (r.is_broll || !r.captions_vtt) continue;
    const text = vttToPlainText(r.captions_vtt);
    if (text.length > best.length) best = text;
  }
  return best.length >= MIN_TRANSCRIPT_CHARS ? best : null;
}

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
  const { description, keywords } = await summariseForSeo(transcript, project);
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
async function summariseForSeo(
  transcript: string,
  project: typeof projects.$inferSelect,
): Promise<{ description: string; keywords: string | null }> {
  const title = project.title;
  const clipped = transcript.slice(0, SEO_PROMPT_MAX_CHARS);
  // Best-effort background path: no key or platform paused → plain excerpt, not an error.
  const client = (await isGenerationPaused()) ? null : await getOpenAIClient();
  if (!client) return { description: excerpt(transcript), keywords: null };
  try {
    const seoModel = process.env.SEO_MODEL || 'gpt-4o-mini';
    const res = await client.chat.completions.create({
      model: seoModel,
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
    await recordChatUsage({
      userId: project.created_by,
      projectId: project.id,
      model: seoModel,
      task: 'seo_summary',
      usage: res.usage,
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
  // Sanitize-on-read here too: this merge persists, so it heals stored poison (review B1).
  const current = sanitizeAvatarPersonaConfig((row?.avatar_config as AvatarPersonaConfig | null) ?? {});
  const merged = { ...current, ...patch };
  await db.update(projects).set({ avatar_config: merged, updated_at: new Date() }).where(eq(projects.id, projectId));
  return merged;
}

async function propagateToAvatar(project: typeof projects.$inferSelect, transcript: string): Promise<void> {
  // Record the new transcript REVISION before anything can fail. /avatar/start compares it with
  // the revision the saved persona was baked from: if this write lands and every Anam call below
  // then fails, start sees "the persona predates this script" and inlines the fresh transcript
  // instead of confidently answering from a stale one. Recording it late would invert that safety.
  await patchAvatarConfig(project.id, { transcriptHash: hashTranscript(transcript) })
    .catch((err) => logger.warn({ projectId: project.id, err: (err as Error).message?.slice(0, 120) }, '[transcript-propagation] could not record the transcript revision'));

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

  // If a persona already exists, re-bake it so the RAG tool AND the new transcript reach live
  // sessions immediately (otherwise it takes effect on the next avatar save) — and so the recorded
  // fingerprint matches again, which is what lets the next start use the one-round-trip path.
  //
  // The old guard also required avatarId && voiceId to be present in the config, which skipped
  // every video that INHERITS its avatar/voice from the base character persona: those personas
  // never followed the script. upsertVideoPersona resolves inherited avatar/voice/brain itself and
  // raises a clear 400 when nothing can be resolved, so the id alone is the right condition.
  if (merged.personaId) {
    try {
      const characterId = merged.characterId ?? DEFAULT_CHARACTER_ID;
      const personaId = await upsertVideoPersona(characterId, withTranscriptKnowledge(merged, transcript), apiKey, merged.personaId);
      // Marked baked ONLY after the vendor accepted the upsert.
      await patchAvatarConfig(project.id, {
        ...(personaId && personaId !== merged.personaId ? { personaId } : {}),
        personaBaked: bakedStateFor(merged, merged.personaBaked?.revision ?? 0),
      });
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
