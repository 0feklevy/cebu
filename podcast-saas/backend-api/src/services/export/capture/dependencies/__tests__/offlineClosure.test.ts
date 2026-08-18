/**
 * THE v0.1.26 INCIDENT, pinned end to end.
 *
 * Production capture reached the rendering gate and failed it: "every sampled canvas frame is
 * uniform (dead/black canvas)", renderer string EMPTY. The real packages declare
 *
 *   { "imports": { "three": "https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js",
 *                  "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/" } }
 *
 * and the container runs `--network none`, so the module graph never resolved and no WebGL context
 * was ever created. These tests use the REAL vendored pack (not a stub) and the REAL entry-HTML
 * shape taken from the production `boids-3d` package.
 */

import { describe, expect, it } from 'vitest';

import { loadTrustedRegistry, TrustedDependencyRegistry } from '../trustedRegistry.js';

/** The loaded registry's vendor root — reused so a tampered copy reads the SAME files on disk. */
const registryRoot = (r: TrustedDependencyRegistry): string =>
  (r as unknown as { root: string }).root;
import { ExternalDependencyBlocked, prepareOfflinePackage, type PreparedFile } from '../offlinePackage.js';
import { parseImportMap, VENDOR_DIR } from 'shared/sim/captureDependencies';

/** The production entry document's load-bearing head, verbatim in shape. */
const BOIDS_ENTRY_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <link rel="icon" href="data:," />
  <link rel="stylesheet" href="./css/style.css" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@20..48,400,0,0" />
  <script type="importmap">
  {
    "imports": {
      "three": "https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js",
      "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/"
    }
  }
  </script>
</head>
<body>
  <canvas id="scene"></canvas>
  <script type="module" src="./src/main.js"></script>
</body>
</html>`;

const MAIN_JS = `import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
export const ok = !!THREE && !!OrbitControls && !!EffectComposer;`;

function boidsPackage(): PreparedFile[] {
  return [
    { path: 'bridge.js', content: Buffer.from('/* bridge */') },
    { path: 'boids-3d/index.html', content: Buffer.from(BOIDS_ENTRY_HTML) },
    { path: 'boids-3d/src/main.js', content: Buffer.from(MAIN_JS) },
    { path: 'boids-3d/css/style.css', content: Buffer.from('canvas{display:block}') },
    { path: 'boids-3d/models/gull.glb', content: Buffer.from('glTF') },
  ];
}

describe('prepareOfflinePackage — the real production package shape', () => {
  it('materialises three@0.169.0 from the REAL vendored pack and retargets the import map', async () => {
    const prepared = await prepareOfflinePackage(boidsPackage(), 'boids-3d/index.html');

    expect(prepared.bootComplete).toBe(true);
    expect(prepared.vendoredPacks).toEqual(['three@0.169.0']);

    // The exact mapping resolves to the vendored module file…
    const paths = prepared.files.map((f) => f.path);
    expect(paths).toContain(`${VENDOR_DIR}/three/0.169.0/build/three.module.js`);
    // …and the prefix mapping's closure came with it (an addon the package imports, plus one of
    // its own transitive imports, which nothing in the package names directly).
    expect(paths).toContain(`${VENDOR_DIR}/three/0.169.0/examples/jsm/controls/OrbitControls.js`);
    expect(paths).toContain(`${VENDOR_DIR}/three/0.169.0/examples/jsm/postprocessing/EffectComposer.js`);
    expect(paths).toContain(`${VENDOR_DIR}/three/0.169.0/examples/jsm/postprocessing/Pass.js`);

    // The vendored three is the REAL library, not a placeholder.
    const three = prepared.files.find((f) => f.path.endsWith('build/three.module.js'))!;
    expect(three.content.byteLength).toBeGreaterThan(500_000);
    expect(three.content.toString('utf8', 0, 4_000)).toMatch(/WebGLRenderer|REVISION/);

    // The capture copy's import map now points INSIDE the package, root-absolute so entry depth
    // (boids-3d/) cannot change resolution.
    const entry = prepared.files.find((f) => f.path === 'boids-3d/index.html')!;
    const map = parseImportMap(entry.content.toString('utf8'))!;
    const imports = Object.fromEntries(map.entries.map((e) => [e.specifier, e.target]));
    expect(imports.three).toBe(`/${VENDOR_DIR}/three/0.169.0/build/three.module.js`);
    expect(imports['three/addons/']).toBe(`/${VENDOR_DIR}/three/0.169.0/examples/jsm/`);
    // A prefix mapping MUST keep its trailing slash on both sides (import-maps spec).
    expect(imports['three/addons/']!.endsWith('/')).toBe(true);
    // Nothing external survives in the map.
    expect(JSON.stringify(imports)).not.toContain('cdn.jsdelivr.net');
  });

  it('neutralises the external font stylesheet so the captured layout is deterministic', async () => {
    const prepared = await prepareOfflinePackage(boidsPackage(), 'boids-3d/index.html');
    const html = prepared.files.find((f) => f.path === 'boids-3d/index.html')!.content.toString('utf8');

    expect(prepared.neutralisedUrls.some((u) => u.includes('fonts.googleapis.com/css2'))).toBe(true);
    // The URL is GONE from the document, not merely commented out — an untrusted href containing
    // `-->` would otherwise escape the comment and inject markup into the captured page.
    expect(html).not.toContain('fonts.googleapis.com/css2');
    expect(html).toContain('<!-- flowvid-capture: external stylesheet removed for offline capture -->');
    // The LOCAL stylesheet is untouched — only unsatisfiable external ones are removed.
    expect(html).toContain('href="./css/style.css"');
  });

  it('a stylesheet href containing "-->" cannot inject markup into the capture copy', async () => {
    const evil = 'https://evil.example/x.css?a=--><script>window.__pwned=1</script><link href="';
    const files: PreparedFile[] = [
      { path: 'index.html', content: Buffer.from(`<link rel="stylesheet" href="${evil}">`) },
    ];
    const prepared = await prepareOfflinePackage(files, 'index.html');
    const html = prepared.files[0]!.content.toString('utf8');
    expect(html).not.toContain('__pwned');
    expect(html).not.toContain('evil.example');
  });

  it('leaves the STORED package untouched — only the returned copy differs', async () => {
    const original = boidsPackage();
    const beforeEntry = original.find((f) => f.path === 'boids-3d/index.html')!.content.toString('utf8');
    await prepareOfflinePackage(original, 'boids-3d/index.html');
    const afterEntry = original.find((f) => f.path === 'boids-3d/index.html')!.content.toString('utf8');
    expect(afterEntry).toBe(beforeEntry);
    expect(afterEntry).toContain('cdn.jsdelivr.net'); // the stored bytes still name the CDN
  });

  it('keeps every original package file alongside the vendor tree', async () => {
    const prepared = await prepareOfflinePackage(boidsPackage(), 'boids-3d/index.html');
    for (const p of ['bridge.js', 'boids-3d/src/main.js', 'boids-3d/css/style.css', 'boids-3d/models/gull.glb']) {
      expect(prepared.files.map((f) => f.path), p).toContain(p);
    }
  });
});

describe('prepareOfflinePackage — packages that cannot be captured offline', () => {
  it('REFUSES a boot-critical dependency no trusted pack satisfies, naming it', async () => {
    const files: PreparedFile[] = [
      {
        path: 'index.html',
        content: Buffer.from(
          '<script type="importmap">{"imports":{"chart":"https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.js"}}</script>',
        ),
      },
    ];
    const err = await prepareOfflinePackage(files, 'index.html').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExternalDependencyBlocked);
    expect((err as Error).message).toContain('chart.js');
    expect((err as Error).message).toMatch(/no trusted pack satisfies/);
  });

  it('REFUSES a version the pack does not pin — 0.170.0 is not 0.169.0', async () => {
    const files: PreparedFile[] = [
      {
        path: 'index.html',
        content: Buffer.from(
          '<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js"}}</script>',
        ),
      },
    ];
    await expect(prepareOfflinePackage(files, 'index.html')).rejects.toBeInstanceOf(ExternalDependencyBlocked);
  });

  it('REFUSES an external <script src> — it bypasses the import map entirely', async () => {
    const files: PreparedFile[] = [
      { path: 'index.html', content: Buffer.from('<script src="https://unpkg.com/whatever@1/dist/x.js"></script>') },
    ];
    await expect(prepareOfflinePackage(files, 'index.html')).rejects.toBeInstanceOf(ExternalDependencyBlocked);
  });

  it('THROWS on a malformed import map rather than silently treating it as absent', async () => {
    const files: PreparedFile[] = [
      { path: 'index.html', content: Buffer.from('<script type="importmap">{ not json }</script>') },
    ];
    await expect(prepareOfflinePackage(files, 'index.html')).rejects.toThrow(/not valid JSON/);
  });

  it('a package with NO external dependencies passes through unchanged', async () => {
    const files: PreparedFile[] = [
      { path: 'scene/index.html', content: Buffer.from('<script type="module" src="./main.js"></script>') },
      { path: 'scene/main.js', content: Buffer.from('export const x = 1;') },
    ];
    const prepared = await prepareOfflinePackage(files, 'scene/index.html');
    expect(prepared.vendoredPacks).toEqual([]);
    expect(prepared.files).toHaveLength(2);
    expect(prepared.files.find((f) => f.path === 'scene/index.html')!.content.toString()).toBe(
      '<script type="module" src="./main.js"></script>',
    );
  });
});

describe('the trusted registry itself', () => {
  it('loads the pinned pack and verifies every vendored byte against its recorded hash', async () => {
    const registry = await loadTrustedRegistry();
    const three = registry.descriptors().find((d) => d.name === 'three' && d.version === '0.169.0');
    expect(three, 'three@0.169.0 must ship in the vendor pack').toBeTruthy();

    // materialise() re-hashes every file; a drifted byte would throw here.
    const files = await registry.materialise(three!);
    expect(files.length).toBe(Object.keys(three!.files).length);
    expect(files.every((f) => f.path.startsWith(`${VENDOR_DIR}/three/0.169.0/`))).toBe(true);
  });

  it('REFUSES bytes whose hash does not match the registry — the supply-chain assertion', async () => {
    const real = await loadTrustedRegistry();
    const three = real.descriptors().find((d) => d.name === 'three')!;
    // The same files, on the same disk, with ONE recorded hash altered: materialise must refuse
    // rather than capture whatever bytes happen to be there. Capturing a different library under
    // the same dependency identity is precisely what pinning exists to prevent.
    const target = Object.keys(three.files)[0]!;
    const tampered = new TrustedDependencyRegistry(registryRoot(real), [
      { ...three, files: { ...three.files, [target]: { ...three.files[target]!, sha256: 'f'.repeat(64) } } },
    ]);
    await expect(tampered.materialise(tampered.descriptors()[0]!)).rejects.toThrow(/integrity mismatch/);
  });

  it('REFUSES a pack whose file is absent from disk', async () => {
    const real = await loadTrustedRegistry();
    const three = real.descriptors().find((d) => d.name === 'three')!;
    const missing = new TrustedDependencyRegistry(registryRoot(real), [
      { ...three, files: { ...three.files, 'build/not-a-real-file.js': { bytes: 1, sha256: '0'.repeat(64) } } },
    ]);
    await expect(missing.materialise(missing.descriptors()[0]!)).rejects.toThrow(/vendored file missing on disk/);
  });

  it('pins an EXACT version — no range, no "latest", and a CDN alias cannot drift into it', async () => {
    const registry = await loadTrustedRegistry();
    for (const d of registry.descriptors()) {
      expect(d.version).toMatch(/^\d+\.\d+\.\d+$/);
      for (const s of d.satisfies) expect(s).toContain(`@${d.version}/`);
      for (const meta of Object.values(d.files)) expect(meta.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

/**
 * Defects the adversarial review found in the first cut of this change. Each one shipped a package
 * that LOOKED prepared while something the browser needs was wrong.
 */
describe('review findings — import-map handling', () => {
  const IM = (json: string): string => `<script type="importmap">${json}</script>`;

  it('preserves `scopes` (and any other member) — emitting only {imports} DELETED them', async () => {
    const files: PreparedFile[] = [{
      path: 'index.html',
      content: Buffer.from(IM(JSON.stringify({
        imports: { three: 'https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js' },
        scopes: { '/legacy/': { three: './vendor/three-old.js' } },
      }))),
    }];
    const prepared = await prepareOfflinePackage(files, 'index.html');
    const map = parseImportMap(prepared.files[0]!.content.toString('utf8'))!;
    expect(map.rest.scopes).toEqual({ '/legacy/': { three: './vendor/three-old.js' } });
  });

  it('rewrites EVERY specifier sharing one CDN target, not just the first', async () => {
    const target = 'https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js';
    const files: PreparedFile[] = [{
      path: 'index.html',
      content: Buffer.from(IM(JSON.stringify({ imports: { three: target, 'three-core': target } }))),
    }];
    const prepared = await prepareOfflinePackage(files, 'index.html');
    const html = prepared.files.find((f) => f.path === 'index.html')!.content.toString('utf8');
    expect(html).not.toContain('cdn.jsdelivr.net'); // neither specifier may keep the CDN target
    const map = parseImportMap(html)!;
    const imports = Object.fromEntries(map.entries.map((e) => [e.specifier, e.target]));
    expect(imports.three).toBe(imports['three-core']);
  });

  it('ignores an import map that is inside an HTML COMMENT and honours the real one', async () => {
    const commented = `<!-- example: ${IM('{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js"}}')} -->`;
    const real = IM(JSON.stringify({
      imports: { three: 'https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js' },
    }));
    const prepared = await prepareOfflinePackage(
      [{ path: 'index.html', content: Buffer.from(`${commented}\n${real}`) }],
      'index.html',
    );
    // The commented 0.170.0 map is not the document's map; the real 0.169.0 one resolves.
    expect(prepared.vendoredPacks).toEqual(['three@0.169.0']);
    expect(prepared.rewrittenSpecifiers.join(' ')).toContain('three ->');
  });

  it('an external plain `preload` is a substitution, not a refusal', async () => {
    const prepared = await prepareOfflinePackage(
      [{
        path: 'index.html',
        content: Buffer.from('<link rel="preload" as="font" href="https://fonts.gstatic.com/s/a.woff2" crossorigin>'),
      }],
      'index.html',
    );
    // It does not block the package…
    expect(prepared.bootComplete).toBe(true);
    // …and it is still REPORTED, so an author can see the fidelity cost.
    expect(prepared.unresolved.some((r) => r.raw.includes('fonts.gstatic.com'))).toBe(true);
  });

  it('a modulepreload of an unsatisfiable module DOES refuse — the graph really needs it', async () => {
    await expect(
      prepareOfflinePackage(
        [{ path: 'index.html', content: Buffer.from('<link rel="modulepreload" href="https://unpkg.com/x@1/x.js">') }],
        'index.html',
      ),
    ).rejects.toBeInstanceOf(ExternalDependencyBlocked);
  });
});

/**
 * Second-round review findings. Both were package-controlled FALSE GREENS: the closure reported
 * `bootComplete` while a CDN target survived into the container.
 */
describe('review round 2 — the tokenizer and multiple import maps', () => {
  it('a decoy import map inside ANOTHER TAG’S attribute cannot masquerade as the document’s map', async () => {
    // `scanTags` used to advance only past tags it wanted, so a `<` inside a non-matching tag's
    // quoted value was read as a tag start — and this <meta> became "the import map": entries [],
    // nothing vendored, the real CDN map left intact, verdict "compatible".
    const html =
      '<meta name="generator" content="<script type=importmap>{}</script>" />' +
      '<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js"}}</script>';
    const prepared = await prepareOfflinePackage([{ path: 'index.html', content: Buffer.from(html) }], 'index.html');
    expect(prepared.vendoredPacks).toEqual(['three@0.169.0']);
    expect(prepared.files.find((f) => f.path === 'index.html')!.content.toString()).not.toContain('cdn.jsdelivr.net');
  });

  it('EVERY import map is planned and rewritten — Chrome merges them, so the second is not decoration', async () => {
    const html =
      '<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js"}}</script>' +
      '<script type="importmap">{"imports":{"three/addons/":"https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/"}}</script>';
    const prepared = await prepareOfflinePackage([{ path: 'index.html', content: Buffer.from(html) }], 'index.html');
    const out = prepared.files.find((f) => f.path === 'index.html')!.content.toString();
    expect(out).not.toContain('cdn.jsdelivr.net');           // neither map keeps a CDN target
    expect(prepared.rewrittenSpecifiers.join(' ')).toContain('three/addons/ ->');
  });

  it('an unsatisfiable target in a SECOND map still refuses the package', async () => {
    const html =
      '<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js"}}</script>' +
      '<script type="importmap">{"imports":{"d3":"https://cdn.jsdelivr.net/npm/d3@7/+esm"}}</script>';
    await expect(
      prepareOfflinePackage([{ path: 'index.html', content: Buffer.from(html) }], 'index.html'),
    ).rejects.toBeInstanceOf(ExternalDependencyBlocked);
  });
});

describe('vendor caps — a dependency pack cannot dominate a capture job', () => {
  const capped = async (overrides: Record<string, unknown>) => {
    const real = await loadTrustedRegistry();
    const three = real.descriptors().find((d) => d.name === 'three')!;
    return new TrustedDependencyRegistry(registryRoot(real), [{ ...three, ...overrides }]);
  };

  it('refuses a pack with too MANY files', async () => {
    const three = (await loadTrustedRegistry()).descriptors().find((d) => d.name === 'three')!;
    const many = Object.fromEntries(
      Array.from({ length: 401 }, (_, i) => [`f${i}.js`, { bytes: 1, sha256: '0'.repeat(64) }]),
    );
    const reg = await capped({ files: many });
    await expect(reg.materialise(reg.descriptors()[0]!)).rejects.toThrow(/exceeds the 400 cap/);
    expect(Object.keys(three.files).length).toBeLessThan(400); // the real pack is well inside it
  });

  it('refuses a single file over the per-file cap before reading it', async () => {
    const reg = await capped({ files: { 'build/three.module.js': { bytes: 9 * 1024 * 1024, sha256: '0'.repeat(64) } } });
    await expect(reg.materialise(reg.descriptors()[0]!)).rejects.toThrow(/over the per-file cap/);
  });
});
