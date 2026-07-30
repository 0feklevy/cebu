/**
 * Tag the avatar-circle faces of a project with explicit voice bands (male/female),
 * so the viewer's FFT/pitch speaker fallback attributes the wave to the right circle
 * on projects that have no scenes-derived speaker_timeline (uploaded videos with
 * manual circle sections).
 *
 *   Report:  tsx --env-file=../.env src/scripts/tag-circle-voices.ts <projectId|title-substring>
 *   Apply:   tsx --env-file=../.env src/scripts/tag-circle-voices.ts <projectId|title-substring> --apply [left=male] [right=female]
 *
 * Side assignments default to left=male right=female (the product's canonical
 * host_a/host_b pairing). Idempotent — re-applying the same tags is a no-op.
 */
import { db } from '../db/index.js';
import { projects } from '../db/schema.js';
import { eq, ilike } from 'drizzle-orm';
import type { AvatarCircleFace } from '../services/avatar/anamService.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main() {
  const args = process.argv.slice(2);
  const target = args.find((a) => !a.startsWith('--') && !a.includes('='));
  const apply = args.includes('--apply');
  if (!target) {
    console.error('Usage: tag-circle-voices.ts <projectId|title-substring> [--apply] [left=male] [right=female]');
    process.exit(1);
  }
  const sideVoice: Record<'left' | 'right', 'male' | 'female'> = { left: 'male', right: 'female' };
  for (const a of args) {
    const m = /^(left|right)=(male|female)$/.exec(a);
    if (m) sideVoice[m[1] as 'left' | 'right'] = m[2] as 'male' | 'female';
  }

  const rows = await db
    .select({ id: projects.id, title: projects.title, avatar_config: projects.avatar_config })
    .from(projects)
    .where(UUID_RE.test(target) ? eq(projects.id, target) : ilike(projects.title, `%${target}%`));

  if (rows.length === 0) { console.error(`No project matched "${target}"`); process.exit(1); }
  if (rows.length > 1 && apply) {
    console.error(`Refusing to --apply: ${rows.length} projects matched "${target}". Use the project id.`);
    rows.forEach((r) => console.error(`  ${r.id}  ${r.title}`));
    process.exit(1);
  }

  for (const row of rows) {
    const cfg = (row.avatar_config ?? {}) as Record<string, unknown>;
    const circles = cfg.avatarCircles as { faces?: AvatarCircleFace[] } | undefined;
    if (!circles?.faces?.length) {
      console.log(`${row.id}  "${row.title}": no avatarCircles.faces — skipped`);
      continue;
    }
    const next = circles.faces.map((f) => ({ ...f, voice: sideVoice[f.side] ?? f.voice }));
    const changed = JSON.stringify(next) !== JSON.stringify(circles.faces);
    console.log(`${row.id}  "${row.title}"`);
    console.log(`  faces: ${JSON.stringify(circles.faces)}`);
    console.log(`  →      ${JSON.stringify(next)}  ${changed ? '' : '(no change)'}`);
    if (apply && changed) {
      const updated = { ...cfg, avatarCircles: { ...circles, faces: next } };
      await db.update(projects).set({ avatar_config: updated, updated_at: new Date() }).where(eq(projects.id, row.id));
      console.log('  APPLIED');
    }
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
