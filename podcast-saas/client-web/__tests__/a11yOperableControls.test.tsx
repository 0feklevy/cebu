/**
 * Controls a keyboard-only or screen-reader user could not operate (ui-ux-003, -005, -009).
 *
 * Two distinct failures, both about the SAME thing — a control that exists visually and not
 * otherwise:
 *   • close/remove buttons whose entire content is an `aria-hidden` icon or a bare "✕" glyph, so
 *     they reach the accessibility tree as an anonymous "button";
 *   • upload dropzones built from a plain `<div onClick>`, which Tab never reaches and Enter/Space
 *     never activates — the file picker is unreachable without a mouse.
 *
 * Names are resolved through the accessibility tree, and the dropzones are driven with real
 * keyboard events that must actually open the file picker. `SimulationUploader` already does this
 * correctly (role/tabIndex/aria-label/onKeyDown) and is pinned here as the reference so the pattern
 * cannot silently regress in the one uploader that had it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../lib/api', () => ({
  api: {
    getBrollJob: vi.fn(async () => ({ id: 'j1', status: 'queued' })),
    generateBroll: vi.fn(async () => ({ jobId: 'j1' })),
    insertExistingBroll: vi.fn(async () => ({ id: 's1' })),
    listPodcastRenders: vi.fn(async () => ({ renders: [] })),
    getBillingStatus: vi.fn(async () => ({ enabled: true })),
    getContentAccess: vi.fn(async () => ({ accessType: 'free' })),
  },
}));
// The pricing control fetches on mount and is not the subject; the popover's chrome is.
vi.mock('../components/LockPriceControl', () => ({ LockPriceControl: () => <div /> }));
// VideoUploader value-imports firebase/auth at module load; nothing here uploads.
vi.mock('firebase/auth', () => ({ getAuth: () => ({ currentUser: null }) }));

import { BrollPanel } from '../components/BrollPanel';
import { CorpusUploader } from '../components/CorpusUploader';
import { VideoUploader } from '../components/VideoUploader';
import { SimulationUploader } from '../components/SimulationUploader';
import { VersionsDrawer } from '../components/podcast/studio/VersionsDrawer';
import { ProjectLockButton } from '../components/ProjectLockButton';

afterEach(cleanup);

describe('icon-only close buttons carry a name (ui-ux-003)', () => {
  it('B-roll panel close button', () => {
    const onClose = vi.fn();
    render(
      <BrollPanel
        projectId="p1"
        mark={{ start: 0, end: 4 }}
        videos={[]}
        jobs={[]}
        onNewJob={() => {}}
        onJobUpdate={() => {}}
        onInserted={() => {}}
        onClose={onClose}
      />,
    );
    const close = screen.getByRole('button', { name: 'Close B-roll panel' });
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('project pricing popover close button', async () => {
    render(<ProjectLockButton projectId="p1" />);
    // The popover only exists once billing status resolves and the trigger is used.
    const trigger = await screen.findByRole('button', { name: 'Lock' });
    fireEvent.click(trigger);

    const close = await screen.findByRole('button', { name: 'Close pricing' });
    fireEvent.click(close);
    expect(screen.queryByRole('button', { name: 'Close pricing' })).toBeNull();
  });

  it('podcast versions drawer close button', () => {
    const onClose = vi.fn();
    render(
      <VersionsDrawer
        showId="s1"
        episodeId="e1"
        snapshots={[]}
        onClose={onClose}
        onRestore={() => {}}
      />,
    );
    const close = screen.getByRole('button', { name: 'Close versions' });
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('bare "✕" glyph buttons carry a name (ui-ux-009)', () => {
  function corpus() {
    const onFilesChange = vi.fn();
    const onUrlsChange = vi.fn();
    const files = [
      new File(['a'], 'lecture-notes.pdf', { type: 'application/pdf' }),
      new File(['b'], 'interview.mp3', { type: 'audio/mpeg' }),
    ];
    const urls = ['https://example.com/paper', 'https://youtu.be/abc123'];
    render(
      <CorpusUploader files={files} urls={urls} onFilesChange={onFilesChange} onUrlsChange={onUrlsChange} />,
    );
    return { onFilesChange, onUrlsChange, files, urls };
  }

  it('names each remove-file button after the file it removes, and removes THAT file', () => {
    const { onFilesChange } = corpus();
    fireEvent.click(screen.getByRole('button', { name: 'Remove interview.mp3' }));
    expect(onFilesChange).toHaveBeenCalledTimes(1);
    expect(onFilesChange.mock.calls[0]![0].map((f: File) => f.name)).toEqual(['lecture-notes.pdf']);
  });

  it('names each remove-URL button after the URL it removes, and removes THAT url', () => {
    const { onUrlsChange } = corpus();
    fireEvent.click(screen.getByRole('button', { name: 'Remove https://youtu.be/abc123' }));
    expect(onUrlsChange).toHaveBeenCalledTimes(1);
    expect(onUrlsChange.mock.calls[0]![0]).toEqual(['https://example.com/paper']);
  });
});

describe('upload dropzones are reachable and operable by keyboard (ui-ux-005)', () => {
  /**
   * Activating the zone must open the real file picker, not merely focus something.
   *
   * The spy does NOT call through. CorpusUploader nests its hidden `<input type="file">` inside
   * the dropzone, so a real `input.click()` dispatches a click that bubbles back into the zone's
   * own onClick. Browsers swallow that re-entry (the HTML "click in progress" flag), but a
   * call-through spy would still COUNT it and turn a correct component into a red test.
   */
  function expectOpensPicker(container: HTMLElement, zone: HTMLElement, key: string) {
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    const clicked = vi.spyOn(input!, 'click').mockImplementation(() => {});
    fireEvent.keyDown(zone, { key });
    expect(clicked).toHaveBeenCalledTimes(1);
    clicked.mockRestore();
  }

  it('VideoUploader: in the tab order, named, and Enter/Space open the picker', () => {
    const { container } = render(<VideoUploader projectId="p1" onUploaded={() => {}} />);
    const zone = screen.getByRole('button', { name: 'Upload video files' });
    expect(zone.tabIndex).toBe(0);
    expectOpensPicker(container, zone, 'Enter');
    expectOpensPicker(container, zone, ' ');
  });

  it('CorpusUploader: in the tab order, named, and Enter/Space open the picker', () => {
    const { container } = render(
      <CorpusUploader files={[]} urls={[]} onFilesChange={() => {}} onUrlsChange={() => {}} />,
    );
    const zone = screen.getByRole('button', { name: 'Upload PDFs, audio, or images' });
    expect(zone.tabIndex).toBe(0);
    expectOpensPicker(container, zone, 'Enter');
    expectOpensPicker(container, zone, ' ');
  });

  it('SimulationUploader already had this — pinned so it cannot regress', () => {
    const { container } = render(<SimulationUploader projectId="p1" onUploaded={() => {}} />);
    const zone = screen.getByRole('button', { name: 'Upload a simulation ZIP or folder' });
    expect(zone.tabIndex).toBe(0);
    expectOpensPicker(container, zone, 'Enter');
  });
});
