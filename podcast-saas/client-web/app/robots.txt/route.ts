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
    // The podcast EDITOR, in the same category as the two above and missed until the P3-A rename
    // made the omission visible. Both forms: the new home, and the legacy tree that now serves
    // 308s — a crawler following those spends a round trip to be told what robots.txt could have
    // said for free, and the redirect targets are disallowed anyway.
    'Disallow: /edit-podcasts/',
    'Disallow: /podcasts/',
    'Disallow: /new',
    'Disallow: /unlock',
    'Disallow: /api/',
    // Library mini-sites (migration 065), on BOTH URL forms — the coded slug and the clean
    // permalink alias. Decided explicitly rather than by omission: a title-derived URL that is
    // guessable is one thing, one that is searchable is another. The pages also emit
    // `robots: noindex` in their metadata, so this is belt and braces rather than the only guard.
    'Disallow: /*/library',
    '',
    `Sitemap: ${base}/sitemap.xml`,
    '',
  ].join('\n');
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
