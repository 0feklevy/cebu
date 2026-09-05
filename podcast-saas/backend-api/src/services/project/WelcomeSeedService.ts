/**
 * Welcome-project seeding (migration 085) — every new user gets a personal, EDITABLE clone of
 * the shared "Welcome to Flow Video" template, plus their own playlist pointing at the clone
 * and at the shared niche films. Design: tutorial-kit/seeding/DESIGN.md.
 *
 * Zero heavy bytes per user: the clone re-uses the template's HLS tree and media blobs
 * (`shareHeavyBytes` through the duplication vocabulary); only the small sim packages, posters
 * and thumbnails are copied so the existing bridge-retarget machinery stays intact.
 *
 * SHIPS DARK by construction — three independent switches must all be on:
 *   1. WELCOME_SEED_ENABLED === 'true' env, OR admin_settings.welcome_seed_enabled (env wins
 *      when set at all, so an operator can force-off a mistakenly-enabled admin flag);
 *   2. WELCOME_TEMPLATE_PROJECT_ID env — absent = off;
 *   3. the template project actually existing and loading.
 *
 * Failure is never user-visible: every caller fires-and-forgets, and the projects-list backfill
 * retries users the trigger missed (crash between commit and stamp, feature enabled after
 * signup, template swapped).
 */
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { admin_settings, playlist_items, playlists, projects, users } from '../../db/schema.js';
import { logger } from '../../lib/logger.js';
import { ProjectDuplicationService } from './ProjectDuplicationService.js';

type SeedUser = { id: string; default_org_id: string | null };

const seenThisBoot = new Set<string>();

/** Tests only: the per-boot memo would otherwise leak between cases. */
export function __resetWelcomeSeedMemo(): void {
  seenThisBoot.clear();
}

export async function welcomeSeedEnabled(): Promise<boolean> {
  const env = process.env.WELCOME_SEED_ENABLED;
  if (env != null && env !== '') return env === 'true';
  const settings = await db.query.admin_settings.findFirst().catch(() => null);
  return settings?.welcome_seed_enabled === true;
}

/**
 * Seed the welcome project + playlist for one user. Idempotent at three layers:
 * the users pointer, the partial unique index on projects(created_by) WHERE is_welcome_seed,
 * and a per-boot memo so hot auth paths do not re-enter while a seed is in flight.
 * Never throws — callers are fire-and-forget by contract.
 */
export async function seedWelcomeProject(user: SeedUser, deps?: { dup?: ProjectDuplicationService }): Promise<void> {
  try {
    if (seenThisBoot.has(user.id)) return;
    const templateId = process.env.WELCOME_TEMPLATE_PROJECT_ID;
    if (!templateId) return;
    if (!(await welcomeSeedEnabled())) return;

    const row = await db.query.users.findFirst({ where: eq(users.id, user.id) });
    if (!row || row.welcome_project_id) { seenThisBoot.add(user.id); return; }
    // A template must never seed its own author — the system user that OWNS the template would
    // otherwise receive a clone of it on first login with the flag on.
    const template = await db.query.projects.findFirst({ where: eq(projects.id, templateId) });
    if (!template) { logger.warn({ templateId }, 'welcome seed: template project missing'); return; }
    if (template.created_by === user.id) { seenThisBoot.add(user.id); return; }

    seenThisBoot.add(user.id);
    const dup = deps?.dup ?? new ProjectDuplicationService();

    // A crashed earlier attempt may have committed the project but died before the stamp —
    // adopt rather than violate the partial index.
    const orphan = await db.query.projects.findFirst({
      where: and(eq(projects.created_by, user.id), eq(projects.is_welcome_seed, true)),
    });
    let cloneId = orphan?.id ?? null;

    if (!cloneId) {
      const snap = await dup.loadSnapshot(templateId);
      if (!snap) { logger.warn({ templateId }, 'welcome seed: template snapshot empty'); return; }
      const planned = dup.buildPlan(snap, { shareHeavyBytes: true });
      await dup.copyBytes(planned.plan);                       // small: sims + posters + thumbnail
      const retarget = await dup.retargetCopiedPackages(snap, planned);
      cloneId = await dup.commitRows(snap, planned, user.id, {
        retarget,
        shareHeavyBytes: true,
        orgId: user.default_org_id ?? undefined,
        title: template.title ?? 'Welcome to Flow Video',
        isWelcomeSeed: true,
      });
    }

    // Stamp the pointer (conditional — the index already guarantees a single winner; a lost
    // race simply leaves the winner's stamp in place).
    await db.update(users)
      .set({ welcome_project_id: cloneId })
      .where(and(eq(users.id, user.id), isNull(users.welcome_project_id)));

    // The user's playlist: the template playlist's items, with the template project swapped for
    // the user's own clone. Shared niche films ride as-is (public, watch-only).
    const templatePlaylistId = process.env.WELCOME_TEMPLATE_PLAYLIST_ID;
    if (templatePlaylistId && !row.welcome_playlist_id) {
      const tpl = await db.query.playlists.findFirst({ where: eq(playlists.id, templatePlaylistId) });
      const items = await db.select().from(playlist_items)
        .where(eq(playlist_items.playlist_id, templatePlaylistId));
      if (tpl && items.length) {
        const [pl] = await db.insert(playlists).values({
          org_id: user.default_org_id ?? tpl.org_id,
          created_by: user.id,
          title: tpl.title ?? 'Welcome to Flow Video',
          description: tpl.description,
          autoplay: tpl.autoplay,
          show_sidebar: tpl.show_sidebar,
          allow_shuffle: tpl.allow_shuffle,
        }).returning();
        await db.insert(playlist_items).values(items
          .sort((a, b) => a.position - b.position)
          .map((it) => ({
            playlist_id: pl.id,
            project_id: it.project_id === templateId ? cloneId! : it.project_id,
            position: it.position,
          })));
        await db.update(users)
          .set({ welcome_playlist_id: pl.id })
          .where(and(eq(users.id, user.id), isNull(users.welcome_playlist_id)));
      }
    }

    logger.info({ userId: user.id, cloneId }, 'welcome seed: complete');
  } catch (err) {
    // The partial unique index turns a two-request race into one winner + one benign error here.
    logger.warn({ err: String(err), userId: user.id }, 'welcome seed: failed (will retry on next projects list)');
  }
}
