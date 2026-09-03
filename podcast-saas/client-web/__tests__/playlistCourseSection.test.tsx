/**
 * The playlist editor's course section: publish, the public address once published, update and
 * unpublish, the readiness reasons, and nothing to publish with an empty playlist.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlaylistCourseState } from 'shared/src/generated/client-v1';

const calls = vi.hoisted(() => ({
  state: null as PlaylistCourseState | null,
  publish: [] as Array<{ publish: boolean }>,
  unpublish: 0,
}));

vi.mock('../lib/api', () => ({
  api: {
    getPlaylistCourse: async () => calls.state ?? { course: null, item_count: 0, readiness: null },
    publishPlaylistCourse: async (_id: string, body: { publish: boolean }) => {
      calls.publish.push(body);
      calls.state = { course: { id: 'c1', slug: 'chaos', publish_state: body.publish ? 'published' : 'draft', published_at: null, lesson_count: 2, public_path: '/c/chaos' }, item_count: 2, readiness: { ready: true, thinLessons: [] } };
      return calls.state;
    },
    unpublishPlaylistCourse: async () => {
      calls.unpublish += 1;
      calls.state = { course: { id: 'c1', slug: 'chaos', publish_state: 'draft', published_at: null, lesson_count: 2, public_path: '/c/chaos' }, item_count: 2, readiness: null };
      return calls.state;
    },
  },
}));

import { PlaylistCourseSection } from '../components/PlaylistCourseSection';

beforeEach(() => { calls.state = null; calls.publish.length = 0; calls.unpublish = 0; });
afterEach(cleanup);

describe('PlaylistCourseSection', () => {
  it('publishes the playlist as a course and shows the public address', async () => {
    render(<PlaylistCourseSection playlistId="pl-1" itemCount={2} />);
    const button = await screen.findByRole('button', { name: /Publish as course/ });
    fireEvent.click(button);
    await waitFor(() => expect(calls.publish).toEqual([{ publish: true }]));
    expect(await screen.findByText(/Published as a course with 2 lessons/)).toBeTruthy();
    const link = screen.getByRole('link', { name: /\/c\/chaos/ });
    expect(link.getAttribute('href')).toBe(`${window.location.origin}/c/chaos`);
    expect(screen.getByRole('button', { name: 'Update course' })).toBeTruthy();
  });

  it('a published course can be updated (re-synced) and unpublished', async () => {
    calls.state = { course: { id: 'c1', slug: 'chaos', publish_state: 'published', published_at: '2026-09-03T12:00:00.000Z', lesson_count: 2, public_path: '/c/chaos' }, item_count: 2, readiness: { ready: true, thinLessons: [] } };
    render(<PlaylistCourseSection playlistId="pl-1" itemCount={2} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Update course' }));
    await waitFor(() => expect(calls.publish).toEqual([{ publish: true }]));
    fireEvent.click(screen.getByRole('button', { name: 'Unpublish' }));
    await waitFor(() => expect(calls.unpublish).toBe(1));
    expect(await screen.findByText(/A course draft exists/)).toBeTruthy();
  });

  it('with no videos the publish button is disabled', async () => {
    render(<PlaylistCourseSection playlistId="pl-1" itemCount={0} />);
    const button = await screen.findByRole('button', { name: /Publish as course/ });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows why a draft cannot publish yet', async () => {
    calls.state = { course: { id: 'c1', slug: 'chaos', publish_state: 'draft', published_at: null, lesson_count: 2, public_path: '/c/chaos' }, item_count: 2, readiness: { ready: false, thinLessons: [{ lessonSlug: 'intro', reason: 'no transcript' }] } };
    render(<PlaylistCourseSection playlistId="pl-1" itemCount={2} />);
    expect(await screen.findByText(/intro: no transcript/)).toBeTruthy();
  });
});
