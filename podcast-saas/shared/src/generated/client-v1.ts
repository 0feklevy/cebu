/// <reference lib="dom" />
import type { CreateProject, PlatformSettings } from '../types/project.js';
import type { Host, CreateHost } from '../types/host.js';
import type { ScriptVersion, DialogueTurn } from '../types/script.js';
import type { Corpus } from '../types/corpus.js';

export interface ApiConfig {
  baseURL: string;
  getToken: () => Promise<string | null>;
}


export interface Project {
  id: string;
  org_id: string;
  topic: string | null;
  style_preset: string | null;
  host_a_id: string | null;
  host_b_id: string | null;
  host_a?: Host | null;
  host_b?: Host | null;
  format: string;
  target_duration_min: number | null;
  pacing: string | null;
  emotional_style: string | null;
  status: string;
  created_by: string | null;
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
    const res = await fetch(this.config.baseURL + path, {
      method: opts.method ?? 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
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

  getPlatformSettings(): Promise<PlatformSettings> {
    return this.request('/api/v1/platform/settings');
  }

  createProject(body: CreateProject): Promise<{ id: string; status: string }> {
    return this.request('/api/v1/projects', { method: 'POST', body });
  }

  getProject(projectId: string): Promise<Project> {
    return this.request(`/api/v1/projects/${projectId}`);
  }

  listProjects(): Promise<Project[]> {
    return this.request('/api/v1/projects');
  }

  listHosts(): Promise<Host[]> {
    return this.request('/api/v1/hosts');
  }

  createHost(body: CreateHost): Promise<Host> {
    return this.request('/api/v1/hosts', { method: 'POST', body });
  }

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

  generateScript(projectId: string): Promise<{ job_id: string }> {
    return this.request(`/api/v1/projects/${projectId}/script/generate`, { method: 'POST' });
  }

  getScript(projectId: string): Promise<ScriptVersion> {
    return this.request(`/api/v1/projects/${projectId}/script`);
  }

  getScriptVersion(projectId: string, version: number): Promise<ScriptVersion> {
    return this.request(`/api/v1/projects/${projectId}/script/${version}`);
  }

  listScriptVersions(projectId: string): Promise<ScriptVersion[]> {
    return this.request(`/api/v1/projects/${projectId}/script/versions`);
  }

  updateTurn(
    projectId: string,
    version: number,
    turnIndex: number,
    patch: Partial<Pick<DialogueTurn, 'text' | 'emotion' | 'audio_tags' | 'speaker'>>,
  ): Promise<{ new_version: number }> {
    return this.request(`/api/v1/projects/${projectId}/script/${version}/turns/${turnIndex}`, {
      method: 'PATCH',
      body: patch,
    });
  }

  replaceTurns(projectId: string, version: number, turns: DialogueTurn[]): Promise<{ new_version: number }> {
    return this.request(`/api/v1/projects/${projectId}/script/${version}/turns`, {
      method: 'PUT',
      body: { turns },
    });
  }

  regenerateTurn(
    projectId: string,
    version: number,
    turnIndex: number,
    opts: { hint?: string },
  ): Promise<{ new_version: number; turn: DialogueTurn }> {
    return this.request(
      `/api/v1/projects/${projectId}/script/${version}/turns/${turnIndex}/regenerate`,
      { method: 'POST', body: opts },
    );
  }

  approveScript(projectId: string, version: number): Promise<void> {
    return this.request(`/api/v1/projects/${projectId}/script/${version}/approve`, {
      method: 'POST',
    });
  }
}
