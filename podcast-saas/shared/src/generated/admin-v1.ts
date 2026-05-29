/// <reference lib="dom" />

export interface ApiConfig {
  baseURL: string;
  getToken: () => Promise<string | null>;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  params?: Record<string, string | number | undefined>;
}

export interface AdminSettings {
  id: number;
  billing_enabled: boolean;
  generation_paused: boolean;
  generation_paused_message: string | null;
  maintenance_mode: boolean;
  maintenance_message: string | null;
  anonymous_user_limit: number;
  default_provider: 'claude' | 'openai' | 'gemini';
  temperature: number;
  max_tokens: number;
  extended_thinking_enabled: boolean;
  thinking_budget_tokens: number;
  utility_model: string;
  generation_model: string;
  complex_model: string;
  complex_min_corpus_tokens: number;
  complex_min_retries: number;
  // TTS settings
  tts_provider: 'elevenlabs' | 'gemini';
  elevenlabs_model: string;
  default_voice_id_a: string | null;
  default_voice_id_b: string | null;
  updated_at: string;
}

export interface SystemPrompt {
  id: number;
  key: string;
  content: string;
  is_customized: boolean;
  updated_by: string | null;
  updated_at: string;
}

export interface ApiKeyStatus {
  provider: 'claude' | 'openai' | 'gemini' | 'elevenlabs';
  set: boolean;
  last_updated: string | null;
}

export interface User {
  id: string;
  firebase_uid: string;
  email: string | null;
  display_name: string | null;
  is_anonymous: boolean;
  is_admin: boolean;
  weekly_token_limit: number;
  monthly_token_limit: number;
  created_at: string;
}

export interface UsageRollup {
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_cents: number;
  by_provider: Record<string, { input: number; output: number; cost_cents: number }>;
  by_model: Record<string, { input: number; output: number; cost_cents: number }>;
  by_task: Record<string, { input: number; output: number }>;
}

export interface TestKeyResult {
  valid: boolean;
  model?: string;
  error?: string;
}

export interface PipelineStats {
  projects: {
    total: number;
    recent_30d: number;
  };
  videos: {
    total: number;
    by_hls_status: {
      pending: number;
      processing: number;
      ready: number;
      failed: number;
    };
  };
  simulations: {
    total: number;
    by_status: {
      processing: number;
      ready: number;
      failed: number;
    };
  };
  ai_extraction: {
    total_input_tokens: number;
    total_output_tokens: number;
    total_cost_cents: number;
    count: number;
  };
}

export class AdminV1Api {
  private config: ApiConfig;

  constructor(config: ApiConfig) {
    this.config = config;
  }

  private async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const token = await this.config.getToken();
    const url = new URL(this.config.baseURL + path);

    if (opts.params) {
      for (const [k, v] of Object.entries(opts.params)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }

    const res = await fetch(url.toString(), {
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

  getSettings(): Promise<AdminSettings> {
    return this.request('/api/admin/v1/settings');
  }

  updateSettings(body: Partial<AdminSettings>): Promise<AdminSettings> {
    return this.request('/api/admin/v1/settings', { method: 'PUT', body });
  }

  listSystemPrompts(): Promise<SystemPrompt[]> {
    return this.request('/api/admin/v1/system-prompts');
  }

  updateSystemPrompt(key: string, content: string): Promise<SystemPrompt> {
    return this.request(`/api/admin/v1/system-prompts/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: { content },
    });
  }

  getLlmConfig(): Promise<AdminSettings> {
    return this.request('/api/admin/v1/llm-config');
  }

  updateLlmConfig(body: Partial<AdminSettings>): Promise<AdminSettings> {
    return this.request('/api/admin/v1/llm-config', { method: 'PUT', body });
  }

  listApiKeys(): Promise<ApiKeyStatus[]> {
    return this.request('/api/admin/v1/api-keys');
  }

  setApiKey(provider: 'claude' | 'openai' | 'gemini' | 'elevenlabs', api_key: string): Promise<{ success: boolean }> {
    return this.request('/api/admin/v1/api-keys', { method: 'POST', body: { provider, api_key } });
  }

  testApiKey(provider: 'claude' | 'openai' | 'gemini' | 'elevenlabs', api_key: string): Promise<TestKeyResult> {
    return this.request('/api/admin/v1/api-keys/test', { method: 'POST', body: { provider, api_key } });
  }

  deleteApiKey(provider: 'claude' | 'openai' | 'gemini' | 'elevenlabs'): Promise<{ success: boolean }> {
    return this.request(`/api/admin/v1/api-keys/${provider}`, { method: 'DELETE' });
  }

  listUsers(page?: number, limit?: number): Promise<{ users: User[]; total: number; page: number; limit: number }> {
    return this.request('/api/admin/v1/users', { params: { page, limit } });
  }

  updateUserLimits(
    id: string,
    body: { weekly_token_limit?: number; monthly_token_limit?: number; is_admin?: boolean },
  ): Promise<User> {
    return this.request(`/api/admin/v1/users/${id}/limits`, { method: 'PUT', body });
  }

  getUsageRollup(from?: string, to?: string): Promise<UsageRollup> {
    return this.request('/api/admin/v1/usage', { params: { from, to } });
  }

  getPipelineStats(): Promise<PipelineStats> {
    return this.request('/api/admin/v1/pipeline-stats');
  }
}
