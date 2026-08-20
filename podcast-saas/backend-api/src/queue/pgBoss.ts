import type { PgBoss as PgBossType, QueueOptions, QueuePolicy } from 'pg-boss';
import type { JobName } from './types.js';
import { PGBOSS_STOP_TIMEOUT_MS } from './shutdownBudget.js';
import { logger } from '../lib/logger.js';

/**
 * pg-boss lifecycle (Phase B). Lazily constructed so the durable driver — and the `pg-boss`
 * module itself — is never loaded on the default `inline` path or in tests (pglite). Only
 * touched when QUEUE_DRIVER=pgboss and something actually enqueues/works a durable job.
 *
 * Connection: prefers QUEUE_DATABASE_URL (point this at a DIRECT/session-mode Postgres
 * endpoint), falling back to DATABASE_URL. LISTEN/NOTIFY is opt-in (QUEUE_PGBOSS_LISTEN=1)
 * and requires a session-pinned connection; polling is always the correctness floor and works
 * through transaction poolers, so it is the default.
 */

/**
 * Job names routed through pg-boss. Phase B: crop; Phase C: video_generate; Phase D:
 * project_export — the ffmpeg assembly (and, when configured, the capture containers) must run in
 * the WORKER service, not the web tier: the 2026-08-13 incident was the kernel OOM-killing the API
 * container mid-assembly, taking every in-flight request down with it.
 *
 * Phase E (job-queue-005): THE REMAINING EIGHT. They were on the inline driver — `setImmediate` in
 * the API process, no row in any table — so a deploy, an OOM kill or a crash took them with it and
 * nothing recorded that anything had been lost. Every one of them either spends money on a
 * third-party API or runs for minutes:
 *
 *   captions            Groq whisper-large-v3 per video                        billable
 *   metadata            OpenAI chat completion, recorded in token_usage        billable
 *   podcast_script      the writers' room; cost_cents per pass, 50 min stale   billable + long
 *   podcast_render      ElevenLabs TTS per turn, then an ffmpeg stitch         billable + long
 *   podcast_clips       ElevenLabs TTS per turn, then per-clip ffmpeg          billable + long
 *   podcast_mix_export  ffmpeg loudnorm two-pass + encode from frozen clips    long
 *   transcode           the full HLS ladder for an upload of up to 2 GB        long
 *   project_duplicate   copies every storage object in a project               long
 *
 * The billable ones are the sharp edge: the money leaves before the process dies, so losing the
 * job loses the RESULT and keeps the CHARGE.
 *
 * This list is the durability contract, and `__tests__/durability.test.ts` asserts it covers
 * `JOB_NAMES` — a new job kind is durable or the suite says which one is not.
 */
export const PGBOSS_JOB_NAMES = [
  'crop',
  'video_generate',
  'project_export',
  'transcode',
  'captions',
  'metadata',
  'podcast_script',
  'podcast_render',
  'podcast_clips',
  'podcast_mix_export',
  'project_duplicate',
  // dub: the most expensive job kind in the product. An inline dub lost to a deploy would lose the
  // RESULT and keep the CHARGE — the same argument that made the eight above durable, only with a
  // per-job cost measured in dollars per source-minute rather than fractions of a cent.
  'dub',
] as const satisfies readonly JobName[];

const DLQ_SUFFIX = '-dead';

// Per-queue retry/backoff + expiry. Inherited by each job; expireInSeconds must exceed the
// worst-case job runtime (crop's stale-claim window is 20 min, so 30 min is a safe ceiling;
// video_generate polls up to 20 min then downloads + HLS-transcodes, so 45 min).
// project_export: retries are safe — run() no-ops on terminal states and its claim() refuses a
// second live encode, so a retry only ever resumes a CRASHED run (the claim goes stale with the
// heartbeat). 60 min covers per-section capture wall clocks (≤10 min each) plus the assembly.
/**
 * The pg-boss queue policies that actually enforce `singletonKey` (job-queue-006).
 *
 * pg-boss's unique index over `singleton_key` is PARTIAL ON THE POLICY — `job_i1` fires only for
 * `short`, `job_i2` only for `singleton`, and so on. Under the default `standard` policy there is
 * no index at all, so a `singletonKey` is an inert text column: every duplicate send inserts a
 * second job and `send()` never returns the null our callers read as "already queued exactly once".
 * A queue that is sent a key and left on `standard` is a guarantee that exists only in comments.
 */
export const SINGLETON_POLICIES: readonly QueuePolicy[] = [
  'short',
  'singleton',
  'stately',
  'exclusive',
  'key_strict_fifo',
];

/**
 * POLICY IS REQUIRED here, not optional, so adding a queue forces an explicit answer to "do two
 * sends of this mean one piece of work?".
 *
 * `short` — one CREATED job per key, unlimited active — is the only one we use, and it is exactly
 * what the call sites describe: it collapses duplicates that are still WAITING, and says nothing
 * about a retry or about two workers in different processes. The stronger policies (`exclusive`,
 * `stately`) gate the RETRY re-insert on the same index, and pg-boss re-inserts retries with
 * `ON CONFLICT DO NOTHING` — so a retry colliding with a queued sibling would be silently dropped.
 * That trades a duplicate for a LOST job, which is the wrong direction for this codebase.
 *
 * `standard` is the right answer wherever a second request genuinely is a second request; those
 * queues pass no key at all (see `singletonKeyFor` in pgBossDriver.ts).
 */
export const QUEUE_OPTIONS: Record<
  (typeof PGBOSS_JOB_NAMES)[number],
  QueueOptions & { policy: QueuePolicy }
> = {
  crop: { policy: 'short', retryLimit: 3, retryDelay: 30, retryBackoff: true, expireInSeconds: 30 * 60 },
  video_generate: { policy: 'short', retryLimit: 2, retryDelay: 60, retryBackoff: true, expireInSeconds: 45 * 60 },
  // An export's worst case is the SUM of its sections' wall-clock caps, and each of those is up to
  // 600 s (`wallClockCapSec`) — so a project with more than six simulation windows could legitimately
  // still be working when a 60-minute expiry fired. Expiring a job that is genuinely progressing is
  // the worst outcome available: pg-boss retries it, and the retry redoes every expensive capture
  // from the start. The expiry must therefore stay ABOVE what the per-section caps already permit.
  // This is not a timeout raised to hide a hang — the hang is caught by the per-section wall clock,
  // which is unchanged; this only stops the queue from interrupting honest work.
  project_export: { policy: 'short', retryLimit: 2, retryDelay: 60, retryBackoff: true, expireInSeconds: 3 * 60 * 60 },

  // ── Phase E (job-queue-005) ────────────────────────────────────────────────────────────────
  // Every expiry below is set ABOVE the handler's own stale-claim window, because those two
  // numbers answer the same question and disagreeing is how a live run gets retried underneath
  // itself. pg-boss's 15-minute default is under all of them, which is why none is left unset.

  // No CAS claim of its own — it sets hls_status='processing' and beats a heartbeat — so a
  // duplicate delivery genuinely double-encodes. Hence the singleton key (see singletonKeyFor)
  // and an expiry far above any honest run: a 2 GB source ladder is measured in tens of minutes.
  transcode: { policy: 'short', retryLimit: 2, retryDelay: 60, retryBackoff: true, expireInSeconds: 2 * 60 * 60 },

  // STALE_CLAIM_MS is 20 min. No key: the payload carries `force`, and collapsing a forced
  // re-caption into a queued ordinary one would silently discard the user's explicit request.
  captions: { policy: 'standard', retryLimit: 2, retryDelay: 60, retryBackoff: true, expireInSeconds: 45 * 60 },

  // A second metadata request is a second request (different MetadataOptions), so no key.
  // retryLimit 1: the handler swallows its own errors, so a retry only follows a crash or an
  // expiry — and each attempt is a paid completion.
  metadata: { policy: 'standard', retryLimit: 1, retryDelay: 60, retryBackoff: true, expireInSeconds: 30 * 60 },

  // STALE_MS is 50 min (opus-max passes run long), so the expiry has to clear it.
  podcast_script: { policy: 'standard', retryLimit: 1, retryDelay: 120, retryBackoff: true, expireInSeconds: 70 * 60 },

  // STALE_MS 30 min for both render kinds. Keyed on renderId: `recoverStuckPodcastRenders` re-drives
  // every untouched queued render on EVERY boot, so a restart loop otherwise stacks one delivery per
  // boot on the same row — the same cost argument that earned video_generate its key.
  podcast_render: { policy: 'short', retryLimit: 1, retryDelay: 120, retryBackoff: true, expireInSeconds: 45 * 60 },
  podcast_mix_export: { policy: 'short', retryLimit: 2, retryDelay: 60, retryBackoff: true, expireInSeconds: 45 * 60 },

  // STALE_MS 30 min. No key: a mix is built once per mixId and there is no boot re-drive for it.
  podcast_clips: { policy: 'standard', retryLimit: 1, retryDelay: 120, retryBackoff: true, expireInSeconds: 45 * 60 },

  // Heartbeat-leased (DUPLICATION_STALE_AFTER_MS = 5 min of silence), but a duplication of a large
  // project copies every object in it, so the expiry is generous. No key: the duplicationId is
  // minted per request and nothing re-drives it.
  project_duplicate: { policy: 'standard', retryLimit: 2, retryDelay: 60, retryBackoff: true, expireInSeconds: 2 * 60 * 60 },

  /**
   * Dubbing. Two of these numbers are doing unusual work and both are about money.
   *
   * `policy: 'short'` with a singletonKey of the dub id, because two sends for one video_dubs row
   * are unambiguously ONE piece of work — unlike `captions`, whose `force` flag makes a second
   * request a genuinely different request. Collapsing duplicates here is free safety.
   *
   * `retryLimit: 8`, which is far above every other queue, and it is not a tolerance for failure.
   * A retry here is overwhelmingly a DEFERRAL: the workspace's three vendor slots were busy, the
   * handler threw `DubSlotUnavailable` without spending anything, and the row is still `queued`.
   * With three slots shared across every tenant, a queue of ten dubs must be able to wait its turn
   * rather than exhaust its retries waiting. Genuine failures do not consume these attempts —
   * `DubbingService.run` swallows non-retryable vendor errors after recording them on the row, so
   * a bad request fails once and stops.
   *
   * `expireInSeconds` clears the handler's own 2-hour STALE_CLAIM_MS, for the reason every other
   * expiry here does: those two numbers answer the same question and disagreeing is how a live run
   * gets retried underneath itself — which for this queue would mean a second invoice.
   */
  dub: { policy: 'short', retryLimit: 8, retryDelay: 120, retryBackoff: true, expireInSeconds: 3 * 60 * 60 },
};

function connectionString(): string {
  return (
    process.env.QUEUE_DATABASE_URL ??
    process.env.DATABASE_URL ??
    'postgresql://postgres:postgres@localhost:5432/podcast_saas'
  );
}

function needsSsl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host.endsWith('.supabase.com') || host.endsWith('.supabase.co');
  } catch {
    return false;
  }
}

let bossPromise: Promise<PgBossType> | null = null;

/** Get the started pg-boss singleton, creating + starting it (and its queues) on first use. */
export function getBoss(): Promise<PgBossType> {
  if (bossPromise) return bossPromise;
  bossPromise = (async () => {
    const url = connectionString();
    const schema = process.env.QUEUE_PGBOSS_SCHEMA ?? 'pgboss';
    const { PgBoss } = await import('pg-boss');
    const boss = new PgBoss({
      connectionString: url,
      schema,
      max: Number(process.env.QUEUE_PGBOSS_MAX ?? '4'),
      ssl: needsSsl(url) ? { rejectUnauthorized: false } : undefined,
      useListenNotify: process.env.QUEUE_PGBOSS_LISTEN === '1',
    });
    boss.on('error', (err) => logger.error({ err }, '[pg-boss] runtime error'));
    await boss.start();
    await ensureQueues(boss);
    await reconcileQueuePolicies(boss, schema);
    logger.info({ schema }, '[pg-boss] started');
    return boss;
  })().catch((err) => {
    bossPromise = null; // allow a later call to retry a fresh start
    throw err;
  });
  return bossPromise;
}

/** Idempotently create each durable queue and its dead-letter queue. */
async function ensureQueues(boss: PgBossType): Promise<void> {
  for (const name of PGBOSS_JOB_NAMES) {
    const dead = deadLetterName(name);
    try {
      await boss.createQueue(dead);
      await boss.createQueue(name, { ...QUEUE_OPTIONS[name], deadLetter: dead });
      // createQueue is ON CONFLICT DO NOTHING, so for a queue that already exists it silently
      // ignores every option — including the retry/expiry numbers above, which is why raising
      // project_export's expiry in code alone would never have reached production. updateQueue
      // applies them. It cannot change `policy`; reconcileQueuePolicies() does that.
      const { policy: _policy, ...updatable } = QUEUE_OPTIONS[name];
      await boss.updateQueue(name, { ...updatable, deadLetter: dead });
    } catch (err) {
      // createQueue is safe to call repeatedly; log and continue if the queue already exists.
      logger.debug({ err, queue: name }, '[pg-boss] createQueue (already exists?)');
    }
  }
}

/** The dead-letter queue paired with a durable queue. */
export function deadLetterName(name: (typeof PGBOSS_JOB_NAMES)[number]): string {
  return `${name}${DLQ_SUFFIX}`;
}

/**
 * Make an ALREADY-EXISTING queue's policy match what QUEUE_OPTIONS asks for (job-queue-006).
 *
 * This is the half of the fix that is easy to miss, and without it the fix is cosmetic. pg-boss's
 * `create_queue` ends in `ON CONFLICT DO NOTHING`, so adding `policy` to the options changes
 * nothing for a queue that already exists — which, in production, is all of them. And `policy` is
 * the one field `updateQueue()` cannot change: `UpdateQueueOptions` omits it, and its UPDATE
 * statement does not touch the column. So the only way to repair a live deployment is to set the
 * column directly.
 *
 * SAFE ON A QUEUE WITH WORK IN IT. The policy indexes are partial on `job.policy`, and each job
 * row carries the policy it was inserted with — so flipping the queue cannot violate an index for
 * jobs already queued under `standard`. New sends read `q.policy` at insert time and are guarded
 * from the next one onward.
 *
 * Never throws: a database that refuses the UPDATE must not stop pg-boss from starting. It is
 * logged at error level because the de-duplication is then genuinely absent, and an operator
 * should see that rather than infer it.
 */
export async function reconcileQueuePolicies(boss: PgBossType, schema: string): Promise<void> {
  try {
    const names = PGBOSS_JOB_NAMES as readonly string[];
    const existing = await boss.getQueues([...names]);
    const drifted = existing.filter(
      (q) => names.includes(q.name) && q.policy !== QUEUE_OPTIONS[q.name as (typeof PGBOSS_JOB_NAMES)[number]].policy,
    );
    for (const q of drifted) {
      const wanted = QUEUE_OPTIONS[q.name as (typeof PGBOSS_JOB_NAMES)[number]].policy;
      // Identifier is our own configured schema, never user input; the values are bound.
      await boss.getDb().executeSql(
        `UPDATE ${schema}.queue SET policy = $1, updated_on = now() WHERE name = $2`,
        [wanted, q.name],
      );
      logger.warn(
        { queue: q.name, was: q.policy, now: wanted },
        '[pg-boss] queue policy repaired — singletonKey was not being enforced',
      );
    }
  } catch (err) {
    logger.error(
      { err },
      '[pg-boss] could not reconcile queue policies — singletonKey de-duplication may be inactive',
    );
  }
}

/**
 * Gracefully stop pg-boss (drains in-flight work). Safe to call when never started.
 *
 * The timeout is declared in `shutdownBudget.ts` because deploy/docker-compose.yml has to give the
 * container at least this long before SIGKILL (job-queue-004); a test asserts the two agree.
 */
export async function stopBoss(): Promise<void> {
  if (!bossPromise) return;
  const pending = bossPromise;
  bossPromise = null;
  try {
    const boss = await pending;
    await boss.stop({ graceful: true, timeout: PGBOSS_STOP_TIMEOUT_MS });
    logger.info('[pg-boss] stopped');
  } catch (err) {
    logger.warn({ err }, '[pg-boss] stop failed');
  }
}
