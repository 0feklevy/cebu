/**
 * A LECTURE SHARED RIGHT AFTER UPLOAD MUST NOT FREEZE AT THE FIRST BOUNDARY.
 *
 * ViewerPage decided readiness with `segments.some(ready)` — per PROJECT — and tore down its
 * config poll in the same block. So a two-video lecture opened while video 2 was still
 * transcoding played video 1, froze on its last frame, and stayed there forever: the player
 * attaches nothing for a null URL and waits on a `canplay` that can never arrive, and the poll
 * that would have delivered video 2's URL was already gone.
 *
 * Found by a fresh-eyes hunt, not by the 330-finding audit — it only appears where the readiness
 * gate and the segment-swap state machine meet, which no single-domain reviewer could see.
 *
 * The decision is pinned as a pure predicate so it is testable without a browser; ViewerPage is
 * asserted to still contain it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(HERE, '../components/viewer/ViewerPage.tsx'), 'utf-8');
const SHARED_SRC = readFileSync(resolve(HERE, '../components/viewer/SharedViewerPage.tsx'), 'utf-8');

type Seg = { hls_status?: string | null; fallback_url?: string | null };

/** The shipped rule, mirrored: a segment is resolved when it can never change again. */
const isResolved = (s: Seg) => s.hls_status === 'ready' || s.hls_status === 'failed' || Boolean(s.fallback_url);
const playable = (segs: Seg[]) => segs.filter((s) => s.hls_status === 'ready' || s.fallback_url);
const pending = (segs: Seg[]) => segs.filter((s) => !isResolved(s));

describe('the viewer keeps polling while later segments are still transcoding', () => {
  const ready = { hls_status: 'ready', fallback_url: null };
  const processing = { hls_status: 'processing', fallback_url: null };
  const failed = { hls_status: 'failed', fallback_url: null };

  it('starts playback on the first ready segment', () => {
    expect(playable([ready, processing]).length).toBeGreaterThan(0);
  });

  it('does NOT stop polling while a later segment is still transcoding', () => {
    // This is the bug: the old gate stopped here, so video 2's URL never arrived.
    expect(pending([ready, processing])).toHaveLength(1);
  });

  it('stops polling once every segment has reached a terminal state', () => {
    expect(pending([ready, ready])).toHaveLength(0);
    expect(pending([ready, failed])).toHaveLength(0);      // a failed segment will not change
    expect(pending([ready, { hls_status: 'processing', fallback_url: 'https://cdn/x.mp4' }])).toHaveLength(0);
  });

  it('a single failed segment does not look like a healthy project', () => {
    // `every(failed)` was the only error path, so one bad video among good ones was invisible —
    // the lecture simply died at that video. It is now resolved (poll stops) but not playable,
    // which is what lets the player surface it rather than hang.
    const segs = [ready, failed];
    expect(segs.every((s) => s.hls_status === 'failed')).toBe(false);
    expect(playable(segs)).toHaveLength(1);
    expect(pending(segs)).toHaveLength(0);
  });

  it('ViewerPage still carries this rule', () => {
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    // The poll must be conditional on nothing being pending — not unconditional as before.
    expect(code).toMatch(/if \(pending\.length === 0\) stop\(\);/);
    // And readiness must no longer be a bare project-wide `some`.
    expect(code).not.toMatch(/const hasReady = data\.segments\.some/);
  });

  it('gives up LOUDLY when the time bound is reached, never silently', () => {
    // A first draft called `stop()` bare after PROCESSING_LIMIT_MS, which put a long transcode —
    // ordinary for a long video — straight back into the silent freeze this change removes.
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).toMatch(/PROCESSING_LIMIT_MS\) \{ setStalled\(true\); stop\(\); \}/);
  });

  it('SharedViewerPage carries the SAME rule — a shared link is how this bug is met', () => {
    // The two surfaces had diverged after only one was fixed, and the shared link is precisely
    // how a lecture gets watched while a later video is still transcoding.
    const code = SHARED_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).toMatch(/if \(pending\.length === 0\) stop\(\);/);
    expect(code).not.toMatch(/const hasReady\s*=\s*data\.segments\.some/);
  });
});
