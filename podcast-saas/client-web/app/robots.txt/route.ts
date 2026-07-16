function siteUrl(): string {
  return (process.env.PUBLIC_SITE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:3000')).replace(/\/+$/, '');
}

// robots.txt — allows public course/lesson routes, disallows private/editor/API
// areas. Note: robots is advisory only; private content is protected by the
// publication-state checks in the backend, not by this file.
export async function GET() {
  const base = siteUrl();
  const body = [
    'User-agent: *',
    'Allow: /c/',
    'Disallow: /v/',          // legacy token viewer (unlisted/private)
    'Disallow: /pl/',         // legacy token playlist viewer
    'Disallow: /projects/',   // editor / authenticated views
    'Disallow: /playlists/',
    'Disallow: /new',
    'Disallow: /unlock',
    'Disallow: /api/',
    '',
    `Sitemap: ${base}/sitemap.xml`,
    '',
  ].join('\n');
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
