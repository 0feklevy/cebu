/**
 * The dark-mode guard for the playlist editor, mirroring libraryMiniSite.test.tsx §12.
 *
 * The editor dialog used to hardcode `#6366f1` on the toggles, two `linear-gradient(...#hex)`
 * button backgrounds, and a `#080818` banner gradient — all invisible to the theme. Everything it
 * renders now has to come from palette tokens (or `.btn-gradient`, which is itself token-based),
 * so this asserts the rendered tree carries no hex colour, no inline rgb()/rgba(), and no
 * `text-black/` / `text-white/` utilities that break in one of the two themes.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getPlaylist: vi.fn(),
    listProjects: vi.fn(),
    getPlaylistShare: vi.fn(),
  },
}));

vi.mock('../lib/api', () => ({ api: apiMock }));
// Self-fetching side panels with their own suites; this file is about the dialog's own markup.
vi.mock('../components/LockPriceControl', () => ({ LockPriceControl: () => null }));
vi.mock('../components/PermalinkEditor', () => ({ PermalinkEditor: () => null }));
vi.mock('../components/CollaboratorsSection', () => ({ CollaboratorsSection: () => null }));
vi.mock('../components/PlaylistCourseSection', () => ({ PlaylistCourseSection: () => null }));

import { PlaylistEditorDialog } from '../components/PlaylistEditorDialog';

const PLAYLIST = {
  id: 'pl-1', title: 'Physics 101', description: null,
  autoplay: true, show_sidebar: true, allow_shuffle: true,
  banner_url: null, banner_prompt: null, banner_provider: null,
  // One item with no thumbnail plus an addable project: exercises the placeholder tiles
  // whose `bg-primary/8` used to compile to no background at all.
  items: [{ project_id: 'p1', title: 'Intro', thumbnail_url: null }],
};

beforeEach(() => {
  for (const fn of Object.values(apiMock)) fn.mockReset();
  apiMock.getPlaylist.mockResolvedValue(PLAYLIST);
  apiMock.listProjects.mockResolvedValue([
    { id: 'p2', title: 'Waves', topic: null, thumbnail_url: null },
  ]);
  apiMock.getPlaylistShare.mockResolvedValue({ shareToken: 'tok', shareUrl: 'https://flowvid.test/pl/tok' });
});

afterEach(() => { cleanup(); });

describe('playlist editor — token-only styling', () => {
  /** Hex literals in class names or inline styles — `#fff`, `#6366f1`. */
  const HEX = /#[0-9a-fA-F]{3,8}\b/;

  it('the dialog renders no hex colours, no inline rgb(), and no one-theme text utilities', async () => {
    render(<PlaylistEditorDialog playlistId="pl-1" open onClose={() => {}} onChanged={() => {}} />);
    await screen.findByRole('button', { name: /Save changes/i });

    // The Radix portal puts overlay + content under <body>; assert over the whole portal so the
    // overlay (formerly bg-black/60) is covered too. The delete ConfirmDialog is not open here.
    const html = document.body.innerHTML;
    expect(html.match(HEX)?.[0] ?? null, 'the playlist editor hardcodes a hex colour').toBeNull();
    expect(html, 'the playlist editor hardcodes an rgb()/rgba() colour').not.toMatch(/rgba?\(/);
    expect(html, 'the playlist editor uses text-black/ — broken in dark mode').not.toMatch(/text-black\//);
    expect(html, 'the playlist editor uses text-white/ — broken in light mode').not.toMatch(/text-white\//);
  });
});
