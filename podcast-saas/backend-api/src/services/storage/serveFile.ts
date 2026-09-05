import { stat as fsStat, createReadStream } from 'fs';
import { promisify } from 'util';
import type { FastifyReply, FastifyRequest } from 'fastify';

const statAsync = promisify(fsStat);

interface ServeOpts {
  cacheControl?: string;
  extraHeaders?: Record<string, string>;
  /**
   * Emit stat-derived validators (`Last-Modified` + a weak `W/"<size>-<mtimeMs>"` ETag) and
   * answer a matching conditional request with `304 Not Modified` instead of the bytes.
   *
   * OPT-IN, because until now no caller of this function sent any validator at all, and the
   * routes that serve media (HLS, video-raw) are byte-tested against today's exact headers.
   * The sim-public route turns it on: a 30MB simulation package was re-downloaded IN FULL on
   * every editor/library preview mount because non-revision package files carried neither
   * Cache-Control nor any validator — no header at all means the browser has nothing to
   * revalidate with, so "open the section editor again" cost the whole package again
   * (measured 2026-09-05, EDITOR-PERF.md). The ETag is WEAK by construction — (size, mtime)
   * asserts equivalence, not byte identity — which is exactly the claim a stat can honestly
   * make, and RFC 9110 permits weak comparison for If-None-Match on GET.
   */
  statValidators?: boolean;
}

/** Weak validator from the file's stat: changes whenever the bytes are rewritten in place. */
const statEtag = (size: number, mtimeMs: number): string => `W/"${size.toString(16)}-${Math.trunc(mtimeMs).toString(16)}"`;

/** RFC 9110 §13.1.2 weak comparison: strip `W/`, honour `*`, compare opaque tags. */
function ifNoneMatchSatisfied(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === '*') return true;
  const bare = etag.replace(/^W\//, '');
  return header.split(',').some((c) => c.trim().replace(/^W\//, '') === bare);
}

/**
 * Serve a local file by **streaming** it (never `readFile`-into-heap) with HTTP Range
 * support, so large media doesn't blow the Node heap and browser `<video>` seeking works.
 * The caller must pass an already path-traversal-checked absolute path (see safeLocalPath).
 */
export async function serveLocalFile(
  request: FastifyRequest,
  reply: FastifyReply,
  absPath: string,
  contentType: string,
  opts: ServeOpts = {},
): Promise<unknown> {
  let fileSize: number;
  let mtimeMs: number;
  try {
    const st = await statAsync(absPath);
    fileSize = st.size;
    mtimeMs = st.mtimeMs;
  } catch {
    return reply.code(404).send({ message: 'File not found' });
  }

  reply.header('Content-Type', contentType).header('Accept-Ranges', 'bytes');
  if (opts.cacheControl) reply.header('Cache-Control', opts.cacheControl);
  for (const [k, v] of Object.entries(opts.extraHeaders ?? {})) reply.header(k, v);

  if (opts.statValidators) {
    const etag = statEtag(fileSize, mtimeMs);
    reply.header('ETag', etag).header('Last-Modified', new Date(mtimeMs).toUTCString());
    // Conditional check BEFORE Range handling: a 304 answer to a revalidation is correct even
    // when the stale cache entry being revalidated was a ranged response. If-None-Match wins
    // over If-Modified-Since when both are present (RFC 9110 §13.1.3).
    const inm = request.headers['if-none-match'];
    const ims = request.headers['if-modified-since'];
    let notModified = false;
    if (inm) {
      notModified = ifNoneMatchSatisfied(inm, etag);
    } else if (ims) {
      const since = Date.parse(ims);
      // mtime truncated to whole seconds: HTTP dates carry no milliseconds.
      notModified = Number.isFinite(since) && Math.trunc(mtimeMs / 1000) * 1000 <= since;
    }
    if (notModified) {
      // 304 keeps the validator + cache headers set above; no body, no stream opened.
      return reply.code(304).send();
    }
  }

  const rangeHeader = request.headers['range'];
  if (rangeHeader) {
    // Parse "bytes=START-END", including suffix "bytes=-N" and open-end "bytes=N-".
    const rangeValue = rangeHeader.replace(/^bytes=/, '');
    const dashIdx = rangeValue.indexOf('-');
    const startStr = rangeValue.slice(0, dashIdx);
    const endStr = rangeValue.slice(dashIdx + 1);

    let start: number;
    let end: number;
    if (startStr === '') {
      start = Math.max(0, fileSize - parseInt(endStr, 10));
      end = fileSize - 1;
    } else {
      start = parseInt(startStr, 10);
      end = endStr ? parseInt(endStr, 10) : fileSize - 1;
    }
    end = Math.min(end, fileSize - 1);

    if (Number.isNaN(start) || Number.isNaN(end) || start > end) {
      return reply.code(416).header('Content-Range', `bytes */${fileSize}`).send();
    }

    reply
      .code(206)
      .header('Content-Range', `bytes ${start}-${end}/${fileSize}`)
      .header('Content-Length', end - start + 1);
    return reply.send(createReadStream(absPath, { start, end }));
  }

  reply.header('Content-Length', fileSize);
  return reply.send(createReadStream(absPath));
}
