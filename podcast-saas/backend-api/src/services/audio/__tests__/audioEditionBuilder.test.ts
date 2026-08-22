/**
 * The two things in the ffmpeg half that are worth testing without ffmpeg.
 *
 * Everything else in that module is an ffmpeg invocation, where the correct assertion is "the
 * file plays" and the honest way to check it is to run it. What IS testable here is the pair of
 * pure decisions embedded in it — how a path reaches the concat demuxer, and where the artifact
 * is stored — and both have a failure mode that a passing render would not reveal.
 */
import { describe, it, expect } from 'vitest';
import { concatListFile, editionStorageKey } from '../audioEditionBuilder.js';

const input = (localPath: string) => ({ localPath, label: localPath });

describe('the concat list, where quoting is the whole problem', () => {
  it('writes one directive per input, in order', () => {
    expect(concatListFile([input('/tmp/a.mp4'), input('/tmp/b.mp4')])).toBe(
      "file '/tmp/a.mp4'\nfile '/tmp/b.mp4'\n",
    );
  });

  it('escapes a quote in the path the way ffmpeg expects', () => {
    // A path can carry a quote — temp names derived from user-supplied titles do. Unescaped, it
    // terminates the demuxer's string early and the rest of the filename becomes directives:
    // either a parse error, or silently a shorter episode than the creator uploaded.
    //
    // ffmpeg's escape is `'\''` (close, escaped quote, reopen), not a backslash.
    expect(concatListFile([input("/tmp/it's here.mp4")])).toBe("file '/tmp/it'\\''s here.mp4'\n");
  });

  it('leaves spaces alone — the quotes already handle them', () => {
    expect(concatListFile([input('/tmp/my lesson.mp4')])).toBe("file '/tmp/my lesson.mp4'\n");
  });

  it('ends with a newline, because the demuxer ignores an unterminated last line', () => {
    // The failure mode is losing exactly the final segment, which reads as "the recording cut off"
    // rather than as a bug in a list file.
    expect(concatListFile([input('/a'), input('/b')]).endsWith("'\n")).toBe(true);
  });
});

describe('where an edition is stored', () => {
  it('lives under a PRIVATE prefix, never a public one', () => {
    // `podcasts/` is a PUBLIC prefix and would have been the convenient place for this. Putting
    // user content there is exactly what made a customer's uploaded brief world-readable
    // (security-016). A project's audio is public only when the project is, and that is decided
    // per request against the project's visibility — not by where the bytes happen to live.
    const key = editionStorageKey('proj-1', null, 'a'.repeat(64));
    expect(key.startsWith('editions/')).toBe(true);
    expect(key).not.toMatch(/^(podcasts|playlist-banners|thumbnails|images|audio|captions)\//);
  });

  it('puts the source hash IN the key, so a rebuild is a new object', () => {
    // Overwriting would leave every CDN and browser cache holding the old bytes under a URL that
    // now promises different audio — and the listener with the stale copy has no way to know.
    const a = editionStorageKey('proj-1', null, 'a'.repeat(64));
    const b = editionStorageKey('proj-1', null, 'b'.repeat(64));
    expect(a).not.toBe(b);
  });

  it('keeps each language separate', () => {
    // `/{slug}/audio` and `/{slug}/he/audio` are links a listener can hold at the same time.
    expect(editionStorageKey('p', null, 'x'.repeat(64))).not.toBe(editionStorageKey('p', 'he', 'x'.repeat(64)));
    expect(editionStorageKey('p', 'he', 'x'.repeat(64))).toContain('he-');
  });

  it('scopes by project, so one project cannot address another’s edition', () => {
    // The first two path segments are the media-token scope, so a key that did not lead with the
    // project id would mint tokens covering the wrong project's objects.
    expect(editionStorageKey('proj-1', null, 'x'.repeat(64)).split('/')[1]).toBe('proj-1');
  });
});
