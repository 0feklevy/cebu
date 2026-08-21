/**
 * THE QUESTION AN AUTHOR IS ASKED BEFORE A VIDEO TAKES OTHER CLIPS WITH IT (D-01b).
 *
 * The server now refuses to delete a video that overlays are anchored to, and returns the list
 * instead. That refusal is only worth anything if the person on the other end can (a) see what is
 * at stake and (b) answer it — otherwise it is a silent failure where there used to be a silent
 * deletion, which is not an improvement.
 *
 * So this suite asserts the dialog the way a user resolves it: by ROLE and NAME, never by class or
 * attribute. And it asserts the one thing the ruling turns on — that the dialog cannot offer to
 * move an orphan onto the next video, no matter how convenient that would be.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import { VideoDependentsDialog } from '../components/VideoDependentsDialog';
import type { VideoDeleteBlocked } from 'shared/src/generated/client-v1';

const blocked = (over: Partial<VideoDeleteBlocked> = {}): VideoDeleteBlocked => ({
  code: 'video_has_dependent_sections',
  message: 'This video has sections placed against it.',
  choices: ['detach', 'delete'],
  dependents: [
    { sectionId: 'sec-a', kind: 'anchor', label: 'logo sting', absoluteSec: 72, anchorOffsetSec: 12 },
    { sectionId: 'sec-b', kind: 'source', label: 'chapter one', absoluteSec: 0, anchorOffsetSec: null },
  ],
  removed_regardless: ['sec-b'],
  generations_in_flight: 0,
  ...over,
});

afterEach(cleanup);

function renderDialog(over: Partial<VideoDeleteBlocked> = {}, props: Record<string, unknown> = {}) {
  const onChoose = vi.fn();
  const onCancel = vi.fn();
  render(
    <VideoDependentsDialog
      blocked={blocked(over)}
      filename="intro.mp4"
      onChoose={onChoose}
      onCancel={onCancel}
      {...props}
    />,
  );
  return { onChoose, onCancel, dialog: screen.getByRole('dialog') };
}

describe('the dependents dialog', () => {
  it('names every clip at stake, and what each one loses', () => {
    // "2 sections depend on this video" is not actionable. The author has to be able to find the
    // clip, which means its name and the second it plays at.
    const { dialog } = renderDialog();
    expect(within(dialog).getByText(/logo sting/)).toBeTruthy();
    expect(within(dialog).getByText(/1:12/)).toBeTruthy();          // 72s, in the editor's units
    expect(within(dialog).getByText('loses its position')).toBeTruthy();
    expect(within(dialog).getByText('is this video')).toBeTruthy();
  });

  it('says which clips no answer can save', () => {
    const { dialog } = renderDialog();
    expect(within(dialog).getByText(/removed whichever you choose/i)).toBeTruthy();
    // …and offers to keep only the one that CAN be kept.
    expect(within(dialog).getByRole('button', { name: /Keep 1 clip/ })).toBeTruthy();
  });

  it('offers exactly two answers plus cancel, and NEVER a re-anchor', () => {
    // The ruling in one assertion: no button, anywhere in this dialog, moves a clip to another
    // video. It is the convenient-looking option, so its absence is what is tested.
    const { dialog } = renderDialog();
    const names = within(dialog).getAllByRole('button').map((b) => b.textContent ?? '');
    expect(names).toHaveLength(3);
    expect(names.join(' ')).not.toMatch(/next clip|next video|move|re-?anchor/i);
  });

  it('returns the author’s answer verbatim, and changes nothing itself', () => {
    const { dialog, onChoose } = renderDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: /Keep 1 clip/ }));
    expect(onChoose).toHaveBeenCalledWith('detach');

    cleanup();
    const second = renderDialog();
    fireEvent.click(within(second.dialog).getByRole('button', { name: /Delete them with the video/ }));
    expect(second.onChoose).toHaveBeenCalledWith('delete');
  });

  it('opens on the answer that changes nothing', () => {
    // A dialog that opens focused on a destructive answer turns a reflexive Enter into the action
    // it exists to guard — the same rule ConfirmDialog follows.
    const { dialog } = renderDialog();
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
  });

  it('cancels on Escape without answering', () => {
    const { onCancel, onChoose } = renderDialog();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalled();
    expect(onChoose).not.toHaveBeenCalled();
  });

  it('mentions a generation still rendering for the spot', () => {
    const { dialog } = renderDialog({ generations_in_flight: 2 });
    expect(within(dialog).getByText(/2 b-roll generations are still rendering/)).toBeTruthy();
  });

  it('survives both themes: token-only styling, no hex and no rgb()', () => {
    // The guard the library mini-site suite established. A dialog that is unreadable in dark mode
    // is a dialog whose answer is a coin flip.
    const { dialog } = renderDialog();
    const html = dialog.outerHTML;
    expect(html.match(/#[0-9a-fA-F]{3,8}\b/)?.[0] ?? null).toBeNull();
    expect(html).not.toMatch(/rgba?\(/);
    expect(html).toMatch(/hsl\(var\(--/);
  });
});
