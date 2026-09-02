import { describe, it, expect } from 'vitest';
import { decodePngDataUrl, parsePngHeader } from '../pngHeader.js';

/** A minimal PNG header: signature + IHDR chunk naming w×h (no image data — enough for the parser). */
function pngHeader(w: number, h: number): Buffer {
  const b = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

describe('parsePngHeader', () => {
  it('reads width and height from a PNG header', () => {
    expect(parsePngHeader(pngHeader(1280, 720))).toEqual({ width: 1280, height: 720 });
    expect(parsePngHeader(pngHeader(720, 1280))).toEqual({ width: 720, height: 1280 });
  });

  it('refuses anything that is not a PNG, or is too short, or names a zero dimension', () => {
    expect(parsePngHeader(Buffer.from('GIF89a…'))).toBeNull();
    expect(parsePngHeader(pngHeader(1, 1).subarray(0, 20))).toBeNull();
    expect(parsePngHeader(pngHeader(0, 720))).toBeNull();
    const notIhdr = pngHeader(1, 1); notIhdr.write('IDAT', 12, 'ascii');
    expect(parsePngHeader(notIhdr)).toBeNull();
  });
});

describe('decodePngDataUrl', () => {
  it('decodes a png data URL and refuses other media types and oversize payloads', () => {
    const bytes = pngHeader(640, 360);
    const url = `data:image/png;base64,${bytes.toString('base64')}`;
    expect(decodePngDataUrl(url, 1024)?.equals(bytes)).toBe(true);
    expect(decodePngDataUrl(url.replace('image/png', 'image/jpeg'), 1024)).toBeNull();
    expect(decodePngDataUrl(url, 10)).toBeNull();
    expect(decodePngDataUrl('not a data url', 1024)).toBeNull();
  });
});
