/**
 * A failed avatar-gallery delete is reported, not dropped on the floor (frontend-editor-001).
 *
 * The handler was:
 *
 *     const del = async (id) => {
 *       if (!confirm('Delete this visual?')) return;
 *       await deleteAvatarVisual(id);          // ← nothing catches this
 *       setItems(prev => prev.filter(…));
 *     };
 *
 * wired as `onClick={() => del(item.id)}`, so nothing awaits the returned promise either. A DELETE
 * that came back 403/404/500 became an unhandled rejection: the console got a stack trace nobody
 * was reading, the admin got no error, and — because the filter is after the await — the row simply
 * stayed put. The only feedback for "the delete failed" was indistinguishable from "the click
 * didn't register", which invites the natural next move: click it again.
 *
 * This page already renders an error banner for every other failed call on it; the fix is to use
 * it, so a delete fails the same way a gallery load does.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { deleteAvatarVisual, gallery } = vi.hoisted(() => ({
  deleteAvatarVisual: vi.fn(),
  gallery: { items: [] as unknown[] },
}));

// AdminShell pulls AdminNav, which needs an App Router context and initialises Firebase at import
// time. Neither is under test here (same reason as avatarGalleryFrames.test.tsx).
vi.mock('../components/AdminShell', () => ({
  AdminShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('../lib/avatarAdminApi', () => ({
  getAvatarConfig: vi.fn(async () => ({
    anam_configured: true, anam_api_key: true, persona_einstein: true, persona_darwin: true,
    persona_napoleon: false, persona_archimedes: false, openai: true,
    default_character: 'einstein', characters: ['einstein'], byok_enabled: false,
  })),
  getAvatarStats: vi.fn(async () => ({
    total_visuals: 1, by_type: {}, by_scope: {}, by_source: {}, conversation_turns: 0, profiles: 0,
  })),
  getAvatarGallery: vi.fn(async () => ({
    items: gallery.items, total: gallery.items.length, page: 1, typeCounts: {},
  })),
  getAvatarConversations: vi.fn(async () => ({ sessions: [] })),
  deleteAvatarVisual,
  setAvatarByok: vi.fn(async () => ({ byok_enabled: false })),
  patchAvatarVisual: vi.fn(async () => ({ ok: true })),
}));

import AvatarAdminPage from '../app/avatar/page';

/** Rejections that escaped the page — what the browser console would have been left holding. */
let escaped: unknown[] = [];

function galleryItem(over: Record<string, unknown> = {}) {
  return {
    id: 'vis-1', project_id: 'proj-1', project_title: 'Proj', scope: 'extended', source: 'generated',
    character_id: 'einstein', visual_type: 'image', caption: 'a pendulum', alt_text: null,
    image_url: null, sim_entry_url: null, visual_spec: null, use_count: 3,
    created_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

beforeEach(() => {
  escaped = [];
  gallery.items = [galleryItem()];
  deleteAvatarVisual.mockReset();
  // jsdom throws "not implemented" for confirm(); the admin always says yes here.
  vi.stubGlobal('confirm', vi.fn(() => true));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  process.on('unhandledRejection', collect);
});

function collect(reason: unknown) { escaped.push(reason); }

afterEach(() => {
  process.off('unhandledRejection', collect);
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('admin avatar gallery — delete', () => {
  it('surfaces the failure and keeps the row when the delete is rejected', async () => {
    deleteAvatarVisual.mockRejectedValue(new Error('403 forbidden'));

    render(<AvatarAdminPage />);
    await screen.findByText('a pendulum');

    fireEvent.click(screen.getByRole('button', { name: /^Delete$/ }));

    await waitFor(() => { expect(deleteAvatarVisual).toHaveBeenCalledWith('vis-1'); });
    // The admin is told what happened…
    const banner = await screen.findByText(/Could not delete/i);
    expect(banner.textContent).toMatch(/403 forbidden/);
    // …and the row is still there, which is the truth.
    expect(screen.getByText('a pendulum')).toBeTruthy();
    // Nothing was left for the runtime to complain about after the fact.
    await waitFor(() => { expect(escaped).toEqual([]); });
  });

  it('removes the row and says nothing when the delete succeeds', async () => {
    deleteAvatarVisual.mockResolvedValue({ ok: true });

    render(<AvatarAdminPage />);
    await screen.findByText('a pendulum');

    fireEvent.click(screen.getByRole('button', { name: /^Delete$/ }));

    await waitFor(() => { expect(screen.queryByText('a pendulum')).toBeNull(); });
    expect(screen.queryByText(/Could not delete/i)).toBeNull();
  });

  it('does not call the API at all when the admin cancels the confirm', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false));

    render(<AvatarAdminPage />);
    await screen.findByText('a pendulum');

    fireEvent.click(screen.getByRole('button', { name: /^Delete$/ }));

    expect(deleteAvatarVisual).not.toHaveBeenCalled();
    expect(screen.getByText('a pendulum')).toBeTruthy();
  });
});
