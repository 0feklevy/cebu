// Phase-level timing for POST /api/v1/avatar/start — ONE structured line per start.
//
// Why this file exists: the night audit could not tell WHERE a slow start spent its time
// (authorization? the transcript read? the mint? the cosmetic name/portrait lookups after the
// mint?), because the endpoint logged nothing but failures. Everything downstream of that audit
// is graded on being able to see the phases, so the recorder is the first thing in the chain.
//
// REDACTION BY CONSTRUCTION. This path holds an Anam API key, a minted session token, the video
// transcript, the system prompt, and — on the ephemeral path — a ~30 KB inline persona body. None
// of that may ever be logged, and "remember not to log it" is not a mechanism. So the recorder
// exposes NO way to attach free-form text:
//
//   • durations are measured inside this module from a monotonic clock (numbers only);
//   • `path`, `outcome` and `flag` take values from closed unions and unknown values are dropped;
//   • the two caller-supplied strings (projectId, characterId) are shape-validated — a uuid and a
//     short slug respectively — and anything else becomes the literal 'invalid';
//   • the payload is assembled from a fixed key allowlist (START_LOG_FIELDS), so a caller cannot
//     introduce a new field at all.
//
// A secret can therefore only be logged by editing this file, which is a reviewable act.
import { randomUUID } from 'crypto';
import { logger } from '../../lib/logger.js';

/** Phases of a start, in the order they can occur. `mint` is the vendor round-trip itself. */
export type StartPhase =
  | 'project_read'      // the single projects row (avatar_config + visibility + owner)
  | 'authorize'         // visibility / collaborator gate
  | 'key_read'          // BYOK key resolution
  | 'transcript_read'   // captions → inline knowledge (fallback path only)
  | 'persona_enrich'    // Anam avatar/voice account listings (fallback path only)
  | 'mint'              // obtaining the token: POST /v1/auth/session-token, or the wait on a
                        // concurrent start of the same popup open (then flagged idempotent_replay)
  | 'display';          // resolving the popup's name/portrait

export type StartOutcome = 'ok' | 'not_found' | 'error';

/** Which persona shape the mint used — the whole point of the fingerprint work. */
export type StartPathKind = 'stateful' | 'ephemeral' | 'global' | 'unknown';

/** Closed set of boolean observations. Add a member here (not at a call site) to record a new one. */
export type StartFlag =
  | 'fingerprint_absent'   // project never recorded a baked persona (old row) → one ephemeral start
  | 'fingerprint_miss'     // recorded, but the persona no longer matches the config → re-bake
  | 'self_heal_queued'     // a background re-bake was scheduled after the response
  | 'idempotent_replay'    // returned the token of an in-flight start with the same client key
  | 'transcript_inlined'   // the caption transcript rode inline in the persona body
  | 'display_cached'       // name/portrait came from persisted metadata or the bounded cache
  | 'display_deferred';    // name/portrait resolution moved off the response path

const PHASES: ReadonlySet<string> = new Set<StartPhase>([
  'project_read', 'authorize', 'key_read', 'transcript_read', 'persona_enrich', 'mint', 'display',
]);
const OUTCOMES: ReadonlySet<string> = new Set<StartOutcome>(['ok', 'not_found', 'error']);
const PATHS: ReadonlySet<string> = new Set<StartPathKind>(['stateful', 'ephemeral', 'global', 'unknown']);
const FLAGS: ReadonlySet<string> = new Set<StartFlag>([
  'fingerprint_absent', 'fingerprint_miss', 'self_heal_queued', 'idempotent_replay',
  'transcript_inlined', 'display_cached', 'display_deferred',
]);

/** The complete set of keys this module may ever emit. Pinned by startTelemetry.test.ts. */
export const START_LOG_FIELDS = [
  'evt', 'cid', 'projectId', 'characterId', 'authenticated', 'path', 'outcome', 'status', 'totalMs', 'phasesMs', 'flags',
] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** A project id, or the literal 'invalid'. Never the caller's string. */
function safeUuid(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  return typeof v === 'string' && UUID_RE.test(v) ? v : 'invalid';
}

/** A short identifier slug (character ids are 'einstein', 'darwin', …), or 'invalid'. */
function safeSlug(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  return typeof v === 'string' && SLUG_RE.test(v) ? v : 'invalid';
}

function safeMs(startedAt: number): number {
  const d = Math.round(performance.now() - startedAt);
  return Number.isFinite(d) && d >= 0 ? d : 0;
}

export interface StartTrace {
  /** Correlation id for this start; also returned to the client so a report can be traced. */
  readonly correlationId: string;
  /** Start a phase; call the returned function when it ends. Safe to call the stop twice. */
  mark(phase: StartPhase): () => void;
  /** Time an awaited phase. Records the duration even when the work throws, then rethrows. */
  time<T>(phase: StartPhase, fn: () => Promise<T>): Promise<T>;
  path(kind: StartPathKind): void;
  flag(flag: StartFlag): void;
  /** Emit the line. Only the FIRST call emits, so a handler that both replies and throws logs once. */
  finish(result: { outcome: StartOutcome; status: number }): void;
}

export function beginStartTrace(input: {
  projectId?: unknown;
  characterId?: unknown;
  authenticated?: unknown;
} = {}): StartTrace {
  const correlationId = randomUUID();
  const t0 = performance.now();
  const projectId = safeUuid(input.projectId);
  const characterId = safeSlug(input.characterId);
  const authenticated = Boolean(input.authenticated);
  const phasesMs: Record<string, number> = {};
  const flags: string[] = [];
  let pathKind: StartPathKind = 'unknown';
  let done = false;

  return {
    correlationId,
    mark(phase) {
      if (!PHASES.has(phase)) return () => {};
      const started = performance.now();
      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        phasesMs[phase] = (phasesMs[phase] ?? 0) + safeMs(started);
      };
    },
    async time(phase, fn) {
      const stop = this.mark(phase);
      try {
        return await fn();
      } finally {
        stop();
      }
    },
    path(kind) {
      if (PATHS.has(kind)) pathKind = kind;
    },
    flag(flag) {
      if (FLAGS.has(flag) && !flags.includes(flag)) flags.push(flag);
    },
    finish({ outcome, status }) {
      if (done) return;
      done = true;
      const safeOutcome: StartOutcome = OUTCOMES.has(outcome) ? outcome : 'error';
      const safeStatus = Number.isFinite(status) ? Math.trunc(status as number) : 0;
      // Assembled key-by-key from the allowlist: no spread of caller data, ever.
      const payload = {
        evt: 'avatar_start',
        cid: correlationId,
        projectId,
        characterId,
        authenticated,
        path: pathKind,
        outcome: safeOutcome,
        status: safeStatus,
        totalMs: safeMs(t0),
        phasesMs,
        flags,
      };
      if (safeOutcome === 'ok') logger.info(payload, '[Avatar] start');
      else logger.warn(payload, '[Avatar] start');
    },
  };
}
