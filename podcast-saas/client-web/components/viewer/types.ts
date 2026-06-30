'use client';

export interface SimulationOverlay {
  id:             string;
  start_sec:      number;
  end_sec:        number;
  simulation_url: string | null;
  simulation_id:  string | null;
  sim_script:     string | null;
  simple_ui:      boolean | null;
  auto_script:    boolean | null;
  label:          string | null;
  type:           string;
}

export interface PlayerSegment {
  id: string;
  label: string;
  duration_sec: number;
  hls_url: string | null;
  fallback_url: string | null;
  hls_status: string;
  crop_url?: string | null;     // smart portrait-crop metadata JSON (null until computed)
  captions?: {
    status: 'none' | 'processing' | 'ready' | 'failed';
    vtt_url: string | null;
    error?: string | null;
  };
  simulations: SimulationOverlay[];
}

export interface BrollClip {
  id: string;
  hls_url: string;
  global_offset_sec: number;
  start_sec: number;
  end_sec: number;
  label: string | null;
  broll_volume: number;
}

export interface ClipOverlay {
  id: string;
  hls_url: string;
  global_offset_sec: number;  // when to show in the global timeline
  start_sec: number;           // in-point of source video
  end_sec: number;             // out-point of source video
  label: string | null;
  broll_volume: number;
}

export interface ImageOverlayItem {
  id: string;
  image_url: string;
  global_offset_sec: number;  // absolute start on main timeline
  duration_sec: number;
  camera_movement: string;    // 'zoom_in' | 'zoom_out' | 'pan_right' | 'pan_left' | 'dolly_in' | 'drift'
  crop_x: number;             // 0–1 fraction of original image
  crop_y: number;
  crop_w: number;
  crop_h: number;
  label: string | null;
}

export interface AudioCutaway {
  id: string;
  audio_url: string;
  global_offset_sec: number;
  start_sec: number;
  end_sec: number;
  label: string | null;
  broll_volume: number;
}

export interface AvatarCircleFace {
  speaker: 'host_a' | 'host_b';
  side: 'left' | 'right';
  imageUrl?: string;
  label?: string;
}

export interface AvatarCirclesConfig {
  enabled: boolean;
  visibility?: 'broll' | 'always' | 'none'; // when circles appear (default 'broll')
  count: 1 | 2;
  faces?: AvatarCircleFace[];
  barStyle?: 'bars' | 'solid' | 'gradient';
  numberOfBars?: number;
  sensitivity?: number;
  barWidth?: number;
  innerRadius?: number;
  smoothness?: number;
  minHeight?: number;
  maxHeight?: number;
  rotationOffset?: number;
  lowFreqCutPct?: number;
  highFreqCutPct?: number;
  colorMode?: 'solid' | 'gradient';
  barColor?: string;
  gradientEnd?: string;
  background?: string;
  roundedBars?: boolean;
  circleSize?: number;
  circleOpacity?: number;
  circleLayout?: 'corners' | 'right-stack';
  circleSideInsetPct?: number;
  circleBottomPct?: number;
  circleGapPct?: number;
  showCenterCircle?: boolean;
}

export interface SpeakerSpan { speaker: string; start_sec: number; end_sec: number; }

// ── Branching Interactive Videos (migration 037) ──────────────────────────────
// Present only for projects split into sequences. When `branching` is null/absent the
// player walks the flat `segments` linearly (unchanged behavior). The graph walker
// (Phase 2) reads from `branching.sequences`.

export type BranchDestinationType =
  | 'sequence' | 'project' | 'playlist' | 'external_url'
  | 'simulation_full' | 'quiz' | 'back' | 'restart' | 'end';

export interface PlayerBranchEdge {
  id: string;
  label: string | null;
  description: string | null;
  thumbnail_url: string | null;
  destination_type: BranchDestinationType;
  dest_sequence_id: string | null;     // 'sequence' destinations (same project)
  dest_url: string | null;             // 'external_url'
  dest_project_token: string | null;   // resolved share token (later phase)
  dest_playlist_token: string | null;  // resolved share token (later phase)
  dest_simulation_url: string | null;  // resolved sim entry URL (later phase)
  trigger_event: string | null;        // sim-triggered edges (later phase)
  trigger_match: Record<string, unknown> | null;
  disabled: boolean;                   // server-set when destination missing/forbidden
  disabled_reason: string | null;
}

export interface PlayerChoicePoint {
  id: string;
  sequence_id: string;
  lead_in_sec: number;                 // overlay appears N sec before the sequence ends
  timeout_sec: number | null;          // default-on-timeout; null = wait for a pick
  behavior: 'continue' | 'pause' | 'loop';
  prompt: string | null;
  layout: 'cards' | 'buttons' | 'quiz';
  default_edge_id: string | null;
  edges: PlayerBranchEdge[];
}

export interface PlayerBranchSequence {
  id: string;
  label: string;
  is_entry: boolean;
  segments: PlayerSegment[];           // same shape as the flat segments, scoped to this sequence
  choice_point: PlayerChoicePoint | null;
}

export interface PlayerBranchingConfig {
  entry_sequence_id: string;
  sequences: PlayerBranchSequence[];
}

export interface PlayerConfig {
  project_id: string;
  title: string | null;
  thumbnail_url: string | null;
  segments: PlayerSegment[];
  broll_clips: BrollClip[];
  clip_overlays?: ClipOverlay[];
  image_overlays?: ImageOverlayItem[];
  audio_cutaways?: AudioCutaway[];
  avatar_circles?: AvatarCirclesConfig | null;
  speaker_timeline?: SpeakerSpan[];
  branching?: PlayerBranchingConfig | null;
}

export interface TimelineSeg {
  id: string;
  duration: number;
  offset: number;
}
