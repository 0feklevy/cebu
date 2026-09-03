/**
 * The post-deploy audit's disk finding after the 2026-09-03 incident: an alarm, never a rollback
 * trigger (a rollback frees nothing) — HIGH under 3 GB, a WARNING under 8, silent from 8 up. The
 * deploy itself refuses under 8 GB before any pull; this is what the audit says when it still
 * sees the disk that low afterwards.
 */
import { describe, expect, it } from 'vitest';
import { auditVm, type VmAudit } from '../commands.js';
import { RELEASE_CONFIG } from '../config.js';

const vm = (diskFreeGb: number | null): VmAudit => ({
  schema: 'flowvid.vm-audit/v1',
  containers: { backend: 'healthy', worker: 'running', 'client-web': 'healthy', 'admin-web': 'healthy', nginx: 'healthy', certbot: 'running' },
  backendHealth: { ok: true },
  workerRunning: true,
  diskFreeGb,
  certDaysRemaining: { 'flowvidco.com': 55 },
  urlBackfill: null,
});

const diskLow = (diskFreeGb: number | null) => auditVm(vm(diskFreeGb), RELEASE_CONFIG, 'report-only').find((f) => f.id === 'vm.disk-low');

describe('vm.disk-low', () => {
  it('is HIGH under 3 GB', () => {
    expect(diskLow(2)?.severity).toBe('HIGH');
  });
  it('is a WARNING between 3 and 8 GB, and names the retention script', () => {
    const f = diskLow(5);
    expect(f?.severity).toBe('WARNING');
    expect(f?.message).toMatch(/retain-images\.sh/);
  });
  it('is silent at 8 GB and above, and when the audit could not read the disk', () => {
    expect(diskLow(8)).toBeUndefined();
    expect(diskLow(42)).toBeUndefined();
    expect(diskLow(null)).toBeUndefined();
  });
  it('is never CRITICAL — a rollback would free nothing', () => {
    expect(diskLow(0)?.severity).not.toBe('CRITICAL');
  });
});
