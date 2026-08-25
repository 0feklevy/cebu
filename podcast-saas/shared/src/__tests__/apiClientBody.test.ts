/**
 * Every request body reaches the server as a JSON OBJECT, not as a JSON string.
 *
 * ── THE BUG THIS PINS (owner-reported: "Save bridge is stuck with A label between 1 and 120
 * characters is required") ──────────────────────────────────────────────────────────────────
 *
 * `ApiClient.request` owns serialisation: it sets `Content-Type: application/json` and calls
 * `JSON.stringify(opts.body)` itself. Three call sites — `saveBridgePreset`, `importSimulation`
 * and `buildAudioEdition` — passed `JSON.stringify(...)` INTO it, so the payload was encoded
 * twice:
 *
 *     JSON.stringify(JSON.stringify({ label: 'x' }))   →   "\"{\\\"label\\\":\\\"x\\\"}\""
 *
 * That is valid JSON, so Fastify accepted it and parsed it back to a **string**. Every handler on
 * the other side does `z.object({…}).safeParse(request.body)`, which fails against a string — and
 * each then returns its own schema's message. The user is told the label is invalid while looking
 * at a perfectly good label, because the message names the field the schema wanted rather than
 * the shape it actually got.
 *
 * ── WHY IT SURVIVED ──────────────────────────────────────────────────────────────────────────
 *
 * `shared/src/generated/` is hand-maintained (CLAUDE.md §5): nothing generates `client-v1.ts`, so
 * a call site that disagrees with `request()` breaks no build. The correct 6 call sites pass a
 * plain object; these 3 did not, and the difference is one `JSON.stringify` on a line that reads
 * perfectly naturally.
 *
 * Two things now stand in the way. `request`'s `body` is typed `object`, so passing a string
 * fails to COMPILE — a string is not assignable to `object`. And this file drives the real client
 * against a fake `fetch`, asserting on the bytes that would go on the wire: the type stops the
 * known mistake, the test stops any other route to the same wire shape.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ClientV1Api } from '../generated/client-v1.js';

interface Sent { url: string; method: string; contentType: string | null; raw: string | null }

let sent: Sent[] = [];

/** A fetch that records what was sent and answers with an empty 200. */
function recordingFetch(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    sent.push({
      url: String(input),
      method: init?.method ?? 'GET',
      contentType: headers.get('content-type'),
      raw: typeof init?.body === 'string' ? init.body : null,
    });
    return new Response('', { status: 200 });
  }) as unknown as typeof fetch;
}

let client: ClientV1Api;

beforeEach(() => {
  sent = [];
  globalThis.fetch = recordingFetch();
  client = new ClientV1Api({ baseURL: 'https://api.test', getToken: async () => 't' });
});

/**
 * What the server's `request.body` would be, after Fastify parses these exact bytes.
 *
 * Returns `unknown` on purpose — the whole defect is that this used to be a STRING where the
 * handler expected an object, so a helper that pre-asserted the type would assume away the thing
 * under test. Callers narrow it themselves.
 */
function parsedBody(i = 0): unknown {
  const raw = sent[i]?.raw;
  expect(raw, 'no body was sent').not.toBeNull();
  return JSON.parse(raw!);
}

/** `parsedBody`, narrowed to a record — and the narrowing itself is an assertion. */
function parsedRecord(i = 0): Record<string, unknown> {
  const v = parsedBody(i);
  expect(typeof v, 'the body parsed to a non-object — the double-stringify is back').toBe('object');
  expect(v).not.toBeNull();
  return v as Record<string, unknown>;
}

describe('a POST body arrives as an object, not as a string', () => {
  it('saveBridgePreset — the reported bug', async () => {
    await client.saveBridgePreset('p1', 's1', 'plucking a boid');
    // The decisive assertion. Under the double-stringify this was `'string'`, and every
    // z.object().safeParse on the other side failed.
    expect(typeof parsedBody()).toBe('object');
    expect(parsedBody()).toEqual({ label: 'plucking a boid' });
  });

  it('importSimulation — the same defect, on the `+` import path', async () => {
    await client.importSimulation('p1', '11111111-1111-4111-a111-111111111111');
    expect(typeof parsedBody()).toBe('object');
    expect(parsedBody()).toEqual({ simulation_id: '11111111-1111-4111-a111-111111111111' });
  });

  it('importSimulation carries a share token when one is given, and omits the key when not', async () => {
    await client.importSimulation('p1', '11111111-1111-4111-a111-111111111111', 'tok');
    expect(parsedBody()).toEqual({
      simulation_id: '11111111-1111-4111-a111-111111111111',
      share_token: 'tok',
    });
    // Omitted rather than sent as undefined/null: the server's schema marks it `.optional()`,
    // and an explicit null would fail `z.string()`.
    expect(Object.keys(parsedRecord(0))).toEqual(['simulation_id', 'share_token']);
  });

  it('buildAudioEdition — the third', async () => {
    await client.buildAudioEdition('p1', { language: 'he', force: true });
    expect(typeof parsedBody()).toBe('object');
    expect(parsedBody()).toEqual({ language: 'he', force: true });
  });

  it('a body-bearing request sets Content-Type: application/json', async () => {
    await client.saveBridgePreset('p1', 's1', 'x');
    expect(sent[0].contentType).toBe('application/json');
  });

  it('a GET sends no body and no Content-Type', async () => {
    // The header is conditional on `hasBody`; sending it without a body is the kind of drift
    // that makes a proxy or a body-limit behave unexpectedly.
    await client.listBridgePresets();
    expect(sent[0].raw).toBeNull();
    expect(sent[0].contentType).toBeNull();
  });
});

describe('the shape holds for the call sites that were already correct', () => {
  it('renameProject', async () => {
    await client.renameProject('p1', 'New title');
    expect(parsedBody()).toEqual({ title: 'New title' });
  });
});
