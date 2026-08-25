/**
 * Command handlers behind cli.ts. Each handler is a plain function over injected
 * inputs so integration tests can drive them without spawning processes.
 *
 * Conventions:
 *   - every command writes a JSON artifact (its section of the final report);
 *   - findings-producing commands exit non-zero when the phase gate would block;
 *   - nothing here calls an AI model, reads a .env file, or prints a secret.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditBrowserReport, parseBrowserAudit } from './asset-audit.js';
import {
  deriveVerdict,
  statusFromExit,
  COLLECTOR_LOG_SCHEMA,
  type CollectorLog,
  type CollectorRecord,
  type CollectorStatus,
  type CoverageEntry,
} from './audit-result.js';
import { checkRequiredEvidence, stampArtifact, type EvidenceExpectation } from './evidence.js';
import { RELEASE_CONFIG, type ReleaseConfig } from './config.js';
import { auditCspHeader, auditLiveCsp, type CspExpectation } from './csp-audit.js';
import { auditDatabaseUrls, parseBackfillReport, type BackfillPolicy, type UrlBackfillReport } from './database-url-audit.js';
import { setOutput } from './gha.js';
import { parseManifest, validateManifest, type ImageManifest } from './image-manifest.js';
import { auditMigrations, sha256, type MigrationAuditResult } from './migration-audit.js';
import { assessReleaseRisk, RELEASE_RISK_SCHEMA, type ReleaseRiskVerdict, type DiffBaseKind } from './release-risk.js';
import { preflight } from './preflight.js';
import { redactValue } from './redact.js';
import { buildReport, renderMarkdown, type EndpointStatus, type ReleaseReport, type StageTiming } from './report.js';
import { runCommand, type Runner } from './run.js';
import { computeNextVersion, type BumpKind } from './semver.js';
import { evaluateGate, finding, type Finding, type GateDecision, type GatePolicy, type Phase, sortFindings } from './severity.js';
import { createRun, parseRun, serializeRun, transition, type ReleaseState } from './state-machine.js';
import { secretScan } from './secret-scan.js';

export interface CommandContext {
  run: Runner;
  fetchImpl: typeof fetch;
  config: ReleaseConfig;
  /** Monorepo root (contains .git). */
  monorepoRoot: string;
  /** App root (podcast-saas). */
  appRoot: string;
  log: (msg: string) => void;
}

export function defaultContext(): CommandContext {
  // ops/release/src -> app root is two levels up; monorepo root three.
  //
  // fileURLToPath, NOT URL.pathname: pathname is percent-encoded, so a checkout under a
  // directory containing a space resolved to ".../My%20Repo/..." — a path that exists
  // nowhere. Every evidence path is anchored here, so that would silently break resolution.
  const appRoot = join(fileURLToPath(new URL('..', import.meta.url)), '..', '..');
  return {
    run: runCommand,
    fetchImpl: fetch,
    config: RELEASE_CONFIG,
    monorepoRoot: join(appRoot, '..'),
    appRoot,
    log: (msg) => process.stderr.write(msg + '\n'),
  };
}

export function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

const hasCritical = (findings: Finding[]) => findings.some((f) => f.severity === 'CRITICAL');

// ─── plan ───────────────────────────────────────────────────────────────────────

export interface PlanArtifact {
  schema: 'flowvid.release-plan/v1';
  bump: BumpKind;
  currentTag: string | null;
  nextTag: string;
  gitSha: string;
  actor?: string;
}

export async function cmdPlan(ctx: CommandContext, opts: { bump: BumpKind; out?: string }): Promise<{ plan: PlanArtifact; exitCode: number }> {
  const tags = await ctx.run('git', ['tag', '-l'], { cwd: ctx.monorepoRoot });
  if (tags.code !== 0) throw new Error(`git tag -l failed: ${tags.stderr}`);
  const head = await ctx.run('git', ['rev-parse', 'HEAD'], { cwd: ctx.monorepoRoot });
  if (head.code !== 0) throw new Error(`git rev-parse failed: ${head.stderr}`);

  const version = computeNextVersion(tags.stdout.split('\n').filter(Boolean), opts.bump);
  const plan: PlanArtifact = {
    schema: 'flowvid.release-plan/v1',
    bump: opts.bump,
    currentTag: version.currentTag,
    nextTag: version.nextTag,
    gitSha: head.stdout.trim(),
    ...(process.env.GITHUB_ACTOR ? { actor: process.env.GITHUB_ACTOR } : {}),
  };
  if (opts.out) writeJsonFile(opts.out, plan);
  setOutput('next_tag', plan.nextTag);
  setOutput('current_tag', plan.currentTag ?? '');
  setOutput('git_sha', plan.gitSha);
  ctx.log(`plan: ${plan.currentTag ?? '(none)'} + ${opts.bump} -> ${plan.nextTag} @ ${plan.gitSha}`);
  return { plan, exitCode: 0 };
}

// ─── preflight ───────────────────────────────────────────────────────────────────

export async function cmdPreflight(ctx: CommandContext, opts: { nextTag: string; out?: string }): Promise<{ findings: Finding[]; exitCode: number }> {
  const pkgPath = join(ctx.appRoot, 'package.json');
  const res = await preflight(ctx.run, {
    cwd: ctx.monorepoRoot,
    nextTag: opts.nextTag,
    rootPackageJson: existsSync(pkgPath) ? readFileSync(pkgPath, 'utf8') : '{}',
    lockfileExists: existsSync(join(ctx.appRoot, 'pnpm-lock.yaml')),
  });
  if (opts.out) writeJsonFile(opts.out, res);
  ctx.log(`preflight: ${res.findings.length} finding(s); HEAD=${res.facts.headSha}`);
  // The count alone left the first release failing with no visible cause in the
  // run log — print every finding, redacted (details may carry git remote stderr).
  for (const f of redactValue(sortFindings(res.findings))) {
    ctx.log(`  [${f.severity}] ${f.id}: ${f.message}${f.detail ? ` — ${f.detail}` : ''}`);
  }
  return { findings: res.findings, exitCode: hasCritical(res.findings) ? 1 : 0 };
}

// ─── secret scan ────────────────────────────────────────────────────────────────

export async function cmdSecretScan(ctx: CommandContext, opts: { out?: string }): Promise<{ findings: Finding[]; exitCode: number }> {
  const list = await ctx.run('git', ['ls-files', '-z'], { cwd: ctx.monorepoRoot });
  if (list.code !== 0) throw new Error(`git ls-files failed: ${list.stderr}`);
  const paths = list.stdout.split('\0').filter(Boolean);
  const result = await secretScan({
    listTrackedFiles: async () => paths,
    readFile: async (p) => {
      try {
        return readFileSync(join(ctx.monorepoRoot, p), 'utf8');
      } catch {
        return null;
      }
    },
  });
  if (opts.out) writeJsonFile(opts.out, result);
  ctx.log(`secret-scan: ${result.scannedFiles} file(s) content-scanned, ${result.findings.length} finding(s)`);
  return { findings: result.findings, exitCode: hasCritical(result.findings) ? 1 : 0 };
}

// ─── migration audit ────────────────────────────────────────────────────────────

export async function cmdMigrationAudit(
  ctx: CommandContext,
  opts: { baseRef: string; out?: string },
): Promise<{ result: MigrationAuditResult; exitCode: number }> {
  const migRelDir = `${ctx.config.appDir}/${ctx.config.migrations.dir}`;
  const diskDir = join(ctx.monorepoRoot, migRelDir);
  const diskFiles = readdirSync(diskDir)
    .filter((n) => n.endsWith('.sql'))
    .map((name) => ({ name, content: readFileSync(join(diskDir, name), 'utf8') }));

  let baseNames: string[] = [];
  const baseChecksums: Record<string, string> = {};
  if (opts.baseRef) {
    const ls = await ctx.run('git', ['ls-tree', '-r', '--name-only', opts.baseRef, '--', migRelDir], { cwd: ctx.monorepoRoot });
    if (ls.code !== 0) throw new Error(`git ls-tree ${opts.baseRef} failed: ${ls.stderr}`);
    baseNames = ls.stdout.split('\n').filter(Boolean).map((p) => p.split('/').pop()!);
    for (const name of baseNames) {
      const show = await ctx.run('git', ['show', `${opts.baseRef}:${migRelDir}/${name}`], { cwd: ctx.monorepoRoot });
      if (show.code === 0) baseChecksums[name] = sha256(show.stdout);
    }
  }

  const runnerSource = readFileSync(join(ctx.monorepoRoot, ctx.config.appDir, ctx.config.migrations.runnerSource), 'utf8');
  const result = auditMigrations({
    diskFiles,
    baseNames,
    baseChecksums,
    runnerSource,
    excluded: ctx.config.migrations.excluded,
    filePattern: ctx.config.migrations.filePattern,
  });
  if (opts.out) writeJsonFile(opts.out, result);
  ctx.log(`migration-audit: ${result.summary.newCount} new file(s), ${result.findings.length} finding(s)`);
  return { result, exitCode: hasCritical(result.findings) ? 1 : 0 };
}

// ─── CSP audit ──────────────────────────────────────────────────────────────────

export function cspExpectationFor(config: ReleaseConfig, app: 'client-web' | 'admin-web'): CspExpectation {
  return {
    app,
    apiOrigin: config.endpoints.api,
    firebaseAuthOrigin: `https://${config.csp.firebaseAuthDomain}`,
    ...(app === 'client-web' ? { stripeOrigin: config.csp.stripeJsOrigin } : {}),
    production: true,
  };
}

export async function cmdCspAudit(
  ctx: CommandContext,
  opts: { app: 'client-web' | 'admin-web'; url?: string; cspString?: string; out?: string },
): Promise<{ findings: Finding[]; exitCode: number }> {
  const exp = cspExpectationFor(ctx.config, opts.app);
  let artifact: { url?: string; status?: number | null; header: string | null; findings: Finding[] };
  if (opts.cspString !== undefined) {
    artifact = { header: opts.cspString, findings: auditCspHeader(opts.cspString, exp) };
  } else {
    const url = opts.url ?? (opts.app === 'client-web' ? ctx.config.endpoints.app : ctx.config.endpoints.admin);
    artifact = await auditLiveCsp(url, exp, ctx.fetchImpl);
  }
  if (opts.out) writeJsonFile(opts.out, artifact);
  ctx.log(`csp-audit(${opts.app}): ${artifact.findings.length} finding(s)`);
  return { findings: artifact.findings, exitCode: hasCritical(artifact.findings) ? 1 : 0 };
}

// ─── image manifest ─────────────────────────────────────────────────────────────

export function cmdImageManifestVerify(ctx: CommandContext, opts: { manifestFile: string; out?: string }): { findings: Finding[]; exitCode: number } {
  const manifest = parseManifest(readFileSync(opts.manifestFile, 'utf8'));
  const findings = validateManifest(manifest, ctx.config);
  if (opts.out) writeJsonFile(opts.out, { manifest, findings });
  ctx.log(`image-manifest: ${manifest.images.length} image(s), ${findings.length} finding(s)`);
  return { findings, exitCode: hasCritical(findings) ? 1 : 0 };
}

// ─── VM audit → findings (containers, certs, DB URL report) ────────────────────

export interface VmAudit {
  schema: 'flowvid.vm-audit/v1';
  generatedAt?: string;
  appVersion?: string;
  containers: Record<string, string>;
  backendHealth: { ok: boolean; body?: string };
  workerRunning: boolean;
  diskFreeGb: number | null;
  certDaysRemaining: Record<string, number | null>;
  urlBackfill: UrlBackfillReport | null;
}

export function auditVm(vm: VmAudit, config: ReleaseConfig, policy: BackfillPolicy): Finding[] {
  const findings: Finding[] = [];

  for (const [svc, state] of Object.entries(vm.containers)) {
    const okStates = ['healthy', 'running'];
    if (okStates.includes(state)) continue;
    if (svc === 'backend') {
      findings.push(finding('vm.backend-unhealthy', 'CRITICAL', 'health', `backend container is ${state}.`));
    } else if (svc === 'worker') {
      findings.push(finding('vm.worker-down', 'HIGH', 'health', `worker container is ${state} — background jobs are not processing.`));
    } else if (svc === 'certbot') {
      findings.push(finding('vm.certbot-down', 'WARNING', 'health', `certbot container is ${state} — renewals paused.`));
    } else {
      findings.push(finding(`vm.${svc}-unhealthy`, 'CRITICAL', 'health', `${svc} container is ${state}.`));
    }
  }
  if (!vm.backendHealth.ok) {
    findings.push(finding('vm.backend-health-endpoint', 'CRITICAL', 'health', 'Internal backend /health probe failed.'));
  }

  for (const [lineage, days] of Object.entries(vm.certDaysRemaining)) {
    if (days === null) {
      findings.push(finding('vm.cert-unreadable', 'CRITICAL', 'health', `TLS certificate for ${lineage} is missing/unreadable.`));
    } else if (days <= 0) {
      findings.push(finding('vm.cert-expired', 'CRITICAL', 'health', `TLS certificate for ${lineage} has EXPIRED.`));
    } else if (days < config.certExpiry.criticalDays) {
      findings.push(finding('vm.cert-expiring', 'HIGH', 'health', `TLS certificate for ${lineage} expires in ${days} day(s).`));
    } else if (days < config.certExpiry.warnDays) {
      findings.push(finding('vm.cert-expiring-soon', 'WARNING', 'health', `TLS certificate for ${lineage} expires in ${days} day(s).`));
    }
  }

  if (vm.diskFreeGb !== null && vm.diskFreeGb < 5) {
    findings.push(finding('vm.disk-low', 'WARNING', 'health', `Only ${vm.diskFreeGb}G free for Docker — image pulls may fail.`));
  }

  if (vm.urlBackfill) {
    findings.push(...auditDatabaseUrls(vm.urlBackfill, policy, vm.urlBackfill.maxAffectedRows ?? config.backfill.maxAffectedRowsDefault).findings);
  } else {
    findings.push(finding('vm.db-url-audit-unavailable', 'WARNING', 'backfill', 'DB URL audit unavailable (deployed image predates --json support).'));
  }

  return findings;
}

export function cmdVmAudit(ctx: CommandContext, opts: { file: string; policy: BackfillPolicy; out?: string }): { findings: Finding[]; exitCode: number } {
  const vm = readJson<VmAudit>(opts.file);
  if (vm.schema !== 'flowvid.vm-audit/v1') throw new Error(`Unknown vm-audit schema: ${String(vm.schema)}`);
  const findings = auditVm(vm, ctx.config, opts.policy);
  if (opts.out) writeJsonFile(opts.out, { vm, findings });
  ctx.log(`vm-audit: ${findings.length} finding(s)`);
  return { findings, exitCode: hasCritical(findings) ? 1 : 0 };
}

// ─── DB URL audit (standalone report file) ──────────────────────────────────────

export function cmdDbUrlAudit(
  ctx: CommandContext,
  opts: { reportFile: string; policy: BackfillPolicy; maxAffected?: number; out?: string },
): { findings: Finding[]; exitCode: number } {
  const report = parseBackfillReport(readFileSync(opts.reportFile, 'utf8'));
  const res = auditDatabaseUrls(report, opts.policy, opts.maxAffected ?? report.maxAffectedRows ?? ctx.config.backfill.maxAffectedRowsDefault);
  if (opts.out) writeJsonFile(opts.out, res);
  ctx.log(`db-url-audit: ${res.findings.length} finding(s), decision=${res.decision}`);
  return { findings: res.findings, exitCode: hasCritical(res.findings) ? 1 : 0 };
}

// ─── browser audit ──────────────────────────────────────────────────────────────

export function cmdBrowserAudit(ctx: CommandContext, opts: { reportFile: string; out?: string }): { findings: Finding[]; exitCode: number } {
  const report = parseBrowserAudit(readFileSync(opts.reportFile, 'utf8'));
  const findings = auditBrowserReport(report);
  if (opts.out) writeJsonFile(opts.out, { findings });
  ctx.log(`browser-audit: ${report.pages.length} page(s), ${findings.length} finding(s)`);
  return { findings, exitCode: hasCritical(findings) ? 1 : 0 };
}

// ─── endpoint audit ─────────────────────────────────────────────────────────────

/** Security headers worth recording on every public response. */
const AUDITED_SECURITY_HEADERS = [
  'strict-transport-security',
  'x-content-type-options',
  'x-frame-options',
  'referrer-policy',
  'content-security-policy',
] as const;

/** A single endpoint probe, rich enough to act on without re-running the audit by hand. */
export interface EndpointDetail extends EndpointStatus {
  /** 'https' proves TLS terminated; null when the request never completed. */
  scheme: string | null;
  tls: boolean;
  redirects: string[];
  finalUrl: string | null;
  latencyMs: number;
  securityHeaders: Record<string, string | null>;
  /** Body-declared health status, when the endpoint speaks the health JSON shape. */
  reportedStatus?: string;
  result: CollectorStatus;
  reason: string;
}

/**
 * Probe the public endpoints.
 *
 * The previous implementation logged only `endpoint-audit: 2/3 ok`, which is not enough
 * to act on: it names neither the failing endpoint, nor its status, nor whether the
 * failure was TLS, DNS, a redirect, or an application-level refusal. Every field below
 * exists because its absence made a real run ambiguous.
 *
 * Redirects are followed but recorded, because a public endpoint that answers 200 only
 * after an unexpected hop is a finding, not a pass.
 */
export async function cmdEndpointAudit(
  ctx: CommandContext,
  opts: { out?: string; runId?: string; gitSha?: string },
): Promise<{ findings: Finding[]; endpoints: EndpointDetail[]; exitCode: number }> {
  const e = ctx.config.endpoints;
  const targets: Array<{ name: string; url: string; critical: boolean }> = [
    { name: 'app', url: e.app, critical: true },
    { name: 'api-health', url: e.apiHealth, critical: true },
    { name: 'admin', url: e.admin, critical: false },
  ];
  const endpoints: EndpointDetail[] = [];
  const findings: Finding[] = [];

  for (const t of targets) {
    const startedAt = Date.now();
    let status: number | null = null;
    let finalUrl: string | null = null;
    let headers: Record<string, string | null> = {};
    let transportError: string | null = null;
    let reportedStatus: string | undefined;
    let bodyReason: string | undefined;

    try {
      const res = await ctx.fetchImpl(t.url, { method: 'GET', redirect: 'follow' });
      status = res.status;
      finalUrl = res.url || t.url;
      headers = Object.fromEntries(AUDITED_SECURITY_HEADERS.map((h) => [h, res.headers.get(h)]));
      // A health endpoint that answers 503 with {"status":"degraded","reason":"…"} is
      // telling us WHICH dependency is down. Recording that turns "api-health failed"
      // into an actionable line without a second manual request.
      const contentType = res.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) {
        try {
          const body = (await res.json()) as Record<string, unknown>;
          if (typeof body.status === 'string') reportedStatus = body.status;
          if (typeof body.reason === 'string') bodyReason = body.reason;
        } catch {
          /* a non-JSON body on a JSON content-type is not itself the finding here */
        }
      }
    } catch (err) {
      transportError = err instanceof Error ? err.message : String(err);
    }

    const latencyMs = Date.now() - startedAt;
    const ok = status !== null && status >= 200 && status < 400;
    const scheme = finalUrl ? new URL(finalUrl).protocol.replace(':', '') : null;
    // The fetch API does not expose the intermediate hop list; `res.url !== requested`
    // is the portable signal that redirection occurred, so record it as such rather
    // than claiming a chain we did not observe.
    // fetch normalises `https://host` to `https://host/`, so a naive string compare reported
    // a phantom redirect on every healthy path-less endpoint. Compare normalised forms.
    const sameTarget = (a: string, b: string): boolean => {
      try {
        return new URL(a).href === new URL(b).href;
      } catch {
        return a === b;
      }
    };
    const redirects = finalUrl && !sameTarget(finalUrl, t.url) ? [t.url, finalUrl] : [];

    const reason = transportError
      ? `transport failure: ${transportError}`
      : ok
        ? `HTTP ${status}${reportedStatus ? ` (reports "${reportedStatus}")` : ''}`
        : `HTTP ${status}${bodyReason ? ` — ${bodyReason}` : ''}`;

    endpoints.push({
      name: t.name,
      url: t.url,
      httpStatus: status,
      ok,
      scheme,
      tls: scheme === 'https',
      redirects,
      finalUrl,
      latencyMs,
      securityHeaders: headers,
      ...(reportedStatus ? { reportedStatus } : {}),
      result: ok ? 'PASS' : 'FINDING',
      reason,
    });

    if (!ok) {
      findings.push(
        finding(
          `endpoints.${t.name}-down`,
          t.critical ? 'CRITICAL' : 'HIGH',
          'health',
          `${t.name} (${t.url}) returned ${status ?? 'no response'}${bodyReason ? ` — ${bodyReason}` : ''}.`,
          {
            detail: reason,
            remediation:
              bodyReason === 'db_unavailable'
                ? 'The API is reachable but reports its database as unavailable — investigate the database/container, not the audit.'
                : 'Confirm the service is running and reachable from the public internet.',
          },
        ),
      );
    }
  }

  if (opts.out) {
    writeJsonFile(opts.out, stampArtifact('flowvid.endpoint-audit/v1', { endpoints, findings }, { runId: opts.runId, gitSha: opts.gitSha }));
  }
  const okCount = endpoints.filter((x) => x.ok).length;
  ctx.log(`endpoint-audit: ${okCount}/${endpoints.length} ok`);
  // Name every non-ok endpoint on its own line: "2/3 ok" alone cost a manual investigation.
  for (const ep of endpoints.filter((x) => !x.ok)) ctx.log(`  ${ep.name}: ${ep.reason} (${ep.url})`);
  return { findings, endpoints, exitCode: hasCritical(findings) ? 1 : 0 };
}

// ─── Playwright JSON-report summary ──────────────────────────────────────────────

interface PwSpec {
  ok: boolean;
  title: string;
  tests?: Array<{ status?: string; results?: Array<{ status?: string }> }>;
}
interface PwSuite {
  title?: string;
  specs?: PwSpec[];
  suites?: PwSuite[];
}

export interface PlaywrightSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  failures: string[];
  /** Full titles of specs that passed — what `--require-tests` matches against. */
  passedTitles: string[];
  /** Full titles of specs every result of which was `skipped`. */
  skippedTitles: string[];
}

export function summarizePlaywrightReport(json: string): PlaywrightSummary {
  const report = JSON.parse(json) as { suites?: PwSuite[] };
  const summary: PlaywrightSummary = { total: 0, passed: 0, failed: 0, skipped: 0, failures: [], passedTitles: [], skippedTitles: [] };
  const walk = (suite: PwSuite, path: string) => {
    for (const spec of suite.specs ?? []) {
      summary.total += 1;
      const title = `${path}${spec.title}`;
      const statuses = (spec.tests ?? []).flatMap((t) => (t.results ?? []).map((r) => r.status ?? t.status ?? 'unknown'));
      const skipped = statuses.length > 0 && statuses.every((s) => s === 'skipped');
      if (skipped) {
        summary.skipped += 1;
        // Recorded by TITLE, not just counted. A count answers "how many did not run"; only the
        // titles answer "was the release-blocking one among them", which is the question the gate
        // actually needs and could not previously ask.
        summary.skippedTitles.push(title);
      } else if (spec.ok) {
        summary.passed += 1;
        summary.passedTitles.push(title);
      } else {
        summary.failed += 1;
        summary.failures.push(title);
      }
    }
    for (const child of suite.suites ?? []) walk(child, `${path}${suite.title ? `${suite.title} › ` : ''}`);
  };
  for (const s of report.suites ?? []) walk(s, '');
  return summary;
}

export const PLAYWRIGHT_SUMMARY_SCHEMA = 'flowvid.playwright-summary/v1';

/** The on-disk playwright-summary.json: counts plus the identity that binds it to this run. */
export interface PlaywrightSummaryArtifact extends PlaywrightSummary {
  schema: string;
  runId?: string;
  gitSha?: string;
  createdAt: string;
  findings: Finding[];
}

/**
 * Resolve an evidence path that a workflow passed us.
 *
 * `pnpm --filter ops-release release-cli …` runs with cwd = ops/release, so a caller
 * writing `--report client-web/e2e-results/results.json` (the natural repo-relative
 * spelling, and what all three workflows used) resolved to
 * `ops/release/client-web/e2e-results/results.json` → ENOENT. Combined with the old
 * `|| true` and the gate's `if (!existsSync(file)) continue`, a browser suite that never
 * ran was indistinguishable from one that passed. That is the v0.1.5 shape of failure.
 *
 * `ctx.appRoot` is derived from `import.meta.url`, not cwd, so anchoring here makes the
 * resolution independent of who invoked the CLI and from where. Absolute paths are
 * returned untouched so callers can keep passing `$ART/...`.
 */
export function resolveEvidencePath(ctx: CommandContext, p: string): string {
  return isAbsolute(p) ? p : resolve(ctx.appRoot, p);
}

export function cmdPlaywrightSummary(
  ctx: CommandContext,
  opts: { reportFile: string; out?: string; runId?: string; gitSha?: string; requireTests?: readonly string[] },
): { summary: PlaywrightSummary; findings: Finding[]; exitCode: number } {
  const reportFile = resolveEvidencePath(ctx, opts.reportFile);
  // FAIL CLOSED. A missing Playwright report is not a summary of "0 failures" — it means
  // browser verification produced no machine-readable result. Fabricating a clean summary
  // here is exactly how an audit reports green for a suite that never executed.
  if (!existsSync(reportFile)) {
    throw new Error(
      `Playwright JSON report not found at ${reportFile} — browser verification produced no machine-readable ` +
        `result. Refusing to summarize (fail closed); the gate will block on the absent evidence.`,
    );
  }
  const raw = readFileSync(reportFile, 'utf8');

  // REFUSE AN ERROR PLACEHOLDER. A failed collector writes `{auditError: true}` at its
  // artifact path so downstream steps do not die on ENOENT. If that path is the Playwright
  // report, the placeholder parses as a valid report with no suites — i.e. zero tests, zero
  // failures — and would be written out as a CLEAN, correctly run-stamped summary that the
  // gate happily passes. That launders an audit error into positive evidence and defeats
  // this entire module. Caught by adversarial review of this branch, reproduced end to end.
  let parsed: { auditError?: unknown; suites?: unknown };
  try {
    parsed = JSON.parse(raw) as { auditError?: unknown; suites?: unknown };
  } catch {
    throw new Error(`Playwright report at ${reportFile} is not valid JSON — refusing to summarize (fail closed).`);
  }
  if (parsed.auditError === true) {
    throw new Error(
      `Playwright report at ${reportFile} is an audit-error placeholder, not a test report — browser ` +
        `verification did not run. Refusing to summarize (fail closed).`,
    );
  }

  const summary = summarizePlaywrightReport(raw);

  // A production audit that executed ZERO tests has verified nothing. Silence here is the
  // same failure as a missing file, so it is a CRITICAL finding rather than "0 failures".
  if (summary.total === 0) {
    throw new Error(
      `Playwright report at ${reportFile} contains no tests — browser verification produced no ` +
        `result to summarize. Refusing to report this as a clean run (fail closed).`,
    );
  }

  const findings: Finding[] =
    summary.failed > 0
      ? [
          finding('playwright.failures', 'CRITICAL', 'browser', `${summary.failed} production browser test(s) failed.`, {
            detail: summary.failures.slice(0, 10).join('; '),
          }),
        ]
      : [];

  // A RELEASE-BLOCKING FLOW THAT DID NOT RUN IS NOT A FLOW THAT PASSED.
  //
  // `test.skip(!process.env.SMOKE_PUBLIC_PATH, …)` is the idiom throughout the production audit,
  // and it is the right idiom — a suite should not fail because a reviewer ran it locally without
  // fixtures. But in CI it meant an unset repository variable silently removed a check: the audit
  // for project pages, playlists, or admin would report `skipped`, the summary counted it, no
  // finding was raised, the gate passed, and the release deployed having verified nothing about
  // the flow. Nothing anywhere went red. That is the same shape as the v0.1.5 missing-report
  // failure this module already guards, arriving through a different door.
  //
  // So the caller names the flows that must have ACTUALLY EXECUTED. Missing and skipped are the
  // same verdict — neither produced evidence — and both are CRITICAL.
  for (const required of opts.requireTests ?? []) {
    const ran = summary.passedTitles.some((t) => t.includes(required));
    if (ran) continue;
    const wasSkipped = summary.skippedTitles.some((t) => t.includes(required));
    const wasFailure = summary.failures.some((t) => t.includes(required));
    if (wasFailure) continue; // already CRITICAL above; do not double-report the same flow
    findings.push(
      finding(
        wasSkipped ? 'playwright.required-skipped' : 'playwright.required-missing',
        'CRITICAL',
        'browser',
        wasSkipped
          ? `Release-blocking flow "${required}" was SKIPPED — it produced no evidence, so it cannot be scored as a pass.`
          : `Release-blocking flow "${required}" is absent from the report — it never ran.`,
        { detail: wasSkipped ? 'Usually an unset SMOKE_* repository variable or secret.' : undefined },
      ),
    );
  }
  if (opts.out) {
    const artifact = stampArtifact(PLAYWRIGHT_SUMMARY_SCHEMA, { ...summary, findings }, { runId: opts.runId, gitSha: opts.gitSha });
    writeJsonFile(opts.out, artifact satisfies PlaywrightSummaryArtifact);
  }
  ctx.log(`playwright: ${summary.passed}/${summary.total} passed, ${summary.failed} failed, ${summary.skipped} skipped`);
  return { summary, findings, exitCode: findings.some((f) => f.severity === 'CRITICAL') ? 1 : 0 };
}

// ─── gate ────────────────────────────────────────────────────────────────────────

export function collectFindingsFromFiles(files: string[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    const doc = readJson<Record<string, unknown>>(file);
    const arr = (doc.findings ?? []) as Finding[];
    if (Array.isArray(arr)) findings.push(...arr);
  }
  return findings;
}

export function cmdGate(
  ctx: CommandContext,
  opts: {
    findingsFiles: string[];
    phase: Phase;
    policy?: GatePolicy;
    /** Files that MUST exist and be current for the gate to pass (missing ⇒ CRITICAL). */
    requiredFiles?: string[];
    /** Basenames within requiredFiles that MUST carry a matching run identity. */
    identityBearing?: readonly string[];
    /** The run/commit the required evidence must belong to. */
    expect?: EvidenceExpectation;
    out?: string;
  },
): { decision: GateDecision; findings: Finding[]; exitCode: number } {
  // Resolve BOTH lists identically: the same path string must not mean two different
  // files depending on which flag carried it.
  const collected = collectFindingsFromFiles(opts.findingsFiles.map((f) => resolveEvidencePath(ctx, f)));
  // Required-evidence findings are appended, not substituted: a run can simultaneously
  // have a real production finding AND be missing an artifact, and the report must show
  // both rather than letting one mask the other.
  const evidence = checkRequiredEvidence(
    (opts.requiredFiles ?? []).map((f) => resolveEvidencePath(ctx, f)),
    opts.expect ?? {},
    { identityBearing: opts.identityBearing ?? [] },
  );
  const findings = [...collected, ...evidence];
  const decision = evaluateGate(findings, opts.phase, opts.policy ?? {});
  if (opts.out) writeJsonFile(opts.out, { decision, findings });
  setOutput('gate_blocked', String(decision.blocked));
  setOutput('gate_rollback', String(decision.shouldRollback));
  ctx.log(
    `gate(${opts.phase}): ${decision.blocked ? 'BLOCKED' : 'pass'} — ${decision.counts.CRITICAL}C/${decision.counts.HIGH}H/${decision.counts.WARNING}W`,
  );
  return { decision, findings, exitCode: decision.blocked ? 1 : 0 };
}

// ─── collector bookkeeping + audit verdict ───────────────────────────────────────

/**
 * Record one collector's outcome, and guarantee its artifact exists.
 *
 * This replaces `|| true`. Suppressing an exit code is legitimate — the audit should keep
 * gathering evidence after one collector dies — but the old form ALSO erased the status,
 * so a crashed step and a clean step were indistinguishable downstream. Here the exit code
 * is preserved in a durable record and the step is still allowed to continue.
 *
 * When an ERROR collector left no artifact, a placeholder is written so later steps read
 * JSON rather than dying on ENOENT (the failure cascade seen in run 31199562890, where a
 * dead Playwright produced no results.json, which killed playwright-summary, which killed
 * browser-audit). The placeholder is explicitly marked `auditError` so it can never be
 * read as a clean result.
 */
export function cmdCollectorRecord(
  ctx: CommandContext,
  opts: {
    name: string;
    command: string;
    startedAt: string;
    endedAt: string;
    exitCode: number | null;
    artifact?: string;
    /**
     * Artifact used ONLY to classify the outcome — never written to.
     *
     * Needed for collectors whose evidence file is consumed by a typed parser. Writing an
     * error placeholder over the Playwright report let it be re-read as a valid empty
     * report and laundered into clean evidence; but dropping artifact detection entirely
     * made a genuine production test failure classify as ERROR instead of FINDING, which
     * is the same conflation in the opposite direction (observed in audit run 31241926542,
     * where two specs failed on a real production 5xx and the run reported "the auditor is
     * broken"). Probing gives accurate classification with no placeholder.
     */
    probeArtifact?: string;
    status?: CollectorStatus;
    reason?: string;
    log: string;
    runId?: string;
    gitSha?: string;
  },
): { record: CollectorRecord; exitCode: number } {
  const artifactPath = opts.artifact ? resolveEvidencePath(ctx, opts.artifact) : undefined;
  const probePath = opts.probeArtifact ? resolveEvidencePath(ctx, opts.probeArtifact) : undefined;
  const classifyPath = artifactPath ?? probePath;
  const producedArtifact = classifyPath !== undefined && existsSync(classifyPath);

  // Read the artifact's own findings rather than trusting the exit code alone. Several
  // collectors exit 0 while reporting HIGH findings (only CRITICAL sets exit 1), so an
  // exit-code-only rule logged a real production finding as "PASS — completed with no
  // findings". An unreadable artifact is left to statusFromExit, which treats it as ERROR.
  let artifactFindings = 0;
  let artifactIsPlaceholder = false;
  if (producedArtifact) {
    try {
      const doc = readJson<{ findings?: unknown[]; auditError?: unknown }>(classifyPath!);
      artifactFindings = Array.isArray(doc.findings) ? doc.findings.length : 0;
      artifactIsPlaceholder = doc.auditError === true;
    } catch {
      artifactIsPlaceholder = true; // corrupt artifact is not evidence of health
    }
  }

  const status =
    opts.status ??
    (artifactIsPlaceholder
      ? 'ERROR'
      : artifactFindings > 0 && opts.exitCode !== null && opts.exitCode <= 1
        ? 'FINDING'
        : statusFromExit(opts.exitCode, { producedArtifact }));

  const reason =
    opts.reason ??
    (status === 'PASS'
      ? 'completed with no findings'
      : status === 'FINDING'
        ? `completed and reported ${artifactFindings || 'one or more'} finding(s)`
        : status === 'NOT_CONFIGURED'
          ? 'not attempted — required inputs absent'
          : `exited ${opts.exitCode ?? 'without running'}${producedArtifact ? '' : ' and produced no artifact'}`);

  const record: CollectorRecord = {
    name: opts.name,
    command: redactValue(opts.command),
    startedAt: opts.startedAt,
    endedAt: opts.endedAt,
    exitCode: opts.exitCode,
    status,
    reason,
    ...(opts.artifact ?? opts.probeArtifact ? { artifact: opts.artifact ?? opts.probeArtifact } : {}),
  };

  if (status === 'ERROR' && artifactPath && !producedArtifact) {
    writeJsonFile(artifactPath, {
      schema: 'flowvid.audit-error/v1',
      auditError: true,
      collector: opts.name,
      reason,
      createdAt: new Date().toISOString(),
      // Deliberately empty: an audit error is not a statement about production, and must
      // not inject a production finding. The collector log carries the error instead.
      findings: [],
    });
  }

  const logPath = resolveEvidencePath(ctx, opts.log);
  const existing: CollectorLog | null = existsSync(logPath) ? readJson<CollectorLog>(logPath) : null;
  const log: CollectorLog = {
    schema: COLLECTOR_LOG_SCHEMA,
    ...(opts.runId ? { runId: opts.runId } : {}),
    ...(opts.gitSha ? { gitSha: opts.gitSha } : {}),
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    collectors: [...(existing?.collectors ?? []).filter((c) => c.name !== opts.name), record],
  };
  writeJsonFile(logPath, log);

  ctx.log(`collector ${opts.name}: ${status} — ${reason}`);
  // Always 0: recording an outcome is bookkeeping and must not itself fail the step.
  // The verdict command is what turns recorded ERRORs into a red run.
  return { record, exitCode: 0 };
}

/**
 * Which production surfaces this audit is configured to exercise.
 *
 * The previous run reported a verdict without saying that the playlist, admin login and
 * admin simulation surfaces were never visited — their inputs were empty. A verdict that
 * does not state its own coverage lets "green" be read as "all of production is healthy"
 * when three surfaces were skipped entirely.
 *
 * REQUIRED-but-absent is an audit ERROR (we promised to test it and did not).
 * OPTIONAL-but-absent is NOT_CONFIGURED (honest, declared, reduced coverage).
 */
export const AUDIT_SURFACES: ReadonlyArray<{ surface: string; requires: readonly string[]; required: boolean }> = [
  { surface: 'Public homepage', requires: ['SMOKE_BASE_URL'], required: true },
  { surface: 'Public project', requires: ['SMOKE_PUBLIC_PATH'], required: false },
  { surface: 'Playlist', requires: ['SMOKE_PLAYLIST_PATH'], required: false },
  { surface: 'Admin login', requires: ['SMOKE_ADMIN_URL', 'SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'], required: false },
  { surface: 'Admin simulation', requires: ['SMOKE_ADMIN_PREVIEW_PATH', 'SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'], required: false },
];

export function cmdCoverageReport(
  ctx: CommandContext,
  opts: { out?: string; env?: NodeJS.ProcessEnv },
): { coverage: CoverageEntry[]; exitCode: number } {
  const env = opts.env ?? process.env;
  const coverage: CoverageEntry[] = AUDIT_SURFACES.map(({ surface, requires, required }) => {
    const missing = requires.filter((k) => !env[k]);
    if (missing.length === 0) return { surface, status: 'TESTED', requires };
    return {
      surface,
      status: required ? 'ERROR' : 'NOT_CONFIGURED',
      requires,
      reason: `missing input(s): ${missing.join(', ')}`,
    };
  });
  if (opts.out) writeJsonFile(opts.out, stampArtifact('flowvid.audit-coverage/v1', { coverage }, {}));
  for (const c of coverage) ctx.log(`coverage ${c.surface}: ${c.status}${c.reason ? ` (${c.reason})` : ''}`);
  // Never fails the step: coverage is a fact to report, and a required-input gap is
  // surfaced as an ERROR entry that the verdict command turns into BLOCKED_BY_AUDIT_ERROR.
  return { coverage, exitCode: 0 };
}

export interface AuditVerdictArtifact {
  schema: 'flowvid.audit-verdict/v1';
  verdict: string;
  reasons: string[];
  productionFindings: Finding[];
  auditErrors: string[];
  coverage: CoverageEntry[];
  createdAt: string;
}

/**
 * Turn the collector log + gate decision into ONE explicit final state.
 *
 * PASS / BLOCKED_BY_FINDINGS / BLOCKED_BY_AUDIT_ERROR are reported separately because
 * they demand different responses: page the on-call for the first kind, fix the pipeline
 * for the second. `AUDIT_FAILED` told an operator neither.
 */
export function cmdAuditVerdict(
  ctx: CommandContext,
  opts: { log: string; gate?: string; coverage?: string; out?: string },
): { verdict: string; exitCode: number } {
  const logPath = resolveEvidencePath(ctx, opts.log);
  const log: CollectorLog = existsSync(logPath)
    ? readJson<CollectorLog>(logPath)
    : { schema: COLLECTOR_LOG_SCHEMA, createdAt: new Date().toISOString(), collectors: [] };

  const gatePath = opts.gate ? resolveEvidencePath(ctx, opts.gate) : undefined;
  const gateDoc = gatePath && existsSync(gatePath) ? readJson<{ decision?: GateDecision; findings?: Finding[] }>(gatePath) : undefined;

  const coveragePath = opts.coverage ? resolveEvidencePath(ctx, opts.coverage) : undefined;
  const coverage: CoverageEntry[] =
    coveragePath && existsSync(coveragePath) ? (readJson<{ coverage?: CoverageEntry[] }>(coveragePath).coverage ?? []) : [];

  // A gate artifact that is missing when collectors all succeeded is itself an audit
  // error: the verdict cannot be derived from evidence that was never written.
  const collectors = [...log.collectors];
  if (opts.gate && !gateDoc && !collectors.some((c) => c.status === 'ERROR')) {
    collectors.push({
      name: 'gate',
      command: 'release-cli gate',
      startedAt: log.createdAt,
      endedAt: new Date().toISOString(),
      exitCode: null,
      status: 'ERROR',
      reason: 'the gate produced no decision artifact',
    });
  }

  // A REQUIRED surface with no inputs is an audit error, not merely reduced coverage:
  // the run claimed it would test that surface and never did.
  for (const c of coverage.filter((e) => e.status === 'ERROR')) {
    collectors.push({
      name: `coverage:${c.surface}`,
      command: 'release-cli coverage-report',
      startedAt: log.createdAt,
      endedAt: new Date().toISOString(),
      exitCode: null,
      status: 'ERROR',
      reason: c.reason ?? 'required surface was not configured',
    });
  }

  const outcome = deriveVerdict({ collectors, gate: gateDoc?.decision, findings: gateDoc?.findings ?? [] });
  const artifact: AuditVerdictArtifact = {
    schema: 'flowvid.audit-verdict/v1',
    verdict: outcome.verdict,
    reasons: outcome.reasons,
    productionFindings: sortFindings((gateDoc?.findings ?? []).filter((f) => f.area !== 'evidence')),
    auditErrors: outcome.erroredCollectors,
    coverage,
    createdAt: new Date().toISOString(),
  };
  if (opts.out) writeJsonFile(opts.out, artifact);

  setOutput('audit_verdict', outcome.verdict);
  ctx.log(`audit-verdict: ${outcome.verdict}`);
  for (const r of outcome.reasons) ctx.log(`  - ${r}`);
  return { verdict: outcome.verdict, exitCode: outcome.verdict === 'PASS' ? 0 : 1 };
}

// ─── state ───────────────────────────────────────────────────────────────────────

export function cmdStateInit(ctx: CommandContext, opts: { file: string; runId: string; version?: string; gitSha?: string; bump?: string }): void {
  const run = createRun(opts.runId, new Date().toISOString(), {
    ...(opts.version ? { version: opts.version } : {}),
    ...(opts.gitSha ? { gitSha: opts.gitSha } : {}),
    ...(opts.bump ? { requestedBump: opts.bump } : {}),
  });
  mkdirSync(dirname(opts.file), { recursive: true });
  writeFileSync(opts.file, serializeRun(run));
  ctx.log(`state: initialized ${opts.runId} at PLANNED`);
}

export function cmdStateTransition(ctx: CommandContext, opts: { file: string; to: ReleaseState; note?: string }): void {
  const run = parseRun(readFileSync(opts.file, 'utf8'));
  const next = transition(run, opts.to, new Date().toISOString(), opts.note);
  writeFileSync(opts.file, serializeRun(next));
  ctx.log(`state: ${run.state} -> ${opts.to}`);
}

// ─── report assembly ─────────────────────────────────────────────────────────────

export interface ReportMeta {
  runId: string;
  /** release (default) walks the state machine; audit/rollback derive an explicit verdict. */
  kind?: 'release' | 'audit' | 'rollback';
  version?: string;
  previousVersion?: string;
  gitSha?: string;
  bump?: string;
  deploy?: boolean;
  backfillPolicy?: string;
  startedAt?: string;
  endedAt?: string;
  actor?: string;
  workflowUrl?: string;
}

/** Known artifact filenames inside the artifacts dir (all optional). */
const ARTIFACTS = {
  plan: 'plan.json',
  state: 'state.json',
  preflight: 'preflight.json',
  secretScan: 'secret-scan.json',
  migrationAudit: 'migration-audit.json',
  imageManifest: 'image-manifest.json',
  cspClient: 'csp-client-web.json',
  cspAdmin: 'csp-admin-web.json',
  vmAudit: 'vm-audit.json',
  vmFindings: 'vm-findings.json',
  dbUrlAudit: 'db-url-audit.json',
  browserAudit: 'browser-audit.json',
  browserFindings: 'browser-findings.json',
  playwright: 'playwright-summary.json',
  endpoints: 'endpoints.json',
  gate: 'gate.json',
  stages: 'stages.json',
  tests: 'tests.json',
  rollback: 'rollback.json',
  failing: 'failing.json',
} as const;

export function cmdReport(
  ctx: CommandContext,
  opts: { dir: string; meta: ReportMeta; outJson: string; outMd: string },
): { report: ReleaseReport } {
  const read = <T>(name: string): T | undefined => {
    const p = join(opts.dir, name);
    return existsSync(p) ? readJson<T>(p) : undefined;
  };

  const plan = read<PlanArtifact>(ARTIFACTS.plan);
  const stateDoc = read<{ state?: ReleaseState; history?: Array<{ state: string; at: string }> }>(ARTIFACTS.state);
  const gateDoc = read<{ decision: GateDecision }>(ARTIFACTS.gate);
  const manifestDoc = read<{ manifest?: ImageManifest } | ImageManifest>(ARTIFACTS.imageManifest);
  const manifest = manifestDoc && 'images' in manifestDoc ? manifestDoc : (manifestDoc as { manifest?: ImageManifest } | undefined)?.manifest;
  const migration = read<MigrationAuditResult>(ARTIFACTS.migrationAudit);
  const vmDoc = read<{ vm?: VmAudit }>(ARTIFACTS.vmFindings) ?? { vm: read<VmAudit>(ARTIFACTS.vmAudit) };
  const dbAudit = read<Record<string, unknown>>(ARTIFACTS.dbUrlAudit);
  // An audit-error placeholder has no counts; treat it as absent so the report still
  // renders (the collector log is what records that the collector failed).
  const playwrightRaw = read<PlaywrightSummary & { auditError?: unknown }>(ARTIFACTS.playwright);
  const playwright = playwrightRaw && playwrightRaw.auditError === true ? undefined : playwrightRaw;
  const endpointsDoc = read<{ endpoints: EndpointStatus[] }>(ARTIFACTS.endpoints);
  // Audit sections: verdict, infrastructure errors and coverage are read from the
  // artifacts the audit workflow writes, so the rendered summary can separate
  // "production is broken" from "the auditor is broken".
  const verdictDoc = read<{ verdict?: string; reasons?: string[]; auditErrors?: string[] }>('audit-verdict.json');
  const collectorLog = read<CollectorLog>('collectors.json');
  const coverageDoc = read<{ coverage?: CoverageEntry[] }>('coverage.json');
  const auditSections =
    verdictDoc || collectorLog || coverageDoc
      ? {
          ...(verdictDoc?.verdict ? { verdict: verdictDoc.verdict } : {}),
          ...(verdictDoc?.reasons ? { verdictReasons: verdictDoc.reasons } : {}),
          auditErrors: (collectorLog?.collectors ?? [])
            .filter((c) => c.status === 'ERROR')
            .map((c) => ({ name: c.name, reason: c.reason })),
          ...(coverageDoc?.coverage ? { coverage: coverageDoc.coverage } : {}),
        }
      : undefined;
  // Stage timings: explicit stages.json wins; otherwise derive durations from the
  // persisted state-machine history (time between consecutive transitions).
  let stages = read<StageTiming[]>(ARTIFACTS.stages) ?? [];
  if (stages.length === 0 && stateDoc?.history && stateDoc.history.length > 1) {
    stages = stateDoc.history.slice(1).map((event, i) => {
      const prev = stateDoc.history![i];
      const duration = Date.parse(event.at) - Date.parse(prev.at);
      return {
        stage: `${prev.state} → ${event.state}`,
        status: event.state === 'FAILED' ? ('failure' as const) : ('success' as const),
        startedAt: prev.at,
        endedAt: event.at,
        ...(Number.isFinite(duration) ? { durationMs: duration } : {}),
      };
    });
  }
  const tests = read<ReleaseReport['tests']>(ARTIFACTS.tests);
  const rollback = read<ReleaseReport['rollback']>(ARTIFACTS.rollback);
  let failing = read<ReleaseReport['failing']>(ARTIFACTS.failing);

  // gate.json embeds the findings it merged from the other artifacts — exclude it
  // here or every gated finding would appear twice in the report.
  const findings = collectFindingsFromFiles(
    Object.values(ARTIFACTS)
      .filter((n) => n !== ARTIFACTS.gate)
      .map((n) => join(opts.dir, n)),
  );

  // Derive "first failure" when no explicit failing.json was recorded.
  if (!failing) {
    if (playwright && playwright.failures.length > 0) failing = { test: playwright.failures[0] };
    else {
      const firstBlocking = findings.find((f) => f.severity === 'CRITICAL') ?? findings.find((f) => f.severity === 'HIGH');
      if (firstBlocking && gateDoc?.decision.blocked) failing = { command: firstBlocking.id };
    }
  }

  const cspSection: Record<string, unknown> = {};
  for (const [key, file] of [['client-web', ARTIFACTS.cspClient], ['admin-web', ARTIFACTS.cspAdmin]] as const) {
    const doc = read<Record<string, unknown>>(file);
    if (doc) cspSection[key] = { url: doc.url, status: doc.status, header: doc.header };
  }

  // ── Final state ──────────────────────────────────────────────────────────────
  // Releases: the persisted state machine is authoritative. Audits/rollbacks have
  // no deployment state machine — they get an EXPLICIT verdict from the gate
  // instead of pretending a deployment occurred (and never report UNKNOWN when a
  // gate decision exists). run 29528323804 regression: audits said "UNKNOWN".
  const kind = opts.meta.kind ?? 'release';
  let state: ReleaseReport['state'];
  if (kind === 'audit') {
    state = gateDoc ? (gateDoc.decision.blocked ? 'AUDIT_FAILED' : 'AUDIT_PASSED') : 'UNKNOWN';
  } else if (kind === 'rollback') {
    state = gateDoc ? (gateDoc.decision.blocked ? 'FAILED' : 'ROLLED_BACK') : 'UNKNOWN';
  } else {
    state = stateDoc?.state ?? 'UNKNOWN';
  }

  const vm = vmDoc?.vm ?? undefined;
  const report = buildReport({
    ...(auditSections ? { audit: auditSections } : {}),
    kind,
    runId: opts.meta.runId,
    workflow: {
      ...(opts.meta.actor ? { actor: opts.meta.actor } : {}),
      ...(opts.meta.workflowUrl ? { runUrl: opts.meta.workflowUrl } : {}),
    },
    requested: {
      ...(opts.meta.bump ? { bump: opts.meta.bump } : {}),
      ...(opts.meta.deploy !== undefined ? { deploy: opts.meta.deploy } : {}),
      ...(opts.meta.backfillPolicy ? { backfillPolicy: opts.meta.backfillPolicy } : {}),
    },
    version: opts.meta.version ?? plan?.nextTag,
    previousVersion: opts.meta.previousVersion ?? plan?.currentTag ?? undefined,
    gitSha: opts.meta.gitSha ?? plan?.gitSha,
    startedAt: opts.meta.startedAt,
    endedAt: opts.meta.endedAt,
    state,
    stages,
    tests,
    images: manifest?.images,
    migrationPlan: migration ? { summary: migration.summary, newMigrations: migration.newMigrations } : undefined,
    databaseUrlAudit: dbAudit,
    deployment: vm
      ? { serviceHealth: vm.containers, endpoints: endpointsDoc?.endpoints }
      : endpointsDoc
        ? { endpoints: endpointsDoc.endpoints }
        : undefined,
    playwright,
    csp: Object.keys(cspSection).length > 0 ? cspSection : undefined,
    findings,
    gate: gateDoc?.decision,
    rollback,
    failing,
    remediation: [...new Set(findings.map((f) => f.remediation).filter((r): r is string => !!r))],
  });

  writeJsonFile(opts.outJson, report);
  mkdirSync(dirname(opts.outMd), { recursive: true });
  writeFileSync(opts.outMd, renderMarkdown(report));
  ctx.log(`report: ${opts.outJson} + ${opts.outMd} (${findings.length} finding(s), state=${report.state})`);
  return { report };
}

// ─── release risk → who must approve ─────────────────────────────────────────────

/**
 * Decide whether this release still needs a person, from evidence already on disk.
 *
 * Writes the verdict as an artifact AND to `$GITHUB_OUTPUT` when running under Actions, so the
 * workflow can gate a job on it. Exit code is always 0: "a human is required" is a routing
 * decision, not a failure, and failing here would block the very releases that most need to
 * reach a reviewer.
 */
export function cmdReleaseRisk(
  ctx: CommandContext,
  opts: {
    findingsFiles: string[];
    backfillPolicy: BackfillPolicy;
    approveHigh: boolean;
    changedPathsFile?: string;
    /**
     * Where the changed-paths window was measured from. DEFAULTS TO 'unresolved' — i.e. to
     * requiring a human — so a caller that never learned about this flag gets the safe verdict,
     * not the trusting one. Only the workflow step that actually anchored the window to
     * `refs/deployed/production` may pass 'deployed-ref'.
     */
    diffBase?: DiffBaseKind;
    out?: string;
  },
): { verdict: ReleaseRiskVerdict; exitCode: number } {
  // FAIL CLOSED ON UNREADABLE EVIDENCE. `collectFindingsFromFiles` skips files that do not
  // exist, which is right for an optional audit and wrong here: "no findings" and "the findings
  // could not be read" are the same value and opposite meanings. A verdict computed from
  // evidence that was never read is exactly the reflexive approval this replaces.
  const missing = opts.findingsFiles.filter((f) => !existsSync(resolveEvidencePath(ctx, f)));
  if (missing.length > 0) {
    const verdict: ReleaseRiskVerdict = {
      schema: RELEASE_RISK_SCHEMA,
      requiresHuman: true,
      reasons: [`audit evidence could not be read: ${missing.join(', ')} — defaulting to human approval.`],
    };
    if (opts.out) writeJsonFile(opts.out, verdict);
    emitRiskOutput(ctx, verdict);
    return { verdict, exitCode: 0 };
  }

  let diffBase: DiffBaseKind = opts.diffBase ?? 'unresolved';
  let changedPaths: string[] = [];
  if (opts.changedPathsFile && existsSync(resolveEvidencePath(ctx, opts.changedPathsFile))) {
    changedPaths = readFileSync(resolveEvidencePath(ctx, opts.changedPathsFile), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  } else if (diffBase === 'deployed-ref') {
    // Contradictory evidence: the caller claims the window was anchored, but the file holding it
    // does not exist. The previous shape of this bug was quieter — release.yml's `|| true` wrote
    // an EMPTY file on a failed diff, and its comment claimed release-risk would fail closed on
    // it, which it did not: the empty file read as "nothing changed". An empty file is still
    // legitimate when the base genuinely equals HEAD; a MISSING file under a 'deployed-ref'
    // claim never is, so the claim is downgraded and check 0 fires.
    diffBase = 'unresolved';
  }

  const verdict = assessReleaseRisk({
    findings: collectFindingsFromFiles(opts.findingsFiles.map((f) => resolveEvidencePath(ctx, f))),
    backfillPolicy: opts.backfillPolicy,
    approveHigh: opts.approveHigh,
    changedPaths,
    diffBase,
  });
  if (opts.out) writeJsonFile(opts.out, verdict);
  emitRiskOutput(ctx, verdict);
  ctx.log(
    verdict.requiresHuman
      ? `release-risk: HUMAN APPROVAL REQUIRED — ${verdict.reasons.length} reason(s):\n  - ${verdict.reasons.join('\n  - ')}`
      : 'release-risk: routine — no reason for a human to be in this path.',
  );
  return { verdict, exitCode: 0 };
}

function emitRiskOutput(ctx: CommandContext, verdict: ReleaseRiskVerdict): void {
  // `setOutput`, not a second appendFileSync: it redacts, handles multiline values through
  // heredoc delimiters, and falls back to stdout locally. A parallel writer here would be one
  // more place for a secret to reach a log, in the module whose whole job is trustworthiness.
  setOutput('requires_human', verdict.requiresHuman ? 'true' : 'false');
  setOutput('risk_reasons', verdict.reasons.join('\n'));
  ctx.log(`release-risk: requires_human=${verdict.requiresHuman}`);
}
