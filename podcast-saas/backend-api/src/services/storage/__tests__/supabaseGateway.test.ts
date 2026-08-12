/**
 * The Supabase adapter's behaviour against a gateway that is NOT AWS S3.
 *
 * WHY THIS FILE EXISTS. Supabase is the writable adapter in production — `getStorageAdapter`
 * chooses it whenever `SUPABASE_S3_*` is set, and R2's token is read-only — but every duplication
 * test runs against a fake adapter that mints `https://cdn.test/{key}` and never fails. So the two
 * things a real duplication actually meets on this gateway were unexercised: its transient 5xx
 * (it sits behind Cloudflare) and its response TIMING (a server-side copy answers when it is done,
 * not while it works). Both are properties of THIS adapter's client wiring, so they are pinned here
 * against the same fake `send` the copy tests use, one level below `ProjectDuplicationService`.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { Readable } from 'node:stream';

vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  SupabaseStorageAdapter,
  SUPABASE_CONNECTION_TIMEOUT_MS,
  SUPABASE_COPY_SOCKET_TIMEOUT_MS,
  SUPABASE_SOCKET_TIMEOUT_MS,
} from '../SupabaseStorageAdapter.js';
import { isCopyTooLarge, isCopyUnsupported, MULTIPART_COPY_PART_BYTES, PermanentStorageError } from '../s3Copy.js';
import { fakeS3 } from './fakeS3.js';


const ENV: Record<string, string> = {
  SUPABASE_URL: 'https://ref.supabase.co',
  SUPABASE_S3_ACCESS_KEY_ID: 'key',
  SUPABASE_S3_SECRET_ACCESS_KEY: 'secret',
  SUPABASE_S3_REGION: 'us-east-1',
  SUPABASE_STORAGE_BUCKET: 'media',
};

const saved = new Map<string, string | undefined>();
afterEach(() => {
  for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  saved.clear();
});

function adapterUnder(react: (name: string, input: any) => unknown) {
  for (const [k, v] of Object.entries(ENV)) { saved.set(k, process.env[k]); process.env[k] = v; }
  const adapter = new SupabaseStorageAdapter();
  return { adapter, s3: fakeS3(adapter, react) };
}

/**
 * The transient failure `withRetry` was written for: Cloudflare answers a 5xx with an HTML body the
 * SDK's XML parser then chokes on, so what arrives is often a deserialization error whose only
 * trace of the real response is `$metadata.httpStatusCode`.
 */
function transient5xx(): Error {
  return Object.assign(new Error('Deserialization error: to see the raw response, inspect the hidden field {error}.'), {
    name: 'DeserializationError',
    $metadata: { httpStatusCode: 522 },
  });
}

/** What the store says when the object simply is not there. */
function notFound(): Error {
  return Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
}

/**
 * The same answer with NO status on it.
 *
 * A HEAD has no response body to parse a code out of, and both adapters' miss test has always had a
 * second clause — `name === 'NotFound'` — for exactly this shape, so the codebase already asserts it
 * occurs. It is the shape that MATTERS here: "no status" is `withRetry`'s definition of a transport
 * failure, so an absorption placed outside the retried closure would spend four attempts and ~3.5s
 * of backoff on it before conceding what the first answer already said.
 */
function notFoundWithoutStatus(): Error {
  return Object.assign(new Error('NotFound'), { name: 'NotFound' });
}

/** A refusal, not a failure: no retry can talk it round. */
function forbidden(): Error {
  return Object.assign(new Error('access denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
}

/**
 * Verbatim from `@smithy/node-http-handler`'s `setSocketTimeout`: the socket saw no activity for
 * the configured window, so the handler destroyed the request. No status, because no response ever
 * arrived — which is precisely why it must not be mistaken for a permanent refusal.
 */
function socketTimeout(ms = SUPABASE_SOCKET_TIMEOUT_MS): Error {
  return Object.assign(
    new Error(`@smithy/node-http-handler - the request socket timed out after ${ms} ms of inactivity (configured by client requestHandler).`),
    { name: 'TimeoutError' },
  );
}

const HEAD_OK = { ContentType: 'video/mp4', CacheControl: 'no-cache', ContentLength: 1234, ETag: '"e"' };

// ── The two bodyless HEADs a duplication issues once per copied object ────────────────────────

/**
 * `verifyBytes` calls `objectExists` for EVERY copied object — 50 to 300 back-to-back, immediately
 * after a copy wave that may have run for minutes. They were the only two commands on this adapter
 * outside `withRetry`, so a single transient 5xx anywhere in that burst failed a duplication whose
 * bytes had all landed.
 */
describe('Supabase: the bodyless HEADs a duplication hammers', () => {
  it('retries objectExists through a transient gateway failure instead of failing the run', async () => {
    let attempts = 0;
    const { adapter, s3 } = adapterUnder((name) => {
      if (name !== 'HeadObject') throw new Error(`unexpected command: ${name}`);
      if (++attempts === 1) throw transient5xx();
      return HEAD_OK;
    });

    await expect(adapter.objectExists('videos/q/main.mp4')).resolves.toBe(true);
    expect(s3.of('HeadObject')).toHaveLength(2);
  });

  it('retries headObject through a transient gateway failure', async () => {
    let attempts = 0;
    const { adapter, s3 } = adapterUnder((name) => {
      if (name !== 'HeadObject') throw new Error(`unexpected command: ${name}`);
      if (++attempts === 1) throw transient5xx();
      return HEAD_OK;
    });

    await expect(adapter.headObject('videos/q/main.mp4')).resolves.toEqual({
      contentType: 'video/mp4', cacheControl: 'no-cache', size: 1234, etag: '"e"',
    });
    expect(s3.of('HeadObject')).toHaveLength(2);
  });

  /**
   * THE HALF THAT IS EASY TO GET WRONG. Wrapping the whole method — 404 absorption and all — would
   * make every genuine miss cost four requests and ~3.5s of backoff, and a duplication asks "does
   * this exist?" about objects that legitimately do not.
   */
  it('answers a genuine 404 immediately, without burning attempts on a settled question', async () => {
    for (const miss of [notFound, notFoundWithoutStatus]) {
      const { adapter, s3 } = adapterUnder((name) => {
        if (name !== 'HeadObject') throw new Error(`unexpected command: ${name}`);
        throw miss();
      });

      await expect(adapter.objectExists('videos/q/gone.mp4')).resolves.toBe(false);
      expect(s3.of('HeadObject')).toHaveLength(1);
    }
  });

  it('answers a genuine 404 from headObject immediately too', async () => {
    for (const miss of [notFound, notFoundWithoutStatus]) {
      const { adapter, s3 } = adapterUnder((name) => {
        if (name !== 'HeadObject') throw new Error(`unexpected command: ${name}`);
        throw miss();
      });

      await expect(adapter.headObject('videos/q/gone.mp4')).resolves.toBeNull();
      expect(s3.of('HeadObject')).toHaveLength(1);
    }
  });

  it('does not turn a permission failure into "missing", and does not retry it either', async () => {
    const { adapter, s3 } = adapterUnder((name) => {
      if (name !== 'HeadObject') throw new Error(`unexpected command: ${name}`);
      throw forbidden();
    });

    await expect(adapter.objectExists('videos/q/main.mp4')).rejects.toThrow(/access denied/);
    expect(s3.of('HeadObject')).toHaveLength(1);
  });

  it('gives up after the last attempt and rethrows, rather than retrying forever', async () => {
    const { adapter, s3 } = adapterUnder((name) => {
      if (name !== 'HeadObject') throw new Error(`unexpected command: ${name}`);
      throw transient5xx();
    });

    await expect(adapter.headObject('videos/q/main.mp4')).rejects.toThrow(/Deserialization error/);
    expect(s3.of('HeadObject')).toHaveLength(4);
  });
});

// ── The socket-inactivity timer, and the one command shape it was sized wrong for ─────────────

/** The resolved `socketTimeout` of a client's request handler. */
async function socketTimeoutOf(client: unknown): Promise<number | undefined> {
  const handler = (client as any).config.requestHandler;
  const cfg = (await handler.configProvider) as { socketTimeout?: number };
  return cfg.socketTimeout;
}

async function connectionTimeoutOf(client: unknown): Promise<number | undefined> {
  const handler = (client as any).config.requestHandler;
  const cfg = (await handler.configProvider) as { connectionTimeout?: number };
  return cfg.connectionTimeout;
}

describe('Supabase: a server-side copy is not killed by the upload wave\'s socket timeout', () => {
  const SRC = 'videos/p/main.mp4';
  const DEST = 'videos/q/main.mp4';
  const SIZE = 6 * 1024 * 1024 * 1024 + 12_345; // over the 5 GiB single-copy wall
  const PARTS = Math.ceil(SIZE / MULTIPART_COPY_PART_BYTES);

  /** `CopyObject` refused for size, then the whole ranged multipart copy. */
  const oversizeStore = (overrides: Partial<Record<string, (input: any) => unknown>> = {}) =>
    (name: string, input: any): unknown => {
      const override = overrides[name];
      if (override) return override(input);
      switch (name) {
        case 'CopyObject':
          throw Object.assign(
            new Error('The specified copy source is larger than the maximum allowable size for a copy source: 5368709120'),
            { name: 'InvalidRequest', $metadata: { httpStatusCode: 400 } },
          );
        case 'HeadObject': return { ContentType: 'video/mp4', CacheControl: 'no-cache', ContentLength: SIZE };
        case 'CreateMultipartUpload': return { UploadId: 'upload-1' };
        case 'UploadPartCopy': return { CopyPartResult: { ETag: `"p${input.PartNumber}"` } };
        case 'CompleteMultipartUpload': return {};
        case 'AbortMultipartUpload': return {};
        default: throw new Error(`unexpected command: ${name}`);
      }
    };

  it('allows a server-side copy far more socket idling than an ordinary request', async () => {
    const { adapter } = adapterUnder(() => ({}));

    // The ordinary client stays impatient — its whole reason for existing is a sim upload wave that
    // must not sit on a black-holed connection.
    expect(await socketTimeoutOf((adapter as any).client)).toBe(SUPABASE_SOCKET_TIMEOUT_MS);
    expect(SUPABASE_SOCKET_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
    // The copy client is sized for the work the gateway does while the socket carries nothing.
    expect(await socketTimeoutOf((adapter as any).copyClient)).toBe(SUPABASE_COPY_SOCKET_TIMEOUT_MS);
    expect(SUPABASE_COPY_SOCKET_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
    // Connecting is fast or it is broken, whatever the object's size, so that budget is unchanged.
    expect(await connectionTimeoutOf((adapter as any).copyClient)).toBe(SUPABASE_CONNECTION_TIMEOUT_MS);
    expect(await connectionTimeoutOf((adapter as any).client)).toBe(SUPABASE_CONNECTION_TIMEOUT_MS);
  });

  it('sends CopyObject and UploadPartCopy on that client, and everything else on the default one', async () => {
    const { adapter, s3 } = adapterUnder(oversizeStore());

    await adapter.copyObject(SRC, DEST);

    // The two whose duration is a function of the object's size while nothing crosses the socket.
    expect(s3.clientsFor('CopyObject')).toEqual(['copyClient']);
    expect(s3.clientsFor('UploadPartCopy')).toEqual(Array.from({ length: PARTS }, () => 'copyClient'));
    // Everything else keeps the short allowance: these answer at once regardless of object size.
    expect(s3.clientsFor('HeadObject')).toEqual(['client']);
    expect(s3.clientsFor('CreateMultipartUpload')).toEqual(['client']);
    expect(s3.clientsFor('CompleteMultipartUpload')).toEqual(['client']);
  });

  it('sends an ordinary small copy on the copy client too — the client is chosen by command, not by size', async () => {
    // The adapter cannot know an object is small without a HEAD it deliberately does not issue, so
    // the allowance is attached to the command shape. A generous idle budget costs a small copy
    // nothing: it returns in milliseconds either way.
    const { adapter, s3 } = adapterUnder((name) => {
      if (name === 'CopyObject') return {};
      throw new Error(`unexpected command: ${name}`);
    });

    await adapter.copyObject('hls/v/run/seg_000.ts', 'hls/w/run/seg_000.ts');

    expect(s3.clientsFor('CopyObject')).toEqual(['copyClient']);
  });

  it('retries a socket timeout rather than failing the copy on it', async () => {
    let attempts = 0;
    const { adapter, s3 } = adapterUnder((name) => {
      if (name !== 'CopyObject') throw new Error(`unexpected command: ${name}`);
      if (++attempts === 1) throw socketTimeout();
      return {};
    });

    await adapter.copyObject(SRC, DEST);

    // A timeout carries no HTTP status at all, and "no status" means transport trouble, which is
    // retryable by definition — the opposite of the permanent refusals next to it.
    expect(s3.of('CopyObject')).toHaveLength(2);
  });

  /**
   * `501 NotImplemented` is a 5xx, so the transport heuristic calls it transient — and it is the
   * one 5xx that never is. On a gateway that does not implement `CopyObject` (this adapter's own
   * documentation calls that "an EXPECTED path, not a curiosity") every object of every duplication
   * paid four attempts and ~3.5s of backoff for an answer the first attempt had already given, then
   * took the read-then-write fallback anyway. A few hundred objects is over ten minutes of pure
   * waiting, inline in the API process.
   */
  it('does not spend the retry budget on an answer the gateway has already settled', async () => {
    const { adapter, s3 } = adapterUnder((name) => {
      switch (name) {
        case 'CopyObject':
          throw Object.assign(new Error('not implemented'), {
            name: 'NotImplemented', $metadata: { httpStatusCode: 501 },
          });
        case 'HeadObject': return { ContentType: 'text/html', ContentLength: 4 };
        case 'GetObject': return { Body: Readable.from([Buffer.from('abcd')]) };
        case 'PutObject': return {};
        default: throw new Error(`unexpected command: ${name}`);
      }
    });

    await adapter.copyObject('sim/p/r/index.html', 'sim/q/r/index.html');

    expect(s3.of('CopyObject')).toHaveLength(1);
    expect(s3.names()).toContain('PutObject'); // and it still took the fallback it was headed for
  });

  it('lets a timeout that outlives the retries surface as itself, transient and unclassified', async () => {
    const { adapter, s3 } = adapterUnder((name) => {
      if (name !== 'CopyObject') throw new Error(`unexpected command: ${name}`);
      throw socketTimeout();
    });

    let caught: unknown;
    await adapter.copyObject(SRC, DEST).catch((err: unknown) => { caught = err; });

    expect((caught as Error)?.name).toBe('TimeoutError');
    // NOT permanent: "try again" is the right advice for this one, and a classifier that read it as
    // a ceiling or as an unsupported gateway would either give up or start a doomed fallback.
    expect(caught).not.toBeInstanceOf(PermanentStorageError);
    expect(isCopyTooLarge(caught)).toBe(false);
    expect(isCopyUnsupported(caught)).toBe(false);
    // And it took neither fallback: no download, no multipart.
    expect(s3.names()).not.toContain('GetObject');
    expect(s3.names()).not.toContain('CreateMultipartUpload');
  });
});
