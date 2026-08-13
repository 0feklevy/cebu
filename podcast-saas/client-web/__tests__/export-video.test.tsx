/**
 * The Export-video affordance in the project header — the client half of Linear Video Export
 * Phase 1 (md-files/LINEAR-VIDEO-EXPORT-PLAN.md, "THE DECISION"), plus the security review's
 * three additions: degraded-quality consent, the degraded badge, and the neutral cancelled state.
 *
 * What is worth pinning is not "a button exists" but the places a user could be told something
 * false: that the button sits where Preview's gate already taught them to look and shares that
 * gate; that the POST hands back a JOB id which is polled, and the download is offered only when
 * the row says ready; that a 409 `degraded_only` is a QUESTION — consent is explicit, never an
 * auto-retry with the flag; that a degraded success is visibly not a plain success; that the
 * plan's warnings are shown ON SUCCESS, not hidden behind a bare "ready"; that a failure is the
 * server's classified message VERBATIM, with retry advice only where the server wrote it; that
 * cancelled is neutral — not an error, not a success; and that a poll which can never succeed
 * gives up with "lost contact" instead of claiming an outcome it cannot know.
 *
 * Mirrors duplicate-project.test.tsx: same mock shape, same sticky poll queue, same fake-timer
 * discipline for the failure-bound tests.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { authState, api, startExport, poll } = vi.hoisted(() => {
  const poll = {
    /**
     * Successive responses the status endpoint hands back. Consumed in order, and the LAST one
     * sticks — a real status endpoint keeps reporting the same row until the job moves.
     */
    queue: [] as Array<Record<string, unknown>>,
  };
  /** One export row, in the wire shape of shared ProjectExport (+ the review's quality_state). */
  function HROW(status: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'exp-1', status, objects_total: 0, objects_done: 0,
      error: null, download_url: null, warnings: [], quality_state: 'full', ...extra,
    };
  }
  const api = {
    getProject: vi.fn(async () => ({
      id: 'proj-1', org_id: 'org-1', title: 'Photosynthesis', topic: 'plants', status: 'ready',
      visibility: 'private', created_at: new Date().toISOString(), collab_role: 'owner', view_count: 0,
    })),
    listVideos: vi.fn(async () => [{ id: 'v1', is_broll: false }]),
    getProjectExport: vi.fn(async (): Promise<Record<string, unknown>> => {
      if (poll.queue.length > 1) return poll.queue.shift()!;
      return poll.queue[0] ?? HROW('planning');
    }),
    cancelProjectExport: vi.fn(async (): Promise<Record<string, unknown>> => HROW('assembling', { cancel_requested: true })),
  };
  // The start POST is a STANDALONE module export (not a ClientV1Api method): the generated client
  // cannot carry the `allow_degraded` body or surface the 409 payload — see lib/api.ts.
  const startExport = vi.fn(
    async (_projectId: string, _opts?: { allowDegraded?: boolean }): Promise<Record<string, unknown>> =>
      ({ export_id: 'exp-1', status: 'queued' }),
  );
  const authState = {
    user: { uid: 'u1' }, loading: false, isAnonymous: false,
    getIdToken: async () => 't',
    signInAnonymouslyFn: async () => {}, signInWithGoogle: async () => {},
    signInWithEmail: async () => {}, signUpWithEmail: async () => {}, signOutUser: async () => {},
  };
  return { authState, api, startExport, poll };
});

/** One export row, in the wire shape of shared ProjectExport (module-scope twin of the hoisted one). */
function ROW(status: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'exp-1', status, objects_total: 0, objects_done: 0,
    error: null, download_url: null, warnings: [], quality_state: 'full', ...extra,
  };
}

/** The server's 409 refusal, as the api layer surfaces it: an error carrying code + warnings. */
function DEGRADED_ONLY(warnings: string[]): Error {
  return Object.assign(
    new Error('Simulation capture is unavailable; this export can only complete with substitutions.'),
    { code: 'degraded_only', warnings },
  );
}

vi.mock('@/lib/firebase', () => ({ useAuth: () => authState, auth: {} }));
vi.mock('@/lib/api', () => ({
  api,
  getApiClient: () => api,
  createShareToken: vi.fn(),
  revokeShareToken: vi.fn(),
  startProjectExport: startExport,
  // The real guard's logic, verbatim — duck-typed on `code`, exactly like lib/api.ts.
  isDegradedOnlyRefusal: (err: unknown) =>
    typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'degraded_only',
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
}));

import { ProjectHeader } from '../components/ProjectHeader';

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  poll.queue.length = 0;
  // jsdom ships no matchMedia; ProjectSettingsPanel's compact-layout effect asks for one on mount
  // (same stub as sectionEditorServedPreview.test.tsx).
  Object.defineProperty(window, 'matchMedia', {
    configurable: true, writable: true,
    value: (query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }),
  });
  api.getProject.mockResolvedValue({
    id: 'proj-1', org_id: 'org-1', title: 'Photosynthesis', topic: 'plants', status: 'ready',
    visibility: 'private', created_at: new Date().toISOString(), collab_role: 'owner', view_count: 0,
  });
  api.listVideos.mockResolvedValue([{ id: 'v1', is_broll: false }]);
  startExport.mockResolvedValue({ export_id: 'exp-1', status: 'queued' });
  // `clearAllMocks()` clears CALLS, not implementations, so a `mockRejectedValue` set by one test
  // would follow the next one into a completely different scenario.
  api.getProjectExport.mockImplementation(async () => {
    if (poll.queue.length > 1) return poll.queue.shift()!;
    return poll.queue[0] ?? ROW('planning');
  });
  api.cancelProjectExport.mockResolvedValue(ROW('assembling', { cancel_requested: true }));
});
afterEach(() => { cleanup(); Reflect.deleteProperty(window, 'matchMedia'); });

/** The Export control, found the way a user finds it: by its accessible name. */
function exportButton(): HTMLElement {
  return screen.getByRole('button', { name: /export video/i });
}

/** Mount the header and wait until the main-video gate has resolved and the button is live. */
async function mountHeader(): Promise<ReturnType<typeof render>> {
  const utils = render(<ProjectHeader projectId="proj-1" />);
  await waitFor(() => expect(exportButton().hasAttribute('disabled')).toBe(false));
  return utils;
}

describe('the Export video button', () => {
  it('sits immediately LEFT of the Preview anchor', async () => {
    const { container } = await mountHeader();
    const preview = container.querySelector('[data-tour="preview"]');
    expect(preview).toBeTruthy();
    // The element directly before Preview is the export control's anchor, holding the button.
    const left = preview!.previousElementSibling;
    expect(left).toBeTruthy();
    expect(left!.contains(exportButton())).toBe(true);
  });

  it('shares Preview\'s gate: no main video (b-roll only) means no export, and no POST', async () => {
    api.listVideos.mockResolvedValue([{ id: 'v1', is_broll: true }]);
    const { container } = render(<ProjectHeader projectId="proj-1" />);
    await waitFor(() => expect(api.listVideos).toHaveBeenCalled());
    await flush();

    const btn = exportButton();
    expect(btn.hasAttribute('disabled')).toBe(true);
    // The same condition disables Preview — one gate, two controls.
    expect(container.querySelector('[data-tour="preview"]')!.getAttribute('aria-disabled')).toBe('true');

    fireEvent.click(btn);
    await flush();
    expect(startExport).not.toHaveBeenCalled();
  });
});

describe('start → poll → ready → download', () => {
  it('POSTs on click, polls the export id, and offers the download only when ready', async () => {
    poll.queue.push(
      ROW('planning', { objects_total: 10, objects_done: 1 }),
      ROW('assembling', { objects_total: 10, objects_done: 6 }),
      ROW('ready', { objects_total: 10, objects_done: 10, download_url: 'https://cdn.example/exports/proj-1/exp-1/master.mp4' }),
    );
    await mountHeader();
    fireEvent.click(exportButton());

    await waitFor(() => expect(startExport).toHaveBeenCalledWith('proj-1'));
    // The POST hands back a JOB id; progress comes from polling that id.
    await waitFor(() => expect(api.getProjectExport).toHaveBeenCalledWith('proj-1', 'exp-1'));
    const link = await waitFor(() => screen.getByRole('link', { name: /download video/i }));
    expect(link.getAttribute('href')).toBe('https://cdn.example/exports/proj-1/exp-1/master.mp4');
  });

  it('names the phase in human words and reports the row\'s progress while in flight', async () => {
    poll.queue.push(ROW('capturing', { objects_total: 100, objects_done: 42 }));
    await mountHeader();
    fireEvent.click(exportButton());

    // 'capturing' is jargon; the user is told what is happening to their sections.
    await waitFor(() => expect(screen.getByText('Rendering sections…')).toBeTruthy());
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('42');
    // In flight: cancel is offered, the download is not.
    expect(screen.getByRole('button', { name: /cancel export/i })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /download video/i })).toBeNull();
  });

  it('joins an already-running export instead of pretending to start a new one', async () => {
    startExport.mockResolvedValue({ export_id: 'exp-9', status: 'assembling', already_running: true });
    poll.queue.push(ROW('assembling', { id: 'exp-9', objects_total: 100, objects_done: 55 }));
    await mountHeader();
    fireEvent.click(exportButton());

    // The join's id — not a fresh one — is what gets polled, and its real progress is shown.
    await waitFor(() => expect(api.getProjectExport).toHaveBeenCalledWith('proj-1', 'exp-9'));
    await waitFor(() => expect(screen.getByText('Assembling video…')).toBeTruthy());
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('55');
  });
});

describe('degraded-quality consent', () => {
  const SUBSTITUTION = 'Section 2: the simulation will be replaced by its poster still.';

  it('parks the 409 as a QUESTION — dialog first, re-POST only after the explicit yes', async () => {
    startExport.mockRejectedValueOnce(DEGRADED_ONLY([SUBSTITUTION]));
    poll.queue.push(ROW('ready', {
      objects_total: 2, objects_done: 2,
      download_url: 'https://cdn.example/master.mp4',
      quality_state: 'degraded', warnings: [SUBSTITUTION],
    }));
    await mountHeader();
    fireEvent.click(exportButton());

    // The question is put to the user, in plain words, with the substitutions listed verbatim.
    await waitFor(() => expect(
      screen.getByText('Simulations in this project will appear as still images in the exported video.'),
    ).toBeTruthy());
    expect(screen.getByText(SUBSTITUTION)).toBeTruthy();
    // And NOTHING has been consented to yet: exactly the one plain POST, and no polling.
    expect(startExport).toHaveBeenCalledTimes(1);
    expect(startExport).toHaveBeenCalledWith('proj-1');
    expect(api.getProjectExport).not.toHaveBeenCalled();

    // The explicit yes re-POSTs with the flag — this is the only path that ever sets it.
    fireEvent.click(screen.getByRole('button', { name: /export anyway/i }));
    await waitFor(() => expect(startExport).toHaveBeenCalledTimes(2));
    expect(startExport).toHaveBeenLastCalledWith('proj-1', { allowDegraded: true });
    await waitFor(() => expect(screen.getByRole('link', { name: /download video/i })).toBeTruthy());
  });

  it('declining POSTs nothing — and a later attempt asks fresh, without the flag', async () => {
    startExport.mockRejectedValueOnce(DEGRADED_ONLY([SUBSTITUTION]));
    await mountHeader();
    fireEvent.click(exportButton());
    await waitFor(() => expect(screen.getByText(/appear as still images/)).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText(/appear as still images/)).toBeNull());
    // The decline sent NOTHING: still only the original plain POST, never the consent flag.
    expect(startExport).toHaveBeenCalledTimes(1);
    expect(startExport).not.toHaveBeenCalledWith('proj-1', { allowDegraded: true });
    expect(api.getProjectExport).not.toHaveBeenCalled();

    // Consent is per-run: the next click starts plain again, it does not remember a yes never given.
    fireEvent.click(exportButton());
    await waitFor(() => expect(startExport).toHaveBeenCalledTimes(2));
    expect(startExport).toHaveBeenLastCalledWith('proj-1');
  });
});

describe('degraded success is not plain success', () => {
  it('labels a degraded ready "Completed with substitutions" beside the download, warnings listed', async () => {
    const w = 'Section 2 was rendered as its poster still.';
    poll.queue.push(ROW('ready', {
      objects_total: 2, objects_done: 2,
      download_url: 'https://cdn.example/master.mp4',
      quality_state: 'degraded', warnings: [w],
    }));
    await mountHeader();
    fireEvent.click(exportButton());

    await waitFor(() => expect(screen.getByRole('link', { name: /download video/i })).toBeTruthy());
    expect(screen.getByText('Completed with substitutions')).toBeTruthy();
    expect(screen.getByText(w)).toBeTruthy();
  });

  it('shows NO substitutions label on a full-quality success', async () => {
    poll.queue.push(ROW('ready', {
      objects_total: 2, objects_done: 2,
      download_url: 'https://cdn.example/master.mp4',
      quality_state: 'full',
    }));
    await mountHeader();
    fireEvent.click(exportButton());

    await waitFor(() => expect(screen.getByRole('link', { name: /download video/i })).toBeTruthy());
    expect(screen.queryByText(/completed with substitutions/i)).toBeNull();
  });
});

describe('warnings are part of the result', () => {
  it('lists the warnings VERBATIM on success — degradations are not hidden behind a bare ready', async () => {
    const w1 = 'Section 3 was rendered as its poster still — simulation capture is not available yet.';
    const w2 = 'Guidance narration was omitted: its cues are interaction-driven and cannot be scheduled offline.';
    poll.queue.push(ROW('ready', {
      objects_total: 10, objects_done: 10,
      download_url: 'https://cdn.example/master.mp4',
      warnings: [w1, w2],
    }));
    await mountHeader();
    fireEvent.click(exportButton());

    await waitFor(() => expect(screen.getByRole('link', { name: /download video/i })).toBeTruthy());
    // Exact-text queries: the warnings are the server's words, not a paraphrase.
    expect(screen.getByText(w1)).toBeTruthy();
    expect(screen.getByText(w2)).toBeTruthy();
    const list = screen.getByRole('list', { name: /export warnings/i });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
  });
});

describe('cancel', () => {
  it('requests cancellation, then reports the server\'s terminal cancelled row', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      poll.queue.push(ROW('assembling', { objects_total: 10, objects_done: 3 }));
      await mountHeader();
      fireEvent.click(exportButton());
      await waitFor(() => expect(screen.getByRole('button', { name: /cancel export/i })).toBeTruthy());

      fireEvent.click(screen.getByRole('button', { name: /cancel export/i }));
      await waitFor(() => expect(api.cancelProjectExport).toHaveBeenCalledWith('proj-1', 'exp-1'));
      // Cancel is a REQUEST — the panel says so and keeps listening rather than declaring an outcome.
      await waitFor(() => expect(screen.getByRole('button', { name: /cancelling/i }).hasAttribute('disabled')).toBe(true));

      // The server confirms by flipping the row to the terminal cancelled state.
      poll.queue.length = 0;
      poll.queue.push(ROW('cancelled'));
      await act(async () => { vi.advanceTimersByTime(3100); await Promise.resolve(); });
      await waitFor(() => expect(screen.getByText('Export cancelled')).toBeTruthy());
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders cancelled as NEUTRAL — no error styling, no advice — and Dismiss resets', async () => {
    poll.queue.push(ROW('cancelled'));
    await mountHeader();
    fireEvent.click(exportButton());

    await waitFor(() => expect(screen.getByText('Export cancelled')).toBeTruthy());
    const status = screen.getByRole('status');
    // Neutral means neutral: not painted as an error…
    expect(status.querySelector('.text-red-500')).toBeNull();
    // …no invented verdict and no invented advice…
    expect(status.textContent).not.toMatch(/failed|error|try again|retry/i);
    // …and nothing to download, because nothing was produced.
    expect(screen.queryByRole('link', { name: /download video/i })).toBeNull();

    // Dismiss returns the control to rest; the next click is a FRESH export.
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /export video progress/i })).toBeNull());
    poll.queue.length = 0;
    poll.queue.push(ROW('planning', { objects_total: 10, objects_done: 0 }));
    fireEvent.click(exportButton());
    await waitFor(() => expect(startExport).toHaveBeenCalledTimes(2));
  });
});

describe('failures are the server\'s words', () => {
  it('shows a permanent failure exactly as classified, and does NOT invent "try again"', async () => {
    // The backend's branching refusal is non-retryable, and its message deliberately carries no
    // retry advice. If any appears in the panel, this client added it — that is the bug.
    const msg = 'This project uses branching, which a linear export cannot represent.';
    poll.queue.push(ROW('failed', { error: msg }));
    await mountHeader();
    fireEvent.click(exportButton());

    await waitFor(() => expect(screen.getByText(msg)).toBeTruthy());
    const panel = screen.getByRole('dialog', { name: /export video progress/i });
    // Verbatim means verbatim: nothing appended around the server's sentence…
    expect(screen.getByRole('status').textContent).toBe(msg);
    // …and no retry affordance or advice anywhere in the panel for a non-retryable failure.
    expect(within(panel).queryByText(/try again|retry/i)).toBeNull();
    expect(within(panel).queryByRole('button', { name: /try again/i })).toBeNull();
  });

  it('passes the server\'s own retry advice through untouched when the message carries it', async () => {
    // Retryability travels INSIDE the classified message — the client neither adds nor removes it.
    const msg = 'The encoder ran out of disk space while assembling. Nothing was published; you can try again.';
    poll.queue.push(ROW('failed', { error: msg }));
    await mountHeader();
    fireEvent.click(exportButton());

    await waitFor(() => expect(screen.getByText(msg)).toBeTruthy());
    // Exactly the server's sentence — the advice appears once, not echoed by a client decoration.
    expect(screen.getByRole('status').textContent).toBe(msg);
  });

  it('surfaces a refusal at the POST plainly — the branching case — and never starts polling', async () => {
    const refusal = 'This project uses branching paths, so it cannot be exported as a single linear video.';
    startExport.mockRejectedValue(new Error(refusal));
    await mountHeader();
    fireEvent.click(exportButton());

    await waitFor(() => expect(screen.getByText(refusal)).toBeTruthy());
    expect(api.getProjectExport).not.toHaveBeenCalled();
    // Retryability is UNKNOWN for a thrown refusal; unknown must not become "try again".
    const panel = screen.getByRole('dialog', { name: /export video progress/i });
    expect(within(panel).queryByText(/try again|retry/i)).toBeNull();
  });
});

describe('a poll that can never succeed', () => {
  /** Start an export and let the status endpoint fail `n` times. */
  const runWithFailingPolls = async (n: number, error: Error): Promise<void> => {
    api.getProjectExport.mockRejectedValue(error);
    await mountHeader();
    fireEvent.click(exportButton());
    await waitFor(() => expect(api.getProjectExport).toHaveBeenCalled());
    // The first tick fires immediately; the rest are one interval apart.
    for (let i = 1; i < n; i++) {
      await act(async () => { vi.advanceTimersByTime(3000); await Promise.resolve(); });
    }
    await flush();
  };

  it('gives up after five consecutive failures instead of spinning forever, and stops polling', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await runWithFailingPolls(6, new Error('Project not found'));
      await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/Lost contact/));

      // The bound also ENDS the loop: no further reads after giving up.
      const calls = api.getProjectExport.mock.calls.length;
      await act(async () => { vi.advanceTimersByTime(9000); await Promise.resolve(); });
      expect(api.getProjectExport.mock.calls.length).toBe(calls);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says the export MAY still be running — it does not claim to know it failed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await runWithFailingPolls(6, new Error('401'));
      const status = await waitFor(() => screen.getByRole('status'));
      expect(status.textContent).toMatch(/may still be running/);
      // Losing contact is not an outcome; no failure verdict and no retry advice are invented.
      expect(status.textContent).not.toMatch(/export failed|try again/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rides out a transient failure — one bad tick is not a failed export', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      api.getProjectExport
        .mockRejectedValueOnce(new Error('network blip'))
        .mockResolvedValue(ROW('ready', { objects_total: 10, objects_done: 10, download_url: 'https://cdn.example/master.mp4' }));
      await mountHeader();
      fireEvent.click(exportButton());
      await waitFor(() => expect(api.getProjectExport).toHaveBeenCalledTimes(1));

      await act(async () => { vi.advanceTimersByTime(3100); });
      await waitFor(() => expect(screen.getByRole('link', { name: /download video/i })).toBeTruthy());
      expect(screen.queryByText(/Lost contact/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('clearing a finished run', () => {
  it('Dismiss resets a failure so the next click starts a FRESH export', async () => {
    poll.queue.push(ROW('failed', {
      error: 'The encoder ran out of disk space while assembling. Nothing was published; you can try again.',
    }));
    await mountHeader();
    fireEvent.click(exportButton());
    await waitFor(() => expect(screen.getByText(/ran out of disk space/)).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /export video progress/i })).toBeNull());

    poll.queue.length = 0;
    poll.queue.push(ROW('planning', { objects_total: 10, objects_done: 0 }));
    fireEvent.click(exportButton());
    await waitFor(() => expect(startExport).toHaveBeenCalledTimes(2));
  });

  it('reopening the panel during a run shows the run — it does not restart it', async () => {
    poll.queue.push(ROW('uploading', { objects_total: 10, objects_done: 9 }));
    await mountHeader();
    fireEvent.click(exportButton());
    await waitFor(() => expect(screen.getByText('Uploading…')).toBeTruthy());

    // Close the popover (the run keeps polling), then reopen it.
    fireEvent.click(screen.getByRole('button', { name: /close export panel/i }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /export video progress/i })).toBeNull());
    fireEvent.click(exportButton());

    await waitFor(() => expect(screen.getByText('Uploading…')).toBeTruthy());
    expect(startExport).toHaveBeenCalledTimes(1);
  });
});
