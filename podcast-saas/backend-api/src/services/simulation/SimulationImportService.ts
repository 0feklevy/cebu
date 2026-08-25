/**
 * The `+` that imports an existing simulation from another project — without re-uploading.
 *
 * ── WHAT AN IMPORT ACTUALLY COPIES, AND INTO WHAT SHAPE ───────────────────────────────────────
 * The source's SERVED content — the active revision's package when it has one, the legacy tree
 * otherwise — lands under the destination's own prefix in the plain LEGACY layout (entry at the
 * root). That choice is what keeps this service small: the legacy migration-on-write machinery
 * that already upgrades old packages to revisions does the same for an import the first time a
 * bridge is generated on it. The import does not need to understand revisions to produce
 * something revisions understand.
 *
 * The copy is SERVER-SIDE (`storage.copyObject`) — the bytes never leave the bucket, which is
 * where "don't upload and store again" actually pays: no round trip through this process at all.
 *
 * ── WHAT IS DELIBERATELY NOT COPIED ───────────────────────────────────────────────────────────
 *   revisions/ and posters/  — regenerable, system-owned, and meaningless under a new sim id.
 *   bridge.js                — its bodies are keyed by the SOURCE project's timeline-section ids,
 *                              which exist nowhere in the destination; a copied bridge would be
 *                              dead weight that the first generation here replaces anyway. (This
 *                              is also why "load bridge" exists as its own feature — a saved
 *                              preset re-keys and re-verifies; a blind file copy cannot.)
 *   guidance                 — its jsonb carries audio URLs minted under the source prefix.
 *                              Half-rewriting URLs inside stored JSON is exactly the kind of
 *                              stringly surgery that breaks silently; the destination regenerates
 *                              guidance in one click instead.
 *
 * ── WHY ELIGIBILITY IS SOMEBODY ELSE'S MODULE ─────────────────────────────────────────────────
 * `judgeImport` (importEligibility.ts) answers "may this person cause this copy" — destination
 * first, 404-for-private, the non-empty-token rule. This service takes its verdict as given and
 * refuses to proceed on anything but `allowed`; keeping the two concerns in two files is what
 * keeps a storage optimisation from quietly becoming a way to read private projects.
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { simulations, projects } from '../../db/schema.js';
import { logger } from '../../lib/logger.js';
import { judgeImport, type ImportVerdict, type Requester, type ProjectFacts } from '../storage/importEligibility.js';
import { isCollaborator, type CollabUser } from '../collabAccess.js';
import { readReplaceCompatibilitySource } from './replaceCompatibilitySource.js';
import { isSystemOwnedKey } from 'shared/sim/simRevision';
import type { StorageService } from '../storage/StorageService.js';

export type ImportResult =
  | { ok: true; simulation: typeof simulations.$inferSelect; copiedObjects: number }
  | { ok: false; status: 400 | 403 | 404 | 409; message: string };

export class SimulationImportService {
  constructor(private readonly storage: StorageService) {}

  /** The facts judgeImport needs about one project, from the requester's point of view. */
  private async projectFacts(projectId: string, who: Requester, user: CollabUser | null): Promise<ProjectFacts | null> {
    const p = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
    if (!p) return null;
    // The repo's own collaborator check — it matches by user id AND by invited email, which a
    // hand-rolled user-id-only query would silently miss (an invited-but-never-signed-in
    // collaborator has rights and no user row).
    const collab = user ? await isCollaborator('project', projectId, user) : false;
    return {
      id: p.id,
      visibility: p.visibility,
      // created_by is nullable (legacy rows). An ownerless project simply owner-matches nobody —
      // the empty string equals no real uid, which is the correct reading, not a workaround.
      ownerId: p.created_by ?? '',
      isCollaborator: collab,
      shareToken: p.share_token,
    };
  }

  async importSimulation(input: {
    destProjectId: string;
    sourceSimulationId: string;
    who: Requester;
    /** The full dbUser, for the email-aware collaborator check. Null for anonymous. */
    user: CollabUser | null;
  }): Promise<ImportResult> {
    // The simulation names its project; the caller does not get to. Loading the source project
    // FROM the sim row (rather than trusting a client-supplied source project id) means the
    // eligibility judgement is always about the project that actually owns the bytes.
    const source = await db.query.simulations.findFirst({
      where: eq(simulations.id, input.sourceSimulationId),
    });

    const [sourceFacts, destFacts] = await Promise.all([
      source ? this.projectFacts(source.project_id, input.who, input.user) : Promise.resolve(null),
      this.projectFacts(input.destProjectId, input.who, input.user),
    ]);

    const verdict: ImportVerdict = judgeImport({ source: sourceFacts, destination: destFacts, who: input.who });
    if (!verdict.allowed) {
      const message =
        verdict.reason === 'destination-not-editable' ? 'You cannot add content to this project'
        : verdict.reason === 'same-project' ? 'This simulation is already in this project'
        : 'Simulation not found';
      return { ok: false, status: verdict.status, message };
    }
    // judgeImport ruled on the PROJECTS; the sim row itself can still be unusable.
    if (!source) return { ok: false, status: 404, message: 'Simulation not found' };
    if (source.status !== 'ready') {
      return { ok: false, status: 409, message: 'This simulation is still processing — import it once it is ready' };
    }

    // ── Enumerate the served content ────────────────────────────────────────────────────────────
    const src = await readReplaceCompatibilitySource(this.storage, source).catch(() => null);
    if (!src?.entryRelPath) {
      return { ok: false, status: 409, message: 'This simulation\'s files could not be read' };
    }

    const newSimId = randomUUID();
    const destPrefix = `simulations/${input.destProjectId}/${newSimId}`;

    // Revisioned source: the manifest enumerates exactly what is served. Legacy source: the live
    // tree minus the system-owned subtrees (same exclusion the duplicator applies).
    let pairs: { from: string; toRel: string }[];
    if (src.files) {
      pairs = src.files
        .filter((f) => !/^bridge\.js$/.test(f.rel))
        .map((f) => ({ from: f.key, toRel: f.rel }));
    } else {
      const prefix = source.storage_prefix.replace(/\/+$/, '');
      const keys = await this.storage.listObjects(prefix);
      pairs = keys
        .filter((k) => !isSystemOwnedKey(k, prefix))
        .map((k) => ({ from: k, toRel: k.slice(prefix.length + 1) }))
        .filter((p) => p.toRel && p.toRel !== 'bridge.js');
    }
    if (pairs.length === 0) return { ok: false, status: 409, message: 'This simulation has no files to import' };

    // ── Server-side copy, bytes first ──────────────────────────────────────────────────────────
    // Row AFTER bytes, same asymmetry as the blob store: a crash here leaks objects a sweep can
    // collect; the other order creates a sim row that serves nothing.
    let copied = 0;
    for (const p of pairs) {
      await this.storage.copyObject(p.from, `${destPrefix}/${p.toRel}`);
      copied += 1;
    }

    const [row] = await db.insert(simulations).values({
      id: newSimId,
      project_id: input.destProjectId,
      name: source.name,
      storage_prefix: destPrefix,
      entry_file: this.storage.getSimPublicUrl(`${destPrefix}/${src.entryRelPath}`),
      bridge_functions: source.bridge_functions,
      status: 'ready',
      // Unproven HERE. The source's canary verdict was about the source's bytes under the source's
      // id; carrying it over would claim a check that never ran against this copy.
      package_class: null,
      // Guidance deliberately not carried — see the header.
      guidance_status: 'none',
    }).returning();

    logger.info(
      { evt: 'simulation_imported', from: source.id, to: newSimId, destProject: input.destProjectId, copied },
      '[SimImport] imported without re-upload',
    );
    return { ok: true, simulation: row, copiedObjects: copied };
  }
}
