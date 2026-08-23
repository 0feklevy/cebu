import { ApiKeyService } from '../secrets/ApiKeyService.js';

/** Shared instance so the admin key's cache actually caches across transcription calls. */
const systemKeys = new ApiKeyService();

/**
 * The Groq STT key, admin-first: Admin → API Keys → Groq wins, `GROQ_API_KEY` is the fallback.
 *
 * Until 077 this was the last vendor secret readable ONLY from the container env — rotating it
 * meant SSH and a restart, and the admin screen's silence about it was indistinguishable from
 * "not needed". Same pattern as the Anam key (#125), for the same reason. Never throws: a broken
 * keystore degrades to the env var.
 */
export async function resolveGroqKey(): Promise<string | null> {
  const adminKey = await systemKeys.getSystemKey('groq').catch(() => null);
  return adminKey ?? process.env.GROQ_API_KEY ?? null;
}
