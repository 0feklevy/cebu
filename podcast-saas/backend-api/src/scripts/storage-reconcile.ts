/**
 * storage-reconcile — the DB-vs-bucket diff, family by family, DRY-RUN BY DEFAULT.
 *
 * Usage (on the VM, inside the backend container, where the env is already set):
 *   docker compose exec backend pnpm --filter backend-api exec tsx src/scripts/storage-reconcile.ts --family=all
 *   … --family=multipart                         # the open multipart uploads and their ages
 *   … --family=exports --json=/tmp/exports.json  # one family, machine-readable
 *   … --family=exports --apply --delete --older-than=7d
 *                                                # delete this family's ORPHANS and REDUNDANT objects
 *                                                # older than a week, through the guarded chokepoint
 *   … --family=multipart --apply --older-than=7d # abort the multipart uploads older than a week
 *
 * Families (census section G): thumbnails, playlist-banners, captions, crop, exports, videos,
 * podcasts, avatar, dubs, editions, multipart. `videos/`, `hls/`, `editions/` and `blobs/` are
 * never apply targets (the uploads in flight, the HLS retention sweep's, the podcast masters, and
 * the blob sweeper's); they are reported only.
 *
 * Nothing is deleted without ALL of `--apply`, `--delete` and `--older-than=`; nothing younger than
 * the grace is ever touched; every delete goes through deleteWithFallback (the chokepoint), never
 * a raw adapter call. Refuses a transaction-pooler URL like the census runner: the reads are many.
 */
import { and, eq, isNotNull } from 'drizzle-orm';
import { writeFile } from 'node:fs/promises';
import { db } from '../db/index.js';
import { project_exports, video_files } from '../db/schema.js';
import { getStorageAdapter } from '../services/storage/getStorageAdapter.js';
import { deleteWithFallback } from '../services/storage/deleteWithFallback.js';
import {
  deletable, exportSectionsRule, inlineCaptionsRule, olderThan, parseAge, reconcileFamily, supersededRule,
  type BucketObject, type FamilyRefs, type FamilyReport, type RedundancyRule,
} from '../services/storage/reconcile.js';
import { sweepAbandonedMultipartUploads } from '../services/storage/multipartSweeper.js';
import { describeTransactionPooler } from '../db/migrate.js';

const ARGS = new Map(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k!, v ?? 'true']; }));
const FAMILY = ARGS.get('family') ?? 'all';
const APPLY = ARGS.get('apply') === 'true';
const DELETE = ARGS.get('delete') === 'true';
const OLDER = ARGS.get('older-than');
const JSON_OUT = ARGS.get('json');
const HEAD_LIMIT = Number(ARGS.get('head-limit') ?? '5000');

const nonNull = <T,>(xs: Array<T | null | undefined>): T[] => xs.filter((x): x is T => x != null);

interface Family {
  name: string;
  prefix: string;
  refs: () => Promise<FamilyRefs>;
  rule?: () => Promise<RedundancyRule>;
}

const FAMILIES: Family[] = [
  {
    name: 'thumbnails', prefix: 'thumbnails/',
    refs: async () => {
      const rows = await db.query.projects.findMany({ columns: { id: true, thumbnail_key: true } });
      return { keys: new Set(nonNull(rows.map((r) => r.thumbnail_key))), prefixes: new Set(rows.map((r) => `thumbnails/${r.id}`)) };
    },
    rule: async () => supersededRule('thumbnail'),
  },
  {
    name: 'playlist-banners', prefix: 'playlist-banners/',
    refs: async () => {
      const rows = await db.query.playlists.findMany({ columns: { id: true, banner_storage_key: true } });
      return { keys: new Set(nonNull(rows.map((r) => r.banner_storage_key))), prefixes: new Set(rows.map((r) => `playlist-banners/${r.id}`)) };
    },
    rule: async () => supersededRule('playlist banner'),
  },
  {
    name: 'captions', prefix: 'captions/',
    refs: async () => {
      const rows = await db.query.video_files.findMany({ columns: { id: true, project_id: true, captions_vtt_key: true } });
      return { keys: new Set(nonNull(rows.map((r) => r.captions_vtt_key))), prefixes: new Set(rows.map((r) => `captions/${r.project_id}/${r.id}`)) };
    },
    rule: async () => {
      const inline = await db.query.video_files.findMany({ where: isNotNull(video_files.captions_vtt), columns: { id: true } });
      return inlineCaptionsRule(new Set(inline.map((r) => r.id)));
    },
  },
  {
    name: 'crop', prefix: 'crop/',
    refs: async () => {
      const rows = await db.query.video_files.findMany({ columns: { id: true } });
      return { keys: new Set(rows.map((r) => `crop/${r.id}.json`)), prefixes: new Set() };
    },
  },
  {
    name: 'exports', prefix: 'exports/',
    refs: async () => {
      const rows = await db.query.project_exports.findMany({ columns: { id: true, project_id: true, output_key: true } });
      return { keys: new Set(nonNull(rows.map((r) => r.output_key))), prefixes: new Set(rows.map((r) => `exports/${r.project_id}/${r.id}`)) };
    },
    rule: async () => {
      const ready = await db.query.project_exports.findMany({ where: and(eq(project_exports.status, 'ready'), isNotNull(project_exports.output_key)), columns: { id: true, project_id: true } });
      return exportSectionsRule(new Set(ready.map((r) => `exports/${r.project_id}/${r.id}`)));
    },
  },
  {
    name: 'videos', prefix: 'videos/',
    refs: async () => {
      const rows = await db.query.video_files.findMany({ columns: { storage_key: true } });
      return { keys: new Set(nonNull(rows.map((r) => r.storage_key))), prefixes: new Set() };
    },
  },
  {
    name: 'podcasts', prefix: 'podcasts/',
    refs: async () => {
      const [sources, chunks, renders, clips] = await Promise.all([
        db.query.podcast_sources.findMany({ columns: { storage_key: true } }),
        db.query.podcast_chunk_audio.findMany({ columns: { storage_key: true } }),
        db.query.podcast_renders.findMany({ columns: { master_mp4_key: true, master_mp3_key: true, master_wav_key: true } }),
        db.query.podcast_clips.findMany({ columns: { storage_key: true } }),
      ]);
      const keys = new Set<string>([
        ...nonNull(sources.map((r) => r.storage_key)), ...nonNull(chunks.map((r) => r.storage_key)),
        ...nonNull(renders.flatMap((r) => [r.master_mp4_key, r.master_mp3_key, r.master_wav_key])),
        ...nonNull(clips.map((r) => r.storage_key)),
      ]);
      return { keys, prefixes: new Set() };
    },
  },
  {
    name: 'avatar', prefix: 'images/avatar/',
    refs: async () => {
      const rows = await db.query.avatar_visuals.findMany({ columns: { image_key: true, sim_storage_prefix: true } });
      return { keys: new Set(nonNull(rows.map((r) => r.image_key))), prefixes: new Set(nonNull(rows.map((r) => r.sim_storage_prefix))) };
    },
  },
  {
    name: 'dubs', prefix: 'dubs/',
    refs: async () => {
      const rows = await db.query.video_dubs.findMany({ columns: { audio_key: true, muxed_video_key: true, hls_master_key: true } });
      const keys = new Set(nonNull(rows.flatMap((r) => [r.audio_key, r.muxed_video_key])));
      // An HLS master names its whole tree: dubs/{videoId}/{lang}/hls/{dubId}/…
      const prefixes = new Set(nonNull(rows.map((r) => r.hls_master_key)).map((k) => k.slice(0, k.lastIndexOf('/'))));
      return { keys, prefixes };
    },
  },
  {
    name: 'editions', prefix: 'editions/',
    refs: async () => {
      const rows = await db.query.project_audio_editions.findMany({ columns: { m4a_key: true } });
      return { keys: new Set(nonNull(rows.map((r) => r.m4a_key))), prefixes: new Set() };
    },
  },
];

function human(n: number): string {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(2)} GiB`;
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MiB`;
  if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(0)} KiB`;
  return `${n} B`;
}

async function listWithHeads(prefix: string): Promise<BucketObject[]> {
  const storage = getStorageAdapter();
  const keys = await storage.listObjects(prefix);
  const out: BucketObject[] = [];
  let heads = 0;
  for (const key of keys) {
    if (heads < HEAD_LIMIT) {
      heads += 1;
      const h = await storage.headObject(key).catch(() => null);
      out.push({ key, size: h?.size ?? null, lastModified: h?.lastModified ?? null });
    } else {
      out.push({ key, size: null, lastModified: null });
    }
  }
  return out;
}

function printReport(r: FamilyReport): void {
  const sum = (xs: BucketObject[]) => human(xs.reduce((a, o) => a + (o.size ?? 0), 0));
  console.log(`\n== ${r.family}  (${r.prefix})  ${r.objects} objects, ${human(r.bytes)}`);
  console.log(`   referenced ${r.referenced.length}  |  orphan ${r.orphans.length} (${sum(r.orphans)})  |  redundant ${r.redundant.length} (${sum(r.redundant)})  |  dangling rows ${r.dangling.length}`);
  for (const o of [...r.orphans, ...r.redundant].slice(0, 25)) console.log(`   ${o.verdict.padEnd(9)} ${human(o.size ?? 0).padStart(10)}  ${o.lastModified ?? '?'}  ${o.key}  — ${o.reason}`);
  if (r.orphans.length + r.redundant.length > 25) console.log(`   … ${r.orphans.length + r.redundant.length - 25} more (see --json)`);
  for (const k of r.dangling.slice(0, 10)) console.log(`   dangling   ${k}`);
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? '';
  const pooler = describeTransactionPooler(url);
  if (pooler) throw new Error(`refusing a transaction-pooler DATABASE_URL for a long read: ${pooler}`);
  if (APPLY && !OLDER) throw new Error('--apply needs --older-than=<age> (e.g. 7d)');
  const graceMs = OLDER ? parseAge(OLDER) : null;

  const reports: FamilyReport[] = [];
  const wanted = FAMILY === 'all' ? [...FAMILIES.map((f) => f.name), 'multipart'] : [FAMILY];

  for (const name of wanted) {
    if (name === 'multipart') {
      const result = await sweepAbandonedMultipartUploads({ apply: APPLY, graceMs: graceMs ?? undefined });
      console.log(`\n== multipart  ${result.listed} open upload(s), ${result.abandoned.length} older than the grace${APPLY ? `, aborted ${result.aborted}, failed ${result.failed}` : ' (dry run)'}`);
      for (const u of result.abandoned.slice(0, 25)) console.log(`   ${u.initiated ?? '?'}  ${u.key}  ${u.uploadId.slice(0, 12)}…`);
      continue;
    }
    const family = FAMILIES.find((f) => f.name === name);
    if (!family) throw new Error(`unknown family '${name}' — one of ${[...FAMILIES.map((f) => f.name), 'multipart', 'all'].join(', ')}`);
    const [objects, refs, rule] = await Promise.all([listWithHeads(family.prefix), family.refs(), family.rule ? family.rule() : Promise.resolve(undefined)]);
    const report = reconcileFamily(family.name, family.prefix, objects, refs, rule);
    reports.push(report);
    printReport(report);

    if (APPLY && DELETE) {
      if (!deletable(family.name, family.prefix)) { console.log(`   (never an apply target: ${family.prefix} is another sweeper's)`); continue; }
      const targets = olderThan([...report.orphans, ...report.redundant], graceMs!);
      console.log(`   applying: ${targets.length} object(s) older than ${OLDER}`);
      let done = 0;
      for (const t of targets) { await deleteWithFallback(t.key); done += 1; }
      console.log(`   deleted ${done}`);
    }
  }

  if (JSON_OUT) {
    await writeFile(JSON_OUT, JSON.stringify({ generatedAt: new Date().toISOString(), apply: APPLY, reports }, null, 2));
    console.log(`\nwrote ${JSON_OUT}`);
  }
  if (!APPLY) console.log('\nDry run — nothing was deleted or aborted. Add --apply --delete --older-than=7d to act on a family.');
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
