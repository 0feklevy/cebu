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
  created_at: string;
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
  created_at: string;
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

    return res.json() as Promise<T>;
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

  deleteVideo(projectId: string, videoId: string): Promise<void> {
    return this.request(`/api/v1/projects/${projectId}/videos/${videoId}`, { method: 'DELETE' });
  }

  // ── Timeline Sections ─────────────────────────────────────────────────────

  listSections(projectId: string): Promise<TimelineSection[]> {
    return this.request(`/api/v1/projects/${projectId}/sections`);
  }

  createSection(
    projectId: string,
    body: { video_file_id: string; start_sec: number; end_sec: number; type: string; label?: string; notes?: string },
  ): Promise<TimelineSection> {
    return this.request(`/api/v1/projects/${projectId}/sections`, { method: 'POST', body });
  }

  updateSection(
    projectId: string,
    sectionId: string,
    body: Partial<{ start_sec: number; end_sec: number; type: string; label: string; notes: string; sort_order: number }>,
  ): Promise<TimelineSection> {
    return this.request(`/api/v1/projects/${projectId}/sections/${sectionId}`, { method: 'PATCH', body });
  }

  deleteSection(projectId: string, sectionId: string): Promise<void> {
    return this.request(`/api/v1/projects/${projectId}/sections/${sectionId}`, { method: 'DELETE' });
  }
}
