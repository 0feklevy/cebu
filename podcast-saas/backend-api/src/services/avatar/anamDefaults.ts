import { db } from '../../db/index.js';
import { admin_settings } from '../../db/schema.js';
import { ANAM_ENV } from './anamService.js';

/**
 * The DEFAULT Anam look/brain — admin-first (077), env as fallback.
 *
 * Until 077 these were env-only module-load captures (`ANAM_ENV`), which made them invisible to
 * the one screen an operator actually checks and changeable only by SSH + restart. The 'guide'
 * outage was adjacent to exactly this invisibility. Owner directive: "כמה שיותר להקל על env".
 *
 * Cached briefly: this sits on the avatar start path, and the admin row changes at human speed.
 * Never throws — a broken read degrades to the env values, same rule as every resolver here.
 */
export interface AnamDefaults { avatarId: string; voiceId: string; llmId: string }

const TTL_MS = 60_000;
let cache: { v: AnamDefaults; at: number } | null = null;

export async function resolveAnamDefaults(): Promise<AnamDefaults> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.v;
  let row: { avatar_default_avatar_id: string | null; avatar_default_voice_id: string | null; avatar_default_llm_id: string | null } | undefined;
  try {
    [row] = await db.select({
      avatar_default_avatar_id: admin_settings.avatar_default_avatar_id,
      avatar_default_voice_id: admin_settings.avatar_default_voice_id,
      avatar_default_llm_id: admin_settings.avatar_default_llm_id,
    }).from(admin_settings).limit(1);
  } catch { /* keystore/db down → env fallback below */ }
  const v: AnamDefaults = {
    avatarId: row?.avatar_default_avatar_id || ANAM_ENV.ANAM_AVATAR_ID,
    voiceId: row?.avatar_default_voice_id || ANAM_ENV.ANAM_VOICE_ID,
    llmId: row?.avatar_default_llm_id || ANAM_ENV.ANAM_LLM_ID,
  };
  cache = { v, at: Date.now() };
  return v;
}

/** Test seam. */
export function invalidateAnamDefaultsCache(): void { cache = null; }
