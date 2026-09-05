'use client';

import { useEffect, useState } from 'react';

/**
 * The window invitation: when a live simulation reveals over the film, a first-time viewer has to
 * learn two things in about a second — that this is not video any more, and what to do with it.
 * The section's own label carries the second ("Touch the motor", "Fly to a planet"); this chip
 * shows it once, pulses twice to draw the eye, and gets out of the way.
 *
 * It hides on the FIRST touch (the pool's `userInteraction` flips `badgeMode` off 'sim', which is
 * the `active` prop going false) or after `holdMs`, whichever comes first, and re-arms only for a
 * different activation (`activationKey`) — a viewer who scrubs back into the same section does not
 * get lectured twice. Pointer events pass straight through to the simulation underneath.
 */
export const SIM_INVITE_HOLD_MS = 3500;

export function SimInviteChip({
  label,
  active,
  activationKey,
  holdMs = SIM_INVITE_HOLD_MS,
}: {
  label: string;
  active: boolean;
  activationKey: string | null;
  holdMs?: number;
}) {
  const [expiredFor, setExpiredFor] = useState<string | null>(null);

  useEffect(() => {
    if (!active || !activationKey) return;
    const t = setTimeout(() => setExpiredFor(activationKey), holdMs);
    return () => clearTimeout(t);
  }, [active, activationKey, holdMs]);

  const text = label.trim();
  if (!active || !text || !activationKey || expiredFor === activationKey) return null;

  return (
    <div className="sim-invite" role="status" aria-live="polite" data-testid="sim-invite">
      <span className="sim-invite-ring" aria-hidden="true" />
      <span className="sim-invite-text">{text}</span>
    </div>
  );
}
