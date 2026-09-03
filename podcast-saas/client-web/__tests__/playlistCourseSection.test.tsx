/**
 * The playlist editor's course section: publish, the public address once published, update and
 * unpublish, the readiness reasons, and nothing to publish with an empty playlist.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlaylistCourseState } from 'shared/src/generated/client-v1';

const calls = vi.hoisted(() => ({
  state: null as PlaylistCourseState | null,
  publish: [] as Array<{ publish: boolean; slug?: string | null }>,
  unpublish: 0,
  slugChecks: [] as Array<[string, string | undefined]>,
}));

vi.mock('../lib/api', () => ({
  api: {
    getPlaylistCourse: async () => calls.state ?? { course: null, item_count: 0, readiness: null },
    publishPlaylistCourse: async (_id: string, body: { publish: boolean; slug?: string | null }) => {
      calls.publish.push(body);
      const slug = body.slug || 'chaos';
      calls.state = { course: { id: 'c1', slug, publish_state: body.publish ? 'published' : 'draft', published_at: null, lesson_count: 2, public_path: `/c/${slug}` }, item_count: 2, readiness: { ready: true, thinLessons: [] } };
      return calls.state;
    },
    courseSlugAvailable: async (slug: string, excludeId?: string) => {
      calls.slugChecks.push([slug, excludeId]);
      const normalized = slug.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      return { available: normalized !== 'taken', normalized };
    },
    unpublishPlaylistCourse: async () => {
      calls.unpublish += 1;
      calls.state = { course: { id: 'c1', slug: 'chaos', publish_state: 'draft', published_at: null, lesson_count: 2, public_path: '/c/chaos' }, item_count: 2, readiness: null };
      return calls.state;
    },
  },
}));

import { PlaylistCourseSection } from '../components/PlaylistCourseSection';

beforeEach(() => { calls.state = null; calls.publish.length = 0; calls.unpublish = 0; calls.slugChecks.length = 0; });
afterEach(cleanup);

describe('PlaylistCourseSection', () => {
  it('publishes the playlist as a course and shows the public address', async () => {
    render(<PlaylistCourseSection playlistId="pl-1" itemCount={2} />);
    const button = await screen.findByRole('button', { name: /Publish as course/ });
    fireEvent.click(button);
    await waitFor(() => expect(calls.publish).toEqual([{ publish: true, slug: null }]));
    expect(await screen.findByText(/Published as a course with 2 lessons/)).toBeTruthy();
    const link = screen.getByRole('link', { name: /\/c\/chaos/ });
    expect(link.getAttribute('href')).toBe(`${window.location.origin}/c/chaos`);
    expect(screen.getByRole('button', { name: 'Update course' })).toBeTruthy();
  });

  it('a published course can be updated (re-synced) and unpublished', async () => {
    calls.state = { course: { id: 'c1', slug: 'chaos', publish_state: 'published', published_at: '2026-09-03T12:00:00.000Z', lesson_count: 2, public_path: '/c/chaos' }, item_count: 2, readiness: { ready: true, thinLessons: [] } };
    render(<PlaylistCourseSection playlistId="pl-1" itemCount={2} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Update course' }));
    await waitFor(() => expect(calls.publish).toEqual([{ publish: true, slug: 'chaos' }]));
    fireEvent.click(screen.getByRole('button', { name: 'Unpublish' }));
    await waitFor(() => expect(calls.unpublish).toBe(1));
    expect(await screen.findByText(/A course draft exists/)).toBeTruthy();
  });

  it('with no videos the publish button is disabled', async () => {
    render(<PlaylistCourseSection playlistId="pl-1" itemCount={0} />);
    const button = await screen.findByRole('button', { name: /Publish as course/ });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('the address field checks availability a moment after typing, and the chosen slug is sent', async () => {
    render(<PlaylistCourseSection playlistId="pl-1" itemCount={2} />);
    const field = await screen.findByLabelText('Course address');
    fireEvent.change(field, { target: { value: 'Chaos Theory' } });
    expect(await screen.findByText('available as chaos-theory', {}, { timeout: 2000 })).toBeTruthy();
    expect(calls.slugChecks).toEqual([['Chaos Theory', undefined]]);
    fireEvent.change(field, { target: { value: 'taken' } });
    expect(await screen.findByText('taken is taken', {}, { timeout: 2000 })).toBeTruthy();
    fireEvent.change(field, { target: { value: 'chaos-theory' } });
    fireEvent.click(screen.getByRole('button', { name: /Publish as course/ }));
    await waitFor(() => expect(calls.publish.at(-1)).toEqual({ publish: true, slug: 'chaos-theory' }));
    expect(await screen.findByRole('link', { name: /\/c\/chaos-theory/ })).toBeTruthy();
  });

  it('shows why a draft cannot publish yet', async () => {
    calls.state = { course: { id: 'c1', slug: 'chaos', publish_state: 'draft', published_at: null, lesson_count: 2, public_path: '/c/chaos' }, item_count: 2, readiness: { ready: false, thinLessons: [{ lessonSlug: 'intro', reason: 'no transcript' }] } };
    render(<PlaylistCourseSection playlistId="pl-1" itemCount={2} />);
    expect(await screen.findByText(/intro: no transcript/)).toBeTruthy();
  });
});
