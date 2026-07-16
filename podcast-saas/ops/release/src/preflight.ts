/**
 * Source verification before anything is built or tagged:
 *   - working tree clean;
 *   - HEAD is exactly origin/main HEAD (releases only ship main; no divergence);
 *   - the computed next tag does not exist locally or on the remote;
 *   - determinism pins present (packageManager, pnpm-lock.yaml).
 */
import { finding, type Finding } from './severity.js';
import type { Runner } from './run.js';

export interface PreflightFacts {
  headSha: string;
  originMainSha: string;
  dirtyFiles: number;
  localTags: string[];
  remoteTagExists: boolean;
}

export interface PreflightResult {
  facts: PreflightFacts;
  findings: Finding[];
}

export interface PreflightOptions {
  /** Repo root to run git in. */
  cwd: string;
  /** The tag the release plans to create. */
  nextTag: string;
  /** Contents of the app package.json (for the packageManager pin check). */
  rootPackageJson: string;
  /** Whether pnpm-lock.yaml exists at the app root. */
  lockfileExists: boolean;
}

export async function preflight(run: Runner, opts: PreflightOptions): Promise<PreflightResult> {
  const findings: Finding[] = [];
  const git = (args: string[]) => run('git', args, { cwd: opts.cwd });

  const status = await git(['status', '--porcelain']);
  const dirty = status.stdout.split('\n').filter((l) => l.trim().length > 0);
  if (status.code !== 0) {
    findings.push(finding('source.git-status-failed', 'CRITICAL', 'source', 'git status failed', { detail: status.stderr.trim() }));
  } else if (dirty.length > 0) {
    findings.push(
      finding('source.dirty-tree', 'CRITICAL', 'source', `Working tree is dirty (${dirty.length} path(s)) — releases must build from a clean checkout.`),
    );
  }

  const head = await git(['rev-parse', 'HEAD']);
  const originMain = await git(['rev-parse', 'origin/main']);
  const headSha = head.stdout.trim();
  const originMainSha = originMain.stdout.trim();
  if (head.code !== 0 || originMain.code !== 0) {
    findings.push(finding('source.rev-parse-failed', 'CRITICAL', 'source', 'Could not resolve HEAD / origin/main.'));
  } else if (headSha !== originMainSha) {
    findings.push(
      finding('source.not-origin-main', 'CRITICAL', 'source', 'HEAD is not origin/main HEAD — only commits already on origin/main are releasable.', {
        detail: `HEAD=${headSha} origin/main=${originMainSha}`,
      }),
    );
  }

  const tagList = await git(['tag', '-l']);
  const localTags = tagList.stdout.split('\n').map((t) => t.trim()).filter(Boolean);
  if (localTags.includes(opts.nextTag)) {
    findings.push(
      finding('source.tag-exists-local', 'CRITICAL', 'source', `Tag ${opts.nextTag} already exists locally — tags are immutable and never reused.`),
    );
  }

  const remote = await git(['ls-remote', '--tags', 'origin', `refs/tags/${opts.nextTag}`]);
  const remoteTagExists = remote.code === 0 && remote.stdout.trim().length > 0;
  if (remote.code !== 0) {
    findings.push(finding('source.ls-remote-failed', 'CRITICAL', 'source', 'Could not check remote tags.', { detail: remote.stderr.trim() }));
  } else if (remoteTagExists) {
    findings.push(
      finding('source.tag-exists-remote', 'CRITICAL', 'source', `Tag ${opts.nextTag} already exists on origin — tags are immutable and never reused.`),
    );
  }

  try {
    const pkg = JSON.parse(opts.rootPackageJson) as { packageManager?: string };
    if (!pkg.packageManager?.startsWith('pnpm@')) {
      findings.push(
        finding('source.no-package-manager-pin', 'HIGH', 'source', 'package.json has no pnpm packageManager pin — builds are not fully deterministic.'),
      );
    }
  } catch {
    findings.push(finding('source.package-json-unreadable', 'CRITICAL', 'source', 'Root package.json is unreadable.'));
  }

  if (!opts.lockfileExists) {
    findings.push(finding('source.no-lockfile', 'CRITICAL', 'source', 'pnpm-lock.yaml missing — frozen installs are impossible.'));
  }

  return {
    facts: { headSha, originMainSha, dirtyFiles: dirty.length, localTags, remoteTagExists },
    findings,
  };
}
