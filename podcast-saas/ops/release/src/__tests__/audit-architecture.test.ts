/**
 * The audit result model, under injected failure.
 *
 * Each test names a failure the production audit must survive while still telling the
 * truth about WHICH kind of failure it was. The reference incident is run 31199562890:
 * Playwright died during collection, so no browser evidence existed at all, and the run
 * still reported `BLOCKED — 1C/0H/0W` / `AUDIT_FAILED` — the same shape a healthy audit
 * produces when it finds one real defect.
 */
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deriveVerdict, requiredInputStatus, statusFromExit, type CollectorRecord } from '../audit-result.js';
import { cmdAuditVerdict, cmdCollectorRecord, cmdCoverageReport, cmdEndpointAudit, defaultContext, type CommandContext } from '../commands.js';
import { diagnoseRemoteFailure } from '../remote-diagnosis.js';

let tmp: string;
const logs: string[] = [];
const ctx = (): CommandContext => ({ ...defaultContext(), appRoot: tmp, log: (m) => logs.push(m) });

const rec = (over: Partial<CollectorRecord>): CollectorRecord => ({
  name: 'c',
  command: 'x',
  startedAt: '2026-01-01T00:00:00Z',
  endedAt: '2026-01-01T00:00:01Z',
  exitCode: 0,
  status: 'PASS',
  reason: 'ok',
  ...over,
});

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'audit-arch-'));
  logs.length = 0;
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('status classification', () => {
  it('exit 0 is PASS', () => expect(statusFromExit(0, { producedArtifact: true })).toBe('PASS'));

  it('exit 1 WITH an artifact is a FINDING — the collector ran and reported', () => {
    expect(statusFromExit(1, { producedArtifact: true })).toBe('FINDING');
  });

  it('exit 1 WITHOUT an artifact is an ERROR, not a finding', () => {
    // This is the distinction the old `|| true` destroyed: a crashed collector produced
    // no artifact, and was indistinguishable from one that ran and found nothing.
    expect(statusFromExit(1, { producedArtifact: false })).toBe('ERROR');
  });

  it('a crash code or an unrun collector is ERROR, never PASS', () => {
    expect(statusFromExit(2, { producedArtifact: true })).toBe('ERROR');
    expect(statusFromExit(null, { producedArtifact: false })).toBe('ERROR');
  });

  it('required-but-absent input is ERROR; optional-but-absent is NOT_CONFIGURED', () => {
    expect(requiredInputStatus(false, true)).toBe('ERROR');
    expect(requiredInputStatus(false, false)).toBe('NOT_CONFIGURED');
    expect(requiredInputStatus(true, true)).toBe('PASS');
  });
});

describe('final verdict never conflates a broken auditor with broken production', () => {
  it('PASS when everything ran and the gate did not block', () => {
    const v = deriveVerdict({ collectors: [rec({ name: 'a' }), rec({ name: 'b' })], gate: { blocked: false } });
    expect(v.verdict).toBe('PASS');
  });

  it('BLOCKED_BY_FINDINGS when every collector ran but production violates policy', () => {
    const v = deriveVerdict({
      collectors: [rec({ name: 'endpoint-audit', status: 'FINDING', exitCode: 1, reason: 'api-health returned 503' })],
      gate: { blocked: true },
    });
    expect(v.verdict).toBe('BLOCKED_BY_FINDINGS');
    expect(v.reasons.join(' ')).toContain('503');
  });

  it('BLOCKED_BY_AUDIT_ERROR when a collector could not answer — even if the gate is clean', () => {
    // The exact 31199562890 shape: browser evidence missing, gate saw nothing to block on.
    const v = deriveVerdict({
      collectors: [rec({ name: 'browser-tests', status: 'ERROR', exitCode: 1, reason: 'Cannot find module shared/sim/canaryContract' })],
      gate: { blocked: false },
    });
    expect(v.verdict).toBe('BLOCKED_BY_AUDIT_ERROR');
    expect(v.erroredCollectors).toEqual(['browser-tests']);
  });

  it('an audit ERROR outranks a findings block — production state is unknown, so it cannot be reported as a findings verdict', () => {
    const v = deriveVerdict({
      collectors: [rec({ name: 'endpoint-audit', status: 'FINDING' }), rec({ name: 'browser-tests', status: 'ERROR', reason: 'crashed' })],
      gate: { blocked: true },
    });
    expect(v.verdict).toBe('BLOCKED_BY_AUDIT_ERROR');
  });

  it('NOT_CONFIGURED alone never blocks, but is always reported as reduced coverage', () => {
    const v = deriveVerdict({
      collectors: [rec({ name: 'admin-login', status: 'NOT_CONFIGURED', reason: 'no admin credentials' })],
      gate: { blocked: false },
    });
    expect(v.verdict).toBe('PASS');
    expect(v.notConfigured).toEqual(['admin-login']);
    expect(v.reasons.join(' ')).toContain('not tested');
  });
});

describe('collector records replace `|| true`', () => {
  it('preserves the real exit code and writes an error placeholder when the artifact is absent', () => {
    const artifact = join(tmp, 'browser-findings.json');
    const { record } = cmdCollectorRecord(ctx(), {
      name: 'browser-tests',
      command: 'playwright test',
      startedAt: 'a',
      endedAt: 'b',
      exitCode: 1,
      artifact,
      log: join(tmp, 'collectors.json'),
    });
    expect(record.exitCode).toBe(1);
    expect(record.status).toBe('ERROR');

    // The placeholder exists so downstream steps parse JSON instead of dying on ENOENT…
    expect(existsSync(artifact)).toBe(true);
    const doc = JSON.parse(readFileSync(artifact, 'utf8'));
    // …and it injects NO production findings, because an audit error says nothing about production.
    expect(doc.findings).toEqual([]);
    expect(doc.auditError).toBe(true);
  });

  it('does not overwrite an artifact the collector actually produced', () => {
    const artifact = join(tmp, 'endpoints.json');
    writeFileSync(artifact, JSON.stringify({ findings: [{ id: 'endpoints.api-health-down', severity: 'CRITICAL' }] }));
    const { record } = cmdCollectorRecord(ctx(), {
      name: 'endpoint-audit',
      command: 'endpoint-audit',
      startedAt: 'a',
      endedAt: 'b',
      exitCode: 1,
      artifact,
      log: join(tmp, 'collectors.json'),
    });
    expect(record.status).toBe('FINDING');
    expect(JSON.parse(readFileSync(artifact, 'utf8')).findings).toHaveLength(1);
  });

  it('recording never fails the step itself', () => {
    const r = cmdCollectorRecord(ctx(), { name: 'x', command: 'x', startedAt: 'a', endedAt: 'b', exitCode: 137, log: join(tmp, 'c.json') });
    expect(r.exitCode).toBe(0);
    expect(r.record.status).toBe('ERROR');
  });

  it('redacts secrets out of the recorded command', () => {
    const { record } = cmdCollectorRecord(ctx(), {
      name: 'x',
      command: 'curl -H "Authorization: Bearer ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"',
      startedAt: 'a',
      endedAt: 'b',
      exitCode: 0,
      log: join(tmp, 'c.json'),
    });
    expect(record.command).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
  });
});

describe('end-to-end verdict from artifacts', () => {
  const writeLog = (collectors: CollectorRecord[]) =>
    writeFileSync(join(tmp, 'collectors.json'), JSON.stringify({ schema: 'flowvid.collector-log/v1', createdAt: 'now', collectors }));

  it('reproduces run 31199562890 as BLOCKED_BY_AUDIT_ERROR rather than AUDIT_FAILED', () => {
    writeLog([
      rec({ name: 'endpoint-audit', status: 'FINDING', exitCode: 1, reason: 'api-health returned 503 — db_unavailable' }),
      rec({ name: 'remote-audit', status: 'ERROR', exitCode: 1, reason: 'VM audit failed' }),
      rec({ name: 'browser-tests', status: 'ERROR', exitCode: 1, reason: 'Cannot find module shared/sim/canaryContract' }),
    ]);
    writeFileSync(join(tmp, 'gate.json'), JSON.stringify({ decision: { blocked: true }, findings: [] }));
    const res = cmdAuditVerdict(ctx(), { log: join(tmp, 'collectors.json'), gate: join(tmp, 'gate.json'), out: join(tmp, 'verdict.json') });
    expect(res.verdict).toBe('BLOCKED_BY_AUDIT_ERROR');
    expect(res.exitCode).toBe(1);
    const doc = JSON.parse(readFileSync(join(tmp, 'verdict.json'), 'utf8'));
    expect(doc.auditErrors).toEqual(expect.arrayContaining(['remote-audit', 'browser-tests']));
  });

  it('a healthy audit that finds a real production defect is BLOCKED_BY_FINDINGS', () => {
    writeLog([rec({ name: 'endpoint-audit', status: 'FINDING', exitCode: 1, reason: 'api-health returned 503' }), rec({ name: 'browser-tests' })]);
    writeFileSync(
      join(tmp, 'gate.json'),
      JSON.stringify({ decision: { blocked: true }, findings: [{ id: 'endpoints.api-health-down', severity: 'CRITICAL', area: 'health', message: '503' }] }),
    );
    const res = cmdAuditVerdict(ctx(), { log: join(tmp, 'collectors.json'), gate: join(tmp, 'gate.json'), out: join(tmp, 'verdict.json') });
    expect(res.verdict).toBe('BLOCKED_BY_FINDINGS');
    const doc = JSON.parse(readFileSync(join(tmp, 'verdict.json'), 'utf8'));
    expect(doc.productionFindings).toHaveLength(1);
  });

  it('a missing gate artifact is itself an audit error, not an implicit pass', () => {
    writeLog([rec({ name: 'endpoint-audit' })]);
    const res = cmdAuditVerdict(ctx(), { log: join(tmp, 'collectors.json'), gate: join(tmp, 'gate.json'), out: join(tmp, 'verdict.json') });
    expect(res.verdict).toBe('BLOCKED_BY_AUDIT_ERROR');
  });
});

describe('coverage classification', () => {
  it('a missing OPTIONAL surface is NOT_CONFIGURED, and is named in the report', () => {
    const { coverage } = cmdCoverageReport(ctx(), {
      out: join(tmp, 'coverage.json'),
      env: { SMOKE_BASE_URL: 'https://flowvidco.com' },
    });
    const byName = Object.fromEntries(coverage.map((c) => [c.surface, c.status]));
    expect(byName['Public homepage']).toBe('TESTED');
    expect(byName['Playlist']).toBe('NOT_CONFIGURED');
    expect(byName['Admin login']).toBe('NOT_CONFIGURED');
  });

  it('a missing REQUIRED surface is an ERROR and drives BLOCKED_BY_AUDIT_ERROR', () => {
    const { coverage } = cmdCoverageReport(ctx(), { out: join(tmp, 'coverage.json'), env: {} });
    expect(coverage.find((c) => c.surface === 'Public homepage')!.status).toBe('ERROR');

    writeFileSync(join(tmp, 'collectors.json'), JSON.stringify({ schema: 'flowvid.collector-log/v1', createdAt: 'n', collectors: [rec({})] }));
    writeFileSync(join(tmp, 'gate.json'), JSON.stringify({ decision: { blocked: false }, findings: [] }));
    const res = cmdAuditVerdict(ctx(), {
      log: join(tmp, 'collectors.json'),
      gate: join(tmp, 'gate.json'),
      coverage: join(tmp, 'coverage.json'),
      out: join(tmp, 'verdict.json'),
    });
    expect(res.verdict).toBe('BLOCKED_BY_AUDIT_ERROR');
  });

  it('a fully configured run reports every surface as TESTED', () => {
    const { coverage } = cmdCoverageReport(ctx(), {
      env: {
        SMOKE_BASE_URL: 'x',
        SMOKE_PUBLIC_PATH: 'x',
        SMOKE_PLAYLIST_PATH: 'x',
        SMOKE_ADMIN_URL: 'x',
        SMOKE_ADMIN_EMAIL: 'x',
        SMOKE_ADMIN_PASSWORD: 'x',
        SMOKE_ADMIN_PREVIEW_PATH: 'x',
      },
    });
    expect(coverage.every((c) => c.status === 'TESTED')).toBe(true);
  });
});

describe('remote failure classification', () => {
  const cases: Array<[string, string, string, boolean]> = [
    ['DNS', 'ssh: Could not resolve hostname vm.example: Name or service not known', 'DNS', true],
    ['connect timeout', 'ssh: connect to host 10.0.0.1 port 22: Connection timed out', 'CONNECT_TIMEOUT', true],
    ['host key', '@@@ REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed.', 'HOST_KEY_MISMATCH', true],
    ['auth', 'Permission denied (publickey).', 'AUTH_FAILED', true],
    ['repo missing', 'bash: /home/ubuntu/cebu/deploy/scripts/production-audit.sh: No such file or directory', 'REPO_MISSING', true],
  ];
  for (const [label, stderr, kind, auditError] of cases) {
    it(`classifies ${label} as ${kind}`, () => {
      const d = diagnoseRemoteFailure({ code: 255, stdout: '', stderr });
      expect(d.kind).toBe(kind);
      expect(d.auditError).toBe(auditError);
    });
  }

  it('a non-zero remote exit is an AUDIT error, because the VM script signals health in JSON and exits 0', () => {
    // Corrected after adversarial review. deploy/scripts/production-audit.sh is a read-only
    // snapshot: a down database still exits 0 with "backendHealth":{"ok":false} in its JSON.
    // Its only non-zero exits are die() preconditions, crashes, 127 and signals — and a
    // SIGKILLed ssh is indistinguishable from exit 1 (SshExecutor resolves `code ?? 1`).
    // Calling any of those "the VM answered" points the operator at the wrong system.
    for (const code of [1, 3, 126, 127]) {
      const d = diagnoseRemoteFailure({ code, stdout: '', stderr: '' });
      expect(d.kind).toBe('REMOTE_COMMAND_FAILED');
      expect(d.auditError, `exit ${code} must be an audit error`).toBe(true);
    }
  });

  it('a die() precondition failure is not reported as a production finding', () => {
    const d = diagnoseRemoteFailure({ code: 1, stdout: '', stderr: '[fail ] python3 required.' });
    expect(d.auditError).toBe(true);
    expect(d.remediation).toMatch(/UNKNOWN/);
  });

  it('never recommends weakening host-key checking', () => {
    const d = diagnoseRemoteFailure({ code: 255, stdout: '', stderr: 'Host key verification failed.' });
    expect(d.remediation).toMatch(/do NOT disable strict host-key checking/i);
  });
});

describe('endpoint audit reports enough to act on', () => {
  const fakeFetch = (impl: (url: string) => Promise<Response> | Response) => impl as unknown as typeof fetch;
  const res = (init: { status: number; url: string; body?: unknown; headers?: Record<string, string> }) =>
    new Response(init.body === undefined ? null : JSON.stringify(init.body), {
      status: init.status,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    });

  it('records status, TLS, latency, security headers and a reason per endpoint', async () => {
    const out = join(tmp, 'endpoints.json');
    const r = await cmdEndpointAudit(
      {
        ...ctx(),
        fetchImpl: fakeFetch(async (url) => {
          const response = res({ status: 200, url, headers: { 'strict-transport-security': 'max-age=31536000' } });
          Object.defineProperty(response, 'url', { value: url });
          return response;
        }),
      },
      { out, runId: 'r1', gitSha: 'sha1' },
    );
    expect(r.exitCode).toBe(0);
    for (const ep of r.endpoints) {
      expect(ep.tls).toBe(true);
      expect(ep.result).toBe('PASS');
      expect(typeof ep.latencyMs).toBe('number');
      expect(ep.securityHeaders['strict-transport-security']).toBe('max-age=31536000');
    }
    const doc = JSON.parse(readFileSync(out, 'utf8'));
    expect(doc.runId).toBe('r1');
  });

  it('surfaces the health endpoint’s own reason instead of a bare status code', async () => {
    // The real production state observed while writing this: the API is reachable and
    // routes correctly, but /health answers 503 {"status":"degraded","reason":"db_unavailable"}.
    // "2/3 ok" cost a manual investigation to learn that.
    const r = await cmdEndpointAudit(
      {
        ...ctx(),
        fetchImpl: fakeFetch(async (url) => {
          const isHealth = url.includes('/health');
          const response = res({
            status: isHealth ? 503 : 200,
            url,
            body: isHealth ? { status: 'degraded', reason: 'db_unavailable' } : undefined,
          });
          Object.defineProperty(response, 'url', { value: url });
          return response;
        }),
      },
      {},
    );
    expect(r.exitCode).toBe(1);
    const health = r.endpoints.find((e) => e.name === 'api-health')!;
    expect(health.reportedStatus).toBe('degraded');
    expect(health.reason).toContain('db_unavailable');
    const f = r.findings.find((x) => x.id === 'endpoints.api-health-down')!;
    expect(f.severity).toBe('CRITICAL');
    expect(f.remediation).toMatch(/database/i);
    // And the failing endpoint is named in the log, not hidden behind "2/3 ok".
    expect(logs.join('\n')).toMatch(/api-health/);
  });

  it('classifies a transport/TLS failure without pretending the endpoint answered', async () => {
    const r = await cmdEndpointAudit(
      { ...ctx(), fetchImpl: fakeFetch(async () => { throw new Error('unable to verify the first certificate'); }) },
      {},
    );
    expect(r.exitCode).toBe(1);
    for (const ep of r.endpoints) {
      expect(ep.httpStatus).toBeNull();
      expect(ep.tls).toBe(false);
      expect(ep.reason).toContain('transport failure');
    }
  });

  it('records a redirect chain when the final URL differs from the requested one', async () => {
    const r = await cmdEndpointAudit(
      {
        ...ctx(),
        fetchImpl: fakeFetch(async (url) => {
          const response = res({ status: 200, url });
          Object.defineProperty(response, 'url', { value: `${url}/redirected` });
          return response;
        }),
      },
      {},
    );
    expect(r.endpoints[0].redirects).toHaveLength(2);
    expect(r.endpoints[0].finalUrl).toContain('/redirected');
  });
});

describe('the rendered report separates the three things an operator triages on', () => {
  it('names production findings, audit errors and coverage as distinct sections', async () => {
    const { renderMarkdown, buildReport } = await import('../report.js');
    const md = renderMarkdown(
      buildReport({
        runId: 'audit-1-1',
        kind: 'audit',
        state: 'AUDIT_COMPLETE' as never,
        stages: [],
        findings: [],
        audit: {
          verdict: 'BLOCKED_BY_AUDIT_ERROR',
          verdictReasons: ['browser-tests: Cannot find module shared/sim/canaryContract'],
          auditErrors: [{ name: 'browser-tests', reason: 'Cannot find module shared/sim/canaryContract' }],
          coverage: [
            { surface: 'Public homepage', status: 'TESTED' },
            { surface: 'Admin login', status: 'NOT_CONFIGURED', reason: 'missing input(s): SMOKE_ADMIN_EMAIL' },
          ],
        },
      } as never),
    );
    expect(md).toContain('## Audit verdict: BLOCKED_BY_AUDIT_ERROR');
    expect(md).toContain('## Audit infrastructure errors');
    expect(md).toContain('## Coverage');
    // The reader must be told explicitly that production state is unknown…
    expect(md).toMatch(/UNKNOWN/);
    // …and that an untested surface is not covered by the verdict.
    expect(md).toMatch(/not \*\*exercised by this run\*\*|not exercised by this run/);
  });

  it('states plainly when every collector answered', async () => {
    const { renderMarkdown, buildReport } = await import('../report.js');
    const md = renderMarkdown(
      buildReport({
        runId: 'audit-2-1',
        kind: 'audit',
        state: 'AUDIT_COMPLETE' as never,
        stages: [],
        findings: [],
        audit: { verdict: 'PASS', auditErrors: [], coverage: [{ surface: 'Public homepage', status: 'TESTED' }] },
      } as never),
    );
    expect(md).toContain('## Audit verdict: PASS');
    expect(md).toContain('None — every collector produced an answer.');
  });
});

describe('probe-artifact classifies without writing (both conflations closed)', () => {
  it('a genuine test failure with a real report is a FINDING, not an audit error', () => {
    // Audit run 31241926542: the suite ran, 2 specs failed on a real production 5xx, and
    // because artifact detection had been removed the run reported BLOCKED_BY_AUDIT_ERROR —
    // "the auditor is broken" for a genuine production incident.
    const results = join(tmp, 'results.json');
    writeFileSync(results, JSON.stringify({ suites: [{ specs: [{ ok: false, title: 't' }] }] }));
    const { record } = cmdCollectorRecord(ctx(), {
      name: 'browser-tests',
      command: 'playwright test',
      startedAt: 'a',
      endedAt: 'b',
      exitCode: 1,
      probeArtifact: results,
      log: join(tmp, 'collectors.json'),
    });
    expect(record.status).toBe('FINDING');
  });

  it('a crash with no report is an ERROR', () => {
    const { record } = cmdCollectorRecord(ctx(), {
      name: 'browser-tests',
      command: 'playwright test',
      startedAt: 'a',
      endedAt: 'b',
      exitCode: 1,
      probeArtifact: join(tmp, 'results.json'),
      log: join(tmp, 'collectors.json'),
    });
    expect(record.status).toBe('ERROR');
  });

  it('probing NEVER writes a placeholder over the probed file', () => {
    // This is what stops the laundering: the report path must stay absent so
    // playwright-summary fails closed instead of parsing a placeholder as an empty pass.
    const results = join(tmp, 'results.json');
    cmdCollectorRecord(ctx(), {
      name: 'browser-tests',
      command: 'playwright test',
      startedAt: 'a',
      endedAt: 'b',
      exitCode: 1,
      probeArtifact: results,
      log: join(tmp, 'collectors.json'),
    });
    expect(existsSync(results)).toBe(false);
  });
});
