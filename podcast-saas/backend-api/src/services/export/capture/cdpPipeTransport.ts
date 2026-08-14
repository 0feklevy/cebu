/**
 * The thin CDP transport — the ONE piece of the beginFrame capture path that never existed.
 *
 * Everything above this file already ships and is tested: the flag policy, CDP message shapes and
 * frame schedule (`beginFrameBackend.ts`), the document-start injection (`injection.ts`), the
 * bridge handshake (`driver.ts` — `runCaptureHandshake` over `DriverDeps`), and the rendering
 * sanity gate (`sanityGate.ts`). This file adds ONLY the plumbing those pieces were waiting for:
 * launch `chrome-headless-shell` and speak DevTools protocol to it.
 *
 * Transport choice: `--remote-debugging-pipe` — CDP as NUL-delimited JSON over inherited file
 * descriptors 3 (chrome reads) and 4 (chrome writes). No WebSocket, no port, no library:
 *   • zero new dependencies (backend-api ships no puppeteer/playwright/ws, and must not);
 *   • zero network surface — it composes with `--network none` by construction, where a
 *     `--remote-debugging-port` would need loopback plumbing and a port race.
 *
 * This file knows NOTHING about capture policy — no flags beyond what it is handed, no CDP method
 * choreography. `beginFrameBackend.ts` owns that (the compositional direction the architecture
 * demands: policy → handshake → DriverDeps → THIS transport → Chrome).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

import { CaptureStageError, sanitizeUntrustedText } from './captureTypes.js';

// ── Framing (pure, unit-tested): NUL-delimited JSON in both directions ──────────────────────────

/** Encode one CDP message for the pipe: its JSON followed by a NUL byte. */
export function encodeCdpMessage(message: Record<string, unknown>): Buffer {
  return Buffer.concat([Buffer.from(JSON.stringify(message), 'utf8'), Buffer.from([0])]);
}

/**
 * Incremental decoder for the chrome→us direction. Feed arbitrary chunks; complete NUL-terminated
 * JSON messages come out. Malformed JSON between delimiters throws — a corrupt CDP stream must
 * fail the capture loudly, never be silently skipped.
 */
export class CdpFramer {
  private buffered: Buffer = Buffer.alloc(0);

  feed(chunk: Buffer): Array<Record<string, unknown>> {
    this.buffered = this.buffered.length === 0 ? chunk : Buffer.concat([this.buffered, chunk]);
    const messages: Array<Record<string, unknown>> = [];
    let start = 0;
    for (let i = 0; i < this.buffered.length; i++) {
      if (this.buffered[i] !== 0) continue;
      const raw = this.buffered.subarray(start, i).toString('utf8');
      start = i + 1;
      if (raw.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new CaptureStageError('cdp_connect', `malformed CDP frame (${raw.slice(0, 120)}…)`);
      }
      messages.push(parsed as Record<string, unknown>);
    }
    this.buffered = start === 0 ? this.buffered : Buffer.from(this.buffered.subarray(start));
    return messages;
  }
}

// ── The connection ──────────────────────────────────────────────────────────────────────────────

export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

interface Pending {
  resolve: (result: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  method: string;
}

/**
 * A minimal request/response + event CDP client over a writable/readable stream pair. Every
 * pending command is rejected when the stream closes, so a Chrome that dies mid-capture surfaces
 * as a classified error at the await site — never a hang.
 */
export class CdpConnection {
  private readonly framer = new CdpFramer();
  private readonly pending = new Map<number, Pending>();
  private readonly eventListeners = new Set<(event: CdpEvent) => void>();
  private readonly eventWaiters = new Set<(reason: Error) => void>();
  private nextId = 1;
  private closed: Error | null = null;

  constructor(
    private readonly toChrome: Writable,
    fromChrome: Readable,
    /** Extra context for the pipe-close reason (e.g. Chrome's sanitized stderr tail). */
    private readonly closeContext?: () => string,
  ) {
    fromChrome.on('data', (chunk: Buffer) => {
      let messages: Array<Record<string, unknown>>;
      try {
        messages = this.framer.feed(chunk);
      } catch (err) {
        this.shutdown(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      for (const m of messages) this.dispatch(m);
    });
    fromChrome.on('error', (err) => this.shutdown(err));
    fromChrome.on('close', () => {
      const context = this.closeContext?.() ?? '';
      this.shutdown(
        new CaptureStageError(
          'cdp_connect',
          `CDP pipe closed by Chrome${context ? ` — stderr tail: ${context}` : ''}`,
        ),
      );
    });
  }

  /** Send one command; resolves with the CDP `result`, rejects on CDP `error` or a dead pipe. */
  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      const message: Record<string, unknown> = { id, method, params };
      if (sessionId) message.sessionId = sessionId;
      this.toChrome.write(encodeCdpMessage(message), (err) => {
        if (err && this.pending.delete(id)) reject(err);
      });
    });
  }

  onEvent(listener: (event: CdpEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /**
   * Wait for one occurrence of a (session-scoped) event, bounded by a real-clock timeout — AND by
   * the pipe's life: `shutdown()` rejects waiters immediately with its (richer) reason, so a Chrome
   * that dies mid-navigation fails the capture in milliseconds with "chrome exited …", never a
   * 30-second stall behind a misleading event-timeout message.
   */
  waitForEvent(method: string, sessionId: string | undefined, timeoutMs: number): Promise<CdpEvent> {
    if (this.closed) return Promise.reject(this.closed);
    return new Promise<CdpEvent>((resolve, reject) => {
      const settle = (fn: () => void): void => {
        clearTimeout(timer);
        off();
        this.eventWaiters.delete(onShutdown);
        fn();
      };
      const onShutdown = (reason: Error): void => settle(() => reject(reason));
      const timer = setTimeout(() => {
        settle(() => reject(new CaptureStageError('cdp_connect', `no ${method} event within ${timeoutMs}ms`)));
      }, timeoutMs);
      timer.unref();
      const off = this.onEvent((event) => {
        if (event.method !== method) return;
        if (sessionId !== undefined && event.sessionId !== sessionId) return;
        settle(() => resolve(event));
      });
      this.eventWaiters.add(onShutdown);
    });
  }

  /** Reject everything in flight — commands AND event waiters — and refuse further work. Idempotent. */
  shutdown(reason: Error): void {
    if (this.closed) return;
    this.closed = reason;
    for (const [, p] of this.pending) p.reject(reason);
    this.pending.clear();
    for (const w of [...this.eventWaiters]) w(reason);
    this.eventWaiters.clear();
    this.eventListeners.clear();
  }

  private dispatch(message: Record<string, unknown>): void {
    const id = message.id;
    if (typeof id === 'number') {
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      const errObj = message.error as { message?: string; code?: number } | undefined;
      if (errObj) {
        p.reject(
          new CaptureStageError('cdp_connect', `${p.method} failed: ${errObj.message ?? 'unknown CDP error'}`),
        );
      } else {
        p.resolve((message.result ?? {}) as Record<string, unknown>);
      }
      return;
    }
    if (typeof message.method === 'string') {
      const event: CdpEvent = {
        method: message.method,
        params: (message.params ?? {}) as Record<string, unknown>,
        sessionId: typeof message.sessionId === 'string' ? message.sessionId : undefined,
      };
      for (const l of [...this.eventListeners]) l(event);
    }
  }
}

// ── Launching chrome-headless-shell with the pipe ───────────────────────────────────────────────

export interface HeadlessShellHandle {
  connection: CdpConnection;
  /** SIGTERM, escalate to SIGKILL, and wait for the process to be reaped. Idempotent. */
  kill(): Promise<void>;
  /** Resolves with the exit code when Chrome exits — for detecting an unexpected death. */
  exited: Promise<number | null>;
}

const KILL_GRACE_MS = 2_000;

/**
 * Spawn the pinned browser with CDP over fds 3/4. The caller owns the flag list (policy lives in
 * `beginFrameBackend.ts`); this function appends ONLY the pipe switch itself. The child gets a
 * minimal environment — no credentials ride in (the container has none to leak; belt and braces).
 */
export function launchHeadlessShell(opts: {
  executablePath: string;
  flags: readonly string[];
  log?: (message: string) => void;
}): HeadlessShellHandle {
  const log = opts.log ?? (() => {});
  const proc: ChildProcess = spawn(
    opts.executablePath,
    [...opts.flags, '--remote-debugging-pipe', 'about:blank'],
    {
      // fd3: chrome reads CDP; fd4: chrome writes CDP. stderr is kept for launch diagnostics.
      stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
      env: { HOME: process.env.HOME ?? '/tmp', XDG_CACHE_HOME: process.env.XDG_CACHE_HOME ?? '/tmp/.cache' },
    },
  );

  let stderrTail = '';
  proc.stderr?.on('data', (d: Buffer) => {
    stderrTail = (stderrTail + d.toString('utf8')).slice(-2048);
  });
  // Chrome's stderr can carry UNTRUSTED sim-influenced bytes; it is sanitized at EVERY exit into
  // an error message (here and in the pipe-close reason), never embedded raw.
  const tail = (): string => sanitizeUntrustedText(stderrTail, { maxBytes: 400, maxLines: 8 });

  const toChrome = proc.stdio[3] as Writable | null;
  const fromChrome = proc.stdio[4] as Readable | null;
  if (!toChrome || !fromChrome) {
    proc.kill('SIGKILL');
    throw new CaptureStageError('chrome_launch', 'CDP pipe fds 3/4 were not created');
  }
  const connection = new CdpConnection(toChrome, fromChrome, tail);

  const exited = new Promise<number | null>((resolve) => {
    proc.on('error', (err) => {
      connection.shutdown(new CaptureStageError('chrome_launch', `spawn failed: ${err.message}`));
      resolve(null);
    });
    proc.on('exit', (code) => {
      const t = tail();
      connection.shutdown(
        new CaptureStageError(
          'chrome_launch',
          `chrome exited ${code ?? 'null'}${t ? ` — stderr tail: ${t}` : ''}`,
        ),
      );
      resolve(code);
    });
  });

  let killed: Promise<void> | null = null;
  const kill = (): Promise<void> => {
    if (killed) return killed;
    killed = new Promise<void>((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) {
        resolve();
        return;
      }
      const hard = setTimeout(() => proc.kill('SIGKILL'), KILL_GRACE_MS);
      hard.unref();
      proc.once('exit', () => {
        clearTimeout(hard);
        resolve();
      });
      log('terminating chrome');
      proc.kill('SIGTERM');
    });
    return killed;
  };

  return { connection, kill, exited };
}
