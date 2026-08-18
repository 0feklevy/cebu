/**
 * Podcast-studio overlays vs. the rest of the app (ui-ux-012).
 *
 * Escape-to-close and `role="dialog" aria-modal` are the established idiom here — ConfirmDialog,
 * ProjectSettingsPanel and every Radix-backed dialog behave that way. The two hand-rolled studio
 * overlays (`createPortal` + a backdrop `div`) were the outliers: click-outside worked, Escape did
 * nothing, and neither reached the accessibility tree as a dialog at all.
 *
 * REFUTED PART OF THE FINDING, pinned below: `ClipPopover` was also named, but it is no longer an
 * overlay — its own header says the portal popover was deliberately replaced with an inline panel
 * in the document flow. Giving an inline panel `aria-modal` and a global Escape handler would be
 * wrong, so the test asserts what is actually true of it instead.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../lib/api', () => ({
  api: { listPodcastRenders: vi.fn(async () => ({ renders: [] })) },
}));

import { ExportDialog } from '../components/podcast/studio/ExportDialog';
import { VersionsDrawer } from '../components/podcast/studio/VersionsDrawer';
import { ClipPopover } from '../components/podcast/studio/ClipPopover';

afterEach(cleanup);

describe('ExportDialog', () => {
  const noop = async () => {};

  it('reaches assistive tech as a NAMED modal dialog', () => {
    render(<ExportDialog onClose={() => {}} onExport={noop} />);
    expect(screen.getByRole('dialog', { name: 'Export the mix' }).getAttribute('aria-modal')).toBe('true');
  });

  it('closes on Escape, like every other dialog in the app', () => {
    const onClose = vi.fn();
    render(<ExportDialog onClose={onClose} onExport={noop} />);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does NOT close on Escape mid-export — same rule the backdrop already enforces', async () => {
    const onClose = vi.fn();
    // Never settles: the dialog stays in its busy state for the whole test.
    const onExport = vi.fn(() => new Promise<void>(() => {}));
    render(<ExportDialog onClose={onClose} onExport={onExport} />);

    fireEvent.click(screen.getByRole('button', { name: /Export MP4/i }));
    await waitFor(() => expect(onExport).toHaveBeenCalled());

    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('VersionsDrawer', () => {
  const props = { showId: 's1', episodeId: 'e1', snapshots: [], onRestore: () => {} };

  it('reaches assistive tech as a NAMED modal dialog', () => {
    render(<VersionsDrawer {...props} onClose={() => {}} />);
    expect(screen.getByRole('dialog', { name: 'Versions' }).getAttribute('aria-modal')).toBe('true');
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(<VersionsDrawer {...props} onClose={onClose} />);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('ClipPopover is NOT an overlay (the refuted third of ui-ux-012)', () => {
  const turn = {
    id: 't1', speaker: 'teacher' as const, text: 'Photosynthesis converts light.',
    overlap: false, is_hook: false, beat: 'explain',
  };

  it('renders inline in its container rather than portalling to <body>', () => {
    const { container } = render(
      <ClipPopover
        turn={turn} gainDb={0} muted={false} revoicing={false}
        onClose={() => {}} onRevoice={() => {}} onGain={() => {}} onToggleMute={() => {}}
      />,
    );
    const close = screen.getByRole('button', { name: 'Close line panel' });
    // Inside the render container ⇒ in the document flow, not a portal on document.body.
    expect(container.contains(close)).toBe(true);
    // …so modal semantics would be a lie, and it correctly claims none.
    expect(container.querySelector('[aria-modal]')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
