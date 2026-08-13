/**
 * ExportProgressPanel — the viewport-fit and honest-progress rules (panel doc rules 7 & 8).
 *
 * THE PRODUCTION INCIDENT THIS PINS: a project with dozens of simulation warnings grew the consent
 * popover past the bottom of the screen and pushed "Export anyway" below the viewport — consent
 * looked unanswerable. jsdom does no real layout, so these tests pin the STRUCTURE that delivers
 * the fix: the panel is height-capped, the warning list is the one scrollable (and focusable)
 * region, and the action row lives OUTSIDE it so it can never scroll away. If someone removes the
 * cap or moves the buttons inside the scroll region, these fail.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';

// The panel value-imports `exportPhaseLabel` from the hook module, whose `./api` import initialises
// Firebase at module load — irrelevant here and crashes under jsdom. Cut the chain at lib/api.
vi.mock('../lib/api', () => ({
  api: {},
  isDegradedOnlyRefusal: () => false,
  startProjectExport: async () => ({ export_id: 'x', status: 'queued' }),
}));

import { ExportProgressPanel } from '../components/ExportProgressPanel';
import type { UseProjectExport } from '../lib/useProjectExport';

afterEach(cleanup);

const noop = async (): Promise<void> => {};

function makeFlow(overrides: Partial<UseProjectExport> = {}): UseProjectExport {
  return {
    status: null, progressPct: null, warnings: [], error: null, downloadUrl: null,
    qualityState: null, busy: false, cancelRequested: false, degradedConsent: null,
    start: noop, confirmDegraded: noop, declineDegraded: () => {}, cancel: noop, reset: () => {},
    ...overrides,
  };
}

const MANY_WARNINGS = Array.from(
  { length: 60 },
  (_, i) => `section ${i}: no poster still exists for this exact configuration — falls back`,
);

describe('consent panel with MANY warnings (rule 7 — the production overflow)', () => {
  it('caps the panel height, scrolls ONLY the warning list, and keeps the actions outside it', () => {
    render(
      <ExportProgressPanel
        open
        onClose={() => {}}
        flow={makeFlow({ degradedConsent: { warnings: MANY_WARNINGS } })}
      />,
    );

    // The panel itself is height-capped to the viewport — the fix's load-bearing class.
    const dialog = screen.getByRole('dialog', { name: 'Export video progress' });
    expect(dialog.className).toMatch(/max-h-\[/);
    expect(dialog.className).toMatch(/flex-col/);

    // The warning list is the designated scroll region, focusable for keyboard scrolling…
    const list = screen.getByRole('list', { name: 'Export warnings' });
    expect(list.className).toContain('overflow-y-auto');
    expect(list).toHaveProperty('tabIndex', 0);
    expect(list.querySelectorAll('li')).toHaveLength(60);

    // …and BOTH answers live outside it, in a non-scrolling row, so they cannot leave the panel.
    const exportAnyway = screen.getByRole('button', { name: 'Export anyway' });
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(list.contains(exportAnyway)).toBe(false);
    expect(list.contains(cancel)).toBe(false);
    expect(exportAnyway.parentElement?.className).toContain('flex-none');
  });

  it('caps the warning list itself to a few lines (its own max-h, not just the panel cap)', () => {
    render(
      <ExportProgressPanel
        open
        onClose={() => {}}
        flow={makeFlow({ degradedConsent: { warnings: MANY_WARNINGS } })}
      />,
    );
    expect(screen.getByRole('list', { name: 'Export warnings' }).className).toMatch(/max-h-/);
  });

  it('Copy all puts the COMPLETE warning text on the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { getByRole, findByRole } = render(
      <ExportProgressPanel
        open
        onClose={() => {}}
        flow={makeFlow({ degradedConsent: { warnings: MANY_WARNINGS } })}
      />,
    );
    getByRole('button', { name: /copy all/i }).click();
    expect(writeText).toHaveBeenCalledWith(MANY_WARNINGS.join('\n'));
    // Feedback state flips so the user knows it worked.
    expect(await findByRole('button', { name: /copied/i })).toBeTruthy();
  });

  it('keeps the same discipline on the RUNNING view (warnings arrive from every poll)', () => {
    render(
      <ExportProgressPanel
        open
        onClose={() => {}}
        flow={makeFlow({ status: 'assembling', busy: true, warnings: MANY_WARNINGS })}
      />,
    );
    const list = screen.getByRole('list', { name: 'Export warnings' });
    expect(list.className).toContain('overflow-y-auto');
    const cancelExport = screen.getByRole('button', { name: 'Cancel export' });
    expect(list.contains(cancelExport)).toBe(false);
  });
});

describe('progress readout (rule 8 — no misleading 0%)', () => {
  it('renders an INDETERMINATE bar and no percentage while progress is 0', () => {
    render(
      <ExportProgressPanel
        open
        onClose={() => {}}
        flow={makeFlow({ status: 'assembling', busy: true, progressPct: 0 })}
      />,
    );
    expect(screen.queryByText(/0%/)).toBeNull();
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBeNull(); // indeterminate per ARIA
  });

  it('renders an INDETERMINATE bar while progress is unknown (null)', () => {
    render(
      <ExportProgressPanel
        open
        onClose={() => {}}
        flow={makeFlow({ status: 'capturing', busy: true, progressPct: null })}
      />,
    );
    expect(screen.queryByText(/%/)).toBeNull();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBeNull();
  });

  it('shows the number and a determinate bar once progress is REAL', () => {
    render(
      <ExportProgressPanel
        open
        onClose={() => {}}
        flow={makeFlow({ status: 'assembling', busy: true, progressPct: 42 })}
      />,
    );
    expect(screen.getByText('· 42%')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('42');
  });
});
