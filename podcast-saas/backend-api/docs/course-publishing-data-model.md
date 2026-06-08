# Course Publishing Data Model (Phase 1)

Status: **data model only.** Migrations `030_course_publishing.sql` +
`032_course_publishing_hardening.sql`. No publishing services, public routes,
redirects, sitemaps or SEO UI are built yet — this document and its migrations
exist so the model can be reviewed before the rest of the system depends on it.

> **Migration split:** 030 was already applied to environments before the
> hardening review, so it must not be edited in place. 032 upgrades an existing
> 030 schema (tightened archive checks, the `course_lessons (id, project_id)`
> composite unique, and `project_redirect_targets`) and runs right after 030 on
> fresh installs. The Drizzle schema reflects the cumulative (post-032) state.

## Entities

| Table | Role |
|-------|------|
| `courses` | Owns the public URL, publication state, canonical host, course-level SEO and (future) custom-domain config. Has one lesson (single-video course) or many ordered lessons (playlist course). |
| `project_redirect_targets` | The single canonical lesson a legacy project's `/v/<shareToken>` link resolves to (a project can appear in many courses). Composite FK guarantees the target lesson belongs to that project. |
| `course_lessons` | Owns the lesson slug, ordering (`position`) and optional lesson-specific SEO. References the reusable `projects` entity. |
| `projects` | **Unchanged.** The reusable interactive content (video, simulations, avatar, etc.). A project can back lessons in many courses. |
| `course_custom_domains` | Future custom-domain → course mapping. Present now so domains can be added later **without changing** the course/lesson model. |
| `playlists` / `playlist_items` | **Unchanged legacy/editorial entities.** Backfilled into courses; not dropped. |

Relationships:

```
orgs 1───* courses 1───* course_lessons *───1 projects
                  │
                  1───* course_custom_domains

courses.legacy_playlist_id ─▶ playlists.id   (backfill provenance, nullable)
courses.legacy_project_id  ─▶ projects.id    (backfill provenance, nullable)
```

A **single-video course** = a `courses` row (`kind='single'`) with exactly one
`course_lessons` row. A **playlist course** = a `courses` row (`kind='playlist'`)
with multiple ordered `course_lessons` rows. The same `projects` row may be the
`project_id` of lessons in different courses (reuse) — but not twice in the same
course.

## Publication state machine

`publish_state` ∈ `draft | unlisted | published | archived` (separate from the
pipeline `projects.status`).

`archived` is refined by `archive_disposition` so the later renderer can
distinguish three cases (Phase 1 only stores them; HTTP behaviour comes later):

| disposition | meaning | later HTTP |
|-------------|---------|-----------|
| `temporary` | temporarily unpublished, may return | 404 |
| `permanent` | permanently removed | 410 Gone |
| `redirect` | replaced; `archived_replacement_url` required | 301 → replacement |

The archive state machine is **fully constrained in the DB** (migration 032):
- `archived` ⇒ `archive_disposition` **and** `archived_at` are required.
- `redirect` ⇒ `archived_replacement_url` is present and non-empty.
- `archived_replacement_url` may exist **only** for `redirect`.
- A non-archived course must hold **no** archive fields
  (`archive_disposition`, `archived_replacement_url`, `archived_at` all `NULL`).

Because of that last rule, the **future service layer must clear all archive
fields when a course returns to draft/unlisted/published** — the DB rejects an
"un-archived" row that still carries archive metadata. The same column shape
expresses all three of "temporarily unpublished" (`temporary`), "permanently
archived" (`permanent`) and "archived with replacement" (`redirect`).

Timestamp semantics:
- `created_at` — row creation.
- `updated_at` — last modification (set by the app on write).
- `published_at` — first transition to `published`; kept even if later unpublished.
- `archived_at` — when moved to `archived`; cleared when leaving `archived`.

## Slug strategy (Hebrew & other non-Latin titles)

One rule is shared by the DB CHECK, the zod `SlugSchema`, `SlugService` and the
tests: a slug matches `^[a-z0-9]+(?:-[a-z0-9]+)*$` (ASCII kebab). Generation
precedence (in `SlugService`):

1. **Author-entered slug** (normalised) wins and is kept stable after publication.
2. Otherwise the title is **deterministically transliterated** to Latin
   (Hebrew supported; niqqud stripped) and kebab-cased — e.g. `מבוא לפיזיקה`
   → `mbv-lpyzykh`. Vowelless Hebrew is inherently lossy but stable.
3. **Only** when that yields nothing do we fall back to an id-derived token
   (`c-<id8>` / `l-<id8>`) — never a human placeholder like "untitled".

## Canonical redirect target for reused projects

A project can be a lesson in many courses, so a legacy `/v/<shareToken>` link has
no single obvious destination. `project_redirect_targets` records one canonical
lesson per project. The composite FK `(course_lesson_id, project_id) →
course_lessons (id, project_id)` **guarantees the target belongs to that
project**. The backfill chooses deterministically — published before draft, then
single-video before playlist, then slug, then id — and sets `is_ambiguous=true`
(with `candidate_count`) when more than one *published* candidate exists, rather
than guessing silently. The Phase-2 redirect resolver must still verify the
target course+lesson are **published and indexable** before issuing a permanent
(301) redirect.

## SEO: overrides only, resolved later

All SEO columns (`seo_title`, `seo_description`, `og_*`, `canonical_url`,
`language`, `indexable`, and the lesson equivalents) are **nullable overrides**.
We persist source content and explicit author overrides only — never generated
or placeholder metadata. The effective value is computed at render time by a
resolver (Phase 4) using a deterministic precedence:

```
explicit SEO override  →  course/lesson content field  →  safe branded fallback
```

Lesson `language` / `indexable` default to `NULL` meaning *inherit the course*.

## Canonical host strategy & custom domains

`courses.canonical_host` is `NULL` for the platform default host. Course slug
uniqueness is enforced **per host** via a unique index on
`(COALESCE(canonical_host, '@platform'), slug)`, so the same slug can exist on
different hosts but never twice on one host.

Custom domains live in `course_custom_domains` (hostname unique globally, at most
one `is_primary` per course). The future canonical-URL resolver consults this
table; its absence ⇒ default host. Mapping a domain later requires **no change**
to `courses`/`course_lessons`.

## Constraints & protections (enforced in the DB)

- **Unique course slug** per canonical host (`uniq_courses_host_slug`).
- **Unique lesson slug** within a course (`uniq_lesson_course_slug`).
- **No duplicate project** within a course (`uniq_lesson_course_project`).
- **Ordering integrity**: `uniq_lesson_course_position` (DEFERRABLE, so a single
  transaction can reorder), `position >= 0`.
- **Valid FKs**: lessons → courses (`ON DELETE CASCADE`), lessons → projects
  (`ON DELETE RESTRICT` — a project backing a lesson cannot be deleted; deleting
  a course cascades to its lessons but **never** to projects).
- **Valid publication state** via the `publish_state` enum; the full archive
  state machine (see above) is enforced by five CHECK constraints (migration 032).
- **Canonical redirect target belongs to its project**: composite FK
  `project_redirect_targets (course_lesson_id, project_id) → course_lessons
  (id, project_id)`; one target per project (PK on `project_id`).
- **Slug & language format** checks mirror the shared zod schemas.
- **`learning_outcomes`** must be a JSON array when present.
- **Backfill idempotency**: partial unique indexes on `legacy_playlist_id` and
  `legacy_project_id` (one course per legacy source).

## Backfill mapping rules

Implemented in `src/db/backfill/computeBackfillPlan.ts` (pure, tested) and run by
`src/db/backfill/030_courses.ts` (dry-run by default; `--execute` to write).

1. Every non-empty **playlist** → one course (`kind='playlist'`) with lessons from
   `playlist_items`, positions normalised to `0..n-1`.
2. A **public standalone project** (has `share_token`) → one course
   (`kind='single'`) with a single lesson, **unless** it is already represented by
   a *public* playlist course, or already backfilled. Membership in *private/draft*
   playlists does **not** suppress this — otherwise a public project whose only
   playlist is private would have no public canonical home. Private projects (no
   `share_token`) never get a standalone course.
3. **Visibility preserved, never flipped**: `share_token` present → `published`
   (`published_at` = `share_enabled_at ?? created_at`); absent → `draft`.
4. **Idempotent**: sources already represented by a course (matched on
   `legacy_*_id`) are skipped; reruns create nothing.

   Canonical results for a project `P` that has a `share_token`:
   | case | standalone course? | canonical redirect target |
   |------|--------------------|---------------------------|
   | `P` in a private playlist only | yes (published) | the standalone lesson |
   | `P` in a public playlist | no | the public playlist's lesson |
   | `P` in both private + public | no | the public playlist's lesson |
   | private `P` in a public playlist | no (it is just a lesson) | none (no token) |
5. **Slug collisions** resolved deterministically (`-2`, `-3`, …) and reported.
6. Share tokens, playlists, projects and `playlist_items` are never modified.

Edge cases reported (not silently dropped): empty playlists → conflict (no
course); playlist items pointing at missing projects → conflict (lesson skipped);
per-course insert failure during `--execute` → recorded in the `failed` list
without aborting the run.

## Example rows

### 1. Single-video course (one project, published)

`courses`
```
id:                 11111111-1111-1111-1111-111111111111
org_id:             org-1
kind:               single
title:              "How Neural Networks Learn"
slug:               how-neural-networks-learn
publish_state:      published
published_at:       2025-05-01T10:00:00Z
canonical_host:     NULL              -- platform default host
language:           en
indexable:          true
seo_title:          NULL              -- resolved from title at render time
legacy_project_id:  proj-neural
legacy_playlist_id: NULL
```
`course_lessons`
```
id: l-1  course_id: 1111…  project_id: proj-neural  position: 0  slug: how-neural-networks-learn
```
→ public URL `/c/how-neural-networks-learn` (and the single lesson at
`/c/how-neural-networks-learn/how-neural-networks-learn`).

### 2. Playlist course (multiple ordered lessons)

`courses`
```
id:                 22222222-2222-2222-2222-222222222222
org_id:             org-1
kind:               playlist
title:              "Intro to Quantum Computing"
slug:               intro-to-quantum-computing
description:        "A 3-part interactive series."
publish_state:      published
published_at:       2025-04-10T09:00:00Z
legacy_playlist_id: pl-quantum
legacy_project_id:  NULL
```
`course_lessons`
```
id: l-2  course_id: 2222…  project_id: proj-qubits        position: 0  slug: qubits-and-superposition
id: l-3  course_id: 2222…  project_id: proj-entanglement  position: 1  slug: entanglement
id: l-4  course_id: 2222…  project_id: proj-algorithms    position: 2  slug: quantum-algorithms
```
→ `/c/intro-to-quantum-computing` with lessons at
`/c/intro-to-quantum-computing/qubits-and-superposition`, `/entanglement`,
`/quantum-algorithms`.

### 3. One project reused across two courses

Project `proj-linear-algebra` is lesson 1 of a "Math Foundations" course and also
a lesson of an "ML Prerequisites" course. Two `course_lessons` rows reference the
same `project_id` under different `course_id`s — allowed (uniqueness is
per-course). Deleting either course removes only its lesson row; the project
survives (and the other course keeps using it).

```
course_lessons
  id: l-5  course_id: aaaa… (Math Foundations)  project_id: proj-linear-algebra  position: 1  slug: linear-algebra
  id: l-6  course_id: bbbb… (ML Prerequisites)  project_id: proj-linear-algebra  position: 0  slug: linear-algebra-basics
```

Attempting to add `proj-linear-algebra` a *second* time to the **same** course is
rejected by `uniq_lesson_course_project`.

## Rollback

Roll back in reverse order — **032 first, then 030** (032 depends on 030). Neither
touches `projects`, `playlists`, `playlist_items` or share tokens, so the legacy
public surface keeps working. Re-running the backfill after a rollback + re-migrate
reproduces courses/lessons but **not** author SEO edits — back up
`courses`/`course_lessons` first if those exist.
```
psql "$DATABASE_URL" -f src/db/migrations/032_course_publishing_hardening.rollback.sql
DELETE FROM schema_migrations WHERE filename = '032_course_publishing_hardening.sql';
psql "$DATABASE_URL" -f src/db/migrations/030_course_publishing.rollback.sql
DELETE FROM schema_migrations WHERE filename = '030_course_publishing.sql';
```
(`032`'s rollback also restores the original 030 archive checks, so rolling back
only 032 leaves a valid 030 schema.)
