/**
 * SemVer calculation for release tags of the form vMAJOR.MINOR.PATCH.
 * Pure functions — the tag list comes from git, decisions are deterministic.
 */

export type BumpKind = 'patch' | 'minor' | 'major';

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

const TAG_RE = /^v(\d+)\.(\d+)\.(\d+)$/;

export function parseSemverTag(tag: string): SemVer | null {
  const m = tag.trim().match(TAG_RE);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export function formatTag(v: SemVer): string {
  return `v${v.major}.${v.minor}.${v.patch}`;
}

export function compareSemver(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

export function bump(v: SemVer, kind: BumpKind): SemVer {
  switch (kind) {
    case 'major':
      return { major: v.major + 1, minor: 0, patch: 0 };
    case 'minor':
      return { major: v.major, minor: v.minor + 1, patch: 0 };
    case 'patch':
      return { major: v.major, minor: v.minor, patch: v.patch + 1 };
  }
}

export interface VersionPlan {
  /** Highest existing release tag, or null when none exist yet. */
  currentTag: string | null;
  /** The next tag to create. */
  nextTag: string;
  bump: BumpKind;
}

/**
 * Compute the next version from the full tag list. Non-semver tags are ignored.
 * With no prior release tags the baseline is v0.0.0 (so the first patch release
 * is v0.0.1). Throws if the computed tag already exists — tags are immutable.
 */
export function computeNextVersion(tags: string[], kind: BumpKind): VersionPlan {
  const parsed = tags
    .map((t) => ({ tag: t.trim(), v: parseSemverTag(t) }))
    .filter((x): x is { tag: string; v: SemVer } => x.v !== null)
    .sort((a, b) => compareSemver(a.v, b.v));

  const current = parsed.length > 0 ? parsed[parsed.length - 1] : null;
  const base = current?.v ?? { major: 0, minor: 0, patch: 0 };
  const nextTag = formatTag(bump(base, kind));

  assertTagAvailable(tags, nextTag);
  return { currentTag: current?.tag ?? null, nextTag, bump: kind };
}

/** Refuse to reuse or overwrite an existing tag under any circumstances. */
export function assertTagAvailable(tags: string[], candidate: string): void {
  const taken = new Set(tags.map((t) => t.trim()));
  if (taken.has(candidate)) {
    throw new Error(
      `Tag ${candidate} already exists — release tags are immutable and are never moved or overwritten.`,
    );
  }
}
