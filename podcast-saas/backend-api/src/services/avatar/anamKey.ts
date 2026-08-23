import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { admin_settings, projects, users } from '../../db/schema.js';
import { ApiKeyService, decryptKey } from '../secrets/ApiKeyService.js';

/** One shared instance so the admin key's 5-minute cache actually caches across starts. */
const systemKeys = new ApiKeyService();

/**
 * The platform Anam key an admin manages from Admin → API Keys, with the env var as fallback.
 *
 * 2026-08-23: this lookup DID NOT EXIST. Every other vendor read the admin-stored key first, the
 * avatar read only `ANAM_API_KEY` from the container env — so rotating the key in the admin screen
 * silently changed nothing, and every viewer's mint kept failing on the stale env key while the
 * screen said the key was set. Never throws; a broken keystore falls back to the env var.
 */
export async function resolveSystemAnamKey(): Promise<string | undefined> {
  const adminKey = await systemKeys.getSystemKey('anam').catch(() => null);
  return adminKey ?? undefined;
}

/**
 * Resolve the Anam API key for a video/project, in trust order:
 *   1. the OWNER's BYOK key — when the admin has enabled BYOK and the owner set one;
 *   2. the PLATFORM key stored in Admin → API Keys;
 *   3. undefined — callers fall back to the env var, ANAM_API_KEY.
 * Never throws.
 *
 * `ownerId` lets a caller that has already loaded the project row (every /avatar/start does — it
 * needs created_by to authorize) skip a second read of the same row.
 */
export async function resolveAnamKeyForProject(projectId?: string | null, ownerId?: string | null): Promise<string | undefined> {
  const byok = projectId ? await resolveOwnerByokKey(projectId, ownerId) : undefined;
  return byok ?? resolveSystemAnamKey();
}

async function resolveOwnerByokKey(projectId: string, ownerId?: string | null): Promise<string | undefined> {
  const [settings] = await db.select({ byok: admin_settings.avatar_byok_enabled }).from(admin_settings).limit(1);
  if (!settings?.byok) return undefined;
  let createdBy = ownerId ?? null;
  if (!createdBy) {
    const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId), columns: { created_by: true } });
    createdBy = project?.created_by ?? null;
  }
  if (!createdBy) return undefined;
  const owner = await db.query.users.findFirst({ where: eq(users.id, createdBy), columns: { anam_api_key_encrypted: true } });
  if (!owner?.anam_api_key_encrypted) return undefined;
  try { return decryptKey(owner.anam_api_key_encrypted); } catch { return undefined; }
}
