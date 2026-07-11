// Ported (simplified) from darwin-avatar/server/db/userMemory.ts
// Cross-session conversation memory: stores turns + extracts personal facts.
import { and, eq, desc } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { avatar_conversations, avatar_profiles } from '../../db/schema.js';
import { MODELS } from './models.js';
import { getOpenAIClient, recordChatUsage } from '../llm/systemAi.js';
import { logger } from '../../lib/logger.js';

export interface Turn { role: 'user' | 'persona'; content: string; }

const MAX_TURNS = 20;

export async function getTurns(sessionKey: string): Promise<Turn[]> {
  const rows = await db
    .select({ role: avatar_conversations.role, content: avatar_conversations.content })
    .from(avatar_conversations)
    .where(eq(avatar_conversations.session_key, sessionKey))
    .orderBy(desc(avatar_conversations.created_at))
    .limit(MAX_TURNS);
  return rows.reverse().map((r) => ({ role: r.role === 'user' ? 'user' : 'persona', content: r.content }));
}

export async function getProfile(sessionKey: string): Promise<Record<string, unknown>> {
  const [row] = await db.select().from(avatar_profiles).where(eq(avatar_profiles.session_key, sessionKey)).limit(1);
  return (row?.facts as Record<string, unknown>) ?? {};
}

export async function saveTurns(
  sessionKey: string,
  characterId: string,
  projectId: string | null,
  turns: Turn[],
): Promise<void> {
  const recent = turns.slice(-MAX_TURNS).filter((t) => t.content && t.content.trim().length > 1);
  if (!recent.length) return;
  // Replace the stored window for this session to keep it bounded.
  await db.delete(avatar_conversations).where(eq(avatar_conversations.session_key, sessionKey)).catch(() => {});
  await db.insert(avatar_conversations).values(
    recent.map((t) => ({
      session_key: sessionKey,
      character_id: characterId,
      project_id: projectId,
      role: t.role === 'user' ? 'user' : 'persona',
      content: t.content.slice(0, 4000),
    })),
  ).catch((err) => logger.warn({ err }, '[AvatarMemory] saveTurns failed'));
}

export async function extractAndSaveFacts(sessionKey: string, turns: Turn[]): Promise<void> {
  const openai = await getOpenAIClient();
  if (!openai) return;
  const userText = turns.filter((t) => t.role === 'user').map((t) => t.content).join('\n').slice(0, 4000);
  if (userText.trim().length < 20) return;
  try {
    const resp = await openai.chat.completions.create({
      model: MODELS.memoryCompact,
      response_format: { type: 'json_object' },
      max_tokens: 300,
      temperature: 0.2,
      messages: [
        { role: 'system', content: 'Extract durable personal facts about the user from the conversation (name, interests, profession, goals, preferences). Respond ONLY with a flat JSON object of key→value strings. Omit anything uncertain. Empty object if nothing.' },
        { role: 'user', content: userText },
      ],
    });
    await recordChatUsage({
      userId: null, // viewer sessions are anonymous
      projectId: null,
      model: MODELS.memoryCompact,
      task: 'avatar_memory',
      usage: resp.usage,
    });
    const facts = JSON.parse(resp.choices[0]?.message?.content ?? '{}') as Record<string, unknown>;
    if (!facts || Object.keys(facts).length === 0) return;
    const existing = await getProfile(sessionKey);
    const merged = { ...existing, ...facts };
    await db
      .insert(avatar_profiles)
      .values({ session_key: sessionKey, facts: merged })
      .onConflictDoUpdate({ target: avatar_profiles.session_key, set: { facts: merged, updated_at: new Date() } });
  } catch (err) {
    logger.warn({ err: (err as Error).message }, '[AvatarMemory] fact extraction failed');
  }
}

// Builds the context string injected into the avatar at session start.
export async function buildMemoryContext(sessionKey: string): Promise<string> {
  const [turns, profile] = await Promise.all([getTurns(sessionKey), getProfile(sessionKey)]);
  const parts: string[] = [];
  if (Object.keys(profile).length) {
    const facts = Object.entries(profile).map(([k, v]) => `${k}: ${v}`).join(', ');
    parts.push(`What you remember about this person: ${facts}.`);
  }
  if (turns.length) {
    const recap = turns.slice(-6).map((t) => `${t.role === 'user' ? 'Visitor' : 'You'}: ${t.content}`).join('\n');
    parts.push(`Recent conversation:\n${recap}`);
  }
  return parts.join('\n\n');
}
