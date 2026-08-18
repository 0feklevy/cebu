/**
 * ConfirmDialog — the app-wide destructive-action modal (ui-ux-004).
 *
 * This is the last thing between a user and a permanent delete: it is what `HomeSidebar` puts in
 * front of "Delete project", and what `VideoEditor` / `SectionEditor` / the podcast show pages use
 * for their own destructive answers. It declares `aria-modal="true"`, which is a PROMISE to
 * assistive technology that focus is contained inside it. Before this suite the promise was false —
 * focus stayed on whatever opened the dialog, so a keyboard user had to guess how many Tabs reached
 * the buttons, and Tab walked straight past them into the page behind the backdrop.
 *
 * Everything here is asserted the way an assistive technology would resolve it: `getByRole` with a
 * NAME, and `document.activeElement` — never "the attribute I just wrote is present".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { ConfirmDialog } from '../components/ConfirmDialog';

/** A focusable control OUTSIDE the dialog — i.e. the page behind the backdrop. */
function pageBehind(label: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  document.body.appendChild(b);
  return b;
}

afterEach(() => {
  cleanup();
  document.body.querySelectorAll('button').forEach((b) => b.remove());
});

function renderDialog(props: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) {
  return render(
    <ConfirmDialog
      title="Delete project?"
      description="Photosynthesis and every export made from it will be removed."
      confirmLabel="Delete forever"
      onConfirm={props.onConfirm ?? (() => {})}
      onCancel={props.onCancel ?? (() => {})}
      {...props}
    />,
  );
}

describe('ConfirmDialog focus containment (ui-ux-004)', () => {
  it('names the dialog so a screen reader announces WHAT is being confirmed', () => {
    renderDialog();
    // Resolved through the accessibility tree, not by reading an attribute back.
    expect(screen.getByRole('dialog', { name: 'Delete project?' })).toBeTruthy();
  });

  it('moves focus into the dialog on open, landing on the NON-destructive answer', () => {
    const trigger = pageBehind('Delete project');
    trigger.focus();
    renderDialog();

    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(document.activeElement).toBe(cancel);
    // …and specifically NOT the destructive one: the next keystroke may be Enter.
    expect(document.activeElement).not.toBe(screen.getByRole('button', { name: 'Delete forever' }));
  });

  it('cycles Tab from the last control back to the first instead of leaving for the page', () => {
    pageBehind('Focusable page content');
    renderDialog();

    const confirm = screen.getByRole('button', { name: 'Delete forever' });
    confirm.focus();
    fireEvent.keyDown(confirm, { key: 'Tab' });

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
  });

  it('cycles Shift+Tab from the first control round to the last', () => {
    pageBehind('Focusable page content');
    renderDialog();

    const cancel = screen.getByRole('button', { name: 'Cancel' });
    cancel.focus();
    fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true });

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Delete forever' }));
  });

  it('pulls focus back when it is already OUTSIDE the dialog (the aria-modal promise)', () => {
    const outside = pageBehind('Focusable page content');
    renderDialog();

    outside.focus();
    expect(document.activeElement).toBe(outside);

    fireEvent.keyDown(outside, { key: 'Tab' });

    const dialog = screen.getByRole('dialog', { name: 'Delete project?' });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('restores focus to whatever opened it when the dialog closes', () => {
    const trigger = pageBehind('Delete project');
    trigger.focus();
    const { unmount } = renderDialog();

    expect(document.activeElement).not.toBe(trigger);
    unmount();
    expect(document.activeElement).toBe(trigger);
  });

  it('still answers Escape with cancel (pre-existing behaviour must survive the trap)', () => {
    const onCancel = vi.fn();
    renderDialog({ onCancel });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('contains Tab even while busy, when BOTH answers are disabled', () => {
    const outside = pageBehind('Focusable page content');
    renderDialog({ busy: true });

    outside.focus();
    fireEvent.keyDown(outside, { key: 'Tab' });

    const dialog = screen.getByRole('dialog', { name: 'Delete project?' });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});
