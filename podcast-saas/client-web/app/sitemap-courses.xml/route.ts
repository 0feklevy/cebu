import { getCourseSitemap } from '@/lib/courseApi';

export const dynamic = 'force-dynamic'; // never serve a frozen build-time (possibly empty) sitemap

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export async function GET() {
  const entries = await getCourseSitemap();
  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    entries
      .map((e) => `  <url><loc>${xmlEscape(e.loc)}</loc><lastmod>${e.lastModified}</lastmod></url>`)
      .join('\n') +
    `\n</urlset>\n`;
  return new Response(body, { headers: { 'content-type': 'application/xml; charset=utf-8' } });
}
