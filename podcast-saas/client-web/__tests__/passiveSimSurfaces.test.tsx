/**
 * Priority 4.7 — the two PASSIVE simulation surfaces (the avatar Library gallery in client-web and
 * the avatar gallery in admin-web) used to hand-roll a raw <iframe>: no origin rebase in one, no
 * boot-hide fragment, and — on both — a frame that was invisible but still in the accessibility
 * tree and still in the tab order.
 *
 * These surfaces are deliberately LIGHT (no activation protocol, no reveal gate beyond `load`), so
 * the guarantee has to come from routing them through the shared surface component rather than
 * from a lifecycle. This file pins that:
 *
 *   1. a hidden frame is `inert` + `aria-hidden` + `tabIndex=-1` on BOTH surfaces;
 *   2. the client gallery's src goes through resolveSimUrl (origin rebase + device hints +
 *      #simboot), and the call site passes the RAW url so it is resolved exactly once;
 *   3. the IntersectionObserver lazy-mount still defers the frame until it intersects — that is a
 *      real performance property of the gallery, not decoration;
 *   4. client-web's SimSurface and admin-web's AdminSimSurface (a second implementation only
 *      because `shared` cannot host a .tsx — see AdminSimSurface's header) produce IDENTICAL DOM
 *      for identical props. This is what stops the two from drifting;
 *   5. neither migrated source file has grown a raw <iframe> back.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SimSurface } from '../lib/sim/SimSurface';
import { AdminSimSurface } from '../../admin-web/components/AdminSimSurface';
import { __resetDprSnapshotForTests } from '../lib/simUrl';
import { ExtendedLibraryModal } from '../components/avatar/ExtendedLibraryModal';
import type { LibraryItem } from '../components/avatar/avatarApi';

// ── module doubles ────────────────────────────────────────────────────────────────────────────
// avatarApi reaches Firebase at import time; the renderers pull katex/chart.js. Neither is under
// test here and both only add ways for this file to fail for unrelated reasons.

const { libraryItems } = vi.hoisted(() => ({ libraryItems: { current: [] as unknown[] } }));

vi.mock('../components/avatar/avatarApi', () => ({
  getProjectLibrary: vi.fn(async () => ({
    items: libraryItems.current,
    total: libraryItems.current.length,
    typeCounts: { simulation: libraryItems.current.length },
  })),
  generateLibraryImage: vi.fn(async () => ({})),
  generateLibrarySimulation: vi.fn(async () => ({})),
  patchLibraryVisual: vi.fn(async () => ({ ok: true })),
  deleteLibraryVisual: vi.fn(async () => ({ ok: true })),
  editLibrarySimulation: vi.fn(async () => ({})),
  uploadLibraryFiles: vi.fn(async () => ({ ok: true, accepted: [], rejected: [] })),
}));
vi.mock('../components/avatar/renderers/EquationRenderer', () => ({ EquationRenderer: () => null }));
vi.mock('../components/avatar/renderers/ChartRenderer', () => ({ ChartRenderer: () => null }));
vi.mock('../components/avatar/renderers/DiagramRenderer', () => ({ DiagramRenderer: () => null }));
vi.mock('../components/GuidedTour', () => ({ GuidedTour: () => null }));

// ── IntersectionObserver double ───────────────────────────────────────────────────────────────
// jsdom ships none. The double keeps the instances so a test can drive intersection explicitly —
// which is the only way to prove the frame is NOT mounted before it happens.

interface ObserverRecord {
  options?: IntersectionObserverInit;
  fire: (isIntersecting: boolean) => void;
}
const observers: ObserverRecord[] = [];

/**
 * The first observer, once the component has actually created it.
 *
 * `observers[0]` was read directly, which assumed the lazy-mount effect had already run by the time
 * the item's text rendered. Usually true; under full-suite load, not always — the failure surfaced
 * as `Cannot read properties of undefined (reading 'fire')` about once in six runs. Waiting makes
 * the ordering explicit, and a component that never observes now fails with a sentence rather than
 * a TypeError.
 */
async function firstObserver(): Promise<ObserverRecord> {
  await vi.waitFor(
    () => { expect(observers.length, 'the component never created an IntersectionObserver').toBeGreaterThan(0); },
    { timeout: 2000, interval: 10 },
  );
  return observers[0];
}

class FakeIntersectionObserver {
  constructor(cb: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    observers.push({
      options,
      fire: (isIntersecting) =>
        act(() => {
          cb([{ isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
        }),
    });
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] { return []; }
}

const SIM_URL = 'https://api.flowvidco.com/sim-public/simulations/proj/sec/boids/index.html?v=7';

const simItem = (over: Partial<LibraryItem> = {}): LibraryItem => ({
  id: 'vis-1',
  project_id: 'proj-1',
  scope: 'extended',
  source: 'generated',
  character_id: 'einstein',
  visual_type: 'simulation',
  caption: 'a pendulum',
  alt_text: null,
  image_url: null,
  sim_entry_url: SIM_URL,
  visual_spec: null,
  use_count: 3,
  ...over,
});

/** The rules that must never differ between the two surface implementations. */
function frameRules(el: HTMLIFrameElement) {
  return {
    src: el.getAttribute('src'),
    srcdoc: el.getAttribute('srcdoc'),
    sandbox: el.getAttribute('sandbox'),
    inert: el.hasAttribute('inert'),
    ariaHidden: el.getAttribute('aria-hidden'),
    tabIndex: el.getAttribute('tabindex'),
    opacity: el.style.opacity,
    pointerEvents: el.style.pointerEvents,
    transition: el.style.transition,
    loading: el.getAttribute('loading'),
    title: el.getAttribute('title'),
  };
}

beforeEach(() => {
  observers.length = 0;
  libraryItems.current = [];
  __resetDprSnapshotForTests();
  Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
  globalThis.IntersectionObserver = FakeIntersectionObserver as unknown as typeof IntersectionObserver;
});
afterEach(() => {
  cleanup();
  __resetDprSnapshotForTests();
});

// ──────────────────────────────────────────────────────────────────────────────────────────────

describe('client-web avatar Library — lazy simulation preview', () => {
  it('defers the frame until the observer reports intersection (lazy-mount preserved)', async () => {
    libraryItems.current = [simItem()];
    const { container } = render(
      <ExtendedLibraryModal open onClose={() => {}} projectId="proj-1" />,
    );

    await screen.findByText('a pendulum');

    expect(container.querySelector('iframe')).toBeNull();
    expect(observers).toHaveLength(1);
    // The prefetch window is part of the performance property, not an arbitrary literal.
    expect((await firstObserver()).options?.rootMargin).toBe('120px');

    (await firstObserver()).fire(true);
    expect(container.querySelector('iframe')).not.toBeNull();
  });

  it('unmounts the frame again when it scrolls out of view', async () => {
    libraryItems.current = [simItem()];
    const { container } = render(
      <ExtendedLibraryModal open onClose={() => {}} projectId="proj-1" />,
    );
    await screen.findByText('a pendulum');

    (await firstObserver()).fire(true);
    expect(container.querySelector('iframe')).not.toBeNull();
    (await firstObserver()).fire(false);
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('keeps the not-yet-loaded frame inert, aria-hidden and untabbable', async () => {
    libraryItems.current = [simItem()];
    const { container } = render(
      <ExtendedLibraryModal open onClose={() => {}} projectId="proj-1" />,
    );
    await screen.findByText('a pendulum');
    (await firstObserver()).fire(true);

    const frame = container.querySelector('iframe') as HTMLIFrameElement;
    expect(frame.hasAttribute('inert')).toBe(true);
    expect(frame.getAttribute('aria-hidden')).toBe('true');
    expect(frame.getAttribute('tabindex')).toBe('-1');
    expect(frame.style.opacity).toBe('0');
    expect(frame.style.pointerEvents).toBe('none');

    act(() => { fireEvent.load(frame); });

    expect(frame.hasAttribute('inert')).toBe(false);
    expect(frame.getAttribute('aria-hidden')).toBe('false');
    expect(frame.hasAttribute('tabindex')).toBe(false);
    expect(frame.style.opacity).toBe('1');
    // The gallery preview is a thumbnail: it stays non-interactive even once revealed.
    expect(frame.style.pointerEvents).toBe('none');
  });

  it('re-hides the frame after a remount so a fresh document re-earns its reveal', async () => {
    libraryItems.current = [simItem()];
    const { container } = render(
      <ExtendedLibraryModal open onClose={() => {}} projectId="proj-1" />,
    );
    await screen.findByText('a pendulum');

    (await firstObserver()).fire(true);
    act(() => { fireEvent.load(container.querySelector('iframe') as HTMLIFrameElement); });
    expect((container.querySelector('iframe') as HTMLIFrameElement).style.opacity).toBe('1');

    (await firstObserver()).fire(false);
    (await firstObserver()).fire(true);

    const remounted = container.querySelector('iframe') as HTMLIFrameElement;
    expect(remounted.style.opacity).toBe('0');
    expect(remounted.hasAttribute('inert')).toBe(true);
  });

  it('routes the src through resolveSimUrl exactly once (rebase + hints + #simboot)', async () => {
    libraryItems.current = [simItem()];
    const { container } = render(
      <ExtendedLibraryModal open onClose={() => {}} projectId="proj-1" />,
    );
    await screen.findByText('a pendulum');
    (await firstObserver()).fire(true);

    const src = (container.querySelector('iframe') as HTMLIFrameElement).getAttribute('src')!;
    const u = new URL(src);

    // Rebased off the stored api.flowvidco.com origin onto this environment's API origin —
    // without it the frame-src CSP blocks the frame outright and the card renders blank.
    expect(u.origin).toBe('http://localhost:8080');
    expect(u.pathname).toBe('/sim-public/simulations/proj/sec/boids/index.html');
    expect(u.searchParams.get('v')).toBe('7');
    expect(u.searchParams.get('dpr')).toBe('2');
    expect(u.hash).toContain('simboot=');
    // Resolved once: a double pass would leave two dpr params / two simboot fragments.
    expect(u.searchParams.getAll('dpr')).toHaveLength(1);
    expect(src.match(/simboot=/g)).toHaveLength(1);
  });

  it('never grants an inline-HTML preview allow-same-origin', async () => {
    libraryItems.current = [simItem({ sim_entry_url: null, visual_spec: { html: '<b>inline</b>' } })];
    const { container } = render(
      <ExtendedLibraryModal open onClose={() => {}} projectId="proj-1" />,
    );
    await screen.findByText('a pendulum');
    (await firstObserver()).fire(true);

    const frame = container.querySelector('iframe') as HTMLIFrameElement;
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('src')).toBeNull();
    expect(frame.getAttribute('srcdoc')).toBe('<b>inline</b>');
  });

  it('fullscreen preview is hidden, inert and untabbable until it loads', async () => {
    libraryItems.current = [simItem()];
    render(<ExtendedLibraryModal open onClose={() => {}} projectId="proj-1" />);
    await screen.findByText('a pendulum');

    fireEvent.click(screen.getByTitle('Full screen'));

    const frame = document.querySelector('.avatar-gfs__frame') as HTMLIFrameElement;
    expect(frame).not.toBeNull();
    expect(frame.hasAttribute('inert')).toBe(true);
    expect(frame.getAttribute('aria-hidden')).toBe('true');
    expect(frame.getAttribute('tabindex')).toBe('-1');
    expect(new URL(frame.src).origin).toBe('http://localhost:8080');

    act(() => { fireEvent.load(frame); });

    expect(frame.hasAttribute('inert')).toBe(false);
    expect(frame.hasAttribute('tabindex')).toBe(false);
    // Fullscreen IS interactive — the gate is visibility, not a blanket pointer-events:none.
    expect(frame.style.pointerEvents).toBe('auto');
  });
});

describe('admin-web AdminSimSurface', () => {
  it('keeps a hidden frame inert, aria-hidden and untabbable', () => {
    const { container } = render(
      <AdminSimSurface src={SIM_URL} visible={false} title="sim" sandbox="allow-scripts allow-same-origin" />,
    );
    const frame = container.querySelector('iframe') as HTMLIFrameElement;
    expect(frame.hasAttribute('inert')).toBe(true);
    expect(frame.getAttribute('aria-hidden')).toBe('true');
    expect(frame.getAttribute('tabindex')).toBe('-1');
    expect(frame.style.opacity).toBe('0');
    expect(frame.style.pointerEvents).toBe('none');
  });

  it('releases inert/aria-hidden/tabIndex once visible', () => {
    const { container } = render(
      <AdminSimSurface src={SIM_URL} visible title="sim" sandbox="allow-scripts allow-same-origin" />,
    );
    const frame = container.querySelector('iframe') as HTMLIFrameElement;
    expect(frame.hasAttribute('inert')).toBe(false);
    expect(frame.getAttribute('aria-hidden')).toBe('false');
    expect(frame.hasAttribute('tabindex')).toBe(false);
    expect(frame.style.pointerEvents).toBe('auto');
  });

  it('routes the src through resolveSimUrl (rebase + hints + #simboot)', () => {
    const { container } = render(<AdminSimSurface src={SIM_URL} visible />);
    const u = new URL((container.querySelector('iframe') as HTMLIFrameElement).src);
    expect(u.origin).toBe('http://localhost:8080');
    expect(u.searchParams.get('dpr')).toBe('2');
    expect(u.hash).toContain('simboot=');
  });

  it('renders nothing without a src or srcDoc', () => {
    const { container } = render(<AdminSimSurface visible />);
    expect(container.querySelector('iframe')).toBeNull();
  });
});

describe('SimSurface / AdminSimSurface agree on the rules that matter', () => {
  /**
   * Deliberately ONE prop type applied to both components: if either surface renames or drops a
   * prop the other still has, this file stops compiling — which is the earliest possible signal
   * that the two have diverged.
   */
  interface SharedFrameProps {
    src?: string;
    srcDoc?: string;
    visible: boolean;
    interactive?: boolean;
    sandbox?: string;
    bootHide?: string[];
    fade?: boolean;
  }

  const cases: Array<{ name: string; props: SharedFrameProps }> = [
    { name: 'hidden url frame', props: { src: SIM_URL, visible: false } },
    { name: 'visible url frame', props: { src: SIM_URL, visible: true } },
    { name: 'non-interactive visible frame', props: { src: SIM_URL, visible: true, interactive: false } },
    { name: 'hidden srcDoc frame', props: { srcDoc: '<b>x</b>', visible: false, sandbox: 'allow-scripts' } },
    { name: 'boot-hide selectors', props: { src: SIM_URL, visible: true, bootHide: ['#hud', '.controls'] } },
    { name: 'fade disabled', props: { src: SIM_URL, visible: true, fade: false } },
  ];

  for (const { name, props } of cases) {
    it(`produces identical DOM: ${name}`, () => {
      const a = render(<SimSurface {...props} frameRef={() => {}} />);
      const client = frameRules(a.container.querySelector('iframe') as HTMLIFrameElement);
      cleanup();

      const b = render(<AdminSimSurface {...props} />);
      const admin = frameRules(b.container.querySelector('iframe') as HTMLIFrameElement);

      expect(admin).toEqual(client);
    });
  }

  it('agrees on the default sandbox token set', () => {
    const a = render(<SimSurface src={SIM_URL} visible frameRef={() => {}} />);
    const clientSandbox = a.container.querySelector('iframe')!.getAttribute('sandbox');
    cleanup();
    const b = render(<AdminSimSurface src={SIM_URL} visible />);
    expect(b.container.querySelector('iframe')!.getAttribute('sandbox')).toBe(clientSandbox);
    expect(clientSandbox).toBe('allow-scripts allow-same-origin allow-forms');
  });

  it('agrees on the fade duration', () => {
    const a = render(<SimSurface src={SIM_URL} visible frameRef={() => {}} />);
    const clientTransition = (a.container.querySelector('iframe') as HTMLIFrameElement).style.transition;
    cleanup();
    const b = render(<AdminSimSurface src={SIM_URL} visible />);
    expect((b.container.querySelector('iframe') as HTMLIFrameElement).style.transition).toBe(clientTransition);
    expect(clientTransition).toContain('200ms');
  });
});

describe('no migrated surface hand-rolls an iframe again', () => {
  const files = [
    '../components/avatar/ExtendedLibraryModal.tsx',
    '../../admin-web/app/avatar/page.tsx',
  ];

  for (const rel of files) {
    it(`${rel} contains no raw <iframe>`, () => {
      const source = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
      expect(source).not.toMatch(/<iframe/);
    });
  }
});
