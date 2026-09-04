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

/**
 * Bind ANY JSON value to a jsonb column without the double-encoding above.
 *
 * The parameter is the JSON TEXT bound as ::text (so neither drizzle's codec nor postgres.js
 * treats it as a jsonb parameter and re-encodes it), and the server performs the single
 * text→jsonb parse. Verified against the real postgres-js driver: the naive
 * `.values({ variants })` write stored a jsonb STRING scalar and violated
 * `sim_posters_variants_array_chk` — every server-side poster store failed
 * (sim-review 2026-09-04, P2; the "no poster still exists" export warnings).
 */
export function jsonbValue(value: unknown): SQL {
  return sql`(${JSON.stringify(value ?? null)}::text)::jsonb`;
}
