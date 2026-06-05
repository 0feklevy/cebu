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
  access_type?: 'free' | 'paid';
  price_cents?: number | null;
  currency?: string;
  thumbnail_url?: string | null;
  metadata_status?: string;
  created_at: string;
}

// ── Billing / pay-to-unlock ─────────────────────────────────────────────────

export type ContentType = 'project' | 'playlist';

export interface BillingStatus {
  enabled: boolean;
  publishableKey: string | null;
  platformFeePercent: number;
}

export interface ContentAccess {
  accessType: 'free' | 'paid';
  priceCents: number | null;
  currency: string;
  title: string | null;
  hasAccess: boolean;
  isOwner: boolean;
  locked: boolean;
}

export interface ContentPricing {
  access_type: 'free' | 'paid';
  price_cents: number | null;
  currency: string;
}

export interface Purchase {
  id: string;
  content_type: ContentType;
  content_id: string;
  title: string | null;
  amount_cents: number;
  currency: string;
  purchased_at: string;
}

export interface BillingTransaction {
  id: string;
  type: string;
  status: string;
  amount_cents: number;
  currency: string;
  platform_fee_cents: number;
  creator_payout_cents: number;
  content_type: ContentType;
  content_id: string;
  description: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface CreatorEarnings {
  salesCount: number;
  totalGrossCents: number;
  totalNetCents: number;
  currency: string;
  recent: Array<{
    id: string;
    content_type: ContentType;
    title: string | null;
    amount_cents: number;
    creator_payout_cents: number;
    currency: string;
    completed_at: string | null;
  }>;
}

/** A viewer player-config response may instead be a paywall stub. */
export interface LockedContent {
  locked: true;
  content_type: ContentType;
  content_id: string;
  title: string | null;
  price_cents: number | null;
  currency: string;
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
  track: 'main' | 'broll' | 'audio';    // default 'main'
  global_offset_sec: number | null;     // broll/audio: absolute start time on main timeline
  sim_meta: SimMeta | null;             // bridge generation plan metadata
  clip_source_video_id: string | null;  // clip type: which library video to play
  clip_in_sec: number | null;           // clip type: in-point in source video (seconds)
  broll_volume: number;
  clip_source_image_id: string | null;  // image clip: which uploaded image to show
  camera_movement: string;              // image clip: 'zoom_in' | 'zoom_out' | 'pan_right' | 'pan_left' | 'dolly_in' | 'drift'
  clip_source_audio_id: string | null;  // audio cutaway: which uploaded audio file to play
  created_at: string;
}

export interface ImageFile {
  id: string;
  project_id: string;
  filename: string;
  storage_key: string;
  original_url: string;
  width: number | null;
  height: number | null;
  crop_x: number;
  crop_y: number;
  crop_w: number;
  crop_h: number;
  created_at: string;
}

export interface AudioFile {
  id: string;
  project_id: string;
  filename: string;
  storage_key: string;
  url: string;
  duration_sec: number | null;
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

export type GuidanceTrigger =
  | { kind: 'feature'; targetId: string; events: Array<'pointerdown' | 'input' | 'change'> }
  | { kind: 'config';  predicateBody: string; observables: string[]; debounce?: number };

export interface GuidanceEntry {
  id:         string;
  kind:       'feature' | 'config';
  title:      string;
  narration:  string;
  enabled:    boolean;
  trigger:    GuidanceTrigger;
  audioUrl:   string | null;
  confidence: number;
  warnings:   string[];
}

export interface GuidanceMeta {
  provider?:     string;
  model?:        string;
  confidence?:   number;
  sourceHash?:   string;
  mdUrl?:        string;
  guidanceHash?: string;
  language?:     string;
  generatedAt?:  string;
  publishedAt?:  string;
  entryCount?:   number;
  droppedCount?: number;
  warnings?:     string[];
}

export type GuidanceStatus = 'none' | 'analyzing' | 'draft' | 'publishing' | 'ready' | 'error';

export interface Simulation {
  id:               string;
  project_id:       string;
  name:             string;
  storage_prefix:   string;
  entry_file:       string;
  bridge_functions: Array<{ name: string; windowFn: string; description: string }> | null;
  status:           'processing' | 'ready' | 'failed';
  error:            string | null;
  guidance?:        GuidanceEntry[] | null;
  guidance_status?: GuidanceStatus;
  guidance_meta?:   GuidanceMeta | null;
  guidance_error?:  string | null;
  created_at:       string;
}

export interface SimFile {
  key:      string;
  filename: string;
  ext:      string;
  url:      string;
}

// ── Playlists ───────────────────────────────────────────────────────────────

export interface Playlist {
  id: string;
  org_id: string;
  created_by: string | null;
  title: string | null;
  description: string | null;
  autoplay: boolean;
  show_sidebar: boolean;
  allow_shuffle: boolean;
  banner_url: string | null;
  banner_storage_key: string | null;
  banner_prompt: string | null;
  banner_provider: string | null;
  share_token: string | null;
  share_enabled_at: string | null;
  access_type?: 'free' | 'paid';
  price_cents?: number | null;
  currency?: string;
  created_at: string;
  updated_at: string;
}

export interface PlaylistItem {
  id: string;
  project_id: string;
  position: number;
  title: string | null;
  description: string | null;
  status: string;
}

export interface PlaylistWithItems extends Playlist {
  items: PlaylistItem[];
}

export interface PlaylistSummary extends Playlist {
  item_count: number;
}

// Public play-config — each item carries its full project PlayerConfig.
// PlayerConfig is intentionally loosely typed here (the viewer owns the precise shape).
export interface PlaylistPlayItem {
  project_id: string;
  title: string | null;
  description: string | null;
  thumbnail_url: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: any;
}

export interface PlaylistPlayConfig {
  id: string;
  title: string | null;
  description: string | null;
  autoplay: boolean;
  show_sidebar: boolean;
  allow_shuffle: boolean;
  banner_url: string | null;
  banner_prompt: string | null;
  banner_provider: string | null;
  items: PlaylistPlayItem[];
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

  private async requestBlob(path: string): Promise<Blob> {
    const token = await this.config.getToken();
    const res = await fetch(this.config.baseURL + path, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.blob();
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

  updateProjectMeta(projectId: string, body: { title?: string; description?: string | null }): Promise<Project> {
    return this.request(`/api/v1/projects/${projectId}/meta`, { method: 'PATCH', body });
  }

  regenerateVideoMetadata(projectId: string): Promise<{ status: string }> {
    return this.request(`/api/v1/projects/${projectId}/generate-metadata`, { method: 'POST' });
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
      track?: 'main' | 'broll' | 'audio';
      global_offset_sec?: number | null;
      clip_source_video_id?: string | null;
      clip_in_sec?: number | null;
      broll_volume?: number;
      simple_ui?: boolean;
      auto_script?: boolean;
      clip_source_image_id?: string | null;
      camera_movement?: string;
      clip_source_audio_id?: string | null;
    },
  ): Promise<TimelineSection> {
    return this.request(`/api/v1/projects/${projectId}/sections`, { method: 'POST', body });
  }

  updateSection(
    projectId: string,
    sectionId: string,
    body: Partial<{ start_sec: number; end_sec: number; type: string; label: string | null; notes: string | null; sort_order: number | null; simulation_url: string | null; simulation_id: string | null; sim_script: string | null; track: 'main' | 'broll' | 'audio'; global_offset_sec: number | null; clip_source_video_id: string | null; clip_in_sec: number | null; broll_volume: number; simple_ui: boolean; auto_script: boolean; clip_source_image_id: string | null; camera_movement: string; clip_source_audio_id: string | null }>,
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

  // ── Images ────────────────────────────────────────────────────────────────

  listImages(projectId: string): Promise<ImageFile[]> {
    return this.request(`/api/v1/projects/${projectId}/images`);
  }

  uploadImage(projectId: string, formData: FormData): Promise<ImageFile> {
    return this.requestMultipart(`/api/v1/projects/${projectId}/images`, formData);
  }

  patchImageCrop(
    projectId: string,
    imageId: string,
    crop: { crop_x: number; crop_y: number; crop_w: number; crop_h: number },
  ): Promise<ImageFile> {
    return this.request(`/api/v1/projects/${projectId}/images/${imageId}`, { method: 'PATCH', body: crop });
  }

  deleteImage(projectId: string, imageId: string): Promise<void> {
    return this.request(`/api/v1/projects/${projectId}/images/${imageId}`, { method: 'DELETE' });
  }

  // ── Audio files ───────────────────────────────────────────────────────────

  listAudioFiles(projectId: string): Promise<AudioFile[]> {
    return this.request(`/api/v1/projects/${projectId}/audio`);
  }

  uploadAudioFile(projectId: string, formData: FormData): Promise<AudioFile> {
    return this.requestMultipart(`/api/v1/projects/${projectId}/audio`, formData);
  }

  deleteAudioFile(projectId: string, audioId: string): Promise<void> {
    return this.request(`/api/v1/projects/${projectId}/audio/${audioId}`, { method: 'DELETE' });
  }

  insertAudioCutaway(
    projectId: string,
    body: { audio_file_id: string; global_offset_sec: number; duration_sec: number; video_file_id: string },
  ): Promise<TimelineSection> {
    return this.request(`/api/v1/projects/${projectId}/audio/insert-cutaway`, { method: 'POST', body });
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

  downloadSimZip(projectId: string, simId: string): Promise<Blob> {
    return this.requestBlob(`/api/v1/projects/${projectId}/simulations/${simId}/download.zip`);
  }

  // ── Playlists ───────────────────────────────────────────────────────────────

  listPlaylists(): Promise<PlaylistSummary[]> {
    return this.request('/api/v1/playlists');
  }

  createPlaylist(body: { title?: string; description?: string }): Promise<PlaylistWithItems> {
    return this.request('/api/v1/playlists', { method: 'POST', body });
  }

  getPlaylist(playlistId: string): Promise<PlaylistWithItems> {
    return this.request(`/api/v1/playlists/${playlistId}`);
  }

  updatePlaylist(
    playlistId: string,
    body: Partial<Pick<Playlist, 'title' | 'description' | 'autoplay' | 'show_sidebar' | 'allow_shuffle' | 'banner_url' | 'banner_prompt' | 'banner_provider'>>,
  ): Promise<PlaylistWithItems> {
    return this.request(`/api/v1/playlists/${playlistId}`, { method: 'PATCH', body });
  }

  uploadPlaylistBanner(playlistId: string, file: File): Promise<PlaylistWithItems> {
    const formData = new FormData();
    formData.append('file', file);
    return this.requestMultipart(`/api/v1/playlists/${playlistId}/banner`, formData);
  }

  generatePlaylistBanner(
    playlistId: string,
    body: { provider: 'openai' | 'gemini'; prompt?: string | null },
  ): Promise<PlaylistWithItems> {
    return this.request(`/api/v1/playlists/${playlistId}/banner/generate`, { method: 'POST', body });
  }

  deletePlaylist(playlistId: string): Promise<void> {
    return this.request(`/api/v1/playlists/${playlistId}`, { method: 'DELETE' });
  }

  setPlaylistItems(playlistId: string, projectIds: string[]): Promise<PlaylistWithItems> {
    return this.request(`/api/v1/playlists/${playlistId}/items`, {
      method: 'PUT',
      body: { items: projectIds.map((project_id) => ({ project_id })) },
    });
  }

  getPlaylistShare(playlistId: string): Promise<{ shareToken: string | null; shareUrl: string | null }> {
    return this.request(`/api/v1/playlists/${playlistId}/share`);
  }

  createPlaylistShare(playlistId: string): Promise<{ shareToken: string; shareUrl: string }> {
    return this.request(`/api/v1/playlists/${playlistId}/share`, { method: 'POST' });
  }

  revokePlaylistShare(playlistId: string): Promise<void> {
    return this.request(`/api/v1/playlists/${playlistId}/share`, { method: 'DELETE' });
  }

  getPlaylistPlayConfig(playlistId: string): Promise<PlaylistPlayConfig> {
    return this.request(`/api/v1/playlists/${playlistId}/play-config`);
  }

  // ── Billing / pay-to-unlock ─────────────────────────────────────────────────

  getBillingStatus(): Promise<BillingStatus> {
    return this.request('/api/v1/billing/status');
  }

  getContentAccess(contentType: ContentType, contentId: string): Promise<ContentAccess> {
    return this.request(`/api/v1/billing/access/${contentType}/${contentId}`);
  }

  createCheckout(contentType: ContentType, contentId: string): Promise<{ url: string }> {
    return this.request('/api/v1/billing/checkout', { method: 'POST', body: { content_type: contentType, content_id: contentId } });
  }

  openBillingPortal(returnUrl?: string): Promise<{ url: string }> {
    return this.request('/api/v1/billing/portal', { method: 'POST', body: { returnUrl } });
  }

  listPurchases(): Promise<Purchase[]> {
    return this.request('/api/v1/billing/purchases');
  }

  listBillingTransactions(): Promise<BillingTransaction[]> {
    return this.request('/api/v1/billing/transactions');
  }

  getCreatorEarnings(): Promise<CreatorEarnings> {
    return this.request('/api/v1/billing/earnings');
  }

  setContentPricing(
    contentType: ContentType,
    contentId: string,
    body: { access_type: 'free' | 'paid'; price_cents?: number | null; currency?: string },
  ): Promise<ContentPricing> {
    return this.request(`/api/v1/billing/pricing/${contentType}/${contentId}`, { method: 'PATCH', body });
  }
}
