/**
 * Describing an LLM response that could not be parsed, WITHOUT putting it in the log.
 *
 * ── THE PROBLEM (observability-009) ───────────────────────────────────────────────────────────
 * When every JSON repair attempt fails, `LLMService` logged `raw.slice(0, 800)` at error level.
 * That string is the model's attempt at a structured answer about the user's own material — a
 * script draft, a corpus document, a brief — so the log line carries customer content by
 * construction, and at error level it is the line most likely to be shipped somewhere, pasted into
 * an issue, or read by whoever is on call.
 *
 * ── WHY NOT JUST DELETE THE LOG ───────────────────────────────────────────────────────────────
 * Because it is the only evidence a parse failure leaves behind, and a 422 with nothing attached
 * gets reported as "the AI is broken" and cannot be diagnosed. Removing it trades one real problem
 * for another.
 *
 * ── WHY THERE IS NO EXCERPT HERE, NOT EVEN A REDACTED ONE ─────────────────────────────────────
 * The first version of this module kept 120 redacted characters from each end, on the reasoning
 * that recognising the FORM needs a little text. Its own test disproved that compromise: a fixture
 * containing "The acquisition price agreed with Northwind was fourteen million" survived redaction
 * intact and appeared in the log, because it is not credential-shaped — it is just a sentence. A
 * redactor removes the things that look like secrets, and the material this system handles is
 * confidential without looking like anything.
 *
 * So there is no excerpt. Everything below is a classification or a count, and none of it can
 * contain a customer's words. If someone genuinely needs to see what a model returned, the answer
 * is to re-run the request with the same input — not to keep a copy of every failure in the logs.
 *
 * That costs less than it sounds. Almost none of the diagnostic value of the old 800 characters
 * was in the words: a JSON parse failure is a question about SHAPE. Did the model wrap it in a
 * fence, did it stop mid-object because it hit the token ceiling, did it write prose instead, did
 * it refuse. Every one of those is answerable structurally.
 */

/**
 * What the model returned, in the coarsest terms that still separate the causes.
 *
 * These are the buckets that lead to DIFFERENT actions: `prose` and `refusal` mean the prompt or
 * the policy is the problem, `fenced` means the extractor missed a wrapper, `json-object` with an
 * unbalanced brace means the token ceiling, `markup` means the wrong model or a badly confused one.
 */
export type OutputKind =
  | 'empty'
  | 'fenced'
  | 'json-object'
  | 'json-array'
  | 'markup'
  | 'refusal'
  | 'prose'
  | 'other';

/**
 * Refusal openings, matched against the start of the response.
 *
 * A FIXED LIST compared against, never echoed. The match result is a boolean, so nothing the model
 * wrote reaches the log even when it matches. Deliberately short: this is a hint that says "look at
 * the prompt and the moderation settings", not a classifier anything depends on.
 */
const REFUSAL_OPENINGS = [
  /^i(?:'m| am) sorry\b/i,
  /^i(?:'m| am) unable\b/i,
  /^i cannot\b/i,
  /^i can(?:'|')?t\b/i,
  /^sorry,/i,
  /^unfortunately,/i,
  /^i(?:'m| am) not able to\b/i,
];

export interface UnparseableShape {
  /** Length of the ORIGINAL output, before trimming. With `braceBalance`, the token-ceiling signal. */
  len: number;
  /** Which of the causes above this looks like. */
  kind: OutputKind;
  /** The first non-whitespace character, or '' when empty. One character; never a word. */
  startsWith: string;
  /** The last non-whitespace character. `}` reads as complete; `,` or `"` reads as cut off. */
  endsWith: string;
  /** `{` minus `}`, ignoring braces inside strings. Positive means it stopped early. */
  braceBalance: number;
  /** `[` minus `]`, same reading. */
  bracketBalance: number;
  /** An odd number of unescaped double quotes: a string was left open. */
  unbalancedQuotes: boolean;
  /** How many `"` appeared at all. Zero on a long response means it was not JSON in any form. */
  quoteCount: number;
}

/**
 * Balance counters that ignore anything inside a JSON string.
 *
 * Counting braces blind is worse than not counting: a title like `"Chapter {1}"` shifts the balance,
 * and the number then says "truncated" about a complete response — a diagnosis that sends someone
 * to raise the token limit for a problem that is not there. The scan tracks string state and
 * backslash escapes so the answer means what it claims to.
 */
function structure(s: string): Pick<UnparseableShape, 'braceBalance' | 'bracketBalance' | 'unbalancedQuotes' | 'quoteCount'> {
  let brace = 0;
  let bracket = 0;
  let inString = false;
  let escaped = false;
  let quotes = 0;

  for (const ch of s) {
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { if (inString) escaped = true; continue; }
    if (ch === '"') { inString = !inString; quotes++; continue; }
    if (inString) continue;
    if (ch === '{') brace++;
    else if (ch === '}') brace--;
    else if (ch === '[') bracket++;
    else if (ch === ']') bracket--;
  }

  return { braceBalance: brace, bracketBalance: bracket, unbalancedQuotes: quotes % 2 === 1, quoteCount: quotes };
}

function classify(trimmed: string): OutputKind {
  if (trimmed.length === 0) return 'empty';
  if (trimmed.startsWith('```')) return 'fenced';
  if (trimmed.startsWith('{')) return 'json-object';
  if (trimmed.startsWith('[')) return 'json-array';
  if (trimmed.startsWith('<')) return 'markup';
  // Checked before the generic prose bucket: a refusal IS prose, and it is the one kind of prose
  // whose fix is somewhere other than the JSON extractor.
  if (REFUSAL_OPENINGS.some((r) => r.test(trimmed))) return 'refusal';
  if (/^[A-Za-z]/.test(trimmed)) return 'prose';
  return 'other';
}

/**
 * Turn an unparseable model response into something safe to log.
 *
 * Never throws: this runs on the failure path, and a describer that can fail turns a diagnosable
 * 422 into an unhandled error inside the error handler, losing the original cause.
 */
export function describeUnparseable(raw: string): UnparseableShape {
  const s = typeof raw === 'string' ? raw : String(raw ?? '');
  const trimmed = s.trim();

  return {
    len: s.length,
    kind: classify(trimmed),
    startsWith: trimmed.slice(0, 1),
    endsWith: trimmed.slice(-1),
    ...structure(trimmed),
  };
}
