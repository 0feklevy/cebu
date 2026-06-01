import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/podcast_saas', { max: 1 });

const untracked = [
  '014_clip_source.sql',
  '015_bridge_plan_prompt.sql',
  '016_share_token.sql',
  '017_broll_audio.sql',
];

for (const f of untracked) {
  const [row] = await sql`SELECT filename FROM schema_migrations WHERE filename = ${f}`;
  if (!row) {
    await sql`INSERT INTO schema_migrations (filename) VALUES (${f})`;
    console.log('Marked as applied:', f);
  } else {
    console.log('Already tracked:', f);
  }
}
await sql.end();
console.log('Done');
