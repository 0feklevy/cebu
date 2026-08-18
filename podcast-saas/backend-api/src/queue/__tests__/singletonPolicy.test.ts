import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  PGBOSS_JOB_NAMES,
  QUEUE_OPTIONS,
  SINGLETON_POLICIES,
  reconcileQueuePolicies,
} from '../pgBoss.js';
import { singletonKeyFor } from '../pgBossDriver.js';
import type { JobName, JobPayloads } from '../types.js';

/**
 * job-queue-006 — `singletonKey` was doing nothing.
 *
 * pg-boss only enforces a singleton key when the QUEUE's policy asks it to: the unique index is
 * partial on `policy`. Our queues were created with the default `standard` policy, so every
 * `singletonKey` we passed was an inert string column, and the de-duplication three call sites
 * are written around — including `enqueueProjectExport`, whose "already queued (singleton)" branch
 * reads the null return — could never happen.
 *
 * These tests hold the two halves that have to stay true together: the policy we ask for honours
 * the key, and pg-boss still enforces it the way we think it does.
 */

const require = createRequire(import.meta.url);
const PG_BOSS_PLANS = readFileSync(require.resolve('pg-boss/dist/plans.js'), 'utf8');

const SAMPLE_PAYLOADS: { [N in JobName]: JobPayloads[N] } = {
  transcode: { videoFileId: 'v1' },
  captions: { videoId: 'v1' },
  crop: { videoFileId: 'v1' },
  metadata: { projectId: 'p1', videoFileId: 'v1' },
  podcast_script: { scriptId: 's1' },
  podcast_render: { renderId: 'r1' },
  podcast_clips: { mixId: 'm1' },
  podcast_mix_export: { renderId: 'r1' },
  video_generate: { jobId: 'g1' },
  project_duplicate: { duplicationId: 'd1' },
  project_export: { exportId: 'e1' },
};

describe('a queue that is sent a singletonKey must have a policy that honours it', () => {
  it('every job kind that gets a key is on a singleton-honouring queue', () => {
    const keyed = PGBOSS_JOB_NAMES.filter(
      (n) => singletonKeyFor(n, SAMPLE_PAYLOADS[n] as never) !== undefined,
    );
    expect(keyed.length, 'no keyed job kinds found — the test lost its subject').toBeGreaterThan(0);
    for (const name of keyed) {
      expect(
        QUEUE_OPTIONS[name].policy,
        `${name} is sent a singletonKey but its queue policy does not honour one`,
      ).toBeDefined();
      expect(SINGLETON_POLICIES).toContain(QUEUE_OPTIONS[name].policy);
    }
  });

  it('a queue with NO key stays on standard — dedup where none is meant is a bug in a costume', () => {
    const unkeyed = PGBOSS_JOB_NAMES.filter(
      // project_export is keyed by enqueueProjectExport, which bypasses singletonKeyFor — asserted
      // separately below.
      (n) => n !== 'project_export' && singletonKeyFor(n, SAMPLE_PAYLOADS[n]) === undefined,
    );
    expect(unkeyed.length, 'no unkeyed job kinds found — the test lost its subject').toBeGreaterThan(0);
    for (const name of unkeyed) {
      expect(QUEUE_OPTIONS[name].policy, `${name} passes no key but claims a singleton policy`)
        .toBe('standard');
    }
  });

  it('project_export too — its caller reads the deduped null return as success', () => {
    // enqueueProjectExport passes `singletonKey: exportId` directly (not via singletonKeyFor) and
    // treats a null id as "already queued exactly once". Under `standard` that null never came.
    const index = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    expect(index).toMatch(/singletonKey: exportId/);
    expect(SINGLETON_POLICIES).toContain(QUEUE_OPTIONS.project_export.policy);
  });
});

describe('the pg-boss contract this depends on', () => {
  it('the singleton unique index is conditional on the queue policy — standard has none', () => {
    // This is WHY the key was inert. Pinned against the installed pg-boss so an upgrade that
    // changes the contract fails here rather than silently un-guarding the queues.
    const indexLines = PG_BOSS_PLANS.split('\n').filter(
      (l) => /CREATE UNIQUE INDEX/.test(l) && /singleton_key/.test(l),
    );
    expect(indexLines.length, 'pg-boss no longer indexes singleton_key at all').toBeGreaterThan(0);

    // EVERY unique index over singleton_key is gated on a specific policy (or on singleton_on,
    // which is the throttle feature, not this one). None of them applies to `standard`.
    for (const line of indexLines) {
      expect(line, `unguarded singleton index: ${line.trim()}`).toMatch(
        /policy = '\$\{QUEUE_POLICIES\.\w+\}'|singleton_on IS NOT NULL/,
      );
    }
    // And the one we rely on is the `short` policy's: one CREATED job per key.
    expect(indexLines.join('\n')).toMatch(
      /job_i1 .*COALESCE\(singleton_key, ''\)\) WHERE state = '\$\{JOB_STATES\.created\}' AND policy = '\$\{QUEUE_POLICIES\.short\}'/,
    );
  });

  it('create_queue is ON CONFLICT DO NOTHING — an existing queue keeps its old policy', () => {
    // The reason setting `policy` in the options is not, by itself, the fix: production already
    // created these queues under `standard`, and createQueue will not change them.
    const createQueueFn = PG_BOSS_PLANS.slice(
      PG_BOSS_PLANS.indexOf('CREATE FUNCTION ${schema}.create_queue'),
    );
    expect(createQueueFn.slice(0, 4000)).toMatch(/ON CONFLICT DO NOTHING/);
  });
});

describe('reconcileQueuePolicies — repairs a queue that already exists on the wrong policy', () => {
  const SCHEMA = 'pgboss';

  function bossWith(existing: Array<{ name: string; policy: string }>) {
    const executeSql = vi.fn().mockResolvedValue({ rows: [] });
    const getQueues = vi.fn().mockResolvedValue(existing);
    return { boss: { getQueues, getDb: () => ({ executeSql }) } as never, executeSql, getQueues };
  }

  beforeEach(() => vi.clearAllMocks());

  it('rewrites the stored policy when it does not match what the code asks for', async () => {
    const { boss, executeSql } = bossWith(
      PGBOSS_JOB_NAMES.map((n) => ({
        name: n,
        // Every queue is already correct except `crop`, which is still on the pre-fix default.
        policy: n === 'crop' ? 'standard' : (QUEUE_OPTIONS[n].policy as string),
      })),
    );

    await reconcileQueuePolicies(boss, SCHEMA);

    expect(executeSql).toHaveBeenCalledTimes(1);
    const [sql, values] = executeSql.mock.calls[0];
    expect(sql).toMatch(/UPDATE\s+pgboss\.queue\s+SET\s+policy/i);
    expect(values).toEqual(['short', 'crop']);
  });

  it('touches nothing when every queue already has the right policy', async () => {
    const { boss, executeSql } = bossWith(
      PGBOSS_JOB_NAMES.map((n) => ({ name: n, policy: QUEUE_OPTIONS[n].policy as string })),
    );
    await reconcileQueuePolicies(boss, SCHEMA);
    expect(executeSql).not.toHaveBeenCalled();
  });

  it('a reconcile failure is logged, not thrown — pg-boss must still start', async () => {
    const executeSql = vi.fn().mockRejectedValue(new Error('permission denied'));
    const boss = {
      getQueues: vi.fn().mockResolvedValue([{ name: 'crop', policy: 'standard' }]),
      getDb: () => ({ executeSql }),
    } as never;
    await expect(reconcileQueuePolicies(boss, SCHEMA)).resolves.toBeUndefined();
  });
});
