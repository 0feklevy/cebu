/**
 * Local process runner. Small wrapper over execFile so modules that shell out
 * (git, curl) can be tested with an injected fake.
 */
import { execFile } from 'node:child_process';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Runner = (cmd: string, args: string[], opts?: { cwd?: string; timeoutMs?: number }) => Promise<ExecResult>;

export const runCommand: Runner = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs ?? 120_000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const anyErr = err as (Error & { code?: number | string }) | null;
        const code = anyErr ? (typeof anyErr.code === 'number' ? anyErr.code : 1) : 0;
        resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
  });
