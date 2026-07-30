/**
 * Regression: the two multipart upload routes used to carry
 * `config: { rawBody: false }` — unsupported Fastify route metadata with NO
 * runtime consumer anywhere in this backend (no fastify-raw-body dependency,
 * no plugin/hook reading routeOptions.config.rawBody, no FastifyContextConfig
 * augmentation). It broke strict typechecking and did nothing at runtime.
 *
 * This suite proves:
 *  - both routes still register successfully (multipart handling intact —
 *    the full authenticated parts() flows are exercised by the existing
 *    upload/replace suites in this directory);
 *  - their route options no longer contain rawBody metadata;
 *  - the multipart size/file limits are unchanged;
 *  - no other `rawBody` occurrence exists anywhere under backend-api/src.
 */
import { describe, it, expect, vi } from 'vitest';
import Fastify, { type FastifyInstance, type RouteOptions } from 'fastify';
import multipart from '@fastify/multipart';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Shallow module stubs: registration only defines routes, it never runs the
// handlers, so every service can be an inert stand-in. ─────────────────────────
vi.mock('../../../db/index.js', () => ({ db: {} }));
vi.mock('../../../db/schema.js', () => ({
  simulations: Symbol('simulations'),
  timeline_sections: Symbol('timeline_sections'),
  projects: Symbol('projects'),
  avatar_visuals: Symbol('avatar_visuals'),
  admin_settings: Symbol('admin_settings'),
  users: Symbol('users'),
}));
vi.mock('drizzle-orm', () => ({
  eq: vi.fn(), and: vi.fn(), or: vi.fn(), isNull: vi.fn(), asc: vi.fn(), desc: vi.fn(),
}));
const { firebaseAuthMiddleware } = vi.hoisted(() => ({
  firebaseAuthMiddleware: vi.fn(async () => {}),
}));
vi.mock('../../../middleware/firebase-auth.js', () => ({
  firebaseAuthMiddleware,
  firebaseAuthOptionalMiddleware: vi.fn(async () => {}),
}));
vi.mock('../../../services/collabAccess.js', () => ({ editableProject: vi.fn(), isCollaborator: vi.fn() }));
vi.mock('../../../services/storage/getStorageAdapter.js', () => ({ getStorageAdapter: vi.fn(() => ({})) }));
vi.mock('../../../services/storage/uploadWithFallback.js', () => ({ uploadWithFallback: vi.fn() }));
vi.mock('../../../services/simulation/SimulationService.js', () => ({
  SimulationService: class {},
  deriveEntryRelPath: vi.fn(),
  getSimulationContentType: vi.fn(),
  isTextSimulationFile: vi.fn(),
}));
vi.mock('../../../services/simulation/GuidanceService.js', () => ({ GuidanceService: class {} }));
vi.mock('../../../services/simulation/SimUiControls.js', () => ({
  scanSimUiControls: vi.fn(),
  SimUiSelectionSchema: { safeParse: vi.fn() },
}));
vi.mock('../../../services/llm/LLMService.js', () => ({ LLMService: class {} }));
vi.mock('../../../services/secrets/ApiKeyService.js', () => ({ ApiKeyService: class {}, encryptKey: vi.fn() }));
vi.mock('../../../services/usage/UsageTrackingService.js', () => ({ UsageTrackingService: class {} }));
vi.mock('../../../services/avatar/anamService.js', () => ({
  getSessionToken: vi.fn(), isAnamConfigured: vi.fn(), listAnamResource: vi.fn(),
  upsertVideoPersona: vi.fn(), enrichAvatarConfigFromAnam: vi.fn(), buildAvatarDisplay: vi.fn(),
  ensureKnowledgeGroup: vi.fn(), ensureKnowledgeTool: vi.fn(), uploadKnowledgeDocument: vi.fn(),
  listKnowledgeDocuments: vi.fn(), deleteKnowledgeDocument: vi.fn(), listSystemTools: vi.fn(),
}));
vi.mock('../../../services/avatar/anamKey.js', () => ({ resolveAnamKeyForProject: vi.fn() }));
vi.mock('../../../services/avatar/visualService.js', () => ({
  analyzeVisual: vi.fn(), generateLibrarySimulation: vi.fn(), editLibrarySimulation: vi.fn(),
}));
vi.mock('../../../services/avatar/imageService.js', () => ({
  analyzeAndGenerateImage: vi.fn(), generateLibraryImage: vi.fn(),
}));
vi.mock('../../../services/avatar/libraryService.js', () => ({
  insertVisual: vi.fn(), listVisuals: vi.fn(), updateVisual: vi.fn(), deleteVisual: vi.fn(),
  syncBasicLibrary: vi.fn(), storeImageBuffer: vi.fn(), storeSimulationHtml: vi.fn(),
}));
vi.mock('../../../services/avatar/memoryService.js', () => ({
  saveTurns: vi.fn(), getTurns: vi.fn(), getProfile: vi.fn(), extractAndSaveFacts: vi.fn(),
}));
vi.mock('../../../services/avatar/memoryToken.js', () => ({ signMemoryToken: vi.fn(), verifyMemoryToken: vi.fn() }));
vi.mock('../../../services/avatar/avatarAccess.js', () => ({
  avatarProjectAllowed: vi.fn(), avatarProjectAllowedAsync: vi.fn(),
}));
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { registerSimulationsRoutes } from '../simulations.controller.js';
import { registerAvatarRoutes } from '../avatar.controller.js';

async function collectRoutes(register: (app: FastifyInstance) => Promise<void>): Promise<RouteOptions[]> {
  const app = Fastify();
  await app.register(multipart);
  const routes: RouteOptions[] = [];
  app.addHook('onRoute', (r) => { routes.push(r as unknown as RouteOptions); });
  await register(app);
  await app.ready();
  await app.close();
  return routes;
}

function findPost(routes: RouteOptions[], url: string): RouteOptions | undefined {
  return routes.find((r) => r.url === url &&
    (Array.isArray(r.method) ? r.method.includes('POST') : r.method === 'POST'));
}

describe('multipart upload routes — no unsupported rawBody config', () => {
  it('simulations upload registers, keeps auth, and has no rawBody metadata', async () => {
    const routes = await collectRoutes(registerSimulationsRoutes);
    const upload = findPost(routes, '/api/v1/projects/:id/simulations/upload');
    expect(upload).toBeTruthy();
    expect((upload!.config as Record<string, unknown> | undefined)?.rawBody).toBeUndefined();
    const pre = ([] as unknown[]).concat(upload!.preHandler ?? []);
    expect(pre).toContain(firebaseAuthMiddleware);
  });

  it('avatar library upload registers, keeps auth, and has no rawBody metadata', async () => {
    const routes = await collectRoutes(registerAvatarRoutes);
    const upload = findPost(routes, '/api/v1/projects/:id/avatar/library/upload');
    expect(upload).toBeTruthy();
    expect((upload!.config as Record<string, unknown> | undefined)?.rawBody).toBeUndefined();
    const pre = ([] as unknown[]).concat(upload!.preHandler ?? []);
    expect(pre).toContain(firebaseAuthMiddleware);
  });

  it('multipart size/file limits are unchanged', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const simSrc = readFileSync(resolve(here, '../simulations.controller.ts'), 'utf8');
    expect(simSrc).toContain('const SIMULATION_UPLOAD_MAX_BYTES = 250 * 1024 * 1024;');
    expect(simSrc).toContain('const SIMULATION_UPLOAD_MAX_FILES = 1000;');
    expect(simSrc).toMatch(/fileSize: SIMULATION_UPLOAD_MAX_BYTES,\s*\n\s*files:\s*SIMULATION_UPLOAD_MAX_FILES,/);
    const avatarSrc = readFileSync(resolve(here, '../avatar.controller.ts'), 'utf8');
    expect(avatarSrc).toMatch(/limits:\s*{\s*\n\s*fileSize: AVATAR_LIBRARY_UPLOAD_MAX_BYTES,/);
  });

  it('no rawBody metadata remains anywhere under backend-api/src', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const srcRoot = resolve(here, '../../..');   // backend-api/src
    const self = fileURLToPath(import.meta.url);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        const st = statSync(p);
        if (st.isDirectory()) { walk(p); continue; }
        if (!/\.(ts|js|mjs|cts|mts)$/.test(name)) continue;
        if (p === self) continue;   // this guard file mentions the word by design
        if (/\brawBody\b/.test(readFileSync(p, 'utf8'))) offenders.push(p);
      }
    };
    walk(srcRoot);
    expect(offenders).toEqual([]);
  });
});
