/**
 * Loading the package bytes off the read-only input mount, for the loopback server (plan §0.2).
 *
 * The trusted side materialized the package at its manifest-relative paths under the input mount
 * (see `writeCaptureInput`), alongside `capture-spec.json` and — when available — `manifest.json`.
 * Inside the container we read those bytes back into memory and serve them from loopback. Reading
 * into memory (rather than letting the server stream from disk) is deliberate: the served bytes are
 * then a frozen snapshot the untrusted browser cannot influence, and the loopback server has no
 * filesystem to traverse.
 *
 * Content-type resolution prefers the manifest (the authoritative type each file was stored with);
 * without a manifest it falls back to the loopback server's extension table, which already yields the
 * `text/html` / `text/javascript` the sim expects.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import type { SimManifest } from 'shared/sim/simManifest';
import { MANIFEST_FILENAME } from 'shared/sim/simRevision';

import { injectSimBootSnippet } from '../../../../controllers/sim-public.controller.js';
import { CAPTURE_RESULT_FILENAME, CAPTURE_SPEC_FILENAME } from './captureJobBoundary.js';
import { contentTypeForPath, type LoopbackPackageFile } from './loopbackPackageServer.js';

/** Files that live on the input mount but are NOT part of the served package. */
const NON_PACKAGE_FILES = new Set<string>([CAPTURE_SPEC_FILENAME, CAPTURE_RESULT_FILENAME]);

/**
 * Read every package file off `inputDir` into `LoopbackPackageFile[]`.
 *
 * When `${inputDir}/manifest.json` is present, its `files[]` drive the load and supply authoritative
 * content-types. Otherwise every file under `inputDir` (except the spec/result sidecars and the
 * manifest itself) is loaded with an extension-derived content-type.
 */
export async function readManifestFilesFromInput(inputDir: string): Promise<LoopbackPackageFile[]> {
  const manifest = await tryReadManifest(inputDir);
  if (manifest) {
    const out: LoopbackPackageFile[] = [];
    for (const file of manifest.files) {
      const content = await readFile(join(inputDir, file.path));
      out.push({ path: file.path, content, contentType: file.contentType });
    }
    return withBootSnippet(out);
  }
  return withBootSnippet(await walkPackage(inputDir));
}

/**
 * Bake the Minimal-UI boot-cloak snippet into every HTML file, mirroring what the `/sim-public/`
 * proxy does at serve time. The viewer's `#simboot={"hide":[…]}` fragment only works because that
 * snippet reads `location.hash` and injects pre-paint hide CSS — and the loopback server serves
 * FROZEN bytes with no serve-time hook, so parity has to be baked in here, on the trusted side,
 * when the bytes are loaded. `injectSimBootSnippet` is idempotent, so a package that already
 * carries the snippet is untouched.
 */
function withBootSnippet(files: LoopbackPackageFile[]): LoopbackPackageFile[] {
  return files.map((f) => {
    const contentType = f.contentType ?? contentTypeForPath(f.path);
    if (!contentType.startsWith('text/html')) return f;
    return { ...f, content: Buffer.from(injectSimBootSnippet(f.content.toString('utf8')), 'utf8') };
  });
}

/**
 * Read `manifest.json` off the mount — but ONLY trust it if it is OUR manifest.
 *
 * `manifest.json` is a name customers own too (a PWA/Vite/webpack build manifest is the common
 * case), and their file can land at the mount root: the input mount is flat, so the package root
 * IS the mount root. An unchecked `JSON.parse(...) as SimManifest` then iterates `manifest.files`
 * on an object that has no `files[]` and the container dies with `TypeError: manifest.files is not
 * iterable` — before the loopback server even starts, so the missing-dependency diagnostic cannot
 * explain it either. A customer manifest is just an asset: shape-check, and on any doubt fall
 * through to walking the mount (which serves that file like any other package byte).
 */
function looksLikeSimManifest(value: unknown): value is SimManifest {
  const m = value as Partial<SimManifest> | null;
  return (
    !!m &&
    typeof m === 'object' &&
    Array.isArray(m.files) &&
    m.files.every((f) => !!f && typeof (f as { path?: unknown }).path === 'string')
  );
}

async function tryReadManifest(inputDir: string): Promise<SimManifest | null> {
  try {
    const raw = await readFile(join(inputDir, MANIFEST_FILENAME), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return looksLikeSimManifest(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function walkPackage(inputDir: string): Promise<LoopbackPackageFile[]> {
  const out: LoopbackPackageFile[] = [];
  const stack: string[] = [inputDir];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
        continue;
      }
      const rel = relative(inputDir, abs).split(sep).join('/');
      // Only the TRUSTED SIDE'S sidecars are excluded. `manifest.json` is NOT one of them here:
      // this branch runs precisely when the mount carries no manifest of ours, so a file by that
      // name belongs to the customer (a PWA/Vite build manifest) and `/sim-public` would serve it.
      // Dropping it would make capture quietly less faithful than the viewer.
      if (NON_PACKAGE_FILES.has(rel)) continue;
      out.push({ path: rel, content: await readFile(abs) });
    }
  }
  return out;
}
