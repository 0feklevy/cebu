export const dynamic = 'force-dynamic'; // never serve a frozen build-time (possibly empty) sitemap

function siteUrl(): string {
  return (process.env.PUBLIC_SITE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
}

// Sitemap index referencing the per-type sitemaps.
export async function GET() {
  const base = siteUrl();
  const now = new Date().toISOString();
  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    `  <sitemap><loc>${base}/sitemap-courses.xml</loc><lastmod>${now}</lastmod></sitemap>\n` +
    `  <sitemap><loc>${base}/sitemap-videos.xml</loc><lastmod>${now}</lastmod></sitemap>\n` +
    `</sitemapindex>\n`;
  return new Response(body, { headers: { 'content-type': 'application/xml; charset=utf-8' } });
}
