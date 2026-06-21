import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { admin_settings, projects, users } from '../../db/schema.js';
import { decryptKey } from '../secrets/ApiKeyService.js';

/**
 * Resolve the Anam API key for a video/project: the owner's BYOK key when the
 * admin has enabled BYOK and the owner has set one, otherwise undefined (callers
 * fall back to the shared server key, ANAM_API_KEY). Never throws.
 */
export async function resolveAnamKeyForProject(projectId?: string | null): Promise<string | undefined> {
  if (!projectId) return undefined;
  const [settings] = await db.select({ byok: admin_settings.avatar_byok_enabled }).from(admin_settings).limit(1);
  if (!settings?.byok) return undefined;
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId), columns: { created_by: true } });
  if (!project?.created_by) return undefined;
  const owner = await db.query.users.findFirst({ where: eq(users.id, project.created_by), columns: { anam_api_key_encrypted: true } });
  if (!owner?.anam_api_key_encrypted) return undefined;
  try { return decryptKey(owner.anam_api_key_encrypted); } catch { return undefined; }
}
