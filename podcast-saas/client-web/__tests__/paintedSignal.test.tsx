/**
 * The library overlay's painted signal: the gate's SIM_PAINTED, the serve-time snippet's
 * SIM_PAINTED_FALLBACK (a package without the gate), and the timer as the last resort — and only
 * from the overlay's OWN frame.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useRef } from 'react';
import { usePaintedSignal, SIM_PAINTED_FALLBACK_TYPE, SIM_PAINTED_TYPE } from '../components/library/usePaintedSignal';

function Harness({ loaded, fallbackMs }: { loaded: boolean; fallbackMs: number }) {
  const ref = useRef<HTMLIFrameElement | null>(null);
  const painted = usePaintedSignal(ref, loaded, fallbackMs);
  return <div><iframe title="sim" ref={ref} src="about:blank" /><p data-testid="painted">{String(painted)}</p></div>;
}

const painted = () => screen.getByTestId('painted').textContent;

function postFromFrame(type: string, source?: Window | null) {
  const frame = screen.getByTitle('sim') as HTMLIFrameElement;
  const event = new MessageEvent('message', { data: { type }, source: source === undefined ? frame.contentWindow : source });
  act(() => { window.dispatchEvent(event); });
}

afterEach(cleanup);

describe('usePaintedSignal', () => {
  it('reveals on the gate’s SIM_PAINTED from its own frame', () => {
    render(<Harness loaded fallbackMs={60_000} />);
    expect(painted()).toBe('false');
    postFromFrame(SIM_PAINTED_TYPE);
    expect(painted()).toBe('true');
  });

  it('reveals on the serve-time SIM_PAINTED_FALLBACK — a package without the gate no longer waits for the timer', () => {
    render(<Harness loaded fallbackMs={60_000} />);
    postFromFrame(SIM_PAINTED_FALLBACK_TYPE);
    expect(painted()).toBe('true');
  });

  it('ignores a message from any other window', () => {
    render(<Harness loaded fallbackMs={60_000} />);
    postFromFrame(SIM_PAINTED_TYPE, null);
    expect(painted()).toBe('false');
  });

  it('falls back to the timer, only after the document loaded', () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(<Harness loaded={false} fallbackMs={1200} />);
      act(() => { vi.advanceTimersByTime(5000); });
      expect(painted()).toBe('false');
      rerender(<Harness loaded fallbackMs={1200} />);
      act(() => { vi.advanceTimersByTime(1199); });
      expect(painted()).toBe('false');
      act(() => { vi.advanceTimersByTime(2); });
      expect(painted()).toBe('true');
    } finally {
      vi.useRealTimers();
    }
  });
});
