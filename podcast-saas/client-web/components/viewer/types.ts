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

export interface PlayerConfig {
  project_id: string;
  title: string | null;
  segments: PlayerSegment[];
  broll_clips: BrollClip[];
  clip_overlays?: ClipOverlay[];  // user-trimmed library video overlays
}

export interface TimelineSeg {
  id: string;
  duration: number;
  offset: number;
}
