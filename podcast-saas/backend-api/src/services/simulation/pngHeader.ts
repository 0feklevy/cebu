/**
 * Read a PNG's dimensions from its header without decoding it — enough to refuse a poster upload
 * that is not a PNG, or not the size the identity names, before any byte is stored.
 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface PngHeader { width: number; height: number }

export function parsePngHeader(buf: Buffer): PngHeader | null {
  // 8 signature + 4 length + 4 'IHDR' + 4 width + 4 height = 24 bytes minimum.
  if (buf.length < 24) return null;
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width === 0 || height === 0) return null;
  return { width, height };
}

/** `data:image/png;base64,…` → bytes, or null for anything else. */
export function decodePngDataUrl(dataUrl: string, maxBytes: number): Buffer | null {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
  if (!m) return null;
  const b64 = m[1].replace(/\s+/g, '');
  // 4 base64 chars → 3 bytes; refuse before allocating anything large.
  if ((b64.length * 3) / 4 > maxBytes) return null;
  const buf = Buffer.from(b64, 'base64');
  return buf.length > 0 && buf.length <= maxBytes ? buf : null;
}
