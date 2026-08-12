/**
 * `state.activeSimUrl` — the field two guards read and nothing ever cleared.
 *
 * THE DEFECT THIS PINS
 * `updateSimOverlay` writes `merge({ activeSimUrl: key })` on entry and NOTHING writes it back.
 * `deactivateSim` clears the REF beside it (`activeSimUrlRef`) and resets the whole layered
 * presentation, but the rendered copy was left holding the last simulation of the session for the
 * rest of it. `HLSPlayerShell`'s capability-floor guard —
 * `floorBlocked = !floor.runnable && state.activeSimUrl !== null` — therefore degenerated to
 * `!floor.runnable` after the first sim section: the half that answers "is a section actually up"
 * could no longer say no. It is masked today because `resetPresentation()` also clears
 * `simRequiresImportMaps`, so `floor.runnable` happens to be true whenever the guard is asked —
 * i.e. the guard is doing nothing, and the comment above it claims otherwise. A defence that is
 * only correct because a second, independent reset happens to fire first is not a defence.
 *
 * WHY THE HOOK DIRECTLY. The field has no other observable: it feeds the floor guard (masked, as
 * above) and `SimPoolOverlay`'s `activeKey`, whose only effect — `active && visible` — is already
 * false once the section is left. Rendering the hook is what makes the state itself assertable
 * rather than inferred from something it cannot currently change.
 */

import { useRef } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useProjectPlayer, type ProjectPlayerState } from '../components/viewer/useProjectPlayer';
import type { PlayerConfig } from '../components/viewer/types';

vi.mock('../lib/sim/SimRuntimeClient', () => {
  class FakeSimRuntimeClient {
    private state = {
      phase: 'mounting', documentKey: null, dynamic: true, ackCapable: null, ready: true,
      painted: true, currentScript: null, pendingScript: null, activationToken: 0, stopped: false,
      visible: false, muted: false, interactive: false, lastError: null,
    };
    getState() { return this.state; }
    modernActive() { return false; }
    getModernState() {
      return {
        active: false, documentState: 'READY', activationState: 'none',
        contextLost: false, failure: null, breakerOpen: false,
      };
    }
    attach() {}
    handleFrameLoad() {}
    activate() { this.state = { ...this.state, visible: true }; }
    deactivate() { this.state = { ...this.state, visible: false }; }
    enableModern() {}
    freeze() {}
    thaw() {}
    mute() {}
    unmute() {}
    hide() {}
    suspend() {}
    resume() {}
    relayout() {}
    setGuidance() {}
    pauseAutomation() {}
    resumeAutomation() {}
    stopNow() {}
    startPaintRecovery() {}
    markPaintedByPolicy() {}
    cancelPendingApply() {}
    cancelDeferredStop() {}
    hasDeferredStop() { return false; }
    setPackageAckCapable() {}
    isHoldingApply() { return false; }
    evict() { return Promise.resolve({ outcome: 'no-document', counts: null, leaked: [], waitedMs: 0 }); }
    cancelEviction() { return false; }
    isEvicting() { return false; }
    evictionPhase() { return 'none'; }
    present() {}
    retryModern() { return false; }
    setQuality() {}
    dispose() {}
  }
  return { SimRuntimeClient: FakeSimRuntimeClient };
});

vi.mock('hls.js', () => ({ default: { isSupported: () => false, Events: { ERROR: 'hlsError' } } }));
vi.mock('firebase/auth', () => ({ getAuth: () => ({ currentUser: null }) }));

// ── the harness ───────────────────────────────────────────────────────────────────────────────
// Every ref `useProjectPlayer` declares, backed by a real element, exactly as `HLSPlayerShell`
// supplies them. Nothing about the player is stubbed — this is the shipping hook.

const latest: {
  state: ProjectPlayerState | null;
  /** The player's own controls, so the explicit "go back to video" can be exercised. */
  resumeFromSim: (() => void) | null;
} = { state: null, resumeFromSim: null };

function Harness({ config }: { config: PlayerConfig }) {
  const videoA = useRef<HTMLVideoElement | null>(null);
  const videoB = useRef<HTMLVideoElement | null>(null);
  const videoBroll = useRef<HTMLVideoElement | null>(null);
  const videoBrollStandby = useRef<HTMLVideoElement | null>(null);
  const tapFeedback = useRef<HTMLDivElement | null>(null);
  const progressFill = useRef<HTMLDivElement | null>(null);
  const progressThumb = useRef<HTMLDivElement | null>(null);
  const progressBuf = useRef<HTMLDivElement | null>(null);
  const progressTrack = useRef<HTMLDivElement | null>(null);
  const progressWrap = useRef<HTMLDivElement | null>(null);
  const curTime = useRef<HTMLSpanElement | null>(null);
  const totTime = useRef<HTMLSpanElement | null>(null);
  const root = useRef<HTMLDivElement | null>(null);

  const { state, actions } = useProjectPlayer(config, {
    videoA, videoB, videoBroll, videoBrollStandby, tapFeedback,
    progressFill, progressThumb, progressBuf, progressTrack, progressWrap,
    curTime, totTime, root,
  });
  latest.state = state;
  latest.resumeFromSim = actions.resumeFromSim;

  return (
    <div ref={root}>
      <video data-testid="a" ref={videoA} />
      <video ref={videoB} />
      <video ref={videoBroll} />
      <video ref={videoBrollStandby} />
      <div ref={tapFeedback} />
      <div ref={progressWrap}><div ref={progressTrack}><div ref={progressBuf} /><div ref={progressFill} /><div ref={progressThumb} /></div></div>
      <span ref={curTime} /><span ref={totTime} />
    </div>
  );
}

const SIM_A = 'https://sims.example.com/pkg-a/index.html?section=a1&v=aaaa';
const SIM_B = 'https://sims.example.com/pkg-b/index.html?section=b1&v=bbbb';

function config(over: Partial<PlayerConfig> = {}): PlayerConfig {
  return {
    project_id: 'proj-1',
    title: 'T',
    description: null,
    thumbnail_url: null,
    ...over,
    segments: [{
      id: 'vid-1',
      label: 'v.mp4',
      duration_sec: 60,
      hls_url: 'https://cdn.example.com/hls/master.m3u8',
      fallback_url: 'https://cdn.example.com/hls/master.m3u8',
      hls_status: 'ready',
      captions: { status: 'ready', vtt_url: null },
      simulations: [
        {
          id: 'sec-a', start_sec: 0, end_sec: 5, simulation_url: SIM_A, simulation_id: 'sim-a',
          package_revision: 'rev-a', package_class: null, sim_script: 'main',
          simple_ui: false, auto_script: true, label: 'A', type: 'simulation',
        },
        {
          id: 'sec-b', start_sec: 20, end_sec: 25, simulation_url: SIM_B, simulation_id: 'sim-b',
          package_revision: 'rev-b', package_class: null, sim_script: 'main',
          simple_ui: false, auto_script: true, label: 'B', type: 'simulation',
        },
      ],
    }],
    broll_clips: [],
  } as unknown as PlayerConfig;
}

/**
 * A POST-ROLL simulation: it starts at the segment's end, so the player pauses the video and offers
 * "go back to video" — the explicit exit, which is `resumeFromSim` rather than the boundary tick.
 */
function postRollConfig(): PlayerConfig {
  return {
    project_id: 'proj-1',
    title: 'T',
    description: null,
    thumbnail_url: null,
    sim_transition_coordinator: true,
    segments: [{
      id: 'vid-1',
      label: 'v.mp4',
      duration_sec: 5,
      hls_url: 'https://cdn.example.com/hls/master.m3u8',
      fallback_url: 'https://cdn.example.com/hls/master.m3u8',
      hls_status: 'ready',
      captions: { status: 'ready', vtt_url: null },
      simulations: [{
        id: 'sec-a', start_sec: 5, end_sec: 15, simulation_url: SIM_A, simulation_id: 'sim-a',
        package_revision: 'rev-a', package_class: null, sim_script: 'main',
        simple_ui: false, auto_script: true, label: 'A', type: 'simulation',
      }],
    }],
    broll_clips: [],
  } as unknown as PlayerConfig;
}

async function seekTo(video: HTMLVideoElement, t: number) {
  Object.defineProperty(video, 'currentTime', { configurable: true, get: () => t, set: () => {} });
  await act(async () => { video.dispatchEvent(new Event('timeupdate')); });
}

// ── a hand-stepped animation clock + frame pipeline, for the coordinated exit ──────────────────
// The coordinator's parent-paint gate runs on rAF and its evidence arrives through
// `requestVideoFrameCallback`; jsdom has neither under the test's control. Owning both is what
// makes "the key is still held" a statement about the handoff rather than about timing.

let rafQueue: Array<{ id: number; cb: FrameRequestCallback }> = [];
let rafId = 1;
const realRaf = globalThis.requestAnimationFrame;
const realCancelRaf = globalThis.cancelAnimationFrame;

async function frames(n = 1): Promise<void> {
  for (let i = 0; i < n; i++) {
    const due = rafQueue;
    rafQueue = [];
    await act(async () => { for (const { cb } of due) cb(performance.now()); });
  }
}

/** Give an element a controllable `requestVideoFrameCallback`, as a real browser would have. */
function installRvfc(video: HTMLVideoElement) {
  let next = 1;
  const cbs = new Map<number, (now: number, meta: { mediaTime: number }) => void>();
  Object.defineProperty(video, 'requestVideoFrameCallback', {
    configurable: true,
    value: (cb: (now: number, meta: { mediaTime: number }) => void) => { const id = next++; cbs.set(id, cb); return id; },
  });
  Object.defineProperty(video, 'cancelVideoFrameCallback', {
    configurable: true,
    value: (id: number) => { cbs.delete(id); },
  });
  return {
    async present(mediaTime: number) {
      const entry = [...cbs.entries()][0];
      if (!entry) return false;
      cbs.delete(entry[0]);
      await act(async () => { entry[1](performance.now(), { mediaTime }); });
      return true;
    },
    pending: () => cbs.size,
  };
}

beforeEach(() => {
  latest.state = null;
  latest.resumeFromSim = null;
  rafQueue = [];
  rafId = 1;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    const id = rafId++;
    rafQueue.push({ id, cb });
    return id;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) => { rafQueue = rafQueue.filter((f) => f.id !== id); }) as typeof cancelAnimationFrame;
  if (!window.localStorage) {
    const store = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, String(v)); },
        removeItem: (k: string) => { store.delete(k); },
        clear: () => store.clear(),
      },
    });
  }
});

afterEach(() => {
  cleanup();
  globalThis.requestAnimationFrame = realRaf;
  globalThis.cancelAnimationFrame = realCancelRaf;
});

describe('the rendered active-simulation key', () => {
  it('is set on entry and cleared again when the section is left', async () => {
    const view = render(<Harness config={config()} />);
    await act(async () => { await Promise.resolve(); });
    const video = view.getByTestId('a') as HTMLVideoElement;

    await seekTo(video, 1);
    expect(latest.state!.activeSimUrl, 'the section never activated — this proves nothing').not.toBeNull();

    // Out into plain video. The ref beside it is cleared here; so must the rendered copy be.
    await seekTo(video, 10);
    expect(
      latest.state!.activeSimUrl,
      'the last simulation of the session stayed "active" for the rest of it',
    ).toBeNull();
  });

  it('names the CURRENT package across a second section, and clears again after it', async () => {
    const view = render(<Harness config={config()} />);
    await act(async () => { await Promise.resolve(); });
    const video = view.getByTestId('a') as HTMLVideoElement;

    await seekTo(video, 1);
    const first = latest.state!.activeSimUrl;
    await seekTo(video, 10);
    expect(latest.state!.activeSimUrl).toBeNull();

    await seekTo(video, 21);
    expect(latest.state!.activeSimUrl, 'the second section did not take ownership').not.toBeNull();
    expect(latest.state!.activeSimUrl, 'it is still reporting the FIRST package').not.toBe(first);

    await seekTo(video, 30);
    expect(latest.state!.activeSimUrl).toBeNull();
  });

  it('stays null across the ticks that follow — the clear is idempotent', async () => {
    // `deactivateSim` runs on EVERY tick that is not inside a sim section, so this write happens
    // several times a second for the length of the video. It must be inert once there is nothing
    // to clear, and it must not oscillate.
    const view = render(<Harness config={config()} />);
    await act(async () => { await Promise.resolve(); });
    const video = view.getByTestId('a') as HTMLVideoElement;

    await seekTo(video, 1);
    await seekTo(video, 10);
    for (const t of [11, 12, 13, 14]) {
      await seekTo(video, t);
      expect(latest.state!.activeSimUrl, `a later tick at ${t}s put the key back`).toBeNull();
    }
  });
});

/**
 * …AND THE CLEAR IS NOT UNCONDITIONAL. (The regression the fix above introduced.)
 *
 * `state.activeSimUrl` is `SimPoolOverlay`'s `activeKey`, and a resident frame is composited on
 * `spec.key === activeKey && visible`. Under `sim_transition_coordinator` the frozen frame IS the
 * cover the coordinator holds while it waits for evidence that the incoming video frame reached the
 * compositor — so releasing the key on the boundary tick fades that cover out in 200 ms at T0, while
 * the coordinator still believes it is holding and has committed nothing.
 *
 * The release therefore belongs to the exit's `uncover`, which runs from COMMIT_REVEAL and nowhere
 * else. `simExitHandoff.test.tsx` asserts the same rule where the user meets it — the pool frame's
 * own opacity through a whole handoff; these two assert the field itself, which is the thing that
 * has to be held and then let go.
 */
describe('the rendered active-simulation key, under the transition coordinator', () => {
  /** Enter section A, then cross its end — the automatic exit, with the coordinator owning it. */
  async function exitUnderCoordinator() {
    const view = render(<Harness config={config({ sim_transition_coordinator: true } as Partial<PlayerConfig>)} />);
    await act(async () => { await Promise.resolve(); });
    const video = view.getByTestId('a') as HTMLVideoElement;
    const pipeline = installRvfc(video);

    await seekTo(video, 1);
    expect(latest.state!.activeSimUrl, 'the section never activated — this proves nothing').not.toBeNull();

    await seekTo(video, 10);
    return { video, pipeline };
  }

  it('is HELD across the boundary while the handoff waits for its frame', async () => {
    const { pipeline } = await exitUnderCoordinator();

    expect(
      latest.state!.activeSimUrl,
      'the cover the coordinator is holding was released at T0',
    ).not.toBeNull();
    expect(pipeline.pending(), 'no handoff is in flight — this proves nothing').toBe(1);
  });

  it('is released by the commit, on the proven frame', async () => {
    // The other half: the hold is a deferral, not a leak. Asserted BEFORE any further tick, because
    // the next tick outside a sim section would clear the key anyway — and a release that depends
    // on the clock still running is not a release the commit owns.
    const { pipeline } = await exitUnderCoordinator();

    await pipeline.present(10);
    await frames(2);

    expect(
      latest.state!.activeSimUrl,
      'the commit ran but the rendered key outlived it',
    ).toBeNull();
  });

  it('the explicit return holds it too, and releases it on ITS commit', async () => {
    // `resumeFromSim` is the other coordinated exit, and it has its own `commit` — the pristine
    // reload / stopScript body. Its `issueSeek` re-enters `deactivateSim` while the handoff is in
    // flight, so the same two rules have to hold on a completely separate code path.
    const view = render(<Harness config={postRollConfig()} />);
    await act(async () => { await Promise.resolve(); });
    const video = view.getByTestId('a') as HTMLVideoElement;
    Object.defineProperty(video, 'play', { configurable: true, value: () => Promise.resolve() });
    Object.defineProperty(video, 'pause', { configurable: true, value: () => {} });
    const pipeline = installRvfc(video);

    await seekTo(video, 5);
    expect(latest.state!.activeSimUrl, 'the post-roll section never activated').not.toBeNull();
    expect(latest.state!.resumeAction, 'this is not the explicit-return path').toBe('backToVideo');

    await act(async () => { latest.resumeFromSim!(); });
    expect(
      latest.state!.activeSimUrl,
      'the return dropped the cover on the click, before the seek had proven anything',
    ).not.toBeNull();

    await pipeline.present(0);
    await frames(2);
    expect(latest.state!.activeSimUrl, 'the return committed but never released the key').toBeNull();
  });
});
