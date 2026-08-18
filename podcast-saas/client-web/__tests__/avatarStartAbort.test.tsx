/**
 * CLOSING THE POPUP MID-FETCH MUST CANCEL THE START, NOT COMPLETE AND BIN IT.
 *
 * AvatarPopup fires /api/v1/avatar/start on open and drops the result if `cancelled`
 * flipped while it was in flight. Nothing leaks: the backend's mint returns a bare
 * token string, the Anam session is created browser-side by the SDK's startSession
 * and released by stopStreaming, so a discarded token holds no concurrency slot.
 * What it does waste is the mint itself and the vendor round-trips behind it — small,
 * but paid on the slowest endpoint in the product, and paid TWICE in React
 * StrictMode, where the throwaway first mount issues a start of its own.
 *
 * So the request is cancelled rather than merely ignored: an AbortSignal is handed to
 * fetch and aborted on close, and an abort is not an error the viewer should ever see.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup, screen } from '@testing-library/react';

vi.mock('../lib/firebase', () => ({
  auth: { currentUser: { getIdToken: () => Promise.resolve('test-id-token') } },
}));

import { AvatarPopup } from '../components/avatar/AvatarPopup';

type Call = { url: string; signal: AbortSignal | null | undefined };

describe('AvatarPopup — a start that is no longer wanted is cancelled', () => {
  const calls: Call[] = [];
  const realFetch = globalThis.fetch;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    calls.length = 0;
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    globalThis.fetch = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), signal: init?.signal });
      // A start that never comes back on its own — only an abort can end it.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    cleanup();
    consoleError.mockRestore();
    globalThis.fetch = realFetch;
  });

  const startCall = () => calls.find((c) => c.url.includes('/api/v1/avatar/start'));

  it('hands the in-flight start an abort signal', async () => {
    render(<AvatarPopup open onClose={() => {}} projectId="p1" />);
    await act(async () => { await Promise.resolve(); });

    const call = startCall();
    expect(call).toBeTruthy();
    expect(call!.signal).toBeInstanceOf(AbortSignal);
    expect(call!.signal!.aborted).toBe(false);
  });

  it('aborts it when the popup closes mid-fetch', async () => {
    const { rerender } = render(<AvatarPopup open onClose={() => {}} projectId="p1" />);
    await act(async () => { await Promise.resolve(); });
    const call = startCall();

    await act(async () => { rerender(<AvatarPopup open={false} onClose={() => {}} projectId="p1" />); });
    await act(async () => { await Promise.resolve(); });

    expect(call!.signal!.aborted).toBe(true);
  });

  it('treats the abort as a cancellation, not a failure the viewer or the log sees', async () => {
    const { rerender } = render(<AvatarPopup open onClose={() => {}} projectId="p1" />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => { rerender(<AvatarPopup open={false} onClose={() => {}} projectId="p1" />); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    // Re-open: a fresh start, no error state carried over from the cancelled one.
    await act(async () => { rerender(<AvatarPopup open onClose={() => {}} projectId="p1" />); });
    await act(async () => { await Promise.resolve(); });

    expect(screen.queryByText(/couldn't start right now/i)).toBeNull();
    expect(consoleError).not.toHaveBeenCalled();
  });
});
