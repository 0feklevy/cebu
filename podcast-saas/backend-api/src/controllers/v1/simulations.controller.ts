import type { FastifyInstance, FastifyReply } from 'fastify';
import { randomUUID } from 'crypto';
import { db } from '../../db/index.js';
import { projects, simulations } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { firebaseAuthMiddleware } from '../../middleware/firebase-auth.js';
import { getStorageAdapter } from '../../services/storage/getStorageAdapter.js';
import {
  getSimulationContentType,
  isTextSimulationFile,
  SimulationService,
  type UploadedSimulationFile,
} from '../../services/simulation/SimulationService.js';
import { LLMService } from '../../services/llm/LLMService.js';
import { ApiKeyService } from '../../services/secrets/ApiKeyService.js';
import { UsageTrackingService } from '../../services/usage/UsageTrackingService.js';
import { logger } from '../../lib/logger.js';

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

      const allKeys = await storage.listObjects(sim.storage_prefix);
      const files = allKeys
        .filter(isTextSimulationFile)
        .sort()
        .map(k => ({
          key:      k,
          filename: k.split('/').pop() ?? k,
          ext:      (k.split('.').pop() ?? '').toLowerCase(),
          url:      storage.getSimPublicUrl(k),
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

      const buf = await storage.readObject(key);
      if (!isTextSimulationFile(key)) {
        return reply.code(415).send({ message: 'Only text simulation files can be read as source' });
      }
      return reply
        .header('Content-Type', getSimulationContentType(key))
        .send(buf.toString('utf-8'));
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

      await db.delete(simulations).where(eq(simulations.id, sim.id));
      return reply.code(204).send();
    },
  );
}
