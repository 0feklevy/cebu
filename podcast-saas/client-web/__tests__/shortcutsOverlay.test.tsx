import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ShortcutsOverlay } from '../components/viewer/ShortcutsOverlay';

describe('ShortcutsOverlay', () => {
  afterEach(cleanup);

  it('is closed until ? is pressed, lists the keys, and closes on Escape or a click outside', () => {
    render(<ShortcutsOverlay />);
    expect(screen.queryByRole('dialog', { name: /keyboard shortcuts/i })).toBeNull();

    fireEvent.keyDown(document, { key: '?' });
    const dialog = screen.getByRole('dialog', { name: /keyboard shortcuts/i });
    expect(dialog.textContent).toMatch(/Space/);
    expect(dialog.textContent).toMatch(/Play \/ pause/);
    expect(dialog.textContent).toMatch(/5 seconds/);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: /keyboard shortcuts/i })).toBeNull();

    fireEvent.keyDown(document, { key: '?' });
    fireEvent.click(screen.getByRole('dialog', { name: /keyboard shortcuts/i }));
    expect(screen.queryByRole('dialog', { name: /keyboard shortcuts/i })).toBeNull();
  });

  it('ignores ? typed into a field', () => {
    render(<><input aria-label="q" /><ShortcutsOverlay /></>);
    fireEvent.keyDown(screen.getByLabelText('q'), { key: '?' });
    expect(screen.queryByRole('dialog', { name: /keyboard shortcuts/i })).toBeNull();
  });
});
