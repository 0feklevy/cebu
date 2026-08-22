/**
 * A typed client for the ElevenLabs Dubbing v2 "project" surface.
 *
 * Every request and response type below is transcribed from the vendor's live OpenAPI document, as
 * captured in md-files/ELEVENLABS-DUBBING-API-BRIEF.md. NOTHING here was derived from memory or
 * from a docs page: where the prose docs and the OpenAPI document disagree, the OpenAPI document
 * wins, because it is generated from the running service.
 *
 * NOT EXERCISED AGAINST THE LIVE API. This code has never made a real call — there is no key and
 * no network in the environment it was written in. The shapes are typed from a machine-verified
 * spec and covered by fixture tests, but "the spec says so" is not "the wire agrees", and the
 * first real call is where that gets settled.
 *
 * ── The two traps this client exists to make impossible ───────────────────────────────────────
 *
 * 1. `status: "ready"` on a PROJECT does not mean a dub exists. It means transcription finished.
 *    The dub lives on the LANGUAGE TARGET and has its own `completed` status. The two enums are
 *    deliberately separate types here so they cannot be compared to each other by accident.
 *
 * 2. A `stale` target KEEPS its old `outputs`. So `outputs != null` does NOT mean fresh — only
 *    `output_revision === revision` does. `isLanguageOutputFresh` is the only sanctioned check.
 *
 * Auth is `xi-api-key`, resolved exactly the way GuidanceTTSService resolves it, so dubbing needs
 * no new secret plumbing: the 'elevenlabs' provider is already in the ApiKeyService union.
 */
import { ApiKeyService } from '../secrets/ApiKeyService.js';
import { logger } from '../../lib/logger.js';

/** Regional base URLs are documented; the default is the global one. */
const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io/v1';

/** The vendor's PROJECT status enum. `ready` means transcription finished — never "dubbed". */
export type DubbingProjectStatus = 'queued' | 'preparing' | 'processing' | 'ready' | 'failed';

/** The vendor's LANGUAGE-TARGET status enum. This is the one that means a dub exists. */
export type DubbingLanguageStatus = 'queued' | 'processing' | 'completed' | 'stale' | 'failed';

/**
 * `DubbingError` from the spec. `code` is an OPEN string set — "new codes are added over time, so
 * treat an unrecognized value as internal_error" — which is why it is typed `string` and why
 * nothing in this codebase switches exhaustively on it.
 *
 * `retryable` is the field that actually matters: `false` means the failure describes the input or
 * the account, so an identical retry fails identically. Burning retries on those is how a bad
 * request turns into four bad requests.
 */
export interface DubbingError {
  code: string;
  message?: string | null;
  retryable: boolean;
}

/** `media` is null until the project is ready. */
export interface DubbingProjectMedia {
  filename?: string | null;
  duration_s?: number | null;
  has_video?: boolean | null;
  mime_type?: string | null;
}

/** `DubbingProjectResponse`. */
export interface DubbingProjectResponse {
  project_id: string;
  status: DubbingProjectStatus;
  reference?: string | null;
  source_language?: string | null;
  model_id?: string | null;
  media?: DubbingProjectMedia | null;
  language_ids?: string[] | null;
  error?: DubbingError | null;
}

/**
 * `DubbingLanguageOutputs` — exactly ONE property in the spec.
 *
 * There is no video output anywhere on the v2 project surface. A dubbed VIDEO is our own ffmpeg
 * mux of this audio onto the original frames; discovering that after building the pipeline is the
 * expensive version of this comment.
 *
 * The URL is signed and expires about an hour after it is issued, so it is never persisted —
 * re-fetch the language resource at download time.
 */
export interface DubbingLanguageOutputs {
  lossless_audio?: string | null;
}

/** `DubbingLanguageResponse`. */
export interface DubbingLanguageResponse {
  language_id: string;
  project_id: string;
  target_language: string;
  status: DubbingLanguageStatus;
  model_id?: string | null;
  outputs?: DubbingLanguageOutputs | null;
  /** Monotonic counter, incremented whenever this target's transcript changes. */
  revision?: number | null;
  /** The `revision` the current dubbed output was generated from. */
  output_revision?: number | null;
  error?: DubbingError | null;
  warnings?: string[] | null;
  created_at?: string | null;
  updated_at?: string | null;
}

/** One segment of `DubbingTargetTranscriptResponse`. `translation` is null until translated. */
export interface DubbingTargetSegment {
  id?: string | null;
  speaker_id?: string | null;
  start_s: number;
  end_s: number;
  source_text?: string | null;
  translation?: string | null;
}

/** `DubbingTargetTranscriptResponse` — JSON only; this surface offers no SRT or WebVTT. */
export interface DubbingTargetTranscriptResponse {
  source_language?: string | null;
  target_language?: string | null;
  revision?: number | null;
  segments?: DubbingTargetSegment[] | null;
}

/** `DubbingProjectResponse` list page from `GET /v1/dubbing/project`. */
export interface DubbingProjectListResponse {
  projects?: DubbingProjectResponse[] | null;
  has_more?: boolean | null;
  next_cursor?: string | null;
}

export interface CreateDubbingProjectRequest {
  /** The source media. Provide this or `sourceUrl`. */
  file?: { bytes: Buffer; filename: string; contentType: string };
  /** Public URL to fetch the source media from. Provide this or `file`. */
  sourceUrl?: string;
  /** Free-form, max 500 chars, to identify the project on our end. Our idempotency handle. */
  reference: string;
  /** BCP-47. Region and script subtags are ignored here. Omit to auto-detect. */
  sourceLanguage?: string | null;
  /** `dubbing_v2` — this product never runs v1. */
  modelId: 'dubbing_v1' | 'dubbing_v2';
  /** Terms to bias transcription/translation toward. At most 1000, each ≤50 chars and ≤5 words. */
  keyterms?: string[];
  /** Shortcut: also create a language target, queued to start once the project is ready. */
  targetLanguage?: string | null;
}

/** Raised for any non-2xx vendor response, carrying enough to decide whether to retry. */
export class ElevenLabsDubbingError extends Error {
  readonly status: number;
  readonly body: string;
  /**
   * The vendor's concurrency ceiling, which is a WAIT rather than a failure. Named explicitly
   * because retrying it immediately is the one reaction guaranteed not to help.
   */
  readonly concurrencyExhausted: boolean;
  readonly retryable: boolean;

  constructor(status: number, body: string) {
    super(`ElevenLabs dubbing error ${status}: ${body.slice(0, 200)}`);
    this.name = 'ElevenLabsDubbingError';
    this.status = status;
    this.body = body;
    this.concurrencyExhausted = body.includes('too_many_concurrent_requests');
    // 4xx describes the request or the account and will fail identically on retry — except 429,
    // which is precisely a "try again later". 5xx is worth another attempt.
    this.retryable = this.concurrencyExhausted || status === 429 || status >= 500;
  }
}

/** Raised when no API key is configured, so a missing key never reads as a vendor outage. */
export class ElevenLabsKeyMissingError extends Error {
  constructor() {
    super('ElevenLabs API key not configured (set it in Admin → API Keys, or ELEVENLABS_API_KEY)');
    this.name = 'ElevenLabsKeyMissingError';
  }
}

/**
 * Is this language target's output actually current?
 *
 * The ONLY sanctioned freshness check. `outputs != null` is not one: a `stale` target retains the
 * outputs it had before the transcript changed, so a naive non-null test serves the pre-edit dub
 * forever. Exported as a pure function so the rule is unit-testable without a client.
 */
export function isLanguageOutputFresh(language: Pick<DubbingLanguageResponse, 'status' | 'revision' | 'output_revision'>): boolean {
  if (language.status !== 'completed') return false;
  // A target that reports neither counter cannot be proven stale; `completed` is then the best
  // signal available and is taken at face value. When both are present they must agree.
  if (language.revision == null || language.output_revision == null) return true;
  return language.revision === language.output_revision;
}

export interface ElevenLabsDubbingClientOpts {
  apiKeyService?: ApiKeyService;
  /** Overrides the global base URL for a data-residency region. */
  baseUrl?: string;
  /** Injected for tests; production passes nothing and gets global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Refuse a credential that is the wrong KIND of string, before it can fail at the vendor.
 *
 * ── Why this exists ───────────────────────────────────────────────────────────────────────────
 * ElevenLabs shows an API key exactly once, at creation, as `sk_…`. Afterwards the dashboard
 * displays the key's **ID** — a different, shorter string that looks equally like a credential and
 * is the obvious thing to copy later. Pasting the ID is therefore the DEFAULT mistake, not an
 * unusual one, and the product's first real dub failed on precisely it:
 *
 *   400 {"type":"authentication_error","code":"invalid_api_key",
 *        "message":"API key ID used as API key …"}
 *
 * That answer is correct and useless in the place it appears: it surfaces per-language, on a job
 * row, after the queue has run — so the operator sees "Hebrew: Failed" and has to go read a vendor
 * message to learn that a field in the admin UI holds the wrong value.
 *
 * ── Why a shape check and not a live probe ────────────────────────────────────────────────────
 * A probe would cost a request and could not run at save time without spending one. The shape is
 * enough for THIS mistake, which is the one that actually happens: the ID and the key differ by an
 * unmistakable prefix. Anything that looks like a key is passed through untouched — this refuses a
 * known-wrong kind of value, it does not try to decide whether a real key is valid.
 */
export function assertUsableElevenLabsKey(key: string): void {
  const trimmed = key.trim();
  if (trimmed.startsWith('sk_')) return;
  throw new ElevenLabsDubbingError(
    401,
    'The stored ElevenLabs credential is not an API key. ElevenLabs shows the key once, at '
    + "creation, and it starts with 'sk_'; the string the dashboard displays afterwards is the "
    + "key's ID and cannot authenticate. Create a new key in the ElevenLabs dashboard, copy the "
    + "'sk_…' value at that moment, and save it in Admin → API Keys.",
  );
}

export class ElevenLabsDubbingClient {
  private readonly apiKeyService: ApiKeyService;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ElevenLabsDubbingClientOpts = {}) {
    this.apiKeyService = opts.apiKeyService ?? new ApiKeyService();
    this.baseUrl = (opts.baseUrl ?? process.env.ELEVENLABS_API_BASE ?? ELEVENLABS_API_BASE).replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Same resolution order as GuidanceTTSService: admin-managed key first, env as the fallback. */
  private async apiKey(): Promise<string> {
    const key =
      (await this.apiKeyService.getSystemKey('elevenlabs')) ??
      process.env.ELEVENLABS_API_KEY ??
      null;
    if (!key) throw new ElevenLabsKeyMissingError();
    assertUsableElevenLabsKey(key);
    return key;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const apiKey = await this.apiKey();
    const headers = new Headers(init.headers);
    headers.set('xi-api-key', apiKey);
    headers.set('Accept', 'application/json');

    const resp = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      // Truncated, and the key is in a header rather than the body or URL, so nothing secret is
      // logged here — the same shape GuidanceTTSService uses.
      logger.error({ status: resp.status, path, body: body.slice(0, 300) }, '[dubbing] ElevenLabs request failed');
      throw new ElevenLabsDubbingError(resp.status, body);
    }
    return (await resp.json()) as T;
  }

  /**
   * `POST /v1/dubbing/project` — multipart/form-data.
   *
   * THIS IS THE BILLABLE CALL. Nothing should reach it that has not first passed the caller's
   * atomic claim, because the vendor accepts no idempotency key and a second call is a second
   * invoice. `reference` carries our own row id so a job can be found again after a crash.
   */
  async createProject(req: CreateDubbingProjectRequest): Promise<DubbingProjectResponse> {
    if (!req.file && !req.sourceUrl) {
      throw new Error('createProject needs either a file or a sourceUrl');
    }
    const form = new FormData();
    if (req.file) {
      form.append('file', new Blob([new Uint8Array(req.file.bytes)], { type: req.file.contentType }), req.file.filename);
    }
    if (req.sourceUrl) form.append('source_url', req.sourceUrl);
    form.append('reference', req.reference.slice(0, 500));
    form.append('model_id', req.modelId);
    if (req.sourceLanguage) form.append('source_language', req.sourceLanguage);
    if (req.targetLanguage) form.append('target_language', req.targetLanguage);
    for (const term of req.keyterms ?? []) form.append('keyterms', term);

    return this.request<DubbingProjectResponse>('/dubbing/project', { method: 'POST', body: form });
  }

  /** `GET /v1/dubbing/project/{project_id}`. */
  async getProject(projectId: string): Promise<DubbingProjectResponse> {
    return this.request<DubbingProjectResponse>(`/dubbing/project/${encodeURIComponent(projectId)}`);
  }

  /**
   * `GET /v1/dubbing/project` — used to FIND an already-created project by our `reference` before
   * creating a second one. This is the recovery path for a worker that died between the vendor's
   * response and our own database write: the money was already spent, and this is how we find what
   * it bought instead of spending it again.
   */
  async listProjects(opts: { cursor?: string; pageSize?: number } = {}): Promise<DubbingProjectListResponse> {
    const params = new URLSearchParams();
    if (opts.cursor) params.set('cursor', opts.cursor);
    if (opts.pageSize) params.set('page_size', String(opts.pageSize));
    const query = params.toString();
    return this.request<DubbingProjectListResponse>(`/dubbing/project${query ? `?${query}` : ''}`);
  }

  /** `DELETE /v1/dubbing/project/{project_id}`. Deletion is not documented to refund credits. */
  async deleteProject(projectId: string): Promise<void> {
    await this.request<unknown>(`/dubbing/project/${encodeURIComponent(projectId)}`, { method: 'DELETE' });
  }

  /**
   * `POST /v1/dubbing/project/{project_id}/language` — application/json, unlike the create calls.
   *
   * A region-qualified tag must be one of the vendor's supported dialects for that language;
   * an unsupported region subtag is an error, not a silent fallback. `vendorTargetLanguage` in
   * languages.ts is what guarantees only acceptable tags reach here.
   */
  async addLanguage(projectId: string, targetLanguage: string): Promise<DubbingLanguageResponse> {
    return this.request<DubbingLanguageResponse>(
      `/dubbing/project/${encodeURIComponent(projectId)}/language`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_language: targetLanguage }),
      },
    );
  }

  /** `GET /v1/dubbing/project/{project_id}/language` — every target on the project. */
  async listLanguages(projectId: string): Promise<DubbingLanguageResponse[]> {
    const body = await this.request<DubbingLanguageResponse[] | { languages?: DubbingLanguageResponse[] | null }>(
      `/dubbing/project/${encodeURIComponent(projectId)}/language`,
    );
    // The spec's list shapes are not uniform across the dubbing paths, so both a bare array and an
    // enveloped one are accepted rather than assuming which one this route returns.
    if (Array.isArray(body)) return body;
    return body.languages ?? [];
  }

  /** `GET /v1/dubbing/project/{project_id}/language/{language_id}` — status plus outputs. */
  async getLanguage(projectId: string, languageId: string): Promise<DubbingLanguageResponse> {
    return this.request<DubbingLanguageResponse>(
      `/dubbing/project/${encodeURIComponent(projectId)}/language/${encodeURIComponent(languageId)}`,
    );
  }

  /** `DELETE /v1/dubbing/project/{project_id}/language/{language_id}`. */
  async deleteLanguage(projectId: string, languageId: string): Promise<void> {
    await this.request<unknown>(
      `/dubbing/project/${encodeURIComponent(projectId)}/language/${encodeURIComponent(languageId)}`,
      { method: 'DELETE' },
    );
  }

  /**
   * `GET /v1/dubbing/project/{project_id}/language/{language_id}/transcript`.
   *
   * Returns JSON segments — this surface offers no SRT or WebVTT. The segments carry `start_s` and
   * `end_s` as numbers of seconds, which is exactly the `{start, end, text}` shape CaptionService's
   * `segmentsToVtt` already consumes.
   */
  async getTargetTranscript(projectId: string, languageId: string): Promise<DubbingTargetTranscriptResponse> {
    return this.request<DubbingTargetTranscriptResponse>(
      `/dubbing/project/${encodeURIComponent(projectId)}/language/${encodeURIComponent(languageId)}/transcript`,
    );
  }

  /**
   * Download a signed output URL.
   *
   * Deliberately NOT authenticated with `xi-api-key`: the URL is pre-signed, and it expires about
   * an hour after it is issued. Always re-fetch the language resource immediately before calling
   * this — a download that queues behind a long ffmpeg render will otherwise find a dead URL.
   */
  async downloadSignedUrl(signedUrl: string): Promise<Buffer> {
    const resp = await this.fetchImpl(signedUrl);
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new ElevenLabsDubbingError(resp.status, body);
    }
    return Buffer.from(await resp.arrayBuffer());
  }
}
