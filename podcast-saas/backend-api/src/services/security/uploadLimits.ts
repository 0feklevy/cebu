// ONE shape for every route that accepts an uploaded file (security-007, performance-001/-002/
// -003/-005).
//
// ── WHAT WAS WRONG ──────────────────────────────────────────────────────────────────────────
// Five routes had the same body:
//
//     const data = await request.file();
//     const buf  = await data.toBuffer();      // the WHOLE file, into the Node heap
//
// with no declared-size check before it and no byte ceiling during it. The only bound was the
// global `@fastify/multipart` registration — 10 GB — which is not a bound, it is a number. On the
// 2-vCPU / small-RAM host this runs on, two concurrent uploads are an out-of-memory kill of the
// whole API process, and the client that caused it gets nothing back, because there is no process
// left to answer.
//
// ── THE SHAPE ───────────────────────────────────────────────────────────────────────────────
// Every guarded route now does the same three things, in this order:
//
//   1. DECLARED FIRST.   `Content-Length` is a free, exact-enough answer available before a byte
//                        of body is read. Refusing here means we never begin spooling something
//                        we have already decided to reject, and the client gets a 413 that names
//                        the real number instead of a proxy error page or a dead socket.
//   2. THEN STREAMED.    Content-Length can be absent (chunked) or a lie, so the bytes are counted
//                        as they arrive and the stream is destroyed the moment it passes the
//                        ceiling. This is the guard that actually holds.
//   3. TO DISK, NOT HEAP, where the route allows it. `withBoundedTempFile` lands the bytes on
//                        disk in 64 KiB pieces, so peak heap is a chunk rather than a file.
//                        Routes whose consumer genuinely needs a Buffer (a document extractor
//                        that parses in memory) use `readStreamBounded` instead and are simply
//                        capped much lower.
//
// ── WHY THE CEILING IS DERIVED, NOT CHOSEN ──────────────────────────────────────────────────
// `parseNginxSize` / `streamUploadMaxFileBytes` moved here from video.controller.ts, which still
// re-exports them, so there is exactly one derivation in the codebase. Every byte of these routes
// crosses nginx, whose `client_max_body_size` is `MAX_UPLOAD_SIZE` (deploy/.env, default `2g`).
// A route that advertises more than the proxy passes is a 413 the client cannot explain, arriving
// after the transfer has already begun. So each route states an APP cap for its own content type,
// and the effective ceiling is the smaller of that and what the proxy will pass.

import { createWriteStream } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const MIB = 1024 * 1024;
const GIB = 1024 * 1024 * 1024;

/** nginx size syntax: bare bytes, or a `k`/`m`/`g` suffix. Returns null if unparseable. */
export function parseNginxSize(value: string | undefined): number | null {
  if (!value) return null;
  const m = /^(\d+)\s*([kmg])?$/i.exec(value.trim());
  if (!m) return null;
  const scale = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[(m[2] ?? '').toLowerCase()] ?? 1;
  const bytes = Number(m[1]) * scale;
  return bytes > 0 ? bytes : null;
}

/** Multipart envelope overhead (boundaries, part headers, any sibling fields). */
const MULTIPART_ENVELOPE_ALLOWANCE = 64 * 1024;

/**
 * The largest FILE a proxied multipart route may accept, given both constraints. It is the
 * smaller of the app cap and what fits inside the proxy's whole-body limit once the multipart
 * envelope is accounted for — a file at exactly the proxy limit is still one boundary too big.
 */
export function streamUploadMaxFileBytes(i: { proxyBodyLimitBytes: number; appMaxBytes: number }): number {
  return Math.max(1, Math.min(i.appMaxBytes, i.proxyBodyLimitBytes - MULTIPART_ENVELOPE_ALLOWANCE));
}

/** What nginx will pass through as one request body. */
export const PROXY_BODY_LIMIT_BYTES = parseNginxSize(process.env.MAX_UPLOAD_SIZE) ?? 2 * GIB;

/**
 * The global `@fastify/multipart` ceiling (performance-005). It is the proxy's limit, not a
 * number picked out of the air: a part larger than what nginx forwards cannot reach us anyway, so
 * declaring 10 GB only meant that a route which forgot its own limit had none. Routes that need
 * less say so per route; the direct-to-storage upload paths (presigned PUT, S3 multipart) never
 * pass through this plugin and keep their own, larger cap.
 */
export const GLOBAL_MULTIPART_FILE_LIMIT_BYTES = PROXY_BODY_LIMIT_BYTES;

/** An app cap, clamped to what the proxy in front of us will actually deliver. */
export function uploadCeilingBytes(appMaxBytes: number): number {
  return streamUploadMaxFileBytes({ proxyBodyLimitBytes: PROXY_BODY_LIMIT_BYTES, appMaxBytes });
}

/** An env override that must be a positive integer to count; anything else falls back. */
function envBytes(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Per-content-type ceilings, in one table so no call site invents a number.
 *
 * ── HOW THESE WERE SIZED ────────────────────────────────────────────────────────────────────
 * A false rejection of a legitimate file is a product outage, so each default sits far above any
 * real payload and is env-overridable. They are read at import time; a test that needs a small
 * ceiling re-imports the module with the variable set.
 *
 *   audio          1 GiB    Streams to disk, so heap cost is one 64 KiB chunk regardless. A
 *                           2-hour uncompressed WAV is ~1.3 GB, a 2-hour MP3 ~115 MB; 1 GiB
 *                           covers every compressed form with room to spare while still being
 *                           ten times below the 10 GB that used to apply.
 *   corpusSource   1 GiB    Same route shape, and it accepts audio AND video (detectSourceType),
 *                           so it gets the same allowance. Also streams to disk.
 *   podcastSource  100 MiB  The ONLY one that must stay in the heap: PDFIngester/DocumentIngester
 *                           take a Buffer and parse it in memory, so the ceiling here is a real
 *                           memory budget, not a transfer budget. 100 MiB is a vast PDF — the
 *                           parse, not the upload, is what a bigger one would kill.
 *   simulationZip  256 MiB  Matches zipGuard's `maxUncompressedBytes`, and the unit is the point.
 *                           An earlier value of 250 MiB was justified as "exactly
 *                           SIMULATION_UPLOAD_MAX_BYTES", but that limit is on the COMPRESSED
 *                           transfer while this guard sums UNCOMPRESSED `readObject` lengths.
 *                           A 120 MB zip that expands to 260 MiB uploaded fine and then became
 *                           permanently un-downloadable, with a 413 telling its owner to "remove
 *                           unused assets and re-upload" — advice about a package the platform
 *                           had already accepted. The ceiling that matters on the way out is the
 *                           largest package that could have come IN uncompressed, which is
 *                           zipGuard's 256 MiB. A guard that refuses legitimate data is a bug
 *                           wearing a guard's clothes.
 */
export const UPLOAD_MAX_BYTES = {
  audio: uploadCeilingBytes(envBytes('MAX_AUDIO_UPLOAD_BYTES', 1 * GIB)),
  corpusSource: uploadCeilingBytes(envBytes('MAX_CORPUS_UPLOAD_BYTES', 1 * GIB)),
  podcastSource: uploadCeilingBytes(envBytes('MAX_PODCAST_SOURCE_BYTES', 100 * MIB)),
  simulationZip: envBytes('MAX_SIM_DOWNLOAD_BYTES', 256 * MIB),
} as const;

export function humanBytes(n: number): string {
  if (n >= GIB) return `${(n / GIB).toFixed(1)} GB`;
  if (n >= MIB) return `${Math.round(n / MIB)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

/** One wording for every over-limit refusal, so a client can always show the real number. */
export function tooLargeMessage(what: string, observedBytes: number, limitBytes: number): string {
  const observed = observedBytes > 0 ? ` (${humanBytes(observedBytes)})` : '';
  return `${what} is too large${observed}. The maximum is ${humanBytes(limitBytes)}.`;
}

/** Thrown by the streaming guards; routes turn it into a 413. */
export class UploadTooLargeError extends Error {
  readonly statusCode = 413;
  constructor(readonly what: string, readonly observedBytes: number, readonly limitBytes: number) {
    super(tooLargeMessage(what, observedBytes, limitBytes));
    this.name = 'UploadTooLargeError';
  }
}

/**
 * GUARD 1 — the declared envelope, checked before any part is read.
 *
 * Returns the declared byte count when it is over the limit (so the caller can name it), or null
 * when there is nothing to object to. An ABSENT or unparseable Content-Length is not an objection:
 * a chunked body legitimately has none, and guard 2 is what actually holds the line.
 *
 * The limit compared against is the limit PLUS the envelope allowance, because Content-Length
 * measures the whole multipart body — boundaries and headers included — not just the file.
 */
export function declaredTooLarge(contentLength: unknown, limitBytes: number): number | null {
  const declared = Number(Array.isArray(contentLength) ? contentLength[0] : contentLength);
  if (!Number.isFinite(declared) || declared <= 0) return null;
  return declared > limitBytes + MULTIPART_ENVELOPE_ALLOWANCE ? declared : null;
}

/** True once busboy itself truncated the part (a second line of defence, and a silent one). */
function wasTruncated(stream: NodeJS.ReadableStream): boolean {
  return (stream as NodeJS.ReadableStream & { truncated?: boolean }).truncated === true;
}

/**
 * GUARD 2a — read a multipart file part into a Buffer, refusing at `limitBytes`.
 *
 * For consumers that genuinely need the bytes in memory. The stream is destroyed as soon as the
 * ceiling is passed, so an attacker's 10 GB body costs `limitBytes`, not 10 GB — and busboy's own
 * truncation flag is checked too, because a SILENTLY truncated file is a corrupt object stored
 * under a name that claims to be the real one.
 */
export async function readStreamBounded(
  stream: NodeJS.ReadableStream,
  limitBytes: number,
  what: string,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > limitBytes) {
      (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
      throw new UploadTooLargeError(what, total, limitBytes);
    }
    chunks.push(chunk);
  }
  if (wasTruncated(stream)) throw new UploadTooLargeError(what, limitBytes, limitBytes);
  return Buffer.concat(chunks);
}

/**
 * GUARD 2b — spool a multipart file part to a temp file, refusing at `limitBytes`.
 *
 * The heap cost is one chunk, whatever the file size, which is the whole point: this is what lets
 * the audio and corpus routes keep a generous ceiling without that ceiling being a memory budget.
 * The temp directory is removed before returning, on every path, including a throw.
 *
 * `fn` receives the on-disk path and the exact byte count, and its return value is the caller's.
 */
export async function withBoundedTempFile<T>(
  stream: NodeJS.ReadableStream,
  opts: { limitBytes: number; what: string; suffix?: string },
  fn: (file: { path: string; bytes: number }) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'upload-'));
  const path = join(dir, `part${opts.suffix ?? ''}`);
  try {
    const bytes = await writeStreamBounded(stream, path, opts.limitBytes, opts.what);
    return await fn({ path, bytes });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Pipe `stream` to `destPath`, aborting at `limitBytes`. Returns the bytes written. */
async function writeStreamBounded(
  stream: NodeJS.ReadableStream,
  destPath: string,
  limitBytes: number,
  what: string,
): Promise<number> {
  const out = createWriteStream(destPath);
  let total = 0;
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      total += chunk.length;
      if (total > limitBytes) {
        (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
        throw new UploadTooLargeError(what, total, limitBytes);
      }
      if (!out.write(chunk)) {
        // BOTH listeners must come off, not just the one that fired. `once('drain')` removes
        // itself when it fires; `once('error')` does not, so every backpressure pause left one
        // more error listener attached — an unbounded per-request leak inside the function whose
        // entire purpose is bounding memory. Reproduced at 16 MiB:
        // "MaxListenersExceededWarning: 11 error listeners added to [WriteStream]". At the 1 GiB
        // ceiling with 64 KiB chunks that is on the order of 10^4 listeners, plus a
        // rejected-but-unawaited promise per drain.
        await new Promise<void>((resolve, reject) => {
          const onDrain = () => { out.off('error', onError); resolve(); };
          const onError = (err: Error) => { out.off('drain', onDrain); reject(err); };
          out.once('drain', onDrain);
          out.once('error', onError);
        });
      }
    }
    if (wasTruncated(stream)) throw new UploadTooLargeError(what, limitBytes, limitBytes);
  } finally {
    await new Promise<void>((resolve) => out.end(resolve));
  }
  return total;
}
