/**
 * Creating, listing and deleting dubs — everything the controllers need, with no HTTP in it.
 *
 * Kept apart from `DubbingService` so that the thing which SPENDS money and the thing which lists
 * rows are not the same module: the controllers import only from here, and nothing in a request
 * path can reach the vendor client by accident.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { video_dubs, video_files } from '../../db/schema.js';
import type { VideoDub } from '../../db/schema.js';
import { logger } from '../../lib/logger.js';
import { enqueueJob } from '../../queue/index.js';
import { getStorageAdapter } from '../storage/getStorageAdapter.js';
import { publicApiOrigin } from '../../config/publicOrigins.js';
import { DUB_STATUS, dubSourceHash, shouldSkipDub } from './DubbingService.js';
import { normalizeDubbingLanguage, isSupportedDubbingLanguage, findDubbingLanguage } from './languages.js';
import { estimateDubbingCost, usdPerMinutePerLanguage } from './cost.js';
import { dubbingWatermarkPolicy, dubbingUsdPerCredit } from './config.js';

export const DUB_PROVIDER_ELEVENLABS = 'elevenlabs';

/** Public URL that serves a dub's DB-stored WebVTT, mirroring `captionVttRouteUrl`. */
export function dubCaptionUrl(videoId: string, language: string): string {
  return `${publicApiOrigin()}/api/v1/videos/${videoId}/captions/${encodeURIComponent(language)}.vtt`;
}

/**
 * Is this dub safe to serve to a viewer?
 *
 * `completed` alone is not the test. A watermarked dub is stored and paid for but must never reach
 * a viewer, and a dub with no HLS rendition has nothing to play. Both checks live here so that
 * every read path — player config, public routes, the creator UI — asks the same question.
 */
export function isDubServable(dub: Pick<VideoDub, 'status' | 'watermarked' | 'hls_master_key'>): boolean {
  return dub.status === DUB_STATUS.completed && !dub.watermarked && Boolean(dub.hls_master_key);
}

export interface DubView {
  id: string;
  video_file_id: string;
  language: string;
  language_name: string;
  language_endonym: string;
  rtl: boolean;
  provider: string;
  status: string;
  /** True only when this dub can actually be served — see `isDubServable`. */
  servable: boolean;
  hls_url: string | null;
  captions_url: string | null;
  cost_cents: number | null;
  error: string | null;
  updated_at: Date | null;
}

function toView(dub: VideoDub): DubView {
  const lang = findDubbingLanguage(dub.target_language);
  const storage = getStorageAdapter();
  const servable = isDubServable(dub);
  return {
    id: dub.id,
    video_file_id: dub.video_file_id,
    language: dub.target_language,
    language_name: lang?.name ?? dub.target_language,
    language_endonym: lang?.endonym ?? dub.target_language,
    rtl: lang?.rtl ?? false,
    provider: dub.provider,
    status: dub.status,
    servable,
    hls_url: servable && dub.hls_master_key ? storage.getPublicUrl(dub.hls_master_key) : null,
    captions_url: servable && dub.captions_vtt ? dubCaptionUrl(dub.video_file_id, dub.target_language) : null,
    cost_cents: dub.cost_cents,
    // A watermark refusal is the creator's business; a raw vendor message is not something a
    // viewer-facing surface should ever carry, which is why only the creator listing reads this.
    error: dub.status === DUB_STATUS.failed ? dub.error : null,
    updated_at: dub.updated_at,
  };
}

/** Every dub across a project's videos, for the creator UI. */
export async function listDubsForProject(projectId: string): Promise<DubView[]> {
  const videos = await db.query.video_files.findMany({
    where: eq(video_files.project_id, projectId),
    columns: { id: true, is_broll: true },
  });
  const ids = videos.filter((v) => !v.is_broll).map((v) => v.id);
  if (ids.length === 0) return [];
  const dubs = await db.query.video_dubs.findMany({ where: inArray(video_dubs.video_file_id, ids) });
  return dubs.map(toView);
}

/** Every dub of one video that is actually safe to serve, for the player's read path. */
export async function listServableDubsForVideo(videoId: string): Promise<VideoDub[]> {
  const dubs = await db.query.video_dubs.findMany({ where: eq(video_dubs.video_file_id, videoId) });
  return dubs.filter(isDubServable);
}

export interface DubCostEstimate {
  /** How many target languages this figure covers. */
  language_count: number;
  /** Total source seconds across every non-broll video in the project. */
  total_duration_sec: number;
  usd_per_minute_per_language: number;
  /** Cost of dubbing this project into ONE language — the UI multiplies by the selection. */
  usd_per_language: number;
  estimated_usd: number;
  estimated_credits: number;
  /** Whether the account's plan watermarks output — a watermarked dub is not published. */
  watermarked: boolean;
  /** Null unless the plan is undeclared, in which case this says what to set. */
  watermark_notice: string | null;
}

/**
 * What dubbing this project into these languages would cost, BEFORE anything is spent.
 *
 * Billing is per minute of source media PER LANGUAGE, so the total multiplies — which is exactly
 * the arithmetic a creator is most likely to get wrong, and the reason this is surfaced in the UI
 * ahead of the run rather than in an invoice afterwards.
 */
export async function estimateProjectDubCost(projectId: string, languageCount = 1): Promise<DubCostEstimate> {
  const videos = await db.query.video_files.findMany({
    where: eq(video_files.project_id, projectId),
    columns: { id: true, is_broll: true, duration_sec: true },
  });
  const totalSec = videos
    .filter((v) => !v.is_broll)
    .reduce((sum, v) => sum + (v.duration_sec ?? 0), 0);

  const policy = dubbingWatermarkPolicy();
  const usdPerCredit = dubbingUsdPerCredit();
  const cost = estimateDubbingCost({
    durationSec: totalSec,
    languageCount,
    watermarked: policy.watermarked,
    usdPerCredit,
  });
  const perLanguage = estimateDubbingCost({
    durationSec: totalSec,
    languageCount: 1,
    watermarked: policy.watermarked,
    usdPerCredit,
  });

  return {
    language_count: languageCount,
    total_duration_sec: totalSec,
    usd_per_minute_per_language: usdPerMinutePerLanguage(policy.watermarked, usdPerCredit),
    usd_per_language: perLanguage.usd,
    estimated_usd: cost.usd,
    estimated_credits: cost.credits,
    watermarked: policy.watermarked,
    watermark_notice: policy.watermarked ? policy.reason : null,
  };
}

export class UnsupportedDubLanguage extends Error {
  readonly code = 'unsupported_language' as const;
  constructor(tag: string) {
    super(`"${tag}" is not a language this product dubs into.`);
    this.name = 'UnsupportedDubLanguage';
  }
}

/**
 * Queue dubs of every main video in a project into one language.
 *
 * The row is created with `ON CONFLICT DO NOTHING` on the unique constraint, so requesting the same
 * language twice is a no-op rather than an error OR a second billed job — the request path and the
 * job path lean on the same constraint from opposite sides.
 */
export async function requestProjectDub(
  projectId: string,
  languageTag: string,
  opts: { force?: boolean } = {},
): Promise<DubView[]> {
  const language = normalizeDubbingLanguage(languageTag);
  if (!language || !isSupportedDubbingLanguage(languageTag)) {
    throw new UnsupportedDubLanguage(languageTag);
  }

  const videos = await db.query.video_files.findMany({ where: eq(video_files.project_id, projectId) });
  const targets = videos.filter((v) => !v.is_broll && v.storage_key);

  const created: VideoDub[] = [];
  for (const video of targets) {
    const hash = dubSourceHash(video);
    const [row] = await db.insert(video_dubs).values({
      video_file_id: video.id,
      target_language: language,
      provider: DUB_PROVIDER_ELEVENLABS,
      status: DUB_STATUS.queued,
      source_hash: hash,
    }).onConflictDoNothing({
      target: [video_dubs.video_file_id, video_dubs.target_language, video_dubs.provider],
    }).returning();

    const dub = row ?? await db.query.video_dubs.findFirst({
      where: and(
        eq(video_dubs.video_file_id, video.id),
        eq(video_dubs.target_language, language),
        eq(video_dubs.provider, DUB_PROVIDER_ELEVENLABS),
      ),
    });
    if (!dub) continue;

    // Ask the same pure gate the worker will ask. Enqueuing a job that would immediately bow out
    // costs a wakeup for nothing, and — for a forced re-run — would otherwise silently re-bill.
    const settled = shouldSkipDub({
      status: dub.status,
      hashMatches: dub.source_hash === hash,
      updatedAtMs: dub.updated_at?.getTime() ?? 0,
      force: opts.force,
    });
    if (!settled) {
      enqueueJob('dub', { dubId: dub.id, force: opts.force });
    }
    created.push(dub);
  }

  return created.map(toView);
}

/**
 * Delete a project's dubs in one language, and the bytes they own.
 *
 * Storage deletion is best-effort and happens BEFORE the row is dropped, because the row is the
 * only record of which keys exist — losing it first would orphan the objects permanently. A failed
 * delete is logged and the row still goes, since a stranded object is a smaller problem than a
 * dub the creator cannot get rid of.
 */
export async function deleteProjectDub(projectId: string, languageTag: string): Promise<number> {
  const language = normalizeDubbingLanguage(languageTag);
  if (!language) throw new UnsupportedDubLanguage(languageTag);

  const videos = await db.query.video_files.findMany({
    where: eq(video_files.project_id, projectId),
    columns: { id: true },
  });
  const ids = videos.map((v) => v.id);
  if (ids.length === 0) return 0;

  const dubs = await db.query.video_dubs.findMany({
    where: and(inArray(video_dubs.video_file_id, ids), eq(video_dubs.target_language, language)),
  });

  const storage = getStorageAdapter();
  for (const dub of dubs) {
    for (const key of [dub.audio_key, dub.muxed_video_key]) {
      if (!key) continue;
      await storage.deleteFile(key).catch((err: Error) => {
        logger.warn({ key, err: err.message?.slice(0, 160) }, '[dubbing] could not delete dub object');
      });
    }
    // The HLS tree is a prefix of many objects; the adapter deletes by key, so the master is
    // removed to make the rendition unplayable and the segment sweep reclaims the rest.
    if (dub.hls_master_key) {
      await storage.deleteFile(dub.hls_master_key).catch(() => {});
    }
    await db.delete(video_dubs).where(eq(video_dubs.id, dub.id));
  }

  return dubs.length;
}
