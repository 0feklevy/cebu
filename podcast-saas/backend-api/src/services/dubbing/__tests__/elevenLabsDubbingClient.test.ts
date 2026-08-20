/**
 * The ElevenLabs Dubbing v2 client, against typed fixtures of the vendor's documented shapes.
 *
 * WHAT THIS CAN AND CANNOT PROVE. Nothing here has ever touched the live API — there is no key and
 * no network in this environment. These tests pin what WE send and how we read what comes back,
 * against response fixtures transcribed from the vendor's machine-verified OpenAPI document. They
 * prove the client is self-consistent and that the documented shapes are handled; they cannot prove
 * the wire agrees with the document. The first real call is what settles that, and the report says
 * so explicitly.
 *
 * What that still buys is real: the traps in this API are shape traps, not connectivity traps —
 * reading a JSON envelope as a file, treating a project's `ready` as a dub, trusting non-null
 * `outputs` on a stale target. Every one of those is a fixture away from being caught here.
 */
import { describe, it, expect, vi } from 'vitest';

import {
  ElevenLabsDubbingClient,
  ElevenLabsDubbingError,
  ElevenLabsKeyMissingError,
  type DubbingLanguageResponse,
  type DubbingProjectResponse,
  type DubbingTargetTranscriptResponse,
} from '../ElevenLabsDubbingClient.js';
import type { ApiKeyService } from '../../secrets/ApiKeyService.js';

/** An ApiKeyService stand-in — the real one decrypts from the database. */
const keyService = (key: string | null): ApiKeyService =>
  ({ getSystemKey: async () => key }) as unknown as ApiKeyService;

interface Captured { url: string; init: RequestInit }

function clientWith(
  responder: (url: string, init: RequestInit) => Response | Promise<Response>,
  key: string | null = 'xi-test-key',
): { client: ElevenLabsDubbingClient; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return responder(url, init ?? {});
  }) as unknown as typeof fetch;
  return {
    client: new ElevenLabsDubbingClient({ apiKeyService: keyService(key), fetchImpl }),
    calls,
  };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** `DubbingProjectResponse`, exactly as the brief documents it. */
const PROJECT_READY: DubbingProjectResponse = {
  project_id: 'proj_abc',
  status: 'ready',
  reference: 'flowvid:dub:dub-1',
  source_language: 'en',
  model_id: 'dubbing_v2',
  media: { filename: 'lesson-04.mp4', duration_s: 612.4, has_video: true, mime_type: 'video/mp4' },
  language_ids: ['lang_he'],
};

/** `DubbingLanguageResponse` for a finished target. */
const LANGUAGE_DONE: DubbingLanguageResponse = {
  language_id: 'lang_he',
  project_id: 'proj_abc',
  target_language: 'he',
  status: 'completed',
  model_id: 'dubbing_v2',
  outputs: { lossless_audio: 'https://signed.example/audio.wav?sig=1' },
  revision: 1,
  output_revision: 1,
  error: null,
  warnings: [],
};

describe('auth and error handling', () => {
  it('sends the key as the xi-api-key header, never in the URL', async () => {
    const { client, calls } = clientWith(() => json(PROJECT_READY));
    await client.getProject('proj_abc');
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get('xi-api-key')).toBe('xi-test-key');
    expect(calls[0]!.url).not.toContain('xi-test-key');
  });

  it('prefers the admin-managed key and falls back to the environment', async () => {
    const prev = process.env.ELEVENLABS_API_KEY;
    process.env.ELEVENLABS_API_KEY = 'env-key';
    try {
      const { client, calls } = clientWith(() => json(PROJECT_READY), null);
      await client.getProject('proj_abc');
      expect(new Headers(calls[0]!.init.headers).get('xi-api-key')).toBe('env-key');
    } finally {
      if (prev === undefined) delete process.env.ELEVENLABS_API_KEY;
      else process.env.ELEVENLABS_API_KEY = prev;
    }
  });

  it('raises a distinct error when no key is configured, so it never reads as a vendor outage', async () => {
    const prev = process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
    try {
      const { client } = clientWith(() => json(PROJECT_READY), null);
      await expect(client.getProject('proj_abc')).rejects.toBeInstanceOf(ElevenLabsKeyMissingError);
    } finally {
      if (prev !== undefined) process.env.ELEVENLABS_API_KEY = prev;
    }
  });

  it('flags the concurrency ceiling as retryable — it is a wait, not a failure', async () => {
    const { client } = clientWith(() => json({ detail: { status: 'too_many_concurrent_requests' } }, 429));
    const err = await client.getProject('p').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ElevenLabsDubbingError);
    expect((err as ElevenLabsDubbingError).concurrencyExhausted).toBe(true);
    expect((err as ElevenLabsDubbingError).retryable).toBe(true);
  });

  it('marks an ordinary 4xx NON-retryable, so a bad request does not burn four attempts', async () => {
    const { client } = clientWith(() => json({ detail: 'invalid target_language' }, 422));
    const err = await client.getProject('p').catch((e: unknown) => e) as ElevenLabsDubbingError;
    expect(err.retryable).toBe(false);
  });

  it('marks 5xx retryable', async () => {
    const { client } = clientWith(() => json({ detail: 'boom' }, 503));
    const err = await client.getProject('p').catch((e: unknown) => e) as ElevenLabsDubbingError;
    expect(err.retryable).toBe(true);
  });
});

describe('createProject — the billable call', () => {
  it('posts multipart to /dubbing/project with model_id, reference and the target shortcut', async () => {
    const { client, calls } = clientWith(() => json({ ...PROJECT_READY, status: 'preparing' }));
    await client.createProject({
      sourceUrl: 'https://storage.example/lesson.mp4',
      reference: 'flowvid:dub:dub-1',
      sourceLanguage: 'en',
      modelId: 'dubbing_v2',
      targetLanguage: 'he',
    });

    const call = calls[0]!;
    expect(call.url).toMatch(/\/v1\/dubbing\/project$/);
    expect(call.init.method).toBe('POST');

    const form = call.init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('source_url')).toBe('https://storage.example/lesson.mp4');
    expect(form.get('reference')).toBe('flowvid:dub:dub-1');
    // The owner asked for v2 explicitly, and this is the only surface where that is selectable.
    expect(form.get('model_id')).toBe('dubbing_v2');
    expect(form.get('source_language')).toBe('en');
    expect(form.get('target_language')).toBe('he');
  });

  it('truncates an over-long reference to the vendor 500-character limit', async () => {
    const { client, calls } = clientWith(() => json(PROJECT_READY));
    await client.createProject({
      sourceUrl: 'https://x/y.mp4', reference: 'r'.repeat(900), modelId: 'dubbing_v2',
    });
    expect((calls[0]!.init.body as FormData).get('reference')).toHaveLength(500);
  });

  it('refuses to call at all without a source — a billable call with no input is pure waste', async () => {
    const { client, calls } = clientWith(() => json(PROJECT_READY));
    await expect(client.createProject({ reference: 'r', modelId: 'dubbing_v2' })).rejects.toThrow(/file or a sourceUrl/);
    expect(calls).toHaveLength(0);
  });
});

describe('addLanguage — JSON, unlike the create calls', () => {
  it('posts application/json with target_language', async () => {
    const { client, calls } = clientWith(() => json({ ...LANGUAGE_DONE, status: 'queued', outputs: null }));
    await client.addLanguage('proj_abc', 'es-MX');

    const call = calls[0]!;
    expect(call.url).toMatch(/\/v1\/dubbing\/project\/proj_abc\/language$/);
    expect(new Headers(call.init.headers).get('Content-Type')).toBe('application/json');
    expect(JSON.parse(call.init.body as string)).toEqual({ target_language: 'es-MX' });
  });

  it('url-encodes ids rather than interpolating them raw', async () => {
    const { client, calls } = clientWith(() => json(LANGUAGE_DONE));
    await client.getLanguage('proj/../x', 'lang 1');
    expect(calls[0]!.url).toContain('proj%2F..%2Fx');
    expect(calls[0]!.url).toContain('lang%201');
  });
});

describe('listLanguages — tolerant of both documented list shapes', () => {
  it('reads a bare array', async () => {
    const { client } = clientWith(() => json([LANGUAGE_DONE]));
    expect(await client.listLanguages('proj_abc')).toHaveLength(1);
  });

  it('reads an enveloped array', async () => {
    const { client } = clientWith(() => json({ languages: [LANGUAGE_DONE] }));
    expect(await client.listLanguages('proj_abc')).toHaveLength(1);
  });

  it('reads an empty envelope as no targets rather than throwing', async () => {
    const { client } = clientWith(() => json({}));
    expect(await client.listLanguages('proj_abc')).toEqual([]);
  });
});

describe('getTargetTranscript — JSON segments, which is what captions are built from', () => {
  it('returns segments carrying start_s, end_s and translation', async () => {
    const transcript: DubbingTargetTranscriptResponse = {
      source_language: 'en',
      target_language: 'he',
      revision: 3,
      segments: [
        { id: 'seg_1', speaker_id: 'spk_0', start_s: 1.12, end_s: 4.30, source_text: 'Hello and welcome', translation: 'שלום, ברוכים הבאים' },
        // `translation` is nullable — "null if not translated yet".
        { id: 'seg_2', start_s: 4.5, end_s: 6.0, source_text: 'Today', translation: null },
      ],
    };
    const { client, calls } = clientWith(() => json(transcript));
    const result = await client.getTargetTranscript('proj_abc', 'lang_he');

    expect(calls[0]!.url).toMatch(/\/language\/lang_he\/transcript$/);
    expect(result.segments).toHaveLength(2);
    expect(result.segments![0]).toMatchObject({ start_s: 1.12, end_s: 4.30 });
    expect(result.segments![1]!.translation).toBeNull();
  });
});

describe('downloadSignedUrl — a pre-signed URL, deliberately unauthenticated', () => {
  it('fetches the signed URL without attaching the API key', async () => {
    const { client, calls } = clientWith(() => new Response(Buffer.from('RIFFfake'), { status: 200 }));
    const bytes = await client.downloadSignedUrl('https://signed.example/audio.wav?sig=1');

    expect(bytes.toString()).toBe('RIFFfake');
    // The signature is the credential; adding ours would be pointless and would leak it to a CDN.
    expect(calls[0]!.init.headers).toBeUndefined();
  });

  it('raises the vendor error type on an expired signature, so the caller can re-fetch', async () => {
    const { client } = clientWith(() => new Response('expired', { status: 403 }));
    await expect(client.downloadSignedUrl('https://signed.example/gone.wav'))
      .rejects.toBeInstanceOf(ElevenLabsDubbingError);
  });
});
