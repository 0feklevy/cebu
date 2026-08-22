/**
 * security-016 — a user's uploaded source document must not live on a public prefix.
 *
 * `podcasts/` is public BY DESIGN: it is listed in `PUBLIC_LOCAL_PREFIXES` and the Supabase adapter
 * mints `/object/public/` URLs for anything under it. That was the right choice for immutable
 * studio clips and render masters, which are meant to be linkable.
 *
 * Source documents were added to the same prefix later without revisiting that. The consequence:
 * a confidential brief uploaded to an episode was readable by anyone who obtained the URL — no
 * credential, no expiry, and no way to tell it had happened. Production held one such document
 * when this was found.
 *
 * These assertions are about the RULE, not about a string: the prefix the routes build with must
 * not be one the serve layer treats as public.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PODCAST_SOURCE_PREFIX } from '../podcast.controller.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * The prefixes the local serve route hands out with no authentication.
 *
 * Read from `server.ts` rather than restated, so this test tracks the real list — the failure it
 * guards is somebody ADDING a prefix there, and a hand-copied list would not notice.
 */
function publicPrefixes(): string[] {
  const server = readFileSync(join(SRC, 'server.ts'), 'utf8');
  const m = /const PUBLIC_LOCAL_PREFIXES = \[([^\]]*)\]/.exec(server);
  if (!m) throw new Error('PUBLIC_LOCAL_PREFIXES not found in server.ts');
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

describe('podcast source documents are not public', () => {
  it('finds the public prefix list it is meant to be checking', () => {
    // Guards the parser: a regex that silently matched nothing would make every assertion below
    // vacuously true.
    const prefixes = publicPrefixes();
    expect(prefixes.length).toBeGreaterThan(3);
    expect(prefixes, 'the studio-clip prefix is still public, as intended').toContain('podcasts/');
  });

  it('does NOT put source documents under any public prefix', () => {
    const key = `${PODCAST_SOURCE_PREFIX}/show-1/episodes/ep-1/sources/123_brief.pdf`;
    for (const prefix of publicPrefixes()) {
      expect(key.startsWith(prefix), `source key must not fall under the public prefix "${prefix}"`)
        .toBe(false);
    }
  });

  it('is not under `podcasts/` — the specific mistake that was made', () => {
    expect(PODCAST_SOURCE_PREFIX.startsWith('podcasts/')).toBe(false);
    expect(`${PODCAST_SOURCE_PREFIX}/`.startsWith('podcasts/')).toBe(false);
  });

  it('deletes the private prefix when a show or episode is removed', () => {
    // A document that outlives the show that owned it is the same exposure with a longer fuse.
    const controller = readFileSync(join(SRC, 'controllers', 'v1', 'podcast.controller.ts'), 'utf8');
    const deletions = [...controller.matchAll(/deleteWithPrefixFallback\(`([^`]+)`\)/g)].map((m) => m[1]!);
    const privateDeletes = deletions.filter((d) => d.includes('PODCAST_SOURCE_PREFIX'));
    expect(privateDeletes.length, 'both the show and the episode delete paths must clear it')
      .toBeGreaterThanOrEqual(2);
  });
});
