/**
 * Package weight analysis (Priority 8.11).
 *
 * WHY THIS IS THE ONLY OPTIMISATION THAT REMOVES WORK
 * Everything else in Priority 8 reschedules work — earlier, in a better order, at a lower quality.
 * This is the one lever that makes there be less of it. A package that ships 8 MB of textures costs
 * that on every cold document, on every device, forever, and no amount of predictive preparation
 * makes those bytes arrive sooner.
 *
 * MEASURED, NOT ESTIMATED
 * Every number here comes from the manifest, which records the size and content type of the exact
 * stored bytes and is verified by read-back at publication. So a before/after comparison is a
 * comparison of two measurements, not of two guesses — which is what makes an optimisation
 * claim checkable rather than merely plausible.
 *
 * ADVISORY, ALWAYS
 * Nothing here blocks a publication. These are the customer's own files, and refusing to publish a
 * heavy package would fail a real user's real content over a number this module chose. Findings are
 * reported so an operator can act; they are never enforced.
 */

import type { SimManifest, SimManifestFile } from './simManifest.js';

export type WeightCategory = 'entry' | 'runtime' | 'script' | 'style' | 'image' | 'media' | 'font' | 'other';

/** Classify by content type first, extension second: the stored type is what a browser acts on. */
export function categorize(f: SimManifestFile): WeightCategory {
  if (f.role === 'entry') return 'entry';
  if (f.role === 'runtime') return 'runtime';
  const ct = (f.contentType || '').toLowerCase();
  if (ct.startsWith('image/')) return 'image';
  if (ct.startsWith('video/') || ct.startsWith('audio/')) return 'media';
  if (ct.startsWith('font/') || /font|woff/.test(ct)) return 'font';
  if (ct.includes('javascript') || ct.includes('ecmascript')) return 'script';
  if (ct.includes('css')) return 'style';
  const ext = f.path.slice(f.path.lastIndexOf('.') + 1).toLowerCase();
  if (['png', 'jpg', 'jpeg', 'webp', 'avif', 'gif', 'svg'].includes(ext)) return 'image';
  if (['mp4', 'webm', 'mp3', 'ogg', 'wav'].includes(ext)) return 'media';
  if (['woff', 'woff2', 'ttf', 'otf', 'eot'].includes(ext)) return 'font';
  if (['js', 'mjs', 'cjs'].includes(ext)) return 'script';
  if (ext === 'css') return 'style';
  return 'other';
}

export interface WeightReport {
  totalBytes: number;
  fileCount: number;
  byCategory: Record<WeightCategory, { bytes: number; count: number }>;
  /** Largest files first. The actionable list; a long tail of small files is rarely the problem. */
  largest: { path: string; bytes: number; category: WeightCategory }[];
  findings: WeightFinding[];
}

export interface WeightFinding {
  code: 'oversized-package' | 'oversized-image' | 'uncompressed-image' | 'duplicate-bytes'
      | 'many-files' | 'external-dependency';
  detail: string;
  /** Bytes this finding could plausibly recover, when that is knowable. Never a guess. */
  recoverableBytes?: number;
}

export const LIMITS = {
  /** Beyond this a cold document is slow on any connection worth designing for. */
  packageBytes: 5 * 1024 * 1024,
  /** A single image larger than this is almost always an unoptimised export. */
  imageBytes: 512 * 1024,
  /** Each file is a request; past this the count itself is the cost. */
  fileCount: 150,
} as const;

const EMPTY = (): Record<WeightCategory, { bytes: number; count: number }> => ({
  entry: { bytes: 0, count: 0 }, runtime: { bytes: 0, count: 0 }, script: { bytes: 0, count: 0 },
  style: { bytes: 0, count: 0 }, image: { bytes: 0, count: 0 }, media: { bytes: 0, count: 0 },
  font: { bytes: 0, count: 0 }, other: { bytes: 0, count: 0 },
});

export function analyzeWeight(manifest: SimManifest, topN = 10): WeightReport {
  const byCategory = EMPTY();
  let totalBytes = 0;
  const entries: { path: string; bytes: number; category: WeightCategory }[] = [];

  // Identical bytes stored under two paths. Detected by HASH, which the manifest already records
  // over the final stored bytes — so this is an observation, not a heuristic about filenames.
  const byHash = new Map<string, string[]>();

  for (const f of manifest.files) {
    const category = categorize(f);
    const bytes = Number.isFinite(f.bytes) && f.bytes > 0 ? f.bytes : 0;
    byCategory[category].bytes += bytes;
    byCategory[category].count += 1;
    totalBytes += bytes;
    entries.push({ path: f.path, bytes, category });
    const list = byHash.get(f.hash);
    if (list) list.push(f.path); else byHash.set(f.hash, [f.path]);
  }

  entries.sort((a, b) => b.bytes - a.bytes || (a.path < b.path ? -1 : 1));

  const findings: WeightFinding[] = [];
  if (totalBytes > LIMITS.packageBytes) {
    findings.push({
      code: 'oversized-package',
      detail: `${fmt(totalBytes)} exceeds the ${fmt(LIMITS.packageBytes)} guideline`,
      recoverableBytes: totalBytes - LIMITS.packageBytes,
    });
  }
  if (manifest.files.length > LIMITS.fileCount) {
    findings.push({
      code: 'many-files',
      detail: `${manifest.files.length} files; each one is a request`,
    });
  }
  for (const e of entries) {
    if (e.category === 'image' && e.bytes > LIMITS.imageBytes) {
      findings.push({
        code: 'oversized-image',
        detail: `${e.path} is ${fmt(e.bytes)}`,
        recoverableBytes: e.bytes - LIMITS.imageBytes,
      });
    }
  }
  for (const [, paths] of byHash) {
    if (paths.length < 2) continue;
    const f = manifest.files.find((x) => x.path === paths[0])!;
    findings.push({
      code: 'duplicate-bytes',
      detail: `${paths.length} paths share identical bytes: ${paths.slice(0, 3).join(', ')}`,
      // Only the duplicates are recoverable; one copy must remain.
      recoverableBytes: (paths.length - 1) * (Number.isFinite(f.bytes) ? f.bytes : 0),
    });
  }
  for (const url of manifest.externalDependencies) {
    findings.push({
      code: 'external-dependency',
      // Recorded, never fetched: a third-party origin is a availability and privacy dependency the
      // package's own numbers cannot describe.
      detail: url.slice(0, 200),
    });
  }

  return {
    totalBytes,
    fileCount: manifest.files.length,
    byCategory,
    largest: entries.slice(0, Math.max(0, topN)),
    findings,
  };
}

/**
 * Compare two reports. The point of the module: an optimisation claim you can check.
 *
 * `deltaBytes` is negative when the package got smaller, so the sign reads the way an engineer
 * expects a saving to read.
 */
export function compareWeight(before: WeightReport, after: WeightReport): {
  deltaBytes: number;
  deltaFiles: number;
  percentChange: number;
  improved: boolean;
} {
  const deltaBytes = after.totalBytes - before.totalBytes;
  return {
    deltaBytes,
    deltaFiles: after.fileCount - before.fileCount,
    // A package that was empty before cannot have a percentage change; 0 is the honest answer
    // rather than Infinity, which would render as a spectacular improvement in any report.
    percentChange: before.totalBytes > 0
      ? Math.round((deltaBytes / before.totalBytes) * 1000) / 10
      : 0,
    improved: deltaBytes < 0,
  };
}

function fmt(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
