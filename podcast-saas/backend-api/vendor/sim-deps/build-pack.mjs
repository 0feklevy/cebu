#!/usr/bin/env node
/**
 * Regenerate a trusted dependency pack from the npm registry — the ONLY place bytes enter this
 * directory, and it is never run at capture time or in production.
 *
 * WHY VENDORED AT ALL: the capture container runs with `--network none`, so a simulation whose
 * import map points at a CDN cannot boot inside it. The trusted side materialises those modules
 * from a pinned, hash-verified pack instead — the runtime never resolves anything from the
 * internet. See md-files/EXPORT-CAPTURE-ISOLATION.md.
 *
 * WHY A CLOSURE AND NOT THE WHOLE LIBRARY: `three@0.169.0`'s `examples/jsm` tree is ~13 MB. The
 * production corpus imports nine addons; their transitive closure is sixteen files (~200 KB).
 * Shipping the rest would bloat every capture job for modules nothing imports.
 *
 * ADDING A DEPENDENCY OR A VERSION:
 *   1. add/extend an entry in PACKS below (exact version — never a range, never "latest");
 *   2. run `node build-pack.mjs` from this directory (needs network, run it locally);
 *   3. commit the emitted files AND the regenerated registry.json;
 *   4. the loader verifies every byte against registry.json at runtime, so a drifted CDN or a
 *      corrupted checkout fails closed instead of capturing something different.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The trusted packs. `roots` are the addon entry points the production corpus imports; the
 * transitive closure of their relative imports is vendored with them.
 */
const PACKS = [
  {
    provider: 'npm',
    name: 'three',
    version: '0.169.0',
    /** Import-map specifier → file inside the npm tarball's `package/` dir. */
    exact: { three: 'build/three.module.js' },
    /** Import-map prefix specifier → directory inside the tarball. */
    prefix: { 'three/addons/': 'examples/jsm/' },
    roots: [
      'controls/OrbitControls.js',
      'loaders/GLTFLoader.js',
      'objects/Sky.js',
      'postprocessing/BokehPass.js',
      'postprocessing/EffectComposer.js',
      'postprocessing/OutputPass.js',
      'postprocessing/RenderPass.js',
      'postprocessing/ShaderPass.js',
      'postprocessing/UnrealBloomPass.js',
    ],
  },
];

const SPEC_RE = /(?:^|[^\w.])(?:import|export)\s*(?:[\s\S]*?\sfrom\s*)?['"]([^'"]+)['"]/g;
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function closureOf(tarRoot, pack) {
  const jsmDir = join(tarRoot, 'package', pack.prefix['three/addons/'] ?? 'examples/jsm/');
  const seen = new Set();
  const queue = [...pack.roots];
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    const abs = join(jsmDir, rel);
    if (!existsSync(abs)) throw new Error(`closure: ${pack.name}@${pack.version} is missing ${rel}`);
    seen.add(rel);
    const src = readFileSync(abs, 'utf8');
    SPEC_RE.lastIndex = 0;
    let m;
    while ((m = SPEC_RE.exec(src))) {
      const spec = m[1];
      if (spec === pack.name) continue;                       // resolved by the exact mapping
      if (spec.startsWith(`${pack.name}/addons/`)) { queue.push(spec.slice(`${pack.name}/addons/`.length)); continue; }
      if (spec.startsWith('.')) { queue.push(normalize(join(dirname(rel), spec))); continue; }
      throw new Error(`closure: ${rel} imports un-vendorable specifier ${JSON.stringify(spec)}`);
    }
  }
  return [...seen].sort();
}

const entries = [];
for (const pack of PACKS) {
  const work = mkdtempSync(join(tmpdir(), 'sim-dep-pack-'));
  try {
    console.log(`fetching ${pack.name}@${pack.version} …`);
    execFileSync('npm', ['pack', `${pack.name}@${pack.version}`, '--silent'], { cwd: work, stdio: 'inherit' });
    const tgz = join(work, `${pack.name}-${pack.version}.tgz`);
    execFileSync('tar', ['-xzf', tgz, '-C', work]);

    const files = {};
    const put = (packRel, tarRel) => {
      const bytes = readFileSync(join(work, 'package', tarRel));
      const dest = join(HERE, pack.name, pack.version, packRel);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, bytes);
      files[packRel] = { bytes: bytes.byteLength, sha256: sha256(bytes) };
    };

    for (const [, tarRel] of Object.entries(pack.exact)) put(tarRel, tarRel);
    const prefixDir = pack.prefix['three/addons/'];
    for (const rel of closureOf(work, pack)) put(`${prefixDir}${rel}`, `${prefixDir}${rel}`);

    entries.push({
      provider: pack.provider,
      name: pack.name,
      version: pack.version,
      // The CDN origins whose URLs this pack is allowed to satisfy. Identity, not permission to
      // fetch: nothing ever downloads from these at capture time.
      satisfies: [
        `https://cdn.jsdelivr.net/npm/${pack.name}@${pack.version}/`,
        `https://unpkg.com/${pack.name}@${pack.version}/`,
        `https://esm.sh/${pack.name}@${pack.version}/`,
      ],
      exact: pack.exact,
      prefix: pack.prefix,
      files,
    });
    console.log(`  vendored ${Object.keys(files).length} files`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const registry = { registryVersion: 1, generatedBy: 'build-pack.mjs', packs: entries };
writeFileSync(join(HERE, 'registry.json'), `${JSON.stringify(registry, null, 2)}\n`);
console.log('wrote registry.json');
