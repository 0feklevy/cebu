/**
 * The listener's side of the inbox: the creator's replies reach the episode as markers on the
 * progress bar and a sheet — and their absence changes nothing.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioEditionView } from '../lib/audioEditionApi';

const replies = vi.hoisted(() => ({ list: [] as Array<{ id: string; position_ms: number; question: string; reply: string; replied_at: string }>, asked: [] as Array<[string, string | null | undefined]> }));

vi.mock('../lib/audioEditionApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/audioEditionApi')>()),
  listCreatorReplies: async (slug: string, language?: string | null) => { replies.asked.push([slug, language]); return replies.list; },
}));

import { AudioEditionPlayer } from '../components/audio/AudioEditionPlayer';

const view: AudioEditionView = {
  title: 'Flocking', description: null, audio_url: 'https://cdn.example/flocking.m4a', duration_ms: 600_000,
  chapters: [], captions_url: null, language: 'he', updated_at: '2026-09-03T00:00:00.000Z', artwork_url: null,
};

beforeEach(() => {
  replies.list = [{ id: 'r1', position_ms: 300_000, question: 'Why do they turn together?', reply: 'Each bird follows seven neighbours.', replied_at: '2026-09-03T11:00:00.000Z' }];
  replies.asked.length = 0;
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('creator replies in the car-mode player', () => {
  it('asks for the episode’s replies in its language and marks each one on the bar', async () => {
    render(<AudioEditionPlayer view={view} slug="flocking" artworkUrl={null} />);
    const marker = await screen.findByRole('button', { name: 'Creator replied at 05:00' });
    expect(replies.asked).toEqual([['flocking', 'he']]);
    expect(marker.style.left).toBe('50%');
    expect(screen.getByRole('button', { name: 'Replies (1)' })).toBeTruthy();
  });

  it('opens the replies sheet from a marker, with the question and the creator’s words', async () => {
    render(<AudioEditionPlayer view={view} slug="flocking" artworkUrl={null} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Creator replied at 05:00' }));
    const sheet = screen.getByRole('dialog', { name: 'Creator replies' });
    expect(sheet.textContent).toContain('Why do they turn together?');
    expect(sheet.textContent).toContain('Each bird follows seven neighbours.');
  });

  it('with no replies there is no marker and no handle', async () => {
    replies.list = [];
    render(<AudioEditionPlayer view={view} slug="flocking" artworkUrl={null} />);
    await Promise.resolve();
    expect(screen.queryByRole('button', { name: /Replies \(/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Creator replied/ })).toBeNull();
  });
});
