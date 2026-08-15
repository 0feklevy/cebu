/**
 * PAGE AUDIT — the bounded record of what the captured page actually did, and why a dead canvas
 * was dead.
 *
 * The v0.1.26 incident ended at a truthful but unhelpful verdict: "every sampled canvas frame is
 * uniform (dead/black canvas)". Correct — and it took a full production forensic session to learn
 * that the cause was `import * as THREE from 'three'` resolving to a CDN the container cannot
 * reach. The evidence existed the whole time, in `Network.loadingFailed` and
 * `Runtime.exceptionThrown`; nothing was listening.
 *
 * This listens, and turns those events into a CLASSIFIED failure the operator can act on:
 * "external_dependency_blocked: https://cdn.jsdelivr.net/… " instead of "uniform_canvas".
 *
 * EVERYTHING HERE IS UNTRUSTED INPUT. The page chooses its URLs, its console text and its
 * exception messages, and they end up in logs the team reads. So every field is bounded (count,
 * length), sanitised (control characters and bidi marks stripped) and stripped of query strings —
 * a query can carry a token, and no diagnostic needs one.
 */

import { sanitizeUntrustedText } from './captureTypes.js';

/** Caps. Small on purpose: this is evidence, not telemetry. */
export const MAX_AUDIT_ENTRIES = 20;
export const MAX_AUDIT_TEXT = 200;

/** Origins whose appearance means the package is not self-contained. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export interface FailedRequest {
  /** Origin + path only — never the query string. */
  url: string;
  /** Chrome's error text (`net::ERR_NAME_NOT_RESOLVED`, …), sanitised. */
  errorText: string;
  /** True when the URL did not target the loopback package server. */
  external: boolean;
}

export interface PageException {
  text: string;
}

/**
 * What the page did, bounded. Collected by the backend from CDP events and read after a failure.
 */
export class PageAudit {
  private readonly failed: FailedRequest[] = [];
  private readonly exceptions: PageException[] = [];
  private readonly consoleErrors: string[] = [];
  private overflow = 0;

  /** Strip the query, cap the length, remove control characters — untrusted, every time. */
  private static safeUrl(raw: string): string {
    let shown: string;
    try {
      const u = new URL(raw);
      shown = `${u.origin}${u.pathname}`;
    } catch {
      shown = raw.split('?')[0] ?? raw;
    }
    return sanitizeUntrustedText(shown, { maxBytes: MAX_AUDIT_TEXT, maxLines: 1 });
  }

  static isExternalUrl(raw: string): boolean {
    try {
      const u = new URL(raw);
      if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'about:') return false;
      return !LOOPBACK_HOSTS.has(u.hostname);
    } catch {
      return false;
    }
  }

  recordFailedRequest(url: string, errorText: string): void {
    if (this.failed.length >= MAX_AUDIT_ENTRIES) { this.overflow += 1; return; }
    this.failed.push({
      url: PageAudit.safeUrl(url),
      errorText: sanitizeUntrustedText(errorText, { maxBytes: 80, maxLines: 1 }),
      external: PageAudit.isExternalUrl(url),
    });
  }

  recordException(text: string): void {
    if (this.exceptions.length >= MAX_AUDIT_ENTRIES) { this.overflow += 1; return; }
    this.exceptions.push({ text: sanitizeUntrustedText(text, { maxBytes: MAX_AUDIT_TEXT, maxLines: 2 }) });
  }

  recordConsoleError(text: string): void {
    if (this.consoleErrors.length >= MAX_AUDIT_ENTRIES) { this.overflow += 1; return; }
    this.consoleErrors.push(sanitizeUntrustedText(text, { maxBytes: MAX_AUDIT_TEXT, maxLines: 2 }));
  }

  /** Requests that left loopback — each one is a package that is not self-contained. */
  externalFailures(): FailedRequest[] {
    return this.failed.filter((f) => f.external);
  }

  get isEmpty(): boolean {
    return this.failed.length === 0 && this.exceptions.length === 0 && this.consoleErrors.length === 0;
  }

  /**
   * Turn the audit into ONE sanitized sentence to append to a failure reason.
   *
   * Ordered by what an operator should look at first: a request that left loopback means the
   * package still has an external dependency (the whole class of the v0.1.26 incident); a local
   * 404 means the package is torn; an exception means it loaded and then broke.
   */
  summarise(): string | null {
    const external = this.externalFailures();
    if (external.length > 0) {
      const shown = external.slice(0, 3).map((f) => `${f.url} (${f.errorText})`).join('; ');
      return `${external.length} request(s) left loopback and failed — the package is not self-contained: ${shown}`;
    }
    const local = this.failed.filter((f) => !f.external);
    if (local.length > 0) {
      return `${local.length} package request(s) failed: ${local.slice(0, 3).map((f) => `${f.url} (${f.errorText})`).join('; ')}`;
    }
    if (this.exceptions.length > 0) {
      return `${this.exceptions.length} uncaught page exception(s): ${this.exceptions.slice(0, 2).map((e) => e.text).join('; ')}`;
    }
    if (this.consoleErrors.length > 0) {
      return `${this.consoleErrors.length} console error(s): ${this.consoleErrors.slice(0, 2).join('; ')}`;
    }
    return null;
  }

  /**
   * The precise failure code for a gate rejection, chosen from what the page actually did.
   *
   * The gate's own verdict ("uniform canvas") is a SYMPTOM. This names the cause when the evidence
   * supports one, and otherwise leaves the symptom in place rather than inventing a story.
   */
  classify(gateReason: string | undefined, webgl?: { attempted: boolean; ok: boolean }): string {
    if (this.externalFailures().length > 0) return 'external_dependency_blocked';
    if (this.failed.length > 0) return 'module_load_failed';
    if (this.exceptions.length > 0) return 'runtime_exception';
    // The page ASKED for a WebGL context and did not get one — a renderer problem, not a dead
    // scene. Without this branch it fell through to 'uniform_canvas', which sends the next
    // operator to look at the simulation instead of at the GPU stack.
    if (webgl && webgl.attempted && !webgl.ok) return 'webgl_context_failed';
    if (gateReason?.includes('uniform')) return 'uniform_canvas';
    if (gateReason?.includes('did not change')) return 'static_canvas';
    return 'sanity_gate_failed';
  }
}
