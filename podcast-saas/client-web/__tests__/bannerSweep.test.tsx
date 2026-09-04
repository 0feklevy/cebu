/**
 * The editor's banner sweep: one simulation at a time, only the ones without a banner, a forced
 * pass covers all, a document that cannot draw is counted and never retried.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Simulation } from 'shared/src/generated/client-v1';

const calls = vi.hoisted(() => ({
  upload: [] as Array<{ simId: string; force: boolean | undefined }>,
  connect: 0,
  failFor: new Set<string>(),
  snapshotFor: null as string | null,
}));

vi.mock('@/lib/api', () => ({
  api: {
    uploadSimulationPoster: async (_projectId: string, simId: string, body: { force?: boolean }) => {
      calls.upload.push({ simId, force: body.force });
      return { outcome: 'stored', identity: 'id', aspectProfile: 'wide' };
    },
  },
}));
vi.mock('@/lib/sim/SimAuthoringClient', () => ({
  connectSimAuthoring: async (iframe: HTMLIFrameElement) => {
    calls.connect += 1;
    const src = iframe.getAttribute('data-sim');
    return {
      snapshot: async () => {
        if (src && calls.failFor.has(src)) throw new Error('cannot draw');
        return { dataUrl: 'data:image/png;base64,AAAA', width: 640, height: 360 };
      },
      dispose: () => {},
    };
  },
}));
vi.mock('@/lib/posterCapture', async (importOriginal) => ({
  // The real module's other exports (POSTER_LETTERBOX_BG among them) stay real — the sweep
  // passes the letterbox colour through explicitly, and a mock that hides the constant fails
  // every import before a single capture runs.
  ...(await importOriginal<typeof import('@/lib/posterCapture')>()),
  renderPosterRenditions: async () => [
    { size: 'standard', width: 1280, height: 720, dataUrl: 'data:image/png;base64,AAAA' },
    { size: 'compact', width: 640, height: 360, dataUrl: 'data:image/png;base64,AAAA' },
  ],
}));

import { useBannerSweep, __resetBannerSweepForTests, bannersNeeded } from '../components/useBannerSweep';

const sim = (id: string, poster: string | null): Simulation => ({
  id, project_id: 'p1', name: id, status: 'ready', entry_file: `https://api.example/sim-public/simulations/p1/${id}/index.html`,
  poster_url: poster, bridge_functions: [], created_at: '2026-01-01T00:00:00.000Z',
} as unknown as Simulation);

function Harness({ sims, settleMs = 0 }: { sims: Simulation[]; settleMs?: number }) {
  const sweep = useBannerSweep({ projectId: 'p1', simulations: sims, aspect: 'wide', settleMs });
  return (
    <div>
      <p data-testid="state">{JSON.stringify({ ...sweep.state, active: sweep.state.active?.id ?? null })}</p>
      <button onClick={() => sweep.run(true)}>force</button>
      {sweep.frameSrc && (
        <iframe key={sweep.frameKey ?? undefined} title="capture" data-sim={sweep.frameSrc} src="about:blank" ref={sweep.frameRef} onLoad={sweep.onFrameLoad} />
      )}
    </div>
  );
}

const state = () => JSON.parse(screen.getByTestId('state').textContent ?? '{}') as { running: boolean; active: string | null; queued: number; stored: number; failed: number };

/**
 * jsdom loads `about:blank` and fires the frame's `load` on its own a tick after mount — the
 * same signal a real document gives — so the sweep runs unattended here exactly as it does in
 * the editor. The tests wait for it to finish rather than driving each frame by hand.
 */
const settled = () => waitFor(() => expect(state().running).toBe(false), { timeout: 4000 });

beforeEach(() => { __resetBannerSweepForTests(); calls.upload.length = 0; calls.connect = 0; calls.failFor.clear(); });
afterEach(() => { cleanup(); });

describe('bannersNeeded', () => {
  it('wants ready simulations without a banner; a forced pass wants every ready one', () => {
    const sims = [sim('a', null), sim('b', 'https://cdn/b.png'), { ...sim('c', null), status: 'processing' } as Simulation];
    expect(bannersNeeded(sims, false).map((s) => s.id)).toEqual(['a']);
    expect(bannersNeeded(sims, true).map((s) => s.id)).toEqual(['a', 'b']);
  });
});

describe('useBannerSweep', () => {
  it('captures the simulations without a banner, one frame at a time, and uploads under each', async () => {
    render(<Harness sims={[sim('a', null), sim('b', 'https://cdn/b.png'), sim('c', null)]} />);
    await waitFor(() => expect(state().active).toBe('a'));
    expect(state().queued).toBe(1);
    // One frame, ever: the second simulation waits for the first to finish.
    expect(screen.getAllByTitle('capture')).toHaveLength(1);
    await settled();
    expect(calls.upload.map((u) => u.simId)).toEqual(['a', 'c']);
    expect(calls.connect).toBe(2);
    expect(state().stored).toBe(2);
    expect(screen.queryByTitle('capture')).toBeNull();
  });

  it('a document that cannot draw itself is counted as failed, the sweep moves on, and it is not retried', async () => {
    calls.failFor.add('https://api.example/sim-public/simulations/p1/a/index.html');
    const sims = [sim('a', null), sim('b', null)];
    const { rerender } = render(<Harness sims={sims} />);
    await settled();
    expect(state().failed).toBe(1);
    expect(calls.upload.map((u) => u.simId)).toEqual(['b']);
    // The listing re-renders (still no banner for a): nothing is re-attempted.
    rerender(<Harness sims={[...sims]} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(state().running).toBe(false);
    expect(calls.connect).toBe(2);
  });

  it('a forced pass captures every simulation, banner or not', async () => {
    render(<Harness sims={[sim('a', 'https://cdn/a.png'), sim('b', 'https://cdn/b.png')]} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(state().running).toBe(false);
    fireEvent.click(screen.getByText('force'));
    await waitFor(() => expect(state().running).toBe(true));
    await settled();
    expect(calls.upload.map((u) => [u.simId, u.force])).toEqual([['a', true], ['b', true]]);
  });
});
