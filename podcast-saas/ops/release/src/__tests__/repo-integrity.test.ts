import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Repository integrity: no undeclared gitlinks.
 *
 * Incident (PR #2 CI): a local nested repo (`myprojects/`, personal projects) was
 * swept into the index by a broad `git add` as a mode-160000 gitlink with no
 * .gitmodules entry. actions/checkout@v6 then failed every job at checkout with
 *   "No url found for submodule path 'myprojects' in .gitmodules" (git exit 128),
 * and the same entry was the source of checkout@v4's post-step git-128 warning.
 *
 * Invariant: every mode-160000 index entry MUST be declared in .gitmodules with a
 * matching path and a non-empty url. This repository intentionally has no
 * submodules today, so the expected state is zero gitlinks — but the check stays
 * valid if a real, properly-declared submodule is ever added.
 */

const MONOREPO_ROOT = join(new URL('.', import.meta.url).pathname, '..', '..', '..', '..', '..');

function gitlinks(): string[] {
  const out = execFileSync('git', ['ls-files', '--stage'], { cwd: MONOREPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out
    .split('\n')
    .filter((line) => line.startsWith('160000 '))
    .map((line) => line.split('\t')[1])
    .filter(Boolean);
}

function declaredSubmodulePaths(): Map<string, string> {
  const file = join(MONOREPO_ROOT, '.gitmodules');
  const declared = new Map<string, string>(); // path -> url
  if (!existsSync(file)) return declared;
  const text = readFileSync(file, 'utf8');
  for (const section of text.split(/\[submodule /).slice(1)) {
    const path = section.match(/^\s*path\s*=\s*(.+)$/m)?.[1]?.trim();
    const url = section.match(/^\s*url\s*=\s*(.+)$/m)?.[1]?.trim();
    if (path) declared.set(path, url ?? '');
  }
  return declared;
}

describe('no undeclared gitlinks (the PR #2 checkout-128 incident)', () => {
  it('every mode-160000 index entry has a matching .gitmodules path AND url', () => {
    const links = gitlinks();
    const declared = declaredSubmodulePaths();
    const undeclaredOrBroken = links.filter((path) => {
      const url = declared.get(path);
      return url === undefined || url === '';
    });
    expect(
      undeclaredOrBroken,
      `gitlink(s) without a valid .gitmodules declaration (breaks actions/checkout): ${undeclaredOrBroken.join(', ')}\n` +
        'Either declare the submodule properly (path + real url) or `git rm --cached <path>` and gitignore it.',
    ).toEqual([]);
  });

  it('this repository currently has no submodules at all', () => {
    // Deliberate second assertion: today the intended state is ZERO gitlinks.
    // If a real submodule is ever introduced on purpose, update this test in the
    // same commit that adds the .gitmodules entry.
    expect(gitlinks()).toEqual([]);
  });
});
