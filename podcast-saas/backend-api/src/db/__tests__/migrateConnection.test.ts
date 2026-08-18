/**
 * WHICH DATABASE THE MIGRATION RUNNER CONNECTS TO — the DEPLOY PREREQUISITE, under test.
 *
 * THE DEFECT THESE EXIST FOR
 * The runner serializes concurrent deploys with a SESSION-level advisory lock, and the CLI used to
 * connect with `postgres(process.env.DATABASE_URL, { max: 1 })`. The documented DATABASE_URL for
 * this deployment is Supabase's TRANSACTION pooler on port 6543 (deploy/.env.example,
 * deploy/README.md). Through a transaction pooler `max: 1` pins one connection to the POOLER, not
 * to a Postgres backend — so `pg_advisory_lock` can be taken in one backend while the migrations
 * run in another. The call SUCCEEDS. The lock is real. It serializes nothing, and there is no error
 * to notice: two concurrent deploys could apply the same file at the same time.
 *
 * Every assertion below is about failing LOUDLY and EARLY instead. These are pure-function tests on
 * `resolveMigrationUrl` — no connection is opened, which is the point: the refusal has to happen
 * before any DDL is attempted.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_LOCAL_MIGRATION_URL,
  TRANSACTION_POOLER_PORT,
  describeTransactionPooler,
  resolveMigrationUrl,
} from '../migrate.js';

const SESSION = 'postgresql://postgres.abc:pw@aws-0-eu-west-1.pooler.supabase.com:5432/postgres';
const TRANSACTION = 'postgresql://postgres.abc:pw@aws-0-eu-west-1.pooler.supabase.com:6543/postgres';
const DIRECT = 'postgresql://postgres:pw@db.abcdefgh.supabase.co:5432/postgres';

/** A bare env — the runner must never read anything this object does not carry. */
const env = (vars: Record<string, string | undefined>): NodeJS.ProcessEnv =>
  vars as NodeJS.ProcessEnv;

describe('the transaction-pooler test', () => {
  it('names port 6543 as the reason, so the operator is not left guessing', () => {
    const reason = describeTransactionPooler(TRANSACTION);
    expect(reason).not.toBeNull();
    expect(reason).toContain(TRANSACTION_POOLER_PORT);
    expect(reason!.toLowerCase()).toContain('transaction');
  });

  it('accepts the SESSION-mode pooler on 5432 — the documented-correct configuration', () => {
    // The discriminator is the PORT, not the hostname: `*.pooler.supabase.com` serves both modes,
    // and deploy/README.md tells operators to point the queue (and now migrations) at :5432 on
    // exactly this host. A hostname test would reject the configuration the docs prescribe.
    expect(describeTransactionPooler(SESSION)).toBeNull();
  });

  it('accepts the direct connection', () => {
    expect(describeTransactionPooler(DIRECT)).toBeNull();
  });

  it('catches a pooled endpoint that announces itself in the query string', () => {
    // Some tooling (Prisma's convention, and hand-written PgBouncer URLs) states the pool mode
    // rather than moving the port. A 5432 port is then not enough to conclude session mode.
    expect(describeTransactionPooler(`${SESSION}?pgbouncer=true`)).toContain('pgbouncer=true');
    expect(describeTransactionPooler(`${SESSION}?pool_mode=transaction`)).toContain('transaction');
    expect(describeTransactionPooler(`${SESSION}?pool_mode=statement`)).toContain('statement');
    // …and does not fire on the mode that IS safe.
    expect(describeTransactionPooler(`${SESSION}?pool_mode=session`)).toBeNull();
  });

  it('does not judge a string it could not parse', () => {
    // A typo deserves the driver's error, which names the actual problem. Refusing to migrate over
    // a URL we could not even read would turn a typo into a mystery about pooling.
    expect(describeTransactionPooler('not a url at all')).toBeNull();
  });
});

describe('resolveMigrationUrl — preference order', () => {
  it('prefers MIGRATION_DATABASE_URL over everything else', () => {
    const r = resolveMigrationUrl(env({
      MIGRATION_DATABASE_URL: DIRECT,
      QUEUE_DATABASE_URL: SESSION,
      DATABASE_URL: TRANSACTION,
    }));
    expect(r).toEqual({ url: DIRECT, source: 'MIGRATION_DATABASE_URL' });
    // The intended configuration is the ONLY one that produces no warning.
    expect(r.fallbackNote).toBeUndefined();
  });

  it('falls back to QUEUE_DATABASE_URL, and says so out loud', () => {
    const r = resolveMigrationUrl(env({ QUEUE_DATABASE_URL: SESSION, DATABASE_URL: TRANSACTION }));
    expect(r.url).toBe(SESSION);
    expect(r.source).toBe('QUEUE_DATABASE_URL');
    // Explicit, not silent: the fallback is only defensible because the deploy contract already
    // requires this variable to be session-mode for pg-boss, and the note has to say that.
    expect(r.fallbackNote).toBeTruthy();
    expect(r.fallbackNote).toContain('MIGRATION_DATABASE_URL');
  });

  it('falls back to DATABASE_URL last, and still says so out loud', () => {
    const r = resolveMigrationUrl(env({ DATABASE_URL: DIRECT }));
    expect(r.url).toBe(DIRECT);
    expect(r.source).toBe('DATABASE_URL');
    expect(r.fallbackNote).toContain('MIGRATION_DATABASE_URL');
  });

  it('uses the local default only when nothing at all is configured', () => {
    const r = resolveMigrationUrl(env({}));
    expect(r.url).toBe(DEFAULT_LOCAL_MIGRATION_URL);
    expect(r.source).toBe('default');
    expect(r.fallbackNote).toBeTruthy();
  });

  it('treats an empty or whitespace value as unset rather than as an endpoint', () => {
    const r = resolveMigrationUrl(env({ MIGRATION_DATABASE_URL: '   ', QUEUE_DATABASE_URL: SESSION }));
    expect(r.source).toBe('QUEUE_DATABASE_URL');
  });
});

describe('resolveMigrationUrl — the refusal', () => {
  it('REFUSES the transaction pooler even when it is the only thing configured', () => {
    // This is the shipped defect, verbatim: DATABASE_URL is the 6543 pooler and nothing else is
    // set. The old runner connected happily and took a lock that serialized nothing.
    expect(() => resolveMigrationUrl(env({ DATABASE_URL: TRANSACTION }))).toThrow(
      /transaction pooler/i,
    );
  });

  it('REFUSES it when MIGRATION_DATABASE_URL itself is pointed at 6543', () => {
    // Introducing the variable is not the fix on its own — setting it WRONG has to fail too, or
    // the deploy prerequisite is only a naming convention.
    expect(() => resolveMigrationUrl(env({ MIGRATION_DATABASE_URL: TRANSACTION }))).toThrow(
      /transaction pooler/i,
    );
  });

  it('REFUSES a transaction-pooled QUEUE_DATABASE_URL rather than trusting the contract blindly', () => {
    // The fallback is justified by what the deploy docs REQUIRE of this variable. The value is
    // still checked, because a misconfigured deployment is exactly the case that matters.
    expect(() => resolveMigrationUrl(env({ QUEUE_DATABASE_URL: TRANSACTION }))).toThrow(
      /transaction pooler/i,
    );
  });

  it('the error names the variable to set, the reason, and that nothing was applied', () => {
    let message = '';
    try {
      resolveMigrationUrl(env({ DATABASE_URL: TRANSACTION }));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('MIGRATION_DATABASE_URL');
    expect(message).toContain(TRANSACTION_POOLER_PORT);
    expect(message).toContain('DATABASE_URL');          // where the bad value came from
    expect(message).toMatch(/advisory lock/i);          // why it matters
    expect(message).toMatch(/nothing has been applied/i); // what state the database is in
  });

  it('a rejected resolution returns no URL to connect with', () => {
    // The guard is a throw, not a flag somebody has to remember to read. There is no branch in
    // which a caller receives a pooler URL alongside a warning.
    expect(() => resolveMigrationUrl(env({
      MIGRATION_DATABASE_URL: TRANSACTION,
      QUEUE_DATABASE_URL: SESSION,
    }))).toThrow();
  });
});
