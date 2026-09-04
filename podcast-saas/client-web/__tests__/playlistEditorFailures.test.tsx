/**
 * The playlist editor never fails silently (frontend-editor-003, ui-ux-011).
 *
 * Three writes in this dialog were wrapped in `catch { /* ignore *\/ }`:
 *
 *   • Save — two sequential calls, `updatePlaylist` then `setPlaylistItems`. When the second one
 *     failed the first had already landed, so the playlist kept its new TITLE and its OLD ITEMS.
 *     The spinner stopped, the dialog stayed open, and nothing said anything. The user closes it
 *     believing the whole edit saved, and finds out later — or never.
 *   • Delete — the dialog stayed open with the playlist still in it.
 *   • Revoke link — the "Revoke" spinner stopped and the live link stayed on screen, so the only
 *     signal was that nothing happened. For a control whose entire job is to make a public link
 *     stop working, "looks like nothing happened" is the worst possible answer.
 *
 * Save is the sharp one, and it is the reason the assertion below is about WHICH part landed
 * rather than just "an error appeared": a message that says "couldn't save" while the title
 * silently did save is still lying to the user about the state of their data.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getPlaylist: vi.fn(),
    listProjects: vi.fn(),
    getPlaylistShare: vi.fn(),
    updatePlaylist: vi.fn(),
    setPlaylistItems: vi.fn(),
    deletePlaylist: vi.fn(),
    createPlaylistShare: vi.fn(),
    revokePlaylistShare: vi.fn(),
    uploadPlaylistBanner: vi.fn(),
    generatePlaylistBanner: vi.fn(),
  },
}));

vi.mock('../lib/api', () => ({ api: apiMock }));
// Side panels that make their own authed calls; none of them is what this file is about.
vi.mock('../components/LockPriceControl', () => ({ LockPriceControl: () => null }));
vi.mock('../components/PermalinkEditor', () => ({ PermalinkEditor: () => null }));
vi.mock('../components/CollaboratorsSection', () => ({ CollaboratorsSection: () => null }));

import { PlaylistEditorDialog } from '../components/PlaylistEditorDialog';

const SHARE_URL = 'https://flowvid.test/pl/tok-123';

const PLAYLIST = {
  id: 'pl-1', title: 'Physics 101', description: null,
  autoplay: true, show_sidebar: true, allow_shuffle: true,
  banner_url: null, banner_prompt: null, banner_provider: null,
  items: [{ project_id: 'p1', title: 'Intro', thumbnail_url: null }],
};

function renderDialog() {
  const onClose = vi.fn();
  const onChanged = vi.fn();
  const view = render(
    <PlaylistEditorDialog playlistId="pl-1" open onClose={onClose} onChanged={onChanged} />,
  );
  return { ...view, onClose, onChanged };
}

beforeEach(() => {
  for (const fn of Object.values(apiMock)) fn.mockReset();
  apiMock.getPlaylist.mockResolvedValue(PLAYLIST);
  apiMock.listProjects.mockResolvedValue([]);
  apiMock.getPlaylistShare.mockResolvedValue({ shareToken: 'tok-123', shareUrl: SHARE_URL });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('playlist editor — Save', () => {
  it('reports exactly what landed when the items write fails after the settings write succeeded', async () => {
    apiMock.updatePlaylist.mockResolvedValue(PLAYLIST);
    apiMock.setPlaylistItems.mockRejectedValue(new Error('409 a video in this playlist was deleted'));

    const { onClose, onChanged } = renderDialog();
    fireEvent.click(await screen.findByRole('button', { name: /Save changes/i }));

    await waitFor(() => { expect(apiMock.setPlaylistItems).toHaveBeenCalledTimes(1); });

    // The user is told the half-truth they are actually holding: settings saved, videos did not.
    const notice = await screen.findByRole('alert');
    expect(notice.textContent).toMatch(/videos/i);
    expect(notice.textContent).toMatch(/409 a video in this playlist was deleted/);

    // The dialog does NOT close over a failed save — closing is the gesture that says "done".
    expect(onClose).not.toHaveBeenCalled();
    // The list behind it still gets refreshed, because half of the write really did land.
    expect(onChanged).toHaveBeenCalled();
    // The Save button is usable again rather than stuck mid-spin.
    expect(screen.getByRole('button', { name: /Save changes/i })).toHaveProperty('disabled', false);
  });

  it('reports a settings write that fails, and does not go on to write the items', async () => {
    apiMock.updatePlaylist.mockRejectedValue(new Error('403 not your playlist'));

    const { onClose } = renderDialog();
    fireEvent.click(await screen.findByRole('button', { name: /Save changes/i }));

    const notice = await screen.findByRole('alert');
    expect(notice.textContent).toMatch(/403 not your playlist/);
    expect(apiMock.setPlaylistItems).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes and refreshes when both writes succeed', async () => {
    apiMock.updatePlaylist.mockResolvedValue(PLAYLIST);
    apiMock.setPlaylistItems.mockResolvedValue(PLAYLIST);

    const { onClose, onChanged } = renderDialog();
    fireEvent.click(await screen.findByRole('button', { name: /Save changes/i }));

    await waitFor(() => { expect(onClose).toHaveBeenCalledTimes(1); });
    expect(onChanged).toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('playlist editor — Delete', () => {
  it('asks for confirmation first — nothing is deleted until the user answers Delete', async () => {
    apiMock.deletePlaylist.mockResolvedValue({ ok: true });

    const { onClose, onChanged } = renderDialog();
    fireEvent.click(await screen.findByRole('button', { name: /Delete playlist/i }));

    // The house ConfirmDialog, not window.confirm: a real dialog with the question in it.
    const confirm = await screen.findByRole('dialog', { name: /Delete playlist\?/i });
    expect(apiMock.deletePlaylist).not.toHaveBeenCalled();

    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete' }));
    await waitFor(() => { expect(apiMock.deletePlaylist).toHaveBeenCalledWith('pl-1'); });
    await waitFor(() => { expect(onClose).toHaveBeenCalled(); });
    expect(onChanged).toHaveBeenCalled();
  });

  it('Cancel answers the confirmation without deleting anything', async () => {
    const { onClose } = renderDialog();
    fireEvent.click(await screen.findByRole('button', { name: /Delete playlist/i }));

    const confirm = await screen.findByRole('dialog', { name: /Delete playlist\?/i });
    fireEvent.click(within(confirm).getByRole('button', { name: /Cancel/i }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /Delete playlist\?/i })).toBeNull();
    });
    expect(apiMock.deletePlaylist).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('reports the failure and keeps the dialog open', async () => {
    apiMock.deletePlaylist.mockRejectedValue(new Error('500 storage unavailable'));

    const { onClose } = renderDialog();
    fireEvent.click(await screen.findByRole('button', { name: /Delete playlist/i }));
    const confirm = await screen.findByRole('dialog', { name: /Delete playlist\?/i });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete' }));

    await waitFor(() => { expect(apiMock.deletePlaylist).toHaveBeenCalledWith('pl-1'); });
    const notice = await screen.findByRole('alert');
    expect(notice.textContent).toMatch(/delete/i);
    expect(notice.textContent).toMatch(/500 storage unavailable/);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('playlist editor — Revoke link', () => {
  it('reports the failure and leaves the still-live link on screen', async () => {
    apiMock.revokePlaylistShare.mockRejectedValue(new Error('502 bad gateway'));

    renderDialog();
    fireEvent.click(await screen.findByRole('button', { name: /Revoke link/i }));

    await waitFor(() => { expect(apiMock.revokePlaylistShare).toHaveBeenCalledWith('pl-1'); });
    const notice = await screen.findByRole('alert');
    expect(notice.textContent).toMatch(/revoke|link/i);
    expect(notice.textContent).toMatch(/502 bad gateway/);
    // The link is still live, so it must still be shown as live. Hiding it would tell the user the
    // opposite of the truth about a URL that still works.
    expect(screen.getByTitle(SHARE_URL)).toBeTruthy();
  });

  it('drops the link when the revoke succeeds', async () => {
    apiMock.revokePlaylistShare.mockResolvedValue({ ok: true });

    renderDialog();
    fireEvent.click(await screen.findByRole('button', { name: /Revoke link/i }));

    await waitFor(() => { expect(screen.queryByTitle(SHARE_URL)).toBeNull(); });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('playlist editor — Create private link', () => {
  it('reports the failure instead of leaving the button looking like it did nothing', async () => {
    // Same two-call shape as Save: the items write goes first, so this one can half-land too.
    apiMock.getPlaylistShare.mockResolvedValue({ shareToken: null, shareUrl: null });
    apiMock.setPlaylistItems.mockResolvedValue(PLAYLIST);
    apiMock.createPlaylistShare.mockRejectedValue(new Error('429 too many links today'));

    renderDialog();
    fireEvent.click(await screen.findByRole('button', { name: /Create private link/i }));

    const notice = await screen.findByRole('alert');
    expect(notice.textContent).toMatch(/private link/i);
    expect(notice.textContent).toMatch(/429 too many links today/);
  });
});

describe('playlist editor — failed load', () => {
  it('says the playlist could not be loaded and refuses to save blank fields over it', async () => {
    // Without this the dialog opens on empty fields, which is indistinguishable from an empty
    // playlist — and Save would then write those blanks over the real one.
    apiMock.getPlaylist.mockRejectedValue(new Error('503 service unavailable'));

    renderDialog();

    const notice = await screen.findByRole('alert');
    expect(notice.textContent).toMatch(/could not load/i);
    expect(notice.textContent).toMatch(/503 service unavailable/);

    const save = screen.getByRole('button', { name: /Save changes/i });
    expect(save).toHaveProperty('disabled', true);
    fireEvent.click(save);
    expect(apiMock.updatePlaylist).not.toHaveBeenCalled();
  });
});
