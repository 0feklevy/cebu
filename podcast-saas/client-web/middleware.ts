import { NextResponse, type NextRequest } from 'next/server';

/**
 * Edge middleware for the public publishing runtime:
 *  - /c/*  : sets the HTTP status a Server Component page cannot — 410 for a
 *            permanently-archived course, a permanent redirect for an archived
 *            'redirect' disposition. (404/200 fall through to the page.)
 *  - /v/*, /pl/* : conditional legacy → /c/ permanent redirects, gated behind
 *            COURSE_LEGACY_REDIRECTS_ENABLED. When disabled or no valid public
 *            target exists, the request falls through to the existing token viewer.
 *
 * All redirect targets are absolute /c/ URLs (never token/preview), so there are
 * no chains or loops. Only approved tracking query params are preserved.
 */

const BACKEND = process.env.BACKEND_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:8080');
const LEGACY_REDIRECTS_ENABLED = process.env.COURSE_LEGACY_REDIRECTS_ENABLED === 'true';
const APPROVED_PARAMS = new Set(['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref']);

export const config = {
  matcher: ['/c/:path*', '/v/:path*', '/pl/:path*'],
};

function preservedQuery(req: NextRequest): string {
  const keep = new URLSearchParams();
  for (const [k, v] of req.nextUrl.searchParams) {
    if (APPROVED_PARAMS.has(k.toLowerCase())) keep.set(k, v);
  }
  const s = keep.toString();
  return s ? `?${s}` : '';
}

function withQuery(url: string, req: NextRequest): string {
  // Target is an absolute /c/ URL from the backend; append only approved params.
  return `${url.replace(/\?.*$/, '')}${preservedQuery(req)}`;
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

const GONE_HTML =
  '<!doctype html><html lang="en"><head><meta name="robots" content="noindex"><title>Gone</title></head>' +
  '<body style="font-family:sans-serif;padding:3rem;text-align:center"><h1>410 — Content removed</h1>' +
  '<p>This course has been permanently removed.</p></body></html>';

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;
  const segments = pathname.split('/').filter(Boolean); // e.g. ['c','slug','lesson']

  // ── /c/* archive status (skip OG image + asset routes) ──────────────────────
  if (segments[0] === 'c' && segments[segments.length - 1] !== 'og') {
    const courseSlug = segments[1];
    const lessonSlug = segments[2];
    if (courseSlug) {
      const statusPath = lessonSlug
        ? `/api/v1/public/courses/${encodeURIComponent(courseSlug)}/lessons/${encodeURIComponent(lessonSlug)}/status`
        : `/api/v1/public/courses/${encodeURIComponent(courseSlug)}/status`;
      const res = await fetchJson<{ status: string; redirectUrl?: string }>(`${BACKEND}${statusPath}`);
      if (res?.status === 'gone') {
        return new NextResponse(GONE_HTML, { status: 410, headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      if (res?.status === 'redirect' && res.redirectUrl) {
        return NextResponse.redirect(withQuery(res.redirectUrl, req), 308);
      }
    }
    return NextResponse.next();
  }

  // ── Legacy token routes (flag-gated) ────────────────────────────────────────
  if ((segments[0] === 'v' || segments[0] === 'pl') && LEGACY_REDIRECTS_ENABLED) {
    const token = segments[1];
    if (token) {
      const kind = segments[0] === 'v' ? 'project' : 'playlist';
      const res = await fetchJson<{ redirectUrl: string | null }>(
        `${BACKEND}/api/v1/public/legacy-redirect/${kind}/${encodeURIComponent(token)}`,
      );
      if (res?.redirectUrl) {
        return NextResponse.redirect(withQuery(res.redirectUrl, req), 308);
      }
    }
  }

  return NextResponse.next();
}
