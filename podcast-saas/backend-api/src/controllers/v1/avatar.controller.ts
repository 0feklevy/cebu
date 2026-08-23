// Ask-the-Avatar — interactive avatar conversation + visual Library.
// Public conversation endpoints (used by viewers, possibly anonymous) +
// authenticated project-library management (used by the editor).
//
// Library model:
//   • basic     — this project's editor media (images + ready sims), AUTO-SYNCED
//                 from the project (no manual import/upload).
//   • extended  — GLOBAL pool (project_id = null) of every visual the avatar has
//                 generated for any viewer of any video; reused everywhere.
// At runtime the avatar prefers basic, then global extended, over generating new.
import { randomUUID } from 'crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { rateLimit } from '../../lib/rateLimit.js';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { uploadWithFallback } from '../../services/storage/uploadWithFallback.js';
import { getStorageAdapter } from '../../services/storage/getStorageAdapter.js';
import { projects, avatar_visuals, admin_settings, users } from '../../db/schema.js';
import { firebaseAuthMiddleware, firebaseAuthOptionalMiddleware } from '../../middleware/firebase-auth.js';
import { SimulationService } from '../../services/simulation/SimulationService.js';
import { LLMService } from '../../services/llm/LLMService.js';
import { ApiKeyService } from '../../services/secrets/ApiKeyService.js';
import { UsageTrackingService } from '../../services/usage/UsageTrackingService.js';
import {
  getSessionToken, isAnamConfigured, listAnamResource, upsertVideoPersona,
  enrichAvatarConfigFromAnam, buildAvatarDisplay, peekAvatarLook,
  ensureKnowledgeGroup, ensureKnowledgeTool, uploadKnowledgeDocument, listKnowledgeDocuments, deleteKnowledgeDocument, listSystemTools,
  type AvatarPersonaConfig, type AvatarDisplay,
} from '../../services/avatar/anamService.js';
import { getProjectTranscript } from '../../services/transcriptPropagation.js';
import { encryptKey } from '../../services/secrets/ApiKeyService.js';
import { resolveAnamKeyForProject } from '../../services/avatar/anamKey.js';
import { normalizeAvatarCircles, type AvatarCirclesLike } from '../../services/avatarCircles/normalizeAvatarCircles.js';
import { circleFaceUrlPersistError } from '../../services/avatarCircles/circleFaceUrls.js';
import { isProd } from '../../config/publicOrigins.js';
import { analyzeVisual, generateLibrarySimulation, editLibrarySimulation } from '../../services/avatar/visualService.js';
import { analyzeAndGenerateImage, generateLibraryImage } from '../../services/avatar/imageService.js';
import { insertVisual, listVisuals, updateVisual, deleteVisual, syncBasicLibrary, storeImageBuffer, storeSimulationHtml } from '../../services/avatar/libraryService.js';
import { saveTurns, getTurns, getProfile, extractAndSaveFacts, type Turn } from '../../services/avatar/memoryService.js';
import { avatarProjectAllowedAsync } from '../../services/avatar/avatarAccess.js';
import { assertSafeZipArchive } from '../../services/security/zipGuard.js';
import { editableProject } from '../../services/collabAccess.js';
import { signMemoryToken, verifyMemoryToken } from '../../services/avatar/memoryToken.js';
import { CHARACTERS, DEFAULT_CHARACTER_ID } from '../../services/avatar/characters.js';
import { beginStartTrace } from '../../services/avatar/startTelemetry.js';
import { verifyStatefulPersona, bakedStateFor, hashTranscript, bakedCharacterId } from '../../services/avatar/personaFingerprint.js';
import { withTranscriptKnowledge, scheduleSelfHeal, type BakeInput } from '../../services/avatar/personaBake.js';
import { startIdempotencyKey, withStartIdempotency } from '../../services/avatar/startIdempotency.js';
import { scheduleDisplayResolve } from '../../services/avatar/displayIdentity.js';
import { logger } from '../../lib/logger.js';
import {
  capabilityMode, capabilityTtlSec, signAvatarCapability, verifyAvatarCapability,
  type AvatarCapabilityPayload,
} from '../../services/avatar/avatarCapability.js';
import { hashSubject, killSwitchEngaged, type AvatarDimension, type AvatarOp } from '../../services/usage/avatarBudget.js';
import { reserveAvatarSpend } from '../../services/usage/avatarBudgetRuntime.js';
import {
  UPLOAD_MAX_BYTES,
  declaredTooLarge,
  readStreamBounded,
  tooLargeMessage,
} from '../../services/security/uploadLimits.js';

// Read avatar_config defensively: normally a jsonb object, but tolerate a legacy
// double-encoded JSON string so a merge-write never spreads a string into
// numeric-index keys (which would corrupt the column).
function asPersonaConfig(v: unknown): AvatarPersonaConfig {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as AvatarPersonaConfig;
  if (typeof v === 'string') {
    try { const o = JSON.parse(v); if (o && typeof o === 'object' && !Array.isArray(o)) return o as AvatarPersonaConfig; } catch { /* ignore */ }
  }
  return {};
}

/**
 * THE CHARACTER A PROJECT-SCOPED AVATAR CALL RUNS AS.
 *
 * The project's configured persona lives in exactly one place — `projects.avatar_config` — and
 * where a project is named it is the authority. Every route here used to resolve the character as
 * `caller ?? DEFAULT_CHARACTER_ID`, or on `/avatar/start` as `caller ?? project`, so a client that
 * sent its OWN local default ('einstein', hardcoded in three client components) silently replaced
 * the persona the owner had configured. A client-side default is not a choice — it is the absence
 * of one — and it must never outrank a configured one.
 *
 * The caller is still honoured where the project expresses no preference (and on the project-less
 * global path, which has no config to consult): that is a real selection, not a default.
 *
 * Deliberately the same normalization as `bakedCharacterId`, so the character a session runs as
 * and the character the persona was BAKED as cannot drift apart for a project that configured one.
 */
function projectCharacterId(cfg: AvatarPersonaConfig | undefined, requested?: string): string {
  return resolveCharacter(cfg, requested).id;
}

/**
 * WHICH CHARACTER, AND WHETHER ANYONE ACTUALLY CHOSE IT.
 *
 * `characterId` alone answers only the first question. It is a ROUTING value — which prompt and
 * voice this session runs as — and it is never empty, because a session must run as something.
 * The client, given nothing else, treated it as an IDENTITY and rendered the character's name,
 * portrait and "Connecting to …" label from it. So a project that configured no persona at all
 * resolved to `einstein` here and every viewer of it was told, in the product's own voice, that
 * they were talking to Albert Einstein — an identity its owner never picked.
 *
 * Those are two different facts and they now travel as two fields. `source` is what lets the
 * client tell a real choice from this function's fallback, which is a distinction it cannot
 * reconstruct from the id.
 */
export function resolveCharacter(
  cfg: AvatarPersonaConfig | undefined,
  requested?: string,
): { id: string; source: 'configured' | 'requested' | 'default' } {
  const configured = cfg?.characterId?.trim();
  if (configured && CHARACTERS[configured]) return { id: configured, source: 'configured' };
  // A request may still SELECT a character on a project that names none; that is a choice.
  if (requested && CHARACTERS[requested]) return { id: requested, source: 'requested' };
  return { id: DEFAULT_CHARACTER_ID, source: 'default' };
}

/**
 * THE NAME THE POPUP SHOWS.
 *
 * `buildAvatarDisplay` answers from the avatar the session actually uses — a pinned `avatarId`, or
 * a `personaDisplay` resolved on an earlier start. Until one of those exists (the first open of a
 * video that never pinned an avatar, or a background resolve that failed) it answers with the
 * voice sensitivity ALONE, and a nameless display is not neutral on the other end: the client's
 * `characterMeta()` fills every hole from its own CHARACTER_META, whose first entry is Einstein.
 * That is how a project whose persona is called "Pnina" kept rendering "Ask Albert Einstein".
 *
 * The project's own name for the persona is already in the config; a session that minted an
 * inline persona also carries one. Either is a truthful answer, and both beat the client guessing.
 */
function namedAvatarDisplay(
  display: AvatarDisplay | undefined,
  cfg: AvatarPersonaConfig | undefined,
  personaName?: string,
): AvatarDisplay | undefined {
  if (display?.displayName?.trim()) return display;
  const name = cfg?.avatarName?.trim() || cfg?.name?.trim() || personaName?.trim();
  if (!name) return display;
  return {
    ...(display ?? {}),
    displayName: name,
    nametag: name,
    startingLabel: `Connecting to ${name}...`,
    leaveLabel: display?.leaveLabel ?? 'End conversation',
  };
}

const AVATAR_LIBRARY_UPLOAD_MAX_BYTES = 250 * 1024 * 1024;
const AVATAR_LIBRARY_UPLOAD_MAX_FILES = 40;
const _avatarLibraryLlmService = new LLMService(new ApiKeyService(), new UsageTrackingService());

type AvatarLibraryUploadAccepted = {
  filename: string;
  visualType: 'image' | 'equation' | 'chart' | 'diagram' | 'simulation';
  id: string;
};

type AvatarLibraryUploadRejected = {
  filename: string;
  reason: string;
};

function extOf(filename: string): string {
  return filename.split('.').pop()?.toLowerCase() ?? '';
}

function cleanCaption(filename: string): string {
  return filename.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim() || filename;
}

function csvToChartSpec(text: string, filename: string): Record<string, unknown> | null {
  const rows = text
    .split(/\r?\n/)
    .map((line) => line.split(',').map((cell) => cell.trim().replace(/^"|"$/g, '')))
    .filter((row) => row.some(Boolean));
  if (rows.length < 2) return null;

  const firstDataRow = Number.isFinite(Number(rows[0]?.[1])) ? 0 : 1;
  const dataRows = rows.slice(firstDataRow, firstDataRow + 24);
  const labels: string[] = [];
  const values: number[] = [];
  for (const row of dataRows) {
    const label = row[0];
    const value = Number(row[1]);
    if (label && Number.isFinite(value)) {
      labels.push(label);
      values.push(value);
    }
  }
  if (labels.length === 0) return null;
  const title = cleanCaption(filename);
  return {
    type: 'chart',
    chartType: 'bar',
    title,
    labels,
    datasets: [{ label: rows[0]?.[1] || 'Value', data: values }],
    caption: title,
  };
}

function normalizeUploadedVisualSpec(parsed: unknown, filename: string): { type: AvatarLibraryUploadAccepted['visualType']; spec: Record<string, unknown>; caption: string } | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const rawType = String(obj.visual_type ?? obj.type ?? '').toLowerCase();
  const caption = String(obj.caption ?? cleanCaption(filename));

  if (rawType === 'equation' && typeof obj.latex === 'string' && obj.latex.trim()) {
    return { type: 'equation', spec: { type: 'equation', latex: obj.latex.trim(), caption }, caption };
  }
  if (rawType === 'chart' && Array.isArray(obj.labels) && Array.isArray(obj.datasets)) {
    return {
      type: 'chart',
      spec: {
        type: 'chart',
        chartType: obj.chartType === 'line' || obj.chartType === 'pie' ? obj.chartType : 'bar',
        title: typeof obj.title === 'string' ? obj.title : caption,
        labels: obj.labels,
        datasets: obj.datasets,
        caption,
      },
      caption,
    };
  }
  if (rawType === 'diagram' && typeof obj.html === 'string' && obj.html.trim()) {
    return { type: 'diagram', spec: { type: 'diagram', html: obj.html, caption }, caption };
  }
  if (rawType === 'simulation' && typeof obj.html === 'string' && obj.html.trim()) {
    return { type: 'simulation', spec: { type: 'simulation', html: obj.html, caption, source: 'json-upload' }, caption };
  }
  return null;
}

// Bound the archive on its DECLARED headers first. This is the earliest point a library ZIP is
// parsed, and it runs on an authenticated-but-user-controlled upload. A ZipLimitError propagates
// out of processFile and lands in the per-file `rejected[]` list with its reason, so the uploader
// is told WHY the bundle was refused instead of getting "needs an HTML entry file".
function zipHasHtml(buffer: Buffer): boolean {
  const zip = assertSafeZipArchive(buffer, { label: 'Avatar library ZIP' });
  return zip.getEntries().some((entry) => !entry.isDirectory && /\.html?$/i.test(entry.entryName));
}

// ── Strict request bodies for the public avatar surface ──────────────────────────────────────
//
// These endpoints previously read whatever they were handed with a cast, which is how an
// arbitrary `projectId` reached a private library and how an unbounded `context` string reached a
// paid prompt as free input. `.strict()` refuses unknown keys as well: on a surface where the body
// selects what gets paid for, an ignored field is a field nobody is checking.
//
// The long text fields are capped TWICE on purpose. The zod cap refuses an absurd payload outright
// (cost-DoS by input size); the slice inside the handler preserves the existing truncation, so an
// ordinary long question is still answered rather than 400'd.
const CapabilityField = z.string().min(1).max(4096).optional();

const StartBody = z.object({
  projectId: z.string().uuid().optional(),
  character_id: z.string().min(1).max(64).optional(),
  startKey: z.string().min(1).max(200).optional(),
  capability: CapabilityField,
}).strict();

const EndBody = z.object({
  character_id: z.string().min(1).max(64).optional(),
  capability: CapabilityField,
}).strict();

const VisualAnalyzeBody = z.object({
  message: z.string().min(1).max(16_000),
  characterId: z.string().min(1).max(64).optional(),
  context: z.string().max(24_000).optional(),
  projectId: z.string().uuid().optional(),
  capability: CapabilityField,
}).strict();

const ImageAnalyzeBody = z.object({
  userMessage: z.string().min(1).max(16_000),
  characterId: z.string().min(1).max(64).optional(),
  conversationContext: z.string().max(24_000).optional(),
  projectId: z.string().uuid().optional(),
  capability: CapabilityField,
}).strict();

const CapabilityMintBody = z.object({
  projectId: z.string().uuid(),
  /** The project's share token, for an unlisted project reached through its link. */
  share: z.string().min(8).max(200).optional(),
}).strict();

/** Conversation context is prompt input somebody pays for; bound it before it becomes tokens. */
const MAX_CONTEXT_CHARS = 12_000;

// ── Cost control for the three BILLABLE public avatar endpoints (D-03) ───────────────────────
//
// `/avatar/start` mints a paid vendor session; `/avatar/visual/analyze` and `/avatar/image/analyze`
// run paid model calls and reach a project's private visual library. All three were open to any
// caller who could POST, bounded only by a per-process, per-IP request counter that reset on every
// deploy and counted a two-image call the same as a no-op.
//
// Requiring Firebase auth is NOT the fix and is deliberately not done here: anonymous avatar use is
// intentional (public and shared viewers expose Ask Avatar, and guests sign in anonymously), so a
// throwaway anonymous account satisfies any such check while a real-account requirement would be a
// feature regression. What is actually missing is a CAPABILITY — proof that this caller passed the
// visibility/share-token gate for THIS project — and a spend budget that survives a deploy.
//
// The layers, in the order they run, cheapest first:
//   1. kill switch          — env, then the database row inside the meter.
//   2. capability           — verified against the request's own projectId (avatarCapability.ts).
//   3. project gate         — the same visibility rule the avatar library GET already applies.
//   4. burst shield         — the old in-process limiter, demoted: weighted now, and layered over
//                             every dimension rather than the IP alone.
//   5. durable meter        — Postgres, atomic, reserved BEFORE the vendor call (avatarBudget*).

const CAPABILITY_HEADER = 'x-avatar-capability';

/** Constant subject for the platform-wide budget. Not personal data, hashed only for uniformity. */
const GLOBAL_SUBJECT = 'platform';

interface BillablePreflight {
  capability: AvatarCapabilityPayload | null;
  /** Identity the concurrency lease is keyed by. Never the raw IP. */
  leaseId: string;
  /**
   * The per-popup-open metering layer — populated ONLY when a real capability was presented.
   *
   * Without one there is no honest per-session identity: the best available substitute is
   * (address, project), which merges every viewer behind one NAT watching one video into a single
   * bucket and would turn the second student in a classroom away. Leaving the layer out instead
   * costs nothing, because it is a sub-partition of the `ip` layer, which still applies.
   */
  meterJti: string | null;
}

/**
 * The I/O-FREE half of the guard: kill switch, capability, and the rule that a public caller must
 * name a project. Runs before any database read so a flood is refused without one.
 *
 * Returns null when the request has already been answered.
 */
function preflightBillable(
  request: FastifyRequest,
  reply: FastifyReply,
  input: { projectId: string | null; capabilityToken: string | null; deniedBody: unknown },
): BillablePreflight | null {
  // ── THE EMERGENCY STOP, HONOURED WHERE ITS DOCSTRING SAYS IT IS ──────────────────────────
  //
  // `killSwitchEngaged`'s contract is "before the capability check, before the limiter and before
  // any read, so a runaway costs nothing while it is engaged". It was only ever consulted inside
  // the reservation — which on `/avatar/start` runs after the project read, the authorization
  // (which can touch the collaborators table), the transcript read, the key read and
  // `enrichAvatarConfigFromAnam`, a VENDOR ROUND TRIP. An operator pulling the emergency stop
  // during an incident still paid a database and vendor call for every inbound request, which is
  // most of what the stop exists to prevent.
  //
  // Proven, not argued: an adversarial reviewer added `expect(projectsFindFirst).not.toBeCalled()`
  // to the kill-switch test and got "called 3 times". The old test asserted only 503 and
  // nothing-spent, both of which a switch consulted on the handler's LAST line satisfies.
  //
  // This is the process-local env switch, checked with no I/O. Its database twin
  // (`avatar_budget_state.killed`) still binds inside the meter, and still binds in shadow mode —
  // shadow means "do not enforce the BUDGETS", never "ignore the emergency stop".
  if (killSwitchEngaged()) {
    reply.code(503).header('Retry-After', '60').send(input.deniedBody);
    return null;
  }

  const mode = capabilityMode();
  const capability = mode === 'off'
    ? null
    : verifyAvatarCapability(input.capabilityToken, { projectId: input.projectId });

  // A capability names a project, so it can only be REQUIRED where there is one to name. The
  // project-less path is not exempted by oversight: it is already restricted to a signed-in,
  // non-anonymous account (mayStartWithoutProject) and metered per uid, and demanding a
  // project-bound credential there would be satisfied by a capability for ANY project — a check
  // that cannot fail is worse than no check, because it reads like one.
  if (mode === 'enforce' && input.projectId && !capability) {
    reply.code(401).send(input.deniedBody);
    return null;
  }

  // The concurrency lease always needs SOME identity. With a capability it is the nonce, so one
  // popup open holds one lease however many times it retries. Without one it falls back to
  // (address, project): coarse, and it undercounts a NAT'd audience — but leases are the soft
  // safety bound on live vendor sessions, not the money limit, and the money limit is exact.
  const leaseSource = capability?.j ?? `anon|${request.ip}|${input.projectId ?? 'global'}`;
  return {
    capability,
    leaseId: hashSubject('jti', leaseSource),
    meterJti: capability ? hashSubject('jti', capability.j) : null,
  };
}

/**
 * The metered half: reserve weighted cost across every layer BEFORE the vendor is called. Answers
 * the request itself (with `Retry-After`) on refusal and returns false.
 */
async function reserveBillable(
  request: FastifyRequest,
  reply: FastifyReply,
  op: AvatarOp,
  input: {
    leaseId: string;
    meterJti: string | null;
    projectId: string | null;
    ownerId: string | null;
    deniedBody: unknown;
    /** Only a session-minting op takes out a concurrency lease. */
    takesLease?: boolean;
  },
): Promise<{ ok: true; shadowDeniedBy?: string } | { ok: false }> {
  const subjects: Partial<Record<AvatarDimension, string>> = {
    ip: hashSubject('ip', request.ip),
    global: hashSubject('global', GLOBAL_SUBJECT),
  };
  if (input.meterJti) subjects.jti = input.meterJti;
  if (request.dbUser?.id) subjects.uid = hashSubject('uid', request.dbUser.id);
  if (input.projectId) subjects.project = hashSubject('project', input.projectId);
  if (input.ownerId) subjects.owner = hashSubject('owner', input.ownerId);

  const verdict = await reserveAvatarSpend({
    op,
    subjects,
    leaseJti: input.takesLease ? input.leaseId : undefined,
  });

  if (verdict.allowed) return { ok: true, shadowDeniedBy: verdict.shadowDeniedBy };

  // A structured line with no raw IP, no project id and no token — the denial is attributable by
  // layer, which is what an operator needs, and by nothing else.
  logger.warn({ evt: 'avatar_spend_denied', op, deniedBy: verdict.deniedBy, status: verdict.status },
    '[Avatar] billable call refused');
  reply.code(verdict.status)
    .header('Retry-After', String(Math.max(1, verdict.retryAfterSec)))
    .send(input.deniedBody);
  return { ok: false };
}

/**
 * The project gate for a BILLABLE call. Identical in rule to the avatar library GET (security-004):
 * public and unlisted are part of the viewer experience, private is owner/collaborator only. It
 * also returns the owner so the reservation can meter the account that will be billed.
 *
 * A denial is 404, never 403, so a private project's existence is not revealed by a paid endpoint.
 */
async function allowedProjectForBillable(
  request: FastifyRequest,
  projectId: string | null,
): Promise<{ allowed: boolean; ownerId: string | null; cfg: AvatarPersonaConfig | undefined }> {
  if (!projectId) return { allowed: true, ownerId: null, cfg: undefined };
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
    // `avatar_config` rides along on a read this gate already performs: the visual and image
    // routes need the project's configured character, and paying a second query for a field
    // sitting in the row we just fetched would be the only reason not to consult it.
    columns: { visibility: true, created_by: true, avatar_config: true },
  }).catch(() => null);
  if (!project) return { allowed: false, ownerId: null, cfg: undefined };
  const allowed = await avatarProjectAllowedAsync(projectId, project, request.dbUser ?? null);
  return { allowed, ownerId: project.created_by ?? null, cfg: asPersonaConfig(project.avatar_config) };
}

/** The capability presented with a request: body field first, then the header. */
function capabilityTokenOf(request: FastifyRequest, bodyValue: string | undefined): string | null {
  if (typeof bodyValue === 'string' && bodyValue) return bodyValue;
  const header = request.headers[CAPABILITY_HEADER];
  return typeof header === 'string' && header ? header : null;
}

/**
 * A public caller must name a project. The global, project-less avatar was a bodyless POST that
 * minted a paid vendor session for anybody — it is gone for anonymous callers, including
 * Firebase-anonymous ones, because a disposable anonymous account is not a bound on anything. A
 * signed-in, non-anonymous account keeps it: that path is attributable and already metered per uid.
 */
function mayStartWithoutProject(request: FastifyRequest): boolean {
  const user = request.dbUser;
  return Boolean(user && !user.is_anonymous);
}

export async function registerAvatarRoutes(app: FastifyInstance): Promise<void> {
  // ── Public: health ─────────────────────────────────────────────────────────
  app.get('/api/v1/avatar/health', async () => ({
    ok: true,
    anam: isAnamConfigured(),
    openai: Boolean(process.env.OPENAI_API_KEY),
    defaultCharacter: DEFAULT_CHARACTER_ID,
    characters: Object.keys(CHARACTERS),
  }));


  // ── Public: mint a short-lived spend capability for one project ────────────
  //
  // This is the mint the ruling asks for: it runs the visibility AND share-token checks first and
  // only then issues a credential. A project UUID is not a capability — it is a name, it is in
  // every URL, and for an unlisted project it is the one thing a link-holder is not supposed to be
  // able to hand around. What comes back is bound to this project, carries a nonce so the meter
  // can bill one popup open rather than one video, and expires.
  //
  // It is a POST because it MINTS; it is optional-auth because anonymous viewing is the point.
  app.post('/api/v1/avatar/capability', { preHandler: [firebaseAuthOptionalMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = CapabilityMintBody.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ message: 'projectId is required' });
    const { projectId, share } = parsed.data;
    // Minting is cheap (one indexed read) but not free, and it is the one route on this surface a
    // caller can hit without a capability — so it keeps a plain per-IP shield of its own, keyed by
    // the hashed IP so no raw address is held even in process memory.
    if (!rateLimit(`avatar-cap:${hashSubject('ip', request.ip)}`, 60, 60_000)) {
      return reply.code(429).header('Retry-After', '60').send({ message: 'Too many requests' });
    }
    const project = await db.query.projects.findFirst({
      where: eq(projects.id, projectId),
      columns: { visibility: true, created_by: true, share_token: true },
    }).catch(() => null);
    if (!project) return reply.code(404).send({ message: 'Project not found' });

    // A valid share token admits a link-holder to an unlisted project; otherwise the ordinary
    // viewer gate decides. Both are checked BEFORE anything is signed.
    const viaShare = Boolean(share && project.share_token && share === project.share_token);
    const allowed = viaShare || await avatarProjectAllowedAsync(projectId, project, request.dbUser ?? null);
    if (!allowed) return reply.code(404).send({ message: 'Project not found' });

    const minted = signAvatarCapability({ projectId, uid: request.dbUser?.id ?? null });
    return reply.send({ capability: minted.token, expiresAt: minted.expiresAt, ttlSec: capabilityTtlSec() });
  });

  // ── Public: start an avatar session (applies the video's saved persona config) ─
  //
  // Every phase of this handler is timed into ONE redacted structured line (see
  // services/avatar/startTelemetry.ts). The endpoint used to log only failures, which is why
  // the "very very slow" report could not be attributed to a phase. The trace is the only log
  // this handler emits: it carries durations, the persona path taken and the outcome, and it
  // cannot carry a token, key, transcript, prompt or persona body by construction.
  app.post('/api/v1/avatar/start', { preHandler: [firebaseAuthOptionalMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsedStart = StartBody.safeParse(request.body ?? {});
    if (!parsedStart.success) return reply.code(400).send({ message: 'Invalid request body' });
    const body = parsedStart.data;
    const trace = beginStartTrace({
      projectId: body.projectId,
      characterId: body.character_id,
      authenticated: Boolean(request.dbUser),
    });
    // The bodyless global mint is gone for public callers (D-03). It cost real money and named
    // nothing: no project to authorize against, no owner to bill, no visibility to check.
    if (!body.projectId && !mayStartWithoutProject(request)) {
      trace.finish({ outcome: 'error', status: 400 });
      return reply.code(400).send({ message: 'projectId is required' });
    }
    const pre = preflightBillable(request, reply, {
      projectId: body.projectId ?? null,
      capabilityToken: capabilityTokenOf(request, body.capability),
      deniedBody: { message: 'Avatar capability required' },
    });
    if (!pre) {
      trace.finish({ outcome: 'error', status: 401 });
      return reply;
    }
    trace.flag(pre.capability ? 'capability_ok' : 'capability_absent');
    let cfg: AvatarPersonaConfig | undefined;
    let apiKey: string | undefined;
    let characterId: string;
    let characterSource: 'configured' | 'requested' | 'default';
    let ownerId: string | null = null;
    let selfHeal: BakeInput | null = null;
    if (body.projectId) {
      const project = await trace.time('project_read', () => db.query.projects.findFirst({ where: eq(projects.id, body.projectId!), columns: { avatar_config: true, visibility: true, created_by: true } }).catch(() => null));
      if (!project) {
        trace.finish({ outcome: 'not_found', status: 404 });
        return reply.code(404).send({ message: 'Project not found' });
      }
      const allowed = await trace.time('authorize', () => avatarProjectAllowedAsync(body.projectId!, project, request.dbUser ?? null));
      if (!allowed) {
        trace.finish({ outcome: 'not_found', status: 404 });
        return reply.code(404).send({ message: 'Project not found' });
      }
      ownerId = project.created_by ?? null;
      cfg = asPersonaConfig(project.avatar_config);
      // The PROJECT's configured character decides (projectCharacterId). `body.character_id ??
      // bakedCharacterId(cfg)` had it the other way round: the caller won, so the reconnect in
      // AvatarConversation — which echoes back whatever the first start resolved — and any client
      // shipping its own 'einstein' default could override the persona the owner configured.
      // A request may still SELECT a character on a project that names none; that is a choice,
      // not a default. The character the persona was BAKED as still comes from the config alone
      // (bakedCharacterId), so a request can never redefine the saved persona and re-bake it.
      ({ id: characterId, source: characterSource } = resolveCharacter(cfg, body.character_id));

      // THE DECISION, taken BEFORE any further read. A saved persona is referenced by id (one
      // vendor round-trip, ~118-byte body) exactly while the recorded fingerprint still describes
      // this config — same prompt, greeting, avatar/voice/brain, tools AND transcript revision.
      // Anything else falls back to an inline persona for THIS start and schedules a re-bake, so
      // the video is on the fast path from the next start onwards. The old code guessed from
      // `knowledgeToolId` alone and threw the pre-baked personaId away on every start — the
      // measured cause of the slow start.
      const verdict = verifyStatefulPersona(cfg);
      const healthy = verdict === 'healthy';

      // A healthy start needs NOTHING from the transcript or from the account listings: the
      // persona already carries this exact script and its own avatar/voice. Reading captions for
      // every video in the project and then discarding the result was pure latency. On the
      // fallback path the transcript read and the key read are independent of each other and both
      // legal only after authorization, so they run concurrently.
      const transcriptPromise = healthy
        ? null
        : trace.time('transcript_read', () => getProjectTranscript(body.projectId!).catch(() => null));
      apiKey = await trace.time('key_read', () => resolveAnamKeyForProject(body.projectId, project.created_by).catch(() => undefined));

      if (healthy) {
        trace.path('stateful');
      } else {
        trace.path('ephemeral');
        if (verdict === 'never_fingerprinted') trace.flag('fingerprint_absent');
        else if (verdict !== 'no_persona') trace.flag('fingerprint_miss');
        // Resolve the selected avatar's display name/image (and default voice) from Anam when they
        // were not persisted — otherwise the popup falls back to the default character's
        // image/name (the "always Einstein" bug). Only reachable on the fallback path, where an
        // inline persona has to name a concrete avatar and voice anyway.
        const enrichPromise = cfg.avatarId && (!cfg.avatarName || !cfg.avatarImageUrl || !cfg.voiceId)
          ? trace.time('persona_enrich', () => enrichAvatarConfigFromAnam(cfg!, apiKey).catch(() => cfg!))
          : Promise.resolve(cfg);
        const [transcript, enriched] = await Promise.all([transcriptPromise!, enrichPromise]);
        cfg = enriched;
        // The video's caption transcript is the avatar's DEFAULT knowledge — inline it so this
        // session can still answer about the actual spoken content while the persona is unusable.
        selfHeal = { projectId: body.projectId, characterId: bakedCharacterId(cfg), cfg, transcript, apiKey };
        cfg = withTranscriptKnowledge(cfg, transcript);
        if (transcript) trace.flag('transcript_inlined');
        if (cfg.personaId) cfg = { ...cfg, personaId: undefined };
      }
    } else {
      trace.path('global');
      // No project, so no configured persona to be authoritative: the caller's choice is the only
      // signal, and 'einstein' is the honest fallback. This is the ONLY start path where a
      // client-supplied character decides unconditionally.
      ({ id: characterId, source: characterSource } = resolveCharacter(undefined, body.character_id));
    }
    // Reserve the session's WORST-CASE cost before the vendor is called. `/avatar/end` is a no-op
    // any client may simply never send, so nothing here is ever given back early — the lease
    // expires on its own clock. Placed after the authorization gate (so an unauthorized caller is
    // never metered) and before the mint (so a refusal costs no money).
    const reserved = await trace.time('reserve', () => reserveBillable(request, reply, 'start', {
      leaseId: pre.leaseId,
      meterJti: pre.meterJti,
      projectId: body.projectId ?? null,
      ownerId,
      takesLease: true,
      deniedBody: { message: 'Avatar is busy — try again shortly' },
    }));
    if (!reserved.ok) {
      trace.finish({ outcome: 'error', status: reply.statusCode });
      return reply;
    }
    if (reserved.shadowDeniedBy) trace.flag('budget_shadow_denied');

    // Dedupe only what is safe to dedupe: repeated asks from ONE popup open by ONE caller. Two
    // viewers of the same video always mint their own token — an Anam token is single-use per
    // stream, so sharing one refuses the second viewer's connection.
    const idempotencyKey = startIdempotencyKey({
      projectId: body.projectId ?? null,
      callerId: request.dbUser?.id ?? request.ip,
      startKey: body.startKey,
    });
    try {
      const minted = await trace.time('mint', () => withStartIdempotency(idempotencyKey, () => getSessionToken(characterId, cfg, apiKey)));
      const info = minted.value;
      if (minted.replayed) trace.flag('idempotent_replay');
      // Display identity must describe the avatar the session ACTUALLY uses — never a stale
      // hardcoded character (the "pnina but labeled Einstein" mismatch). It is pure cosmetics,
      // so it NEVER holds the minted token: answer from what is already known (the pinned avatar,
      // the persisted personaDisplay, or the bounded look cache), otherwise resolve it after the
      // response and persist it so the next open has the real face.
      let displayCfg = cfg;
      if (!displayCfg?.avatarId) {
        const stopDisplay = trace.mark('display');
        const sessionAvatarId = info.avatarId || cfg?.personaDisplay?.avatarId || '';
        const known = (sessionAvatarId ? peekAvatarLook(sessionAvatarId, apiKey) : undefined)
          ?? (cfg?.personaDisplay?.avatarId && (!sessionAvatarId || cfg.personaDisplay.avatarId === sessionAvatarId)
                ? cfg.personaDisplay
                : undefined);
        if (known) {
          displayCfg = { ...(displayCfg ?? {}), personaDisplay: known };
          trace.flag('display_cached');
        } else if (body.projectId && (info.avatarId || cfg?.personaId)) {
          const scheduled = scheduleDisplayResolve({
            projectId: body.projectId,
            avatarId: info.avatarId,
            personaId: cfg?.personaId,
            apiKey,
          });
          if (scheduled) trace.flag('display_deferred');
        }
        stopDisplay();
      }
      // Re-bake in the background so the NEXT viewer gets the one-round-trip path. Scheduling is
      // synchronous and bounded (single-flight per project, backoff after failure); the work
      // itself runs after this response.
      if (selfHeal && scheduleSelfHeal(selfHeal)) trace.flag('self_heal_queued');
      trace.finish({ outcome: 'ok', status: 200 });
      return reply.send({
        provider: 'anam',
        correlationId: trace.correlationId,
        // A start has already passed the visibility gate for this project, so it is a legitimate
        // mint point and it hands the conversation its capability here rather than making the
        // viewer ask for one again. The popup's two follow-on billable routes can therefore be
        // switched to `enforce` without a second round-trip anywhere.
        //
        // Not a replacement for POST /avatar/capability: that route is the one a share-link or
        // permalink viewer can call with its share token, and the one that will let the player
        // config carry a capability minted at page load. This is the convenience path.
        capability: body.projectId ? signAvatarCapability({ projectId: body.projectId, uid: request.dbUser?.id ?? null }).token : undefined,
        sessionToken: info.token,
        characterId: info.characterId,
        // The provenance of that id, so the client can tell "the owner chose Einstein" from
        // "nobody chose anything and this is the fallback". Without it the two are identical on
        // the wire and the client has to guess — which is how it guessed Einstein for everyone.
        characterSource: characterSource,
        voiceSensitivity: info.voiceSensitivity,
        avatarDisplay: namedAvatarDisplay(
          buildAvatarDisplay(info.characterId, displayCfg, info.voiceSensitivity),
          displayCfg,
          info.personaName,
        ),
      });
    } catch (err) {
      const status = (err as { status?: number }).status ?? 500;
      // Deliberately NO free-form error MESSAGE here: an Anam failure detail can echo the request
      // (persona body, prompt). But the 2026-08-23 incident showed the opposite failure: a
      // statusless throw surfaced as a bare 500 and NOTHING recorded which KIND of error it was —
      // the vendor log line only exists when the vendor answered, so an internal throw left no
      // trace at all and the incident could not be diagnosed from outside the VM. So: bounded,
      // shape-only fields — the constructor name, whether a status was attached, and where it
      // happened. No message, no stack, nothing request-derived.
      logger.warn(
        {
          evt: 'avatar_start_failed',
          cid: trace.correlationId,
          status,
          errClass: (err as Error)?.constructor?.name ?? 'unknown',
          hadStatus: typeof (err as { status?: unknown }).status === 'number',
        },
        '[Avatar] start failed in the mint block',
      );
      trace.finish({ outcome: 'error', status });
      return reply.code(status).send({ message: status >= 500 ? 'Avatar session failed' : (err as Error).message });
    }
  });

  // ── Public: end session ────────────────────────────────────────────────────
  //
  // Deliberately a NO-OP, and deliberately NOT a cost release. Any client can close the tab, lose
  // its network or simply never send this, and a hostile one can send it while the vendor session
  // it claims to have ended is still running. Trusting it to hand budget back would make "spend
  // without paying" a one-line request. The session lease taken at start expires on its own clock
  // instead (migration 064); reconciling against the vendor's real session records — should Anam
  // ever expose them — is the only honest way to return cost early, and it is not this endpoint.
  app.post('/api/v1/avatar/end', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!EndBody.safeParse(request.body ?? {}).success) return reply.code(400).send({ ok: false });
    return reply.send({ ok: true });
  });

  // ── Public: visual analysis ────────────────────────────────────────────────
  app.post('/api/v1/avatar/visual/analyze', { preHandler: [firebaseAuthOptionalMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const NONE = { type: 'none' } as const;
    const parsed = VisualAnalyzeBody.safeParse(request.body ?? {});
    if (!parsed.success) return reply.send(NONE);
    const body = parsed.data;
    if (!body.projectId && !mayStartWithoutProject(request)) {
      return reply.code(400).send(NONE);
    }
    const pre = preflightBillable(request, reply, {
      projectId: body.projectId ?? null,
      capabilityToken: capabilityTokenOf(request, body.capability),
      deniedBody: NONE,
    });
    if (!pre) return reply;
    // The project id used to be taken on trust, which let any caller point a paid call at any
    // project and read its private avatar library. Gate it with the SAME rule the library GET
    // already applies (avatarAccess.ts): public and unlisted are viewer-visible, private is not.
    const gate = await allowedProjectForBillable(request, body.projectId ?? null);
    if (!gate.allowed) return reply.code(404).send(NONE);

    const reserved = await reserveBillable(request, reply, 'visual', {
      leaseId: pre.leaseId,
      meterJti: pre.meterJti,
      projectId: body.projectId ?? null,
      ownerId: gate.ownerId,
      deniedBody: NONE,
    });
    if (!reserved.ok) return reply;

    const message = body.message.slice(0, 4000);
    const context = body.context?.slice(0, MAX_CONTEXT_CHARS);
    // The project's configured character decides which persona the visual is styled and captioned
    // for. This route used to ignore the project entirely and take the caller's word — so a video
    // configured as somebody else got Einstein's visual vocabulary whenever the client sent its
    // own default. `gate.cfg` is undefined only on the project-less path, where the caller's
    // choice (else the default) is all there is.
    const characterId = projectCharacterId(gate.cfg, body.characterId);
    // Keep the project's basic library fresh so it's preferred at retrieval (throttled).
    if (body.projectId) syncBasicLibrary(body.projectId).catch(() => {});
    try {
      const result = await analyzeVisual(message, characterId, context, { projectId: body.projectId ?? null });
      return reply.send(result);
    } catch (err) {
      logger.warn({ err }, '[Avatar] visual/analyze failed');
      return reply.send(NONE);
    }
  });

  // ── Public: image analysis ─────────────────────────────────────────────────
  app.post('/api/v1/avatar/image/analyze', { preHandler: [firebaseAuthOptionalMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const NO_IMAGE = { shouldGenerate: false, imageUrl: null, altText: '', caption: '', imageType: 'realistic' } as const;
    const parsed = ImageAnalyzeBody.safeParse(request.body ?? {});
    if (!parsed.success) return reply.send(NO_IMAGE);
    const body = parsed.data;
    if (!body.projectId && !mayStartWithoutProject(request)) {
      return reply.code(400).send(NO_IMAGE);
    }
    const pre = preflightBillable(request, reply, {
      projectId: body.projectId ?? null,
      capabilityToken: capabilityTokenOf(request, body.capability),
      deniedBody: NO_IMAGE,
    });
    if (!pre) return reply;
    const gate = await allowedProjectForBillable(request, body.projectId ?? null);
    if (!gate.allowed) return reply.code(404).send(NO_IMAGE);

    // This is the most expensive public call in the product — worst case one completion plus two
    // gpt-image-1 renders — and it is weighted accordingly (avatarBudget.unitsFor).
    const reserved = await reserveBillable(request, reply, 'image', {
      leaseId: pre.leaseId,
      meterJti: pre.meterJti,
      projectId: body.projectId ?? null,
      ownerId: gate.ownerId,
      deniedBody: NO_IMAGE,
    });
    if (!reserved.ok) return reply;

    const userMessage = body.userMessage.slice(0, 4000);
    const context = body.conversationContext?.slice(0, MAX_CONTEXT_CHARS);
    // Same rule as visual/analyze: where a project is named, the project decides.
    const characterId = projectCharacterId(gate.cfg, body.characterId);
    if (body.projectId) syncBasicLibrary(body.projectId).catch(() => {});
    try {
      const result = await analyzeAndGenerateImage(userMessage, characterId, context, body.projectId ?? null);
      return reply.send(result);
    } catch (err) {
      logger.warn({ err }, '[Avatar] image/analyze failed');
      return reply.send(NO_IMAGE);
    }
  });

  // ── Public: read the basic + global extended library for a project (viewer) ─
  app.get<{ Params: { id: string } }>(
    '/api/v1/avatar/projects/:id/library',
    { preHandler: [firebaseAuthOptionalMiddleware] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      // A private project's avatar library isn't anonymously readable (review security-004).
      const proj = await db.query.projects.findFirst({
        where: eq(projects.id, request.params.id),
        columns: { visibility: true, created_by: true },
      }).catch(() => null);
      if (!proj) return reply.code(404).send({ message: 'Project not found' });
      if (!(await avatarProjectAllowedAsync(request.params.id, proj, request.dbUser ?? null))) {
        return reply.code(404).send({ message: 'Project not found' });
      }
      await syncBasicLibrary(request.params.id).catch(() => {});
      const q = request.query as { scope?: string; type?: string; q?: string; page?: string };
      const result = await listVisuals({
        projectId: request.params.id, includeGlobal: false,  // per-project Extended Library (no shared globals)
        scope: q.scope === 'basic' || q.scope === 'extended' ? q.scope : undefined,
        type: q.type, q: q.q, page: q.page ? parseInt(q.page, 10) : 1, limit: 60,
      });
      return reply.send(result);
    },
  );

  // ── Conversation memory ────────────────────────────────────────────────────
  // Access is bound to a server-issued, project-scoped capability token: the GET applies
  // the project visibility gate (optional-auth) and, when allowed, MINTS a token bound to
  // {projectKey, sessionKey}; the POST requires that token to persist turns. Anonymous
  // viewers of public/unlisted projects work as before; a private project's memory is not
  // reachable by anonymous/non-owner callers, and the trusted-only sessionKey is no longer
  // sufficient to write (review security-004/005).
  const MemorySchema = z.object({
    token: z.string().min(1).max(800),
    sessionKey: z.string().min(1).max(200),
    characterId: z.string().max(64).optional(),
    projectId: z.string().uuid().optional(),
    turns: z.array(z.object({ role: z.enum(['user', 'persona']), content: z.string() })).max(40),
  });

  app.get('/api/v1/avatar/memory', { preHandler: [firebaseAuthOptionalMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { sessionKey, projectId } = request.query as { sessionKey?: string; projectId?: string };
    if (!sessionKey) return reply.send({ token: null, turns: [], profile: {} });

    // A BURST SHIELD ON THE MINT ITSELF. This endpoint hands out a twelve-hour bearer that
    // authorizes paid work on the POST below, and until now the `projectId`-less path handed one
    // out with no gate whatsoever — one unauthenticated GET bought twelve hours of writes. The POST
    // is now metered, which bounds the spend; this bounds the rate at which credentials for it are
    // manufactured, so a caller cannot simply collect a fresh token per request and spread the
    // spend across as many meter subjects as it likes. Same shape as the capability mint above.
    if (!rateLimit(`avatar-mem:${hashSubject('ip', request.ip)}`, 60, 60_000)) {
      return reply.code(429).header('Retry-After', '60').send({ token: null, turns: [], profile: {} });
    }

    // Project-scoped visibility gate (no projectId = global avatar, always allowed).
    if (projectId) {
      const proj = await db.query.projects.findFirst({
        where: eq(projects.id, projectId),
        columns: { visibility: true, created_by: true },
      }).catch(() => null);
      if (!proj || !(await avatarProjectAllowedAsync(projectId, proj, request.dbUser ?? null))) {
        return reply.code(403).send({ message: 'Forbidden' });
      }
    }
    const token = signMemoryToken(projectId ?? 'global', sessionKey);
    try {
      const [turns, profile] = await Promise.all([getTurns(sessionKey), getProfile(sessionKey)]);
      return reply.send({ token, turns, profile });
    } catch {
      return reply.send({ token, turns: [], profile: {} });
    }
  });

  app.post('/api/v1/avatar/memory', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = MemorySchema.safeParse(request.body);
    if (!parsed.success) return reply.send({ ok: false });
    const { token, sessionKey, characterId, projectId, turns } = parsed.data;
    // The capability token (minted by the gated GET) authorizes writes to THIS session only.
    const payload = verifyMemoryToken(token);
    if (!payload || payload.s !== sessionKey || payload.p !== (projectId ?? 'global')) {
      return reply.code(403).send({ ok: false });
    }

    // ── THIS IS A BILLABLE ROUTE, and it was the only one on this surface that did not know it ──
    //
    // `extractAndSaveFacts` runs TWO OpenAI completions per accepted call. Until now this endpoint
    // had no capability check, no kill switch, no burst shield and no reservation — while the three
    // routes D-03 was opened for got all four. Found by the adversarial review of D-03 itself,
    // which is the useful kind of finding: the fix was built and the same hole was left open one
    // handler further down the same file.
    //
    // The memory token does not substitute for metering. It proves "you own this session key"; it
    // says nothing about how much money that session may spend, and it is minted for TWELVE HOURS.
    //
    // Reserved AFTER the token check so an unauthorized caller cannot consume anyone's budget by
    // being refused, and BEFORE `saveTurns`, so a refusal writes nothing at all.
    const reserved = await reserveBillable(request, reply, 'memory', {
      leaseId: `mem:${sessionKey}`,
      meterJti: null,
      projectId: projectId ?? null,
      ownerId: null,
      deniedBody: { ok: false },
    });
    if (!reserved.ok) return reply;

    try {
      // Normalized rather than stored verbatim: this is a free-text field on the wire, and the
      // column is the one an operator reads to see which persona a conversation belonged to.
      // Not read back from the project — turn persistence is a per-turn beacon and does not
      // justify a project read; the session key the client derives already pins the character.
      await saveTurns(sessionKey, projectCharacterId(undefined, characterId), projectId ?? null, turns as Turn[]);
      extractAndSaveFacts(sessionKey, turns as Turn[]).catch(() => {});
      return reply.send({ ok: true });
    } catch {
      return reply.send({ ok: false });
    }
  });

  // ── Authenticated library management (editor) ──────────────────────────────

  async function requireOwnedProject(request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const user = request.dbUser!;
    const project = await editableProject(request.params.id, user);
    if (!project) {
      reply.code(404).send({ message: 'Project not found' });
      return null;
    }
    return project;
  }

  /**
   * A visual THIS PROJECT may manage. Scoped strictly to `project_id`; a global row (project_id
   * IS NULL) is never manageable from a project route (security-008).
   *
   * It used to accept `OR project_id IS NULL`, which made every global extended visual writable by
   * ANY project owner in the deployment: PATCH could rewrite its caption and scope, DELETE could
   * remove it, and edit-simulation could rewrite its code — for every other tenant at once. The
   * only thing keeping that from being trivially exploitable was that both LIST endpoints pass
   * `includeGlobal: false`, so the UI never hands out a global id. That is obscurity, not a
   * boundary: the id is a uuid in a URL, and one leaked id was enough.
   *
   * Globals are administered through admin-web's own avatar routes, which is where a cross-tenant
   * write belongs — behind an admin check rather than a project check.
   */
  async function findManageableVisual(projectId: string, visualId: string) {
    const [row] = await db.select().from(avatar_visuals)
      .where(and(eq(avatar_visuals.id, visualId), eq(avatar_visuals.project_id, projectId))).limit(1);
    return row ?? null;
  }

  // GET — basic (this project, auto-synced) + global extended
  app.get<{ Params: { id: string } }>(
    '/api/v1/projects/:id/avatar/library',
    { preHandler: [firebaseAuthMiddleware] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const project = await requireOwnedProject(request, reply);
      if (!project) return;
      await syncBasicLibrary(project.id, true).catch(() => {});
      const q = request.query as { scope?: string; type?: string; q?: string; page?: string };
      const result = await listVisuals({
        projectId: project.id, includeGlobal: false,  // per-project Extended Library (no shared globals)
        scope: q.scope === 'basic' || q.scope === 'extended' ? q.scope : undefined,
        type: q.type, q: q.q, page: q.page ? parseInt(q.page, 10) : 1, limit: 60,
      });
      return reply.send(result);
    },
  );

  // POST generate-image — text → image saved to the GLOBAL extended library
  app.post<{ Params: { id: string } }>(
    '/api/v1/projects/:id/avatar/library/generate-image',
    { preHandler: [firebaseAuthMiddleware] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const project = await requireOwnedProject(request, reply);
      if (!project) return;
      const body = (request.body ?? {}) as { prompt?: string; dallePrompt?: string; caption?: string; characterId?: string };
      if (!body.prompt && !body.dallePrompt) return reply.code(400).send({ message: 'prompt is required' });
      try {
        const res = await generateLibraryImage({
          prompt: body.prompt ?? body.dallePrompt!, dallePrompt: body.dallePrompt,
          // Tag and style the generated visual as the persona this PROJECT is configured with,
          // not as whatever the editor modal's local default happened to be ('einstein').
          characterId: projectCharacterId(asPersonaConfig(project.avatar_config), body.characterId),
          caption: body.caption, createdBy: request.dbUser!.id, projectId: project.id,
        });
        return reply.send({ ok: true, item: res!.row, imageUrl: res!.imageUrl });
      } catch (err) {
        logger.error({ err }, '[Avatar] library image generation failed');
        return reply.code(500).send({ message: 'Image generation failed' });
      }
    },
  );

  // POST generate-simulation — text → sim saved to the GLOBAL extended library
  app.post<{ Params: { id: string } }>(
    '/api/v1/projects/:id/avatar/library/generate-simulation',
    { preHandler: [firebaseAuthMiddleware] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const project = await requireOwnedProject(request, reply);
      if (!project) return;
      const body = (request.body ?? {}) as { prompt?: string; caption?: string; characterId?: string };
      if (!body.prompt) return reply.code(400).send({ message: 'prompt is required' });
      try {
        const res = await generateLibrarySimulation({
          prompt: body.prompt, caption: body.caption,
          characterId: projectCharacterId(asPersonaConfig(project.avatar_config), body.characterId),
          createdBy: request.dbUser!.id, projectId: project.id,
        });
        return reply.send({ ok: true, item: res!.row, simulationUrl: res!.simulationUrl });
      } catch (err) {
        logger.error({ err }, '[Avatar] library simulation generation failed');
        return reply.code(500).send({ message: 'Simulation generation failed' });
      }
    },
  );

  // POST upload — drag/drop files into the editor Library and classify by renderable type.
  app.post<{ Params: { id: string } }>(
    '/api/v1/projects/:id/avatar/library/upload',
    {
      preHandler: [firebaseAuthMiddleware],
    },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const project = await requireOwnedProject(request, reply);
      if (!project) return;
      const projectId = project.id;

      const accepted: AvatarLibraryUploadAccepted[] = [];
      const rejected: AvatarLibraryUploadRejected[] = [];
      const projectCfg = asPersonaConfig(project.avatar_config);
      // Seeded from the project's configured persona rather than DEFAULT_CHARACTER_ID; a
      // `characterId` field in the multipart body may still refine it only when the project
      // itself names none (see projectCharacterId).
      let characterId = projectCharacterId(projectCfg);
      let scope: 'basic' | 'extended' = 'extended';
      let totalBytes = 0;

      async function addVisual(
        filename: string,
        visualType: AvatarLibraryUploadAccepted['visualType'],
        fields: {
          caption: string;
          lookupKey?: string;
          altText?: string | null;
          imageUrl?: string | null;
          imageKey?: string | null;
          visualSpec?: Record<string, unknown> | null;
          simStoragePrefix?: string | null;
          simEntryUrl?: string | null;
        },
      ): Promise<void> {
        const row = await insertVisual({
          projectId,
          scope,
          source: 'uploaded',
          characterId,
          visualType,
          lookupKey: fields.lookupKey ?? fields.caption,
          caption: fields.caption,
          altText: fields.altText ?? fields.caption,
          imageUrl: fields.imageUrl,
          imageKey: fields.imageKey,
          visualSpec: fields.visualSpec,
          simStoragePrefix: fields.simStoragePrefix,
          simEntryUrl: fields.simEntryUrl,
          createdBy: request.dbUser!.id,
        });
        if (!row) throw new Error('Could not save library item');
        accepted.push({ filename, visualType, id: row.id });
      }

      async function processFile(filename: string, mimetype: string, buffer: Buffer): Promise<void> {
        const ext = extOf(filename);
        const caption = cleanCaption(filename);
        const isImage = mimetype.startsWith('image/') || ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].includes(ext);
        const isHtml = mimetype.includes('html') || ext === 'html' || ext === 'htm';
        const isZip = mimetype.includes('zip') || ext === 'zip';

        if (isImage) {
          const contentType = mimetype || (ext === 'svg' ? 'image/svg+xml' : 'application/octet-stream');
          const stored = await storeImageBuffer(buffer, contentType, projectId, ext || 'img');
          await addVisual(filename, 'image', {
            caption,
            imageUrl: stored.url,
            imageKey: stored.key,
            visualSpec: { type: 'image', imageType: ext === 'svg' ? 'diagram' : 'realistic', source: 'upload' },
          });
          return;
        }

        if (isHtml) {
          const html = buffer.toString('utf-8');
          const stored = await storeSimulationHtml(html, projectId);
          await addVisual(filename, 'simulation', {
            caption,
            simStoragePrefix: stored.prefix,
            simEntryUrl: stored.url,
            visualSpec: { type: 'simulation', caption, source: 'html-upload' },
          });
          return;
        }

        if (isZip) {
          if (!zipHasHtml(buffer)) throw new Error('Simulation ZIP needs an HTML entry file.');
          const simId = randomUUID();
          const svc = new SimulationService(getStorageAdapter(), _avatarLibraryLlmService);
          const processed = await svc.processUpload({ projectId, simId, zipBuffer: buffer });
          await addVisual(filename, 'simulation', {
            caption,
            simStoragePrefix: `simulations/${projectId}/${simId}`,
            simEntryUrl: processed.entryUrl,
            visualSpec: { type: 'simulation', caption, source: 'zip-upload', entryKey: processed.entryKey },
          });
          return;
        }

        if (ext === 'csv') {
          const spec = csvToChartSpec(buffer.toString('utf-8'), filename);
          if (!spec) throw new Error('CSV needs a label column and a numeric value column.');
          await addVisual(filename, 'chart', { caption, visualSpec: spec });
          return;
        }

        if (ext === 'tex' || ext === 'latex') {
          const latex = buffer.toString('utf-8').trim();
          if (!latex) throw new Error('LaTeX file is empty.');
          await addVisual(filename, 'equation', {
            caption,
            visualSpec: { type: 'equation', latex, caption },
          });
          return;
        }

        if (ext === 'json') {
          const spec = normalizeUploadedVisualSpec(JSON.parse(buffer.toString('utf-8')), filename);
          if (!spec) throw new Error('JSON must describe an equation, chart, diagram, or simulation visual.');
          if (spec.type === 'simulation' && typeof spec.spec.html === 'string') {
            const stored = await storeSimulationHtml(spec.spec.html, projectId);
            await addVisual(filename, 'simulation', {
              caption: spec.caption,
              simStoragePrefix: stored.prefix,
              simEntryUrl: stored.url,
              visualSpec: { type: 'simulation', caption: spec.caption, source: 'json-upload' },
            });
          } else {
            await addVisual(filename, spec.type, { caption: spec.caption, visualSpec: spec.spec });
          }
          return;
        }

        throw new Error('Not a supported visual Library file.');
      }

      const parts = request.parts({
        limits: {
          fileSize: AVATAR_LIBRARY_UPLOAD_MAX_BYTES,
          files:    AVATAR_LIBRARY_UPLOAD_MAX_FILES,
          fields:   20,
        },
      });

      for await (const part of parts) {
        if (part.type === 'field') {
          if (part.fieldname === 'characterId' && typeof part.value === 'string') characterId = projectCharacterId(projectCfg, part.value);
          if (part.fieldname === 'scope' && (part.value === 'basic' || part.value === 'extended')) scope = part.value;
          continue;
        }
        const filename = part.filename || `upload-${accepted.length + rejected.length + 1}`;
        const chunks: Buffer[] = [];
        for await (const chunk of part.file) {
          const buf = chunk as Buffer;
          totalBytes += buf.length;
          if (totalBytes > AVATAR_LIBRARY_UPLOAD_MAX_BYTES) {
            return reply.code(413).send({ message: 'Library upload exceeds 250 MB' });
          }
          chunks.push(buf);
        }
        const buffer = Buffer.concat(chunks);
        if (buffer.length === 0) {
          rejected.push({ filename, reason: 'File is empty.' });
          continue;
        }
        try {
          await processFile(filename, part.mimetype || '', buffer);
        } catch (err) {
          rejected.push({ filename, reason: (err as Error).message });
        }
      }

      if (accepted.length === 0 && rejected.length === 0) {
        return reply.code(400).send({ message: 'No files received' });
      }
      return reply.send({ ok: true, accepted, rejected });
    },
  );

  // POST :visualId/edit-simulation — AI-refine a single-file simulation in place
  app.post<{ Params: { id: string; visualId: string } }>(
    '/api/v1/projects/:id/avatar/library/:visualId/edit-simulation',
    { preHandler: [firebaseAuthMiddleware] },
    async (request: FastifyRequest<{ Params: { id: string; visualId: string } }>, reply: FastifyReply) => {
      const project = await requireOwnedProject(request, reply);
      if (!project) return;
      if (!(await findManageableVisual(project.id, request.params.visualId))) return reply.code(404).send({ message: 'Visual not found' });
      const body = (request.body ?? {}) as { instructions?: string };
      if (!body.instructions) return reply.code(400).send({ message: 'instructions are required' });
      try {
        const res = await editLibrarySimulation(request.params.visualId, body.instructions);
        return reply.send({ ok: true, simulationUrl: res.simulationUrl });
      } catch (err) {
        logger.warn({ err }, '[Avatar] library simulation edit failed');
        return reply.code(400).send({ message: 'Could not edit the simulation' });
      }
    },
  );

  // PATCH — update caption / alt text / scope
  app.patch<{ Params: { id: string; visualId: string } }>(
    '/api/v1/projects/:id/avatar/library/:visualId',
    { preHandler: [firebaseAuthMiddleware] },
    async (request: FastifyRequest<{ Params: { id: string; visualId: string } }>, reply: FastifyReply) => {
      const project = await requireOwnedProject(request, reply);
      if (!project) return;
      if (!(await findManageableVisual(project.id, request.params.visualId))) return reply.code(404).send({ message: 'Visual not found' });
      const body = (request.body ?? {}) as { caption?: string; altText?: string; scope?: 'basic' | 'extended' };
      const ok = await updateVisual(request.params.visualId, body);
      return reply.send({ ok });
    },
  );

  // DELETE — remove a library visual (editor-sourced "basic" rows keep their media)
  app.delete<{ Params: { id: string; visualId: string } }>(
    '/api/v1/projects/:id/avatar/library/:visualId',
    { preHandler: [firebaseAuthMiddleware] },
    async (request: FastifyRequest<{ Params: { id: string; visualId: string } }>, reply: FastifyReply) => {
      const project = await requireOwnedProject(request, reply);
      if (!project) return;
      if (!(await findManageableVisual(project.id, request.params.visualId))) return reply.code(404).send({ message: 'Visual not found' });
      const ok = await deleteVisual(request.params.visualId);
      return reply.code(ok ? 204 : 404).send();
    },
  );

  // ── Per-video avatar persona config (editor) ───────────────────────────────

  // GET — the video's saved avatar persona config (defaults to {})
  app.get<{ Params: { id: string } }>(
    '/api/v1/projects/:id/avatar/config',
    { preHandler: [firebaseAuthMiddleware] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const project = await requireOwnedProject(request, reply);
      if (!project) return;
      const row = await db.query.projects.findFirst({ where: eq(projects.id, project.id), columns: { avatar_config: true } });
      return reply.send({ config: (row?.avatar_config as AvatarPersonaConfig | null) ?? {} });
    },
  );

  // PUT — save the video's avatar persona config (stored per-video on the server)
  const AvatarConfigSchema = z.object({
    characterId: z.string().max(40).optional(),
    name: z.string().max(120).optional(),
    avatarName: z.string().max(120).optional(),
    avatarVariantName: z.string().max(120).optional(),
    avatarImageUrl: z.string().max(2048).optional(),
    systemPrompt: z.string().max(20000).optional(),
    knowledge: z.string().max(40000).optional(),
    greeting: z.string().max(2000).optional(),
    languageCode: z.string().max(12).optional(),
    avatarId: z.string().max(80).optional(),
    avatarModel: z.string().max(40).optional(),
    voiceId: z.string().max(80).optional(),
    voiceName: z.string().max(120).optional(),
    llmId: z.string().max(80).optional(),
    maxSessionLengthSeconds: z.number().int().min(60).max(3600).optional(),
    skipGreeting: z.boolean().optional(),
    uninterruptibleGreeting: z.boolean().optional(),
    voiceSensitivity: z.number().min(0).max(1).optional(),
    toolIds: z.array(z.string().max(80)).max(20).optional(),
    avatarCircles: z.object({
      enabled: z.boolean(),
      // 'manual' / 'broll+manual' show the circles inside user-marked timeline
      // ranges (manualSections) — alone or merged with the b-roll windows.
      visibility: z.enum(['broll', 'always', 'none', 'manual', 'broll+manual']).optional(),
      manualSections: z.array(z.object({
        id: z.string().max(64),
        start_sec: z.number().min(0).max(360000),
        end_sec: z.number().min(0).max(360000),
      }).refine((s) => s.end_sec > s.start_sec, { message: 'end_sec must be greater than start_sec' })).max(200).optional(),
      count: z.union([z.literal(1), z.literal(2)]),
      faces: z.array(z.object({
        speaker: z.enum(['host_a', 'host_b']),
        side: z.enum(['left', 'right']),
        imageUrl: z.string().max(2048).optional(),
        label: z.string().max(120).optional(),
        // Voice band of this circle's character — drives the FFT/pitch speaker
        // fallback in the viewer when the project has no scenes timeline.
        voice: z.enum(['male', 'female']).optional(),
      })).max(2).optional(),
      barStyle: z.enum(['bars', 'solid', 'gradient']).optional(),
      numberOfBars: z.number().min(8).max(512).optional(),
      sensitivity: z.number().min(0).max(1).optional(),
      barWidth: z.number().min(1).max(64).optional(),
      innerRadius: z.number().min(0).max(600).optional(),
      smoothness: z.number().min(0).max(1).optional(),
      minHeight: z.number().min(0).max(600).optional(),
      maxHeight: z.number().min(1).max(1200).optional(),
      rotationOffset: z.number().min(0).max(360).optional(),
      lowFreqCutPct: z.number().min(0).max(100).optional(),
      highFreqCutPct: z.number().min(0).max(100).optional(),
      colorMode: z.enum(['solid', 'gradient']).optional(),
      barColor: z.string().max(32).optional(),
      gradientEnd: z.string().max(32).optional(),
      background: z.string().max(32).optional(),
      roundedBars: z.boolean().optional(),
      circleSize: z.number().min(16).max(800).optional(),
      circleOpacity: z.number().min(0).max(1).optional(),
      circleLayout: z.enum(['corners', 'right-stack']).optional(),
      circleSideInsetPct: z.number().min(0).max(45).optional(),
      circleBottomPct: z.number().min(0).max(70).optional(),
      circleGapPct: z.number().min(0).max(20).optional(),
      showCenterCircle: z.boolean().optional(),
    }).optional(),
  });

  app.put<{ Params: { id: string } }>(
    '/api/v1/projects/:id/avatar/config',
    { preHandler: [firebaseAuthMiddleware] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const project = await requireOwnedProject(request, reply);
      if (!project) return;
      const parsed = AvatarConfigSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ message: parsed.error.message });
      // Same durable state, same guard as PUT /avatar/circles — this route can write
      // avatarCircles too, so a face URL that is not publicly reachable is refused here as well.
      const configCircleUrlError = circleFaceUrlPersistError(parsed.data.avatarCircles, isProd());
      if (configCircleUrlError) return reply.code(400).send({ message: configCircleUrlError });
      const incoming = parsed.data as AvatarPersonaConfig;
      const existing = (project.avatar_config as AvatarPersonaConfig | null) ?? {};
      // STORE A CHARACTER ONLY WHEN SOMEONE ACTUALLY PICKED ONE.
      //
      // This used to run the value through `projectCharacterId`, which returns the DEFAULT when
      // it is handed nothing. So saving the settings form at all — changing only the greeting,
      // never touching the character picker — wrote `characterId: 'einstein'` into the project's
      // config. From that moment the project was indistinguishable from one whose owner had
      // deliberately chosen Einstein, and the viewer was shown "Ask Albert Einstein" on the
      // strength of a choice nobody made. It is the same fabrication the start path had, one
      // layer earlier and far more durable, because it persists.
      //
      // The invariant that normalization protected is kept: the config and the persona
      // fingerprint must never disagree. They cannot, because there is still exactly one stored
      // value and exactly one normalizer — `bakedCharacterId()`, which already maps an absent or
      // unrecognized id to the default on READ. An unrecognized id is dropped rather than
      // rewritten, so the config never claims a character the owner did not send.
      const requestedCharacter = (incoming.characterId ?? existing.characterId)?.trim();
      const characterId = requestedCharacter && CHARACTERS[requestedCharacter] ? requestedCharacter : undefined;
      const apiKey = await resolveAnamKeyForProject(project.id).catch(() => undefined);
      const avatarChanged = Boolean(incoming.avatarId && incoming.avatarId !== existing.avatarId);
      const staleExistingVoice = Boolean(avatarChanged && existing.voiceId && incoming.voiceId === existing.voiceId);

      // Server/feature-managed fields carry over from the saved config (the PUT
      // rebuilds avatar_config from the form, so anything not in the form must be
      // preserved explicitly); user fields come from `incoming`.
      // Normalize circles on save so a degenerate faces mapping (both circles → the same
      // speaker/side) can never be stored — that mis-mapping is what breaks "his wave / her
      // wave". Mirrors the read-path self-heal in buildPlayerConfig. (avatar-circles-fix)
      const savedCircles = incoming.avatarCircles ?? existing.avatarCircles;
      // The persona is baked WITH the caption transcript (exactly as an inline session would carry
      // it), and the transcript revision is recorded, so a start can tell whether the saved persona
      // still knows the current video without reading captions itself.
      const transcript = await getProjectTranscript(project.id).catch(() => null);
      const effectiveBase: AvatarPersonaConfig = {
        ...incoming,
        knowledgeGroupId: existing.knowledgeGroupId,
        knowledgeToolId: existing.knowledgeToolId,
        transcriptDocId: existing.transcriptDocId,
        transcriptHash: hashTranscript(transcript),
        personaDisplay: existing.personaDisplay,
        // Record the character this persona is baked as, so a later start derives the same
        // fingerprint from the stored config alone.
        characterId,
        avatarCircles: savedCircles
          ? (normalizeAvatarCircles(savedCircles as unknown as AvatarCirclesLike) as unknown as AvatarPersonaConfig['avatarCircles'])
          : savedCircles,
      };
      const effective = await enrichAvatarConfigFromAnam(effectiveBase, apiKey, {
        forceDefaultVoice: staleExistingVoice || !effectiveBase.voiceId,
      }).catch(() => effectiveBase);

      // Save the settings AS a real Anam persona (created/updated in the account)
      // and store its id for this video, so the session loads it exactly.
      let personaId: string | undefined;
      let personaError: string | undefined;
      let personaBaked: AvatarPersonaConfig['personaBaked'];
      try {
        // `bakedCharacterId` — the ONE normalizer — rather than the stored value, which is now
        // legitimately absent when nobody chose a character. The persona must still be baked as
        // something concrete, and this is the same function every later read uses to decide what
        // that something is, so the config and the fingerprint cannot drift apart.
        personaId = await upsertVideoPersona(bakedCharacterId(effective), withTranscriptKnowledge(effective, transcript), apiKey, existing.personaId);
        // Recorded ONLY after the vendor accepted the upsert: this record is what later starts
        // trust when they skip the inline persona body.
        personaBaked = bakedStateFor(effective, existing.personaBaked?.revision ?? 0);
      } catch (e) {
        personaError = (e as Error).message; // non-fatal: still save config, session falls back
        personaId = undefined;
        personaBaked = undefined;
      }

      const toSave: AvatarPersonaConfig = { ...effective, ...(personaId && personaBaked ? { personaId, personaBaked } : {}) };
      await db.update(projects).set({ avatar_config: toSave, updated_at: new Date() }).where(eq(projects.id, project.id));
      return reply.send({ ok: true, config: toSave, personaId, personaError });
    },
  );

  // GET — list the Anam avatars / voices / llms / personas available to this
  // video's key (the owner's BYOK key when enabled, else the shared key).
  app.get<{ Params: { id: string } }>(
    '/api/v1/projects/:id/avatar/anam-resources',
    { preHandler: [firebaseAuthMiddleware] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const project = await requireOwnedProject(request, reply);
      if (!project) return;
      const kindRaw = (request.query as { kind?: string }).kind;
      const kind = (['avatars', 'voices', 'llms', 'personas'] as const).find((k) => k === kindRaw);
      if (!kind) return reply.code(400).send({ message: 'kind must be avatars|voices|llms|personas' });
      const apiKey = await resolveAnamKeyForProject(project.id).catch(() => undefined);
      const result = await listAnamResource(kind, apiKey).catch(() => ({ data: [] }));
      return reply.send(result);
    },
  );

  // GET — selectable Anam SYSTEM tools (end_call, change_language, skip_turn)
  app.get<{ Params: { id: string } }>(
    '/api/v1/projects/:id/avatar/tools',
    { preHandler: [firebaseAuthMiddleware] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const project = await requireOwnedProject(request, reply);
      if (!project) return;
      const apiKey = await resolveAnamKeyForProject(project.id).catch(() => undefined);
      const tools = await listSystemTools(apiKey).catch(() => []);
      return reply.send({ tools });
    },
  );

  // ── Knowledge base (RAG) documents ─────────────────────────────────────────

  // POST — upload a document; lazily creates the group + RAG tool for this video.
  app.post<{ Params: { id: string } }>(
    '/api/v1/projects/:id/avatar/knowledge/documents',
    { preHandler: [firebaseAuthMiddleware] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const project = await requireOwnedProject(request, reply);
      if (!project) return;
      // DECLARED SIZE FIRST (security-007): free, exact enough, and available before a byte of body
      // is read — so we never begin buffering something already decided against. It is not the real
      // guard (Content-Length can be absent or a lie); `readStreamBounded` below is.
      const declared = declaredTooLarge(request.headers['content-length'], UPLOAD_MAX_BYTES.knowledgeDoc);
      if (declared !== null) {
        return reply.code(413).send({ message: tooLargeMessage('This document', declared, UPLOAD_MAX_BYTES.knowledgeDoc) });
      }

      const data = await request.file();
      if (!data) return reply.code(400).send({ message: 'No file uploaded' });
      const ext = (data.filename?.split('.').pop() ?? '').toLowerCase();
      if (!['pdf', 'txt', 'md', 'docx', 'csv'].includes(ext)) {
        return reply.code(400).send({ message: 'Supported: PDF, TXT, MD, DOCX, CSV' });
      }
      const buf = await readStreamBounded(data.file, UPLOAD_MAX_BYTES.knowledgeDoc, 'This document');
      const apiKey = await resolveAnamKeyForProject(project.id).catch(() => undefined);
      const existing = (project.avatar_config as AvatarPersonaConfig | null) ?? {};
      try {
        const groupId = await ensureKnowledgeGroup(`${project.title ?? 'Video'} knowledge`, apiKey, existing.knowledgeGroupId);
        await uploadKnowledgeDocument(groupId, buf, data.filename ?? 'document', data.mimetype, apiKey);
        const toolId = await ensureKnowledgeTool(groupId, project.title ?? project.id.slice(0, 8), apiKey, existing.knowledgeToolId);
        const merged: AvatarPersonaConfig = { ...existing, knowledgeGroupId: groupId, knowledgeToolId: toolId };
        await db.update(projects).set({ avatar_config: merged, updated_at: new Date() }).where(eq(projects.id, project.id));
        return reply.send({ ok: true, knowledgeGroupId: groupId, knowledgeToolId: toolId });
      } catch (e) {
        return reply.code(502).send({ message: (e as Error).message });
      }
    },
  );

  // GET — list documents in this video's knowledge group
  app.get<{ Params: { id: string } }>(
    '/api/v1/projects/:id/avatar/knowledge/documents',
    { preHandler: [firebaseAuthMiddleware] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const project = await requireOwnedProject(request, reply);
      if (!project) return;
      const cfg = (project.avatar_config as AvatarPersonaConfig | null) ?? {};
      if (!cfg.knowledgeGroupId) return reply.send({ data: [] });
      const apiKey = await resolveAnamKeyForProject(project.id).catch(() => undefined);
      const docs = await listKnowledgeDocuments(cfg.knowledgeGroupId, apiKey).catch(() => ({ data: [] }));
      return reply.send(docs);
    },
  );

  /**
   * Is this document actually in THIS project's knowledge group? (security-009)
   *
   * The vendor's document ids are global to the Anam ACCOUNT, and by default every tenant in this
   * deployment shares one platform key — `resolveAnamKeyForProject` returns undefined unless BYOK
   * is on AND the owner stored their own key. So a document id is not a capability: proving you own
   * SOME project proves nothing about the document you named.
   *
   * The listing above already scopes by `knowledgeGroupId`; this makes the destructive path ask
   * the same question. Membership is checked against the group's own listing rather than a local
   * table because the vendor is the only system that knows it.
   */
  async function documentBelongsToProject(
    groupId: string | undefined,
    docId: string,
    apiKey: string | undefined,
  ): Promise<boolean> {
    if (!groupId) return false;
    const docs = await listKnowledgeDocuments(groupId, apiKey).catch(() => ({ data: [] }));
    return docs.data.some((d) => {
      const id = (d as { id?: unknown; documentId?: unknown } | null)?.id
        ?? (d as { documentId?: unknown } | null)?.documentId;
      return typeof id === 'string' && id === docId;
    });
  }

  // DELETE — remove a document from the knowledge group
  app.delete<{ Params: { id: string; docId: string } }>(
    '/api/v1/projects/:id/avatar/knowledge/documents/:docId',
    { preHandler: [firebaseAuthMiddleware] },
    async (request: FastifyRequest<{ Params: { id: string; docId: string } }>, reply: FastifyReply) => {
      const project = await requireOwnedProject(request, reply);
      if (!project) return;
      const apiKey = await resolveAnamKeyForProject(project.id).catch(() => undefined);
      const cfg = (project.avatar_config as AvatarPersonaConfig | null) ?? {};

      // 404, not 403 — the same rule every project route here keeps: refusing must not confirm
      // that somebody else's document id exists.
      if (!(await documentBelongsToProject(cfg.knowledgeGroupId, request.params.docId, apiKey))) {
        logger.warn(
          { projectId: project.id, docId: request.params.docId },
          '[Avatar] refused a knowledge-document delete for a document outside this project group',
        );
        return reply.code(404).send({ message: 'Document not found' });
      }

      const ok = await deleteKnowledgeDocument(request.params.docId, apiKey).catch(() => false);
      return reply.code(ok ? 204 : 502).send();
    },
  );

  // ── Avatar circles (audio-reactive overlays shown during b-roll) ───────────

  const AvatarCirclesSchema = AvatarConfigSchema.shape.avatarCircles.unwrap();

  // GET — this video's avatar-circles config (defaults to null/disabled).
  app.get<{ Params: { id: string } }>(
    '/api/v1/projects/:id/avatar/circles',
    { preHandler: [firebaseAuthMiddleware] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const project = await requireOwnedProject(request, reply);
      if (!project) return;
      const cfg = asPersonaConfig(project.avatar_config);
      return reply.send({ config: cfg.avatarCircles ?? null });
    },
  );

  // PUT — save the avatar-circles config (merged into avatar_config, decoupled
  // from the Anam persona save).
  app.put<{ Params: { id: string } }>(
    '/api/v1/projects/:id/avatar/circles',
    { preHandler: [firebaseAuthMiddleware] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const project = await requireOwnedProject(request, reply);
      if (!project) return;
      const parsed = AvatarCirclesSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ message: parsed.error.message });
      // A face image URL is stored ABSOLUTE and never re-derived on read, so a non-public host
      // written here is served to every viewer of this project forever — and it lives inside a
      // JSON document, where the URL-column backfill and the release audit could not see it.
      // Refuse it at the door instead of repairing it afterwards. Prod-gated: in local dev
      // http://localhost:8080/local-storage/... IS the correct value for this field.
      const circleUrlError = circleFaceUrlPersistError(parsed.data, isProd());
      if (circleUrlError) return reply.code(400).send({ message: circleUrlError });
      const existing = asPersonaConfig(project.avatar_config);
      const merged: AvatarPersonaConfig = { ...existing, avatarCircles: parsed.data };
      await db.update(projects).set({ avatar_config: merged, updated_at: new Date() }).where(eq(projects.id, project.id));
      return reply.send({ ok: true, config: parsed.data });
    },
  );

  // POST — upload an avatar face image for a circle; returns its public URL.
  app.post<{ Params: { id: string } }>(
    '/api/v1/projects/:id/avatar/circle-face',
    { preHandler: [firebaseAuthMiddleware] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const project = await requireOwnedProject(request, reply);
      if (!project) return;
      // DECLARED SIZE FIRST (security-007): free, exact enough, and available before a byte of body
      // is read — so we never begin buffering something already decided against. It is not the real
      // guard (Content-Length can be absent or a lie); `readStreamBounded` below is.
      const declared = declaredTooLarge(request.headers['content-length'], UPLOAD_MAX_BYTES.avatarFace);
      if (declared !== null) {
        return reply.code(413).send({ message: tooLargeMessage('This image', declared, UPLOAD_MAX_BYTES.avatarFace) });
      }

      const data = await request.file();
      if (!data) return reply.code(400).send({ message: 'No file uploaded' });
      const mime = data.mimetype.toLowerCase().split(';')[0].trim();
      if (!['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(mime)) {
        return reply.code(400).send({ message: 'Only JPEG, PNG, and WebP images are supported' });
      }
      // Same 8 MB as before, enforced before the heap pays for it (security-007).
      const buf = await readStreamBounded(data.file, UPLOAD_MAX_BYTES.avatarFace, 'This image');
      const ext = mime === 'image/png' ? '.png' : mime === 'image/webp' ? '.webp' : '.jpg';
      const key = `avatar-circles/${project.id}/${randomUUID()}${ext}`;
      const url = await uploadWithFallback(key, buf, mime);
      return reply.code(201).send({ url });
    },
  );

  // ── BYOK: the signed-in user's own Anam API key ────────────────────────────

  // Tells the UI whether the BYOK key field should be shown + whether one is set.
  app.get('/api/v1/avatar/byok-status', { preHandler: [firebaseAuthMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const [settings] = await db.select({ byok: admin_settings.avatar_byok_enabled }).from(admin_settings).limit(1);
    const user = request.dbUser!;
    return reply.send({ byokEnabled: Boolean(settings?.byok), hasKey: Boolean(user.anam_api_key_encrypted) });
  });

  // Save / clear the user's own Anam API key (encrypted at rest). Never returned.
  app.put('/api/v1/avatar/my-key', { preHandler: [firebaseAuthMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as { apiKey?: string };
    const key = (body.apiKey ?? '').trim();
    const user = request.dbUser!;
    await db.update(users).set({ anam_api_key_encrypted: key ? encryptKey(key) : null }).where(eq(users.id, user.id));
    return reply.send({ ok: true, hasKey: Boolean(key) });
  });
}
