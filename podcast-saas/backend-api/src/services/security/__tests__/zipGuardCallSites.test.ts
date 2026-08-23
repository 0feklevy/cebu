/**
 * The guard is only worth anything where user-uploaded archives actually enter the system.
 * There are exactly two such parse sites:
 *
 *   • SimulationService.extractZip            — every simulation upload / replace
 *   • avatar.controller.ts zipHasHtml         — every avatar-library ZIP upload
 *
 * Both are reached from unauthenticated-to-lightly-authenticated upload routes, and both used
 * to hand an attacker-declared central directory straight to adm-zip.
 */
import { describe, it, expect, vi } from 'vitest';
import AdmZip from 'adm-zip';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SimulationService } from '../../simulation/SimulationService.js';
import type { LLMService } from '../../llm/LLMService.js';
import { ZipLimitError } from '../zipGuard.js';

const MiB = 1024 * 1024;

const mockStorage = {
  uploadFile: vi.fn().mockResolvedValue(undefined),
  getSimPublicUrl: vi.fn().mockReturnValue('https://cdn.example.com/sim.html'),
  listObjects: vi.fn().mockResolvedValue([]),
  readObject: vi.fn().mockResolvedValue(Buffer.from('')),
} as unknown as ConstructorParameters<typeof SimulationService>[0] & { uploadFile: ReturnType<typeof vi.fn> };

const svc = new SimulationService(mockStorage, {} as unknown as LLMService);

function declareUncompressedSize(buf: Buffer, declared: number): Buffer {
  const out = Buffer.from(buf);
  const EOCD_SIG = 0x06054b50;
  let eocd = -1;
  for (let i = out.length - 22; i >= 0; i--) {
    if (out.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('fixture is not a zip: no EOCD record');
  const total = out.readUInt16LE(eocd + 10);
  let at = out.readUInt32LE(eocd + 16);
  for (let i = 0; i < total; i++) {
    out.writeUInt32LE(declared, at + 24);
    at += 46 + out.readUInt16LE(at + 28) + out.readUInt16LE(at + 30) + out.readUInt16LE(at + 32);
  }
  return out;
}

describe('SimulationService ZIP call site', () => {
  it('still accepts an ordinary simulation package', () => {
    const zip = new AdmZip();
    zip.addFile('index.html', Buffer.from('<html/>'));
    zip.addFile('src/main.js', Buffer.from('const a = 1;'));
    const files = svc.buildUploadFileMap({ zipBuffer: zip.toBuffer() });
    expect([...files.keys()].sort()).toEqual(['index.html', 'src/main.js']);
  });

  it('refuses a declared-size bomb before staging anything', () => {
    const zip = new AdmZip();
    zip.addFile('index.html', Buffer.from('<html/>'));
    const bomb = declareUncompressedSize(zip.toBuffer(), 0xffffffff);
    expect(() => svc.buildUploadFileMap({ zipBuffer: bomb })).toThrow(ZipLimitError);
    expect(mockStorage.uploadFile).not.toHaveBeenCalled();
  });

  it('refuses a traversal entry name through the shared guard', () => {
    const zip = new AdmZip();
    zip.addFile('index.html', Buffer.from('<html/>'));
    zip.addFile('placeholder.js', Buffer.from('x')).entryName = '../../evil.js';
    let caught: unknown;
    try { svc.buildUploadFileMap({ zipBuffer: zip.toBuffer() }); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(ZipLimitError);
    expect((caught as ZipLimitError).code).toBe('entry_name');
  });

  it('refuses a real high-ratio archive', () => {
    const zip = new AdmZip();
    zip.addFile('index.html', Buffer.from('<html/>'));
    zip.addFile('bomb.bin', Buffer.alloc(12 * MiB, 0));
    let caught: unknown;
    try { svc.buildUploadFileMap({ zipBuffer: zip.toBuffer() }); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(ZipLimitError);
    expect((caught as ZipLimitError).code).toBe('compression_ratio');
  });
});

describe('avatar library ZIP call site', () => {
  const src = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../../controllers/v1/avatar.controller.ts'),
    'utf8',
  );

  it('routes the library ZIP probe through the shared guard', () => {
    expect(src).toMatch(/function zipHasHtml[\s\S]{0,400}?assertSafeZipArchive\(/);
  });

  it('no longer constructs AdmZip directly on the upload path', () => {
    expect(src).not.toMatch(/new AdmZip\(/);
  });
});

describe('no unguarded zip parse remains on an upload path', () => {
  it('every `new AdmZip(<user buffer>)` in src is either guarded or an archive we build', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const simSrc = readFileSync(resolve(here, '../../simulation/SimulationService.ts'), 'utf8');
    // The only read-side parse in SimulationService is inside extractZip, and it must come
    // from the guard rather than from a bare constructor.
    expect(simSrc).not.toMatch(/new AdmZip\(buf\)/);
    expect(simSrc).toMatch(/private extractZip[\s\S]{0,600}?assertSafeZipArchive\(/);
  });
});
