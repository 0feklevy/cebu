/**
 * Consent, bound to one exact plan.
 *
 * `allow_degraded: true` used to be a naked boolean in the request body. Anything that could reach
 * the endpoint could set it, and it said nothing about WHAT was being agreed to — so a client could
 * send it without ever showing a dialog, a stale tab could send it for a project that had changed
 * since, and a retry could send it for a plan whose substitutions were now entirely different. The
 * user's agreement was being inferred from a flag rather than recorded.
 *
 * A consent token is that agreement written down: this user, this project, this policy, this exact
 * plan, valid for a few minutes. It is signed, so it cannot be minted by the client; it names the
 * plan's fingerprint, so agreeing to one set of substitutions cannot authorise another; and it
 * expires, so a tab left open overnight does not carry yesterday's decision into today's project.
 *
 * It is deliberately NOT a session or a capability — it authorises exactly one export of exactly
 * one plan, and the server checks every field rather than trusting the signature alone.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Bumped whenever the payload's meaning changes, so old tokens stop verifying rather than drift. */
export const CONSENT_TOKEN_VERSION = 1;

/**
 * Five minutes. Long enough to read a dialog and decide; short enough that a tab left open across a
 * working session cannot silently agree on behalf of a project that has since been rewritten. The
 * fingerprint check would catch that anyway — this is the second lock on the same door.
 */
export const CONSENT_TTL_MS = 5 * 60 * 1000;

export interface ConsentClaims {
  v: number;
  projectId: string;
  userId: string;
  policy: 'allow_poster';
  fingerprint: string;
  /** Unix ms. */
  exp: number;
}

export class ConsentSecretMissing extends Error {
  constructor() {
    super('EXPORT_CONSENT_SECRET is not set — degraded-export consent cannot be issued or verified');
    this.name = 'ConsentSecretMissing';
  }
}

/**
 * The signing key, from its own variable.
 *
 * No fallback, and specifically not the database URL or any other secret that happens to be in the
 * environment: a signing key derived from something else fails open the day that something else is
 * rotated, logged, or shared with a subsystem that has no business signing consent. Absent in
 * production is a hard error, because the alternative — a default key — is a signature anybody
 * reading the source can forge.
 */
export function consentSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.EXPORT_CONSENT_SECRET?.trim();
  if (secret && secret.length >= 32) return secret;
  if (secret) {
    throw new Error('EXPORT_CONSENT_SECRET is too short — use at least 32 characters of real entropy');
  }
  throw new ConsentSecretMissing();
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/** Compare in constant time, and never throw on a length mismatch. */
function signatureMatches(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export interface IssueConsentInput {
  projectId: string;
  userId: string;
  fingerprint: string;
  nowMs: number;
  ttlMs?: number;
}

/** Mint a token for one plan. The only policy a token can carry is the one that needs consent. */
export function issueConsentToken(input: IssueConsentInput, env: NodeJS.ProcessEnv = process.env): string {
  const secret = consentSecret(env);
  const claims: ConsentClaims = {
    v: CONSENT_TOKEN_VERSION,
    projectId: input.projectId,
    userId: input.userId,
    policy: 'allow_poster',
    fingerprint: input.fingerprint,
    exp: input.nowMs + (input.ttlMs ?? CONSENT_TTL_MS),
  };
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

export type ConsentRejection =
  | 'malformed'
  | 'bad_signature'
  | 'wrong_version'
  | 'expired'
  | 'project_mismatch'
  | 'user_mismatch'
  | 'plan_changed';

export class ConsentInvalid extends Error {
  constructor(readonly reason: ConsentRejection, message: string) {
    super(message);
    this.name = 'ConsentInvalid';
  }
}

export interface VerifyConsentInput {
  token: unknown;
  projectId: string;
  userId: string;
  fingerprint: string;
  nowMs: number;
}

/**
 * Verify a token against the plan it is being spent on.
 *
 * Every field is checked, not just the signature. A valid signature over the wrong project, the
 * wrong user, or a plan that has since changed is exactly the case this exists to refuse: the
 * signature proves the server issued it, and the claims prove it was issued for THIS.
 */
export function verifyConsentToken(
  input: VerifyConsentInput,
  env: NodeJS.ProcessEnv = process.env,
): ConsentClaims {
  const secret = consentSecret(env);
  if (typeof input.token !== 'string' || !input.token.includes('.')) {
    throw new ConsentInvalid('malformed', 'consent token is missing or malformed');
  }
  const dot = input.token.lastIndexOf('.');
  const payload = input.token.slice(0, dot);
  const signature = input.token.slice(dot + 1);
  if (!signatureMatches(signature, sign(payload, secret))) {
    throw new ConsentInvalid('bad_signature', 'consent token signature does not verify');
  }

  let claims: ConsentClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as ConsentClaims;
  } catch {
    throw new ConsentInvalid('malformed', 'consent token payload is not JSON');
  }

  if (claims.v !== CONSENT_TOKEN_VERSION) {
    throw new ConsentInvalid('wrong_version', `consent token version ${claims.v} is no longer accepted`);
  }
  if (!Number.isFinite(claims.exp) || claims.exp <= input.nowMs) {
    throw new ConsentInvalid('expired', 'consent has expired — confirm again');
  }
  if (claims.projectId !== input.projectId) {
    throw new ConsentInvalid('project_mismatch', 'consent was given for a different project');
  }
  if (claims.userId !== input.userId) {
    throw new ConsentInvalid('user_mismatch', 'consent was given by a different user');
  }
  if (claims.policy !== 'allow_poster') {
    throw new ConsentInvalid('malformed', 'consent token carries no recognised policy');
  }
  if (claims.fingerprint !== input.fingerprint) {
    // The project changed between the dialog and the confirmation, so the substitutions the user
    // saw are not the substitutions that would happen. Re-prompt rather than proceed.
    throw new ConsentInvalid('plan_changed', 'the project changed since you confirmed — review the new plan');
  }
  return claims;
}
