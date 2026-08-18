/**
 * config-008 — the root `package.json` delegates to workspace scripts, and nothing checked that
 * the target script exists.
 *
 *   "generate": "pnpm --filter backend-api generate && pnpm --filter shared build"
 *
 * `backend-api` has no `generate` script. `pnpm run generate` therefore failed on its FIRST clause
 * and never reached the `shared build` half, so the one command a newcomer would reach for after
 * reading `shared/src/generated/` was broken — and broken in the specific way that teaches the
 * wrong lesson, because it implies a codegen step exists.
 *
 * A missing delegation target is invisible until someone runs the command, and the commands most
 * likely to rot are exactly the ones nobody runs. This test reads the manifests instead: for every
 * `pnpm --filter <workspace> <script>` (and `pnpm -F`, and npm's `-w`) in ANY workspace's scripts,
 * the named workspace must define the named script.
 *
 * Deliberately not checked: shell builtins, `bash x.sh`, `node x.js` and `pnpm exec` — those are
 * paths, not delegation, and a path check would be a different test with different failure modes.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Every workspace of this monorepo, by the name `--filter` would use, plus the root. */
const WORKSPACE_DIRS = ['backend-api', 'client-web', 'admin-web', 'shared', 'ops/release', 'ops/ship'];

type Manifest = { name?: string; scripts?: Record<string, string> };

function readManifest(dir: string): Manifest | null {
  const path = join(REPO, dir, 'package.json');
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Manifest) : null;
}

const rootManifest = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as Manifest;

const byName = new Map<string, Manifest>();
for (const dir of WORKSPACE_DIRS) {
  const manifest = readManifest(dir);
  if (manifest?.name) byName.set(manifest.name, manifest);
}

/** `pnpm --filter <ws> <script>`, `pnpm -F <ws> <script>`, `npm run <script> -w <ws>`. */
export function delegations(command: string): Array<{ workspace: string; script: string }> {
  const found: Array<{ workspace: string; script: string }> = [];
  for (const m of command.matchAll(/pnpm\s+(?:--filter|-F)\s+"?([^\s"]+)"?\s+(?:run\s+)?([A-Za-z0-9:_-]+)/g)) {
    found.push({ workspace: m[1], script: m[2] });
  }
  for (const m of command.matchAll(/npm\s+run\s+([A-Za-z0-9:_-]+)\s+-w\s+"?([^\s"]+)"?/g)) {
    found.push({ workspace: m[2], script: m[1] });
  }
  return found;
}

const allScripts: Array<{ from: string; name: string; command: string }> = [
  ...Object.entries(rootManifest.scripts ?? {}).map(([name, command]) => ({ from: '<root>', name, command })),
  ...WORKSPACE_DIRS.flatMap((dir) => {
    const manifest = readManifest(dir);
    return Object.entries(manifest?.scripts ?? {}).map(([name, command]) => ({ from: dir, name, command }));
  }),
];

describe('workspace script delegation', () => {
  it('reads the manifests it claims to — an empty scan would pass everything', () => {
    expect(byName.size).toBe(WORKSPACE_DIRS.length);
    expect(allScripts.length).toBeGreaterThan(30);
  });

  it('every delegated script exists in the workspace it names', () => {
    const broken: string[] = [];
    for (const { from, name, command } of allScripts) {
      for (const { workspace, script } of delegations(command)) {
        const target = byName.get(workspace);
        if (!target) {
          broken.push(`${from} "${name}" filters an unknown workspace "${workspace}"`);
        } else if (!(target.scripts ?? {})[script]) {
          broken.push(`${from} "${name}" runs "${script}" in "${workspace}", which does not define it`);
        }
      }
    }
    expect(broken).toEqual([]);
  });
});

describe('the delegation parser', () => {
  it('reads --filter, -F, and npm -w forms', () => {
    expect(delegations('pnpm --filter backend-api generate && pnpm --filter shared build')).toEqual([
      { workspace: 'backend-api', script: 'generate' },
      { workspace: 'shared', script: 'build' },
    ]);
    expect(delegations('pnpm -F ops-ship ship')).toEqual([{ workspace: 'ops-ship', script: 'ship' }]);
    expect(delegations('npm run build -w shared')).toEqual([{ workspace: 'shared', script: 'build' }]);
    expect(delegations('pnpm --filter shared run typecheck')).toEqual([{ workspace: 'shared', script: 'typecheck' }]);
  });

  it('ignores recursive and non-delegating commands', () => {
    expect(delegations('pnpm -r --parallel dev')).toEqual([]);
    expect(delegations('bash deploy/scripts/release-verify.sh')).toEqual([]);
    expect(delegations('node backend-api/dist/server.js')).toEqual([]);
  });
});
