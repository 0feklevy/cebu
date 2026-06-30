import { db } from '../db/index.js';
import {
  projects, video_files, timeline_sections, image_files, audio_files, scenes,
  branch_sequences, branch_choice_points, branch_edges, playlists, simulations,
} from '../db/schema.js';
import { eq, asc, inArray } from 'drizzle-orm';
import { requireProjectAccess } from './projectAccess.js';

// Player-facing branching shapes (mirrored loosely in client-web viewer/types.ts).
// Cross-project/playlist/sim destinations are resolved to share tokens / URLs in a
// later phase; Phase 1 emits the structure with those fields null.
type PlayerBranchEdge = {
  id: string;
  label: string | null;
  description: string | null;
  thumbnail_url: string | null;
  destination_type: string;
  dest_sequence_id: string | null;
  dest_url: string | null;
  dest_project_token: string | null;
  dest_playlist_token: string | null;
  dest_simulation_url: string | null;
  trigger_event: string | null;
  trigger_match: Record<string, unknown> | null;
  disabled: boolean;
  disabled_reason: string | null;
};
type PlayerChoicePoint = {
  id: string;
  sequence_id: string;
  lead_in_sec: number;
  timeout_sec: number | null;
  behavior: string;
  prompt: string | null;
  layout: string;
  default_edge_id: string | null;
  edges: PlayerBranchEdge[];
};
import { getStorageAdapter } from './storage/getStorageAdapter.js';
import { captionUrlForVideo } from './captions/CaptionService.js';

/**
 * Build the PlayerConfig for a single project — the dynamic equivalent of
 * interactive-podcast-react's constants/index.ts. Shared by the player-config
 * endpoint, the single-video share endpoint, and the playlist play-config.
 *
 * Returns null if the project does not exist.
 */
export async function buildPlayerConfig(projectId: string, requesterUserId: string | null = null) {
  const storage = getStorageAdapter();

  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
  });
  if (!project) return null;

  const allVideos = await db.query.video_files.findMany({
    where: eq(video_files.project_id, project.id),
    orderBy: [asc(video_files.created_at)],
  });

  const sections = await db.query.timeline_sections.findMany({
    where: eq(timeline_sections.project_id, project.id),
    orderBy: [asc(timeline_sections.start_sec)],
  });

  // Main video segments (uploaded by user, not AI-generated broll sources)
  const mainVideos = allVideos.filter((v) => !v.is_broll);
  const brollVideos = allVideos.filter((v) => v.is_broll);

  const buildSegment = (v: (typeof allVideos)[number]) => {
    const hls_url = v.hls_master_key
      ? storage.getPublicUrl(v.hls_master_key)
      : v.hls_360p_key
        ? storage.getPublicUrl(v.hls_360p_key)
        : null;
    const fallback_url = hls_url;

    // Only non-broll sections for this main video
    const simulations = sections
      .filter((s) => s.video_file_id === v.id && s.track === 'main')
      .map((s) => ({
        id:             s.id,
        start_sec:      s.start_sec,
        end_sec:        s.end_sec,
        simulation_url: s.simulation_url ?? null,
        simulation_id:  s.simulation_id  ?? null,
        sim_script:     s.sim_script     ?? null,
        simple_ui:      s.simple_ui      ?? false,
        auto_script:    s.auto_script    ?? true,
        label:          s.label,
        type:           s.type,
      }));

    const crop_url = v.crop_status === 'ready' && v.crop_key ? storage.getPublicUrl(v.crop_key) : null;

    return {
      id: v.id,
      label: v.filename,
      duration_sec: v.duration_sec ?? 0,
      hls_url,
      fallback_url,
      hls_status: v.hls_status,
      crop_url,                 // smart portrait-crop metadata (null until ready)
      captions: {
        status: videoCaptionStatus(v.captions_status),
        vtt_url: captionUrlForVideo(v),
        error: v.captions_status === 'failed' ? v.captions_error : null,
      },
      simulations,
    };
  };

  const segments = mainVideos.map(buildSegment);

  // NB: crop + captions are NOT enqueued here. They run once on the write path when a
  // video is uploaded (video.controller enqueueVideoProcessing) instead of on every
  // preview/share/course render, which was a per-render side-effect (review perf-002).

  // Build broll_clips from broll sections — each broll section points to a broll video
  const brollVideoMap = new Map(brollVideos.map((v) => [v.id, v]));
  const brollClips = sections
    .filter((s) => s.track === 'broll' && !s.clip_source_audio_id)
    .map((s) => {
      const brollVid = brollVideoMap.get(s.video_file_id);
      if (!brollVid) return null;
      const hls_url = brollVid.hls_master_key
        ? storage.getPublicUrl(brollVid.hls_master_key)
        : brollVid.hls_360p_key
          ? storage.getPublicUrl(brollVid.hls_360p_key)
          : null;
      if (!hls_url) return null;
      return {
        id:                s.id,
        hls_url,
        global_offset_sec: s.global_offset_sec ?? 0,
        start_sec:         s.start_sec,
        end_sec:           s.end_sec,
        label:             s.label,
        broll_volume:      s.broll_volume ?? 1.0,
      };
    })
    .filter(Boolean);

  // Build clip_overlays from clip sections — user-trimmed library videos shown as overlay.
  // Compute each main video's global offset (cumulative sum of durations).
  const allVideoMap = new Map(allVideos.map((v) => [v.id, v]));
  let globalOff = 0;
  const videoGlobalOffsets = new Map<string, number>();
  for (const v of mainVideos) {
    videoGlobalOffsets.set(v.id, globalOff);
    globalOff += v.duration_sec ?? 0;
  }

  const clipOverlays = sections
    .filter((s) => s.type === 'clip' && s.clip_source_video_id)
    .map((s) => {
      const srcVideo = allVideoMap.get(s.clip_source_video_id!);
      if (!srcVideo) return null;
      const hls_url = srcVideo.hls_master_key
        ? storage.getPublicUrl(srcVideo.hls_master_key)
        : srcVideo.hls_360p_key
          ? storage.getPublicUrl(srcVideo.hls_360p_key)
          : null;
      if (!hls_url) return null;

      const vidOffset = videoGlobalOffsets.get(s.video_file_id) ?? 0;
      const sectionDuration = s.end_sec - s.start_sec;
      const clipIn = s.clip_in_sec ?? 0;

      return {
        id:                s.id,
        hls_url,
        global_offset_sec: vidOffset + s.start_sec,
        start_sec:         clipIn,
        end_sec:           clipIn + sectionDuration,
        label:             s.label,
        broll_volume:      1.0,
      };
    })
    .filter(Boolean);

  // Build image_overlays from clip sections that reference an image file
  const imageFileMap = new Map(
    (await db.query.image_files.findMany({ where: eq(image_files.project_id, project.id) }))
      .map((img) => [img.id, img]),
  );

  const imageOverlays = sections
    .filter((s) => s.type === 'clip' && s.clip_source_image_id)
    .map((s) => {
      const img = imageFileMap.get(s.clip_source_image_id!);
      if (!img) return null;
      const vidOffset = videoGlobalOffsets.get(s.video_file_id) ?? 0;
      return {
        id:                s.id,
        image_url:         img.original_url,
        global_offset_sec: vidOffset + s.start_sec,
        duration_sec:      s.end_sec - s.start_sec,
        camera_movement:   s.camera_movement ?? 'zoom_in',
        crop_x:            img.crop_x,
        crop_y:            img.crop_y,
        crop_w:            img.crop_w,
        crop_h:            img.crop_h,
        label:             s.label,
      };
    })
    .filter(Boolean);

  // Build audio_cutaways from broll/audio sections backed by an audio file (audio-only cutaways)
  const audioFileMap = new Map(
    (await db.query.audio_files.findMany({ where: eq(audio_files.project_id, project.id) }))
      .map((a) => [a.id, a]),
  );

  const audioCutaways = sections
    .filter((s) => (s.track === 'audio' || !!s.clip_source_audio_id) && s.clip_source_audio_id)
    .map((s) => {
      const af = audioFileMap.get(s.clip_source_audio_id!);
      if (!af) return null;
      return {
        id:                s.id,
        audio_url:         af.url,
        global_offset_sec: s.global_offset_sec ?? 0,
        start_sec:         s.start_sec,
        end_sec:           s.end_sec,
        label:             s.label,
        broll_volume:      s.broll_volume ?? 1.0,
      };
    })
    .filter(Boolean);

  // Avatar circles config (audio-reactive overlays shown during b-roll). Tolerate
  // a legacy double-encoded JSON string for avatar_config.
  const avatarConfigObj: { avatarCircles?: unknown } | null = (() => {
    const v = project.avatar_config as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as { avatarCircles?: unknown };
    if (typeof v === 'string') { try { const o = JSON.parse(v); return o && typeof o === 'object' ? o : null; } catch { return null; } }
    return null;
  })();
  const avatarCircles = avatarConfigObj?.avatarCircles ?? null;

  // Speaker timeline (from the latest script version) so the viewer can animate
  // whichever avatar is speaking. Empty for uploaded videos with no script —
  // the viewer then animates all circles to the audio.
  let speakerTimeline: Array<{ speaker: string; start_sec: number; end_sec: number }> = [];
  if (avatarCircles) {
    const allScenes = await db.query.scenes.findMany({ where: eq(scenes.project_id, project.id) });
    if (allScenes.length > 0) {
      const latestVersion = Math.max(...allScenes.map((s) => s.script_version));
      speakerTimeline = allScenes
        .filter((s) => s.script_version === latestVersion)
        .sort((a, b) => a.start_ms - b.start_ms)
        .map((s) => ({ speaker: s.speaker, start_sec: s.start_ms / 1000, end_sec: s.end_ms / 1000 }));
    }
  }

  // ── Branching (migration 037) ────────────────────────────────────────────────
  // Emit a graph block only when the project has been split into sequences. Projects
  // with no branch_sequences rows return branching:null and play linearly as before —
  // zero behavior change. Phase 1 is read-only (no authoring UI yet); the block exists
  // so the viewer/editor can render a preview and Phase 2 can walk it.
  type Segment = ReturnType<typeof buildSegment>;
  type BranchingBlock = {
    entry_sequence_id: string;
    sequences: Array<{
      id: string;
      label: string;
      is_entry: boolean;
      segments: Segment[];
      choice_point: PlayerChoicePoint | null;
    }>;
  };

  let branching: BranchingBlock | null = null;

  const sequenceRows = await db.query.branch_sequences.findMany({
    where: eq(branch_sequences.project_id, project.id),
    orderBy: [asc(branch_sequences.sort_order), asc(branch_sequences.created_at)],
  });

  if (sequenceRows.length > 0) {
    const [choicePointRows, edgeRows] = await Promise.all([
      db.query.branch_choice_points.findMany({
        where: eq(branch_choice_points.project_id, project.id),
        orderBy: [asc(branch_choice_points.created_at)],
      }),
      db.query.branch_edges.findMany({
        where: eq(branch_edges.project_id, project.id),
        orderBy: [asc(branch_edges.sort_order), asc(branch_edges.created_at)],
      }),
    ]);

    // First choice point per sequence (Phase 1 supports one decision per sequence).
    const cpBySequence = new Map<string, (typeof choicePointRows)[number]>();
    for (const cp of choicePointRows) {
      if (!cpBySequence.has(cp.sequence_id)) cpBySequence.set(cp.sequence_id, cp);
    }
    const edgesByChoicePoint = new Map<string, typeof edgeRows>();
    for (const e of edgeRows) {
      if (!e.choice_point_id) continue;
      const list = edgesByChoicePoint.get(e.choice_point_id) ?? [];
      list.push(e);
      edgesByChoicePoint.set(e.choice_point_id, list);
    }

    const entrySeq = sequenceRows.find((s) => s.is_entry) ?? sequenceRows[0];

    // Group main videos by sequence; unassigned main videos fall into the entry
    // sequence so no segment is dropped from the preview.
    const videosBySequence = new Map<string, typeof mainVideos>();
    for (const seq of sequenceRows) videosBySequence.set(seq.id, []);
    for (const v of mainVideos) {
      const seqId = v.sequence_id && videosBySequence.has(v.sequence_id) ? v.sequence_id : entrySeq.id;
      videosBySequence.get(seqId)!.push(v);
    }
    const orderInSequence = (a: (typeof mainVideos)[number], b: (typeof mainVideos)[number]) => {
      const ao = a.sequence_order ?? Number.MAX_SAFE_INTEGER;
      const bo = b.sequence_order ?? Number.MAX_SAFE_INTEGER;
      if (ao !== bo) return ao - bo;
      return a.created_at.getTime() - b.created_at.getTime();
    };

    // Resolve cross-destination edges (Phase 4): tokens for project/playlist, sim URLs, and
    // access checks. Private/unpublished/missing destinations are disabled (greyed out at the
    // viewer), never exposed as raw ids — only share tokens for reachable destinations.
    const destProjectIds  = [...new Set(edgeRows.filter((e) => e.destination_type === 'project'         && e.dest_project_id).map((e) => e.dest_project_id!))];
    const destPlaylistIds = [...new Set(edgeRows.filter((e) => e.destination_type === 'playlist'        && e.dest_playlist_id).map((e) => e.dest_playlist_id!))];
    const destSimIds      = [...new Set(edgeRows.filter((e) => e.destination_type === 'simulation_full' && e.dest_simulation_id).map((e) => e.dest_simulation_id!))];

    const [destProjects, destPlaylists, destSims] = await Promise.all([
      destProjectIds.length  ? db.query.projects.findMany({ where: inArray(projects.id, destProjectIds) })       : Promise.resolve([]),
      destPlaylistIds.length ? db.query.playlists.findMany({ where: inArray(playlists.id, destPlaylistIds) })    : Promise.resolve([]),
      destSimIds.length      ? db.query.simulations.findMany({ where: inArray(simulations.id, destSimIds) })     : Promise.resolve([]),
    ]);
    const destProjectMap  = new Map(destProjects.map((p) => [p.id, p]));
    const destPlaylistMap = new Map(destPlaylists.map((p) => [p.id, p]));
    const destSimMap      = new Map(destSims.map((s) => [s.id, s]));
    const resolveSimUrl = (entryFile: string | null) => !entryFile ? null : (entryFile.startsWith('http') ? entryFile : storage.getSimPublicUrl(entryFile));

    const mapEdge = (e: (typeof edgeRows)[number]): PlayerBranchEdge => {
      let dest_project_token: string | null = null;
      let dest_playlist_token: string | null = null;
      let dest_simulation_url: string | null = null;
      let disabled = false;
      let disabled_reason: string | null = null;

      switch (e.destination_type) {
        case 'project': {
          const p = e.dest_project_id ? destProjectMap.get(e.dest_project_id) : undefined;
          if (!p || !requireProjectAccess(p, requesterUserId, null)) { disabled = true; disabled_reason = 'unavailable'; }
          else if (!p.share_token) { disabled = true; disabled_reason = 'no_share_link'; }
          else dest_project_token = p.share_token;
          break;
        }
        case 'playlist': {
          const pl = e.dest_playlist_id ? destPlaylistMap.get(e.dest_playlist_id) : undefined;
          if (!pl) { disabled = true; disabled_reason = 'unavailable'; }
          else if (!pl.share_token) { disabled = true; disabled_reason = 'no_share_link'; }
          else dest_playlist_token = pl.share_token;
          break;
        }
        case 'simulation_full': {
          const sim = e.dest_simulation_id ? destSimMap.get(e.dest_simulation_id) : undefined;
          if (!sim || sim.status !== 'ready') { disabled = true; disabled_reason = 'unavailable'; }
          else dest_simulation_url = resolveSimUrl(sim.entry_file);
          break;
        }
        case 'external_url':
          if (!e.dest_url) { disabled = true; disabled_reason = 'no_url'; }
          break;
        case 'sequence':
          if (!e.dest_sequence_id || !sequenceRows.some((s) => s.id === e.dest_sequence_id)) { disabled = true; disabled_reason = 'unavailable'; }
          break;
        // back | restart | end | quiz: always enabled
      }

      return {
        id:                  e.id,
        label:               e.label ?? null,
        description:         e.description ?? null,
        thumbnail_url:       e.thumbnail_url ?? null,
        destination_type:    e.destination_type,
        dest_sequence_id:    e.dest_sequence_id ?? null,
        dest_url:            e.dest_url ?? null,
        dest_project_token,
        dest_playlist_token,
        dest_simulation_url,
        trigger_event:       e.trigger_event ?? null,
        trigger_match:       (e.trigger_match as Record<string, unknown> | null) ?? null,
        disabled,
        disabled_reason,
      };
    };

    branching = {
      entry_sequence_id: entrySeq.id,
      sequences: sequenceRows.map((seq) => {
        const cp = cpBySequence.get(seq.id) ?? null;
        return {
          id:       seq.id,
          label:    seq.label,
          is_entry: seq.is_entry,
          segments: (videosBySequence.get(seq.id) ?? []).slice().sort(orderInSequence).map(buildSegment),
          choice_point: cp
            ? {
                id:              cp.id,
                sequence_id:     cp.sequence_id,
                lead_in_sec:     cp.lead_in_sec,
                timeout_sec:     cp.timeout_sec ?? null,
                behavior:        cp.behavior,
                prompt:          cp.prompt ?? null,
                layout:          cp.layout,
                default_edge_id: cp.default_edge_id ?? null,
                edges:           (edgesByChoicePoint.get(cp.id) ?? []).map(mapEdge),
              }
            : null,
        };
      }),
    };
  }

  return {
    project_id:     project.id,
    title:          project.title,
    description:    project.topic ?? null,
    thumbnail_url:  project.thumbnail_url ?? null,
    segments,
    broll_clips:    brollClips,
    clip_overlays:  clipOverlays,
    image_overlays: imageOverlays,
    audio_cutaways: audioCutaways,
    avatar_circles: avatarCircles,
    speaker_timeline: speakerTimeline,
    branching,
  };
}

function videoCaptionStatus(status: string | null | undefined): 'none' | 'processing' | 'ready' | 'failed' {
  return status === 'processing' || status === 'ready' || status === 'failed' ? status : 'none';
}
