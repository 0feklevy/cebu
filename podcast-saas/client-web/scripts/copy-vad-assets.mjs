#!/usr/bin/env node
/**
 * Copy the on-device voice-activity assets into public/vad/ so the car-mode player serves them
 * from OUR origin — never a CDN a phone in a car may not reach, and never a script the CSP has
 * to trust from somewhere else.
 *
 * Runs before `next dev` and `next build` (package.json). The files come straight from the two
 * installed packages, so a version bump in package.json is the only way they change:
 *   @ricky0123/vad-web  (ISC)  — the Silero VAD v5 model (MIT) + the AudioWorklet bundle
 *   onnxruntime-web     (MIT)  — the WebAssembly runtime the model runs on
 *
 * public/vad/ is git-ignored (≈15 MB of binaries); LICENSES.txt is written beside them because
 * shipped third-party code carries its licence with it (stack.md §8).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'public', 'vad');

function pkgDir(name) {
  // Resolved through client-web/node_modules directly: both packages guard package.json behind
  // an `exports` map, so require.resolve("<pkg>/package.json") is refused.
  const dir = join(here, "..", "node_modules", name);
  if (!existsSync(join(dir, "package.json"))) {
    console.error(`copy-vad-assets: ${name} is not installed in client-web/node_modules`);
    process.exit(1);
  }
  return dir;
}

const vad = pkgDir('@ricky0123/vad-web');
const ort = pkgDir('onnxruntime-web');

const files = [
  [join(vad, 'dist', 'silero_vad_v5.onnx'), 'silero_vad_v5.onnx'],
  [join(vad, 'dist', 'vad.worklet.bundle.min.js'), 'vad.worklet.bundle.min.js'],
  [join(ort, 'dist', 'ort-wasm-simd-threaded.wasm'), 'ort-wasm-simd-threaded.wasm'],
  [join(ort, 'dist', 'ort-wasm-simd-threaded.mjs'), 'ort-wasm-simd-threaded.mjs'],
];

mkdirSync(out, { recursive: true });
for (const [src, name] of files) {
  if (!existsSync(src)) {
    console.error(`copy-vad-assets: missing ${src} — is the package installed?`);
    process.exit(1);
  }
  copyFileSync(src, join(out, name));
}

const licence = (dir, label) => {
  const p = join(dir, 'package.json');
  const j = JSON.parse(readFileSync(p, 'utf8'));
  return `${label}: ${j.name}@${j.version} — licence ${j.license}`;
};
writeFileSync(join(out, 'LICENSES.txt'), [
  'Third-party assets served from /vad/ (copied at build time by scripts/copy-vad-assets.mjs):',
  licence(vad, 'VAD worklet + Silero VAD v5 model (model weights: MIT, github.com/snakers4/silero-vad)'),
  licence(ort, 'ONNX Runtime Web'),
  '',
].join('\n'));

console.log(`copy-vad-assets: ${files.length} files → public/vad/`);
