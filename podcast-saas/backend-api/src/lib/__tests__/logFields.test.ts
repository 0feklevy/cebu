/**
 * observability-003, redaction half — what may go into a structured log field.
 *
 * The error boundary already logged `url: request.url`, and `request.url` is not a safe field on
 * this API: `middleware/firebase-auth.ts` accepts the Firebase id token in `?token=` because
 * EventSource cannot set an Authorization header, and `client-web/components/SectionEditor.tsx`
 * sends it that way. So every malformed-id 22P02 warning on an SSE stream wrote a live credential
 * to the log. Adding MORE logging (which is the whole point of this stream) makes that worse unless
 * the safe accessor is the only one anybody reaches for.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyRequest, FastifyReply } from 'fastify';

vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { safeRequestPath } = await import('../logFields.js');
const { apiErrorHandler } = await import('../apiErrorHandler.js');
const { logger } = await import('../logger.js');

function fakeRequest(url: string, routePattern?: string): FastifyRequest {
  return {
    url,
    method: 'GET',
    routeOptions: routePattern ? { url: routePattern } : {},
  } as unknown as FastifyRequest;
}

function fakeReply(): FastifyReply & { sent: { code?: number; body?: unknown } } {
  const sent: { code?: number; body?: unknown } = {};
  const reply = {
    sent,
    code(c: number) { sent.code = c; return reply; },
    send(b: unknown) { sent.body = b; return reply; },
  };
  return reply as unknown as FastifyReply & { sent: { code?: number; body?: unknown } };
}

describe('safeRequestPath', () => {
  it('prefers the matched route pattern, so ids do not explode log cardinality', () => {
    expect(safeRequestPath(fakeRequest('/api/v1/projects/abc-123/sections?x=1', '/api/v1/projects/:id/sections')))
      .toBe('/api/v1/projects/:id/sections');
  });

  it('falls back to the path with the query cut off', () => {
    expect(safeRequestPath(fakeRequest('/api/v1/stream?token=SECRET'))).toBe('/api/v1/stream');
    expect(safeRequestPath(fakeRequest('/api/v1/stream'))).toBe('/api/v1/stream');
  });

  it('never returns the query string, whatever is in it', () => {
    for (const url of [
      '/a?token=SECRET',
      '/a?foo=1&token=SECRET',
      '/a?token=SECRET#frag',
      '/a??token=SECRET',
    ]) {
      expect(safeRequestPath(fakeRequest(url)), url).not.toContain('SECRET');
    }
  });

  it('tolerates a request with no url at all', () => {
    expect(safeRequestPath({ } as unknown as FastifyRequest)).toBe('');
  });
});

describe('apiErrorHandler log redaction', () => {
  beforeEach(() => { vi.mocked(logger.warn).mockClear(); vi.mocked(logger.error).mockClear(); });

  it('does not write the id token from ?token= when it rejects a malformed identifier', () => {
    const err = Object.assign(new Error('invalid input syntax for type uuid: "banana"'), { code: '22P02' });
    apiErrorHandler(err, fakeRequest('/api/v1/sections/banana/stream?token=SUPER-SECRET-ID-TOKEN'), fakeReply());
    expect(vi.mocked(logger.warn)).toHaveBeenCalled();
    const serialized = JSON.stringify(vi.mocked(logger.warn).mock.calls);
    expect(serialized, 'the error boundary logged the raw url, token and all').not.toContain('SUPER-SECRET-ID-TOKEN');
    expect(serialized).toContain('/api/v1/sections/banana/stream');
  });

  it('says WHICH request blew up when it logs a 5xx', () => {
    // `logger.error({ err }, 'Unhandled server error')` named no route at all: an operator saw a
    // stack trace with nothing to join it to.
    apiErrorHandler(new Error('boom'), fakeRequest('/api/v1/projects/x/export?token=SUPER-SECRET-ID-TOKEN', '/api/v1/projects/:id/export'), fakeReply());
    expect(vi.mocked(logger.error)).toHaveBeenCalled();
    const payload = vi.mocked(logger.error).mock.calls[0][0] as Record<string, unknown>;
    expect(payload.method, 'the 5xx line does not say which request failed').toBe('GET');
    expect(payload.path).toBe('/api/v1/projects/:id/export');
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain('SUPER-SECRET-ID-TOKEN');
  });

  it('still answers the client exactly as before', () => {
    const reply = fakeReply();
    apiErrorHandler(new Error('boom'), fakeRequest('/x'), reply);
    expect(reply.sent.code).toBe(500);
    expect(reply.sent.body).toEqual({ error_type: 'server_error', message: 'Internal server error' });
  });
});
