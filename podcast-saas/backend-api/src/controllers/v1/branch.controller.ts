import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db } from '../../db/index.js';
import {
  projects, video_files,
  branch_sequences, branch_choice_points, branch_edges, branch_path_events,
} from '../../db/schema.js';
import { eq, and, asc } from 'drizzle-orm';
import { firebaseAuthMiddleware, firebaseAuthOptionalMiddleware } from '../../middleware/firebase-auth.js';
import { editableProject, isCollaborator } from '../../services/collabAccess.js';

// Branching Interactive Videos — authoring CRUD (Phase 2). Editor-gated (owner or
// invited collaborator, migration 042), project-scoped. The viewer reads the graph
// through buildPlayerConfig's `branching` block; these routes are how the editor
// creates/edits it.

const DESTINATION_TYPES = [
  'sequence', 'project', 'playlist', 'external_url',
  'simulation_full', 'quiz', 'back', 'restart', 'end',
] as const;
type DestinationType = (typeof DESTINATION_TYPES)[number];

const BEHAVIORS = ['continue', 'pause', 'loop'] as const;

/** Load a project the requester may edit (owner or collaborator), or send 404. */
async function ownedProject(request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
  const user = request.dbUser!;
  const project = await editableProject(request.params.id, user);
  if (!project) {
    reply.code(404).send({ message: 'Project not found' });
    return null;
  }
  return project;
}

/** Pure graph validation. Returns a list of issues (errors block a clean publish; warnings inform). */
async function validateGraph(projectId: string): Promise<Array<{ level: 'error' | 'warning'; code: string; message: string; sequence_id?: string; edge_id?: string }>> {
  const issues: Array<{ level: 'error' | 'warning'; code: string; message: string; sequence_id?: string; edge_id?: string }> = [];

  const [sequences, choicePoints, edges] = await Promise.all([
    db.query.branch_sequences.findMany({ where: eq(branch_sequences.project_id, projectId) }),
    db.query.branch_choice_points.findMany({ where: eq(branch_choice_points.project_id, projectId) }),
    db.query.branch_edges.findMany({ where: eq(branch_edges.project_id, projectId) }),
  ]);

  if (sequences.length === 0) return issues; // not a branching project

  const seqIds = new Set(sequences.map((s) => s.id));
  const entries = sequences.filter((s) => s.is_entry);
  if (entries.length === 0) issues.push({ level: 'error', code: 'no_entry', message: 'No entry sequence is set.' });
  if (entries.length > 1) issues.push({ level: 'error', code: 'multiple_entries', message: 'More than one entry sequence is set.' });

  const cpBySequence = new Map<string, typeof choicePoints[number]>();
  for (const cp of choicePoints) if (!cpBySequence.has(cp.sequence_id)) cpBySequence.set(cp.sequence_id, cp);
  const edgesByChoicePoint = new Map<string, typeof edges>();
  for (const e of edges) {
    if (!e.choice_point_id) continue;
    const list = edgesByChoicePoint.get(e.choice_point_id) ?? [];
    list.push(e);
    edgesByChoicePoint.set(e.choice_point_id, list);
  }

  // Sequence-edge adjacency (only 'sequence' destinations route in-graph).
  const adjacency = new Map<string, string[]>();
  for (const seq of sequences) {
    const cp = cpBySequence.get(seq.id);
    const outEdges = cp ? (edgesByChoicePoint.get(cp.id) ?? []) : [];
    const targets: string[] = [];
    for (const e of outEdges) {
      if (e.destination_type === 'sequence') {
        if (!e.dest_sequence_id || !seqIds.has(e.dest_sequence_id)) {
          issues.push({ level: 'error', code: 'missing_destination', message: `Edge "${e.label ?? e.id}" points to a sequence that no longer exists.`, sequence_id: seq.id, edge_id: e.id });
        } else {
          targets.push(e.dest_sequence_id);
        }
      }
    }
    adjacency.set(seq.id, targets);

    // Dead end: a sequence with no choice point and no auto/terminal edge.
    if (!cp) {
      const autoEdges = edges.filter((e) => e.project_id === projectId && !e.choice_point_id);
      // (Phase 2: no auto edges yet — flag as a warning so the author knows it ends here.)
      if (autoEdges.length === 0) {
        issues.push({ level: 'warning', code: 'dead_end', message: `Sequence "${seq.label}" has no choices — it ends the experience.`, sequence_id: seq.id });
      }
    } else if ((edgesByChoicePoint.get(cp.id) ?? []).length === 0) {
      issues.push({ level: 'warning', code: 'empty_choice_point', message: `Sequence "${seq.label}" has a decision point with no choices.`, sequence_id: seq.id });
    } else if (cp.default_edge_id && !(edgesByChoicePoint.get(cp.id) ?? []).some((e) => e.id === cp.default_edge_id)) {
      issues.push({ level: 'error', code: 'bad_default_edge', message: `Sequence "${seq.label}" has a default choice that is not one of its choices.`, sequence_id: seq.id });
    }
  }

  // Unreachable sequences (BFS from the single entry, if exactly one).
  if (entries.length === 1) {
    const seen = new Set<string>([entries[0].id]);
    const queue = [entries[0].id];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const next of adjacency.get(cur) ?? []) {
        if (!seen.has(next)) { seen.add(next); queue.push(next); }
      }
    }
    for (const seq of sequences) {
      if (!seen.has(seq.id)) {
        issues.push({ level: 'warning', code: 'unreachable', message: `Sequence "${seq.label}" can't be reached from the start.`, sequence_id: seq.id });
      }
    }
  }

  return issues;
}

export async function registerBranchRoutes(app: FastifyInstance): Promise<void> {
  // ── GET full graph ──────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    '/api/v1/projects/:id/branching',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply) => {
      const project = await ownedProject(request, reply);
      if (!project) return;

      const [sequences, choice_points, edges, videos] = await Promise.all([
        db.query.branch_sequences.findMany({
          where: eq(branch_sequences.project_id, project.id),
          orderBy: [asc(branch_sequences.sort_order), asc(branch_sequences.created_at)],
        }),
        db.query.branch_choice_points.findMany({ where: eq(branch_choice_points.project_id, project.id) }),
        db.query.branch_edges.findMany({
          where: eq(branch_edges.project_id, project.id),
          orderBy: [asc(branch_edges.sort_order), asc(branch_edges.created_at)],
        }),
        db.query.video_files.findMany({
          where: eq(video_files.project_id, project.id),
          orderBy: [asc(video_files.created_at)],
        }),
      ]);

      return reply.send({
        sequences,
        choice_points,
        edges,
        // Only main videos participate in sequences; expose the minimal fields the editor needs.
        videos: videos
          .filter((v) => !v.is_broll)
          .map((v) => ({ id: v.id, filename: v.filename, duration_sec: v.duration_sec, sequence_id: v.sequence_id, sequence_order: v.sequence_order })),
      });
    },
  );

  // ── Sequences ─────────────────────────────────────────────────────────────
  app.post<{ Params: { id: string }; Body: { label?: string; is_entry?: boolean; sort_order?: number; graph_x?: number; graph_y?: number } }>(
    '/api/v1/projects/:id/branch/sequences',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply) => {
      const project = await ownedProject(request, reply);
      if (!project) return;
      const { label, is_entry, sort_order, graph_x, graph_y } = request.body ?? {};

      const existing = await db.query.branch_sequences.findMany({ where: eq(branch_sequences.project_id, project.id) });
      // First sequence becomes the entry automatically so the graph always has a start.
      const makeEntry = is_entry ?? existing.length === 0;

      const seq = await db.transaction(async (tx) => {
        if (makeEntry) {
          await tx.update(branch_sequences).set({ is_entry: false }).where(eq(branch_sequences.project_id, project.id));
        }
        const [row] = await tx.insert(branch_sequences).values({
          project_id: project.id,
          label: label ?? 'Sequence',
          is_entry: makeEntry,
          sort_order: sort_order ?? existing.length,
          graph_x: graph_x ?? 0,
          graph_y: graph_y ?? 0,
        }).returning();
        return row;
      });

      return reply.code(201).send(seq);
    },
  );

  app.patch<{ Params: { id: string; sid: string }; Body: Partial<{ label: string; is_entry: boolean; sort_order: number; graph_x: number; graph_y: number }> }>(
    '/api/v1/projects/:id/branch/sequences/:sid',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply) => {
      const project = await ownedProject(request, reply);
      if (!project) return;
      const existing = await db.query.branch_sequences.findFirst({
        where: and(eq(branch_sequences.id, request.params.sid), eq(branch_sequences.project_id, project.id)),
      });
      if (!existing) return reply.code(404).send({ message: 'Sequence not found' });

      const { is_entry, ...rest } = request.body ?? {};
      const updated = await db.transaction(async (tx) => {
        if (is_entry === true) {
          await tx.update(branch_sequences).set({ is_entry: false }).where(eq(branch_sequences.project_id, project.id));
        }
        const [row] = await tx.update(branch_sequences)
          .set({ ...rest, ...(is_entry !== undefined ? { is_entry } : {}) })
          .where(eq(branch_sequences.id, existing.id))
          .returning();
        return row;
      });

      return reply.send(updated);
    },
  );

  app.delete<{ Params: { id: string; sid: string } }>(
    '/api/v1/projects/:id/branch/sequences/:sid',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply) => {
      const project = await ownedProject(request, reply);
      if (!project) return;
      const existing = await db.query.branch_sequences.findFirst({
        where: and(eq(branch_sequences.id, request.params.sid), eq(branch_sequences.project_id, project.id)),
      });
      if (!existing) return reply.code(404).send({ message: 'Sequence not found' });
      // video_files.sequence_id and edges' dest_sequence_id are ON DELETE SET NULL / CASCADE per FK.
      await db.delete(branch_sequences).where(eq(branch_sequences.id, existing.id));
      return reply.code(204).send();
    },
  );

  // Assign a main video to a sequence (or unassign with sequence_id=null).
  app.post<{ Params: { id: string }; Body: { video_file_id: string; sequence_id: string | null; sequence_order?: number | null } }>(
    '/api/v1/projects/:id/branch/assign',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply) => {
      const project = await ownedProject(request, reply);
      if (!project) return;
      const { video_file_id, sequence_id, sequence_order } = request.body ?? {};
      if (!video_file_id) return reply.code(400).send({ message: 'video_file_id is required' });

      const video = await db.query.video_files.findFirst({
        where: and(eq(video_files.id, video_file_id), eq(video_files.project_id, project.id)),
      });
      if (!video) return reply.code(404).send({ message: 'Video not found' });

      if (sequence_id) {
        const seq = await db.query.branch_sequences.findFirst({
          where: and(eq(branch_sequences.id, sequence_id), eq(branch_sequences.project_id, project.id)),
        });
        if (!seq) return reply.code(404).send({ message: 'Sequence not found' });
      }

      const [updated] = await db.update(video_files)
        .set({ sequence_id: sequence_id ?? null, sequence_order: sequence_order ?? null })
        .where(eq(video_files.id, video.id))
        .returning();

      return reply.send({ id: updated.id, sequence_id: updated.sequence_id, sequence_order: updated.sequence_order });
    },
  );

  // ── Choice points ───────────────────────────────────────────────────────────
  app.post<{ Params: { id: string }; Body: { sequence_id: string; lead_in_sec?: number; timeout_sec?: number | null; behavior?: string; prompt?: string | null; layout?: string } }>(
    '/api/v1/projects/:id/branch/choice-points',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply) => {
      const project = await ownedProject(request, reply);
      if (!project) return;
      const { sequence_id, lead_in_sec, timeout_sec, behavior, prompt, layout } = request.body ?? {};
      if (!sequence_id) return reply.code(400).send({ message: 'sequence_id is required' });
      if (behavior && !BEHAVIORS.includes(behavior as typeof BEHAVIORS[number])) {
        return reply.code(400).send({ message: `behavior must be one of ${BEHAVIORS.join(', ')}` });
      }

      const seq = await db.query.branch_sequences.findFirst({
        where: and(eq(branch_sequences.id, sequence_id), eq(branch_sequences.project_id, project.id)),
      });
      if (!seq) return reply.code(404).send({ message: 'Sequence not found' });

      const [row] = await db.insert(branch_choice_points).values({
        project_id: project.id,
        sequence_id,
        lead_in_sec: lead_in_sec ?? 10,
        timeout_sec: timeout_sec ?? null,
        behavior: behavior ?? 'continue',
        prompt: prompt ?? null,
        layout: layout ?? 'cards',
      }).returning();

      return reply.code(201).send(row);
    },
  );

  app.patch<{ Params: { id: string; cid: string }; Body: Partial<{ lead_in_sec: number; timeout_sec: number | null; behavior: string; prompt: string | null; layout: string; default_edge_id: string | null }> }>(
    '/api/v1/projects/:id/branch/choice-points/:cid',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply) => {
      const project = await ownedProject(request, reply);
      if (!project) return;
      const existing = await db.query.branch_choice_points.findFirst({
        where: and(eq(branch_choice_points.id, request.params.cid), eq(branch_choice_points.project_id, project.id)),
      });
      if (!existing) return reply.code(404).send({ message: 'Choice point not found' });

      const body = request.body ?? {};
      if (body.behavior && !BEHAVIORS.includes(body.behavior as typeof BEHAVIORS[number])) {
        return reply.code(400).send({ message: `behavior must be one of ${BEHAVIORS.join(', ')}` });
      }
      if (body.default_edge_id) {
        const edge = await db.query.branch_edges.findFirst({
          where: and(eq(branch_edges.id, body.default_edge_id), eq(branch_edges.choice_point_id, existing.id)),
        });
        if (!edge) return reply.code(400).send({ message: 'default_edge_id must be an edge of this choice point' });
      }

      const [updated] = await db.update(branch_choice_points).set(body).where(eq(branch_choice_points.id, existing.id)).returning();
      return reply.send(updated);
    },
  );

  app.delete<{ Params: { id: string; cid: string } }>(
    '/api/v1/projects/:id/branch/choice-points/:cid',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply) => {
      const project = await ownedProject(request, reply);
      if (!project) return;
      const existing = await db.query.branch_choice_points.findFirst({
        where: and(eq(branch_choice_points.id, request.params.cid), eq(branch_choice_points.project_id, project.id)),
      });
      if (!existing) return reply.code(404).send({ message: 'Choice point not found' });
      await db.delete(branch_choice_points).where(eq(branch_choice_points.id, existing.id));
      return reply.code(204).send();
    },
  );

  // ── Edges ─────────────────────────────────────────────────────────────────
  app.post<{ Params: { id: string }; Body: {
    choice_point_id?: string | null; label?: string | null; description?: string | null; thumbnail_url?: string | null; sort_order?: number;
    destination_type: string;
    dest_sequence_id?: string | null; dest_project_id?: string | null; dest_playlist_id?: string | null; dest_url?: string | null; dest_simulation_id?: string | null; dest_quiz_id?: string | null;
    trigger_event?: string | null; trigger_match?: Record<string, unknown> | null;
  } }>(
    '/api/v1/projects/:id/branch/edges',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply) => {
      const project = await ownedProject(request, reply);
      if (!project) return;
      const b = request.body ?? ({} as Record<string, never>);
      if (!b.destination_type || !DESTINATION_TYPES.includes(b.destination_type as DestinationType)) {
        return reply.code(400).send({ message: `destination_type must be one of ${DESTINATION_TYPES.join(', ')}` });
      }

      // Validate referenced choice point + same-project sequence destination belong to this project.
      if (b.choice_point_id) {
        const cp = await db.query.branch_choice_points.findFirst({
          where: and(eq(branch_choice_points.id, b.choice_point_id), eq(branch_choice_points.project_id, project.id)),
        });
        if (!cp) return reply.code(404).send({ message: 'Choice point not found' });
      }
      if (b.destination_type === 'sequence') {
        if (!b.dest_sequence_id) return reply.code(400).send({ message: 'dest_sequence_id is required for a sequence destination' });
        const seq = await db.query.branch_sequences.findFirst({
          where: and(eq(branch_sequences.id, b.dest_sequence_id), eq(branch_sequences.project_id, project.id)),
        });
        if (!seq) return reply.code(404).send({ message: 'Destination sequence not found' });
      }
      if (b.destination_type === 'external_url' && !b.dest_url) {
        return reply.code(400).send({ message: 'dest_url is required for an external_url destination' });
      }

      const [row] = await db.insert(branch_edges).values({
        project_id: project.id,
        choice_point_id: b.choice_point_id ?? null,
        label: b.label ?? null,
        description: b.description ?? null,
        thumbnail_url: b.thumbnail_url ?? null,
        sort_order: b.sort_order ?? 0,
        destination_type: b.destination_type,
        dest_sequence_id: b.dest_sequence_id ?? null,
        dest_project_id: b.dest_project_id ?? null,
        dest_playlist_id: b.dest_playlist_id ?? null,
        dest_url: b.dest_url ?? null,
        dest_simulation_id: b.dest_simulation_id ?? null,
        dest_quiz_id: b.dest_quiz_id ?? null,
        trigger_event: b.trigger_event ?? null,
        trigger_match: b.trigger_match ?? null,
      }).returning();

      return reply.code(201).send(row);
    },
  );

  app.patch<{ Params: { id: string; eid: string }; Body: Record<string, unknown> }>(
    '/api/v1/projects/:id/branch/edges/:eid',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply) => {
      const project = await ownedProject(request, reply);
      if (!project) return;
      const existing = await db.query.branch_edges.findFirst({
        where: and(eq(branch_edges.id, request.params.eid), eq(branch_edges.project_id, project.id)),
      });
      if (!existing) return reply.code(404).send({ message: 'Edge not found' });

      const b = request.body ?? {};
      if (typeof b.destination_type === 'string' && !DESTINATION_TYPES.includes(b.destination_type as DestinationType)) {
        return reply.code(400).send({ message: `destination_type must be one of ${DESTINATION_TYPES.join(', ')}` });
      }
      // Whitelist updatable columns.
      const allowed = ['choice_point_id', 'label', 'description', 'thumbnail_url', 'sort_order', 'destination_type',
        'dest_sequence_id', 'dest_project_id', 'dest_playlist_id', 'dest_url', 'dest_simulation_id', 'dest_quiz_id',
        'trigger_event', 'trigger_match'];
      const patch: Record<string, unknown> = {};
      for (const k of allowed) if (k in b) patch[k] = b[k];

      const [updated] = await db.update(branch_edges).set(patch).where(eq(branch_edges.id, existing.id)).returning();
      return reply.send(updated);
    },
  );

  app.delete<{ Params: { id: string; eid: string } }>(
    '/api/v1/projects/:id/branch/edges/:eid',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply) => {
      const project = await ownedProject(request, reply);
      if (!project) return;
      const existing = await db.query.branch_edges.findFirst({
        where: and(eq(branch_edges.id, request.params.eid), eq(branch_edges.project_id, project.id)),
      });
      if (!existing) return reply.code(404).send({ message: 'Edge not found' });
      await db.delete(branch_edges).where(eq(branch_edges.id, existing.id));
      return reply.code(204).send();
    },
  );

  // ── Validation ──────────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    '/api/v1/projects/:id/branch/validate',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply) => {
      const project = await ownedProject(request, reply);
      if (!project) return;
      const issues = await validateGraph(project.id);
      return reply.send({ issues });
    },
  );

  // ── Clear all branching (revert to a single linear timeline) ─────────────────
  app.delete<{ Params: { id: string } }>(
    '/api/v1/projects/:id/branching',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply) => {
      const project = await ownedProject(request, reply);
      if (!project) return;
      // Deleting sequences cascades choice points + edges and nulls video_files.sequence_id.
      await db.delete(branch_sequences).where(eq(branch_sequences.project_id, project.id));
      await db.update(video_files).set({ sequence_id: null, sequence_order: null }).where(eq(video_files.project_id, project.id));
      return reply.code(204).send();
    },
  );

  // ── Analytics: record a viewer path event (Phase 5) ─────────────────────────
  // Public (optional auth) so anonymous viewers of shared/public projects are counted;
  // refuses to record for a private project unless the requester is the owner.
  app.post<{ Params: { id: string }; Body: { session_id?: string; event_type?: string; sequence_id?: string | null; edge_id?: string | null; destination_type?: string | null } }>(
    '/api/v1/projects/:id/branch/events',
    { preHandler: [firebaseAuthOptionalMiddleware] },
    async (request, reply) => {
      const { session_id, event_type, sequence_id, edge_id, destination_type } = request.body ?? {};
      if (!session_id || !event_type) return reply.code(400).send({ message: 'session_id and event_type are required' });
      if (!['sequence_enter', 'choice', 'complete'].includes(event_type)) return reply.code(400).send({ message: 'invalid event_type' });

      const project = await db.query.projects.findFirst({ where: eq(projects.id, request.params.id) });
      if (!project) return reply.code(404).send({ message: 'Project not found' });
      if (project.visibility === 'private' && project.created_by !== (request.dbUser?.id ?? null)) {
        const collab = request.dbUser
          ? await isCollaborator('project', project.id, request.dbUser)
          : false;
        if (!collab) return reply.code(403).send({ message: 'Forbidden' });
      }

      await db.insert(branch_path_events).values({
        project_id:       project.id,
        session_id:       String(session_id).slice(0, 128),
        event_type,
        sequence_id:      sequence_id ?? null,
        edge_id:          edge_id ?? null,
        destination_type: destination_type ?? null,
      });
      return reply.code(204).send();
    },
  );

  // ── Analytics: per-project aggregates (owner only) ──────────────────────────
  app.get<{ Params: { id: string } }>(
    '/api/v1/projects/:id/branch/analytics',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply) => {
      const project = await ownedProject(request, reply);
      if (!project) return;
      const events = await db.query.branch_path_events.findMany({ where: eq(branch_path_events.project_id, project.id) });

      const sessions = new Set<string>();
      const edgeChoiceCounts: Record<string, number> = {};
      const sequenceEnterCounts: Record<string, number> = {};
      let completes = 0;
      for (const e of events) {
        sessions.add(e.session_id);
        if (e.event_type === 'choice' && e.edge_id) edgeChoiceCounts[e.edge_id] = (edgeChoiceCounts[e.edge_id] ?? 0) + 1;
        if (e.event_type === 'sequence_enter' && e.sequence_id) sequenceEnterCounts[e.sequence_id] = (sequenceEnterCounts[e.sequence_id] ?? 0) + 1;
        if (e.event_type === 'complete') completes++;
      }
      return reply.send({
        total_events: events.length,
        sessions: sessions.size,
        completes,
        edge_choice_counts: edgeChoiceCounts,
        sequence_enter_counts: sequenceEnterCounts,
      });
    },
  );
}
