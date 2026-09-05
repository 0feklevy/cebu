// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { SimInviteChip, SIM_INVITE_HOLD_MS } from '../components/viewer/SimInviteChip';

// The window invitation exists for exactly one moment: a live simulation has just revealed over
// the film and a first-time viewer needs to be told what to touch. These pin the three things that
// make it an invitation rather than a label — it shows the section's imperative, it leaves on the
// first touch, and it leaves on its own if nobody touches.

afterEach(() => { cleanup(); vi.useRealTimers(); });

const chipText = () => screen.queryByTestId('sim-invite')?.textContent ?? null;

describe('SimInviteChip', () => {
  it('shows the section label while a live window is on screen', () => {
    render(<SimInviteChip label="Touch the motor" active activationKey="pkg-a" />);
    expect(chipText()).toBe('Touch the motor');
  });

  it('renders nothing when no window is live, when the label is blank, or when there is no activation', () => {
    const { rerender } = render(<SimInviteChip label="Touch the motor" active={false} activationKey="pkg-a" />);
    expect(chipText()).toBeNull();
    rerender(<SimInviteChip label="   " active activationKey="pkg-a" />);
    expect(chipText()).toBeNull();
    rerender(<SimInviteChip label="Touch the motor" active activationKey={null} />);
    expect(chipText()).toBeNull();
  });

  it("leaves on the viewer's first touch (the host flips `active` off)", () => {
    const { rerender } = render(<SimInviteChip label="Steer the flock" active activationKey="pkg-b" />);
    expect(chipText()).toBe('Steer the flock');
    rerender(<SimInviteChip label="Steer the flock" active={false} activationKey="pkg-b" />);
    expect(chipText()).toBeNull();
  });

  it('leaves on its own after the hold when nobody touches, and re-arms only for a different activation', () => {
    vi.useFakeTimers();
    const { rerender } = render(<SimInviteChip label="Fly to a planet" active activationKey="pkg-c" />);
    expect(chipText()).toBe('Fly to a planet');
    act(() => { vi.advanceTimersByTime(SIM_INVITE_HOLD_MS + 10); });
    expect(chipText()).toBeNull();
    // Scrubbing back into the same section: no second lecture.
    rerender(<SimInviteChip label="Fly to a planet" active={false} activationKey="pkg-c" />);
    rerender(<SimInviteChip label="Fly to a planet" active activationKey="pkg-c" />);
    expect(chipText()).toBeNull();
    // A different window: invited again.
    rerender(<SimInviteChip label="Steer the flock" active activationKey="pkg-d" />);
    expect(chipText()).toBe('Steer the flock');
  });
});
