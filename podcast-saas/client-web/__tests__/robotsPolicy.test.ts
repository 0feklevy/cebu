/**
 * What crawlers are told, and the one rule that keeps the list honest.
 *
 * ── WHY A TEST FOR A TEXT FILE ────────────────────────────────────────────────────────────────
 * robots.txt has no types, no imports and no build error to catch a missing line. Its entries
 * decay by OMISSION: a new authenticated surface ships, nobody remembers this file, and the
 * editor is crawlable for a year before anyone notices. That is exactly how the podcast editor
 * came to be the only one of three editor trees without a Disallow — found on 2026-08-25 while
 * renaming it, not by anything failing.
 *
 * So the rule this file enforces is not "these strings are present" but "every EDITOR tree is
 * disallowed", stated as a list somebody must consciously extend.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'robots.txt', 'route.ts'),
  'utf8',
);

/** Every route tree that is an authenticated editing surface rather than a public page. */
const EDITOR_TREES = ['/projects/', '/playlists/', '/edit-podcasts/'];

describe('the crawl policy', () => {
  it('disallows EVERY editor tree, not merely the ones somebody remembered', () => {
    // The assertion the podcast editor's year of exposure would have failed.
    for (const tree of EDITOR_TREES) {
      expect(SOURCE, `${tree} is an editing surface and is crawlable`).toContain(`'Disallow: ${tree}'`);
    }
  });

  it('disallows the LEGACY podcast tree too, which now serves redirects', () => {
    // A crawler following those spends a round trip to be told what robots could have said for
    // free — and every target is disallowed anyway.
    expect(SOURCE).toContain("'Disallow: /podcasts/'");
  });

  it('keeps the public course path ALLOWED — the policy must not become a blanket ban', () => {
    // A test that only checks for Disallow lines is satisfied by disallowing everything, which
    // would quietly delete the product from search.
    expect(SOURCE).toContain("'Allow: /c/'");
  });

  it('still shields the token viewers and the API', () => {
    for (const p of ['/v/', '/pl/', '/api/']) {
      expect(SOURCE, p).toContain(`'Disallow: ${p}'`);
    }
  });

  it('still emits a sitemap reference — robots is also how the sitemap is found', () => {
    expect(SOURCE).toMatch(/Sitemap: \$\{base\}\/sitemap\.xml/);
  });
});
