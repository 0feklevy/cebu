/**
 * Safety predicates for fixture seeders, in their own module so they are importable by unit tests.
 *
 * The synthetic sim-pool seeder writes package bytes, HLS media and posters through the configured
 * storage adapter. Its whole authorization rests on that adapter being LOCAL DISK: pointed at a
 * cloud bucket it would write synthetic fixtures into shared storage. The seeder script itself
 * runs `main()` at import time, so a test cannot import IT to prove the refusal exists — the
 * refusal lives here instead, where deleting or weakening it is caught by a unit test rather than
 * by someone noticing objects in a bucket.
 */
import { LocalStorageAdapter } from '../services/storage/LocalStorageAdapter.js';

export function assertLocalStorageOnly(storage: unknown): asserts storage is LocalStorageAdapter {
  if (!(storage instanceof LocalStorageAdapter)) {
    throw new Error('refusing to run: STORAGE_BACKEND must resolve to the LOCAL disk adapter — '
      + 'this fixture must never write into a cloud bucket');
  }
}

/**
 * Hosts a fixture seeder is allowed to wipe and re-seed.
 *
 * Loopback only, by name and by literal address. A developer's Postgres is one of these; a managed
 * database never is.
 */
const LOCAL_DB_HOSTS: ReadonlySet<string> = new Set([
  'localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0',
  // The container name Compose gives the dev database, for a seeder run from inside the network.
  'postgres', 'db',
]);

/** The escape hatch, named so that using it is a visible decision in the command line. */
export const ALLOW_NONLOCAL_DB_ENV = 'ALLOW_NONLOCAL_DB';

/**
 * Refuse to run a destructive fixture script against a database that is not local (scripts-ship-013).
 *
 * ── Why storage was not enough ────────────────────────────────────────────────────────────────
 * `assertLocalStorageOnly` guards the BYTES, and it is the only guard the synthetic seeder had.
 * But the seeder also runs `wipe()` — four `db.delete` calls — and then inserts a public
 * `[SYNTHETIC]` project. Nothing anywhere looked at `DATABASE_URL`. So
 * `STORAGE_BACKEND=local` with a production `DATABASE_URL` passed every check and wiped and
 * seeded production, which is exactly the standing "never touch prod from local" rule.
 *
 * The two are independent variables and they need independent guards; one implying the other is
 * the assumption that made this reachable.
 *
 * ── Failing closed on an unparseable URL ──────────────────────────────────────────────────────
 * A URL this cannot parse is REFUSED, not waved through. The alternative — "we could not tell, so
 * proceed" — is the wrong default for a function whose next statement is `DELETE`.
 */
export function assertLocalDatabase(databaseUrl: string | undefined, env: NodeJS.ProcessEnv = process.env): void {
  if (env[ALLOW_NONLOCAL_DB_ENV] === '1' || env[ALLOW_NONLOCAL_DB_ENV] === 'true') return;

  const refuse = (why: string): never => {
    throw new Error(
      `refusing to run: ${why}. This script DELETES rows and seeds fixtures, so it runs only `
      + `against a local database. Set ${ALLOW_NONLOCAL_DB_ENV}=1 to override deliberately.`,
    );
  };

  if (!databaseUrl || databaseUrl.trim() === '') refuse('DATABASE_URL is not set');

  let host: string;
  try {
    // postgres:// and postgresql:// both parse; a password with reserved characters does not
    // survive URL parsing in every case, so an unparseable value fails closed rather than open.
    host = new URL(databaseUrl!).hostname.toLowerCase();
  } catch {
    return refuse('DATABASE_URL could not be parsed, so its host cannot be checked');
  }

  if (!host) refuse('DATABASE_URL names no host');
  if (!LOCAL_DB_HOSTS.has(host)) {
    refuse(`DATABASE_URL points at "${host}", which is not a local database`);
  }
}
