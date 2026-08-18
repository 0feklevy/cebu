/**
 * test-quality-014 — `shared/src/generated/client-v1.ts` is 1,693 hand-maintained lines living in
 * a directory called "generated". Nothing generates it, nothing checked it, and the only thing
 * that told you a method pointed at a route the backend does not serve was a 404 in production.
 *
 * This is that check. It reads BOTH sides as text and asserts every `ClientV1Api` call has a
 * matching `app.<verb>('<path>')` registration somewhere in `backend-api/src`.
 *
 * WHY TEXT AND NOT A BOOTED APP. Building the real Fastify instance would need the database, the
 * Firebase admin SDK, Stripe, four LLM clients and the queue driver stubbed before a single route
 * could be counted — a harness with more moving parts than the thing under test, and one that
 * would go red for reasons having nothing to do with the contract. The route table is declarative
 * text on both sides, so text is where it is cheapest to read honestly.
 *
 * TWO PARSING FACTS THIS FILE EARNS, both of which produced false drift on the first attempt and
 * are pinned by the self-tests below:
 *
 *   1. A route's first argument is NOT the first quoted string after `app.post`. The generic
 *      parameter comes first and is full of string-literal types (`track: 'main' | 'broll'`), so a
 *      naive scan reported `POST /projects/:id/sections` as missing when it is registered at
 *      sections.controller.ts:567. The generic is skipped by matching angle brackets.
 *   2. Some routes are registered from a template — `collaborators.controller.ts` registers
 *      `${base}/:id/collaborators` twice, once per content type. That prefix cannot be resolved
 *      statically, so such a pattern is matched by its resolvable SUFFIX. A deliberate relaxation
 *      for three routes, not a hole in the other 268.
 *
 * A path parameter is a wildcard on both sides: `${projectId}` and `:id` both become `*`, because
 * what is under test is the route's SHAPE, not the caller's variable names.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND_SRC = resolve(HERE, '../..');
const CLIENT_V1 = resolve(HERE, '../../../../shared/src/generated/client-v1.ts');

type Call = { method: string; path: string };

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== '__tests__' && entry !== 'node_modules' && entry !== '_archive') walk(full, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Skip a balanced `<...>` generic parameter list, if one is present. */
export function skipGeneric(src: string, from: number): number {
  let i = from;
  while (i < src.length && /\s/.test(src[i])) i++;
  if (src[i] !== '<') return i;
  let depth = 0;
  while (i < src.length) {
    if (src[i] === '<') depth++;
    else if (src[i] === '>' && --depth === 0) return i + 1;
    i++;
  }
  return i;
}

/** The first argument of the call starting at `from`, when it is a string or template literal. */
export function firstStringArg(src: string, from: number): string | null {
  let i = from;
  while (i < src.length && /\s/.test(src[i])) i++;
  if (src[i] !== '(') return null;
  i++;
  while (i < src.length && /\s/.test(src[i])) i++;
  const quote = src[i];
  if (quote !== "'" && quote !== '`') return null;
  const end = src.indexOf(quote, i + 1);
  return end === -1 ? null : src.slice(i + 1, end);
}

export function collectServerRoutes(files: Array<{ path: string; source: string }>): Call[] {
  const verb = /\bapp\.(get|post|put|patch|delete|head|options)\b/g;
  const found: Call[] = [];
  for (const { source } of files) {
    for (const m of source.matchAll(verb)) {
      const literal = firstStringArg(source, skipGeneric(source, m.index! + m[0].length));
      if (literal && (literal.startsWith('/') || literal.includes('${'))) {
        found.push({ method: m[1].toUpperCase(), path: literal });
      }
    }
  }
  return found;
}

export function collectClientCalls(source: string): Call[] {
  const call = /this\.request(?:<[^>]*>)?\(\s*`([^`]+)`([^;]*?)\)\s*;/gs;
  const found: Call[] = [];
  for (const m of source.matchAll(call)) {
    const method = /method:\s*'([A-Z]+)'/.exec(m[2])?.[1] ?? 'GET';
    found.push({ method, path: m[1] });
  }
  return found;
}

/**
 * `${projectId}` becomes `*`; a query string is not part of the route. A `${…}` glued to the END
 * of a segment is an interpolated query string (`…/script${q}`), not a path parameter.
 */
export function normalizeClientPath(path: string): string {
  return path
    .split('?')[0]
    .replace(/\$\{[^}]*\}/g, '*')
    .replace(/\/$/, '')
    .split('/')
    .map((seg) => (seg === '*' ? '*' : seg.replace(/\*/g, '')))
    .join('/');
}

/** A marker for a `${prefix}` this parser cannot resolve. No real route contains it literally. */
const UNRESOLVED = '<<unresolved-prefix>>';

/** `:id` becomes `*`; an unresolvable `${base}` prefix becomes the marker above. */
export function normalizeServerPath(path: string): string {
  return path
    .replace(/:[A-Za-z_][A-Za-z0-9_]*/g, '*')
    .replace(/\$\{[^}]*\}/g, UNRESOLVED)
    .replace(/\/$/, '');
}

export function findUnservedCalls(clientCalls: Call[], serverRoutes: Call[]): Call[] {
  const exact = new Set<string>();
  const bySuffix: Call[] = [];
  for (const route of serverRoutes) {
    const norm = normalizeServerPath(route.path);
    if (norm.includes(UNRESOLVED)) {
      bySuffix.push({ method: route.method, path: norm.split(UNRESOLVED).pop()! });
    } else {
      exact.add(`${route.method} ${norm}`);
    }
  }
  return clientCalls.filter((call) => {
    const norm = normalizeClientPath(call.path);
    if (exact.has(`${call.method} ${norm}`)) return false;
    return !bySuffix.some((s) => s.method === call.method && norm.endsWith(s.path));
  });
}

const backendFiles = walk(BACKEND_SRC).map((path) => ({ path, source: readFileSync(path, 'utf8') }));
const clientSource = readFileSync(CLIENT_V1, 'utf8');
const serverRoutes = collectServerRoutes(backendFiles);
const clientCalls = collectClientCalls(clientSource);

describe('ClientV1Api and the backend route table agree', () => {
  it('finds both sides — a parser that silently reads nothing would pass everything', () => {
    expect(clientCalls.length).toBeGreaterThan(100);
    expect(serverRoutes.length).toBeGreaterThan(200);
  });

  it('every generated client call has a route that serves it', () => {
    const unserved = findUnservedCalls(clientCalls, serverRoutes);
    expect(unserved.map((c) => `${c.method} ${c.path}`)).toEqual([]);
  });

  it('covers every HTTP verb the client uses', () => {
    expect([...new Set(clientCalls.map((c) => c.method))].sort())
      .toEqual(['DELETE', 'GET', 'PATCH', 'POST', 'PUT']);
  });
});

describe('the parser itself — the two facts that produced false drift', () => {
  it('skips a generic full of string-literal types before reading the path', () => {
    const src = "app.post<{ Params: { id: string }; Body: { track: 'main' | 'broll' } }>(\n  '/api/v1/projects/:id/sections',";
    expect(collectServerRoutes([{ path: 'x.ts', source: src }]))
      .toEqual([{ method: 'POST', path: '/api/v1/projects/:id/sections' }]);
  });

  it('reads a route registered from a template and matches it by suffix', () => {
    const server = collectServerRoutes([{ path: 'x.ts', source: 'app.get(`${base}/:id/collaborators`,' }]);
    expect(server).toEqual([{ method: 'GET', path: '${base}/:id/collaborators' }]);
    expect(findUnservedCalls(
      [{ method: 'GET', path: '/api/v1/projects/${projectId}/collaborators' }],
      server,
    )).toEqual([]);
  });

  it('treats a trailing interpolated query string as no path segment at all', () => {
    expect(normalizeClientPath('/api/v1/podcasts/${showId}/script${q}')).toBe('/api/v1/podcasts/*/script');
    expect(normalizeClientPath('/api/v1/permalink-availability?${params.toString()}'))
      .toBe('/api/v1/permalink-availability');
  });

  it('reports a call the backend does not serve', () => {
    expect(findUnservedCalls(
      [{ method: 'POST', path: '/api/v1/projects/${projectId}/teleport' }],
      [{ method: 'POST', path: '/api/v1/projects/:id/sections' }],
    )).toEqual([{ method: 'POST', path: '/api/v1/projects/${projectId}/teleport' }]);
  });

  it('does not let one verb satisfy another', () => {
    expect(findUnservedCalls(
      [{ method: 'DELETE', path: '/api/v1/projects/${projectId}' }],
      [{ method: 'GET', path: '/api/v1/projects/:id' }],
    )).toHaveLength(1);
  });
});

describe('the generated client declares no `any`', () => {
  /**
   * types-012 — `PlaylistPlayItem.config` was `any` with an eslint-disable directly above it.
   * `any` is not a way to say "the viewer owns this shape"; it switches type checking off for
   * everything downstream of the value. `unknown` says the same thing and keeps the compiler on.
   * This is the floor that stops the next one being added: `shared` has no eslint config of its
   * own, so nothing else in this repo would notice.
   */
  it('has no explicit any and no suppression of the rule that bans it', () => {
    const offenders = clientSource
      .split('\n')
      .map((line, n) => ({ line, n: n + 1 }))
      .filter(({ line }) => /:\s*any\b/.test(line) || /\bas any\b/.test(line) || line.includes('no-explicit-any'));
    expect(offenders.map((o) => `${o.n}: ${o.line.trim()}`)).toEqual([]);
  });
});
