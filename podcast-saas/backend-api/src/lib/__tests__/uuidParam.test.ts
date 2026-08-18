/**
 * backend-001 — the shared pieces: the path-parameter guard and the 22P02 net.
 *
 * The route-level proof lives in `controllers/v1/__tests__/player.uuidParams.test.ts`. This file
 * pins the reusable machinery those routes (and every route that adopts it next) depend on.
 */
import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';

vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { isUuid, isPgUuidLiteral, isUuidSyntaxError, requireUuidParams } = await import('../uuidParam.js');
const { apiErrorHandler } = await import('../apiErrorHandler.js');
const { logger } = await import('../logger.js');

describe('isUuid', () => {
  it('accepts canonical uuids in either case', () => {
    expect(isUuid('11111111-1111-4111-8111-111111111111')).toBe(true);
    expect(isUuid('AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE')).toBe(true);
    // Version/variant nibbles are not checked — matching mediaAccess.ts's existing UUID_RE.
    expect(isUuid('00000000-0000-0000-0000-000000000000')).toBe(true);
  });

  it('rejects everything that is not the canonical spelling', () => {
    for (const bad of [
      'banana', '12345', '', ' ',
      '11111111-1111-4111-8111',                          // short a group
      '11111111-1111-4111-8111-111111111111-1111',        // extra group
      '1111111z-1111-4111-8111-111111111111',             // non-hex
      ' 11111111-1111-4111-8111-111111111111',            // leading space
      '11111111-1111-4111-8111-111111111111\n',           // trailing newline (anchors must be ^$)
    ]) {
      expect(isUuid(bad), bad).toBe(false);
    }
  });

  it('rejects non-strings without throwing', () => {
    for (const bad of [undefined, null, 42, {}, []]) expect(isUuid(bad)).toBe(false);
  });
});

describe('isPgUuidLiteral — the question the guard must actually ask', () => {
  // An earlier draft used `isUuid` in the guard and listed the two forms below as things to
  // REJECT. They are not rejectable: Postgres resolves them to the same row (verified against a
  // real database, which is how the mistake was caught). Rejecting them would have 404'd working
  // URLs with a body that reads "does not exist".
  it('accepts every alternative spelling Postgres documents', () => {
    for (const ok of [
      '11111111-1111-4111-8111-111111111111',             // canonical
      'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE',             // upper case
      '11111111111141118111111111111111',                 // fully hyphenless
      '{11111111-1111-4111-8111-111111111111}',           // braced
      '{11111111111141118111111111111111}',               // braced AND hyphenless
      '1111-1111-1111-4111-8111-1111-1111-1111',          // hyphen after any group of four
    ]) {
      expect(isPgUuidLiteral(ok), ok).toBe(true);
    }
  });

  it('still rejects what no database would parse', () => {
    for (const bad of [
      'banana', '', ' ', '12345',
      '1111111z-1111-4111-8111-111111111111',             // non-hex
      '11111111-1111-4111-8111',                          // 16 hex, too short
      '11111111-1111-4111-8111-111111111111-1111',        // 36 hex, too long
      ' 11111111-1111-4111-8111-111111111111',            // leading space survives the strip
      '{11111111-1111-4111-8111-111111111111',            // unbalanced brace
      undefined, null, 42, {}, [],
    ]) {
      expect(isPgUuidLiteral(bad as unknown), String(bad)).toBe(false);
    }
  });
});

describe('isUuidSyntaxError', () => {
  it('recognises a uuid parse failure', () => {
    const err = Object.assign(new Error('invalid input syntax for type uuid: "banana"'), { code: '22P02' });
    expect(isUuidSyntaxError(err)).toBe(true);
  });

  it('leaves the REST of 22P02 alone, because most of it is our own bug', () => {
    // 22P02 is `invalid_text_representation` for EVERY type. The values bound into this schema's
    // 20 enums, 39 jsonb, 93 numeric and 92 timestamp columns are written by this service, not by
    // a caller — so treating a bare 22P02 as a client fault would answer 400 for a server bug and
    // drop it out of the 5xx alarm. These must stay 500.
    for (const msg of [
      'invalid input syntax for type integer: "abc"',
      'invalid input syntax for type timestamp with time zone: "nope"',
      'invalid input syntax for type json',
      'invalid input value for enum job_status: "wat"',
      'invalid input syntax for type boolean: "maybe"',
    ]) {
      expect(isUuidSyntaxError(Object.assign(new Error(msg), { code: '22P02' })), msg).toBe(false);
    }
  });

  it('does not mistake other coded errors for a client fault', () => {
    // The narrowness is the point: a filesystem or connection error must stay a 500.
    expect(isUuidSyntaxError(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe(false);
    expect(isUuidSyntaxError(Object.assign(new Error('x'), { code: '23505' }))).toBe(false);
    expect(isUuidSyntaxError(new Error('invalid input syntax for type uuid'))).toBe(false);
    expect(isUuidSyntaxError(null)).toBe(false);
    expect(isUuidSyntaxError(undefined)).toBe(false);
  });
});

describe('requireUuidParams', () => {
  async function appWith(names: string | string[], message?: string, path = '/x/:id') {
    const app = Fastify();
    const handler = vi.fn(async () => ({ ok: true }));
    app.get(path, { preHandler: [requireUuidParams(names, message)] }, handler);
    await app.ready();
    return { app, handler };
  }

  it('404s a malformed param with the supplied body and never runs the handler', async () => {
    const { app, handler } = await appWith('id', 'Project not found');
    const res = await app.inject({ method: 'GET', url: '/x/banana' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ message: 'Project not found' });
    expect(handler).not.toHaveBeenCalled();
    await app.close();
  });

  it('defaults to a generic body when no message is given', async () => {
    const { app } = await appWith('id');
    expect((await app.inject({ method: 'GET', url: '/x/banana' })).json()).toEqual({ message: 'Not found' });
    await app.close();
  });

  it('passes a canonical uuid through to the handler', async () => {
    const { app, handler } = await appWith('id');
    const res = await app.inject({ method: 'GET', url: '/x/11111111-1111-4111-8111-111111111111' });
    expect(res.statusCode).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('checks every named param, not just the first', async () => {
    const { app, handler } = await appWith(['id', 'videoId'], 'Not found', '/x/:id/v/:videoId');
    const good = '11111111-1111-4111-8111-111111111111';
    expect((await app.inject({ method: 'GET', url: `/x/${good}/v/banana` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/x/banana/v/${good}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/x/${good}/v/${good}` })).statusCode).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('skips a param the route does not declare, so one guard serves sibling routes', async () => {
    // `['id','videoId']` on a route that only has `:id` must not 404 for the missing one.
    const { app, handler } = await appWith(['id', 'videoId'], 'Not found', '/x/:id');
    const res = await app.inject({ method: 'GET', url: '/x/11111111-1111-4111-8111-111111111111' });
    expect(res.statusCode).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    await app.close();
  });
});

describe('apiErrorHandler — the 22P02 net under unadopted routes', () => {
  async function appThrowing(err: unknown) {
    const app = Fastify();
    app.get('/boom', async () => { throw err; });
    app.setErrorHandler(apiErrorHandler);
    await app.ready();
    return app;
  }

  it('maps a Postgres 22P02 to 400, not 500', async () => {
    vi.mocked(logger.warn).mockClear();
    const app = await appThrowing(
      Object.assign(new Error('invalid input syntax for type uuid: "banana"'), { code: '22P02' }),
    );
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error_type: 'invalid_identifier', message: 'Invalid identifier' });
    // The Postgres text names the bad value — it must not be echoed to the client.
    expect(res.body).not.toContain('banana');
    // Downgrading the status must not make a genuine server-side 22P02 invisible.
    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('still 500s and scrubs an ordinary unhandled error', async () => {
    const app = await appThrowing(new Error('connection string postgres://user:pw@host/db failed'));
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error_type: 'server_error', message: 'Internal server error' });
    expect(res.body).not.toContain('postgres://');
    await app.close();
  });

  it('preserves an explicit 4xx statusCode and its message', async () => {
    const app = await appThrowing(Object.assign(new Error('Nope'), { statusCode: 403 }));
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error_type: 'server_error', message: 'Nope' });
    await app.close();
  });

  it('preserves a custom error_type', async () => {
    const app = await appThrowing(Object.assign(new Error('bad'), { statusCode: 422, error_type: 'llm_error' }));
    expect((await app.inject({ method: 'GET', url: '/boom' })).json()).toEqual({
      error_type: 'llm_error', message: 'bad',
    });
    await app.close();
  });
});
