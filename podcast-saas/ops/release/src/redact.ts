/**
 * Redaction for everything that enters a report, artifact, or job summary.
 * Belt-and-braces on top of GitHub's own secret masking: known credential shapes
 * and secret-named keys are masked before any text is persisted.
 */

export const REDACTED = '***REDACTED***';

const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g, // Anthropic
  /sk-[A-Za-z0-9]{20,}/g, // OpenAI-style
  /sk_(?:live|test)_[A-Za-z0-9]{8,}/g, // Stripe secret
  /rk_(?:live|test)_[A-Za-z0-9]{8,}/g, // Stripe restricted
  /whsec_[A-Za-z0-9]{8,}/g, // Stripe webhook secret
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /gh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, // JWT (incl. Supabase keys)
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/** user:password@ credentials embedded in any URL (postgres://, https://, …). */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)([^:/\s@]+):([^@/\s]+)@/gi;

/** KEY=value / KEY: value assignments whose key name implies a secret. */
const SECRET_ASSIGNMENT =
  /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY|ACCESS_KEY|CREDENTIALS)[A-Z0-9_]*)(\s*[=:]\s*)(?!\*{3})("[^"]*"|'[^']*'|\S+)/g;

const SECRET_KEY_NAME = /(SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|API_KEY|ACCESS_KEY|CREDENTIALS)/i;

export function redactText(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, REDACTED);
  out = out.replace(URL_CREDENTIALS, (_m, scheme: string, user: string) => `${scheme}${user}:${REDACTED}@`);
  out = out.replace(SECRET_ASSIGNMENT, (_m, key: string, sep: string) => `${key}${sep}${REDACTED}`);
  return out;
}

/** Deep-redact every string in a JSON-safe value; secret-named keys are fully masked. */
export function redactValue<T>(value: T): T {
  return walk(value, false) as T;
}

function walk(value: unknown, keyIsSecret: boolean): unknown {
  if (typeof value === 'string') return keyIsSecret ? REDACTED : redactText(value);
  if (Array.isArray(value)) return value.map((v) => walk(v, keyIsSecret));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = walk(v, SECRET_KEY_NAME.test(k));
    }
    return out;
  }
  return value;
}
