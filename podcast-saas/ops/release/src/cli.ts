/**
 * Release-engine CLI — the ONLY entry point GitHub Actions calls.
 *   pnpm --filter ops-release release-cli <command> [flags]
 *
 * Deterministic by construction: no AI, no network beyond the explicitly-audited
 * GET/HEAD probes, no secrets read or printed.
 */
import {
  cmdBrowserAudit,
  cmdCspAudit,
  cmdDbUrlAudit,
  cmdEndpointAudit,
  cmdGate,
  cmdImageManifestVerify,
  cmdMigrationAudit,
  cmdPlan,
  cmdPlaywrightSummary,
  cmdPreflight,
  cmdReport,
  cmdSecretScan,
  cmdStateInit,
  cmdStateTransition,
  cmdVmAudit,
  defaultContext,
} from './commands.js';
import { cmdDryRun } from './dry-run.js';
import type { BumpKind } from './semver.js';
import type { Phase } from './severity.js';
import type { ReleaseState } from './state-machine.js';
import type { BackfillPolicy } from './database-url-audit.js';

function parseArgs(argv: string[]): { flags: Map<string, string>; bools: Set<string>; rest: string[] } {
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      rest.push(a);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(a.slice(2), next);
      i++;
    } else {
      bools.add(a.slice(2));
    }
  }
  return { flags, bools, rest };
}

const USAGE = `Usage: release-cli <command> [flags]

  plan                --bump patch|minor|major [--out plan.json]
  preflight           --next-tag vX.Y.Z [--out preflight.json]
  secret-scan         [--out secret-scan.json]
  migration-audit     --base-ref <tag|sha|""> [--out migration-audit.json]
  csp-audit           --app client-web|admin-web [--url URL | --csp-string CSP] [--out file]
  image-manifest      --verify --manifest manifest.json [--out file]
  vm-audit            --file vm-audit.json --policy report-only|allow-safe|require-approval [--out file]
  db-url-audit        --report backfill.json --policy … [--max-affected N] [--out file]
  browser-audit       --report browser-audit.json [--out file]
  playwright-summary  --report playwright.json [--out file]
  endpoint-audit      [--out endpoints.json]
  gate                --phase pre-deploy|post-deploy --findings f1.json,f2.json [--approve-high] [--block-on-warning] [--out gate.json]
  state-init          --file state.json --run-id ID [--version V] [--git-sha SHA] [--bump B]
  state-transition    --file state.json --to STATE [--note TEXT]
  report              --dir artifacts/ --run-id ID --out-json report.json --out-md report.md [meta flags]
  dry-run             --out-dir DIR
`;

async function main(): Promise<number> {
  const [command, ...raw] = process.argv.slice(2);
  const { flags, bools } = parseArgs(raw);
  const ctx = defaultContext();
  const need = (name: string): string => {
    const v = flags.get(name);
    if (v === undefined) throw new Error(`Missing required flag --${name}\n\n${USAGE}`);
    return v;
  };

  switch (command) {
    case 'plan':
      return (await cmdPlan(ctx, { bump: need('bump') as BumpKind, out: flags.get('out') })).exitCode;
    case 'preflight':
      return (await cmdPreflight(ctx, { nextTag: need('next-tag'), out: flags.get('out') })).exitCode;
    case 'secret-scan':
      return (await cmdSecretScan(ctx, { out: flags.get('out') })).exitCode;
    case 'migration-audit':
      return (await cmdMigrationAudit(ctx, { baseRef: flags.get('base-ref') ?? '', out: flags.get('out') })).exitCode;
    case 'csp-audit':
      return (
        await cmdCspAudit(ctx, {
          app: need('app') as 'client-web' | 'admin-web',
          url: flags.get('url'),
          cspString: flags.get('csp-string'),
          out: flags.get('out'),
        })
      ).exitCode;
    case 'image-manifest':
      return cmdImageManifestVerify(ctx, { manifestFile: need('manifest'), out: flags.get('out') }).exitCode;
    case 'vm-audit':
      return cmdVmAudit(ctx, { file: need('file'), policy: need('policy') as BackfillPolicy, out: flags.get('out') }).exitCode;
    case 'db-url-audit':
      return cmdDbUrlAudit(ctx, {
        reportFile: need('report'),
        policy: need('policy') as BackfillPolicy,
        maxAffected: flags.has('max-affected') ? Number(flags.get('max-affected')) : undefined,
        out: flags.get('out'),
      }).exitCode;
    case 'browser-audit':
      return cmdBrowserAudit(ctx, { reportFile: need('report'), out: flags.get('out') }).exitCode;
    case 'playwright-summary':
      return cmdPlaywrightSummary(ctx, { reportFile: need('report'), out: flags.get('out') }).exitCode;
    case 'endpoint-audit':
      return (await cmdEndpointAudit(ctx, { out: flags.get('out') })).exitCode;
    case 'gate':
      return cmdGate(ctx, {
        findingsFiles: need('findings').split(','),
        phase: need('phase') as Phase,
        policy: { approveHigh: bools.has('approve-high'), blockOnWarning: bools.has('block-on-warning') },
        out: flags.get('out'),
      }).exitCode;
    case 'state-init':
      cmdStateInit(ctx, {
        file: need('file'),
        runId: need('run-id'),
        version: flags.get('version'),
        gitSha: flags.get('git-sha'),
        bump: flags.get('bump'),
      });
      return 0;
    case 'state-transition':
      cmdStateTransition(ctx, { file: need('file'), to: need('to') as ReleaseState, note: flags.get('note') });
      return 0;
    case 'report':
      cmdReport(ctx, {
        dir: need('dir'),
        meta: {
          runId: need('run-id'),
          version: flags.get('version'),
          previousVersion: flags.get('previous-version'),
          gitSha: flags.get('git-sha'),
          bump: flags.get('bump'),
          deploy: flags.has('deploy') ? flags.get('deploy') === 'true' : undefined,
          backfillPolicy: flags.get('backfill-policy'),
          startedAt: flags.get('started-at'),
          endedAt: flags.get('ended-at'),
          actor: flags.get('actor'),
          workflowUrl: flags.get('workflow-url'),
        },
        outJson: need('out-json'),
        outMd: need('out-md'),
      });
      return 0;
    case 'dry-run':
      return (await cmdDryRun(ctx, { outDir: need('out-dir') })).exitCode;
    case undefined:
    case 'help':
    case '--help':
      process.stdout.write(USAGE);
      return command === undefined ? 1 : 0;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
      return 1;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
