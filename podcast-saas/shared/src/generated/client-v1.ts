/// <reference lib="dom" />
import type { CreateProject, PlatformSettings } from '../types/project.js';
import type { Host, CreateHost } from '../types/host.js';
import type { Corpus } from '../types/corpus.js';

export interface ApiConfig {
  baseURL: string;
  getToken: () => Promise<string | null>;
}

export interface Project {
  id: string;
  org_id: string;
  title: string | null;
  topic: string | null;
  status: string;
  created_by: string | null;
  created_at: string;
}

export interface VideoFile {
  id: string;
  project_id: string;
  filename: string;
  file_size: number | null;
  storage_key: string | null;
  status: string;
  duration_sec: number | null;
  hls_status: 'pending' | 'processing' | 'ready' | 'failed';
  hls_master_key: string | null;
  hls_error: string | null;
  waveform_peaks: string | null;  // JSON-encoded float[200] 0–1, set after HLS transcode
  is_broll: boolean;              // true for AI-generated broll source files
  hls_url: string | null;   // computed: public HLS URL (only set when hls_status === 'ready')
  raw_url?: string | null;  // present in upload response and hls-status poll; absent in list
  created_at: string;
}

export interface HlsStatusResponse {
  id: string;
  hls_status: 'pending' | 'processing' | 'ready' | 'failed';
  hls_url: string | null;
  raw_url: string | null;   // presigned download URL for raw source file, TTL 3600s
  duration_sec: number | null;
  hls_error: string | null;
  hls_current_tier: string | null;   // e.g. '360p', '480p', '720p', '1080p'
  hls_360p_ready: boolean;           // true once the 360p playlist is uploaded
}

export interface TimelineSection {
  id: string;
  project_id: string;
  video_file_id: string;
  start_sec: number;
  end_sec: number;
  type: string;
  label: string | null;
  notes: string | null;
  sort_order: number | null;
  simulation_url: string | null;
  simulation_id:  string | null;
  sim_script:     string | null;
  sim_prompt:     string | null;
  simple_ui:      boolean;
  auto_script:    boolean;
  track: 'main' | 'broll';              // default 'main'
  global_offset_sec: number | null;     // broll only: absolute start time on main timeline
  sim_meta: SimMeta | null;             // bridge generation plan metadata
  clip_source_video_id: string | null;  // clip type: which library video to play
  clip_in_sec: number | null;           // clip type: in-point in source video (seconds)
  broll_volume: number;
  created_at: string;
}

export interface SimMeta {
  targetControlId:     string | null;
  confidence:          number;
  warnings:            string[];
  hideControlIds:      string[];
  hideButtonIds:       string[];
  hideSelectorStrings: string[];
  animation: {
    enabled:      boolean;
    controllerId: string | null;
    min:          number;
    max:          number;
    step:         number;
    intervalMs:   number;
    showOptimal:  boolean;
  } | null;
  planVersion: string;
}

export interface VideoGenerationJob {
  id: string;
  project_id: string;
  section_id: string | null;
  video_file_id: string | null;
  model: 'kling' | 'seedance' | 'veo';
  original_prompt: string;
  enhanced_prompt: string | null;
  enhance_enabled: boolean;
  target_duration_sec: number;
  target_global_offset_sec: number;
  external_task_id: string | null;
  status:
    | 'queued' | 'enhancing' | 'submitting' | 'generating'
    | 'downloading' | 'transcoding' | 'ready' | 'failed';
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface Simulation {
  id:               string;
  project_id:       string;
  name:             string;
  storage_prefix:   string;
  entry_file:       string;
  bridge_functions: Array<{ name: string; windowFn: string; description: string }> | null;
  status:           'processing' | 'ready' | 'failed';
  error:            string | null;
  created_at:       string;
}

export interface SimFile {
  key:      string;
  filename: string;
  ext:      string;
  url:      string;
}

export class ClientV1Api {
  private config: ApiConfig;

  constructor(config: ApiConfig) {
    this.config = config;
  }

  private async request<T>(
    path: string,
    opts: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const token = await this.config.getToken();
    const hasBody = opts.body !== undefined;
    const res = await fetch(this.config.baseURL + path, {
      method: opts.method ?? 'GET',
      headers: {
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: hasBody ? JSON.stringify(opts.body) : undefined,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: res.statusText })) as { message?: string };
      throw new Error(err.message ?? `HTTP ${res.status}`);
    }

    // 204 No Content and genuinely empty bodies must not be fed to JSON.parse.
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  private async requestText(path: string): Promise<string> {
    const token = await this.config.getToken();
    const res = await fetch(this.config.baseURL + path, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  }

  private async requestMultipart<T>(path: string, formData: FormData): Promise<T> {
    const token = await this.config.getToken();
    const res = await fetch(this.config.baseURL + path, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: formData,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: res.statusText })) as { message?: string };
      throw new Error(err.message ?? `HTTP ${res.status}`);
    }

    return res.json() as Promise<T>;
  }

  // ── Platform ──────────────────────────────────────────────────────────────

  getPlatformSettings(): Promise<PlatformSettings> {
    return this.request('/api/v1/platform/settings');
  }

  // ── Projects ──────────────────────────────────────────────────────────────

  createProject(body: CreateProject): Promise<{ id: string; status: string }> {
    return this.request('/api/v1/projects', { method: 'POST', body });
  }

  getProject(projectId: string): Promise<Project> {
    return this.request(`/api/v1/projects/${projectId}`);
  }

  listProjects(): Promise<Project[]> {
    return this.request('/api/v1/projects');
  }

  renameProject(projectId: string, title: string): Promise<Project> {
    return this.request(`/api/v1/projects/${projectId}`, { method: 'PATCH', body: { title } });
  }

  deleteProject(projectId: string): Promise<void> {
    return this.request(`/api/v1/projects/${projectId}`, { method: 'DELETE' });
  }

  // ── Hosts ─────────────────────────────────────────────────────────────────

  listHosts(): Promise<Host[]> {
    return this.request('/api/v1/hosts');
  }

  createHost(body: CreateHost): Promise<Host> {
    return this.request('/api/v1/hosts', { method: 'POST', body });
  }

  // ── Corpus ────────────────────────────────────────────────────────────────

  addCorpus(
    projectId: string,
    bodyOrFormData: FormData | { source_url?: string; text?: string; source_type?: string },
    isMultipart?: boolean,
  ): Promise<Corpus> {
    const path = `/api/v1/projects/${projectId}/corpus`;
    if (isMultipart && bodyOrFormData instanceof FormData) {
      return this.requestMultipart(path, bodyOrFormData);
    }
    return this.request(path, { method: 'POST', body: bodyOrFormData });
  }

  getCorpusStatus(projectId: string, corpusId: string): Promise<Corpus> {
    return this.request(`/api/v1/projects/${projectId}/corpus/${corpusId}`);
  }

  // ── Videos ────────────────────────────────────────────────────────────────

  getVideoUploadUrl(
    projectId: string,
    body: { filename: string; file_size: number; content_type: string },
  ): Promise<{ upload_url: string; storage_key: string }> {
    return this.request(`/api/v1/projects/${projectId}/videos/upload-url`, { method: 'POST', body });
  }

  confirmVideoUpload(
    projectId: string,
    body: { storage_key: string; filename: string; file_size: number },
  ): Promise<VideoFile> {
    return this.request(`/api/v1/projects/${projectId}/videos/confirm`, { method: 'POST', body });
  }

  listVideos(projectId: string): Promise<VideoFile[]> {
    return this.request(`/api/v1/projects/${projectId}/videos`);
  }

  getHlsStatus(projectId: string, videoId: string): Promise<HlsStatusResponse> {
    return this.request(`/api/v1/projects/${projectId}/videos/${videoId}/hls-status`);
  }

  deleteVideo(projectId: string, videoId: string): Promise<void> {
    return this.request(`/api/v1/projects/${projectId}/videos/${videoId}`, { method: 'DELETE' });
  }

  // ── Timeline Sections ─────────────────────────────────────────────────────

  listSections(projectId: string): Promise<TimelineSection[]> {
    return this.request(`/api/v1/projects/${projectId}/sections`);
  }

  createSection(
    projectId: string,
    body: {
      video_file_id: string;
      start_sec: number;
      end_sec: number;
      type: string;
      label?: string | null;
      notes?: string | null;
      sort_order?: number | null;
      simulation_url?: string | null;
      simulation_id?: string | null;
      sim_script?: string | null;
      track?: 'main' | 'broll';
      global_offset_sec?: number | null;
      clip_source_video_id?: string | null;
      clip_in_sec?: number | null;
      broll_volume?: number;
      simple_ui?: boolean;
      auto_script?: boolean;
    },
  ): Promise<TimelineSection> {
    return this.request(`/api/v1/projects/${projectId}/sections`, { method: 'POST', body });
  }

  updateSection(
    projectId: string,
    sectionId: string,
    body: Partial<{ start_sec: number; end_sec: number; type: string; label: string | null; notes: string | null; sort_order: number | null; simulation_url: string | null; simulation_id: string | null; sim_script: string | null; global_offset_sec: number | null; clip_source_video_id: string | null; clip_in_sec: number | null; broll_volume: number; simple_ui: boolean; auto_script: boolean }>,
  ): Promise<TimelineSection> {
    return this.request(`/api/v1/projects/${projectId}/sections/${sectionId}`, { method: 'PATCH', body });
  }

  deleteSection(projectId: string, sectionId: string): Promise<void> {
    return this.request(`/api/v1/projects/${projectId}/sections/${sectionId}`, { method: 'DELETE' });
  }

  // ── B-Roll ────────────────────────────────────────────────────────────────

  generateBroll(
    projectId: string,
    body: {
      prompt: string;
      model: 'kling' | 'seedance' | 'veo';
      enhance: boolean;
      target_duration_sec: number;
      target_global_offset_sec: number;
    },
  ): Promise<{ jobId: string; status: string }> {
    return this.request(`/api/v1/projects/${projectId}/broll/generate`, { method: 'POST', body });
  }

  listBrollJobs(projectId: string): Promise<VideoGenerationJob[]> {
    return this.request(`/api/v1/projects/${projectId}/broll/jobs`);
  }

  getBrollJob(projectId: string, jobId: string): Promise<VideoGenerationJob> {
    return this.request(`/api/v1/projects/${projectId}/broll/jobs/${jobId}`);
  }

  deleteBrollJob(projectId: string, jobId: string): Promise<void> {
    return this.request(`/api/v1/projects/${projectId}/broll/jobs/${jobId}`, { method: 'DELETE' });
  }

  insertExistingBroll(
    projectId: string,
    body: { video_file_id: string; global_offset_sec: number; start_sec?: number; end_sec?: number },
  ): Promise<TimelineSection> {
    return this.request(`/api/v1/projects/${projectId}/broll/insert-existing`, { method: 'POST', body });
  }

  generateSimScript(
    projectId: string,
    sectionId: string,
    body: { prompt: string; simple_ui: boolean; auto_script: boolean },
  ): Promise<TimelineSection> {
    return this.request(
      `/api/v1/projects/${projectId}/sections/${sectionId}/generate-sim-script`,
      { method: 'POST', body },
    );
  }

  // ── Simulations ───────────────────────────────────────────────────────────

  listSimulations(projectId: string): Promise<Simulation[]> {
    return this.request(`/api/v1/projects/${projectId}/simulations`);
  }

  uploadSimulation(projectId: string, formData: FormData): Promise<Simulation> {
    return this.requestMultipart(`/api/v1/projects/${projectId}/simulations/upload`, formData);
  }

  deleteSimulation(projectId: string, simId: string): Promise<void> {
    return this.request(`/api/v1/projects/${projectId}/simulations/${simId}`, { method: 'DELETE' });
  }

  listSimFiles(projectId: string, simId: string): Promise<SimFile[]> {
    return this.request(`/api/v1/projects/${projectId}/simulations/${simId}/files`);
  }

  getSimFileContent(projectId: string, simId: string, key: string): Promise<string> {
    return this.requestText(
      `/api/v1/projects/${projectId}/simulations/${simId}/file-content?key=${encodeURIComponent(key)}`,
    );
  }
}
