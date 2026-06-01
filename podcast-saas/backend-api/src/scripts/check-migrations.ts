import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/podcast_saas', { max: 1 });
const rows = await sql`SELECT filename FROM schema_migrations ORDER BY filename`;
console.log('Tracked migrations:');
rows.forEach(r => console.log(' ', r.filename));
await sql.end();
