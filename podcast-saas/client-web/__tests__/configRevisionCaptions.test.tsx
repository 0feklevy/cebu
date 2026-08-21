/**
 * D-13 — the regression that blocked the obvious fix, pinned through the REAL player shell.
 *
 * "Just keep the config poll alive" is about six lines, and it has a verified regression behind
 * it: `HLSPlayerShell` resets caption state on `config.segments` IDENTITY —
 *
 *     useEffect(() => { setCaptionState(...); setCaptionCues({}); setCaptionsEnabled(false); },
 *               [config.project_id, config.segments]);
 *
 * — so re-`setConfig`ing every tick turns the viewer's captions off once a minute. And because a
 * poll only produces a *different* payload when the creator actually corrects something, the
 * captions would go out at precisely the moment the correction arrived: the fix and the new bug
 * fire on the same tick.
 *
 * `applyConfigRevision` is what prevents it, and the CONTROL at the bottom of this file is what
 * proves these assertions are not vacuous: the same corrected payload applied the naive way does
 * wipe the captions, right here, in this suite.
 */
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HLSPlayerShell } from '../components/viewer/HLSPlayerShell';
import { applyConfigRevision } from '../components/viewer/configRevision';
import type { PlayerConfig } from '../components/viewer/types';

const h = vi.hoisted(() => {
  class FakeHls {
    static instances: FakeHls[] = [];
    static isSupported = () => true;
    static Events = { ERROR: 'hlsError', MANIFEST_PARSED: 'hlsManifestParsed' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    config: any;
    url: string | null = null;
    media: HTMLMediaElement | null = null;
    destroyed = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handlers = new Map<string, any[]>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(cfg: any) { this.config = { ...cfg }; FakeHls.instances.push(this); }
    loadSource(u: string) { this.url = u; }
    attachMedia(el: HTMLMediaElement) { this.media = el; }
    detachMedia() { this.media = null; }
    stopLoad() {}
    startLoad() {}
    destroy() { this.destroyed = true; }
    recoverMediaError() {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(ev: string, fn: any) { this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), fn]); }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    off(ev: string, fn: any) { this.handlers.set(ev, (this.handlers.get(ev) ?? []).filter((f) => f !== fn)); }
  }
  return { FakeHls };
});

vi.mock('hls.js', () => ({ default: h.FakeHls }));
vi.mock('firebase/auth', () => ({ getAuth: () => ({ currentUser: null }) }));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

const VTT = 'WEBVTT\n\n00:00:00.000 --> 00:00:30.000\nHello, world.\n';

const CLIP = {
  id: 'b1', hls_url: 'https://cdn.example.com/broll/b1.m3u8',
  global_offset_sec: 20, start_sec: 0, end_sec: 10, label: null, broll_volume: 1,
};
/** The creator moved the clip AND re-cut it, so both halves of the correction are observable. */
const CLIP_MOVED = {
  ...CLIP,
  global_offset_sec: 40,
  hls_url: 'https://cdn.example.com/broll/b1-corrected.m3u8',
};

const V1: PlayerConfig = {
  project_id: 'proj-1',
  title: 'A lecture',
  description: null,
  thumbnail_url: null,
  segments: [{
    id: 'vid-1',
    label: 'v.mp4',
    duration_sec: 120,
    hls_url: 'https://cdn.example.com/hls/master.m3u8',
    fallback_url: 'https://cdn.example.com/hls/fallback.mp4',
    hls_status: 'ready',
    captions: { status: 'ready', vtt_url: 'https://cdn.example.com/captions/vid-1.vtt' },
    simulations: [],
  }],
  broll_clips: [CLIP],
} as unknown as PlayerConfig;

/** Exactly what a poll produces: a structurally fresh object with one clip moved. */
const CORRECTED: PlayerConfig = JSON.parse(JSON.stringify({ ...V1, broll_clips: [CLIP_MOVED] }));

class FakeAudio {
  src: string;
  volume = 1; muted = false; currentTime = 0; paused = true;
  constructor(src?: string) { this.src = src ?? ''; }
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
}

beforeEach(() => {
  h.FakeHls.instances.length = 0;
  Object.defineProperty(window, 'Audio', { configurable: true, writable: true, value: FakeAudio });
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, status: 200,
    text: async () => VTT,
    json: async () => ({ segments: [] }),
  }) as unknown as Response));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mountWithCaptionsOn() {
  const view = render(<HLSPlayerShell config={V1} />);
  view.container.querySelectorAll('video').forEach((v) => {
    Object.defineProperty(v, 'play', { configurable: true, value: () => Promise.resolve() });
    Object.defineProperty(v, 'pause', { configurable: true, value: () => {} });
  });
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });

  const cc = view.getByLabelText('Closed captions');
  await act(async () => { fireEvent.click(cc); });
  expect(view.getByLabelText('Closed captions').getAttribute('aria-pressed')).toBe('true');

  const publish = async (next: PlayerConfig) => {
    await act(async () => { view.rerender(<HLSPlayerShell config={next} />); });
  };
  const captionsOn = () =>
    view.getByLabelText('Closed captions').getAttribute('aria-pressed') === 'true';

  return { ...view, publish, captionsOn };
}

describe('an editorial correction must not cost the viewer their captions', () => {
  it('keeps captions ON when the revision is applied through applyConfigRevision', async () => {
    const { publish, captionsOn } = await mountWithCaptionsOn();
    await publish(applyConfigRevision(V1, CORRECTED));
    expect(captionsOn()).toBe(true);
  });

  it('keeps them on across a whole hour of unchanged re-polls', async () => {
    // A 60-minute lecture is ~60 ticks. Each one returns a structurally fresh object off the
    // wire; each one must be a no-op.
    const { publish, captionsOn } = await mountWithCaptionsOn();
    let current = V1;
    for (let i = 0; i < 60; i += 1) {
      const refetched = JSON.parse(JSON.stringify(current)) as PlayerConfig;
      current = applyConfigRevision(current, refetched);
      await publish(current);
    }
    expect(current).toBe(V1);           // identity preserved end to end
    expect(captionsOn()).toBe(true);
  });

  it('still delivers the correction to the player — the captions surviving is not the only claim', async () => {
    const { publish, container } = await mountWithCaptionsOn();
    const revision = applyConfigRevision(V1, CORRECTED);
    expect(revision.broll_clips[0].global_offset_sec).toBe(40);

    await publish(revision);
    const videos = [...container.querySelectorAll('video')] as HTMLVideoElement[];
    const mainVideo = videos[0];
    // The live b-roll slot; the standby sits behind it at z-index -1 (see useProjectPlayer).
    const liveSlot = videos.slice(2).find((v) => v.style.zIndex === '8')!;
    const liveUrlOn = (el: HTMLMediaElement) =>
      h.FakeHls.instances.find((i) => i.media === el && !i.destroyed)?.url ?? null;

    const tickAt = async (gt: number) => {
      Object.defineProperty(mainVideo, 'currentTime', { configurable: true, get: () => gt });
      await act(async () => { mainVideo.dispatchEvent(new Event('timeupdate')); });
    };

    // t=21 is where the clip used to sit. Under the correction nothing belongs on screen here,
    // and a player still reading its mount-time config would be playing b-roll.
    await tickAt(21);
    expect(liveUrlOn(liveSlot)).toBeNull();

    // t=41 is where the creator moved it to, with the re-cut media.
    await tickAt(41);
    expect(liveUrlOn(liveSlot)).toBe(CLIP_MOVED.hls_url);
  });

  /**
   * THE CONTROL. Without it every assertion above could pass on a shell that never resets caption
   * state at all, and the test would be describing a bug that had quietly been fixed elsewhere.
   */
  it('CONTROL: the naive setConfig(await r.json()) does wipe them, right here', async () => {
    const { publish, captionsOn } = await mountWithCaptionsOn();
    await publish(CORRECTED);
    expect(captionsOn()).toBe(false);
  });
});
