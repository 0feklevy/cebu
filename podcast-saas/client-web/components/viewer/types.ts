'use client';

export interface SimulationOverlay {
  id:             string;
  start_sec:      number;
  end_sec:        number;
  simulation_url: string | null;
  simulation_id:  string | null;
  /** Logical package revision (backend-derived). One of the five reveal-invariant identity axes. */
  package_revision?: string | null;
  /**
   * The LAST PUBLISH-TIME CANARY VERDICT for this package, or null when it has never been
   * canaried. Null means UNPROVEN, which the player treats exactly as it treats legacy: the v2
   * path, no aggressive preparation, no activation-scoped reveal. Only 'managed-presentable'
   * unlocks the modern path.
   */
  package_class?: 'managed-presentable' | 'managed-partial' | 'legacy-cooperative' | 'legacy-opaque' | 'failed' | null;
  sim_script:     string | null;
  simple_ui:      boolean | null;
  auto_script:    boolean | null;
  // Minimal-UI control picker: selectors hidden mechanically while simple_ui is on.
  // Emitted by buildPlayerConfig from sim_meta.uiControls.hide; passed to the sim
  // bridge as startScript.params.hideSelectors (old bridges ignore it harmlessly).
  ui_hide?:       string[];
  /**
   * The poster for THIS section's exact presentation identity (package revision + variant key +
   * config hash + aspect + quality), or null when none has been captured.
   *
   * Never another identity's poster: a still picture that does not match the frame it stands in for
   * is worse than no poster at all, because the user sees the difference and reads it as a glitch.
   */
  poster_url?:    string | null;
  /** True when the poster was captured over a transparent background (a section that sits on video). */
  poster_transparent?: boolean;
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
  // Voice band of this circle's character — drives the FFT (pitch) speaker fallback
  // when no scenes-derived speaker_timeline exists. Defaults: host_a=male, host_b=female.
  voice?: 'male' | 'female';
}

export interface AvatarCirclesConfig {
  enabled: boolean;
  // when circles appear (default 'broll'); 'manual' / 'broll+manual' use the
  // user-marked manualSections ranges — alone or merged with b-roll windows
  visibility?: 'broll' | 'always' | 'none' | 'manual' | 'broll+manual';
  manualSections?: Array<{ id: string; start_sec: number; end_sec: number }>;
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
  description: string | null;   // emitted by buildPlayerConfig (project.topic); was undeclared (types-008)
  thumbnail_url: string | null;
  segments: PlayerSegment[];
  broll_clips: BrollClip[];
  clip_overlays?: ClipOverlay[];
  image_overlays?: ImageOverlayItem[];
  audio_cutaways?: AudioCutaway[];
  avatar_circles?: AvatarCirclesConfig | null;
  speaker_timeline?: SpeakerSpan[];
  branching?: PlayerBranchingConfig | null;
  // Kill switch (admin_settings / SIM_POOL_MODE): 'adaptive' = package-identity resident pool;
  // 'single' = conservative one-frame-on-activation fallback. A ?simpool= URL param overrides it.
  sim_pool_mode?: 'adaptive' | 'single';
  // ── Priority 8 runtime switches (migration 052). All absent/OFF = today's behaviour. ──
  sim_scheduler_mode?: 'off' | 'predictive';
  sim_adaptive_quality?: boolean;
  sim_boundary_sentinel?: boolean;
  /**
   * The bidirectional frame-valid transition coordinator (migration 054, audit P0.1).
   *
   * ON, the simulation→video exit holds the outgoing (frozen, still-audible) package as the cover
   * until a frame callback proves the REQUESTED video frame — matching handoff generation and
   * media time — reached the compositor, then cross-fades on a parent paint. OFF is byte-for-byte
   * today's exit. Server-resolved and authoritative: unlike `sim_pool_mode` there is no URL
   * override, because this decides which pixels a viewer may see.
   */
  sim_transition_coordinator?: boolean;
  sim_rum_sample_rate?: number;
  /** Per-simulation publish-time preparation cost, keyed by simulation id. */
  sim_prepare_budget_ms?: Record<string, number>;
  /**
   * The canary-derived budget alone, never refined by field data.
   *
   * Separate from `sim_prepare_budget_ms` because the two answer different questions. That one is
   * a LEAD TIME and is rightly refined by what the fleet actually measures; this one is a STANDARD
   * for adaptive quality to judge a device against, and a standard derived from the same
   * measurement it judges is not a standard at all.
   */
  sim_lab_budget_ms?: Record<string, number>;
}

export interface TimelineSeg {
  id: string;
  duration: number;
  offset: number;
}
