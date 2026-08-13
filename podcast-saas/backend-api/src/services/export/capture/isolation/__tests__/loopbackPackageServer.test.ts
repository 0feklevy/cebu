/**
 * Loopback package server — the one isolation piece fully verifiable on macOS (it is a plain
 * node:http server). These tests pin the properties §0.2 depends on: it serves the package files with
 * the right content-types, it REFUSES path traversal, and it binds 127.0.0.1 — never 0.0.0.0.
 *
 * What these tests do NOT prove (and cannot, off a Linux container): that `--network none` blocks
 * egress while this loopback socket still serves. That is the container-verification checklist in
 * md-files/EXPORT-CAPTURE-ISOLATION.md.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  LoopbackPackageServer,
  contentTypeForPath,
  PACKAGE_CACHE_CONTROL,
  type LoopbackPackageFile,
} from '../loopbackPackageServer.js';

const PACKAGE: LoopbackPackageFile[] = [
  { path: 'package/index.html', content: Buffer.from('<!doctype html><title>sim</title>') },
  { path: 'package/app.js', content: Buffer.from('console.log(1)') },
  { path: 'package/data.json', content: Buffer.from('{"a":1}') },
  { path: 'package/style.css', content: Buffer.from('body{}') },
  { path: 'package/mod.wasm', content: Buffer.from([0x00, 0x61, 0x73, 0x6d]) },
];

let running: LoopbackPackageServer | null = null;
afterEach(async () => {
  await running?.stop();
  running = null;
});

interface Fetched {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

/** A minimal raw HTTP GET/HEAD against a loopback origin, so we see exact status + headers. */
function fetchRaw(origin: string, path: string, method = 'GET'): Promise<Fetched> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, origin);
    const req = request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function startServer(
  files: LoopbackPackageFile[] = PACKAGE,
  opts?: ConstructorParameters<typeof LoopbackPackageServer>[1],
): Promise<LoopbackPackageServer> {
  const server = new LoopbackPackageServer(files, { entryPath: 'package/index.html', ...opts });
  await server.start();
  running = server;
  return server;
}

describe('LoopbackPackageServer — serving', () => {
  it('serves the entry HTML as text/html', async () => {
    const server = await startServer();
    const res = await fetchRaw(server.origin, '/package/index.html');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.body.toString()).toContain('<title>sim</title>');
    expect(res.headers['cache-control']).toBe(PACKAGE_CACHE_CONTROL);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('serves JS as text/javascript (the type the sim expects)', async () => {
    const server = await startServer();
    const res = await fetchRaw(server.origin, '/package/app.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/javascript; charset=utf-8');
  });

  it('serves json, css and wasm with correct types', async () => {
    const server = await startServer();
    expect((await fetchRaw(server.origin, '/package/data.json')).headers['content-type']).toBe('application/json; charset=utf-8');
    expect((await fetchRaw(server.origin, '/package/style.css')).headers['content-type']).toBe('text/css; charset=utf-8');
    expect((await fetchRaw(server.origin, '/package/mod.wasm')).headers['content-type']).toBe('application/wasm');
  });

  it('serves the entry at / when configured', async () => {
    const server = await startServer();
    const res = await fetchRaw(server.origin, '/');
    expect(res.status).toBe(200);
    expect(res.body.toString()).toContain('<title>sim</title>');
  });

  it('honours the manifest content-type over the extension', async () => {
    const server = await startServer([
      { path: 'weird.bin', content: Buffer.from('x'), contentType: 'text/html; charset=utf-8' },
    ], { entryPath: undefined });
    expect((await fetchRaw(server.origin, '/weird.bin')).headers['content-type']).toBe('text/html; charset=utf-8');
  });

  it('HEAD returns headers and no body', async () => {
    const server = await startServer();
    const res = await fetchRaw(server.origin, '/package/app.js', 'HEAD');
    expect(res.status).toBe(200);
    expect(res.headers['content-length']).toBe(String(Buffer.from('console.log(1)').byteLength));
    expect(res.body.byteLength).toBe(0);
  });

  it('entryUrl preserves query and fragment verbatim', async () => {
    const server = await startServer();
    const url = server.entryUrl('?section=abc&v=deadbeef', '#simboot=1');
    expect(url).toBe(`${server.origin}/package/index.html?section=abc&v=deadbeef#simboot=1`);
  });
});

describe('LoopbackPackageServer — refusing traversal & bad requests', () => {
  it('rejects a ../ traversal with 400 and leaks nothing', async () => {
    const server = await startServer();
    for (const p of ['/../secret', '/package/../../etc/passwd', '/..%2f..%2fetc%2fpasswd']) {
      const res = await fetchRaw(server.origin, p);
      // 400 for a path that normalizes to null; either way it must not be 200 and must not leak.
      expect([400, 404]).toContain(res.status);
      expect(res.body.toString()).not.toContain('root:');
    }
  });

  it('rejects an encoded NUL byte', async () => {
    const server = await startServer();
    const res = await fetchRaw(server.origin, '/package/app.js%00.txt');
    expect(res.status).toBe(400);
  });

  it('returns 404 for a path not in the package (no filesystem to reach)', async () => {
    const server = await startServer();
    const res = await fetchRaw(server.origin, '/package/does-not-exist.js');
    expect(res.status).toBe(404);
  });

  it('returns 405 for a write verb', async () => {
    const server = await startServer();
    const res = await fetchRaw(server.origin, '/package/app.js', 'POST');
    expect(res.status).toBe(405);
    expect(res.headers['allow']).toBe('GET, HEAD');
  });
});

describe('LoopbackPackageServer — binding', () => {
  it('binds 127.0.0.1, never 0.0.0.0', async () => {
    const server = await startServer();
    // Reported bind host
    expect(server.boundHost).toBe('127.0.0.1');
    // And the actual socket address
    const addr = (server as unknown as { server: { address(): AddressInfo } }).server.address();
    expect(addr.address).toBe('127.0.0.1');
    expect(addr.address).not.toBe('0.0.0.0');
  });

  it('refuses to construct with a non-loopback host', () => {
    expect(() => new LoopbackPackageServer(PACKAGE, { host: '0.0.0.0' })).toThrow(/non-loopback/);
    expect(() => new LoopbackPackageServer(PACKAGE, { host: '10.0.0.5' })).toThrow(/non-loopback/);
  });

  it('accepts ::1 as a loopback literal', () => {
    expect(() => new LoopbackPackageServer(PACKAGE, { host: '::1' })).not.toThrow();
  });
});

describe('LoopbackPackageServer — construction guards', () => {
  it('rejects a package path containing ..', () => {
    expect(() => new LoopbackPackageServer([{ path: '../evil.js', content: Buffer.from('') }])).toThrow(/not representable/);
  });

  it('rejects an entryPath that is not a package file', () => {
    expect(() => new LoopbackPackageServer(PACKAGE, { entryPath: 'nope.html' })).toThrow(/not one of the package files/);
  });

  it('rejects duplicate normalized paths', () => {
    expect(
      () => new LoopbackPackageServer([
        { path: 'a.js', content: Buffer.from('1') },
        { path: '/a.js', content: Buffer.from('2') },
      ]),
    ).toThrow(/duplicate/);
  });
});

describe('contentTypeForPath', () => {
  it('maps the sim-critical extensions', () => {
    expect(contentTypeForPath('x/index.html')).toBe('text/html; charset=utf-8');
    expect(contentTypeForPath('x/app.js')).toBe('text/javascript; charset=utf-8');
    expect(contentTypeForPath('x/app.mjs')).toBe('text/javascript; charset=utf-8');
    expect(contentTypeForPath('x/unknown.xyz')).toBe('application/octet-stream');
    expect(contentTypeForPath('noext')).toBe('application/octet-stream');
  });
});
