/**
 * STAGING THE PACKAGE WHOLE — the v0.1.23 regression, pinned end to end.
 *
 * The fixture IS the failing production package (section 75639e6c-…, verified against the row):
 * a LEGACY simulation whose entry is nested one level down and whose generated runtime sits at the
 * package root, referenced upward:
 *
 *   simulations/<p>/<s>/bridge.js          ← the ONLY SIM_READY emitter
 *   simulations/<p>/<s>/guidance.js
 *   simulations/<p>/<s>/guidance/en/a.mp3
 *   simulations/<p>/<s>/boids-3d/index.html   ← entry, loads ../bridge.js
 *   simulations/<p>/<s>/boids-3d/src/main.js
 *   simulations/<p>/<s>/boids-3d/app.css
 *   simulations/<p>/<s>/posters/…             ← system-owned, must NOT be staged
 *   simulations/<p>/<s>/revisions/…           ← system-owned, must NOT be staged
 *
 * The old provider staged `boids-3d/**` only and told the container the entry was `index.html`.
 * These tests assert the repaired shape: the whole package on /input, layout preserved, and an
 * entry path that keeps its nesting so `../bridge.js` resolves to the package root.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

import type { StorageService } from '../../../../storage/StorageService.js';
import type { CaptureSpec } from '../../captureTypes.js';
import type { CaptureIo, ContainerCaptureResult, ContainerCaptureSpec } from '../captureJobBoundary.js';
import { ContainerCaptureProvider, parseServedSimUrl, type ContainerCaptureConfig } from '../containerCaptureProvider.js';

const PROJECT = 'd8e7557a-6efd-4458-ab20-a391a0ee6b52';
const SIM = '49d20194-3fe7-4916-867b-22334c5022b3';
const PREFIX = `simulations/${PROJECT}/${SIM}`;
const REV = '11111111-2222-4333-8444-555555555555';

/** The stored entry HTML, with the real upward bridge reference. */
const NESTED_ENTRY_HTML =
  '<!doctype html><html><body><canvas id="c"></canvas>' +
  '<link rel="stylesheet" href="./app.css">' +
  '<script type="module" src="./src/main.js"></script>' +
  '<!-- SIM_BRIDGE_SCRIPT_START -->\n<script src="../bridge.js?v=3cb4123b80d1"></script>\n<!-- SIM_BRIDGE_SCRIPT_END -->' +
  '</body></html>';

function storageOf(objects: Record<string, string>): StorageService {
  const bufs = Object.fromEntries(Object.entries(objects).map(([k, v]) => [k, Buffer.from(v)]));
  return {
    listObjects: async (prefix: string) => Object.keys(bufs).filter((k) => k.startsWith(prefix)),
    readObject: async (key: string) => {
      const found = bufs[key];
      if (!found) throw new Error(`missing ${key}`);
      return found;
    },
  } as unknown as StorageService;
}

/** The production package, plus the system-owned subtrees that share a legacy prefix. */
const LEGACY_NESTED = storageOf({
  [`${PREFIX}/bridge.js`]: '/* combined bridge */',
  [`${PREFIX}/guidance.js`]: '/* guidance */',
  [`${PREFIX}/guidance/en/a.mp3`]: 'ID3',
  [`${PREFIX}/boids-3d/index.html`]: NESTED_ENTRY_HTML,
  [`${PREFIX}/boids-3d/src/main.js`]: 'export const boids = 1;',
  [`${PREFIX}/boids-3d/app.css`]: 'canvas{display:block}',
  [`${PREFIX}/posters/identity/full.png`]: 'PNG',
  [`${PREFIX}/revisions/${REV}/package/index.html`]: '<old/>',
  [`${PREFIX}/revisions/${REV}/manifest.json`]: '{}',
});

function specFor(entryKey: string): CaptureSpec {
  return {
    servedSimUrl: `https://api.flowvidco.com/sim-public/${entryKey}?section=75639e6c&v=3cb4123b80d1#simboot=%7B%7D`,
    sectionId: '75639e6c-c18d-470d-8334-d14106e32371',
    simpleUi: true,
    autoScript: true,
    uiHide: [],
    durationSec: 1,
    fps: 30,
    width: 1920,
    height: 1080,
    configHash: '3cb4123b80d1',
    posterKey: '',
  };
}

function testConfig(workDir: string): ContainerCaptureConfig {
  return {
    image: 'podcast-saas/export-worker:test', workDir, user: '1000:1000', cpus: '2',
    memoryMb: 2048, pidsLimit: 256, tmpfsScratchMb: 512, stopTimeoutSec: 10,
    dockerBin: 'true', sandboxMechanism: 'sys-admin',
  };
}

/** Captures the staged mount, then reports a benign clip so captureSection completes. */
function capturingBoundary(): {
  boundary: { runCapture: (s: ContainerCaptureSpec, io: CaptureIo) => Promise<ContainerCaptureResult> };
  seen: { spec: ContainerCaptureSpec | null; staged: string[] };
} {
  const seen: { spec: ContainerCaptureSpec | null; staged: string[] } = { spec: null, staged: [] };
  const walk = async (dir: string, base: string): Promise<string[]> => {
    const out: string[] = [];
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) out.push(...(await walk(abs, base)));
      else out.push(relative(base, abs).split(sep).join('/'));
    }
    return out;
  };
  return {
    seen,
    boundary: {
      async runCapture(spec: ContainerCaptureSpec, io: CaptureIo): Promise<ContainerCaptureResult> {
        seen.spec = spec;
        seen.staged = (await walk(io.inputDir, io.inputDir)).sort();
        const { writeFile } = await import('node:fs/promises');
        await writeFile(join(io.outputDir, 'clip.mp4'), Buffer.from('clip'));
        return {
          resultVersion: 1, sectionId: spec.sectionId, status: 'ok', framesDir: null, clipPath: 'clip.mp4',
          frameCount: 30, rendererString: 'ANGLE (SwiftShader)', gate: 'passed', reason: null,
          rendererIdentity: { imageDigest: 'i', headlessShellVersion: 'v', viewport: { w: 1920, h: 1080 }, dpr: 1 },
          failure: null,
        };
      },
    },
  };
}

let scratch: string | null = null;
afterEach(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = null;
});

describe('parseServedSimUrl — package terms, not entry-directory terms', () => {
  it('THE PRODUCTION URL resolves to the package root with a NESTED entry path', () => {
    expect(parseServedSimUrl(specFor(`${PREFIX}/boids-3d/index.html`).servedSimUrl)).toMatchObject({
      layout: 'legacy',
      packageRoot: PREFIX,
      entryPath: 'boids-3d/index.html',
    });
  });

  it('refuses a non-sim URL and a traversing key', () => {
    expect(parseServedSimUrl('https://api.flowvidco.com/api/v1/podcasts/x.mp3')).toBeNull();
    expect(parseServedSimUrl(`https://api.flowvidco.com/sim-public/${PREFIX}/../secrets.html`)).toBeNull();
  });
});

describe('staging a NESTED LEGACY package (the failing production shape)', () => {
  it('stages the package ROOT-relative, bridge.js included, nesting preserved, entryPath nested', async () => {
    scratch = await mkdtemp(join(tmpdir(), 'pkgroot-'));
    const { boundary, seen } = capturingBoundary();
    const provider = new ContainerCaptureProvider(testConfig(scratch), boundary, LEGACY_NESTED);

    const result = await provider.captureSection(specFor(`${PREFIX}/boids-3d/index.html`));
    expect(result.gate).toBe('passed');

    // (3) the package-root runtime is staged AT THE ROOT, so `../bridge.js` resolves.
    expect(seen.staged).toContain('bridge.js');
    // (5) sibling/root generated assets survive too — nothing is special-cased.
    expect(seen.staged).toContain('guidance.js');
    expect(seen.staged).toContain('guidance/en/a.mp3');
    // (4) the nested entry stays nested, with its own relative assets.
    expect(seen.staged).toContain('boids-3d/index.html');
    expect(seen.staged).toContain('boids-3d/src/main.js');
    expect(seen.staged).toContain('boids-3d/app.css');
    // (10) system-owned subtrees of a legacy prefix are NOT shipped into the container.
    expect(seen.staged.some((p) => p.startsWith('posters/'))).toBe(false);
    expect(seen.staged.some((p) => p.startsWith('revisions/'))).toBe(false);
    // (2) the container is told the nested entry path — NOT the bare basename.
    expect(seen.spec?.entryPath).toBe('boids-3d/index.html');
  });

  it('the staged entry HTML still carries its upward bridge reference (nothing was rewritten)', async () => {
    scratch = await mkdtemp(join(tmpdir(), 'pkgroot-'));
    const { boundary } = capturingBoundary();
    let staged = '';
    const spy = {
      async runCapture(spec: ContainerCaptureSpec, io: CaptureIo): Promise<ContainerCaptureResult> {
        const { readFile } = await import('node:fs/promises');
        staged = await readFile(join(io.inputDir, 'boids-3d', 'index.html'), 'utf8');
        return boundary.runCapture(spec, io);
      },
    };
    const provider = new ContainerCaptureProvider(testConfig(scratch), spy, LEGACY_NESTED);
    await provider.captureSection(specFor(`${PREFIX}/boids-3d/index.html`));
    expect(staged).toContain('src="../bridge.js?v=3cb4123b80d1"');
  });
});

describe('the INPUT MOUNT the container actually gets (offline closure, end to end)', () => {
  /** The production entry, with the CDN import map and the external font stylesheet. */
  const CDN_ENTRY = `<!doctype html>
<link rel="stylesheet" href="./css/style.css">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded" />
<script type="importmap">
{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js",
            "three/addons/":"https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/"}}
</script>
<script type="module" src="./src/main.js"></script>
<script src="../bridge.js?v=1"></script>`;

  const cdnStorage = storageOf({
    [`${PREFIX}/bridge.js`]: '/* bridge */',
    [`${PREFIX}/boids-3d/index.html`]: CDN_ENTRY,
    [`${PREFIX}/boids-3d/src/main.js`]: "import * as THREE from 'three';",
    [`${PREFIX}/boids-3d/css/style.css`]: 'canvas{display:block}',
  });

  it('stages three.js locally and hands the container an entry with NO external URL left in it', async () => {
    scratch = await mkdtemp(join(tmpdir(), 'pkgroot-'));
    const { boundary, seen } = capturingBoundary();
    let stagedEntry = '';
    const spy = {
      async runCapture(spec: ContainerCaptureSpec, io: CaptureIo): Promise<ContainerCaptureResult> {
        const { readFile } = await import('node:fs/promises');
        stagedEntry = await readFile(join(io.inputDir, 'boids-3d', 'index.html'), 'utf8');
        return boundary.runCapture(spec, io);
      },
    };
    const provider = new ContainerCaptureProvider(testConfig(scratch), spy, cdnStorage);
    await provider.captureSection(specFor(`${PREFIX}/boids-3d/index.html`));

    // The v0.1.26 assertion, at the mount: nothing the container serves points off-origin.
    expect(stagedEntry).not.toContain('cdn.jsdelivr.net');
    expect(stagedEntry).not.toContain('fonts.googleapis.com');
    expect(stagedEntry).toContain('/__flowvid_vendor/three/0.169.0/build/three.module.js');
    // The package's own relative references survive untouched.
    expect(stagedEntry).toContain('./css/style.css');
    expect(stagedEntry).toContain('../bridge.js?v=1');

    // The vendored module graph is physically present on the mount, at the package ROOT.
    expect(seen.staged).toContain('__flowvid_vendor/three/0.169.0/build/three.module.js');
    expect(seen.staged).toContain('__flowvid_vendor/three/0.169.0/examples/jsm/controls/OrbitControls.js');
    // …and the package itself is still whole.
    expect(seen.staged).toContain('bridge.js');
    expect(seen.staged).toContain('boids-3d/src/main.js');
    expect(seen.spec?.entryPath).toBe('boids-3d/index.html');
  });

  it('REFUSES to capture a package whose boot dependency nothing trusts, with the URL in the error', async () => {
    scratch = await mkdtemp(join(tmpdir(), 'pkgroot-'));
    const { boundary } = capturingBoundary();
    const unsupported = storageOf({
      [`${PREFIX}/index.html`]:
        '<script type="importmap">{"imports":{"d3":"https://cdn.jsdelivr.net/npm/d3@7/+esm"}}</script>',
    });
    const provider = new ContainerCaptureProvider(testConfig(scratch), boundary, unsupported);
    await expect(provider.captureSection(specFor(`${PREFIX}/index.html`))).rejects.toThrow(
      /no trusted pack satisfies[\s\S]*d3/,
    );
  });
});

describe('the other three supported layouts still stage correctly', () => {
  const cases = [
    {
      name: 'FLAT legacy',
      entryKey: `${PREFIX}/index.html`,
      storage: storageOf({
        [`${PREFIX}/bridge.js`]: '/* b */',
        [`${PREFIX}/index.html`]: '<script src="./bridge.js"></script>',
        [`${PREFIX}/posters/x/full.png`]: 'PNG',
      }),
      expectEntry: 'index.html',
      expectStaged: ['bridge.js', 'index.html'],
      expectAbsent: ['posters/x/full.png'],
    },
    {
      name: 'FLAT revision',
      entryKey: `${PREFIX}/revisions/${REV}/package/index.html`,
      storage: storageOf({
        [`${PREFIX}/revisions/${REV}/manifest.json`]: '{}',
        [`${PREFIX}/revisions/${REV}/package/bridge.js`]: '/* b */',
        [`${PREFIX}/revisions/${REV}/package/index.html`]: '<script src="./bridge.js"></script>',
      }),
      expectEntry: 'index.html',
      expectStaged: ['bridge.js', 'index.html'],
      // manifest.json is a SIBLING of package/ — outside the package root, never staged.
      expectAbsent: ['manifest.json'],
    },
    {
      name: 'NESTED revision',
      entryKey: `${PREFIX}/revisions/${REV}/package/scene/index.html`,
      storage: storageOf({
        [`${PREFIX}/revisions/${REV}/package/bridge.js`]: '/* b */',
        [`${PREFIX}/revisions/${REV}/package/scene/index.html`]: '<script src="../bridge.js"></script>',
        [`${PREFIX}/revisions/${REV}/package/scene/app.css`]: 'body{}',
      }),
      expectEntry: 'scene/index.html',
      expectStaged: ['bridge.js', 'scene/index.html', 'scene/app.css'],
      expectAbsent: [],
    },
  ];

  for (const c of cases) {
    it(`${c.name}: entryPath "${c.expectEntry}" with the package root staged whole`, async () => {
      scratch = await mkdtemp(join(tmpdir(), 'pkgroot-'));
      const { boundary, seen } = capturingBoundary();
      const provider = new ContainerCaptureProvider(testConfig(scratch), boundary, c.storage);
      await provider.captureSection(specFor(c.entryKey));
      expect(seen.spec?.entryPath).toBe(c.expectEntry);
      for (const p of c.expectStaged) expect(seen.staged, p).toContain(p);
      for (const p of c.expectAbsent) expect(seen.staged, p).not.toContain(p);
    });
  }
});

describe('refusals', () => {
  it('a package whose entry is not among the staged files fails LOUDLY, never captures blind', async () => {
    scratch = await mkdtemp(join(tmpdir(), 'pkgroot-'));
    const { boundary } = capturingBoundary();
    // Root exists but the entry object does not — a torn package.
    const torn = storageOf({ [`${PREFIX}/bridge.js`]: '/* b */' });
    const provider = new ContainerCaptureProvider(testConfig(scratch), boundary, torn);
    await expect(provider.captureSection(specFor(`${PREFIX}/boids-3d/index.html`))).rejects.toThrow(
      /entry boids-3d\/index\.html is not among/,
    );
  });

  it('an unparseable key is refused before any storage call', async () => {
    scratch = await mkdtemp(join(tmpdir(), 'pkgroot-'));
    const { boundary } = capturingBoundary();
    const exploding = {
      listObjects: async () => { throw new Error('storage must not be touched'); },
      readObject: async () => { throw new Error('storage must not be touched'); },
    } as unknown as StorageService;
    const provider = new ContainerCaptureProvider(testConfig(scratch), boundary, exploding);
    await expect(
      provider.captureSection(specFor('podcasts/not-a-simulation.html')),
    ).rejects.toThrow(/not a sim-public key|sim-public/);
  });
});
