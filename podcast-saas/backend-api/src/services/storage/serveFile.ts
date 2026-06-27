import { stat as fsStat, createReadStream } from 'fs';
import { promisify } from 'util';
import type { FastifyReply, FastifyRequest } from 'fastify';

const statAsync = promisify(fsStat);

interface ServeOpts {
  cacheControl?: string;
  extraHeaders?: Record<string, string>;
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
  try {
    fileSize = (await statAsync(absPath)).size;
  } catch {
    return reply.code(404).send({ message: 'File not found' });
  }

  reply.header('Content-Type', contentType).header('Accept-Ranges', 'bytes');
  if (opts.cacheControl) reply.header('Cache-Control', opts.cacheControl);
  for (const [k, v] of Object.entries(opts.extraHeaders ?? {})) reply.header(k, v);

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
