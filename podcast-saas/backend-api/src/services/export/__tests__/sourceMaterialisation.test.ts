/**
 * media-007 — how the assembler gets a source master onto local disk.
 *
 * The defect: `writeFile(path, await storage.readObject(key))`. `readObject` resolves with the
 * WHOLE object as one Buffer (R2StorageAdapter concatenates every chunk before returning), so
 * every source master — the podcast's own multi-GB main video included — was held in the heap
 * in full before a byte reached disk, on the same 2-vCPU/small-RAM worker that runs the encode.
 *
 * The fix asserted here: stream storage → disk, the same presigned-URL + `pipeline` route
 * `runVideoTranscode` already uses for the HLS source. No real encode and no real network:
 * a loopback HTTP server plays object storage.
 *
 * The guard that makes this a real red-to-green: the storage double's `readObject` THROWS.
 * A materialiser that buffers cannot pass, whatever else it does.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AddressInfo } from 'node:net';

import { materialiseSource, type AssemblerStorage } from '../LinearAssembler.js';

/** 6 MiB of deterministic bytes, served in 64 KiB chunks — big enough that buffering shows. */
const CHUNK = Buffer.alloc(64 * 1024, 0xab);
const CHUNKS = 96;
const EXPECTED_BYTES = CHUNK.length * CHUNKS;
const EXPECTED_SHA = (() => {
  const h = createHash('sha256');
  for (let i = 0; i < CHUNKS; i++) h.update(CHUNK);
  return h.digest('hex');
})();

let server: Server | null = null;
let scratch: string | null = null;

async function serveObject(): Promise<string> {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(EXPECTED_BYTES) });
    let i = 0;
    const push = (): void => {
      while (i < CHUNKS) {
        i++;
        if (!res.write(CHUNK)) { res.once('drain', push); return; }
      }
      res.end();
    };
    push();
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server!.address() as AddressInfo;
  return `http://127.0.0.1:${port}/object`;
}

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = null;
});

describe('materialiseSource', () => {
  it('streams the object to disk and never buffers it through readObject', async () => {
    const url = await serveObject();
    scratch = await mkdtemp(join(tmpdir(), 'materialise-'));
    const dest = join(scratch, 's0.mp4');

    const seen: Array<{ key: string; ttl: number }> = [];
    const storage: AssemblerStorage = {
      readObject: async () => {
        throw new Error('readObject buffers the whole master into heap — the assembler must stream');
      },
      getPresignedDownloadUrl: async (key, ttl) => { seen.push({ key, ttl }); return url; },
    };

    await materialiseSource(storage, 'videos/p1/main.mp4', dest);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.key).toBe('videos/p1/main.mp4');
    expect(seen[0]!.ttl).toBeGreaterThan(0);
    expect((await stat(dest)).size).toBe(EXPECTED_BYTES);
    expect(createHash('sha256').update(await readFile(dest)).digest('hex')).toBe(EXPECTED_SHA);
  });

  it('falls back to the buffered read when the URL route refuses (the LOCAL adapter + poster keys case)', async () => {
    // LocalStorageAdapter does not presign — it returns a URL into this API's own serve routes,
    // and a sim poster (`simulations/…`) is neither a public local prefix nor a token-minted
    // scope, so that URL answers 401 while `readObject` reads the same bytes off disk. Failing
    // hard here would break every local export that renders a poster.
    server = createServer((_req, res) => { res.writeHead(401).end('nope'); });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const { port } = server!.address() as AddressInfo;
    scratch = await mkdtemp(join(tmpdir(), 'materialise-'));
    const dest = join(scratch, 'poster.jpg');

    let read = 0;
    const storage: AssemblerStorage = {
      readObject: async () => { read++; return Buffer.from('poster-bytes'); },
      getPresignedDownloadUrl: async () => `http://127.0.0.1:${port}/refused`,
    };

    await materialiseSource(storage, 'simulations/p1/s1/posters/a.jpg', dest);

    expect(read).toBe(1);
    expect(await readFile(dest, 'utf8')).toBe('poster-bytes');
  });

  it('does not turn a cancelled download into a second, buffered one', async () => {
    server = createServer(() => { /* never responds — the abort is what ends it */ });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const { port } = server!.address() as AddressInfo;
    scratch = await mkdtemp(join(tmpdir(), 'materialise-'));
    const dest = join(scratch, 's0.mp4');

    const ac = new AbortController();
    let read = 0;
    const storage: AssemblerStorage = {
      readObject: async () => { read++; return Buffer.from('x'); },
      getPresignedDownloadUrl: async () => { ac.abort(); return `http://127.0.0.1:${port}/slow`; },
    };

    await expect(materialiseSource(storage, 'videos/p1/main.mp4', dest, ac.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(read, 'a cancelled export must not download the object again through the heap').toBe(0);
  });

  it('still works for an injected storage double that offers only readObject', async () => {
    scratch = await mkdtemp(join(tmpdir(), 'materialise-'));
    const dest = join(scratch, 's0.mp4');
    const storage: AssemblerStorage = { readObject: async () => Buffer.from('tiny-source') };

    await materialiseSource(storage, 'videos/p1/tiny.mp4', dest);

    expect(await readFile(dest, 'utf8')).toBe('tiny-source');
  });
});
