import { db } from '../db/index.js';
import { projects, video_files, timeline_sections, image_files, audio_files, scenes } from '../db/schema.js';
import { eq, asc } from 'drizzle-orm';
import { getStorageAdapter } from './storage/getStorageAdapter.js';
import { captionUrlForVideo } from './captions/CaptionService.js';

/**
 * Build the PlayerConfig for a single project — the dynamic equivalent of
 * interactive-podcast-react's constants/index.ts. Shared by the player-config
 * endpoint, the single-video share endpoint, and the playlist play-config.
 *
 * Returns null if the project does not exist.
 */
export async function buildPlayerConfig(projectId: string) {
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

  const segments = mainVideos.map((v) => {
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
  });

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
  };
}

function videoCaptionStatus(status: string | null | undefined): 'none' | 'processing' | 'ready' | 'failed' {
  return status === 'processing' || status === 'ready' || status === 'failed' ? status : 'none';
}
