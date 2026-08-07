/**
 * Classify why a remote (SSH) audit failed.
 *
 * Run 31199562890 logged exactly `remote-audit: FAILED` followed by an empty line, and
 * discarded the VM's stdout. That is unactionable: it does not distinguish "the VM is
 * unreachable" (an audit error — we learned nothing about production) from "the VM ran
 * our script and it reported the database is down" (a production finding — page someone).
 *
 * Measured during this investigation: TCP 22 on the production host accepted a connection
 * immediately and the site served HTTP 200, so the 21-second failure was NOT a connect
 * timeout. Meanwhile `https://api.flowvidco.com/health` answered 503 with
 * `{"status":"degraded","reason":"db_unavailable"}`. The most likely reading is therefore
 * the second kind — a VM-side check exiting non-zero — which the old code reported as an
 * infrastructure failure.
 *
 * Nothing here weakens SSH security: strict host-key checking, BatchMode and key-only auth
 * stay exactly as they were. This module only reads what ssh already told us.
 */

export type RemoteFailureKind =
  | 'DNS'
  | 'CONNECT_TIMEOUT'
  | 'HOST_KEY_MISMATCH'
  | 'AUTH_FAILED'
  | 'PERMISSION_DENIED'
  | 'REPO_MISSING'
  | 'REMOTE_COMMAND_FAILED'
  | 'INVALID_REMOTE_JSON'
  | 'UNKNOWN';

export interface RemoteDiagnosis {
  kind: RemoteFailureKind;
  /**
   * true  ⇒ the audit itself failed; we learned nothing about production (ERROR).
   * false ⇒ we reached the VM and it answered; the answer is about production (FINDING).
   */
  auditError: boolean;
  /** Operator-facing sentence. Never contains key material or credentials. */
  summary: string;
  remediation: string;
}

/** Ordered most-specific first: ssh emits several of these phrases together. */
const PATTERNS: ReadonlyArray<{ kind: RemoteFailureKind; test: RegExp }> = [
  { kind: 'HOST_KEY_MISMATCH', test: /host key verification failed|remote host identification has changed|no matching host key/i },
  { kind: 'DNS', test: /could not resolve hostname|name or service not known|nodename nor servname/i },
  { kind: 'CONNECT_TIMEOUT', test: /connection timed out|operation timed out|connect to host .* port .*: (connection timed out|no route to host)/i },
  { kind: 'AUTH_FAILED', test: /permission denied \(publickey|too many authentication failures|no supported authentication methods/i },
  { kind: 'CONNECT_TIMEOUT', test: /connection refused|network is unreachable/i },
  { kind: 'REPO_MISSING', test: /no such file or directory|not a git repository|cannot access .*: no such file/i },
  { kind: 'PERMISSION_DENIED', test: /permission denied(?! \(publickey)/i },
];

/**
 * Diagnose from ssh's own output.
 *
 * `code === 255` is ssh's own transport failure code; anything else non-zero came from the
 * remote command, which means the transport worked and the VM answered.
 */
export function diagnoseRemoteFailure(input: { code: number; stdout: string; stderr: string }): RemoteDiagnosis {
  const haystack = `${input.stderr}\n${input.stdout}`;

  for (const { kind, test } of PATTERNS) {
    if (test.test(haystack)) return describe(kind, input);
  }

  // ssh reserves 255 for its own errors. A non-255 non-zero code means the remote command
  // ran and chose to fail — the VM answered, so this is production's answer, not ours.
  if (input.code !== 0 && input.code !== 255) return describe('REMOTE_COMMAND_FAILED', input);
  if (input.code === 255) return describe('UNKNOWN', input);
  return describe('INVALID_REMOTE_JSON', input);
}

function describe(kind: RemoteFailureKind, input: { code: number; stdout: string; stderr: string }): RemoteDiagnosis {
  const tail = (input.stderr.trim() || input.stdout.trim()).split('\n').slice(-3).join(' | ').slice(0, 400);
  switch (kind) {
    case 'DNS':
      return { kind, auditError: true, summary: 'the VM hostname did not resolve', remediation: 'Check the PRODUCTION_SSH_HOST variable and DNS.' };
    case 'CONNECT_TIMEOUT':
      return { kind, auditError: true, summary: 'could not open an SSH connection to the VM', remediation: 'Check the VM is running and its security group allows the runner.' };
    case 'HOST_KEY_MISMATCH':
      return {
        kind,
        auditError: true,
        summary: 'the VM host key did not match the pinned known_hosts entry',
        remediation: 'Do NOT disable strict host-key checking. Verify the VM identity, then update PRODUCTION_SSH_KNOWN_HOSTS deliberately.',
      };
    case 'AUTH_FAILED':
      return { kind, auditError: true, summary: 'SSH authentication was rejected', remediation: 'Check the read-only audit key is installed on the VM and unexpired.' };
    case 'PERMISSION_DENIED':
      return { kind, auditError: true, summary: 'the audit user lacks permission for a command it needs', remediation: 'Grant the read-only audit user access, or narrow the audit.' };
    case 'REPO_MISSING':
      return { kind, auditError: true, summary: 'the repository or audit script was not found on the VM', remediation: 'Check PRODUCTION_REPO_DIR and that the VM checkout exists.' };
    case 'REMOTE_COMMAND_FAILED':
      return {
        kind,
        auditError: false,
        summary: `the VM ran the audit and it exited ${input.code}${tail ? ` — ${tail}` : ''}`,
        remediation: 'The VM answered, so this describes production. Read the VM audit output rather than the pipeline.',
      };
    case 'INVALID_REMOTE_JSON':
      return { kind, auditError: true, summary: 'the VM returned output that is not valid JSON', remediation: 'Inspect production-audit.sh output; partial JSON is an audit error, not a pass.' };
    default:
      return { kind: 'UNKNOWN', auditError: true, summary: `SSH failed with code ${input.code}${tail ? ` — ${tail}` : ''}`, remediation: 'Inspect the sanitized ssh output.' };
  }
}
