/**
 * scripts-ship-013 — the seeders guarded storage and not the database.
 *
 * `assertLocalStorageOnly` protects the BYTES. It says nothing about where `wipe()`'s four
 * `db.delete` calls land, and nothing anywhere inspected `DATABASE_URL`. So
 * `STORAGE_BACKEND=local` with a production `DATABASE_URL` passed every check the script had, then
 * wiped and seeded a public [SYNTHETIC] project into production — exactly the standing "never touch
 * prod from local" rule, with no code path enforcing it.
 *
 * Storage and database are independent variables; one implying the other is the assumption that
 * made this reachable.
 */
import { describe, it, expect } from 'vitest';
import { assertLocalDatabase, ALLOW_NONLOCAL_DB_ENV } from '../scripts/seedGuards.js';

const NO_ENV = {} as NodeJS.ProcessEnv;

describe('assertLocalDatabase', () => {
  it('accepts a developer database', () => {
    for (const url of [
      'postgres://u:p@localhost:5432/app',
      'postgresql://u:p@127.0.0.1:5432/app',
      'postgres://u:p@[::1]:5432/app',
      // The compose service names, for a run from inside the dev network.
      'postgres://u:p@postgres:5432/app',
      'postgres://u:p@db:5432/app',
    ]) {
      expect(() => assertLocalDatabase(url, NO_ENV), url).not.toThrow();
    }
  });

  it('REFUSES a managed database — the case that could wipe production', () => {
    for (const url of [
      'postgres://u:p@db.abcdefgh.supabase.co:5432/postgres',
      'postgresql://u:p@prod-db.eu-west-1.rds.amazonaws.com:5432/app',
      'postgres://u:p@10.0.0.5:5432/app',
    ]) {
      expect(() => assertLocalDatabase(url, NO_ENV), url).toThrow(/not a local database/);
    }
  });

  it('names the host it refused, so the message is actionable', () => {
    expect(() => assertLocalDatabase('postgres://u:p@db.xyz.supabase.co:5432/postgres', NO_ENV))
      .toThrow(/db\.xyz\.supabase\.co/);
  });

  it('FAILS CLOSED on a URL it cannot parse', () => {
    // "We could not tell, so proceed" is the wrong default for a function whose next statement is
    // DELETE.
    for (const url of ['not-a-url', '://missing-scheme', 'just some text']) {
      expect(() => assertLocalDatabase(url, NO_ENV), url).toThrow();
    }
  });

  it('FAILS CLOSED when DATABASE_URL is unset or empty', () => {
    expect(() => assertLocalDatabase(undefined, NO_ENV)).toThrow(/not set/);
    expect(() => assertLocalDatabase('', NO_ENV)).toThrow(/not set/);
    expect(() => assertLocalDatabase('   ', NO_ENV)).toThrow();
  });

  it('honours the explicit escape hatch, and only when set deliberately', () => {
    const prod = 'postgres://u:p@prod.rds.amazonaws.com:5432/app';
    expect(() => assertLocalDatabase(prod, { [ALLOW_NONLOCAL_DB_ENV]: '1' } as NodeJS.ProcessEnv)).not.toThrow();
    expect(() => assertLocalDatabase(prod, { [ALLOW_NONLOCAL_DB_ENV]: 'true' } as NodeJS.ProcessEnv)).not.toThrow();
    // Anything else is not an override — including values people assume mean "on".
    for (const v of ['0', 'false', '', 'yes', 'YES']) {
      expect(() => assertLocalDatabase(prod, { [ALLOW_NONLOCAL_DB_ENV]: v } as NodeJS.ProcessEnv), v).toThrow();
    }
  });

  it('tells the operator how to override, rather than just refusing', () => {
    expect(() => assertLocalDatabase('postgres://u:p@prod.example.com/app', NO_ENV))
      .toThrow(new RegExp(ALLOW_NONLOCAL_DB_ENV));
  });
});
