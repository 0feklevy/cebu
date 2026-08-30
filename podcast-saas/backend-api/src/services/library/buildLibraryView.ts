/**
 * buildLibraryView — the `buildPlayerConfig` analogue for the public materials page.
 *
 * It reads the same four asset tables the editor bootstrap reads and returns a PUBLIC-ONLY view
 * model. The single most important property of this file is what it does NOT emit, so it is stated
 * as a rule rather than left to inspection:
 *
 *   every material object is CONSTRUCTED FIELD BY FIELD. No database row is ever spread into a
 *   response. That is why no storage key, no share code, no `project_id`, no `org_id`, no
 *   `created_by`, no `bridge_functions`, no `guidance` and no `canary_report` can reach a visitor —
 *   not because each was remembered and stripped, but because nothing arrives unless it is written
 *   out here by name. The backend suite asserts this over the whole serialized response.
 *
 * Two more rules with teeth:
 *   - Only `status='ready'` material is emitted. A half-uploaded video and a failed simulation are
 *     INVISIBLE, not broken tiles.
 *   - `include_types` is enforced in the READ. An excluded type is absent from the payload and its
 *     sub-route 404s; it is never present-but-hidden, because client-side hiding of data the server
 *     already sent is not scope control.
 *
 * Zero bytes are written anywhere. Every URL below already exists and is simply re-emitted.
 */
import { desc, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { audio_files, image_files, sim_posters, simulations, video_files } from '../../db/schema.js';
import { getStorageAdapter } from '../storage/getStorageAdapter.js';
import { captionUrlForVideo } from '../captions/CaptionService.js';
import { publicApiOrigin } from '../../config/publicOrigins.js';
import { logger } from '../../lib/logger.js';
import {
  parsePosterVariants, selectPosterVariant, type PosterFormat,
} from 'shared/sim/posterIdentity';
import { packageRevisionFor } from 'shared/sim/simRevision';
import { derivePackageRevision } from 'shared/sim/simIdentity';
import type {
  LibraryCounts, LibraryMaterial, LibraryMaterialType, LibraryView,
} from 'shared';

export interface BuildLibraryViewInput {
  projectId: string;
  title: string | null;
  includeTypes: readonly string[];
  canonicalUrl: string;
  /**
   * The project's stored video-derived thumbnail (`projects.thumbnail_url`), already public.
   * Passed in rather than re-read because every caller already holds the project row.
   */
  projectThumbnailUrl?: string | null;
}

/**
 * The simulation read, with the degraded retry `editor-state.controller.ts` already carries.
 *
 * A bare `findMany()` selects whatever the Drizzle schema declares, which now includes
 * `bridge_ack_capable` (055) and `requires_import_maps` (057). An app image deployed AHEAD of its
 * migrations therefore raises Postgres 42703 and takes the whole read down — here that would be
 * the entire public page, not one bucket. The retry drops exactly those two columns; neither is
 * read by this file, so the degraded path is not degraded output, it is identical output.
 */
async function loadSimulationsDegraded(projectId: string) {
  const query = {
    where: eq(simulations.project_id, projectId),
    orderBy: [desc(simulations.created_at)],
  };
  try {
    return await db.query.simulations.findMany(query);
  } catch (err) {
    logger.error({ err, projectId }, 'library view: full simulation read failed — retrying without the post-migration capability columns');
    return await db.query.simulations.findMany({
      ...query,
      columns: { bridge_ack_capable: false, requires_import_maps: false },
    });
  }
}

/**
 * The origin guard.
 *
 * `R2StorageAdapter.getSimPublicUrl` returns `${R2_PUBLIC_URL}/${path}`, which is not a
 * `/sim-public/` path — so `shared/src/sim/simUrl.ts#rebaseSimPublicOrigin` will not rebase it, and
 * the frontend `frame-src` (which lists only 'self', the API origin, Stripe and the Firebase auth
 * origin) refuses it. The visitor gets a blank iframe with no explanation.
 *
 * A dropped tile with a logged warning is strictly better than a tile that cannot render, so a sim
 * URL whose origin is not the API origin is dropped here rather than shipped. R2 is not the
 * production writer today; this exists so switching adapters produces a log line instead of a
 * mystery.
 */
function simUrlIsFramable(url: string, projectId: string, simId: string): boolean {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    logger.warn({ projectId, simId }, 'library view: simulation URL is not a URL — dropping the material');
    return false;
  }
  const expected = new URL(publicApiOrigin()).origin;
  if (origin !== expected) {
    logger.warn(
      { projectId, simId, origin, expected },
      'library view: simulation URL is on a foreign origin the frame-src CSP will refuse — dropping the material',
    );
    return false;
  }
  return true;
}

/** Same emitted-format preference as the player: cheapest first, PNG kept for transparent captures. */
const BANNER_FORMATS: readonly PosterFormat[] = ['webp', 'avif', 'png'];

/**
 * One banner URL per simulation, from the posters the capture pipeline already stored.
 *
 * The player (`buildPlayerConfig.posterFor`) refuses any poster that is not the section's exact
 * presentation identity, because there a poster is a promise about the live frame that will
 * replace it. A library tile makes no such promise — the banner illustrates the simulation, it
 * never stands in for a frame — so any stored poster of the simulation is honest here. The
 * preference order exists for determinism, not honesty: the tile's own aspect first ('wide' — the
 * grid tile is 16:9), then the newest capture, then identity as the tie-break. Zero bytes are
 * written; a simulation that was never captured simply has no banner.
 */
async function loadSimBannerUrls(
  sims: readonly { id: string; bridge_hash?: string | null; active_revision_id?: string | null }[],
): Promise<Map<string, string>> {
  const banners = new Map<string, string>();
  if (sims.length === 0) return banners;
  const simIds = sims.map((s) => s.id);

  // ONLY the currently-served revision's posters may banner (adversarial review, 2026-08-30).
  // Poster objects live OUTSIDE the revisions/ prefix, so the /sim-public status gate that keeps
  // never-activated revision BYTES private does not cover them — and the canary pipeline stores
  // posters for candidates before (and independently of) activation. Ranking newest-first without
  // this filter would prefer exactly the unpublished capture. Same identity rule as
  // buildPlayerConfig.posterFor: packageRevisionFor over {active_revision_id, bridge_hash}, no
  // fallback to other revisions — a sim whose current revision was never captured has no banner.
  const wantedRevision = new Map<string, string>();
  for (const sim of sims) {
    try { wantedRevision.set(sim.id, packageRevisionFor(sim, derivePackageRevision)); }
    catch { /* underivable identity → this sim simply gets no banner */ }
  }

  // Same guard as buildPlayerConfig: `sim_posters` does not exist until migration 049 is applied,
  // and a missing poster table must degrade to "no banner", never a failed public page. Logged —
  // silently-absorbed reads are how the audioEdition wrong-table 409s shipped (its own comment).
  const rows = await db.query.sim_posters
    .findMany({ where: inArray(sim_posters.simulation_id, simIds) })
    .catch((err: unknown) => {
      logger.warn({ err }, 'library banners: sim_posters read failed — serving without banners');
      return [];
    });

  const bySim = new Map<string, typeof rows>();
  for (const row of rows) {
    if (row.package_revision !== wantedRevision.get(row.simulation_id)) continue;
    const list = bySim.get(row.simulation_id) ?? [];
    list.push(row);
    bySim.set(row.simulation_id, list);
  }

  const storage = getStorageAdapter();
  for (const [simId, posterRows] of bySim) {
    const ranked = [...posterRows].sort((a, b) => {
      const aspect = Number(b.aspect_profile === 'wide') - Number(a.aspect_profile === 'wide');
      if (aspect !== 0) return aspect;
      const captured = b.captured_at.getTime() - a.captured_at.getTime();
      if (captured !== 0) return captured;
      return a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0;
    });
    for (const row of ranked) {
      // `parsePosterVariants` is the shared validation that keeps an arbitrary JSONB write from
      // reaching a public URL — the same reader PosterService and buildPlayerConfig use.
      const variant = selectPosterVariant(
        { variants: parsePosterVariants(row.variants) }, 'standard', BANNER_FORMATS,
      );
      if (variant) {
        banners.set(simId, storage.getSimPublicUrl(variant.path));
        break;
      }
    }
  }
  return banners;
}

const ALL_TYPES: readonly LibraryMaterialType[] = ['simulation', 'image', 'video', 'audio'];

function iso(value: Date | string | null | undefined): string {
  if (!value) return new Date(0).toISOString();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export async function buildLibraryView(input: BuildLibraryViewInput): Promise<LibraryView> {
  const { projectId, includeTypes, canonicalUrl } = input;
  const storage = getStorageAdapter();
  const wanted = new Set(includeTypes);
  const want = (t: LibraryMaterialType) => wanted.has(t);

  const [videoRows, simRows, imageRows, audioRows] = await Promise.all([
    want('video')
      ? db.query.video_files.findMany({
          where: eq(video_files.project_id, projectId),
          orderBy: [desc(video_files.created_at)],
        })
      : Promise.resolve([]),
    want('simulation') ? loadSimulationsDegraded(projectId) : Promise.resolve([]),
    want('image')
      ? db.query.image_files.findMany({
          where: eq(image_files.project_id, projectId),
          orderBy: [desc(image_files.created_at)],
        })
      : Promise.resolve([]),
    want('audio')
      ? db.query.audio_files.findMany({
          where: eq(audio_files.project_id, projectId),
          orderBy: [desc(audio_files.created_at)],
        })
      : Promise.resolve([]),
  ]);

  const materials: LibraryMaterial[] = [];

  // ── Simulations ────────────────────────────────────────────────────────────────────────────
  // `active_revision_entry_key` is preferred over the mutable `entry_file` deliberately: revision
  // bytes are immutable and carry a real cache policy, while the mutable pointer is served
  // no-cache. The `startsWith('http')` branch is the legacy shape simulations.controller.ts and
  // buildPlayerConfig both still honour — an entry_file that is already a full URL.
  const readySims = simRows.filter((s) => s.status === 'ready');
  const simBanners = await loadSimBannerUrls(readySims);
  for (const s of readySims) {
    const key = s.active_revision_entry_key ?? s.entry_file;
    if (!key) continue;
    const url = key.startsWith('http') ? key : storage.getSimPublicUrl(key);
    if (!simUrlIsFramable(url, projectId, s.id)) continue;
    const bannerUrl = simBanners.get(s.id);
    materials.push({
      id: s.id,
      type: 'simulation',
      name: s.name,
      url,
      ...(bannerUrl ? { bannerUrl } : {}),
      createdAt: iso(s.created_at),
    });
  }

  // ── Images ─────────────────────────────────────────────────────────────────────────────────
  // `original_url` verbatim — written at upload as a permanent public URL. The stored crop is
  // passed through as fractions and applied as a CSS transform by the card, exactly as the
  // editor's thumbnail does; the overlay shows the uncropped original.
  for (const im of imageRows) {
    materials.push({
      id: im.id,
      type: 'image',
      name: im.filename,
      url: im.original_url,
      width: im.width,
      height: im.height,
      crop: { x: im.crop_x, y: im.crop_y, w: im.crop_w, h: im.crop_h },
      createdAt: iso(im.created_at),
    });
  }

  // ── Videos ─────────────────────────────────────────────────────────────────────────────────
  // Same precedence buildPlayerConfig uses: master first, 360p fallback, and only once HLS is
  // ready. A `pending`/`processing`/`failed` video has no playable URL at all, so emitting it
  // would be emitting a tile that can only fail.
  const videoMaterials: LibraryMaterial[] = [];
  let soleEmittedVideoIsBroll = false;
  for (const v of videoRows) {
    if (v.hls_status !== 'ready') continue;
    const key = v.hls_master_key ?? v.hls_360p_key;
    if (!key) continue;
    const material: LibraryMaterial = {
      id: v.id,
      type: 'video',
      name: v.filename,
      url: storage.getPublicUrl(key),
      durationSec: v.duration_sec,
      captionsUrl: captionUrlForVideo(v),
      createdAt: iso(v.created_at),
    };
    videoMaterials.push(material);
    soleEmittedVideoIsBroll = videoMaterials.length === 1 && !!v.is_broll;
    materials.push(material);
  }

  // The only stored video still is the PROJECT's thumbnail (`generateVideoMetadata` extracts one
  // frame per project, not per file), so it is attached only when exactly one video is emitted —
  // then it is that video's own picture. With several videos (b-roll included) there is no honest
  // way to know which file the frame came from, and stamping every card with the same image would
  // caption b-roll with the main video's frame. Absent is honest; approximate is not.
  // Tightened after an adversarial review probe (2026-08-30): "exactly one EMITTED video" is not
  // the same claim as "the video the frame came from". Every extraction path derives the frame
  // from a NON-B-ROLL main video — so when the main video is failed or deleted while a b-roll
  // stays ready, the b-roll becomes the sole emitted video and the old guard stamped the MAIN
  // video's frame onto the b-roll's card: a picture of a different video presented as this one's
  // (probe-verified). The emitted single must therefore itself be non-b-roll before the project
  // frame may claim to be its picture. Absent is honest; approximate is not.
  if (videoMaterials.length === 1 && !soleEmittedVideoIsBroll && input.projectThumbnailUrl) {
    videoMaterials[0].bannerUrl = input.projectThumbnailUrl;
  }

  // ── Sounds ─────────────────────────────────────────────────────────────────────────────────
  for (const a of audioRows) {
    materials.push({
      id: a.id,
      type: 'audio',
      name: a.filename,
      url: a.url,
      durationSec: a.duration_sec,
      createdAt: iso(a.created_at),
    });
  }

  const counts = ALL_TYPES.reduce<LibraryCounts>(
    (acc, t) => ({ ...acc, [t]: materials.filter((m) => m.type === t).length }),
    { simulation: 0, image: 0, video: 0, audio: 0 },
  );

  materials.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));

  return {
    title: input.title ?? 'Library',
    // Phase 1 emits 'ltr' unconditionally so the contract is stable before the RTL work lands.
    direction: 'ltr',
    counts,
    materials,
    canonicalUrl,
    indexable: false,
  };
}

/** Narrow a full view to one bucket, keeping `counts` over all four. Used by `?type=`. */
export function filterLibraryView(view: LibraryView, type: LibraryMaterialType | null): LibraryView {
  if (!type) return view;
  return { ...view, materials: view.materials.filter((m) => m.type === type) };
}
