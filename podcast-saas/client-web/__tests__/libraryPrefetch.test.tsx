/**
 * The library's pointer-down prefetch names the URL the frame will actually request — the
 * resolved one, with the origin rebase and the `?dpr=` hint — not the bare stored URL. A prefetch
 * of the bare URL is a different HTTP cache key and was never reused (v0.3.0).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { LibraryMaterial, LibraryView } from 'shared/src/types/library-view';
import { resolveSimUrl } from '../lib/simUrl';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock('../lib/firebase', () => ({ auth: { currentUser: null } }));
// The hls.js warm-up is an intent signal, not a playback: the mock counts module evaluations —
// the module cache means a deduped fire-and-forget import evaluates the factory exactly once,
// no matter how many tiles are pressed.
const hlsLoads = vi.hoisted(() => ({ count: 0 }));
vi.mock('hls.js', () => {
  hlsLoads.count += 1;
  return { default: { isSupported: () => false } };
});

import { LibraryMiniSite } from '../components/library/LibraryMiniSite';

afterEach(() => { cleanup(); document.head.querySelectorAll('link[rel="prefetch"]').forEach((l) => l.remove()); });

const SIM_URL = 'http://localhost:8080/sim-public/simulations/proj/pkg/index.html';
const POSTER_URL = 'https://cdn.test/sim-poster/standard.png';
const view: LibraryView = {
  title: 'Chaos', direction: 'ltr', counts: { simulation: 1, image: 0, video: 0, audio: 0 },
  materials: [{ id: 'sim-1', type: 'simulation', name: 'Boids', url: SIM_URL, createdAt: '2026-01-01T00:00:00.000Z' } as LibraryMaterial],
  canonicalUrl: 'https://flowvidco.test/chaos/library', indexable: false,
};

const links = () => [...document.head.querySelectorAll('link[rel="prefetch"]')].map((l) => l.getAttribute('href'));

describe('library prefetch', () => {
  it('prefetches exactly the frame’s resolved URL, once', () => {
    render(<LibraryMiniSite view={view} slug="chaos" activeType={null} />);
    const tile = screen.getByRole('button', { name: /Boids/ });
    fireEvent.pointerDown(tile);
    fireEvent.pointerDown(tile);
    expect(links()).toEqual([resolveSimUrl(SIM_URL, { hideSelectors: [] })]);
    expect(links()[0]).not.toBe(SIM_URL);
    expect(links()[0]).toContain('dpr=');
  });

  it('a simulation with a stored poster also prefetches the standard rendition, as an image, once', () => {
    const withPoster: LibraryView = {
      ...view,
      materials: [{ ...view.materials[0], posterUrl: POSTER_URL } as LibraryMaterial],
    };
    render(<LibraryMiniSite view={withPoster} slug="chaos" activeType={null} />);
    const tile = screen.getByRole('button', { name: /Boids/ });
    fireEvent.pointerDown(tile);
    fireEvent.pointerDown(tile);
    // The overlay draws the STANDARD rendition while the sim attaches; the tile only ever loaded
    // the compact one, so this fetch is otherwise still ahead of the visitor when the overlay opens.
    expect(links()).toEqual([resolveSimUrl(SIM_URL, { hideSelectors: [] }), POSTER_URL]);
    const poster = document.head.querySelector(`link[href="${POSTER_URL}"]`);
    expect(poster?.getAttribute('as')).toBe('image');
  });

  it('pressing a video tile warms the hls.js chunk (fire-and-forget, deduped) and its poster', async () => {
    const videoView: LibraryView = {
      title: 'Chaos', direction: 'ltr', counts: { simulation: 0, image: 0, video: 1, audio: 0 },
      materials: [{ id: 'vid-1', type: 'video', name: 'intro.mp4', url: 'https://cdn.test/master.m3u8', posterUrl: POSTER_URL, createdAt: '2026-01-01T00:00:00.000Z' } as LibraryMaterial],
      canonicalUrl: 'https://flowvidco.test/chaos/library', indexable: false,
    };
    render(<LibraryMiniSite view={videoView} slug="chaos" activeType={null} />);
    const tile = screen.getByRole('button', { name: /intro\.mp4/ });
    fireEvent.pointerDown(tile);
    fireEvent.pointerDown(tile);
    await vi.dynamicImportSettled();   // let the fire-and-forget import land
    expect(hlsLoads.count).toBe(1);
    // No stream bytes move on a pointer press — only the chunk and the poster picture.
    expect(links()).toEqual([POSTER_URL]);
  });
});
