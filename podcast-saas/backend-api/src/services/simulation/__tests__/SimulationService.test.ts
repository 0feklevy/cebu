import { describe, it, expect, vi, beforeEach } from 'vitest';
import AdmZip from 'adm-zip';
import { SimulationService } from '../SimulationService.js';

// ── Mock Anthropic SDK ────────────────────────────────────────────────────────

const mockCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  function MockAnthropic(_opts: unknown) {
    return { messages: { create: mockCreate } };
  }
  return { default: MockAnthropic };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeZip(files: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [path, content] of Object.entries(files)) {
    zip.addFile(path, Buffer.from(content));
  }
  return zip.toBuffer();
}

function jsMap(files: Record<string, string>): Map<string, Buffer> {
  return new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)]));
}

function htmlMap(files: Record<string, string>): Map<string, Buffer> {
  return new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)]));
}

const mockStorage = {
  uploadFile: vi.fn(),
  getSimPublicUrl: vi.fn(),
} as unknown as Parameters<typeof SimulationService['prototype']['constructor']>[0];

// ── Setup ─────────────────────────────────────────────────────────────────────

let svc: SimulationService;

beforeEach(() => {
  vi.clearAllMocks();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  svc = new SimulationService(mockStorage as any, 'test-api-key');
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
    // Manually add a macOS artifact entry
    zip.addFile('__MACOSX/._index.html', Buffer.from(''));
    const buf = zip.toBuffer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const files: Map<string, Buffer> = (svc as any).extractZip(buf);
    // The __MACOSX artifact should be excluded (starts with ._)
    expect(files.has('index.html')).toBe(true);
    expect([...files.keys()].some(k => k.includes('__MACOSX'))).toBe(false);
    expect([...files.keys()].some(k => k.startsWith('.'))).toBe(false);
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
    // sim/main.html has fewer path segments than sim/deep/other.html
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
    const bodyIdx  = result.indexOf('</body>');
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

// ── extractBridgeFunctions ────────────────────────────────────────────────────

describe('extractBridgeFunctions', () => {
  it('returns [] when jsFiles is empty', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (svc as any).extractBridgeFunctions(new Map());
    expect(result).toEqual([]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('returns [] when anthropicApiKey is falsy', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svcNoKey = new SimulationService(mockStorage as any, '');
    const files = jsMap({ 'app.js': 'window.runDemo = function() {}' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (svcNoKey as any).extractBridgeFunctions(files);
    expect(result).toEqual([]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('parses valid JSON array from AI response', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: '[{"name":"runDemo","windowFn":"runDemo","description":"runs demo"}]' }],
    });
    const files = jsMap({ 'app.js': 'window.runDemo = function() {}' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (svc as any).extractBridgeFunctions(files);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ name: 'runDemo', windowFn: 'runDemo', description: 'runs demo' });
  });

  it('strips markdown code fences before parsing', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: '```json\n[{"name":"fn","windowFn":"fn","description":"desc"}]\n```' }],
    });
    const files = jsMap({ 'app.js': 'window.fn = function() {}' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (svc as any).extractBridgeFunctions(files);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('fn');
  });

  it('filters out items missing required fields', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: '[{"name":"ok","windowFn":"ok","description":"valid"},{"name":"bad"},{"windowFn":"missing_name","description":"x"}]' }],
    });
    const files = jsMap({ 'app.js': 'window.ok = function() {}' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (svc as any).extractBridgeFunctions(files);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('ok');
  });

  it('returns [] on JSON parse error (does not throw)', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'this is not json' }],
    });
    const files = jsMap({ 'app.js': 'window.x = function() {}' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (svc as any).extractBridgeFunctions(files);
    expect(result).toEqual([]);
  });

  it('returns [] when API call throws', async () => {
    mockCreate.mockRejectedValue(new Error('Network error'));
    const files = jsMap({ 'app.js': 'window.x = function() {}' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (svc as any).extractBridgeFunctions(files);
    expect(result).toEqual([]);
  });

  it('takes only the 4 largest JS files when more than 4 are provided', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: '[]' }],
    });
    // 5 files with sizes 100, 200, 300, 400, 500 chars
    const files = jsMap({
      'tiny.js':    'a'.repeat(100),
      'small.js':   'b'.repeat(200),
      'medium.js':  'c'.repeat(300),
      'large.js':   'd'.repeat(400),
      'largest.js': 'e'.repeat(500),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (svc as any).extractBridgeFunctions(files);
    expect(mockCreate).toHaveBeenCalledOnce();
    const calledContent: string = mockCreate.mock.calls[0][0].messages[0].content;
    // The 4 largest should be present; the smallest ('tiny.js') should be absent
    expect(calledContent).toContain('largest.js');
    expect(calledContent).toContain('large.js');
    expect(calledContent).toContain('medium.js');
    expect(calledContent).toContain('small.js');
    expect(calledContent).not.toContain('tiny.js');
  });
});
