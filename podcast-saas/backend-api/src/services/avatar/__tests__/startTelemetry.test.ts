/**
 * /avatar/start telemetry — REDACTION BY CONSTRUCTION.
 *
 * The start path handles, in one request: an Anam API key, a minted session token, the video
 * transcript, the system prompt and (on the ephemeral path) a ~30 KB inline persona body. The
 * night audit's requirement is phase-level timing, and the standing rule is that none of that
 * material may ever reach a log line.
 *
 * So the recorder has NO API that accepts free-form text. Durations are measured internally
 * (numbers). `path`/`outcome`/`flag` are closed unions. The only caller-supplied strings are ids,
 * and they are shape-validated on the way in — anything that is not a uuid / short slug becomes
 * the literal 'invalid'. These tests pin that property by feeding it exactly the secrets it must
 * never emit.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { beginStartTrace, START_LOG_FIELDS } from '../startTelemetry.js';
import { logger } from '../../../lib/logger.js';

const SECRETS = {
  token: 'eyJhbGciOiJIUzI1NiJ9.eyJ0eXBlIjoiZXBoZW1lcmFsIiwic2Vzc2lvbiI6IjEyMyJ9.c2lnbmF0dXJl',
  apiKey: 'anam_sk_live_9f3b2c7d8e1a4b6c9d0e2f4a6b8c0d2e',
  transcript: 'Today we are going to talk about the photoelectric effect and how it earned a Nobel prize.',
  personaBody: JSON.stringify({ systemPrompt: 'You are Albert. '.repeat(1200), knowledge: 'SECRET-KNOWLEDGE-BLOB' }),
};

function captureLines() {
  const lines: Array<{ level: 'info' | 'warn'; payload: Record<string, unknown>; msg: string }> = [];
  const push = (level: 'info' | 'warn') => (payload: unknown, msg?: unknown) =>
    lines.push({ level, payload: payload as Record<string, unknown>, msg: String(msg ?? '') });
  vi.spyOn(logger, 'info').mockImplementation(push('info') as never);
  vi.spyOn(logger, 'warn').mockImplementation(push('warn') as never);
  return lines;
}

describe('avatar start telemetry — one redacted structured line per start', () => {
  let lines: ReturnType<typeof captureLines>;
  beforeEach(() => { lines = captureLines(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('emits exactly one line carrying phase durations, path and outcome', async () => {
    const trace = beginStartTrace({ projectId: '11111111-2222-4333-8444-555555555555', characterId: 'einstein', authenticated: false });
    await trace.time('project_read', async () => 'row');
    await trace.time('authorize', async () => true);
    const stopMint = trace.mark('mint');
    stopMint();
    trace.path('stateful');
    trace.flag('display_cached');
    trace.finish({ outcome: 'ok', status: 200 });

    expect(lines).toHaveLength(1);
    const { payload, msg } = lines[0];
    expect(msg).toContain('start');
    expect(payload.evt).toBe('avatar_start');
    expect(payload.projectId).toBe('11111111-2222-4333-8444-555555555555');
    expect(payload.characterId).toBe('einstein');
    expect(payload.path).toBe('stateful');
    expect(payload.outcome).toBe('ok');
    expect(payload.status).toBe(200);
    expect(payload.flags).toEqual(['display_cached']);

    const phases = payload.phasesMs as Record<string, unknown>;
    expect(Object.keys(phases).sort()).toEqual(['authorize', 'mint', 'project_read']);
    for (const v of Object.values(phases)) expect(Number.isFinite(v as number)).toBe(true);
    expect(Number.isFinite(payload.totalMs as number)).toBe(true);
  });

  it('finish is idempotent — a handler that both sends and throws still logs one line', () => {
    const trace = beginStartTrace({ projectId: undefined, characterId: 'einstein', authenticated: true });
    trace.finish({ outcome: 'ok', status: 200 });
    trace.finish({ outcome: 'error', status: 500 });
    expect(lines).toHaveLength(1);
    expect(lines[0].payload.outcome).toBe('ok');
  });

  it('a failure outcome is logged at warn with its status', () => {
    const trace = beginStartTrace({ characterId: 'einstein' });
    trace.finish({ outcome: 'error', status: 503 });
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe('warn');
    expect(lines[0].payload.outcome).toBe('error');
    expect(lines[0].payload.status).toBe(503);
  });

  it('REDACTION: secrets pushed into every caller-supplied field never reach the line', () => {
    const trace = beginStartTrace({
      projectId: SECRETS.personaBody,
      characterId: SECRETS.token,
      authenticated: SECRETS.apiKey,
    });
    // Even a phase/flag/path name that is not part of the closed union is dropped.
    trace.path(SECRETS.transcript as never);
    trace.flag(SECRETS.apiKey as never);
    trace.mark(SECRETS.transcript as never)();
    trace.finish({ outcome: SECRETS.token as never, status: Number.NaN });

    expect(lines).toHaveLength(1);
    const serialized = JSON.stringify(lines[0]);
    for (const [name, secret] of Object.entries(SECRETS)) {
      expect(serialized, `leaked ${name}`).not.toContain(secret);
      // Also reject any long fragment of it (a truncated secret is still a secret).
      expect(serialized, `leaked ${name} prefix`).not.toContain(secret.slice(0, 24));
    }
    expect(lines[0].payload.projectId).toBe('invalid');
    expect(lines[0].payload.characterId).toBe('invalid');
    expect(lines[0].payload.authenticated).toBe(true);   // coerced to a boolean, never the key
    expect(lines[0].payload.path).toBe('unknown');
    expect(lines[0].payload.flags).toEqual([]);
    expect(lines[0].payload.phasesMs).toEqual({});
    expect(lines[0].payload.outcome).toBe('error');
    expect(lines[0].payload.status).toBe(0);
  });

  it('REDACTION: the emitted key set is a fixed allowlist — no field can be added by a caller', () => {
    const trace = beginStartTrace({ projectId: '11111111-2222-4333-8444-555555555555', characterId: 'einstein' });
    (trace as unknown as Record<string, unknown>).extra = SECRETS.transcript;
    trace.finish({ outcome: 'ok', status: 200 });
    const keys = Object.keys(lines[0].payload).sort();
    expect(keys).toEqual([...START_LOG_FIELDS].sort());
  });

  it('flags are deduped and stay within the closed union', () => {
    const trace = beginStartTrace({ characterId: 'einstein' });
    trace.flag('fingerprint_absent');
    trace.flag('fingerprint_absent');
    trace.flag('self_heal_queued');
    trace.finish({ outcome: 'ok', status: 200 });
    expect(lines[0].payload.flags).toEqual(['fingerprint_absent', 'self_heal_queued']);
  });

  it('time() still records the phase (and rethrows) when the awaited work fails', async () => {
    const trace = beginStartTrace({ characterId: 'einstein' });
    await expect(trace.time('mint', async () => { throw new Error(SECRETS.apiKey); })).rejects.toThrow();
    trace.finish({ outcome: 'error', status: 502 });
    expect(Object.keys(lines[0].payload.phasesMs as object)).toEqual(['mint']);
    expect(JSON.stringify(lines[0])).not.toContain(SECRETS.apiKey);
  });
});
