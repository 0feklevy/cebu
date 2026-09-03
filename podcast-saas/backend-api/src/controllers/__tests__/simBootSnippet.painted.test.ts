/**
 * The serve-time boot snippet posts SIM_PAINTED_FALLBACK for a package that has no rAF gate — run
 * for real in a sandbox with a fake window, not read as text. Its own type, not SIM_PAINTED: the
 * gate's message means a real frame was drawn and the player's hold relies on that.
 *
 * Every cover that waits for the gate's first frame waited for a timer instead when the package
 * predated the gate (the library overlay: "Loading simulation…" for load + 2.5 s). The gate is
 * baked at publication; the snippet is injected at serve time, so this reaches every stored
 * package. A gated document must stay silent here — the gate posts its own.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import vm from 'node:vm';
import { injectSimBootSnippet, resetSimBootSnippetForTest } from '../sim-public.controller.js';

interface Fake {
  listeners: Record<string, Array<() => void>>;
  posted: unknown[];
  raf: Array<() => void>;
  gate: boolean;
}

/** Run the injected snippet against a minimal window; return what it did. */
function runSnippet(opts: { gate: boolean; parentIsSelf?: boolean }): Fake {
  const html = injectSimBootSnippet('<!doctype html><html><head></head><body></body></html>');
  const m = /<script data-simboot>([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error('snippet not injected');
  const fake: Fake = { listeners: {}, posted: [], raf: [], gate: opts.gate };
  const parent = { postMessage: (msg: unknown) => { fake.posted.push(msg); } };
  const window: Record<string, unknown> = {
    addEventListener: (name: string, fn: () => void) => { (fake.listeners[name] ??= []).push(fn); },
    requestAnimationFrame: (fn: () => void) => { fake.raf.push(fn); return fake.raf.length; },
  };
  window.parent = opts.parentIsSelf ? window : parent;
  if (opts.gate) window.__SIM_RAF_GATE__ = { v: 1 };
  const document = {
    getElementById: () => null,
    createElement: () => ({ setAttribute() {}, style: {} }),
    head: { appendChild() {} },
    documentElement: { appendChild() {} },
  };
  // The snippet calls the bare globals, as a document would; they are the window's.
  const ctx = vm.createContext({
    window, document, location: { hash: '' }, JSON, decodeURIComponent,
    requestAnimationFrame: window.requestAnimationFrame,
  });
  vm.runInContext(m[1], ctx);
  return fake;
}

beforeEach(() => { resetSimBootSnippetForTest(); });

describe('the boot snippet’s painted fallback', () => {
  it('a document WITHOUT the gate posts SIM_PAINTED_FALLBACK two frames after load — never the gate’s own SIM_PAINTED', () => {
    const fake = runSnippet({ gate: false });
    expect(fake.listeners.load).toHaveLength(1);
    fake.listeners.load![0]!();
    expect(fake.posted).toEqual([]);
    expect(fake.raf).toHaveLength(1);
    fake.raf[0]!();                     // first frame: nothing yet
    expect(fake.posted).toEqual([]);
    expect(fake.raf).toHaveLength(2);
    fake.raf[1]!();                     // second frame: painted
    expect(fake.posted).toEqual([{ type: 'SIM_PAINTED_FALLBACK' }]);
  });

  it('a document WITH the gate schedules NO frame at all — the gate wraps rAF and would ack a paint for a fallback frame', () => {
    const fake = runSnippet({ gate: true });
    fake.listeners.load![0]!();
    expect(fake.raf).toHaveLength(0);
    expect(fake.posted).toEqual([]);
  });

  it('a top-level document (no parent) posts nothing and throws nothing', () => {
    const fake = runSnippet({ gate: false, parentIsSelf: true });
    fake.listeners.load![0]!();
    fake.raf[0]!();
    expect(() => fake.raf[1]!()).not.toThrow();
    expect(fake.posted).toEqual([]);
  });

  it('the message listener is still installed first — the fallback cannot take it down', () => {
    const fake = runSnippet({ gate: false });
    expect(fake.listeners.message).toHaveLength(1);
  });
});
