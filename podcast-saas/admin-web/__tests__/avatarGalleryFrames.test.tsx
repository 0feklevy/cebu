/**
 * The admin avatar gallery is the ONLY place admin-web frames third-party content, and it frames
 * two very different things through the same component: a stored simulation (a real URL on the
 * sim-public proxy) and a diagram (model-authored HTML inlined via srcDoc). They need opposite
 * sandboxes, and the stored URL needs the origin rebase that the pre-migration raw <iframe> lacked.
 *
 * AdminSimSurface's own tests prove the component obeys those rules when asked. This file proves
 * the call site actually asks — which is where the original defect lived.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// See adminSimSurface.test.tsx: resolveSimUrl snapshots NEXT_PUBLIC_API_URL into a module-level
// const at import time, so it must be pinned before the import graph is evaluated. An origin that
// differs from every stored URL below is what makes the rebase assertion mean something.
const { API_ORIGIN } = vi.hoisted(() => {
  const origin = 'https://admin-under-test.invalid';
  process.env.NEXT_PUBLIC_API_URL = origin;
  return { API_ORIGIN: origin };
});

const { gallery } = vi.hoisted(() => ({ gallery: { items: [] as unknown[] } }));

// AdminShell pulls AdminNav, which needs an App Router context (usePathname) and initialises
// Firebase at import time. Neither is under test here; both are only ways for this file to fail for
// an unrelated reason.
vi.mock('../components/AdminShell', () => ({
  AdminShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('../lib/avatarAdminApi', () => ({
  getAvatarConfig: vi.fn(async () => ({
    anam_configured: true, anam_api_key: true, persona_einstein: true, persona_darwin: true,
    persona_napoleon: false, persona_archimedes: false, openai: true,
    default_character: 'einstein', characters: ['einstein'], byok_enabled: false,
  })),
  getAvatarStats: vi.fn(async () => ({
    total_visuals: 2, by_type: {}, by_scope: {}, by_source: {}, conversation_turns: 0, profiles: 0,
  })),
  getAvatarGallery: vi.fn(async () => ({
    items: gallery.items, total: gallery.items.length, page: 1, typeCounts: {},
  })),
  getAvatarConversations: vi.fn(async () => ({ sessions: [] })),
  deleteAvatarVisual: vi.fn(async () => ({ ok: true })),
  setAvatarByok: vi.fn(async () => ({ byok_enabled: false })),
  patchAvatarVisual: vi.fn(async () => ({ ok: true })),
}));

import AvatarAdminPage from '../app/avatar/page';
import { __resetDprSnapshotForTests } from 'shared/src/sim/simUrl';

const STORED_ORIGIN = 'https://api.flowvidco.com';
const STORED_SIM_URL = `${STORED_ORIGIN}/sim-public/simulations/proj/sec/boids/index.html?v=7`;
const DIAGRAM_HTML = '<svg><circle r="4"/></svg>';

function galleryItem(over: Record<string, unknown> = {}) {
  return {
    id: 'vis-1', project_id: 'proj-1', project_title: 'Proj', scope: 'extended', source: 'generated',
    character_id: 'einstein', visual_type: 'simulation', caption: 'a pendulum', alt_text: null,
    image_url: null, sim_entry_url: STORED_SIM_URL, visual_spec: null, use_count: 3,
    created_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

function frameTitled(title: string): HTMLIFrameElement {
  const el = document.querySelector<HTMLIFrameElement>(`iframe[title="${title}"]`);
  if (!el) throw new Error(`no <iframe title="${title}"> rendered`);
  return el;
}

beforeEach(() => {
  gallery.items = [];
  __resetDprSnapshotForTests();
  Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
});
afterEach(() => {
  cleanup();
  __resetDprSnapshotForTests();
});

describe('admin avatar gallery — stored simulation card', () => {
  it('rebases the stored sim URL onto this environment before framing it', async () => {
    gallery.items = [galleryItem()];
    render(<AvatarAdminPage />);
    await screen.findByText('a pendulum');

    const url = new URL(frameTitled('sim').src);
    // The stored URL carries the production API origin; framing that origin from anywhere else is
    // refused by frame-src and the card renders blank. This is the whole reason the card stopped
    // hand-rolling its own <iframe>.
    expect(url.origin).toBe(API_ORIGIN);
    expect(url.origin).not.toBe(STORED_ORIGIN);
    expect(url.pathname).toBe('/sim-public/simulations/proj/sec/boids/index.html');
    expect(url.hash).toContain('simboot=');
  });

  it('holds the frame inert and untabbable until it loads, then reveals it', async () => {
    gallery.items = [galleryItem()];
    render(<AvatarAdminPage />);
    await screen.findByText('a pendulum');

    const frame = frameTitled('sim');
    expect(frame.hasAttribute('inert')).toBe(true);
    expect(frame.getAttribute('aria-hidden')).toBe('true');
    expect(frame.getAttribute('tabindex')).toBe('-1');
    expect(frame.style.opacity).toBe('0');

    // `load` is the entire reveal gate for a passive preview, and it fires even for a document the
    // browser refused to render — so a blocked frame reveals its blank self instead of being
    // stranded invisible forever.
    fireEvent.load(frame);

    expect(frame.hasAttribute('inert')).toBe(false);
    expect(frame.hasAttribute('tabindex')).toBe(false);
    expect(frame.style.opacity).toBe('1');
  });

  it('gives the stored simulation a scripted, same-origin sandbox but no more', async () => {
    gallery.items = [galleryItem()];
    render(<AvatarAdminPage />);
    await screen.findByText('a pendulum');

    // The sim needs same-origin for its own storage/canvas work, but nothing beyond that: no
    // popups, no top-navigation, no downloads out of a preview thumbnail.
    expect(frameTitled('sim').getAttribute('sandbox')).toBe('allow-scripts allow-same-origin');
  });
});

describe('admin avatar gallery — inline diagram card', () => {
  it('never grants inline HTML allow-same-origin', async () => {
    gallery.items = [galleryItem({
      visual_type: 'diagram', sim_entry_url: null, visual_spec: { html: DIAGRAM_HTML }, caption: 'a diagram',
    })];
    render(<AvatarAdminPage />);
    await screen.findByText('a diagram');

    const frame = frameTitled('diagram');
    // srcDoc content is model-authored. Scripted + same-origin lets it delete its own sandbox
    // attribute and reload itself unsandboxed, inside the admin console's origin.
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(frame.getAttribute('srcdoc')).toBe(DIAGRAM_HTML);
    expect(frame.getAttribute('src')).toBeNull();
  });

  it('opens the reveal gate when the inline document loads', async () => {
    gallery.items = [galleryItem({
      visual_type: 'diagram', sim_entry_url: null, visual_spec: { html: DIAGRAM_HTML }, caption: 'a diagram',
    })];
    render(<AvatarAdminPage />);
    await screen.findByText('a diagram');

    // jsdom really navigates a srcdoc frame, so its `load` has already fired (or is one macrotask
    // away) by the time the card is queryable — the hidden window is not observable from here. The
    // component-level test pins the hidden state; what this pins is that the gate OPENS, because a
    // diagram wired to an onLoad nothing ever calls would sit blank forever.
    await waitFor(() => { expect(frameTitled('diagram').hasAttribute('inert')).toBe(false); });
    expect(frameTitled('diagram').style.opacity).toBe('1');
  });
});

describe('admin avatar gallery — every framed card', () => {
  it('never leaves a frame hidden-but-reachable, whatever the card type', async () => {
    // Swept rather than named: this is the assertion a NEW card type that hand-rolls its own
    // <iframe> has to walk past, and it fails without anyone remembering to extend this file.
    gallery.items = [
      galleryItem({ id: 'a', caption: 'a pendulum' }),
      galleryItem({ id: 'b', caption: 'a diagram', visual_type: 'diagram', sim_entry_url: null, visual_spec: { html: DIAGRAM_HTML } }),
    ];
    render(<AvatarAdminPage />);
    await screen.findByText('a pendulum');
    await screen.findByText('a diagram');
    await waitFor(() => { expect(frameTitled('diagram').hasAttribute('inert')).toBe(false); });

    const frames = Array.from(document.querySelectorAll('iframe'));
    expect(frames).toHaveLength(2);

    // jsdom loads the srcdoc frame but never the remote sim URL, so this fixture lands one frame in
    // each state on purpose. Asserted up front because a sweep with nothing hidden left to check
    // would pass for the wrong reason.
    expect(frames.filter((f) => f.style.opacity === '0')).toHaveLength(1);

    for (const frame of frames) {
      const hidden = frame.style.opacity === '0';
      expect(frame.hasAttribute('inert')).toBe(hidden);
      expect(frame.getAttribute('aria-hidden')).toBe(String(hidden));
      expect(frame.getAttribute('tabindex')).toBe(hidden ? '-1' : null);
      expect(frame.style.pointerEvents).toBe(hidden ? 'none' : 'auto');
      expect(frame.getAttribute('sandbox')).toBeTruthy();
    }
  });

  it('reveals each card independently — one loaded frame does not un-hide its neighbour', async () => {
    // Two SIMULATION cards: jsdom loads neither, so both reveal gates stay under this test's
    // control and the isolation is observable rather than raced.
    gallery.items = [
      galleryItem({ id: 'a', caption: 'first pendulum' }),
      galleryItem({ id: 'b', caption: 'second pendulum' }),
    ];
    render(<AvatarAdminPage />);
    await screen.findByText('first pendulum');
    await screen.findByText('second pendulum');

    const frames = Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe[title="sim"]'));
    expect(frames).toHaveLength(2);

    fireEvent.load(frames[0]);

    expect(frames[0].hasAttribute('inert')).toBe(false);
    expect(frames[1].hasAttribute('inert')).toBe(true);
  });
});
