import type { FastifyInstance, FastifyReply } from 'fastify';
import { randomUUID } from 'crypto';
import AdmZip from 'adm-zip';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { projects, simulations, timeline_sections } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { firebaseAuthMiddleware } from '../../middleware/firebase-auth.js';
import { getStorageAdapter } from '../../services/storage/getStorageAdapter.js';
import {
  getSimulationContentType,
  isTextSimulationFile,
  SimulationService,
  type UploadedSimulationFile,
} from '../../services/simulation/SimulationService.js';
import {
  GuidanceService,
  type GuidanceEntryStored,
} from '../../services/simulation/GuidanceService.js';
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
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
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
      config: { rawBody: false },
    },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
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

  // GET /api/v1/projects/:id/simulations/:simId/files
  app.get<{ Params: { id: string; simId: string } }>(
    '/api/v1/projects/:id/simulations/:simId/files',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const sim = await db.query.simulations.findFirst({
        where: and(eq(simulations.id, request.params.simId), eq(simulations.project_id, project.id)),
      });
      if (!sim) return reply.code(404).send({ message: 'Simulation not found' });

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
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
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

  // GET /api/v1/projects/:id/simulations/:simId/download.zip
  app.get<{ Params: { id: string; simId: string } }>(
    '/api/v1/projects/:id/simulations/:simId/download.zip',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const sim = await db.query.simulations.findFirst({
        where: and(eq(simulations.id, request.params.simId), eq(simulations.project_id, project.id)),
      });
      if (!sim) return reply.code(404).send({ message: 'Simulation not found' });

      const allKeys = (await storage.listObjects(sim.storage_prefix)).sort();
      const prefix = sim.storage_prefix.endsWith('/') ? sim.storage_prefix : sim.storage_prefix + '/';
      const keys = allKeys.filter(k => k.startsWith(prefix));

      if (keys.length === 0) {
        return reply.code(404).send({ message: 'No simulation files found — try re-uploading the simulation.' });
      }

      const zip = new AdmZip();
      for (const key of keys) {
        const relativePath = key.slice(prefix.length).replace(/^\/+/, '');
        if (!relativePath) continue;
        const buf = await storage.readObject(key);
        zip.addFile(relativePath, buf);
      }

      const safeName = sim.name.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'simulation';
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
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
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

  // Helper: own the project + simulation, returning both or null.
  const loadOwnedSim = async (userId: string, projectId: string, simId: string) => {
    const project = await db.query.projects.findFirst({
      where: and(eq(projects.id, projectId), eq(projects.created_by, userId)),
    });
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
      const owned = await loadOwnedSim(user.id, request.params.id, request.params.simId);
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
      const owned = await loadOwnedSim(user.id, request.params.id, request.params.simId);
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
      const owned = await loadOwnedSim(user.id, request.params.id, request.params.simId);
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
      const owned = await loadOwnedSim(user.id, request.params.id, request.params.simId);
      if (!owned) return reply.code(404).send({ message: 'Simulation not found' });

      const entries = (owned.sim.guidance as GuidanceEntryStored[] | null) ?? [];
      const meta = (owned.sim.guidance_meta as Record<string, unknown> | null) ?? {};
      const language = (meta.language as string | undefined) ?? 'en';
      if (entries.filter(e => e.enabled).length === 0) {
        return reply.code(400).send({ message: 'No enabled guidance cues to publish — generate a draft first' });
      }

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

      await db.update(simulations).set({ guidance_status: 'publishing', guidance_error: null }).where(eq(simulations.id, owned.sim.id));

      try {
        const svc = new GuidanceService(storage, _llmService);
        const result = await svc.publishGuidance({
          simId: owned.sim.id, projectId: owned.project.id,
          entries, language, existing: entries,
          entryKey: owned.sim.entry_file,   // authoritative entry-file storage key
          onEvent: sendEvent, signal: controller.signal,
        });
        if (!controller.signal.aborted) {
          const newMeta = { ...meta, guidanceHash: result.guidanceHash, language: result.language, publishedAt: new Date().toISOString() };
          const [updated] = await db.update(simulations)
            .set({ guidance: result.entries, guidance_meta: newMeta, guidance_status: 'ready', guidance_error: null })
            .where(eq(simulations.id, owned.sim.id)).returning();

          // Bust the iframe cache for every section using this sim so the freshly-injected
          // guidance.js is actually loaded (the entry HTML changed but section URLs did not).
          // Append/replace a `g=<guidanceHash>` query param on each section's simulation_url.
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
