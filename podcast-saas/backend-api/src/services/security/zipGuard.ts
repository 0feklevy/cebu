// Application-level ZIP limits for user-uploaded archives.
//
// WHY THIS EXISTS, given adm-zip was already bumped to ^0.6.0: a dependency bump bounds what the
// PARSER mishandles. It does not bound what an attacker may DECLARE. A zip central directory is
// attacker-authored metadata — entry count, compressed size, uncompressed size and entry name are
// all just numbers and bytes in a header. A 20 KB upload can declare 40 GB of content, and any
// consumer that trusts the declaration (allocating, extracting, or simply summing it) is a
// denial-of-service away from a two-vCPU host with no memory to spare.
//
// So: refuse on the DECLARED values, before a single byte is inflated. This module never calls
// getData(); it reads the central directory and decides. Callers get back the already-parsed
// AdmZip so validation cannot be skipped and the archive is not parsed twice.
//
// ── HOW THE DEFAULTS WERE SIZED ──────────────────────────────────────────────────────────────
// Measured against real simulation packages (SIMULATION-VIDEO-PIPELINE-DEEP-AUDIT.md:474-475):
//
//     boids-3d           26 files    546,220 B total    largest asset 345,816 B (a GLB)
//     murmuration-knob   16 files    210,425 B total
//
// And against the ceilings this platform ALREADY enforces on the same bytes:
//
//     simulations.controller.ts:61   SIMULATION_UPLOAD_MAX_BYTES  = 250 MB   (multipart, compressed)
//     simulations.controller.ts:62   SIMULATION_UPLOAD_MAX_FILES  = 1000     (multipart parts)
//     avatar.controller.ts:57        AVATAR_LIBRARY_UPLOAD_MAX_BYTES = 250 MB
//     containerCaptureProvider.ts:103 MAX_PACKAGE_BYTES           = 256 MiB  (staged, uncompressed)
//
// Every default below sits at or above a ceiling the request would hit anyway, and two to three
// orders of magnitude above a real package. A false rejection of a legitimate bundle is a product
// outage, so each limit is deliberately generous:
//
//   maxEntries                4096      4x the 1000-part multipart cap (a ZIP also carries
//                                       directory entries), ~160x the largest measured package.
//   maxCompressedBytes        256 MiB   Above the 250 MB multipart cap, so this guard can never
//                                       reject an archive the HTTP layer already accepted.
//   maxUncompressedBytes      256 MiB   Exactly MAX_PACKAGE_BYTES. A package larger than this
//                                       cannot be staged for capture, so accepting it here would
//                                       only defer the failure to the export pipeline. ~500x the
//                                       largest measured package.
//   maxEntryUncompressedBytes 128 MiB   Half the total budget for one file — ~380x the largest
//                                       measured single asset, and far above any media file a
//                                       browser-run simulation can practically load.
//   maxCompressionRatio       200       DEFLATE on text tops out around 10-15x; even pathological
//                                       repetitive JSON or source maps stay near 50-100x. Classic
//                                       bombs are 1000:1 and up per layer. 200 sits well clear of
//                                       both.
//   ratioFloorBytes           8 MiB     The ratio ceiling is NOT applied below this. A small
//                                       zero-padded asset legitimately compresses 1000:1 and is
//                                       harmless; a ratio test on tiny archives is a false-positive
//                                       machine. Above the floor, a high ratio is the bomb
//                                       signature and nothing else.
//
// ── ENV OVERRIDES ────────────────────────────────────────────────────────────────────────────
// Every limit is overridable at runtime (read per call, so no restart is needed):
//
//     ZIP_GUARD_MAX_ENTRIES                     integer > 0   default 4096
//     ZIP_GUARD_MAX_COMPRESSED_BYTES            bytes   > 0   default 268435456  (256 MiB)
//     ZIP_GUARD_MAX_UNCOMPRESSED_BYTES          bytes   > 0   default 268435456  (256 MiB)
//     ZIP_GUARD_MAX_ENTRY_UNCOMPRESSED_BYTES    bytes   > 0   default 134217728  (128 MiB)
//     ZIP_GUARD_MAX_COMPRESSION_RATIO           number  > 0   default 200
//     ZIP_GUARD_RATIO_FLOOR_BYTES               bytes   > 0   default 8388608    (8 MiB)
//
// A malformed, zero, negative or non-finite value falls back to the default — an operator typo
// must never silently WIDEN a security limit.
import AdmZip from 'adm-zip';

const MiB = 1024 * 1024;

export interface ZipArchiveLimits {
  /** Maximum number of central-directory entries (files AND directories). */
  maxEntries: number;
  /** Maximum bytes of the archive itself, and of the declared compressed sizes summed. */
  maxCompressedBytes: number;
  /** Maximum DECLARED uncompressed bytes across all entries — the zip-bomb axis. */
  maxUncompressedBytes: number;
  /** Maximum DECLARED uncompressed bytes for any single entry. */
  maxEntryUncompressedBytes: number;
  /** Ceiling on declared-uncompressed / compressed for the archive as a whole. */
  maxCompressionRatio: number;
  /** The ratio ceiling is only applied once declared-uncompressed exceeds this. */
  ratioFloorBytes: number;
}

export const DEFAULT_ZIP_LIMITS: Readonly<ZipArchiveLimits> = Object.freeze({
  maxEntries: 4096,
  maxCompressedBytes: 256 * MiB,
  maxUncompressedBytes: 256 * MiB,
  maxEntryUncompressedBytes: 128 * MiB,
  maxCompressionRatio: 200,
  ratioFloorBytes: 8 * MiB,
});

export const ZIP_LIMIT_ENV_VARS: Readonly<Record<keyof ZipArchiveLimits, string>> = Object.freeze({
  maxEntries:                'ZIP_GUARD_MAX_ENTRIES',
  maxCompressedBytes:        'ZIP_GUARD_MAX_COMPRESSED_BYTES',
  maxUncompressedBytes:      'ZIP_GUARD_MAX_UNCOMPRESSED_BYTES',
  maxEntryUncompressedBytes: 'ZIP_GUARD_MAX_ENTRY_UNCOMPRESSED_BYTES',
  maxCompressionRatio:       'ZIP_GUARD_MAX_COMPRESSION_RATIO',
  ratioFloorBytes:           'ZIP_GUARD_RATIO_FLOOR_BYTES',
});

export type ZipRejectionCode =
  | 'unreadable'                 // not a zip, empty, or truncated
  | 'entry_count'                // too many central-directory entries
  | 'compressed_bytes'           // archive (or summed declared compressed sizes) too large
  | 'uncompressed_bytes'         // declared uncompressed total too large
  | 'entry_uncompressed_bytes'   // one entry declares too much
  | 'compression_ratio'          // declared/compressed above the ceiling
  | 'entry_name'                 // absolute, drive-letter, traversal, backslash or NUL name
  | 'symlink';                   // entry is a symlink, not a regular file/directory

export class ZipLimitError extends Error {
  readonly code: ZipRejectionCode;
  constructor(code: ZipRejectionCode, message: string) {
    super(message);
    this.name = 'ZipLimitError';
    this.code = code;
  }
}

/** Entry names are attacker-controlled and end up in logs and API responses. Strip control
 *  characters (log/terminal injection) and bound the length before quoting one back. */
function quoteName(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, '');
  return clean.length > 120 ? `${clean.slice(0, 120)}…` : clean;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  // Never let a typo widen a limit: anything not a finite positive number is the default.
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Defaults, then env, then explicit per-call overrides (which win — they are code, not config). */
export function resolveZipLimits(overrides: Partial<ZipArchiveLimits> = {}): ZipArchiveLimits {
  const resolved = {} as ZipArchiveLimits;
  for (const key of Object.keys(DEFAULT_ZIP_LIMITS) as (keyof ZipArchiveLimits)[]) {
    const fromOverride = overrides[key];
    resolved[key] = typeof fromOverride === 'number' && Number.isFinite(fromOverride) && fromOverride > 0
      ? fromOverride
      : envNumber(ZIP_LIMIT_ENV_VARS[key], DEFAULT_ZIP_LIMITS[key]);
  }
  return resolved;
}

const S_IFMT  = 0xf000;
const S_IFLNK = 0xa000;

/** A safe entry name is a relative POSIX path with no traversal and no Windows-isms.
 *  Rejects rather than sanitises: a bundle whose author meant `../x` did not mean `x`. */
function assertSafeEntryName(rawName: string, label: string): void {
  const name = String(rawName ?? '');
  const reject = (why: string): never => {
    throw new ZipLimitError('entry_name', `${label} rejected: ${why} ("${quoteName(name)}")`);
  };

  if (name.trim() === '') reject('entry has an empty name');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000]/.test(name)) reject('entry name contains a NUL byte');
  // Covers plain backslash separators, UNC (\\server\share) and drive+backslash (C:\...).
  if (name.includes('\\')) reject('entry name uses backslash separators');
  if (name.startsWith('/')) reject('entry name is an absolute path');
  if (/^[a-zA-Z]:[/\\]?/.test(name)) reject('entry name carries a drive letter');
  if (name.split('/').includes('..')) reject('entry name traverses outside the archive');
}

/** A zip stores the Unix mode in the high 16 bits of the external attributes. DOS-authored
 *  archives leave those bits zero, so they are simply not symlinks. */
function assertNotSymlink(attr: number, name: string, label: string): void {
  const unixMode = (attr >>> 16) & 0xffff;
  if (unixMode !== 0 && (unixMode & S_IFMT) === S_IFLNK) {
    throw new ZipLimitError(
      'symlink',
      `${label} rejected: entry is a symlink, which may point outside the bundle ("${quoteName(name)}")`,
    );
  }
}

/**
 * Validate a user-supplied ZIP against application-level limits and return the parsed archive.
 *
 * Call this INSTEAD of `new AdmZip(buffer)` on any upload path. Nothing is inflated: every
 * verdict comes from the central directory, and the oversized-buffer check runs before the
 * archive is parsed at all.
 *
 * @throws {ZipLimitError} with a `code` identifying which limit or rule was broken.
 */
export function assertSafeZipArchive(
  buffer: Buffer,
  opts: { label?: string; limits?: Partial<ZipArchiveLimits> } = {},
): AdmZip {
  const label  = opts.label ?? 'ZIP archive';
  const limits = resolveZipLimits(opts.limits);

  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new ZipLimitError('unreadable', `${label} rejected: the upload is empty`);
  }

  // EARLIEST possible check — refuse before adm-zip touches an attacker-sized buffer.
  if (buffer.length > limits.maxCompressedBytes) {
    throw new ZipLimitError(
      'compressed_bytes',
      `${label} rejected: archive is ${buffer.length} bytes, over the ${limits.maxCompressedBytes}-byte limit`,
    );
  }

  let entries: AdmZip.IZipEntry[];
  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
    entries = zip.getEntries();     // reads the central directory only — no entry data is inflated
  } catch (err) {
    throw new ZipLimitError(
      'unreadable',
      `${label} rejected: not a readable ZIP archive (${(err as Error)?.message ?? 'unknown error'})`,
    );
  }

  if (entries.length > limits.maxEntries) {
    throw new ZipLimitError(
      'entry_count',
      `${label} rejected: ${entries.length} entries, over the ${limits.maxEntries}-entry limit`,
    );
  }

  let totalDeclared   = 0;
  let totalCompressed = 0;

  for (const entry of entries) {
    assertSafeEntryName(entry.entryName, label);
    assertNotSymlink(entry.header.attr, entry.entryName, label);

    // Declared, never measured. A header is a claim; treat a nonsense claim as the largest one.
    const declared   = Number.isFinite(entry.header.size) ? Math.max(0, entry.header.size) : Infinity;
    const compressed = Number.isFinite(entry.header.compressedSize)
      ? Math.max(0, entry.header.compressedSize)
      : Infinity;

    if (declared > limits.maxEntryUncompressedBytes) {
      throw new ZipLimitError(
        'entry_uncompressed_bytes',
        `${label} rejected: entry declares ${declared} uncompressed bytes, over the `
        + `${limits.maxEntryUncompressedBytes}-byte per-entry limit ("${quoteName(entry.entryName)}")`,
      );
    }

    totalDeclared   += declared;
    totalCompressed += compressed;

    // Inside the loop: stop at the entry that crosses the line, not after reading them all.
    if (totalDeclared > limits.maxUncompressedBytes) {
      throw new ZipLimitError(
        'uncompressed_bytes',
        `${label} rejected: entries declare at least ${totalDeclared} uncompressed bytes, over the `
        + `${limits.maxUncompressedBytes}-byte limit`,
      );
    }
    if (totalCompressed > limits.maxCompressedBytes) {
      throw new ZipLimitError(
        'compressed_bytes',
        `${label} rejected: entries declare at least ${totalCompressed} compressed bytes, over the `
        + `${limits.maxCompressedBytes}-byte limit`,
      );
    }
  }

  // Ratio last: it needs both totals, and only means anything above the floor.
  if (totalDeclared > limits.ratioFloorBytes) {
    const ratio = totalDeclared / Math.max(totalCompressed, 1);
    if (ratio > limits.maxCompressionRatio) {
      throw new ZipLimitError(
        'compression_ratio',
        `${label} rejected: compression ratio ${ratio.toFixed(1)}:1 (${totalDeclared} declared from `
        + `${totalCompressed} compressed) is over the ${limits.maxCompressionRatio}:1 limit`,
      );
    }
  }

  return zip;
}
