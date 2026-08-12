/**
 * The name a corpus upload is STORED under, and why it is not the name the user typed.
 *
 * `corpora.storage_url` is a full public URL with NO shadow key column, so every reader —
 * `CorpusBuilder.ingest`'s presign, a duplication's copy plan — recovers the key by inverting that
 * URL. The inverse takes the remainder after the base VERBATIM (see `publicUrlKeys.ts`), which is
 * the only answer that cannot truncate a key. That leaves exactly one way to still get it wrong: a
 * filename that carries URL grammar into the key in the first place. This is the gate that closes
 * it, at the one place with enough information to close it — the mint site.
 */
import { describe, it, expect } from 'vitest';

import { corpusObjectName } from '../corpus.controller.js';
import { keyFromPublicUrlAgainst } from '../../../services/storage/publicUrlKeys.js';

const BASE = 'https://cdn.test';

/** What the upload handler builds, given a project and the name the browser sent. */
const keyFor = (filename: string): string => `projects/p1/corpus/1700000000000_${corpusObjectName(filename)}`;

describe('corpusObjectName', () => {
  it('strips the characters that would make the key ambiguous with URL grammar', () => {
    expect(corpusObjectName('what?.pdf')).toBe('what_.pdf');
    expect(corpusObjectName('draft#2.pdf')).toBe('draft_2.pdf');
    expect(corpusObjectName('a?b#c.pdf')).toBe('a_b_c.pdf');
  });

  it('keeps everything else, including spaces, ampersands and non-ASCII', () => {
    // The name is the user's, and object stores take all of this happily. Over-sanitising would
    // rename their file for no reason.
    expect(corpusObjectName('Q&A notes (final) v2.pdf')).toBe('Q&A notes (final) v2.pdf');
    expect(corpusObjectName('Фотосинтез.pdf')).toBe('Фотосинтез.pdf');
  });

  it('refuses to let a filename become a path, or escape one', () => {
    expect(corpusObjectName('../../etc/passwd')).toBe('passwd');
    expect(corpusObjectName('C:\\Users\\me\\report.pdf')).toBe('report.pdf');
    expect(corpusObjectName('.hidden')).toBe('hidden');
    expect(corpusObjectName('..')).toBe('upload');
  });

  it('always yields a non-empty, bounded leaf', () => {
    expect(corpusObjectName('')).toBe('upload');
    expect(corpusObjectName('   ')).toBe('upload');
    expect(corpusObjectName('a'.repeat(4000)).length).toBe(200);
  });

  it('mints a key that survives the public-URL round trip', () => {
    // THE PROPERTY THAT MATTERS. The upload returns `getPublicUrl(key)` and that URL is the only
    // pointer stored; ingestion presigns whatever `keyFromPublicUrl` gives back. If those two
    // disagree by a single character the object is unreachable, and the failure surfaces minutes
    // later as a failed ingest of a file that uploaded perfectly.
    for (const filename of ['paper.pdf', 'what?.pdf', 'draft#2.pdf', 'Q&A notes (final) v2.pdf']) {
      const key = keyFor(filename);
      expect(key).not.toMatch(/[?#]/);
      expect(keyFromPublicUrlAgainst(`${BASE}/${key}`, [BASE]), filename).toBe(key);
    }
  });
});
