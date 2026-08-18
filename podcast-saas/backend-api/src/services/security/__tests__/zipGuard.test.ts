/**
 * Application-level ZIP limits.
 *
 * Bumping adm-zip bounds the PARSER; it does not bound what an attacker may DECLARE in a
 * zip central directory. Every assertion here is about the declared values: the guard must
 * refuse an archive on its headers alone, before a single byte is inflated.
 *
 * The bomb fixtures below therefore carry a REAL payload of a few bytes and a PATCHED
 * central-directory size field — if a test passes only because something inflated the entry
 * to find its true size, the guard is not doing its job.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import AdmZip from 'adm-zip';
import {
  assertSafeZipArchive,
  ZipLimitError,
  DEFAULT_ZIP_LIMITS,
  ZIP_LIMIT_ENV_VARS,
} from '../zipGuard.js';

// ── Fixture helpers ───────────────────────────────────────────────────────────

const MiB = 1024 * 1024;

/** A well-formed archive. `addFile` normalises entry names, which is why the hostile
 *  fixtures below assign `entryName` on the returned entry instead. */
function makeZip(files: Record<string, string | Buffer>): Buffer {
  const zip = new AdmZip();
  for (const [path, content] of Object.entries(files)) {
    zip.addFile(path, Buffer.isBuffer(content) ? content : Buffer.from(content));
  }
  return zip.toBuffer();
}

/** An archive carrying one entry whose stored name is exactly `name` (no normalisation). */
function makeZipWithRawName(name: string, content = 'x'): Buffer {
  const zip = new AdmZip();
  const entry = zip.addFile('placeholder.txt', Buffer.from(content));
  entry.entryName = name;
  return zip.toBuffer();
}

/** An archive whose single entry carries a Unix mode — used to forge S_IFLNK (0xA000). */
function makeZipWithUnixMode(name: string, mode: number, content = '/etc/passwd'): Buffer {
  const zip = new AdmZip();
  const entry = zip.addFile(name, Buffer.from(content));
  entry.attr = (mode << 16) >>> 0;
  return zip.toBuffer();
}

/** Offsets of every central-directory record, walked from the End Of Central Directory
 *  record — never by scanning for the signature, which can collide with payload bytes. */
function centralDirectoryOffsets(buf: Buffer): number[] {
  const EOCD_SIG = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('fixture is not a zip: no EOCD record');
  const total = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const offsets: number[] = [];
  for (let i = 0; i < total; i++) {
    offsets.push(at);
    const nameLen    = buf.readUInt16LE(at + 28);
    const extraLen   = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    at += 46 + nameLen + extraLen + commentLen;
  }
  return offsets;
}

/** Rewrite the DECLARED uncompressed size (CENLEN, +24) of every entry. The payload is
 *  untouched: the archive still holds a handful of bytes and claims to hold gigabytes. */
function declareUncompressedSize(buf: Buffer, declared: number): Buffer {
  const out = Buffer.from(buf);
  for (const at of centralDirectoryOffsets(out)) out.writeUInt32LE(declared, at + 24);
  return out;
}

function expectRejection(run: () => unknown, code: string): ZipLimitError {
  let caught: unknown;
  try { run(); } catch (err) { caught = err; }
  expect(caught, `expected a ZipLimitError(${code}), nothing was thrown`).toBeInstanceOf(ZipLimitError);
  const err = caught as ZipLimitError;
  expect(err.code).toBe(code);
  return err;
}

afterEach(() => { vi.unstubAllEnvs(); });

// ── Legitimate packages must survive ──────────────────────────────────────────

describe('assertSafeZipArchive — legitimate packages', () => {
  it('accepts a package shaped like the measured boids-3d bundle (26 files, ~530 KiB)', () => {
    const files: Record<string, string | Buffer> = {
      'index.html': '<!doctype html><html><body><canvas></canvas></body></html>',
      'src/main.js': 'x'.repeat(64_000),
      'src/Flock.js': 'y'.repeat(48_000),
      'src/Post.js': 'z'.repeat(32_000),
      'assets/parrot.glb': Buffer.alloc(345_816, 7),
    };
    for (let i = 0; i < 21; i++) files[`src/mod${i}.js`] = `export const m${i} = ${i};`;

    const zip = assertSafeZipArchive(makeZip(files));
    expect(zip.getEntries().length).toBe(26);
    expect(zip.getEntries().some((e) => e.entryName === 'index.html')).toBe(true);
  });

  it('accepts nested paths, dotted filenames and single-dot segments', () => {
    const buf = makeZipWithRawName('assets/models/parrot.v1.2.glb');
    expect(() => assertSafeZipArchive(buf)).not.toThrow();
    expect(() => assertSafeZipArchive(makeZipWithRawName('src/./main.js'))).not.toThrow();
    expect(() => assertSafeZipArchive(makeZipWithRawName('..hidden/file.js'))).not.toThrow();
    expect(() => assertSafeZipArchive(makeZipWithRawName('a/b..c/d.js'))).not.toThrow();
  });

  it('accepts directory entries (they carry a declared size of 0)', () => {
    const zip = new AdmZip();
    zip.addFile('src/', Buffer.alloc(0));
    zip.addFile('src/main.js', Buffer.from('const a = 1;'));
    expect(() => assertSafeZipArchive(zip.toBuffer())).not.toThrow();
  });

  it('does NOT apply the ratio ceiling below the floor — a small, very compressible bundle passes', () => {
    // 1 MiB of zeros deflates ~1000:1. Under the floor, so it is none of the guard's business:
    // rejecting it would be a product outage for a legitimate padded asset.
    const buf = makeZip({ 'data.bin': Buffer.alloc(1 * MiB, 0) });
    expect(() => assertSafeZipArchive(buf)).not.toThrow();
  });
});

// ── The zip-bomb axis: DECLARED sizes ─────────────────────────────────────────

describe('assertSafeZipArchive — declared-size bombs', () => {
  it('rejects a single entry declaring more than the per-entry ceiling, without inflating it', () => {
    const honest = makeZip({ 'index.html': '<html>hi</html>' });
    const bomb = declareUncompressedSize(honest, 0xffffffff);   // claims ~4 GiB
    // The payload is still a handful of bytes — proving the verdict came from the header.
    expect(bomb.length).toBeLessThan(1024);
    const err = expectRejection(() => assertSafeZipArchive(bomb), 'entry_uncompressed_bytes');
    expect(err.message).toMatch(/index\.html/);
  });

  it('rejects an archive whose entries SUM past the total declared-uncompressed ceiling', () => {
    // Four entries, each under the per-entry ceiling, together far over the total.
    const honest = makeZip({ 'a.bin': 'a', 'b.bin': 'b', 'c.bin': 'c', 'd.bin': 'd' });
    const bomb = declareUncompressedSize(honest, 100 * MiB);
    expect(100 * MiB).toBeLessThan(DEFAULT_ZIP_LIMITS.maxEntryUncompressedBytes);
    expect(4 * 100 * MiB).toBeGreaterThan(DEFAULT_ZIP_LIMITS.maxUncompressedBytes);
    expectRejection(() => assertSafeZipArchive(bomb), 'uncompressed_bytes');
  });

  it('rejects a REAL high-ratio archive (12 MiB of zeros in ~12 KiB)', () => {
    const buf = makeZip({ 'bomb.bin': Buffer.alloc(12 * MiB, 0) });
    expect(buf.length).toBeLessThan(1 * MiB);
    const err = expectRejection(() => assertSafeZipArchive(buf), 'compression_ratio');
    expect(err.message).toMatch(/ratio/i);
  });

  it('rejects an oversized archive buffer BEFORE parsing it', () => {
    // Not a zip at all. If the size check ran after parsing, the verdict would be
    // "unreadable" — the point of this test is that nothing parsed it.
    vi.stubEnv(ZIP_LIMIT_ENV_VARS.maxCompressedBytes, '1024');
    expectRejection(() => assertSafeZipArchive(Buffer.alloc(4096, 0x41)), 'compressed_bytes');
  });

  it('rejects when the declared COMPRESSED bytes exceed the ceiling', () => {
    vi.stubEnv(ZIP_LIMIT_ENV_VARS.maxCompressedBytes, '64');
    const buf = makeZip({ 'a.js': 'a'.repeat(4000), 'b.js': 'b'.repeat(4000) });
    expect(buf.length).toBeGreaterThan(64);
    expectRejection(() => assertSafeZipArchive(buf), 'compressed_bytes');
  });

  it('rejects an archive with too many entries', () => {
    vi.stubEnv(ZIP_LIMIT_ENV_VARS.maxEntries, '8');
    const files: Record<string, string> = {};
    for (let i = 0; i < 12; i++) files[`f${i}.js`] = `const a${i} = ${i};`;
    const err = expectRejection(() => assertSafeZipArchive(makeZip(files)), 'entry_count');
    expect(err.message).toMatch(/12/);
  });
});

// ── Entry names ───────────────────────────────────────────────────────────────

describe('assertSafeZipArchive — entry names', () => {
  it.each([
    ['parent traversal',          '../evil.js'],
    ['deep traversal',            '../../../../etc/passwd'],
    ['embedded traversal',        'assets/../../evil.js'],
    ['trailing traversal',        'assets/subdir/..'],
    ['absolute posix path',       '/etc/passwd'],
    ['windows drive letter',      'C:/windows/system32/evil.dll'],
    ['windows drive + backslash', 'C:\\windows\\system32\\evil.dll'],
    ['backslash separator',       'assets\\evil.js'],
    ['UNC path',                  '\\\\server\\share\\evil.js'],
  ])('rejects %s (%s)', (_label, name) => {
    expectRejection(() => assertSafeZipArchive(makeZipWithRawName(name)), 'entry_name');
  });

  it('rejects an entry name containing a NUL byte', () => {
    expectRejection(() => assertSafeZipArchive(makeZipWithRawName('index.html\u0000.js')), 'entry_name');
  });

  it('rejects an empty entry name', () => {
    expectRejection(() => assertSafeZipArchive(makeZipWithRawName('')), 'entry_name');
  });

  it('checks EVERY entry, not just the first', () => {
    const zip = new AdmZip();
    zip.addFile('index.html', Buffer.from('<html/>'));
    zip.addFile('src/main.js', Buffer.from('const a = 1;'));
    zip.addFile('placeholder.js', Buffer.from('x')).entryName = '../../evil.js';
    expectRejection(() => assertSafeZipArchive(zip.toBuffer()), 'entry_name');
  });

  it('does not leak an unbounded or control-laden entry name into the error message', () => {
    const nasty = `a`.repeat(4000) + '\n\r\u001b[31m/../x';
    const err = expectRejection(() => assertSafeZipArchive(makeZipWithRawName(nasty)), 'entry_name');
    expect(err.message.length).toBeLessThan(400);
    // Control characters are the SUBJECT of this assertion: it proves none of them survive into
    // an error message that reaches a log. A rule that exists to catch a control character typed
    // into a pattern BY ACCIDENT cannot tell that apart from a pattern whose entire purpose is to
    // match them, so suppressing it here is the correct answer rather than a workaround.
    // eslint-disable-next-line no-control-regex
    expect(err.message).not.toMatch(/[\u0000-\u001f]/);
  });
});

// ── Symlink entries ───────────────────────────────────────────────────────────

describe('assertSafeZipArchive — symlink entries', () => {
  it('rejects an entry whose Unix mode marks it a symlink (S_IFLNK)', () => {
    const buf = makeZipWithUnixMode('link.js', 0xa1ff);   // S_IFLNK | 0777
    expectRejection(() => assertSafeZipArchive(buf), 'symlink');
  });

  it('accepts a regular file with a Unix mode (S_IFREG)', () => {
    const buf = makeZipWithUnixMode('main.js', 0x81a4, 'const a = 1;');   // S_IFREG | 0644
    expect(() => assertSafeZipArchive(buf)).not.toThrow();
  });

  it('accepts DOS-authored entries, whose external attributes carry no Unix mode', () => {
    const buf = makeZipWithUnixMode('main.js', 0x0000, 'const a = 1;');
    expect(() => assertSafeZipArchive(buf)).not.toThrow();
  });
});

// ── Unreadable input ──────────────────────────────────────────────────────────

describe('assertSafeZipArchive — unreadable input', () => {
  it('rejects a buffer that is not a zip', () => {
    expectRejection(() => assertSafeZipArchive(Buffer.from('this is definitely not a zip')), 'unreadable');
  });

  it('rejects an empty buffer', () => {
    expectRejection(() => assertSafeZipArchive(Buffer.alloc(0)), 'unreadable');
  });

  it('rejects a truncated archive', () => {
    const buf = makeZip({ 'index.html': '<html/>' });
    expectRejection(() => assertSafeZipArchive(buf.subarray(0, buf.length - 30)), 'unreadable');
  });
});

// ── Limits: defaults, env overrides, explicit overrides ───────────────────────

describe('zip limits', () => {
  it('ships the documented defaults', () => {
    expect(DEFAULT_ZIP_LIMITS).toEqual({
      maxEntries: 4096,
      maxCompressedBytes: 256 * MiB,
      maxUncompressedBytes: 256 * MiB,
      maxEntryUncompressedBytes: 128 * MiB,
      maxCompressionRatio: 200,
      ratioFloorBytes: 8 * MiB,
    });
  });

  it('never rejects an archive the HTTP layer already accepted (250 MB multipart cap)', () => {
    expect(DEFAULT_ZIP_LIMITS.maxCompressedBytes).toBeGreaterThan(250 * 1000 * 1000);
  });

  it('exposes every limit under a documented ZIP_GUARD_* env name', () => {
    expect(ZIP_LIMIT_ENV_VARS).toEqual({
      maxEntries: 'ZIP_GUARD_MAX_ENTRIES',
      maxCompressedBytes: 'ZIP_GUARD_MAX_COMPRESSED_BYTES',
      maxUncompressedBytes: 'ZIP_GUARD_MAX_UNCOMPRESSED_BYTES',
      maxEntryUncompressedBytes: 'ZIP_GUARD_MAX_ENTRY_UNCOMPRESSED_BYTES',
      maxCompressionRatio: 'ZIP_GUARD_MAX_COMPRESSION_RATIO',
      ratioFloorBytes: 'ZIP_GUARD_RATIO_FLOOR_BYTES',
    });
    expect(Object.keys(ZIP_LIMIT_ENV_VARS).sort()).toEqual(Object.keys(DEFAULT_ZIP_LIMITS).sort());
  });

  it('reads env at call time, so a raised ceiling takes effect without a restart', () => {
    const buf = makeZip({ 'bomb.bin': Buffer.alloc(12 * MiB, 0) });
    expectRejection(() => assertSafeZipArchive(buf), 'compression_ratio');
    vi.stubEnv(ZIP_LIMIT_ENV_VARS.maxCompressionRatio, '5000');
    expect(() => assertSafeZipArchive(buf)).not.toThrow();
  });

  it('falls back to the safe default when an env override is malformed or non-positive', () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 12; i++) files[`f${i}.js`] = `const a${i} = ${i};`;
    const buf = makeZip(files);
    for (const bad of ['not-a-number', '0', '-1', '', '   ', 'NaN', 'Infinity']) {
      vi.stubEnv(ZIP_LIMIT_ENV_VARS.maxEntries, bad);
      expect(() => assertSafeZipArchive(buf), `env value ${JSON.stringify(bad)}`).not.toThrow();
      vi.unstubAllEnvs();
    }
  });

  it('accepts explicit per-call limits, which win over env', () => {
    const buf = makeZip({ 'a.js': 'a', 'b.js': 'b' });
    vi.stubEnv(ZIP_LIMIT_ENV_VARS.maxEntries, '99');
    expectRejection(() => assertSafeZipArchive(buf, { limits: { maxEntries: 1 } }), 'entry_count');
  });

  it('labels the rejection with the caller-supplied archive label', () => {
    const err = expectRejection(
      () => assertSafeZipArchive(Buffer.from('nope'), { label: 'Avatar library ZIP' }),
      'unreadable',
    );
    expect(err.message).toMatch(/Avatar library ZIP/);
  });
});
