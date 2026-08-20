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
import { desc, eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { audio_files, image_files, simulations, video_files } from '../../db/schema.js';
import { getStorageAdapter } from '../storage/getStorageAdapter.js';
import { captionUrlForVideo } from '../captions/CaptionService.js';
import { publicApiOrigin } from '../../config/publicOrigins.js';
import { logger } from '../../lib/logger.js';
import type {
  LibraryCounts, LibraryMaterial, LibraryMaterialType, LibraryView,
} from 'shared';

export interface BuildLibraryViewInput {
  projectId: string;
  title: string | null;
  includeTypes: readonly string[];
  canonicalUrl: string;
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
  for (const s of simRows) {
    if (s.status !== 'ready') continue;
    const key = s.active_revision_entry_key ?? s.entry_file;
    if (!key) continue;
    const url = key.startsWith('http') ? key : storage.getSimPublicUrl(key);
    if (!simUrlIsFramable(url, projectId, s.id)) continue;
    materials.push({
      id: s.id,
      type: 'simulation',
      name: s.name,
      url,
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
  for (const v of videoRows) {
    if (v.hls_status !== 'ready') continue;
    const key = v.hls_master_key ?? v.hls_360p_key;
    if (!key) continue;
    materials.push({
      id: v.id,
      type: 'video',
      name: v.filename,
      url: storage.getPublicUrl(key),
      durationSec: v.duration_sec,
      captionsUrl: captionUrlForVideo(v),
      createdAt: iso(v.created_at),
    });
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
