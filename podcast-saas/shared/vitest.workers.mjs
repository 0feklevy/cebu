/**
 * HOW MANY FILE WORKERS A SUITE MAY SPAWN — one answer, shared by every workspace config.
 *
 * THE PROBLEM THIS SOLVES. `release:verify` runs `pnpm -r test`, which starts every workspace's
 * suite CONCURRENTLY. Vitest's default worker count is derived per-process from the machine's core
 * count, and each process believes it has the whole machine — so four workspaces on a 10-core host
 * ask for roughly 9 workers EACH, ~36 threads competing for 10 cores. Nothing is oversubscribed
 * from any single suite's point of view, which is exactly why it was never noticed from inside one.
 *
 * The visible symptom was tests timing out with passing assertions: work that takes 200ms on an
 * idle machine taking seconds under 3.6x oversubscription. That was addressed from the other side
 * too (a 20s `testTimeout` — see any workspace config), and the two fixes are complementary rather
 * than alternatives: the timeout stops EXTERNAL load being reported as failure, this stops the
 * suite creating the load itself.
 *
 * THE RULE. Half the available cores, at least one. Half rather than all because a test worker is
 * not the only thing running — the pnpm parent processes, esbuild/oxc transforms and (on this
 * project's own host) ffmpeg and audit agents are real. `availableParallelism()` rather than
 * `cpus().length` because it respects cgroup CPU limits, which is what a CI container actually
 * gets; `cpus()` reports the host's cores and would over-provision on every runner.
 *
 * `VITEST_MAX_WORKERS` overrides it. `release-verify.sh` sets it to 2 precisely because it is the
 * one caller that runs four suites at once and therefore needs a tighter budget than any of them
 * would choose alone. A standalone `pnpm --filter client-web test` keeps the larger default, since
 * crippling the common case to protect the rare one is a bad trade.
 */

import { availableParallelism } from 'node:os';

export function maxTestWorkers() {
  const override = Number(process.env.VITEST_MAX_WORKERS);
  if (Number.isInteger(override) && override > 0) return override;
  return Math.max(1, Math.floor(availableParallelism() / 2));
}
