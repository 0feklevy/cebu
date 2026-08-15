/**
 * The execution snapshot's identity.
 *
 * An export used to be planned twice: once in the controller, to answer the user, and again in the
 * worker, minutes or hours later. Between those two moments the project is fully editable — a
 * section can be retimed, a simulation republished, a clip deleted — so the video that was described
 * and the video that was produced were only ever probably the same. Consent compounded it: the user
 * agreed to a specific set of substitutions, and the worker then applied whatever the second plan
 * happened to need.
 *
 * So the plan is FROZEN when the job is created and the worker executes that, verbatim. The
 * fingerprint is what makes the freeze checkable: it names one exact plan, so a stored snapshot can
 * be verified before it runs, consent can be bound to it, and a redelivery can be shown to be
 * running the same thing rather than assumed to be.
 *
 * `plan` is never rewritten. Everything the run learns — substitutions, renderer identity, warnings,
 * failures — goes to separate columns, because a plan that changes as it executes is not a snapshot,
 * and the first question after any bad export is "what were we actually asked to make?".
 */

import { createHash } from 'node:crypto';

/**
 * Domain separator and version. A hash without one is a hash of "some JSON": the day another
 * subsystem fingerprints something structurally similar, the two spaces collide, and the day this
 * canonicalisation changes, old fingerprints silently mean something new. The prefix makes both
 * loud — every stored fingerprint is tied to the rules that produced it.
 */
export const FINGERPRINT_DOMAIN = 'flowvid.export.plan.v1';

/** Values that survive a JSON round-trip unchanged. Anything else is a bug, not a value. */
export type JsonSafe = null | boolean | number | string | JsonSafe[] | { [k: string]: JsonSafe };

export class NotCanonicalisable extends Error {
  constructor(path: string, reason: string) {
    super(`plan fingerprint: ${path || '<root>'} ${reason}`);
    this.name = 'NotCanonicalisable';
  }
}

/**
 * Serialise a value so that equal plans produce equal bytes and unequal plans do not.
 *
 * Object keys are SORTED, because `{a,b}` and `{b,a}` are the same plan and two fingerprints for one
 * plan would make the check useless. Array order is PRESERVED, because a timeline is a sequence and
 * reordering it is a different video. Everything else is refused rather than coerced: `undefined`,
 * functions and symbols vanish under `JSON.stringify` (so a dropped field would silently not change
 * the hash), `NaN` and `±Infinity` become `null` (so three different plans would collide), and a
 * `Date` or a class instance would hash by whatever `toJSON` felt like today. A fingerprint whose
 * inputs can disappear is not an identity.
 */
export function canonicalJson(value: unknown, path = ''): string {
  if (value === null) return 'null';

  const t = typeof value;
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'string') return JSON.stringify(value);
  if (t === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new NotCanonicalisable(path, `is ${String(value)}, which JSON cannot represent`);
    }
    // `-0` and `0` are the same number and must not be two fingerprints.
    return JSON.stringify(Object.is(value, -0) ? 0 : (value as number));
  }
  if (t === 'undefined') {
    // Reached only from inside an ARRAY, where JSON turns `undefined` into `null` — a real change
    // of value. As an object PROPERTY it is skipped below, exactly as `JSON.stringify` skips it, so
    // the hash describes the snapshot as it is STORED rather than as it happened to exist in
    // memory. That distinction is the whole point: the worker verifies bytes read back from JSONB.
    throw new NotCanonicalisable(path, 'is undefined inside an array — JSON would turn it into null');
  }
  if (t === 'function' || t === 'symbol' || t === 'bigint') {
    throw new NotCanonicalisable(path, `is a ${t}, which cannot be part of a plan`);
  }

  if (Array.isArray(value)) {
    return `[${value.map((v, i) => canonicalJson(v, `${path}[${i}]`)).join(',')}]`;
  }

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new NotCanonicalisable(path, `is a ${(value as object).constructor?.name ?? 'class'} instance, not plain data`);
  }

  const entries = Object.entries(value as Record<string, unknown>)
    // `JSON.stringify` omits undefined-valued properties, and the stored snapshot is what gets
    // verified — so the hash has to describe the same object the database will hand back.
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v, path ? `${path}.${k}` : k)}`)
    .join(',')}}`;
}

/** SHA-256 over the domain-separated canonical form. 64 lowercase hex characters. */
export function fingerprintPlan(plan: unknown): string {
  return createHash('sha256')
    .update(FINGERPRINT_DOMAIN)
    .update('\n')
    .update(canonicalJson(plan))
    .digest('hex');
}

/** A stored fingerprint is 64 lowercase hex characters and nothing else. */
export function isFingerprint(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/**
 * Verify a stored snapshot before running it.
 *
 * The row is trusted more than the container is, but not blindly: a snapshot whose hash does not
 * match has been edited by something, and the honest response is to refuse rather than to render
 * whatever is there now. This is also what makes consent meaningful — the token names a
 * fingerprint, and this is where "the plan the user agreed to" stops being a claim.
 */
export function assertFrozenPlan(
  plan: unknown,
  storedFingerprint: unknown,
  expectedProjectId: string,
): asserts plan is JsonSafe {
  if (!plan || typeof plan !== 'object') {
    throw new Error('export snapshot: the stored plan is missing or not an object');
  }
  if (!isFingerprint(storedFingerprint)) {
    throw new Error('export snapshot: the stored fingerprint is not 64 hex characters');
  }
  const projectId = (plan as { projectId?: unknown }).projectId;
  if (projectId !== expectedProjectId) {
    // A snapshot belonging to another project would render someone else's timeline under this row.
    throw new Error(
      `export snapshot: plan is for project ${JSON.stringify(String(projectId).slice(0, 64))}, not ${expectedProjectId}`,
    );
  }
  const actual = fingerprintPlan(plan);
  if (actual !== storedFingerprint) {
    throw new Error(
      `export snapshot: fingerprint mismatch — stored ${storedFingerprint.slice(0, 12)}…, plan hashes to ${actual.slice(0, 12)}…`,
    );
  }
}
