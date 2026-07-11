// The avatar's visual Library — postgres-backed replacement for the darwin
// Supabase image_bank. Holds both the "basic" library (assets the editor put in
// the project) and the "extended" library (visuals the avatar generated on the
// fly and stored for reuse). All media lives in podcast-saas storage (R2/local).
import { randomUUID } from 'crypto';
import { and, or, eq, isNull, desc, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { avatar_visuals, image_files, simulations, type AvatarVisual } from '../../db/schema.js';
import { getStorageAdapter } from '../storage/getStorageAdapter.js';
import { uploadWithFallback } from '../storage/uploadWithFallback.js';
import { DEFAULT_CHARACTER_ID } from './characters.js';
import { logger } from '../../lib/logger.js';

export type AvatarVisualRow = AvatarVisual;

export const DEDUP_DISTANCE = 0.12;   // retained for signature parity (text dedup is exact)

export function normalizeKey(s: string): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

// Scope predicate: this project's assets + the global library.
function projectScope(projectId?: string | null) {
  if (projectId) {
    return or(eq(avatar_visuals.project_id, projectId), isNull(avatar_visuals.project_id));
  }
  return isNull(avatar_visuals.project_id);
}

export interface FindVisualOpts {
  lookupKey: string;
  visualType?: string;
  characterId: string;
  projectId?: string | null;
}

// Exact normalized-key lookup (used for dedup + retrieval). Prefers the most-used,
// then the most-recent. Falls back to a loose prefix match for retrieval.
export async function findVisual(opts: FindVisualOpts): Promise<AvatarVisualRow | null> {
  const key = normalizeKey(opts.lookupKey);
  if (!key) return null;

  const conds = [projectScope(opts.projectId), eq(avatar_visuals.character_id, opts.characterId)];
  if (opts.visualType) conds.push(eq(avatar_visuals.visual_type, opts.visualType));

  // 1. exact normalized-key match
  const exact = await db
    .select()
    .from(avatar_visuals)
    .where(and(...conds, eq(avatar_visuals.lookup_key, key)))
    .orderBy(desc(avatar_visuals.use_count), desc(avatar_visuals.created_at))
    .limit(1);
  if (exact[0]) return exact[0];

  // 2. loose containment match (first ~6 words) — retrieval only
  const head = key.split(' ').slice(0, 6).join(' ');
  if (head.length >= 8) {
    const loose = await db
      .select()
      .from(avatar_visuals)
      .where(and(...conds, sql`${avatar_visuals.lookup_key} ILIKE ${'%' + head + '%'}`))
      .orderBy(desc(avatar_visuals.use_count), desc(avatar_visuals.created_at))
      .limit(1);
    if (loose[0]) return loose[0];
  }
  return null;
}

// ── Context-relevance retrieval ────────────────────────────────────────────────
// Prefers existing Library visuals over generating new ones. Editor-curated
// "basic" items get higher privilege than avatar-generated "extended" items.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'your', 'with', 'this', 'that',
  'have', 'has', 'had', 'was', 'were', 'will', 'would', 'can', 'could', 'should',
  'what', 'when', 'where', 'which', 'who', 'how', 'why', 'about', 'into', 'from',
  'they', 'them', 'their', 'there', 'here', 'just', 'like', 'more', 'some', 'such',
  'than', 'then', 'these', 'those', 'over', 'also', 'show', 'tell', 'explain', 'lets',
  'let', 'see', 'look', 'want', 'know', 'think', 'really', 'very', 'much', 'many',
]);

// Words naming the visual TYPE, not the topic — stripped so "ising simulation"
// matches an "ising" asset on the topic word alone.
const TYPE_WORDS = new Set([
  'simulation', 'simulations', 'simulate', 'chart', 'charts', 'graph', 'graphs',
  'plot', 'plots', 'diagram', 'diagrams', 'flowchart', 'equation', 'equations',
  'formula', 'formulas', 'image', 'images', 'picture', 'pictures', 'photo',
  'photograph', 'visual', 'visuals', 'visualize', 'visualise', 'display', 'render',
]);

function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of (text ?? '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= 4 && !STOPWORDS.has(raw) && !TYPE_WORDS.has(raw)) out.add(raw);
  }
  return out;
}

export interface RelevantVisualOpts {
  message: string;
  context?: string;
  projectId?: string | null;
  visualType?: string;   // restrict to this type when the viewer explicitly asked
}

// Returns the most relevant Library visual for the current utterance, or null.
// Basic (editor) items outrank extended items among everything that clears the
// keyword-overlap bar, so curated assets are shown before anything new is made.
export async function findRelevantLibraryVisual(opts: RelevantVisualOpts): Promise<AvatarVisualRow | null> {
  const queryTokens = tokenize(`${opts.message} ${opts.context ?? ''}`);
  if (queryTokens.size === 0) return null;

  const conds = [projectScope(opts.projectId)];
  if (opts.visualType) conds.push(eq(avatar_visuals.visual_type, opts.visualType));

  const candidates = await db
    .select()
    .from(avatar_visuals)
    .where(and(...conds))
    .orderBy(desc(avatar_visuals.use_count), desc(avatar_visuals.created_at))
    .limit(400);

  let best: { row: AvatarVisualRow; rank: number; score: number } | null = null;
  for (const row of candidates) {
    // A renderable row only — skip empties.
    const renderable = (row.visual_type === 'image' && row.image_url)
      || (row.visual_type === 'simulation' && (row.sim_entry_url || (row.visual_spec as { html?: string } | null)?.html))
      || (row.visual_spec && (row.visual_spec as { type?: string }).type);
    if (!renderable) continue;

    const candTokens = tokenize(`${row.caption ?? ''} ${row.alt_text ?? ''} ${row.lookup_key ?? ''}`);
    if (candTokens.size === 0) continue;

    let overlap = 0;
    for (const t of queryTokens) if (candTokens.has(t)) overlap++;
    if (overlap === 0) continue;
    const matchRatio = overlap / queryTokens.size;

    const isBasic = row.scope === 'basic' || row.source === 'editor';
    // Basic (editor-curated for THIS video) gets the lowest bar — a single topic
    // word is enough, since the conversation is about this video's content.
    // Extended (global) needs more signal to avoid cross-topic false positives.
    const qualifies = isBasic
      ? overlap >= 1
      : (overlap >= 2 || matchRatio >= 0.5);
    if (!qualifies) continue;

    const rank = isBasic ? 0 : 1;                 // basic outranks extended
    const score = overlap + matchRatio + (isBasic ? 1 : 0) + Math.min(row.use_count, 5) * 0.1;

    if (!best || rank < best.rank || (rank === best.rank && score > best.score)) {
      best = { row, rank, score };
    }
  }
  return best?.row ?? null;
}

export async function isDuplicateVisual(
  lookupKey: string,
  visualType: string,
  characterId: string,
  projectId?: string | null,
): Promise<boolean> {
  const hit = await findVisual({ lookupKey, visualType, characterId, projectId }).catch(() => null);
  return Boolean(hit);
}

export async function incrementUseCount(id: string): Promise<void> {
  await db
    .update(avatar_visuals)
    .set({ use_count: sql`${avatar_visuals.use_count} + 1` })
    .where(eq(avatar_visuals.id, id))
    .catch((err) => logger.warn({ err, id }, '[AvatarLibrary] incrementUseCount failed'));
}

export interface InsertVisualParams {
  projectId?: string | null;
  scope?: 'basic' | 'extended';
  source?: 'editor' | 'generated' | 'uploaded';
  characterId: string;
  visualType: string;
  lookupKey?: string;
  caption?: string;
  altText?: string;
  imageUrl?: string | null;
  imageKey?: string | null;
  dallePrompt?: string | null;
  visualSpec?: Record<string, unknown> | null;
  simStoragePrefix?: string | null;
  simEntryUrl?: string | null;
  createdBy?: string | null;
}

export async function insertVisual(p: InsertVisualParams): Promise<AvatarVisualRow | null> {
  try {
    const [row] = await db
      .insert(avatar_visuals)
      .values({
        project_id:         p.projectId ?? null,
        scope:              p.scope ?? 'extended',
        source:             p.source ?? 'generated',
        character_id:       p.characterId,
        visual_type:        p.visualType,
        lookup_key:         p.lookupKey ? normalizeKey(p.lookupKey) : null,
        caption:            p.caption ?? null,
        alt_text:           p.altText ?? null,
        image_url:          p.imageUrl ?? null,
        image_key:          p.imageKey ?? null,
        dalle_prompt:       p.dallePrompt ?? null,
        visual_spec:        p.visualSpec ?? null,
        sim_storage_prefix: p.simStoragePrefix ?? null,
        sim_entry_url:      p.simEntryUrl ?? null,
        created_by:         p.createdBy ?? null,
      })
      .returning();
    return row ?? null;
  } catch (err) {
    logger.warn({ err }, '[AvatarLibrary] insertVisual failed');
    return null;
  }
}

export interface ListVisualsOpts {
  projectId?: string | null;
  includeGlobal?: boolean;
  scope?: 'basic' | 'extended';
  type?: string;
  character?: string;
  q?: string;
  page?: number;
  limit?: number;
}

export async function listVisuals(opts: ListVisualsOpts): Promise<{
  items: AvatarVisualRow[];
  total: number;
  typeCounts: Record<string, number>;
}> {
  const page = Math.max(1, opts.page ?? 1);
  const limit = Math.min(60, Math.max(1, opts.limit ?? 24));

  const conds = [];
  if (opts.projectId && opts.includeGlobal) conds.push(projectScope(opts.projectId));
  else if (opts.projectId) conds.push(eq(avatar_visuals.project_id, opts.projectId));
  else conds.push(isNull(avatar_visuals.project_id));
  if (opts.scope) conds.push(eq(avatar_visuals.scope, opts.scope));
  if (opts.type) conds.push(eq(avatar_visuals.visual_type, opts.type));
  if (opts.character) conds.push(eq(avatar_visuals.character_id, opts.character));
  if (opts.q) conds.push(sql`(${avatar_visuals.caption} ILIKE ${'%' + opts.q + '%'} OR ${avatar_visuals.lookup_key} ILIKE ${'%' + opts.q + '%'})`);

  const whereClause = conds.length ? and(...conds) : undefined;

  const items = await db
    .select()
    .from(avatar_visuals)
    .where(whereClause)
    .orderBy(desc(avatar_visuals.created_at))
    .limit(limit)
    .offset((page - 1) * limit);

  const totalRows = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(avatar_visuals)
    .where(whereClause);
  const total = totalRows[0]?.c ?? 0;

  const typeRows = await db
    .select({ t: avatar_visuals.visual_type, c: sql<number>`count(*)::int` })
    .from(avatar_visuals)
    .where(whereClause)
    .groupBy(avatar_visuals.visual_type);
  const typeCounts: Record<string, number> = {};
  for (const r of typeRows) typeCounts[r.t] = r.c;

  return { items, total, typeCounts };
}

export async function getVisual(id: string): Promise<AvatarVisualRow | null> {
  const [row] = await db.select().from(avatar_visuals).where(eq(avatar_visuals.id, id)).limit(1);
  return row ?? null;
}

export async function updateVisual(
  id: string,
  updates: { caption?: string; altText?: string; visualSpec?: Record<string, unknown>; scope?: 'basic' | 'extended' },
): Promise<boolean> {
  const set: Record<string, unknown> = {};
  if (updates.caption !== undefined) set.caption = updates.caption;
  if (updates.altText !== undefined) set.alt_text = updates.altText;
  if (updates.visualSpec !== undefined) set.visual_spec = updates.visualSpec;
  if (updates.scope !== undefined) set.scope = updates.scope;
  if (Object.keys(set).length === 0) return false;
  const res = await db.update(avatar_visuals).set(set).where(eq(avatar_visuals.id, id)).returning({ id: avatar_visuals.id });
  return res.length > 0;
}

export async function deleteVisual(id: string): Promise<boolean> {
  const row = await getVisual(id);
  if (!row) return false;
  // Editor-sourced ("basic") rows mirror the project's own media (managed in the
  // normal editor) — never delete the underlying storage for those, only the row.
  if (row.source !== 'editor') {
    const storage = getStorageAdapter();
    if (row.image_key) await storage.deleteFile(row.image_key).catch(() => {});
    if (row.sim_storage_prefix) await storage.deleteWithPrefix(row.sim_storage_prefix).catch(() => {});
  }
  const res = await db.delete(avatar_visuals).where(eq(avatar_visuals.id, id)).returning({ id: avatar_visuals.id });
  return res.length > 0;
}

// ── Basic-library auto-sync ─────────────────────────────────────────────────────
// Mirrors the project's editor media (images + ready simulations) into the
// per-project "basic" library. Idempotent and throttled — replaces the old manual
// "import basic" button. Basic items + the global extended library together form
// the pool the avatar draws from at runtime (basic preferred).
const lastSyncAt = new Map<string, number>();
const SYNC_THROTTLE_MS = 60_000;

export async function syncBasicLibrary(projectId: string, force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - (lastSyncAt.get(projectId) ?? 0) < SYNC_THROTTLE_MS) return;
  lastSyncAt.set(projectId, now);

  try {
    const [imgs, sims, existing] = await Promise.all([
      db.query.image_files.findMany({ where: eq(image_files.project_id, projectId) }),
      db.query.simulations.findMany({ where: eq(simulations.project_id, projectId) }),
      db.select().from(avatar_visuals).where(and(
        eq(avatar_visuals.project_id, projectId),
        eq(avatar_visuals.scope, 'basic'),
        eq(avatar_visuals.source, 'editor'),
      )),
    ]);

    const storage = getStorageAdapter();
    // entry_file is a STORAGE KEY (e.g. simulations/<proj>/<sim>/index.html), not a
    // URL — wrap it with getSimPublicUrl exactly like the player does, so the avatar
    // can load it in an iframe (a bare key would 404 against the frontend origin).
    const simUrl = (s: typeof sims[number]) => /^https?:\/\//i.test(s.entry_file) ? s.entry_file : storage.getSimPublicUrl(s.entry_file);

    const haveImageKeys = new Set(existing.filter((r) => r.visual_type === 'image').map((r) => r.image_key));
    const haveSimUrls = new Set(existing.filter((r) => r.visual_type === 'simulation').map((r) => r.sim_entry_url));
    const liveImageKeys = new Set(imgs.map((i) => i.storage_key));
    const liveSimUrls = new Set(sims.map(simUrl));

    // insert any new project media
    for (const img of imgs) {
      if (haveImageKeys.has(img.storage_key)) continue;
      await insertVisual({
        projectId, scope: 'basic', source: 'editor', characterId: DEFAULT_CHARACTER_ID,
        visualType: 'image', lookupKey: img.filename, caption: img.filename, altText: img.filename,
        imageUrl: img.original_url, imageKey: img.storage_key, visualSpec: { imageType: 'realistic' },
      });
    }
    for (const sim of sims) {
      if (sim.status !== 'ready' && sim.status !== 'done') continue;
      const entryUrl = simUrl(sim);
      if (haveSimUrls.has(entryUrl)) continue;
      await insertVisual({
        projectId, scope: 'basic', source: 'editor', characterId: DEFAULT_CHARACTER_ID,
        visualType: 'simulation', lookupKey: sim.name, caption: sim.name,
        simStoragePrefix: sim.storage_prefix, simEntryUrl: entryUrl,
        visualSpec: { type: 'simulation', caption: sim.name },
      });
    }
    // remove basic rows whose source media no longer exists in the project
    for (const r of existing) {
      const orphan = (r.visual_type === 'image' && r.image_key && !liveImageKeys.has(r.image_key))
        || (r.visual_type === 'simulation' && r.sim_entry_url && !liveSimUrls.has(r.sim_entry_url));
      if (orphan) await db.delete(avatar_visuals).where(eq(avatar_visuals.id, r.id)).catch(() => {});
    }
  } catch (err) {
    logger.warn({ err, projectId }, '[AvatarLibrary] syncBasicLibrary failed');
  }
}

// ── Media storage helpers ──────────────────────────────────────────────────────

// Stores a base64 PNG to the public images/ prefix. Returns the browser URL + key.
export async function storeImageB64(b64: string, projectId?: string | null): Promise<{ url: string; key: string }> {
  const key = `images/avatar/${projectId ?? 'global'}/${randomUUID()}.png`;
  const url = await uploadWithFallback(key, Buffer.from(b64, 'base64'), 'image/png');
  return { url, key };
}

export async function storeImageBuffer(
  data: Buffer,
  contentType: string,
  projectId?: string | null,
  extension = 'bin',
): Promise<{ url: string; key: string }> {
  const safeExt = extension.toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
  const key = `images/avatar/uploads/${projectId ?? 'global'}/${randomUUID()}.${safeExt}`;
  const url = await uploadWithFallback(key, data, contentType);
  return { url, key };
}

// Stores a full HTML simulation as a single-file entry. Returns prefix + public URL.
export async function storeSimulationHtml(html: string, projectId?: string | null): Promise<{ prefix: string; url: string }> {
  const id = randomUUID();
  const prefix = `simulations/avatar/${id}`;
  const key = `${prefix}/index.html`;
  await uploadWithFallback(key, Buffer.from(html, 'utf-8'), 'text/html; charset=utf-8');
  return { prefix, url: getStorageAdapter().getSimPublicUrl(key) };
}
