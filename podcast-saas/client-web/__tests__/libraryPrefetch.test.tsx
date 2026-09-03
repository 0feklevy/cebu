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

import { LibraryMiniSite } from '../components/library/LibraryMiniSite';

afterEach(() => { cleanup(); document.head.querySelectorAll('link[rel="prefetch"]').forEach((l) => l.remove()); });

const SIM_URL = 'http://localhost:8080/sim-public/simulations/proj/pkg/index.html';
const view: LibraryView = {
  title: 'Chaos', direction: 'ltr', counts: { simulation: 1, image: 0, video: 0, audio: 0 },
  materials: [{ id: 'sim-1', type: 'simulation', name: 'Boids', url: SIM_URL, createdAt: '2026-01-01T00:00:00.000Z' } as LibraryMaterial],
  canonicalUrl: 'https://flowvidco.test/chaos/library', indexable: false,
};

describe('library prefetch', () => {
  it('prefetches exactly the frame’s resolved URL, once', () => {
    render(<LibraryMiniSite view={view} slug="chaos" activeType={null} />);
    const tile = screen.getByRole('button', { name: /Boids/ });
    fireEvent.pointerDown(tile);
    fireEvent.pointerDown(tile);
    const links = [...document.head.querySelectorAll('link[rel="prefetch"]')].map((l) => l.getAttribute('href'));
    expect(links).toEqual([resolveSimUrl(SIM_URL, { hideSelectors: [] })]);
    expect(links[0]).not.toBe(SIM_URL);
    expect(links[0]).toContain('dpr=');
  });
});
