/**
 * The container package prep must bake the Minimal-UI boot-cloak snippet into HTML files — the
 * loopback server serves FROZEN bytes with no serve-time hook, so without this the viewer's
 * `#simboot={"hide":[…]}` fragment is inert inside the container and Minimal-UI sections capture
 * with their full controls visible (the exact parity gap the sim-public proxy closes at serve time).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { readManifestFilesFromInput } from '../packageInput.js';

let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pkg-input-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const contentOf = (files: Awaited<ReturnType<typeof readManifestFilesFromInput>>, path: string): string =>
  files.find((f) => f.path === path)!.content.toString('utf8');

describe('readManifestFilesFromInput — Minimal-UI boot snippet parity', () => {
  it('bakes the data-simboot snippet into HTML files and leaves other files untouched', async () => {
    await writeFile(join(dir, 'index.html'), '<html><head><title>t</title></head><body></body></html>');
    await mkdir(join(dir, 'js'), { recursive: true });
    await writeFile(join(dir, 'js/app.js'), 'console.log("sim")');

    const files = await readManifestFilesFromInput(dir);

    expect(contentOf(files, 'index.html')).toMatch(/<script\s+data-simboot[\s>]/);
    expect(contentOf(files, 'js/app.js')).toBe('console.log("sim")');
  });

  it('is idempotent: a package whose HTML already carries the snippet is untouched', async () => {
    const already = '<html><head><script data-simboot>/*x*/</script></head><body></body></html>';
    await writeFile(join(dir, 'index.html'), already);

    const files = await readManifestFilesFromInput(dir);

    expect(contentOf(files, 'index.html')).toBe(already);
  });
});
