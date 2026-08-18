import type { FastifyInstance, FastifyReply } from 'fastify';
import { randomUUID } from 'crypto';
import AdmZip from 'adm-zip';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { simulations, timeline_sections } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { firebaseAuthMiddleware } from '../../middleware/firebase-auth.js';
import { editableProject, type CollabUser } from '../../services/collabAccess.js';
import { getStorageAdapter } from '../../services/storage/getStorageAdapter.js';
import {
  deriveEntryRelPath,
  getSimulationContentType,
  isTextSimulationFile,
  SimulationService,
  type UploadedSimulationFile,
} from '../../services/simulation/SimulationService.js';
import {
  GuidanceService,
  guidancePublishMeta,
  type GuidanceEntryStored,
} from '../../services/simulation/GuidanceService.js';
import { scanSimUiControls } from '../../services/simulation/SimUiControls.js';
import { readActiveRevisionId } from '../../services/simulation/RevisionDerivation.js';
import {
  checkReplaceCompatibility,
  describeIncompatibility,
} from '../../services/simulation/SimBridgeContract.js';
import {
  ActiveRevisionUnreadable,
  readReplaceCompatibilitySource,
  type ReplaceCompatibilitySource,
} from '../../services/simulation/replaceCompatibilitySource.js';
import {
  readActiveRevisionPackage,
  type ActivePackageView,
} from '../../services/simulation/activeRevisionPackage.js';
import { LLMService } from '../../services/llm/LLMService.js';
import { ApiKeyService } from '../../services/secrets/ApiKeyService.js';
import { UsageTrackingService } from '../../services/usage/UsageTrackingService.js';
import { logger } from '../../lib/logger.js';

const GUIDANCE_ERROR_MESSAGES: Record<string, string> = {
  aborted:          'Generation was cancelled.',
  no_source:        'Simulation files not found. Please re-upload the simulation.',
  tts_error:        'Voice synthesis failed. Check the ElevenLabs API key in Admin → API Keys.',
  generation_error: 'Guidance generation failed. Please try again.',
};

function classifyGuidanceError(err: unknown): string {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (msg.includes('abort')) return 'aborted';
  if (msg.includes('no readable') || msg.includes('no html entry')) return 'no_source';
  if (msg.includes('elevenlabs') || msg.includes('tts')) return 'tts_error';
  return 'generation_error';
}

// Stored guidance entry shape accepted from the editor on PATCH (narration/enabled edits).
const StoredGuidanceEntrySchema = z.object({
  id:         z.string().min(1),
  kind:       z.enum(['feature', 'config']),
  title:      z.string(),
  narration:  z.string().min(1).max(400),
  enabled:    z.boolean(),
  trigger:    z.any(),
  audioUrl:   z.string().nullable().optional(),
  confidence: z.number().min(0).max(1).default(0.6),
  warnings:   z.array(z.string()).default([]),
});

const _llmService = new LLMService(new ApiKeyService(), new UsageTrackingService());
const SIMULATION_UPLOAD_MAX_BYTES = 250 * 1024 * 1024;
const SIMULATION_UPLOAD_MAX_FILES = 1000;

function parseManifestPaths(value: unknown): string[] | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error('manifest must be an array');
  return parsed.map((item) => {
    if (typeof item === 'string') return item;
    if (
      item &&
      typeof item === 'object' &&
      'path' in item &&
      typeof (item as { path?: unknown }).path === 'string'
    ) {
      return (item as { path: string }).path;
    }
    throw new Error('manifest entries must be strings or { path } objects');
  });
}

export async function registerSimulationsRoutes(app: FastifyInstance): Promise<void> {
  const storage = getStorageAdapter();

  /**
   * The package a simulation is ACTUALLY serving, for every read path (audit D-04).
   *
   * `null` for a legacy simulation — the caller keeps its storage-listing path, which for that
   * simulation is correct. An unreadable active revision is surfaced as its own 409 rather than as
   * an empty file list: "this package has no files" and "its manifest could not be read" are
   * different answers and only one of them is true.
   */
  const activePackageOr409 = async (
    sim: typeof simulations.$inferSelect,
    reply: FastifyReply,
  ): Promise<{ pkg: ActivePackageView | null } | { sent: true }> => {
    try {
      return { pkg: await readActiveRevisionPackage(storage, sim) };
    } catch (err) {
      if (err instanceof ActiveRevisionUnreadable) {
        logger.error({ simId: sim.id, revisionId: err.revisionId, err }, 'Active revision unreadable');
        await reply.code(409).send({ code: err.code, message: err.message, activeRevisionId: err.revisionId });
        return { sent: true };
      }
      throw err;
    }
  };

  // entry_file is stored as a storage key on new rows and a full URL on old rows —
  // always hand the client a working public URL.
  const serializeSim = (r: typeof simulations.$inferSelect) => ({
    ...r,
    entry_file: r.entry_file
      ? (r.entry_file.startsWith('http') ? r.entry_file : storage.getSimPublicUrl(r.entry_file))
      : r.entry_file,
  });

  // GET /api/v1/projects/:id/simulations
  app.get<{ Params: { id: string } }>(
    '/api/v1/projects/:id/simulations',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await editableProject(request.params.id, user);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const rows = await db.query.simulations.findMany({
        where: eq(simulations.project_id, project.id),
        orderBy: (t, { desc }) => [desc(t.created_at)],
      });
      // Transform entry_file: new rows store a storage key, old rows store a full URL.
      // Always return a fresh public URL so the client always gets a working link.
      return reply.send(rows.map(r => ({
        ...r,
        entry_file: r.entry_file
          ? (r.entry_file.startsWith('http') ? r.entry_file : storage.getSimPublicUrl(r.entry_file))
          : r.entry_file,
      })));
    },
  );

  // POST /api/v1/projects/:id/simulations/upload
  // Accepts multipart:
  // - name (text field) + file (.zip), or
  // - name + manifest (JSON path array) + files (repeated folder/file bundle parts)
  app.post<{ Params: { id: string } }>(
    '/api/v1/projects/:id/simulations/upload',
    {
      preHandler: [firebaseAuthMiddleware],
    },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await editableProject(request.params.id, user);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      let name = '';
      let zipBuf: Buffer | null = null;
      let manifestPaths: string[] | null = null;
      let totalBytes = 0;
      const bundleFiles: UploadedSimulationFile[] = [];

      const parts = request.parts({
        limits: {
          fileSize: SIMULATION_UPLOAD_MAX_BYTES,
          files:    SIMULATION_UPLOAD_MAX_FILES,
          fields:   20,
        },
      });
      for await (const part of parts) {
        if (part.type === 'field' && part.fieldname === 'name') {
          name = String(part.value).trim();
        } else if (part.type === 'field' && part.fieldname === 'manifest') {
          try {
            manifestPaths = parseManifestPaths(part.value);
          } catch (err) {
            return reply.code(400).send({ message: (err as Error).message });
          }
        } else if (part.type === 'file' && part.fieldname === 'file') {
          const chunks: Buffer[] = [];
          for await (const chunk of part.file) {
            const buf = chunk as Buffer;
            totalBytes += buf.length;
            if (totalBytes > SIMULATION_UPLOAD_MAX_BYTES) {
              return reply.code(413).send({ message: 'Simulation upload exceeds 250 MB' });
            }
            chunks.push(buf);
          }
          zipBuf = Buffer.concat(chunks);
        } else if (part.type === 'file' && part.fieldname === 'files') {
          const chunks: Buffer[] = [];
          for await (const chunk of part.file) {
            const buf = chunk as Buffer;
            totalBytes += buf.length;
            if (totalBytes > SIMULATION_UPLOAD_MAX_BYTES) {
              return reply.code(413).send({ message: 'Simulation upload exceeds 250 MB' });
            }
            chunks.push(buf);
          }
          bundleFiles.push({
            path:   part.filename || `file-${bundleFiles.length + 1}`,
            buffer: Buffer.concat(chunks),
          });
        }
      }

      if (!name) return reply.code(400).send({ message: '"name" field is required' });
      if (zipBuf && bundleFiles.length > 0) {
        return reply.code(400).send({ message: 'Upload either one ZIP or a file bundle, not both' });
      }
      if ((!zipBuf || zipBuf.length === 0) && bundleFiles.length === 0) {
        return reply.code(400).send({ message: '"file" (ZIP) or "files" bundle is required' });
      }
      if (manifestPaths && manifestPaths.length !== bundleFiles.length) {
        return reply.code(400).send({ message: 'manifest file count does not match uploaded files' });
      }
      if (manifestPaths) {
        for (let i = 0; i < bundleFiles.length; i++) {
          bundleFiles[i].path = manifestPaths[i];
        }
      }

      const simId   = randomUUID();
      const prefix  = `simulations/${project.id}/${simId}`;

      // Insert a placeholder so the client has an ID immediately
      const [row] = await db
        .insert(simulations)
        .values({
          id:             simId,
          project_id:     project.id,
          name,
          storage_prefix: prefix,
          entry_file:     '',    // filled in after upload
          status:         'processing',
        })
        .returning();

      // Process asynchronously so the response returns quickly
      const svc = new SimulationService(storage, _llmService);

      const processPromise = zipBuf
        ? svc.processUpload({ projectId: project.id, simId, zipBuffer: zipBuf })
        : svc.processFileUpload({ projectId: project.id, simId, files: bundleFiles });

      processPromise
        .then(async ({ entryKey, bridgeFunctions }) => {
          // Store storage KEY (not URL) so it never goes stale across environments/ports
          await db
            .update(simulations)
            .set({ entry_file: entryKey, bridge_functions: bridgeFunctions, status: 'ready' })
            .where(eq(simulations.id, simId));
          logger.info({ simId, entryKey }, 'Simulation ready');
        })
        .catch(async (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          await db
            .update(simulations)
            .set({ status: 'failed', error: msg })
            .where(eq(simulations.id, simId));
          logger.error({ simId, err }, 'Simulation processing failed');
        });

      return reply.code(202).send(row);
    },
  );

  // POST /api/v1/projects/:id/simulations/:simId/replace
  // In-place file swap for an existing simulation — same simId and storage prefix.
  // Mirrors the upload endpoint's multipart contract (one ZIP in "file" OR a "files"
  // bundle + optional "manifest"; "name" is tolerated but ignored) and its caps.
  // Semantics:
  //   - TWO PUBLICATION SHAPES, ONE CONTRACT (audit D-04). A LEGACY simulation is swapped in place
  //     under its mutable prefix, exactly as before. A simulation with an `active_revision_id` is
  //     served from an immutable revision prefix, so the swap is expressed as a NEW revision
  //     derived from the active one — customer files replaced, the LIVE bridge and guidance
  //     carried across, made live by one compare-and-set. Either way the client sees 202 + poll.
  //   - only a 'ready' (or previously 'failed'-replace) sim can be swapped; the row is
  //     CAS-claimed to 'processing' for the swap and set back to 'ready'/'failed' after
  //   - the new bundle MUST contain an HTML file at the SAME relative path as the current
  //     entry file — sections' stored simulation_url embeds that exact path, so a renamed
  //     entry is rejected with 409 before any processing starts
  //   - new files overwrite the old keys; stale keys are deleted EXCEPT generated
  //     artifacts (bridge.js, guidance.js, guidance/*, legacy section_* files)
  //   - the head rAF gate + bridge/guidance script tags are re-injected into the new
  //     entry HTML (bridge.js keeps its current ?v= hash, guidance.js its current hash)
  //   - sections' simulation_url / sim_meta are NOT touched — the next generate call
  //     detects the changed sources via sourceHash
  //   - BRIDGE-COMPATIBILITY GATE: because bridge.js is preserved, the new files must still
  //     provide every DOM/JS anchor its section bodies bind to. Verified on the decoded upload
  //     BEFORE any mutation; a single broken section refuses the whole replace with 409 +
  //     a per-section report. `?dry_run=true` returns that report without replacing anything.
  app.post<{ Params: { id: string; simId: string }; Querystring: { dry_run?: string } }>(
    '/api/v1/projects/:id/simulations/:simId/replace',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await editableProject(request.params.id, user);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const sim = await db.query.simulations.findFirst({
        where: and(eq(simulations.id, request.params.simId), eq(simulations.project_id, project.id)),
      });
      if (!sim) return reply.code(404).send({ message: 'Simulation not found' });

      const isDryRun = request.query?.dry_run === 'true';

      // 'failed' is allowed so a failed replace can be retried; a failed INITIAL upload has
      // no entry_file and is rejected by the entry-path check below.
      if (sim.status !== 'ready' && sim.status !== 'failed') {
        return reply.code(409).send({ message: `Simulation is ${sim.status} — wait for it to finish before replacing files` });
      }

      let zipBuf: Buffer | null = null;
      let manifestPaths: string[] | null = null;
      let totalBytes = 0;
      const bundleFiles: UploadedSimulationFile[] = [];

      const parts = request.parts({
        limits: {
          fileSize: SIMULATION_UPLOAD_MAX_BYTES,
          files:    SIMULATION_UPLOAD_MAX_FILES,
          fields:   20,
        },
      });
      for await (const part of parts) {
        if (part.type === 'field' && part.fieldname === 'manifest') {
          try {
            manifestPaths = parseManifestPaths(part.value);
          } catch (err) {
            return reply.code(400).send({ message: (err as Error).message });
          }
        } else if (part.type === 'file' && part.fieldname === 'file') {
          const chunks: Buffer[] = [];
          for await (const chunk of part.file) {
            const buf = chunk as Buffer;
            totalBytes += buf.length;
            if (totalBytes > SIMULATION_UPLOAD_MAX_BYTES) {
              return reply.code(413).send({ message: 'Simulation upload exceeds 250 MB' });
            }
            chunks.push(buf);
          }
          zipBuf = Buffer.concat(chunks);
        } else if (part.type === 'file' && part.fieldname === 'files') {
          const chunks: Buffer[] = [];
          for await (const chunk of part.file) {
            const buf = chunk as Buffer;
            totalBytes += buf.length;
            if (totalBytes > SIMULATION_UPLOAD_MAX_BYTES) {
              return reply.code(413).send({ message: 'Simulation upload exceeds 250 MB' });
            }
            chunks.push(buf);
          }
          bundleFiles.push({
            path:   part.filename || `file-${bundleFiles.length + 1}`,
            buffer: Buffer.concat(chunks),
          });
        }
      }

      if (zipBuf && bundleFiles.length > 0) {
        return reply.code(400).send({ message: 'Upload either one ZIP or a file bundle, not both' });
      }
      if ((!zipBuf || zipBuf.length === 0) && bundleFiles.length === 0) {
        return reply.code(400).send({ message: '"file" (ZIP) or "files" bundle is required' });
      }
      if (manifestPaths && manifestPaths.length !== bundleFiles.length) {
        return reply.code(400).send({ message: 'manifest file count does not match uploaded files' });
      }
      if (manifestPaths) {
        for (let i = 0; i < bundleFiles.length; i++) {
          bundleFiles[i].path = manifestPaths[i];
        }
      }

      const svc = new SimulationService(storage, _llmService);

      let fileMap: Map<string, Buffer>;
      try {
        fileMap = svc.buildUploadFileMap(zipBuf ? { zipBuffer: zipBuf } : { files: bundleFiles });
      } catch (err) {
        return reply.code(400).send({ message: (err as Error).message });
      }
      if (fileMap.size === 0) {
        return reply.code(400).send({ message: 'Replacement bundle appears to be empty' });
      }

      // ── What the upload is judged AGAINST (audit simulation-003) ───────────────────
      //
      // The entry path and the bridge both have to describe the package that is actually SERVED.
      // For a legacy simulation that is the mutable prefix, as before. For a revisioned one it is
      // the active revision's manifest and its `package/bridge.js` — reading `<prefix>/bridge.js`
      // there answers the question against a stale copy nobody loads, and the wrong answer is the
      // permissive one. A revision that cannot be read produces a refusal, never a default verdict.
      let source: ReplaceCompatibilitySource;
      try {
        source = await readReplaceCompatibilitySource(storage, sim);
      } catch (err) {
        if (err instanceof ActiveRevisionUnreadable) {
          logger.error({ simId: sim.id, revisionId: err.revisionId, err }, 'Replace preflight: active revision unreadable');
          return reply.code(409).send({ code: err.code, message: err.message, activeRevisionId: err.revisionId });
        }
        throw err;
      }

      // Same-entry-name rule: sections' simulation_url points at the exact current entry
      // path, so the replacement must ship an HTML file at that same relative path.
      const entryRelPath = source.entryRelPath;
      if (!entryRelPath) {
        return reply.code(409).send({
          message: 'Cannot determine the current entry file of this simulation — delete it and upload the files as a new simulation instead.',
        });
      }
      if (!fileMap.has(entryRelPath)) {
        return reply.code(409).send({
          message:
            `Replacement must keep the same entry file name: expected "${entryRelPath}" in the new upload ` +
            `but it was not found. Rename your entry HTML to "${entryRelPath}" and re-upload — existing ` +
            'video sections reference this exact file, so a renamed entry would break them.',
          expectedEntryFile: entryRelPath,
        });
      }

      // ── Bridge-compatibility gate ───────────────────────────────────────────────────
      // A replace keeps bridge.js (and with it every section's Minimal-UI / auto-script
      // configuration) — that is the whole point of the feature. So the new files must still
      // provide the DOM and JS-API anchors those section bodies bind to; otherwise the
      // sub-simulations silently no-op in production with no error anywhere.
      //
      // This runs on the DECODED UPLOAD BEFORE the CAS claim and before processReplace, so a
      // refusal cannot touch storage, the DB row, or the live simulation in any way.
      const pkgSections = await db.query.timeline_sections.findMany({
        where: eq(timeline_sections.simulation_id, sim.id),
        columns: { id: true, sim_meta: true },
      });

      const compatibility = checkReplaceCompatibility({
        bridgeJs: source.bridgeJs,
        bundle: { files: fileMap, entryRelPath },
        sections: pkgSections.map((s) => ({ id: s.id, simMeta: s.sim_meta })),
      });

      // Preflight: report only, mutate nothing. `replaceSupported` stays on the response — it was
      // the field that told a caller a compatible report on a revisioned package was not permission
      // to replace it, and dropping it would silently turn "false" into "undefined" for any client
      // still reading it. Both shapes are supported now, so both answer true.
      if (isDryRun) {
        return reply.code(200).send({
          compatibility,
          message: describeIncompatibility(compatibility),
          replaceSupported: true,
          comparedAgainst: { origin: source.origin, revisionId: source.revisionId, bridgeKey: source.bridgeKey },
        });
      }

      if (!compatibility.compatible) {
        // Owner policy: ANY broken section refuses the WHOLE replace (no partial swap, no
        // override) — production must never be left with a silently dead sub-simulation.
        logger.info(
          { simId: sim.id, broken: compatibility.summary.sectionsBroken, total: compatibility.summary.sectionsTotal },
          'Simulation replace refused — incompatible with the existing bridge',
        );
        return reply.code(409).send({
          message: describeIncompatibility(compatibility),
          compatibility,
        });
      }

      // CAS-claim ready/failed → processing so concurrent replaces can't interleave
      // (cluster-safe: the WHERE re-checks the status we observed).
      const [claimed] = await db
        .update(simulations)
        .set({ status: 'processing', error: null })
        .where(and(eq(simulations.id, sim.id), eq(simulations.status, sim.status)))
        .returning();
      if (!claimed) {
        return reply.code(409).send({ message: 'Simulation is busy — try again shortly' });
      }

      // Process asynchronously so the response returns quickly (mirrors the upload endpoint).
      //
      // The two shapes differ in WHERE the terminal status is written. The legacy swap writes it
      // here, after the last upload; the revisioned one writes it INSIDE the activation
      // transaction, so a lost compare-and-set can never leave a package live with a row that
      // still says `processing`. Only the failure path is shared — and it must be, because a
      // claimed row with no terminal write is a simulation nobody can replace again.
      // ── THE PACKAGE MUST NOT HAVE CHANGED SHAPE UNDER US (audit D-04) ────────────────────
      //
      // `active_revision_id` decides whether these bytes are served from the mutable prefix or
      // from an immutable revision, and the two are published by different code below. An earlier
      // draft took it from the row loaded at HANDLER ENTRY — the same time-of-check bug this
      // branch has now shipped three times, in the one path whose whole purpose is to close it.
      //
      // The distance from handler entry to here spans the entire multipart upload, ZIP
      // extraction, the compatibility read and the status CAS: a window measured in the SIZE OF
      // THE UPLOAD, not in milliseconds. Status does not exclude anything — the row stays `ready`
      // for almost all of it.
      //
      // Re-reading and simply routing on the NEW value is not enough either, and that is the
      // subtler half. The compatibility gate above already read the base package and answered
      // "these files work against that bridge". If the pointer moved since, that answer is about
      // a DIFFERENT package: a legacy-validated upload would be published into a revision derived
      // from a bridge nobody checked it against. Passing a stale compatibility verdict forward is
      // how you ship a broken simulation with a green check next to it.
      //
      // So a change is a CONFLICT, not a branch. The client re-uploads against the package that
      // now exists — the same shape as any other optimistic-concurrency failure, and cheap
      // compared to publishing something unvalidated.
      const activeRevisionIdNow = await readActiveRevisionId(sim.id);
      const activeRevisionIdAtEntry = sim.active_revision_id ?? null;
      if (activeRevisionIdNow !== activeRevisionIdAtEntry) {
        // The row is already CLAIMED (`processing`) at this point, and a claimed row with no
        // terminal write is a simulation nobody can ever replace again. Hand it back before
        // answering — to `ready`, not `failed`: nothing was written and nothing is wrong with the
        // package, so leaving a red error on it would be a lie the owner has to clear by hand.
        await db
          .update(simulations)
          .set({ status: 'ready', error: null })
          .where(and(eq(simulations.id, sim.id), eq(simulations.status, 'processing')));
        return reply.code(409).send({
          code: 'SIM_PACKAGE_CHANGED_DURING_UPLOAD',
          message:
            'This simulation was published to a new revision while your files were uploading, so the ' +
            'compatibility check ran against a package that is no longer current. Nothing was written. ' +
            'Re-upload to check against the current package.',
        });
      }
      const isRevisioned = activeRevisionIdNow !== null;

      const publication = isRevisioned
        ? svc.replaceIntoRevision({ projectId: project.id, simId: sim.id, files: fileMap, entryRelPath })
            .then(({ revisionId, revisionNumber, carriedForward, droppedFromBase }) => {
              logger.info(
                { simId: sim.id, revisionId, revisionNumber,
                  carriedForward: carriedForward.length, droppedFromBase: droppedFromBase.length },
                'Simulation files replaced into a new revision',
              );
            })
        : svc.processReplace({ projectId: project.id, simId: sim.id, files: fileMap, entryRelPath })
            .then(async ({ entryKey, bridgeFunctions, deletedStale, preservedGenerated }) => {
              await db
                .update(simulations)
                .set({ entry_file: entryKey, bridge_functions: bridgeFunctions, status: 'ready', error: null })
                .where(eq(simulations.id, sim.id));
              logger.info(
                { simId: sim.id, entryKey, deletedStale: deletedStale.length, preservedGenerated: preservedGenerated.length },
                'Simulation files replaced',
              );
            });

      publication.catch(async (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        await db
          .update(simulations)
          .set({ status: 'failed', error: msg })
          .where(eq(simulations.id, sim.id));
        logger.error({ simId: sim.id, err }, 'Simulation replace failed');
      });

      return reply.code(202).send(serializeSim(claimed));
    },
  );

  // GET /api/v1/projects/:id/simulations/:simId/files
  app.get<{ Params: { id: string; simId: string } }>(
    '/api/v1/projects/:id/simulations/:simId/files',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await editableProject(request.params.id, user);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const sim = await db.query.simulations.findFirst({
        where: and(eq(simulations.id, request.params.simId), eq(simulations.project_id, project.id)),
      });
      if (!sim) return reply.code(404).send({ message: 'Simulation not found' });

      // REVISION-AWARE (audit D-04). Listing the storage prefix of a revisioned package returns
      // every revision's every file plus the captured posters — so the Files tab showed four
      // copies of index.html under machine-generated directories and none of them was marked as
      // the live one. The active revision's manifest is the authoritative list of what is served.
      const active = await activePackageOr409(sim, reply);
      if ('sent' in active) return reply;
      if (active.pkg) {
        // The SAME row shape the legacy branch returns, deliberately: what changes here is WHICH
        // files are listed, not what a file looks like on the wire. `key` stays the storage key the
        // `file-content` proxy takes, and it is a revision key — which that route already accepts,
        // because a revision prefix is inside `storage_prefix`.
        return reply.send(active.pkg.files.map(f => ({
          key:      f.key,
          filename: f.relPath.split('/').pop() ?? f.relPath,
          ext:      (f.relPath.split('.').pop() ?? '').toLowerCase(),
          url:      storage.getSimPublicUrl(f.key),
          isText:   isTextSimulationFile(f.relPath),
        })));
      }

      const prefix = sim.storage_prefix.endsWith('/') ? sim.storage_prefix : sim.storage_prefix + '/';

      let allKeys: string[] = [];
      let listFailed = false;
      try {
        allKeys = await storage.listObjects(sim.storage_prefix);
      } catch (err) {
        // Some R2 API tokens can read/write objects but lack ListBucket permission
        // (→ AccessDenied). Don't hard-fail: fall back to probing the standard files.
        listFailed = true;
        logger.warn({ err, prefix: sim.storage_prefix }, 'listObjects failed — falling back to known-file probe (grant the storage token List permission to see all files)');
      }

      // When listing is unavailable/empty (e.g. a write-only / public-only R2 token
      // that denies ListBucket+GetObject), derive the file set from the entry HTML
      // — fetched over the PUBLIC url the player already uses, which needs no S3 auth.
      // Sim files live in an arbitrarily-named subfolder with arbitrary names, so we
      // can't guess them; instead we parse the entry's <link href>/<script src> refs.
      if (listFailed || allKeys.length === 0) {
        const entryKey = sim.entry_file;
        // entry_file may be a raw storage key OR a legacy full public URL.
        const entryIsUrl = entryKey.startsWith('http://') || entryKey.startsWith('https://');
        const entryPublicUrl = entryIsUrl ? entryKey : storage.getSimPublicUrl(entryKey);
        // Normalise to an absolute base so relative-ref resolution works for both forms.
        const entryBase = entryIsUrl ? entryKey : `http://x/${entryKey}`;
        const entryDir  = entryBase.slice(0, entryBase.lastIndexOf('/') + 1);

        // Only seed found with the entry key if it is a storage key (not a URL) so
        // it survives the prefix filter below.
        const found = new Set<string>(entryIsUrl ? [] : [entryKey]);
        try {
          const res = await fetch(entryPublicUrl);
          if (res.ok) {
            const html = await res.text();
            const refs = [...html.matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']/gi)]
              .map((m) => m[1])
              .filter((r) => !/^(https?:)?\/\//i.test(r) && !r.startsWith('data:') && !r.startsWith('#') && !r.startsWith('mailto:'));
            for (const ref of refs) {
              const clean = ref.split('?')[0].split('#')[0].trim();
              if (!clean) continue;
              let resolved: string;
              try { resolved = new URL(clean, entryDir).pathname.slice(1); } catch { continue; }
              if (resolved.startsWith(prefix)) found.add(resolved);
            }
          }
        } catch { /* entry unreachable — fall through with just the entry key */ }

        // Generated files (bridge.js, guidance.js) live at predictable paths regardless
        // of whether they've been injected into the HTML yet. Probe via HEAD request
        // (public bucket, so no auth needed) so they always appear in the Files tab.
        // Use sim.storage_prefix (no trailing slash) to avoid double-slash in the key.
        const knownGenerated = [
          `${sim.storage_prefix}/bridge.js`,
          `${sim.storage_prefix}/guidance.js`,
        ];
        await Promise.all(knownGenerated.map(async (k) => {
          if (found.has(k)) return;
          try {
            const r = await fetch(storage.getSimPublicUrl(k), { method: 'HEAD' });
            if (r.ok) found.add(k);
          } catch { /* not accessible */ }
        }));

        allKeys = [...found];
      }
      const files = allKeys
        .filter(k => k.startsWith(prefix) || k === sim.storage_prefix)
        .sort()
        .map(k => ({
          key:       k,
          filename:  k.split('/').pop() ?? k,
          ext:       (k.split('.').pop() ?? '').toLowerCase(),
          url:       storage.getSimPublicUrl(k),
          isText:    isTextSimulationFile(k),
        }));

      return reply.send(files);
    },
  );

  // GET /api/v1/projects/:id/simulations/:simId/file-content?key=...
  // Proxies file through the storage adapter so the browser avoids R2 CORS restrictions.
  app.get<{ Params: { id: string; simId: string }; Querystring: { key?: string } }>(
    '/api/v1/projects/:id/simulations/:simId/file-content',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const { key } = request.query;
      if (!key) return reply.code(400).send({ message: 'key query param required' });

      const user = request.dbUser!;
      const project = await editableProject(request.params.id, user);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const sim = await db.query.simulations.findFirst({
        where: and(eq(simulations.id, request.params.simId), eq(simulations.project_id, project.id)),
      });
      if (!sim) return reply.code(404).send({ message: 'Simulation not found' });

      if (!key.startsWith(sim.storage_prefix + '/')) {
        return reply.code(403).send({ message: 'Key outside simulation prefix' });
      }

      if (!isTextSimulationFile(key)) {
        return reply.code(415).send({ message: 'Only text simulation files can be read as source' });
      }

      // Read via the storage API; fall back to the public URL when the storage
      // token denies GetObject (write-only R2 token) — same path the player uses.
      let buf: Buffer;
      try {
        buf = await storage.readObject(key);
      } catch {
        const res = await fetch(storage.getSimPublicUrl(key)).catch(() => null);
        if (!res || !res.ok) return reply.code(404).send({ message: 'File not found' });
        buf = Buffer.from(await res.arrayBuffer());
      }
      return reply
        .header('Content-Type', getSimulationContentType(key))
        .send(buf.toString('utf-8'));
    },
  );

  // GET /api/v1/projects/:id/simulations/:simId/ui-controls
  // Static control scan for the Minimal-UI picker: parses the stored entry HTML (system-
  // injected gate/bridge blocks stripped) into { selector, kind, label } controls. The
  // runtime layer (rAF-gate v2 answering listSimControls in the live preview iframe)
  // supersedes this when available — the editor falls back here. Same collabAccess gate
  // as the upload/replace endpoints.
  app.get<{ Params: { id: string; simId: string } }>(
    '/api/v1/projects/:id/simulations/:simId/ui-controls',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await editableProject(request.params.id, user);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const sim = await db.query.simulations.findFirst({
        where: and(eq(simulations.id, request.params.simId), eq(simulations.project_id, project.id)),
      });
      if (!sim) return reply.code(404).send({ message: 'Simulation not found' });

      // REVISION-AWARE (audit D-04). `entry_file` names the pre-revision copy of the entry
      // document; for a revisioned package the player loads the ACTIVE revision's entry, and
      // scanning the old one offered the picker controls from a document nobody serves — the same
      // stale read that made the replace-compatibility gate answer about the wrong bytes.
      const activeForControls = await activePackageOr409(sim, reply);
      if ('sent' in activeForControls) return reply;

      let entryKey: string;
      if (activeForControls.pkg) {
        entryKey = activeForControls.pkg.entryKey;
      } else {
        const entryRelPath = deriveEntryRelPath(sim.entry_file, sim.storage_prefix);
        if (!entryRelPath) {
          return reply.code(404).send({ message: 'Simulation has no readable entry file' });
        }
        entryKey = `${sim.storage_prefix}/${entryRelPath}`;
      }

      // Read via the storage API; fall back to the public URL when the storage token
      // denies GetObject (write-only R2 token) — same path the file-content route uses.
      let html: string;
      try {
        html = (await storage.readObject(entryKey)).toString('utf-8');
      } catch {
        const res = await fetch(storage.getSimPublicUrl(entryKey)).catch(() => null);
        if (!res || !res.ok) return reply.code(404).send({ message: 'Simulation entry file not found' });
        html = await res.text();
      }

      return reply.send({ controls: scanSimUiControls(html), source: 'static' });
    },
  );

  // GET /api/v1/projects/:id/simulations/:simId/download.zip
  app.get<{ Params: { id: string; simId: string } }>(
    '/api/v1/projects/:id/simulations/:simId/download.zip',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await editableProject(request.params.id, user);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const sim = await db.query.simulations.findFirst({
        where: and(eq(simulations.id, request.params.simId), eq(simulations.project_id, project.id)),
      });
      if (!sim) return reply.code(404).send({ message: 'Simulation not found' });

      const zip = new AdmZip();
      const safeName = sim.name.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'simulation';

      // REVISION-AWARE (audit D-04). Zipping the whole prefix shipped every revision the package
      // has ever had plus its captured posters — so a download → edit → replace round-trip grew
      // the package on every pass, and the archive's `revisions/<id>/package/index.html` was not a
      // path anybody could upload back. The ZIP is the LIVE package, at the paths the customer
      // uploaded it under.
      const activeForZip = await activePackageOr409(sim, reply);
      if ('sent' in activeForZip) return reply;

      if (activeForZip.pkg) {
        if (activeForZip.pkg.files.length === 0) {
          return reply.code(404).send({ message: 'No simulation files found — try re-uploading the simulation.' });
        }
        for (const f of activeForZip.pkg.files) {
          zip.addFile(f.relPath, await storage.readObject(f.key));
        }
        return reply
          .header('Content-Type', 'application/zip')
          .header('Content-Disposition', `attachment; filename="${safeName}.zip"`)
          .send(zip.toBuffer());
      }

      const allKeys = (await storage.listObjects(sim.storage_prefix)).sort();
      const prefix = sim.storage_prefix.endsWith('/') ? sim.storage_prefix : sim.storage_prefix + '/';
      const keys = allKeys.filter(k => k.startsWith(prefix));

      if (keys.length === 0) {
        return reply.code(404).send({ message: 'No simulation files found — try re-uploading the simulation.' });
      }

      for (const key of keys) {
        const relativePath = key.slice(prefix.length).replace(/^\/+/, '');
        if (!relativePath) continue;
        const buf = await storage.readObject(key);
        zip.addFile(relativePath, buf);
      }

      return reply
        .header('Content-Type', 'application/zip')
        .header('Content-Disposition', `attachment; filename="${safeName}.zip"`)
        .send(zip.toBuffer());
    },
  );

  // DELETE /api/v1/projects/:id/simulations/:simId
  app.delete<{ Params: { id: string; simId: string } }>(
    '/api/v1/projects/:id/simulations/:simId',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await editableProject(request.params.id, user);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const sim = await db.query.simulations.findFirst({
        where: and(eq(simulations.id, request.params.simId), eq(simulations.project_id, project.id)),
      });
      if (!sim) return reply.code(404).send({ message: 'Simulation not found' });

      // Delete storage files first
      await storage.deleteWithPrefix(sim.storage_prefix).catch((err: unknown) =>
        logger.warn({ err, prefix: sim.storage_prefix }, 'Could not delete simulation storage'),
      );

      // Clear the denormalized sim fields on any sections that referenced this sim BEFORE
      // deleting it, so buildPlayerConfig stops emitting a now-dead simulation_url to the
      // player. The FK only nulls simulation_id; the cached url/script/meta would otherwise
      // linger (database-004). Both in one transaction so they can't diverge.
      await db.transaction(async (tx) => {
        await tx.update(timeline_sections)
          .set({ simulation_url: null, sim_script: null, sim_meta: null })
          .where(eq(timeline_sections.simulation_id, sim.id));
        await tx.delete(simulations).where(eq(simulations.id, sim.id));
      });
      return reply.code(204).send();
    },
  );

  // ── Guided Simulation (mother-sim-level) ──────────────────────────────────────

  // Helper: load the project (editable by user: owner or collaborator) + simulation.
  const loadOwnedSim = async (user: CollabUser, projectId: string, simId: string) => {
    const project = await editableProject(projectId, user);
    if (!project) return null;
    const sim = await db.query.simulations.findFirst({
      where: and(eq(simulations.id, simId), eq(simulations.project_id, project.id)),
    });
    if (!sim) return null;
    return { project, sim };
  };

  // GET /api/v1/projects/:id/simulations/:simId/generate-guidance/stream
  // SSE — deep analysis + draft cues (no audio yet). Auth via ?token= query param.
  app.get<{ Params: { id: string; simId: string }; Querystring: { language?: string } }>(
    '/api/v1/projects/:id/simulations/:simId/generate-guidance/stream',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const owned = await loadOwnedSim(user, request.params.id, request.params.simId);
      if (!owned) return reply.code(404).send({ message: 'Simulation not found' });
      if (owned.sim.status !== 'ready') return reply.code(400).send({ message: 'Simulation is not ready yet' });

      const language = (String(request.query.language ?? 'en').slice(0, 10)) || 'en';

      const origin = request.headers.origin;
      reply.raw.setHeader('Access-Control-Allow-Origin', origin ?? '*');
      reply.raw.setHeader('Access-Control-Allow-Credentials', 'true');
      reply.raw.setHeader('Content-Type', 'text/event-stream');
      reply.raw.setHeader('Cache-Control', 'no-cache');
      reply.raw.setHeader('Connection', 'keep-alive');
      reply.raw.setHeader('X-Accel-Buffering', 'no');
      const sendEvent = (event: string, data: object) => {
        try { reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* closed */ }
      };
      sendEvent('connected', {});
      const keepAlive = setInterval(() => { try { reply.raw.write(': keep-alive\n\n'); } catch { /* closed */ } }, 15_000);
      const controller = new AbortController();
      request.raw.on('close', () => { controller.abort(); clearInterval(keepAlive); });

      await db.update(simulations).set({ guidance_status: 'analyzing', guidance_error: null }).where(eq(simulations.id, owned.sim.id));

      try {
        const svc = new GuidanceService(storage, _llmService);
        const result = await svc.analyzeAndDraft({
          simId: owned.sim.id, projectId: owned.project.id, userId: user.id,
          language, onEvent: sendEvent, signal: controller.signal,
        });
        if (!controller.signal.aborted) {
          const meta = {
            provider: result.provider, model: result.model, confidence: result.confidence,
            sourceHash: result.sourceHash, mdUrl: result.mdUrl, language: result.language,
            generatedAt: new Date().toISOString(), entryCount: result.entries.length,
            droppedCount: result.droppedCount, warnings: result.warnings,
          };
          const [updated] = await db.update(simulations)
            .set({ guidance: result.entries, guidance_meta: meta, guidance_status: 'draft', guidance_error: null })
            .where(eq(simulations.id, owned.sim.id)).returning();
          sendEvent('done', { simulation: serializeSim(updated) });
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          const errorType = classifyGuidanceError(err);
          await db.update(simulations)
            .set({ guidance_status: 'error', guidance_error: (err instanceof Error ? err.message : String(err)).slice(0, 500) })
            .where(eq(simulations.id, owned.sim.id));
          sendEvent('error', { error: GUIDANCE_ERROR_MESSAGES[errorType] ?? GUIDANCE_ERROR_MESSAGES.generation_error, errorType });
        }
      } finally {
        clearInterval(keepAlive);
        try { reply.raw.end(); } catch { /* already closed */ }
      }
    },
  );

  // PATCH /api/v1/projects/:id/simulations/:simId/guidance
  // Save editor edits (narration text, enabled flags) to the draft. Keeps status 'draft'.
  app.patch<{ Params: { id: string; simId: string } }>(
    '/api/v1/projects/:id/simulations/:simId/guidance',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const owned = await loadOwnedSim(user, request.params.id, request.params.simId);
      if (!owned) return reply.code(404).send({ message: 'Simulation not found' });

      const parsed = z.object({ entries: z.array(StoredGuidanceEntrySchema) }).safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ message: 'Invalid guidance entries' });

      const entries = parsed.data.entries as unknown as GuidanceEntryStored[];
      const [updated] = await db.update(simulations)
        .set({ guidance: entries })
        .where(eq(simulations.id, owned.sim.id)).returning();
      return reply.send(serializeSim(updated));
    },
  );

  // PATCH /api/v1/projects/:id/simulations/:simId — rename the simulation
  app.patch<{ Params: { id: string; simId: string }; Body: { name?: string } }>(
    '/api/v1/projects/:id/simulations/:simId',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const owned = await loadOwnedSim(user, request.params.id, request.params.simId);
      if (!owned) return reply.code(404).send({ message: 'Simulation not found' });

      const name = (request.body?.name ?? '').trim();
      if (!name) return reply.code(400).send({ message: 'name is required' });

      const [updated] = await db.update(simulations)
        .set({ name })
        .where(eq(simulations.id, owned.sim.id)).returning();
      return reply.send(serializeSim(updated));
    },
  );

  // GET /api/v1/projects/:id/simulations/:simId/publish-guidance/stream
  // SSE — synthesize audio, assemble guidance.js, inject into entry HTML. Auth via ?token=.
  app.get<{ Params: { id: string; simId: string } }>(
    '/api/v1/projects/:id/simulations/:simId/publish-guidance/stream',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const owned = await loadOwnedSim(user, request.params.id, request.params.simId);
      if (!owned) return reply.code(404).send({ message: 'Simulation not found' });

      const entries = (owned.sim.guidance as GuidanceEntryStored[] | null) ?? [];
      const meta = (owned.sim.guidance_meta as Record<string, unknown> | null) ?? {};
      const language = (meta.language as string | undefined) ?? 'en';

      const origin = request.headers.origin;
      const openStream = () => {
        reply.raw.setHeader('Access-Control-Allow-Origin', origin ?? '*');
        reply.raw.setHeader('Access-Control-Allow-Credentials', 'true');
        reply.raw.setHeader('Content-Type', 'text/event-stream');
        reply.raw.setHeader('Cache-Control', 'no-cache');
        reply.raw.setHeader('Connection', 'keep-alive');
        reply.raw.setHeader('X-Accel-Buffering', 'no');
      };
      const sendEvent = (event: string, data: object) => {
        try { reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* closed */ }
      };

      if (entries.filter(e => e.enabled).length === 0) {
        return reply.code(400).send({ message: 'No enabled guidance cues to publish — generate a draft first' });
      }

      openStream();
      sendEvent('connected', {});
      const keepAlive = setInterval(() => { try { reply.raw.write(': keep-alive\n\n'); } catch { /* closed */ } }, 15_000);
      const controller = new AbortController();
      request.raw.on('close', () => { controller.abort(); clearInterval(keepAlive); });

      await db.update(simulations).set({ guidance_status: 'publishing', guidance_error: null }).where(eq(simulations.id, owned.sim.id));

      try {
        const svc = new GuidanceService(storage, _llmService);
        const result = await svc.publishGuidance({
          simId: owned.sim.id, projectId: owned.project.id,
          entries, language, existing: entries,
          entryKey: owned.sim.entry_file,   // authoritative entry-file storage key
          meta,                             // so a revisioned publish writes the new meta in-tx
          onEvent: sendEvent, signal: controller.signal,
        });
        if (!controller.signal.aborted) {
          // ── REVISIONED: the row was already written, inside the activation transaction ──────
          //
          // Nothing to do here but report it. In particular NOT the `?g=` rewrite below: the
          // served URL of every section is composed from `active_revision_entry_key`
          // (`resolveSimulationUrl`), so the pointer flip already busted every section's cache in
          // the one row update that made the guidance live. Appending `g=` would additionally
          // write a value into `timeline_sections.simulation_url`, whose documented meaning is
          // "what THIS section published" — a per-section rewrite of a package-level fact.
          if (result.simulation) {
            sendEvent('done', { simulation: serializeSim(result.simulation) });
          } else {
            const newMeta = guidancePublishMeta(meta, result);
            const [updated] = await db.update(simulations)
              .set({ guidance: result.entries, guidance_meta: newMeta, guidance_status: 'ready', guidance_error: null })
              .where(eq(simulations.id, owned.sim.id)).returning();

            // LEGACY ONLY. Bust the iframe cache for every section using this sim so the
            // freshly-injected guidance.js is actually loaded (the entry HTML changed in place but
            // section URLs did not). Append/replace a `g=<guidanceHash>` query param.
            const usingSecs = await db.query.timeline_sections.findMany({
              where: eq(timeline_sections.simulation_id, owned.sim.id),
            });
            for (const sec of usingSecs) {
              if (!sec.simulation_url) continue;
              const [base, query] = sec.simulation_url.split('?');
              const params = new URLSearchParams(query ?? '');
              params.set('g', result.guidanceHash);
              await db.update(timeline_sections)
                .set({ simulation_url: `${base}?${params.toString()}` })
                .where(eq(timeline_sections.id, sec.id));
            }

            sendEvent('done', { simulation: serializeSim(updated) });
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          const errorType = classifyGuidanceError(err);
          await db.update(simulations)
            .set({ guidance_status: 'error', guidance_error: (err instanceof Error ? err.message : String(err)).slice(0, 500) })
            .where(eq(simulations.id, owned.sim.id));
          sendEvent('error', { error: GUIDANCE_ERROR_MESSAGES[errorType] ?? GUIDANCE_ERROR_MESSAGES.generation_error, errorType });
        }
      } finally {
        clearInterval(keepAlive);
        try { reply.raw.end(); } catch { /* already closed */ }
      }
    },
  );
}
