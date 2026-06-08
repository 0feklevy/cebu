/**
 * Pure mapping-rule tests for the course backfill. No DB — these pin down the
 * exact, deterministic rules: playlist→course, standalone-project→course,
 * visibility preservation, slug collisions, project reuse and idempotency.
 */

import { describe, it, expect } from 'vitest';
import {
  computeBackfillPlan,
  type BackfillInput,
  type PlaylistRow,
  type ProjectRow,
} from '../computeBackfillPlan.js';

const T0 = new Date('2025-01-01T00:00:00Z');
const T1 = new Date('2025-02-01T00:00:00Z');

function playlist(over: Partial<PlaylistRow> & { id: string }): PlaylistRow {
  return {
    id: over.id, org_id: 'org-1', created_by: 'user-1', title: 'Playlist', description: null,
    banner_url: null, share_token: null, share_enabled_at: null, view_count: 0, created_at: T0,
    ...over,
  };
}
function project(over: Partial<ProjectRow> & { id: string }): ProjectRow {
  return {
    id: over.id, org_id: 'org-1', created_by: 'user-1', title: 'Project', topic: null,
    thumbnail_url: null, share_token: null, share_enabled_at: null, view_count: 0, created_at: T0,
    ...over,
  };
}
function input(over: Partial<BackfillInput>): BackfillInput {
  return { playlists: [], playlistItems: [], projects: [], existingCourses: [], ...over };
}

describe('computeBackfillPlan — playlist mapping', () => {
  it('maps a playlist to one playlist-course with ordered, normalised lessons', () => {
    const plan = computeBackfillPlan(input({
      playlists: [playlist({ id: 'pl-1', title: 'Quantum 101', share_token: 'tok' })],
      projects: [project({ id: 'pr-a', title: 'Intro' }), project({ id: 'pr-b', title: 'Spin' })],
      playlistItems: [
        { playlist_id: 'pl-1', project_id: 'pr-b', position: 10 },
        { playlist_id: 'pl-1', project_id: 'pr-a', position: 5 },
      ],
    }));

    expect(plan.coursesToCreate).toHaveLength(1);
    const course = plan.coursesToCreate[0];
    expect(course.kind).toBe('playlist');
    expect(course.slug).toBe('quantum-101');
    expect(course.legacyPlaylistId).toBe('pl-1');

    // Sorted by source position, positions normalised to 0..n-1.
    expect(plan.lessonsToCreate.map((l) => [l.projectId, l.position])).toEqual([
      ['pr-a', 0],
      ['pr-b', 1],
    ]);
  });

  it('preserves visibility: public playlist → published, private → draft', () => {
    const plan = computeBackfillPlan(input({
      playlists: [
        playlist({ id: 'pub', title: 'Public', share_token: 'tok', share_enabled_at: T1 }),
        playlist({ id: 'prv', title: 'Private', share_token: null }),
      ],
      projects: [project({ id: 'pr-a' })],
      playlistItems: [
        { playlist_id: 'pub', project_id: 'pr-a', position: 0 },
        { playlist_id: 'prv', project_id: 'pr-a', position: 0 },
      ],
    }));
    const pub = plan.coursesToCreate.find((c) => c.legacyPlaylistId === 'pub')!;
    const prv = plan.coursesToCreate.find((c) => c.legacyPlaylistId === 'prv')!;
    expect(pub.publishState).toBe('published');
    expect(pub.publishedAt).toBe(T1);
    expect(prv.publishState).toBe('draft');
    expect(prv.publishedAt).toBeNull();
  });

  it('flags an empty playlist as a conflict and creates no course', () => {
    const plan = computeBackfillPlan(input({ playlists: [playlist({ id: 'pl-empty' })] }));
    expect(plan.coursesToCreate).toHaveLength(0);
    expect(plan.conflicts).toEqual([
      { type: 'playlist', id: 'pl-empty', detail: expect.stringContaining('no items') },
    ]);
  });

  it('flags a playlist item with a missing project as a conflict, keeps the rest', () => {
    const plan = computeBackfillPlan(input({
      playlists: [playlist({ id: 'pl-1', share_token: 'tok' })],
      projects: [project({ id: 'pr-a', title: 'A' })],
      playlistItems: [
        { playlist_id: 'pl-1', project_id: 'pr-a', position: 0 },
        { playlist_id: 'pl-1', project_id: 'ghost', position: 1 },
      ],
    }));
    expect(plan.lessonsToCreate.map((l) => l.projectId)).toEqual(['pr-a']);
    expect(plan.conflicts[0]).toMatchObject({ type: 'playlist_item', detail: expect.stringContaining('missing project') });
  });
});

describe('computeBackfillPlan — standalone projects', () => {
  it('creates a single-lesson course for a published standalone project', () => {
    const plan = computeBackfillPlan(input({
      projects: [project({ id: 'pr-x', title: 'Solo Lesson', share_token: 'tok' })],
    }));
    expect(plan.coursesToCreate).toHaveLength(1);
    expect(plan.coursesToCreate[0]).toMatchObject({ kind: 'single', publishState: 'published', legacyProjectId: 'pr-x', slug: 'solo-lesson' });
    expect(plan.lessonsToCreate).toEqual([
      expect.objectContaining({ projectId: 'pr-x', position: 0, slug: 'solo-lesson' }),
    ]);
  });

  it('skips a private standalone project (never silently made public)', () => {
    const plan = computeBackfillPlan(input({ projects: [project({ id: 'pr-x', share_token: null })] }));
    expect(plan.coursesToCreate).toHaveLength(0);
    expect(plan.skipped).toEqual([{ type: 'project', id: 'pr-x', reason: expect.stringContaining('private standalone') }]);
  });

  it('skips a public project already represented by a PUBLIC playlist course', () => {
    const plan = computeBackfillPlan(input({
      playlists: [playlist({ id: 'pl-1', share_token: 'tok' })],
      projects: [project({ id: 'pr-a', title: 'A', share_token: 'tok-a' })],
      playlistItems: [{ playlist_id: 'pl-1', project_id: 'pr-a', position: 0 }],
    }));
    expect(plan.coursesToCreate.filter((c) => c.legacyProjectId === 'pr-a')).toHaveLength(0);
    expect(plan.skipped).toContainEqual({ type: 'project', id: 'pr-a', reason: expect.stringContaining('public playlist course') });
  });
});

// The four cases from the hardening review, with documented canonical results.
describe('computeBackfillPlan — public project vs playlist visibility (Item 2)', () => {
  it('public project in a PRIVATE playlist only → standalone published course is created (its canonical home)', () => {
    const plan = computeBackfillPlan(input({
      playlists: [playlist({ id: 'pl-priv', title: 'Private', share_token: null })],
      projects: [project({ id: 'pr-x', title: 'Public Lesson', share_token: 'tok' })],
      playlistItems: [{ playlist_id: 'pl-priv', project_id: 'pr-x', position: 0 }],
    }));
    const standalone = plan.coursesToCreate.find((c) => c.legacyProjectId === 'pr-x');
    expect(standalone).toMatchObject({ kind: 'single', publishState: 'published' });
    // It still also appears as a (draft) lesson in the private playlist course.
    const privCourse = plan.coursesToCreate.find((c) => c.legacyPlaylistId === 'pl-priv')!;
    expect(privCourse.publishState).toBe('draft');
    // Canonical redirect target = the standalone (published, single) course.
    const rt = plan.redirectTargets.find((r) => r.projectId === 'pr-x')!;
    expect(rt.courseTempId).toBe('project:pr-x');
    expect(rt.ambiguous).toBe(false);
  });

  it('public project in a PUBLIC playlist → no standalone course; canonical = the playlist lesson', () => {
    const plan = computeBackfillPlan(input({
      playlists: [playlist({ id: 'pl-pub', title: 'Public', share_token: 'pub' })],
      projects: [project({ id: 'pr-x', title: 'X', share_token: 'tok' })],
      playlistItems: [{ playlist_id: 'pl-pub', project_id: 'pr-x', position: 0 }],
    }));
    expect(plan.coursesToCreate.filter((c) => c.legacyProjectId === 'pr-x')).toHaveLength(0);
    const rt = plan.redirectTargets.find((r) => r.projectId === 'pr-x')!;
    expect(rt.courseTempId).toBe('playlist:pl-pub');
    expect(rt.ambiguous).toBe(false);
  });

  it('public project in BOTH a private and a public playlist → no standalone; canonical = public playlist lesson', () => {
    const plan = computeBackfillPlan(input({
      playlists: [
        playlist({ id: 'pl-priv', title: 'Private', share_token: null }),
        playlist({ id: 'pl-pub', title: 'Public', share_token: 'pub' }),
      ],
      projects: [project({ id: 'pr-x', title: 'X', share_token: 'tok' })],
      playlistItems: [
        { playlist_id: 'pl-priv', project_id: 'pr-x', position: 0 },
        { playlist_id: 'pl-pub', project_id: 'pr-x', position: 0 },
      ],
    }));
    expect(plan.coursesToCreate.filter((c) => c.legacyProjectId === 'pr-x')).toHaveLength(0);
    const rt = plan.redirectTargets.find((r) => r.projectId === 'pr-x')!;
    expect(rt.courseTempId).toBe('playlist:pl-pub');           // published candidate wins over draft
    expect(rt.ambiguous).toBe(false);                          // only one PUBLISHED candidate
    expect(rt.candidateCount).toBe(2);
  });

  it('private project in a PUBLIC playlist → appears as a lesson, no standalone course, no redirect target', () => {
    const plan = computeBackfillPlan(input({
      playlists: [playlist({ id: 'pl-pub', title: 'Public', share_token: 'pub' })],
      projects: [project({ id: 'pr-priv', title: 'Private', share_token: null })],
      playlistItems: [{ playlist_id: 'pl-pub', project_id: 'pr-priv', position: 0 }],
    }));
    expect(plan.coursesToCreate.filter((c) => c.legacyProjectId === 'pr-priv')).toHaveLength(0);
    expect(plan.lessonsToCreate.some((l) => l.projectId === 'pr-priv')).toBe(true);
    expect(plan.redirectTargets.find((r) => r.projectId === 'pr-priv')).toBeUndefined();
    expect(plan.skipped).toContainEqual({ type: 'project', id: 'pr-priv', reason: expect.stringContaining('private standalone') });
  });

  it('flags an ambiguous canonical target when a public project is in two public playlists', () => {
    const plan = computeBackfillPlan(input({
      playlists: [
        playlist({ id: 'pl-a', title: 'A', share_token: 'a', created_at: T0 }),
        playlist({ id: 'pl-b', title: 'B', share_token: 'b', created_at: T1 }),
      ],
      projects: [project({ id: 'pr-x', title: 'X', share_token: 'tok' })],
      playlistItems: [
        { playlist_id: 'pl-a', project_id: 'pr-x', position: 0 },
        { playlist_id: 'pl-b', project_id: 'pr-x', position: 0 },
      ],
    }));
    const rt = plan.redirectTargets.find((r) => r.projectId === 'pr-x')!;
    expect(rt.ambiguous).toBe(true);
    expect(rt.candidateCount).toBe(2);
    // Deterministic winner: both published playlists, tie broken by slug → 'a'.
    expect(rt.courseTempId).toBe('playlist:pl-a');
  });
});

describe('computeBackfillPlan — slug collisions', () => {
  it('deterministically suffixes colliding course slugs and records the collision', () => {
    const plan = computeBackfillPlan(input({
      playlists: [
        playlist({ id: 'pl-1', title: 'Same Title', share_token: 'a', created_at: T0 }),
        playlist({ id: 'pl-2', title: 'Same Title', share_token: 'b', created_at: T1 }),
      ],
      projects: [project({ id: 'pr-a' })],
      playlistItems: [
        { playlist_id: 'pl-1', project_id: 'pr-a', position: 0 },
        { playlist_id: 'pl-2', project_id: 'pr-a', position: 0 },
      ],
    }));
    const slugs = plan.coursesToCreate.map((c) => c.slug).sort();
    expect(slugs).toEqual(['same-title', 'same-title-2']);
    expect(plan.coursesToCreate.find((c) => c.slug === 'same-title-2')!.slugCollided).toBe(true);
  });

  it('avoids colliding with slugs of already-existing courses', () => {
    const plan = computeBackfillPlan(input({
      playlists: [playlist({ id: 'pl-1', title: 'Taken', share_token: 'a' })],
      projects: [project({ id: 'pr-a' })],
      playlistItems: [{ playlist_id: 'pl-1', project_id: 'pr-a', position: 0 }],
      existingCourses: [{ slug: 'taken', canonical_host: null, legacy_playlist_id: null, legacy_project_id: null }],
    }));
    expect(plan.coursesToCreate[0].slug).toBe('taken-2');
  });

  it('falls back to an id-derived slug (not a placeholder word) when the title is empty', () => {
    const plan = computeBackfillPlan(input({
      projects: [project({ id: 'abcdef12-0000-0000-0000-000000000000', title: null, topic: null, share_token: 'tok' })],
    }));
    expect(plan.coursesToCreate[0].slug).toMatch(/^c-[a-z0-9]+$/);
  });
});

describe('computeBackfillPlan — project reuse & idempotency', () => {
  it('reuses one project across two playlist-courses as separate lessons', () => {
    const plan = computeBackfillPlan(input({
      playlists: [
        playlist({ id: 'pl-1', title: 'Course One', share_token: 'a' }),
        playlist({ id: 'pl-2', title: 'Course Two', share_token: 'b' }),
      ],
      projects: [project({ id: 'pr-shared', title: 'Shared' })],
      playlistItems: [
        { playlist_id: 'pl-1', project_id: 'pr-shared', position: 0 },
        { playlist_id: 'pl-2', project_id: 'pr-shared', position: 0 },
      ],
    }));
    expect(plan.lessonsToCreate.filter((l) => l.projectId === 'pr-shared')).toHaveLength(2);
    expect(new Set(plan.lessonsToCreate.map((l) => l.courseTempId)).size).toBe(2);
  });

  it('skips sources already backfilled (idempotent rerun)', () => {
    const data = input({
      playlists: [playlist({ id: 'pl-1', title: 'PL', share_token: 'a' })],
      projects: [project({ id: 'pr-a', title: 'A' }), project({ id: 'pr-solo', title: 'Solo', share_token: 'tok' })],
      playlistItems: [{ playlist_id: 'pl-1', project_id: 'pr-a', position: 0 }],
      existingCourses: [
        { slug: 'pl', canonical_host: null, legacy_playlist_id: 'pl-1', legacy_project_id: null },
        { slug: 'solo', canonical_host: null, legacy_playlist_id: null, legacy_project_id: 'pr-solo' },
      ],
    });
    const plan = computeBackfillPlan(data);
    expect(plan.coursesToCreate).toHaveLength(0);
    expect(plan.lessonsToCreate).toHaveLength(0);
    expect(plan.skipped).toContainEqual({ type: 'playlist', id: 'pl-1', reason: expect.stringContaining('already backfilled') });
    expect(plan.skipped).toContainEqual({ type: 'project', id: 'pr-solo', reason: expect.stringContaining('already backfilled') });
  });

  it('is deterministic — same input yields an identical plan', () => {
    const data = input({
      playlists: [playlist({ id: 'pl-1', title: 'A', share_token: 'a' }), playlist({ id: 'pl-2', title: 'A', share_token: 'b' })],
      projects: [project({ id: 'pr-a' }), project({ id: 'pr-b' })],
      playlistItems: [
        { playlist_id: 'pl-1', project_id: 'pr-a', position: 0 },
        { playlist_id: 'pl-2', project_id: 'pr-b', position: 0 },
      ],
    });
    expect(computeBackfillPlan(data)).toEqual(computeBackfillPlan(data));
  });
});
