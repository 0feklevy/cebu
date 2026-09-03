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
 * ── NO BYTES ARE DUPLICATED (migration 080) ──────────────────────────────────────────────────
 * The first version of this service copied every file into the destination's prefix. That is
 * cheap in TIME — a server-side copy never leaves the bucket — and wrong in SPACE: importing one
 * 31 MB package into five projects stored it five times, which is the exact duplication the dedup
 * work exists to remove and the opposite of what was asked for.
 *
 * Now each file is CLAIMED as a blob: hashed, uploaded to `blobs/<digest>` only if nobody already
 * has those bytes, and recorded in `sim_files` as "this simulation's file at this path IS that
 * blob". The second import of a package writes rows and nothing else — no upload, no copy, no
 * bytes. `simFileResolver` turns the path back into a location at serve time.
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
import { claimBlob } from '../storage/MediaBlobStore.js';
import { identifyBuffer } from '../storage/contentIdentity.js';
import { sim_files } from '../../db/schema.js';
import { extname } from 'node:path';
import { isSystemOwnedKey } from 'shared/sim/simRevision';
import type { StorageService } from '../storage/StorageService.js';

export type ImportResult =
  | { ok: true; simulation: typeof simulations.$inferSelect; copiedObjects: number; reusedObjects: number }
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

    // ── Claim each file as a blob; upload only what nobody already has ─────────────────────────
    // Bytes before rows, the same asymmetry the blob store keeps: a crash here leaks an object a
    // sweep collects, while the other order records a file that does not exist yet.
    let copied = 0;
    let reused = 0;
    const mappings: { rel: string; blobId: string }[] = [];
    for (const p of pairs) {
      const buf = await this.storage.readObject(p.from);
      const identity = identifyBuffer(buf);
      const claim = await claimBlob({
        identity,
        adapter: this.storage,
        ext: extname(p.toRel).replace(/^\./, ''),
        upload: async (key) => { await this.storage.uploadFile(key, buf, contentTypeFor(p.toRel)); },
      });
      mappings.push({ rel: p.toRel, blobId: claim.blob.id });
      if (claim.deduped) reused += 1; else copied += 1;
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
      // Where it came from (migration 084), so a second import of the same package into the same
      // project can be answered with the first copy instead of another row.
      imported_from_simulation_id: input.sourceSimulationId,
    }).returning();

    // The mapping is what makes the blobs findable. Written AFTER the simulation row so the FK
    // holds, and in one statement so a partially-mapped simulation cannot be served.
    if (mappings.length > 0) {
      await db.insert(sim_files).values(
        mappings.map((m) => ({ simulation_id: newSimId, rel_path: m.rel, blob_id: m.blobId })),
      );
    }

    logger.info(
      { evt: 'simulation_imported', from: source.id, to: newSimId, destProject: input.destProjectId,
        filesStored: copied, filesReused: reused },
      '[SimImport] imported — only unseen bytes were stored',
    );
    return { ok: true, simulation: row, copiedObjects: copied, reusedObjects: reused };
  }
}


/**
 * The content type an imported file is stored with.
 *
 * It matters more than it looks: binary assets are served by REDIRECTING the browser to the
 * bucket, so the type recorded at upload is the type the browser receives — a wrong one there is
 * a texture the GPU refuses or a script the browser will not execute.
 */
function contentTypeFor(relPath: string): string {
  const ext = relPath.slice(relPath.lastIndexOf('.')).toLowerCase();
  switch (ext) {
    case '.html': case '.htm': return 'text/html; charset=utf-8';
    case '.js': case '.mjs': return 'text/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.jpg': case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.gif': return 'image/gif';
    case '.wasm': return 'application/wasm';
    case '.mp3': return 'audio/mpeg';
    case '.mp4': return 'video/mp4';
    case '.woff2': return 'font/woff2';
    default: return 'application/octet-stream';
  }
}
