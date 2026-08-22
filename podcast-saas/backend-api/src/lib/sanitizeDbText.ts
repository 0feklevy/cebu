/**
 * Make arbitrary text safe to store in a Postgres `text` column.
 *
 * ── The one character that matters ────────────────────────────────────────────────────────────
 * Postgres rejects U+0000 in a text value outright: a NUL genuinely cannot be represented in a
 * `text` column, so the only choices are to strip it or to let the write throw.
 *
 * Where that bites is error paths. A message from an LLM, a vendor API, or a truncated subprocess
 * pipe can carry a NUL, and the place we most want to write it is the `error` column of a row we
 * are marking failed. That write lives inside a fire-and-forget `.catch()`, so its own throw is an
 * unhandled rejection, which terminates the process on Node 22 (backend-011). A failure handler
 * that can itself fail is the actual defect; this removes the input that makes it fail.
 *
 * Other C0 control characters are stripped for the same reason a log line does it — they are never
 * meaningful in a stored message and they corrupt whatever later renders it — but TAB, NEWLINE and
 * CARRIAGE RETURN are kept, because a multi-line stack trace is the whole value of the column.
 *
 * The length cap is a second, independent guard: an unbounded vendor payload in an error column is
 * a row nobody can read.
 */

/** Longest error text worth storing. Past this it is noise in a column, not evidence. */
export const MAX_DB_TEXT = 4_000;

/**
 * C0 controls except \t (09), \n (0A) and \r (0D), plus DEL (7F).
 *
 * `no-control-regex` is disabled deliberately and narrowly: the rule exists to catch a control
 * character typed into a pattern by accident, and matching them is the entire purpose of this one.
 */
// eslint-disable-next-line no-control-regex
const UNSTORABLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export function sanitizeDbText(value: string, maxLength = MAX_DB_TEXT): string {
  const stripped = value.replace(UNSTORABLE, '');
  if (stripped.length <= maxLength) return stripped;
  // Say that it was cut. A silently truncated stack trace reads as a complete one that happened to
  // end somewhere odd, which is worse than a shorter message that admits what it did.
  return `${stripped.slice(0, maxLength)}… [truncated]`;
}
