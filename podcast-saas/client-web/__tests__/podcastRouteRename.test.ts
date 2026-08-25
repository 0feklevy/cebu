/**
 * The `/podcasts` → `/edit-podcasts` move (P3-A), and the three shims that keep old links alive.
 *
 * ── WHY THIS IS A TEST AND NOT A COMMENT ──────────────────────────────────────────────────────
 * A redirect shim is a file that appears to do nothing. It has no UI, no logic worth reading, and
 * a 167-byte bundle — which makes it exactly the sort of thing a later tidy-up deletes as dead
 * code. What it actually holds up is every podcast-editor link anyone has ever shared, including
 * deep ones like `/podcasts/{showId}/episodes/{episodeId}`.
 *
 * The reservation matters just as much and is even less visible: `podcasts` stays in
 * RESERVED_SLUGS after the move, because releasing it would let a creator claim the exact URL
 * those old links point at — turning a redirect into somebody else's page.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PERMALINK = join(ROOT, '..', 'backend-api', 'src', 'services', 'permalinkService.ts');

const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const LEGACY = [
  'app/podcasts/page.tsx',
  'app/podcasts/[showId]/page.tsx',
  'app/podcasts/[showId]/episodes/[episodeId]/page.tsx',
];
const MOVED = [
  'app/edit-podcasts/page.tsx',
  'app/edit-podcasts/[showId]/page.tsx',
  'app/edit-podcasts/[showId]/episodes/[episodeId]/page.tsx',
];

describe('the editor lives at its new address', () => {
  it('every page moved', () => {
    for (const f of MOVED) expect(existsSync(join(ROOT, f)), f).toBe(true);
  });

  it('the moved pages are the REAL editor, not more redirects', () => {
    // A move that redirected to itself would satisfy "the files exist" and serve nothing.
    for (const f of MOVED) {
      expect(read(f), `${f} is a redirect, not the editor`).not.toContain('permanentRedirect');
    }
  });
});

describe('every old link still lands on its exact destination', () => {
  it('all three legacy paths still exist as shims', () => {
    // Deleting one of these silently breaks a class of shared link — the index, a show, or an
    // episode — and nothing else in the build would notice.
    for (const f of LEGACY) expect(existsSync(join(ROOT, f)), `${f} — a shared link class just died`).toBe(true);
  });

  it('each is a PERMANENT redirect (308), not a rewrite or a temporary one', () => {
    // The old path is a former address, not an alias. Saying so is what eventually retires it
    // from crawlers and browser histories.
    for (const f of LEGACY) {
      expect(read(f), f).toContain('permanentRedirect');
      expect(read(f), `${f} uses a temporary redirect`).not.toMatch(/\bredirect\(/);
    }
  });

  it('carries the ids through, so a deep link lands on the EPISODE and not the index', () => {
    // The failure that would look like it works: redirecting every old URL to /edit-podcasts.
    // Somebody following a link to one episode would arrive at a list and assume it was deleted.
    const show = read(LEGACY[1]);
    expect(show).toContain('${showId}');
    const ep = read(LEGACY[2]);
    expect(ep).toContain('${showId}');
    expect(ep).toContain('${episodeId}');
    expect(ep).toContain('/episodes/');
  });

  it('points at the new tree, never back at itself', () => {
    // A shim redirecting to its own path is an infinite loop that only shows up in a browser.
    for (const f of LEGACY) {
      const body = read(f);
      const target = /permanentRedirect\(([^)]*)\)/.exec(body)?.[1] ?? '';
      expect(target, f).toContain('/edit-podcasts');
      expect(target.replace('/edit-podcasts', ''), `${f} redirects to itself`).not.toContain('/podcasts');
    }
  });
});

describe('the slug registry', () => {
  const registry = readFileSync(PERMALINK, 'utf8');

  it('reserves the NEW name, so no creator can shadow the editor', () => {
    expect(registry).toContain("'edit-podcasts'");
  });

  it('KEEPS the old name reserved after the move', () => {
    // The subtle one. Releasing `podcasts` would let a creator claim the exact URL every
    // previously-shared editor link points at, turning a redirect into their page.
    expect(registry, 'releasing `podcasts` would hand old links to a creator').toContain("'podcasts'");
  });
});

describe('nothing still links to the old path', () => {
  it('no component or page href points at /podcasts', () => {
    // A live link to a redirect works, and costs every user an extra round trip forever.
    const files = [
      'components/HomeSidebar.tsx',
      'components/podcast/PodcastShowPage.tsx',
      'components/podcast/PodcastEpisodePage.tsx',
      'components/podcast/PodcastShowsPage.tsx',
    ];
    for (const f of files) {
      const body = read(f).replace(/edit-podcasts/g, '');
      expect(body, `${f} still links to the old path`).not.toMatch(/["'`]\/podcasts/);
    }
  });
});
