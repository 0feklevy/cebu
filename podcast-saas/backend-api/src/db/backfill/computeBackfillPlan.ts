/**
 * computeBackfillPlan — PURE, deterministic mapping from legacy playlists/projects
 * to the new courses + course_lessons model, plus the canonical redirect target
 * for each public project. No DB access; the runner loads rows, calls this, then
 * executes (or, in dry-run, just reports) the plan.
 *
 * ── Mapping rules ─────────────────────────────────────────────────────────────
 *  1. Every non-empty playlist → exactly one course (kind 'playlist') with ordered
 *     lessons from its playlist_items. Positions are normalised to 0..n-1.
 *  2. A project becomes its OWN single-lesson course (kind 'single') when:
 *       - it has a share_token (already public / "published"), AND
 *       - it is NOT already represented by a *public* playlist course, AND
 *       - no course already has legacy_project_id = project.id.
 *     Membership in PRIVATE/draft playlists does NOT suppress this — otherwise a
 *     public project whose only playlist is private would have no public canonical
 *     destination. Private projects (no share_token) never get a standalone course.
 *  3. Visibility is PRESERVED, never flipped:
 *       has share_token → publish_state 'published'; otherwise → 'draft'.
 *  4. Idempotency: a source already represented by a course (legacy_*_id) is
 *     skipped. Safe to rerun.
 *  5. Slug collisions are resolved deterministically (-2, -3, …) and recorded.
 *  6. Canonical redirect target: for every public project, choose ONE lesson its
 *     /v/<shareToken> link should resolve to. Selection is deterministic; if more
 *     than one *published* candidate exists the target is flagged ambiguous.
 *  7. Share tokens, playlists, projects and playlist_items are never modified.
 *
 * ── Canonical results for the key cases (project P has a share_token) ──────────
 *   P in private playlist only      → standalone published single-course created;
 *                                      canonical = that standalone lesson.
 *   P in public playlist            → no standalone course; canonical = the public
 *                                      playlist's lesson for P.
 *   P in both private & public       → no standalone course; canonical = the public
 *                                      playlist's lesson (private playlist also keeps
 *                                      P as a draft lesson, but it is not canonical).
 *   private project in public playlist → appears as a lesson; no standalone course;
 *                                      no redirect target (it has no share token).
 */

import { allocateSlug } from '../../services/seo/SlugService.js';

// ── Input row shapes (minimal projections of the legacy tables) ────────────────

export interface PlaylistRow {
  id: string;
  org_id: string;
  created_by: string | null;
  title: string | null;
  description: string | null;
  banner_url: string | null;
  share_token: string | null;
  share_enabled_at: Date | string | null;
  view_count: number;
  created_at: Date | string;
}

export interface PlaylistItemRow {
  playlist_id: string;
  project_id: string;
  position: number;
}

export interface ProjectRow {
  id: string;
  org_id: string;
  created_by: string | null;
  title: string | null;
  topic: string | null;
  thumbnail_url: string | null;
  share_token: string | null;
  share_enabled_at: Date | string | null;
  view_count: number;
  created_at: Date | string;
}

export interface ExistingCourseRow {
  slug: string;
  canonical_host: string | null;
  legacy_playlist_id: string | null;
  legacy_project_id: string | null;
}

export interface BackfillInput {
  playlists: PlaylistRow[];
  playlistItems: PlaylistItemRow[];
  projects: ProjectRow[];
  existingCourses: ExistingCourseRow[];
}

// ── Output plan shapes ─────────────────────────────────────────────────────────

export type PublishState = 'draft' | 'unlisted' | 'published' | 'archived';

export interface PlannedCourse {
  tempId: string;                    // 'playlist:<id>' | 'project:<id>' — links lessons to this course
  kind: 'single' | 'playlist';
  orgId: string;
  createdBy: string | null;
  title: string | null;
  description: string | null;
  coverImageUrl: string | null;
  publishState: PublishState;
  publishedAt: Date | string | null;
  slug: string;
  slugCollided: boolean;
  legacyPlaylistId: string | null;
  legacyProjectId: string | null;
  viewCount: number;
}

export interface PlannedLesson {
  courseTempId: string;
  projectId: string;
  position: number;
  slug: string;
  slugCollided: boolean;
}

/** Canonical lesson a public project's /v link should redirect to. */
export interface PlannedRedirectTarget {
  projectId: string;
  courseTempId: string;   // course whose lesson for this project is canonical
  ambiguous: boolean;     // >1 published candidate existed
  candidateCount: number; // total candidate lessons considered
}

export interface SkippedItem {
  type: 'playlist' | 'project';
  id: string;
  reason: string;
}

export interface ConflictItem {
  type: 'playlist' | 'project' | 'playlist_item';
  id: string;
  detail: string;
}

export interface BackfillPlan {
  coursesToCreate: PlannedCourse[];
  lessonsToCreate: PlannedLesson[];
  redirectTargets: PlannedRedirectTarget[];
  skipped: SkippedItem[];
  conflicts: ConflictItem[];
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const asTime = (d: Date | string): number => (d instanceof Date ? d.getTime() : new Date(d).getTime());

/** Stable order: oldest first, id as tie-break — makes slug allocation deterministic. */
function byCreatedThenId<T extends { created_at: Date | string; id: string }>(a: T, b: T): number {
  const t = asTime(a.created_at) - asTime(b.created_at);
  return t !== 0 ? t : a.id.localeCompare(b.id);
}

interface CourseCandidate {
  tempId: string;
  publishState: PublishState;
  kind: 'single' | 'playlist';
  slug: string;
}

// ── Plan computation ───────────────────────────────────────────────────────────

export function computeBackfillPlan(input: BackfillInput): BackfillPlan {
  const plan: BackfillPlan = {
    coursesToCreate: [], lessonsToCreate: [], redirectTargets: [], skipped: [], conflicts: [],
  };

  // Idempotency: sources already represented by a course.
  const backfilledPlaylistIds = new Set(
    input.existingCourses.map((c) => c.legacy_playlist_id).filter((x): x is string => !!x),
  );
  const backfilledProjectIds = new Set(
    input.existingCourses.map((c) => c.legacy_project_id).filter((x): x is string => !!x),
  );

  // Course slugs already taken on the default host (sentinel-free — backfilled
  // courses all use the platform default host).
  const takenCourseSlugs = new Set(
    input.existingCourses.filter((c) => (c.canonical_host ?? null) === null).map((c) => c.slug),
  );

  const projectsById = new Map(input.projects.map((p) => [p.id, p]));

  // Index playlist items by playlist.
  const itemsByPlaylist = new Map<string, PlaylistItemRow[]>();
  for (const item of input.playlistItems) {
    if (!itemsByPlaylist.has(item.playlist_id)) itemsByPlaylist.set(item.playlist_id, []);
    itemsByPlaylist.get(item.playlist_id)!.push(item);
  }

  // A project is "represented by a public playlist course" when it is a member of
  // a non-empty playlist that has a share_token (→ becomes a published course).
  const projectsInPublicPlaylistCourse = new Set<string>();
  for (const pl of input.playlists) {
    if (!pl.share_token) continue;
    for (const item of itemsByPlaylist.get(pl.id) ?? []) projectsInPublicPlaylistCourse.add(item.project_id);
  }

  // Track, per project, the candidate courses that contain a lesson for it (used
  // to choose the canonical redirect target).
  const candidatesByProject = new Map<string, CourseCandidate[]>();
  const addCandidate = (projectId: string, c: CourseCandidate) => {
    if (!candidatesByProject.has(projectId)) candidatesByProject.set(projectId, []);
    candidatesByProject.get(projectId)!.push(c);
  };

  // ── 1. Playlists → playlist courses ──────────────────────────────────────────
  for (const pl of [...input.playlists].sort(byCreatedThenId)) {
    if (backfilledPlaylistIds.has(pl.id)) {
      plan.skipped.push({ type: 'playlist', id: pl.id, reason: 'already backfilled (course exists)' });
      continue;
    }

    const items = (itemsByPlaylist.get(pl.id) ?? [])
      .slice()
      .sort((a, b) => (a.position - b.position) || a.project_id.localeCompare(b.project_id));

    if (items.length === 0) {
      plan.conflicts.push({ type: 'playlist', id: pl.id, detail: 'playlist has no items — no course created' });
      continue;
    }

    const isPublic = !!pl.share_token;
    const publishState: PublishState = isPublic ? 'published' : 'draft';
    const tempId = `playlist:${pl.id}`;
    const slug = allocateSlug(pl.title, pl.id, takenCourseSlugs, 'c');

    plan.coursesToCreate.push({
      tempId, kind: 'playlist', orgId: pl.org_id, createdBy: pl.created_by,
      title: pl.title, description: pl.description, coverImageUrl: pl.banner_url,
      publishState, publishedAt: isPublic ? (pl.share_enabled_at ?? pl.created_at) : null,
      slug: slug.slug, slugCollided: slug.collided,
      legacyPlaylistId: pl.id, legacyProjectId: null, viewCount: pl.view_count,
    });

    const takenLessonSlugs = new Set<string>();
    let pos = 0;
    for (const item of items) {
      const proj = projectsById.get(item.project_id);
      if (!proj) {
        plan.conflicts.push({
          type: 'playlist_item', id: `${pl.id}/${item.project_id}`,
          detail: 'playlist item references a missing project — lesson skipped',
        });
        continue;
      }
      const lessonSlug = allocateSlug(proj.title ?? proj.topic, proj.id, takenLessonSlugs, 'l');
      plan.lessonsToCreate.push({
        courseTempId: tempId, projectId: proj.id, position: pos++,
        slug: lessonSlug.slug, slugCollided: lessonSlug.collided,
      });
      addCandidate(proj.id, { tempId, publishState, kind: 'playlist', slug: slug.slug });
    }
  }

  // ── 2. Standalone published projects → single-lesson courses ─────────────────
  for (const proj of [...input.projects].sort(byCreatedThenId)) {
    if (backfilledProjectIds.has(proj.id)) {
      plan.skipped.push({ type: 'project', id: proj.id, reason: 'already backfilled (course exists)' });
      continue;
    }
    if (!proj.share_token) {
      plan.skipped.push({ type: 'project', id: proj.id, reason: 'private standalone project — no public presence' });
      continue;
    }
    if (projectsInPublicPlaylistCourse.has(proj.id)) {
      plan.skipped.push({ type: 'project', id: proj.id, reason: 'represented by a public playlist course' });
      continue;
    }

    const tempId = `project:${proj.id}`;
    const slug = allocateSlug(proj.title ?? proj.topic, proj.id, takenCourseSlugs, 'c');
    plan.coursesToCreate.push({
      tempId, kind: 'single', orgId: proj.org_id, createdBy: proj.created_by,
      title: proj.title, description: proj.topic, coverImageUrl: proj.thumbnail_url,
      publishState: 'published', publishedAt: proj.share_enabled_at ?? proj.created_at,
      slug: slug.slug, slugCollided: slug.collided,
      legacyPlaylistId: null, legacyProjectId: proj.id, viewCount: proj.view_count,
    });

    const lessonSlug = allocateSlug(proj.title ?? proj.topic, proj.id, new Set<string>(), 'l');
    plan.lessonsToCreate.push({
      courseTempId: tempId, projectId: proj.id, position: 0,
      slug: lessonSlug.slug, slugCollided: lessonSlug.collided,
    });
    addCandidate(proj.id, { tempId, publishState: 'published', kind: 'single', slug: slug.slug });
  }

  // ── 6. Canonical redirect target per PUBLIC project ──────────────────────────
  // Only public projects (with a share_token) need a /v redirect destination.
  for (const proj of [...input.projects].sort(byCreatedThenId)) {
    if (!proj.share_token) continue;
    const candidates = candidatesByProject.get(proj.id);
    if (!candidates || candidates.length === 0) continue; // only existing-course representation → leave prior target

    // Deterministic ranking: published first, then single over playlist, then slug, then tempId.
    const ranked = [...candidates].sort((a, b) =>
      (a.publishState === 'published' ? 0 : 1) - (b.publishState === 'published' ? 0 : 1)
      || (a.kind === 'single' ? 0 : 1) - (b.kind === 'single' ? 0 : 1)
      || a.slug.localeCompare(b.slug)
      || a.tempId.localeCompare(b.tempId),
    );
    const publishedCount = candidates.filter((c) => c.publishState === 'published').length;
    plan.redirectTargets.push({
      projectId: proj.id,
      courseTempId: ranked[0].tempId,
      ambiguous: publishedCount > 1,
      candidateCount: candidates.length,
    });
  }

  return plan;
}
