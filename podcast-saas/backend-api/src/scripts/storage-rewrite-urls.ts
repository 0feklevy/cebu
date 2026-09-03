/**
 * storage-rewrite-urls — move the URL-bearing columns from one public base to another, DRY-RUN
 * BY DEFAULT, only where the object already exists at the destination.
 *
 *   pnpm --filter backend-api storage:rewrite-urls -- --from=https://x.supabase.co/storage/v1/object/public/bucket --to=https://media.example.com
 *   … --apply                                  # write the rows (idempotent; re-runnable)
 *   … --to=… --from=… --limit=200              # a first slice
 *
 * Step 4 of the staged R2 migration (owner ruling 2026-09-03; plan §5). The bytes are copied
 * first (rclone); this rewrites what the database still says, one row at a time, and only when a
 * HEAD on the destination adapter confirms the object is there — a row is never pointed at
 * nothing. Resumable by construction: a row already under the TO base plans nothing.
 */
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { audio_files, avatar_visuals, corpora, image_files, playlists, projects, simulations } from '../db/schema.js';
import { getStorageAdapter } from '../services/storage/getStorageAdapter.js';
import { planUrlRewrite, rewriteJsonUrls, type RewritePlan } from '../services/storage/urlRewrite.js';
import { describeTransactionPooler } from '../db/migrate.js';

const ARGS = new Map(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k!, v ?? 'true']; }));
const FROM = (ARGS.get('from') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const TO = ARGS.get('to') ?? '';
const APPLY = ARGS.get('apply') === 'true';
const LIMIT = Number(ARGS.get('limit') ?? '0') || 0;

interface Column { table: string; id: string; column: string; current: unknown; write: (next: unknown) => Promise<void> }

async function columns(): Promise<Column[]> {
  const out: Column[] = [];
  const add = <T extends { id: string }>(table: string, rows: T[], column: keyof T & string, write: (id: string, next: unknown) => Promise<void>) => {
    for (const r of rows) out.push({ table, id: r.id, column, current: r[column], write: (next) => write(r.id, next) });
  };
  add('projects', await db.query.projects.findMany({ columns: { id: true, thumbnail_url: true } }), 'thumbnail_url', async (id, next) => { await db.update(projects).set({ thumbnail_url: next as string }).where(eq(projects.id, id)); });
  add('image_files', await db.query.image_files.findMany({ columns: { id: true, original_url: true } }), 'original_url', async (id, next) => { await db.update(image_files).set({ original_url: next as string }).where(eq(image_files.id, id)); });
  add('audio_files', await db.query.audio_files.findMany({ columns: { id: true, url: true } }), 'url', async (id, next) => { await db.update(audio_files).set({ url: next as string }).where(eq(audio_files.id, id)); });
  add('playlists', await db.query.playlists.findMany({ columns: { id: true, banner_url: true } }), 'banner_url', async (id, next) => { await db.update(playlists).set({ banner_url: next as string }).where(eq(playlists.id, id)); });
  add('corpora', await db.query.corpora.findMany({ columns: { id: true, storage_url: true } }), 'storage_url', async (id, next) => { await db.update(corpora).set({ storage_url: next as string }).where(eq(corpora.id, id)); });
  const visuals = await db.query.avatar_visuals.findMany({ columns: { id: true, image_url: true, sim_entry_url: true } });
  add('avatar_visuals', visuals, 'image_url', async (id, next) => { await db.update(avatar_visuals).set({ image_url: next as string }).where(eq(avatar_visuals.id, id)); });
  add('avatar_visuals', visuals, 'sim_entry_url', async (id, next) => { await db.update(avatar_visuals).set({ sim_entry_url: next as string }).where(eq(avatar_visuals.id, id)); });
  const sims = await db.query.simulations.findMany({ columns: { id: true, entry_file: true, guidance: true, guidance_meta: true } });
  add('simulations', sims, 'entry_file', async (id, next) => { await db.update(simulations).set({ entry_file: next as string }).where(eq(simulations.id, id)); });
  add('simulations', sims, 'guidance', async (id, next) => { await db.update(simulations).set({ guidance: next as never }).where(eq(simulations.id, id)); });
  add('simulations', sims, 'guidance_meta', async (id, next) => { await db.update(simulations).set({ guidance_meta: next as never }).where(eq(simulations.id, id)); });
  return out;
}

async function main(): Promise<void> {
  if (FROM.length === 0 || !TO) throw new Error('--from=<base>[,<base>] and --to=<base> are required');
  const pooler = describeTransactionPooler(process.env.DATABASE_URL ?? '');
  if (pooler) throw new Error(`refusing a transaction-pooler DATABASE_URL: ${pooler}`);
  const storage = getStorageAdapter();

  let planned = 0, written = 0, skippedMissing = 0, untouched = 0;
  const missing: RewritePlan[] = [];
  for (const col of await columns()) {
    if (LIMIT && planned >= LIMIT) break;
    let next: unknown;
    let plans: RewritePlan[];
    if (typeof col.current === 'string') {
      const p = planUrlRewrite(col.current, FROM, TO);
      if (!p) { untouched += 1; continue; }
      next = p.to; plans = [p];
    } else if (col.current && typeof col.current === 'object') {
      const r = rewriteJsonUrls(col.current, FROM, TO);
      if (r.plans.length === 0) { untouched += 1; continue; }
      next = r.value; plans = r.plans;
    } else { untouched += 1; continue; }

    // Every key the row would now name must already exist at the destination.
    const absent: RewritePlan[] = [];
    for (const p of plans) if (!(await storage.objectExists(p.key))) absent.push(p);
    if (absent.length) { skippedMissing += 1; missing.push(...absent); continue; }

    planned += 1;
    console.log(`${APPLY ? 'WRITE' : 'PLAN '} ${col.table}.${col.column} ${col.id}  ${plans.length} url(s)`);
    if (APPLY) { await col.write(next); written += 1; }
  }
  console.log(`\nplanned ${planned}, written ${written}, skipped (object missing at destination) ${skippedMissing}, untouched ${untouched}`);
  for (const m of missing.slice(0, 20)) console.log(`  missing at destination: ${m.key}`);
  if (!APPLY) console.log('\nDry run — no row was written. Add --apply to write.');
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
