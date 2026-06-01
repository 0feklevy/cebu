/**
 * READ-ONLY diagnostic: who owns the projects?
 * Run: pnpm --filter backend-api exec tsx --env-file=../.env src/scripts/who-owns-projects.ts
 *
 * Lists every user (id, email, firebase_uid) and every project's owner so we
 * can tell whether the currently-logged-in account matches the account that
 * created the existing projects. Performs only SELECTs — no writes.
 */
import postgres from 'postgres';

async function run() {
  const connectionString =
    process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/podcast_saas';
  const sql = postgres(connectionString, { max: 1 });

  try {
    console.log('\n── USERS ─────────────────────────────────────────────');
    const users = await sql`
      SELECT id, email, firebase_uid, is_admin, default_org_id, created_at, last_seen_at
      FROM users ORDER BY created_at
    `;
    for (const u of users) {
      console.log(
        `  ${(u.id as string).slice(0, 8)}…  email=${u.email ?? '(none)'}  ` +
        `fb_uid=${(u.firebase_uid as string | null)?.slice(0, 12) ?? '(none)'}…  ` +
        `admin=${u.is_admin}  last_seen=${u.last_seen_at ? new Date(u.last_seen_at as string).toISOString().slice(0, 16) : '(never)'}`,
      );
    }

    console.log('\n── PROJECTS WITH CONTENT (videos>0 or sections>0) ────');
    const projects = await sql`
      SELECT p.id, p.title, p.created_by, u.email AS owner_email,
             u.firebase_uid AS owner_fb_uid,
             COUNT(DISTINCT vf.id) AS videos,
             COUNT(DISTINCT ts.id) AS sections
      FROM projects p
      LEFT JOIN users u              ON u.id = p.created_by
      LEFT JOIN video_files vf       ON vf.project_id = p.id
      LEFT JOIN timeline_sections ts ON ts.project_id = p.id
      GROUP BY p.id, p.title, p.created_by, u.email, u.firebase_uid
      HAVING COUNT(DISTINCT vf.id) > 0 OR COUNT(DISTINCT ts.id) > 0
      ORDER BY videos DESC
    `;
    for (const p of projects) {
      console.log(
        `  proj ${(p.id as string).slice(0, 8)}…  videos=${p.videos} sections=${p.sections}  ` +
        `owner=${p.owner_email ?? '(MISSING USER!)'}  ` +
        `created_by=${(p.created_by as string | null)?.slice(0, 8) ?? '(null)'}…`,
      );
    }

    console.log('\n── PROJECT COUNT PER OWNER ───────────────────────────');
    const perOwner = await sql`
      SELECT COALESCE(u.email, '(missing user)') AS owner_email,
             p.created_by, COUNT(*) AS project_count
      FROM projects p
      LEFT JOIN users u ON u.id = p.created_by
      GROUP BY u.email, p.created_by
      ORDER BY project_count DESC
    `;
    for (const r of perOwner) {
      console.log(`  ${r.owner_email}  (${(r.created_by as string | null)?.slice(0, 8) ?? 'null'}…): ${r.project_count} projects`);
    }
    console.log('');
  } finally {
    await sql.end();
  }
}

run();
