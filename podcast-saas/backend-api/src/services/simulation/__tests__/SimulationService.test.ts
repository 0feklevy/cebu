import { describe, it, expect, vi, beforeEach } from 'vitest';
import AdmZip from 'adm-zip';
import { SimulationService } from '../SimulationService.js';
import type { LLMService } from '../../llm/LLMService.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeZip(files: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [path, content] of Object.entries(files)) {
    zip.addFile(path, Buffer.from(content));
  }
  return zip.toBuffer();
}

function htmlMap(files: Record<string, string>): Map<string, Buffer> {
  return new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)]));
}

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockStorage = {
  uploadFile: vi.fn().mockResolvedValue(undefined),
  getSimPublicUrl: vi.fn().mockReturnValue('https://cdn.example.com/sim.html'),
  listObjects: vi.fn().mockResolvedValue([]),
  readObject: vi.fn().mockResolvedValue(Buffer.from('')),
} as unknown as Parameters<typeof SimulationService.prototype.constructor>[0];

const mockLLMService = {} as unknown as LLMService;

// ── Setup ─────────────────────────────────────────────────────────────────────

let svc: SimulationService;

beforeEach(() => {
  vi.clearAllMocks();
  svc = new SimulationService(mockStorage, mockLLMService);
});

// ── extractZip ────────────────────────────────────────────────────────────────

describe('extractZip', () => {
  it('returns all non-directory, non-hidden file entries', () => {
    const buf = makeZip({ 'index.html': '<h1/>', 'app.js': 'var x=1;' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const files: Map<string, Buffer> = (svc as any).extractZip(buf);
    expect(files.has('index.html')).toBe(true);
    expect(files.has('app.js')).toBe(true);
    expect(files.size).toBe(2);
  });

  it('strips __MACOSX/ prefix from entry names', () => {
    const zip = new AdmZip();
    zip.addFile('index.html', Buffer.from('<h1/>'));
    zip.addFile('__MACOSX/._index.html', Buffer.from(''));
    zip.addFile('__MACOSX/sim/._app.js', Buffer.from(''));
    const buf = zip.toBuffer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const files: Map<string, Buffer> = (svc as any).extractZip(buf);
    expect(files.has('index.html')).toBe(true);
    expect([...files.keys()].some(k => k.includes('__MACOSX'))).toBe(false);
    expect([...files.keys()].some(k => k.startsWith('.'))).toBe(false);
    expect([...files.keys()].some(k => k.endsWith('/._app.js'))).toBe(false);
    expect(files.has('sim')).toBe(false);
  });

  it('excludes dot-files like .DS_Store', () => {
    const zip = new AdmZip();
    zip.addFile('index.html', Buffer.from('<h1/>'));
    zip.addFile('.DS_Store', Buffer.from(''));
    const buf = zip.toBuffer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const files: Map<string, Buffer> = (svc as any).extractZip(buf);
    expect(files.has('.DS_Store')).toBe(false);
    expect(files.has('index.html')).toBe(true);
  });

  it('returns empty Map for a ZIP with no valid entries', () => {
    const buf = makeZip({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const files: Map<string, Buffer> = (svc as any).extractZip(buf);
    expect(files.size).toBe(0);
  });

  it('preserves file content correctly', () => {
    const html = '<html><body>hello</body></html>';
    const buf = makeZip({ 'index.html': html });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const files: Map<string, Buffer> = (svc as any).extractZip(buf);
    expect(files.get('index.html')!.toString('utf-8')).toBe(html);
  });

  it('keeps nested binary assets like PNG files', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const zip = new AdmZip();
    zip.addFile('ising-kid-simu/index.html', Buffer.from('<html></html>'));
    zip.addFile('ising-kid-simu/VERSION3/BLUE_RED_HATS_NEW/1_BLUE_HAPPY.png', png);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const files: Map<string, Buffer> = (svc as any).extractZip(zip.toBuffer());
    expect(files.get('ising-kid-simu/VERSION3/BLUE_RED_HATS_NEW/1_BLUE_HAPPY.png')).toEqual(png);
  });

  it('rejects unsafe paths', async () => {
    await expect(svc.processFileUpload({
      projectId: 'project-1',
      simId:     'sim-1',
      files:     [{ path: '../index.html', buffer: Buffer.from('<html></html>') }],
    })).rejects.toThrow(/Unsafe file path/);
  });
});

describe('processFileUpload', () => {
  it('uploads folder bundles with preserved paths and content types', async () => {
    const html = Buffer.from('<html><body></body></html>');
    const css = Buffer.from('body { color: red; }');
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

    const result = await svc.processFileUpload({
      projectId: 'project-1',
      simId:     'sim-1',
      files: [
        { path: 'ising-kid-simu/ising_model.html', buffer: html },
        { path: 'ising-kid-simu/ising_model.css', buffer: css },
        { path: 'ising-kid-simu/VERSION3/BLUE_RED_HATS_NEW/1_BLUE_HAPPY.png', buffer: png },
      ],
    });

    expect(result.entryKey).toBe('simulations/project-1/sim-1/ising-kid-simu/ising_model.html');
    // Write-once assets (css/png) upload with immutable cache metadata; the rewritable
    // entry HTML must NOT (bridge regeneration overwrites it in place).
    const IMMUTABLE = 'public, max-age=31536000, immutable';
    expect(mockStorage.uploadFile).toHaveBeenCalledWith(
      'simulations/project-1/sim-1/ising-kid-simu/ising_model.css',
      css,
      'text/css',
      IMMUTABLE,
    );
    expect(mockStorage.uploadFile).toHaveBeenCalledWith(
      'simulations/project-1/sim-1/ising-kid-simu/VERSION3/BLUE_RED_HATS_NEW/1_BLUE_HAPPY.png',
      png,
      'image/png',
      IMMUTABLE,
    );
    expect(mockStorage.uploadFile).toHaveBeenCalledWith(
      'simulations/project-1/sim-1/ising-kid-simu/ising_model.html',
      expect.any(Buffer),
      'text/html; charset=utf-8',
      undefined,
    );
  });
});

// ── findEntryHtml ─────────────────────────────────────────────────────────────

describe('findEntryHtml', () => {
  it('returns index.html when present at root', () => {
    const files = htmlMap({ 'index.html': '', 'other.html': '' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((svc as any).findEntryHtml(files)).toBe('index.html');
  });

  it('returns folder/index.html (single-folder ZIP) preferentially', () => {
    const files = htmlMap({ 'sim/index.html': '', 'sim/about.html': '' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((svc as any).findEntryHtml(files)).toBe('sim/index.html');
  });

  it('falls back to shortest-path HTML when no index.html', () => {
    const files = htmlMap({ 'sim/deep/other.html': '', 'sim/main.html': '' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: string | null = (svc as any).findEntryHtml(files);
    expect(result).toBe('sim/main.html');
  });

  it('returns null when no HTML files exist', () => {
    const files = htmlMap({ 'app.js': '', 'style.css': '' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((svc as any).findEntryHtml(files)).toBeNull();
  });

  it('accepts .htm extension', () => {
    const files = htmlMap({ 'index.htm': '' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((svc as any).findEntryHtml(files)).toBe('index.htm');
  });
});

// ── injectBridge ──────────────────────────────────────────────────────────────

describe('injectBridge', () => {
  const fns = [{ name: 'runDemo', windowFn: 'runDemo', description: 'runs the demo' }];

  it('injects script tag before </body>', () => {
    const html = '<html><body><p>hi</p></body></html>';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: string = (svc as any).injectBridge(html, fns);
    const bodyIdx   = result.indexOf('</body>');
    const scriptIdx = result.indexOf('<script>');
    expect(scriptIdx).toBeGreaterThan(-1);
    expect(scriptIdx).toBeLessThan(bodyIdx);
  });

  it('appends script when no </body> tag present', () => {
    const html = '<h1>bare html</h1>';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: string = (svc as any).injectBridge(html, fns);
    expect(result.endsWith('</script>')).toBe(true);
    expect(result).toContain('<h1>bare html</h1>');
  });

  it('replaces __SIM_BRIDGE_FUNCTIONS__ with serialized fn array', () => {
    const html = '<html><body></body></html>';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: string = (svc as any).injectBridge(html, fns);
    expect(result).toContain(JSON.stringify(fns));
    expect(result).not.toContain('__SIM_BRIDGE_FUNCTIONS__');
  });

  it('bridge script contains SIM_READY postMessage call', () => {
    const html = '<html><body></body></html>';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: string = (svc as any).injectBridge(html, fns);
    expect(result).toContain('SIM_READY');
    expect(result).toContain('postMessage');
  });

  it('handles empty functions array', () => {
    const html = '<html><body></body></html>';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: string = (svc as any).injectBridge(html, []);
    expect(result).toContain('[]');
    expect(result).toContain('SIM_READY');
  });
});
