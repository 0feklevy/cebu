import { sql, type SQL } from 'drizzle-orm';

/**
 * Build a jsonb ARRAY of strings for insert/update.
 *
 * WHY: postgres.js JSON-re-encodes any parameter bound to a jsonb cast, and
 * Drizzle's jsonb codec pre-stringifies — so passing a JS string[] to a jsonb
 * column stores a doubly-encoded jsonb *string* (jsonb_typeof = 'string'), which
 * violates courses_outcomes_array_chk. Building the array server-side with
 * jsonb_build_array(<text params>) yields a true jsonb array on both
 * postgres-js (app) and pglite (tests).
 */
export function jsonbStringArray(values: string[] | null | undefined): SQL {
  if (!values || values.length === 0) return sql`'[]'::jsonb`;
  const elems = sql.join(values.map((v) => sql`${v}::text`), sql`, `);
  return sql`jsonb_build_array(${elems})`;
}
