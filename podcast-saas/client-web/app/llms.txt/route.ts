import { getCourseSitemap } from '@/lib/courseApi';

export const dynamic = 'force-dynamic'; // never serve a frozen build-time (possibly empty) sitemap

// llms.txt — a secondary, LLM-friendly index of public courses. It complements,
// and never replaces, normal SEO metadata and the XML sitemaps.
export async function GET() {
  const base = (process.env.PUBLIC_SITE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
  const brand = process.env.PUBLIC_BRAND_NAME ?? 'Interactive Video Studio';
  const courses = await getCourseSitemap();
  const body = [
    `# ${brand}`,
    '',
    'Interactive video courses. Public, server-rendered course and lesson pages.',
    '',
    '## Courses',
    ...courses.map((c) => `- ${c.loc}`),
    '',
    `## Sitemaps`,
    `- ${base}/sitemap.xml`,
    '',
  ].join('\n');
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
