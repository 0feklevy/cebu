/**
 * security-011 — a Firebase ID token may travel in a URL on TWO routes and nowhere else.
 *
 * The query-string fallback exists for a real reason: the browser's `EventSource` cannot set an
 * Authorization header, so an SSE stream has no other way to carry a credential. It was implemented
 * in the shared middleware, which meant every route using that middleware accepted a live token in
 * its URL — while exactly one client call site ever sent one.
 *
 * A credential in a URL is retained by things nobody audits: the nginx access log, browser history,
 * and the `Referer` header of every subsequent request from the page. The nginx half of this fix
 * strips the query string from `log_format`; this half is the boundary itself.
 *
 * These assertions are on `bearerTokenFor`, the exported decision function, because the question
 * "which routes accept a token in the URL" is a rule and should be readable as one.
 */
import { describe, it, expect } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { bearerTokenFor } from '../firebase-auth.js';

const req = (opts: {
  route?: string;
  query?: Record<string, string>;
  header?: string;
}): FastifyRequest => ({
  headers: opts.header ? { authorization: opts.header } : {},
  query: opts.query ?? {},
  routeOptions: opts.route ? { url: opts.route } : undefined,
} as unknown as FastifyRequest);

const SSE_GENERATE = '/api/v1/projects/:id/simulations/:simId/generate-guidance/stream';
const SSE_PUBLISH = '/api/v1/projects/:id/simulations/:simId/publish-guidance/stream';

describe('bearerTokenFor', () => {
  it('takes the Authorization header on any route', () => {
    expect(bearerTokenFor(req({ route: '/api/v1/projects/:id', header: 'Bearer abc' }))).toBe('abc');
  });

  it('accepts ?token= on the two SSE routes that cannot send a header', () => {
    for (const route of [SSE_GENERATE, SSE_PUBLISH]) {
      expect(bearerTokenFor(req({ route, query: { token: 'sse-token' } })), route).toBe('sse-token');
    }
  });

  it('IGNORES ?token= on every other route', () => {
    // The defect: this middleware is a preHandler on most of the API, so before this rule every
    // one of these would have authenticated from a credential sitting in the access log.
    for (const route of [
      '/api/v1/projects/:id',
      '/api/v1/projects/:id/dubs',
      '/api/v1/projects/:id/avatar/knowledge/documents/:docId',
      '/api/v1/projects/:id/simulations/:simId',
    ]) {
      expect(bearerTokenFor(req({ route, query: { token: 'leaked' } })), route).toBeUndefined();
    }
  });

  it('ignores ?token= when the route is unknown, rather than defaulting to permissive', () => {
    expect(bearerTokenFor(req({ query: { token: 'leaked' } }))).toBeUndefined();
  });

  it('prefers the header even on an SSE route, so a capable client never puts one in the URL', () => {
    expect(bearerTokenFor(req({
      route: SSE_GENERATE, header: 'Bearer from-header', query: { token: 'from-url' },
    }))).toBe('from-header');
  });

  it('is not fooled by a path that merely resembles an allowlisted one', () => {
    // Matching is on the ROUTE PATTERN, so a literal URL cannot smuggle itself in.
    for (const route of [
      '/api/v1/projects/:id/simulations/:simId/generate-guidance/stream/extra',
      '/api/v1/projects/:id/simulations/:simId/generate-guidance',
      '/evil/api/v1/projects/:id/simulations/:simId/publish-guidance/stream',
    ]) {
      expect(bearerTokenFor(req({ route, query: { token: 'leaked' } })), route).toBeUndefined();
    }
  });

  it('treats an empty or non-string token as absent', () => {
    expect(bearerTokenFor(req({ route: SSE_GENERATE, query: { token: '' } }))).toBeUndefined();
    expect(bearerTokenFor(req({ route: SSE_GENERATE, query: {} }))).toBeUndefined();
  });

  it('ignores a malformed Authorization header rather than passing the raw value through', () => {
    expect(bearerTokenFor(req({ route: '/api/v1/projects/:id', header: 'Basic abc' }))).toBeUndefined();
  });
});
