/**
 * Secret scanning over TRACKED files only (git ls-files) — the release must fail if a
 * secret-bearing file is committed, but the scanner itself must never read the real
 * .env files sitting untracked in the working tree.
 *
 * Two layers:
 *   1. Path rules — env files, PEM/keys, keystores, env backups must not be tracked.
 *   2. Content rules — known credential shapes inside tracked text files.
 *
 * Findings NEVER include the matched secret value — only file, rule name, line.
 */
import { SECRET_PATTERN_DEFS } from './redact.js';
import { finding, type Finding } from './severity.js';

export interface PathRule {
  name: string;
  re: RegExp;
}

/** Paths that are allowed even though they look like env files. */
const PATH_ALLOWLIST: RegExp[] = [
  /(^|\/)\.env\.example$/i,
  /(^|\/)\.env\.[a-z0-9-]+\.example$/i,
];

export const FORBIDDEN_PATH_RULES: PathRule[] = [
  { name: 'env-file', re: /(^|\/)\.env$/i },
  { name: 'env-variant', re: /(^|\/)\.env\.[^/]+$/i }, // .env.local, .env.production, .env.bak …
  { name: 'env-backup', re: /\.(env\.bak|env\.backup|env\.old|env\.save)$/i },
  { name: 'release-verify-backup', re: /\.release-bak$/i },
  { name: 'pem-key', re: /\.pem$/i },
  { name: 'private-key-ext', re: /\.(key|p12|pfx|jks|keystore)$/i },
  { name: 'ssh-private-key', re: /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.[^/]+)?$/i },
  { name: 'gcp-service-account', re: /(^|\/)[^/]*service[-_]?account[^/]*\.json$/i },
];

/** Files whose CONTENT is exempt (fixtures with clearly fake credentials + the pattern definitions themselves). */
const CONTENT_ALLOWLIST: RegExp[] = [
  /(^|\/)__tests__\//,
  /\.test\.tsx?$/,
  /(^|\/)ops\/release\/src\/(redact|secret-scan)\.ts$/,
];

/** Extensions worth content-scanning (text/source). */
const TEXT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|ya?ml|sh|bash|sql|md|txt|env|conf|cfg|ini|toml|Dockerfile|dockerfile|html|css|tf|py)$/i;
const SCAN_ALSO = /(^|\/)(Dockerfile|Makefile|\.gitignore|\.dockerignore|\.npmrc)[^/]*$/i;

export function isPathForbidden(path: string): PathRule | null {
  if (PATH_ALLOWLIST.some((re) => re.test(path))) return null;
  for (const rule of FORBIDDEN_PATH_RULES) {
    if (rule.re.test(path)) return rule;
  }
  return null;
}

export function scanTrackedPaths(paths: string[]): Finding[] {
  const findings: Finding[] = [];
  for (const p of paths) {
    const rule = isPathForbidden(p);
    if (rule) {
      findings.push(
        finding(`secrets.path.${rule.name}`, 'CRITICAL', 'secrets', `Forbidden file is tracked by git: ${p}`, {
          detail: `Matched rule "${rule.name}". Secret-bearing files must never be committed.`,
          remediation: `git rm --cached ${p} && add it to .gitignore; rotate any credential it contained.`,
        }),
      );
    }
  }
  return findings;
}

export function shouldContentScan(path: string): boolean {
  // Never read the CONTENT of a forbidden file (env/keys) — the path finding is
  // enough, and secret material must not pass through the scanner's memory/logs.
  if (isPathForbidden(path)) return false;
  if (CONTENT_ALLOWLIST.some((re) => re.test(path))) return false;
  if (/(^|\/)pnpm-lock\.yaml$/.test(path)) return false; // integrity hashes, huge, no plaintext creds
  return TEXT_EXT.test(path) || SCAN_ALSO.test(path);
}

/** Scan one file's content. Returns findings naming file+rule+line — never the value. */
export function scanContent(path: string, content: string): Finding[] {
  const findings: Finding[] = [];
  for (const def of SECRET_PATTERN_DEFS) {
    const re = new RegExp(def.re.source, def.re.flags); // fresh lastIndex
    const m = re.exec(content);
    if (!m) continue;
    const line = content.slice(0, m.index).split('\n').length;
    findings.push(
      finding(`secrets.content.${def.name}`, 'CRITICAL', 'secrets', `Possible ${def.name} committed in ${path}:${line}`, {
        detail: 'Matched a known credential shape. The value is not reproduced here.',
        remediation: 'Remove the credential from git history and rotate it immediately.',
      }),
    );
  }
  return findings;
}

export interface SecretScanSource {
  listTrackedFiles(): Promise<string[]>;
  readFile(path: string): Promise<string | null>;
}

export async function secretScan(source: SecretScanSource): Promise<{ findings: Finding[]; scannedFiles: number }> {
  const paths = await source.listTrackedFiles();
  const findings = scanTrackedPaths(paths);

  let scanned = 0;
  for (const p of paths) {
    if (!shouldContentScan(p)) continue;
    const content = await source.readFile(p);
    if (content === null || content.length > 2 * 1024 * 1024) continue;
    scanned += 1;
    findings.push(...scanContent(p, content));
  }
  return { findings, scannedFiles: scanned };
}
