/**
 * The EDITOR player releases its avatar-circle audio taps when it unmounts (frontend-001).
 *
 * `lib/avatarAudioGraph` keeps every tap in a module-level `Map` keyed by the <video> it tapped —
 * deliberately a Map and not a WeakMap, because `syncAvatarGains()` iterates it every frame. That
 * makes the map a strong reference: an entry that is never deleted pins its MediaElementSourceNode,
 * its GainNode and the detached <video> itself for the lifetime of the page.
 *
 * The VIEWER already pairs its taps (`useProjectPlayer`'s unmount cleanup calls
 * `releaseAvatarElement` on both elements — perf-006). The editor's player, which renders the same
 * `AvatarCirclesOverlay` over its own A/B pair, did not: `useEditorPlayback`'s cleanup destroys the
 * hls.js instances and nothing else. Every project switch inside the editor therefore left two more
 * permanently-connected source nodes on the one AudioContext the page is allowed. Browsers cap
 * AudioContexts (and the node graph they carry); enough switches and the tab's audio stops.
 *
 * The tap here is created by calling `ensureAvatarAnalyser` directly rather than by driving the
 * overlay's canvas rAF loop. That is the same state the overlay produces — the graph is keyed by
 * the element, not by who asked for it — and it keeps the assertion about the release contract
 * instead of about jsdom's canvas support.
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VideoPlayer } from '../components/VideoPlayer';

const CLIPS = [{ id: 'v1', hlsUrl: null, rawUrl: 'blob:v1', duration: 120 }];

/** Every MediaElementSourceNode the fake context has handed out, in creation order. */
let sources: FakeSource[] = [];
/** Every GainNode the fake context has handed out, in creation order. */
let gains: FakeNode[] = [];

class FakeNode {
  disconnects = 0;
  connect(): void { /* the graph shape is not what this file is about */ }
  disconnect(): void { this.disconnects += 1; }
}
class FakeSource extends FakeNode {
  constructor(readonly el: HTMLMediaElement) { super(); }
}
class FakeGain extends FakeNode {
  gain = { value: 1 };
}
class FakeAnalyser extends FakeNode {
  fftSize = 1024;
  smoothingTimeConstant = 0.7;
  frequencyBinCount = 512;
  getByteFrequencyData(): void { /* no spectrum needed */ }
  getByteTimeDomainData(): void { /* no waveform needed */ }
}
class FakeAudioContext {
  state = 'running';
  sampleRate = 48_000;
  destination = new FakeNode();
  createAnalyser() { return new FakeAnalyser(); }
  createGain() { const g = new FakeGain(); gains.push(g); return g; }
  createMediaElementSource(el: HTMLMediaElement) { const s = new FakeSource(el); sources.push(s); return s; }
  resume() { return Promise.resolve(); }
}

function videosIn(container: HTMLElement): HTMLVideoElement[] {
  // The A/B pair the playback engine owns, in JSX order. The b-roll overlay is a third <video> in
  // the same tree; the circles overlay is only ever handed videoARef/videoBRef, so only those two
  // are ever tapped.
  const all = Array.from(container.querySelectorAll('video'));
  expect(all.length).toBeGreaterThanOrEqual(2);
  return all.slice(0, 2);
}

beforeEach(() => {
  sources = [];
  gains = [];
  (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (window as unknown as { AudioContext?: unknown }).AudioContext;
});

describe('editor player — avatar-circle audio taps', () => {
  it('releases both tapped video elements when the player unmounts', async () => {
    // Imported lazily so the fake AudioContext is installed before the module's `unsupported`
    // latch can be tripped by an earlier probe.
    const { ensureAvatarAnalyser } = await import('../lib/avatarAudioGraph');

    const { container, unmount } = render(
      <VideoPlayer clips={CLIPS} timelineDuration={120} currentTime={0} onTimeUpdate={() => {}} />,
    );

    const [videoA, videoB] = videosIn(container);
    expect(videoA).toBeTruthy();
    expect(videoB).toBeTruthy();

    // This is what the overlay's rAF loop does on its first visible frame.
    expect(ensureAvatarAnalyser([videoA, videoB])).not.toBeNull();
    expect(sources.map((s) => s.el)).toEqual([videoA, videoB]);
    expect(sources.every((s) => s.disconnects === 0)).toBe(true);

    unmount();

    // Released ⇒ the graph dropped its edges AND its map entry. Without both, the detached
    // elements stay reachable from a module-level Map for the lifetime of the page.
    expect(sources.map((s) => s.disconnects > 0)).toEqual([true, true]);
    expect(gains.map((g) => g.disconnects > 0)).toEqual([true, true]);
  });

  it('does not re-tap an element the previous editor mount already released', async () => {
    const { ensureAvatarAnalyser } = await import('../lib/avatarAudioGraph');

    const first = render(
      <VideoPlayer clips={CLIPS} timelineDuration={120} currentTime={0} onTimeUpdate={() => {}} />,
    );
    const firstPair = videosIn(first.container);
    ensureAvatarAnalyser(firstPair);
    first.unmount();

    // A project switch inside the editor: same surface, brand-new elements.
    const second = render(
      <VideoPlayer clips={CLIPS} timelineDuration={120} currentTime={0} onTimeUpdate={() => {}} />,
    );
    const secondPair = videosIn(second.container);
    ensureAvatarAnalyser(secondPair);

    // Four taps total across two mounts, and the first two are gone. If the map still held the
    // first pair, those nodes would still be connected — which is the leak, one switch deep.
    expect(sources).toHaveLength(4);
    expect(sources.slice(0, 2).map((s) => s.disconnects > 0)).toEqual([true, true]);
    expect(sources.slice(2).map((s) => s.el)).toEqual(secondPair);

    second.unmount();
    expect(sources.map((s) => s.disconnects > 0)).toEqual([true, true, true, true]);
  });
});
