/**
 * The page audit — the evidence that turns "uniform canvas" into a cause.
 *
 * v0.1.26 failed with a truthful symptom and no cause; the CDP events that explained it were never
 * subscribed. These tests pin what the audit records, what it REFUSES to record (the page controls
 * every byte here), and the classification an operator reads first.
 */

import { describe, expect, it } from 'vitest';

import { MAX_AUDIT_ENTRIES, PageAudit } from '../pageAudit.js';

describe('PageAudit — classification', () => {
  it('a request that LEFT loopback is the v0.1.26 signature and outranks every other symptom', () => {
    const audit = new PageAudit();
    audit.recordFailedRequest('https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js', 'net::ERR_NAME_NOT_RESOLVED');
    audit.recordException('TypeError: THREE is undefined');

    expect(audit.classify('every sampled canvas frame is uniform')).toBe('external_dependency_blocked');
    const summary = audit.summarise()!;
    expect(summary).toMatch(/left loopback/);
    expect(summary).toContain('cdn.jsdelivr.net');
    expect(summary).toContain('ERR_NAME_NOT_RESOLVED');
  });

  it('a failed LOOPBACK request is a torn package, not a dependency problem', () => {
    const audit = new PageAudit();
    audit.recordFailedRequest('http://127.0.0.1:44311/scene/src/main.js', 'net::ERR_FILE_NOT_FOUND');
    expect(audit.classify(undefined)).toBe('module_load_failed');
    expect(audit.summarise()).toMatch(/package request\(s\) failed/);
    expect(audit.externalFailures()).toEqual([]);
  });

  it('an uncaught exception ranks below load failures but above the gate symptom', () => {
    const audit = new PageAudit();
    audit.recordException('ReferenceError: boot is not defined');
    expect(audit.classify('every sampled canvas frame is uniform')).toBe('runtime_exception');
  });

  it('with no evidence, the gate symptom stands — no cause is invented', () => {
    const audit = new PageAudit();
    expect(audit.isEmpty).toBe(true);
    expect(audit.summarise()).toBeNull();
    expect(audit.classify('every sampled canvas frame is uniform (dead/black canvas)')).toBe('uniform_canvas');
    expect(audit.classify('the canvas did not change across frames')).toBe('static_canvas');
    expect(audit.classify(undefined)).toBe('sanity_gate_failed');
  });

  it('localhost/127.0.0.1/::1 and data:/blob: are NOT external', () => {
    for (const url of ['http://127.0.0.1:9/x.js', 'http://localhost:9/x.js', 'data:text/css,a{}', 'blob:http://127.0.0.1/x']) {
      expect(PageAudit.isExternalUrl(url), url).toBe(false);
    }
    for (const url of ['https://cdn.jsdelivr.net/x', 'https://fonts.gstatic.com/f.woff2', 'http://10.0.0.5/y']) {
      expect(PageAudit.isExternalUrl(url), url).toBe(true);
    }
  });
});

describe('PageAudit — the page is UNTRUSTED', () => {
  it('strips the query string: a URL can carry a token and no diagnostic needs one', () => {
    const audit = new PageAudit();
    audit.recordFailedRequest('https://evil.example/collect?token=SECRET-VALUE&x=1', 'failed');
    const summary = audit.summarise()!;
    expect(summary).toContain('evil.example/collect');
    expect(summary).not.toContain('SECRET-VALUE');
    expect(summary).not.toContain('token=');
  });

  it('strips control characters and bidi overrides — a log line cannot be rewritten by the page', () => {
    const audit = new PageAudit();
    audit.recordException('boom\u001b[2Kfake-line\u202ereversed\u0000');
    const summary = audit.summarise()!;
    expect(summary).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/); // eslint-disable-line no-control-regex
    expect(summary).not.toContain('\u202e');
    expect(summary).toContain('boom');
  });

  it('is BOUNDED: a page requesting thousands of missing files cannot grow the record', () => {
    const audit = new PageAudit();
    for (let i = 0; i < 500; i++) audit.recordFailedRequest(`https://evil.example/${i}.js`, 'failed');
    expect(audit.externalFailures().length).toBe(MAX_AUDIT_ENTRIES);
    // The count in the summary still reports only what was RECORDED — it never claims more.
    expect(audit.summarise()).toMatch(new RegExp(`^${MAX_AUDIT_ENTRIES} request\\(s\\) left loopback`));
  });

  it('caps a single absurd URL rather than emitting it whole', () => {
    const audit = new PageAudit();
    audit.recordFailedRequest(`https://evil.example/${'a'.repeat(50_000)}`, 'failed');
    expect(audit.summarise()!.length).toBeLessThan(1_000);
  });
});
