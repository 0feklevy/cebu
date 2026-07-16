import { describe, expect, it } from 'vitest';
import { isPathForbidden, scanContent, scanTrackedPaths, secretScan, shouldContentScan } from '../secret-scan.js';

describe('secret path detection', () => {
  it('forbids env files and their variants/backups', () => {
    for (const p of [
      '.env',
      'podcast-saas/.env',
      'podcast-saas/deploy/.env',
      'client-web/.env.local',
      'admin-web/.env.production',
      '.env.bak',
      'client-web/.env.local.release-bak',
    ]) {
      expect(isPathForbidden(p), p).not.toBeNull();
    }
  });

  it('allows example env files', () => {
    for (const p of ['.env.example', 'podcast-saas/.env.example', 'deploy/.env.example']) {
      expect(isPathForbidden(p), p).toBeNull();
    }
  });

  it('forbids key material', () => {
    for (const p of ['deploy/vm.pem', 'certs/server.key', 'ops/id_rsa', 'ops/id_ed25519.old', 'firebase-service-account.json']) {
      expect(isPathForbidden(p), p).not.toBeNull();
    }
  });

  it('does not flag ordinary source files', () => {
    for (const p of ['backend-api/src/server.ts', 'deploy/docker-compose.yml', 'client-web/lib/api.ts', 'shared/src/csp.ts']) {
      expect(isPathForbidden(p), p).toBeNull();
    }
  });

  it('produces CRITICAL findings for tracked forbidden paths', () => {
    const findings = scanTrackedPaths(['README.md', 'deploy/.env', 'a/b/id_rsa']);
    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.severity === 'CRITICAL')).toBe(true);
  });
});

describe('secret content detection', () => {
  it('reports rule + line but never the secret value', () => {
    const content = `const config = {\n  key: "sk_live_abcdefgh12345678"\n};\n`;
    const findings = scanContent('src/pay.ts', content);
    expect(findings).toHaveLength(1);
    expect(findings[0].id).toBe('secrets.content.stripe-secret-key');
    expect(findings[0].message).toContain('src/pay.ts:2');
    expect(JSON.stringify(findings)).not.toContain('sk_live_abcdefgh12345678');
  });

  it('skips test fixtures and lockfiles', () => {
    expect(shouldContentScan('ops/release/src/__tests__/redact.test.ts')).toBe(false);
    expect(shouldContentScan('podcast-saas/pnpm-lock.yaml')).toBe(false);
    expect(shouldContentScan('backend-api/src/server.ts')).toBe(true);
  });
});

describe('secretScan end-to-end (mock source)', () => {
  it('combines path and content findings over tracked files only', async () => {
    const files: Record<string, string> = {
      'src/ok.ts': 'export const x = 1;',
      'src/leak.ts': 'const t = "ghp_abcdefghijklmnopqrst123456";',
      'deploy/.env': 'SHOULD_NEVER_BE_READ=1',
    };
    const { findings, scannedFiles } = await secretScan({
      listTrackedFiles: async () => Object.keys(files),
      readFile: async (p) => files[p] ?? null,
    });
    const ids = findings.map((f) => f.id).sort();
    expect(ids).toEqual(['secrets.content.github-token', 'secrets.path.env-file']);
    // The forbidden .env path is flagged by PATH only — its content is not eligible for scanning.
    expect(scannedFiles).toBe(2);
  });
});
