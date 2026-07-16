import { describe, expect, it } from 'vitest';
import { REDACTED, redactText, redactValue } from '../redact.js';

describe('redactText', () => {
  it('masks known credential shapes', () => {
    const samples = [
      'sk-ant-api03-abcdefgh12345678',
      'sk_live_abcdefgh12345678',
      'whsec_abcdefgh12345678',
      'AKIAIOSFODNN7EXAMPLE',
      'ghp_abcdefghijklmnopqrst123456',
      'github_pat_11ABCDEFG0123456789_abcdef',
      'eyJhbGciOiJIUzI1NiJ9x.eyJzdWIiOiIxMjM0NX0abc.SflKxwRJSMeKKF2QT4',
    ];
    for (const s of samples) {
      expect(redactText(`before ${s} after`), s).toBe(`before ${REDACTED} after`);
    }
  });

  it('masks PEM private key blocks', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIB\nlines\n-----END RSA PRIVATE KEY-----';
    expect(redactText(pem)).toBe(REDACTED);
  });

  it('masks credentials embedded in URLs but keeps the rest readable', () => {
    expect(redactText('postgresql://postgres:S3cr3t!@db.abc.supabase.co:5432/postgres')).toBe(
      `postgresql://postgres:${REDACTED}@db.abc.supabase.co:5432/postgres`,
    );
  });

  it('masks secret-named env assignments', () => {
    expect(redactText('STRIPE_SECRET_KEY=sk_live_x8s7d6f5')).toBe(`STRIPE_SECRET_KEY=${REDACTED}`);
    expect(redactText('SUPABASE_S3_SECRET_ACCESS_KEY: abc123def456')).toBe(
      `SUPABASE_S3_SECRET_ACCESS_KEY: ${REDACTED}`,
    );
  });

  it('leaves public configuration alone', () => {
    const text = 'NEXT_PUBLIC_API_URL=https://api.flowvidco.com DOMAIN_ROOT=flowvidco.com';
    expect(redactText(text)).toBe(text);
  });
});

describe('redactValue (report redaction)', () => {
  it('deep-walks objects and masks values under secret-named keys entirely', () => {
    const input = {
      version: 'v0.1.2',
      env: { GHCR_PULL_TOKEN: 'anything at all', DOMAIN_ROOT: 'flowvidco.com' },
      logs: ['connected with postgresql://u:pw@host/db'],
    };
    const out = redactValue(input);
    expect(out.version).toBe('v0.1.2');
    expect(out.env.GHCR_PULL_TOKEN).toBe(REDACTED);
    expect(out.env.DOMAIN_ROOT).toBe('flowvidco.com');
    expect(out.logs[0]).toContain(`u:${REDACTED}@host`);
  });
});
