/**
 * The loopback package server — the crux of "no network egress, structurally" (plan §0.2).
 *
 * The capture container runs UNTRUSTED code (simulation HTML/JS generated from user prompts, plus a
 * ZIP-upload path — i.e. arbitrary JavaScript). The design does NOT try to filter what that code may
 * reach; it removes the reach. The container runs with `--network none`, so there is no route to the
 * AWS metadata endpoint, the backend, Postgres, or any internal service — SSRF is impossible by
 * construction, not by deny-list.
 *
 * But Chrome still has to load the simulation from *somewhere*. The resolution, verified as the crux
 * of the design (see md-files/EXPORT-CAPTURE-ISOLATION.md): the loopback interface `lo` is ALWAYS up
 * inside a `--network none` network namespace — `--network none` removes the veth pair and the
 * default route, not `lo`. So the (already-immutable) package bytes are fetched on the TRUSTED side
 * (which has the DB and mints presigned URLs), handed into the container, and served by THIS server
 * bound to `127.0.0.1`. Chrome navigates to `http://127.0.0.1:<port>/<entry>`. The loopback socket
 * works; every external destination does not.
 *
 * This file is TRUSTED code (ours, small, auditable) even though it runs alongside untrusted Chrome
 * in the same network namespace. Two properties make it safe to sit next to arbitrary JavaScript:
 *
 *   1. It serves from a FROZEN in-memory map, not a filesystem. There is no path to resolve against
 *      a directory, so directory traversal is structurally impossible: a request path is a key
 *      lookup, and a key that is not in the map is a 404 — it can never become an `open()` of
 *      `/etc/passwd` or of the untrusted-writable tmpfs. The bytes served are exactly the bytes the
 *      trusted side vetted and loaded; nothing the browser writes later can change them.
 *   2. It can only ever bind a loopback address. A non-loopback host is rejected at construction, so
 *      "accidentally bound 0.0.0.0" is not a mistake this class can make.
 *
 * It is fully unit-testable on macOS (it is a plain `node:http` server) — which is deliberate: the
 * one part of the isolation story that does NOT require a Linux container to verify is exactly the
 * part that lets the container have no network.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { normalizeManifestPath } from 'shared/sim/simManifest';

/** The two loopback literals we will bind. Anything else is rejected — see the class doc. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1']);

/**
 * The Cache-Control served with every package object. Revision bytes are immutable by the revision
 * model (the id is in the path; bytes under an id are never rewritten), so this is both correct and
 * a small determinism aid: the browser cannot be handed two different bodies for one URL.
 */
export const PACKAGE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/**
 * Content-type by extension. The sim expects `text/html` for its entry document and
 * `text/javascript` for its scripts (the two the plan calls out explicitly); the rest cover the
 * assets a generated package realistically ships. A manifest-supplied `contentType` always wins over
 * this table — the manifest records the authoritative type the file was stored with — and this map
 * is only the fallback for a file that arrived without one.
 */
const CONTENT_TYPE_BY_EXT: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  cjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  css: 'text/css; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  wasm: 'application/wasm',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

/** Resolve a content-type from a normalized path's extension; falls back to octet-stream. */
export function contentTypeForPath(path: string): string {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return DEFAULT_CONTENT_TYPE;
  const ext = path.slice(dot + 1).toLowerCase();
  return CONTENT_TYPE_BY_EXT[ext] ?? DEFAULT_CONTENT_TYPE;
}

/** One file of the package, as loaded by the trusted side. */
export interface LoopbackPackageFile {
  /**
   * Normalized, prefix-relative POSIX path — exactly as it appears in the sim manifest
   * (`SimManifestFile.path`). Rejected at construction if it does not normalize (absolute, `..`,
   * backslash, NUL) so a malformed package fails loudly on the trusted side, never at request time.
   */
  path: string;
  /** The exact stored bytes. Frozen once loaded; the server never mutates or re-reads them. */
  content: Buffer;
  /** Authoritative content-type from the manifest; the extension table is the fallback. */
  contentType?: string;
}

export interface LoopbackPackageServerOptions {
  /**
   * The bind host. Defaults to `127.0.0.1` and MUST be a loopback literal — a non-loopback value
   * throws. This is what makes "bound to the outside world" un-representable rather than merely
   * discouraged.
   */
  host?: string;
  /** Bind port. `0` (the default) asks the OS for an ephemeral port; read the real one from `.port`. */
  port?: number;
  /**
   * The manifest entry path, served at `/`. Optional: the capture host navigates to the full entry
   * URL anyway, but serving it at the root makes the server usable without knowing the entry name.
   */
  entryPath?: string;
}

/**
 * A read-only static server for one simulation package, bound to loopback, serving from memory.
 *
 * Lifecycle: construct with the package files, `await start()`, read `.port` / `.entryUrl()`, point
 * the browser at it, `await stop()` in a finally. Construction validates every path and the host;
 * start/stop are idempotent-safe against their own state.
 */
export class LoopbackPackageServer {
  private readonly files: ReadonlyMap<string, { content: Buffer; contentType: string }>;
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly entryPath: string | null;
  private server: Server | null = null;
  private boundPort: number | null = null;

  constructor(files: readonly LoopbackPackageFile[], options: LoopbackPackageServerOptions = {}) {
    const host = options.host ?? '127.0.0.1';
    if (!LOOPBACK_HOSTS.has(host)) {
      // Fail closed: the whole point is that this can only ever be reachable from inside the netns.
      throw new Error(
        `LoopbackPackageServer refuses a non-loopback host: ${JSON.stringify(host)} (allowed: 127.0.0.1, ::1)`,
      );
    }
    this.host = host;
    this.requestedPort = options.port ?? 0;

    const map = new Map<string, { content: Buffer; contentType: string }>();
    for (const file of files) {
      const normalized = normalizeManifestPath(file.path);
      if (normalized === null) {
        throw new Error(`LoopbackPackageServer: package path is not representable: ${JSON.stringify(file.path)}`);
      }
      if (map.has(normalized)) {
        throw new Error(`LoopbackPackageServer: duplicate package path after normalization: ${normalized}`);
      }
      map.set(normalized, {
        content: file.content,
        contentType: file.contentType ?? contentTypeForPath(normalized),
      });
    }
    this.files = map;

    if (options.entryPath !== undefined) {
      const entry = normalizeManifestPath(options.entryPath);
      if (entry === null || !map.has(entry)) {
        throw new Error(`LoopbackPackageServer: entryPath is not one of the package files: ${JSON.stringify(options.entryPath)}`);
      }
      this.entryPath = entry;
    } else {
      this.entryPath = null;
    }
  }

  /** Start listening. Resolves once bound; rejects on listen error. */
  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((req, res) => this.handle(req, res));
    // A slow-loris on loopback is not a threat model here, but a bounded header timeout keeps a
    // wedged request from holding the process open past the job's wall-clock cap.
    server.headersTimeout = 5_000;
    server.requestTimeout = 10_000;
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => reject(err);
      server.once('error', onError);
      server.listen({ host: this.host, port: this.requestedPort }, () => {
        server.removeListener('error', onError);
        const addr = server.address() as AddressInfo | null;
        this.boundPort = addr?.port ?? null;
        this.server = server;
        resolve();
      });
    });
  }

  /** Stop listening and drop the socket. Safe to call when never started. */
  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    this.boundPort = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** The actually-bound port (may differ from the requested one when 0 was asked). */
  get port(): number {
    if (this.boundPort === null) throw new Error('LoopbackPackageServer: not started');
    return this.boundPort;
  }

  /** The address this server is bound to — always a loopback literal, exposed for assertions. */
  get boundHost(): string {
    return this.host;
  }

  /** The base origin, e.g. `http://127.0.0.1:54321`. IPv6 loopback is bracketed. */
  get origin(): string {
    const hostPart = this.host.includes(':') ? `[${this.host}]` : this.host;
    return `http://${hostPart}:${this.port}`;
  }

  /** A full URL for one package path, optionally with a preserved query and fragment. */
  urlFor(path: string, query = '', fragment = ''): string {
    const rel = path.replace(/^\/+/, '');
    return `${this.origin}/${rel}${query}${fragment}`;
  }

  /** The entry URL (requires `entryPath` in options). `query`/`fragment` are appended verbatim. */
  entryUrl(query = '', fragment = ''): string {
    if (this.entryPath === null) throw new Error('LoopbackPackageServer: no entryPath configured');
    return this.urlFor(this.entryPath, query, fragment);
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    // Only reads. The container never PUTs here — output leaves via a bind-mounted dir the trusted
    // side reads, never over this socket — so any write verb is a 405.
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('method not allowed');
      return;
    }

    let pathname: string;
    try {
      // Parse against a fixed loopback base; only the path is used, query/fragment are the caller's.
      pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      pathname = decodeURIComponent(pathname);
    } catch {
      // Malformed percent-encoding (e.g. `%zz`, `%00` producing a NUL) — reject, do not guess.
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('bad request');
      return;
    }

    // Root → the entry document, when one is configured.
    if (pathname === '/' || pathname === '') {
      if (this.entryPath) {
        this.serve(this.entryPath, method, res);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }

    // The SAME normalizer the package was built with. A path it refuses (`..`, backslash, NUL,
    // empty segment, absolute after slash-strip) is a 400 — it is not a typo, it is an attempt to
    // address something outside the package, and there is nothing outside the package to address.
    const normalized = normalizeManifestPath(pathname);
    if (normalized === null) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('bad request');
      return;
    }

    this.serve(normalized, method, res);
  }

  private serve(normalized: string, method: string, res: ServerResponse): void {
    const entry = this.files.get(normalized);
    if (!entry) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': entry.contentType,
      'Content-Length': entry.content.byteLength,
      'Cache-Control': PACKAGE_CACHE_CONTROL,
      // The bytes are untrusted-authored content served to an untrusted browser; nosniff keeps a
      // mislabelled asset from being reinterpreted as script by the loader.
      'X-Content-Type-Options': 'nosniff',
    });
    if (method === 'HEAD') {
      res.end();
      return;
    }
    res.end(entry.content);
  }
}
