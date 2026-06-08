import { getVideoSitemap } from '@/lib/courseApi';

export const dynamic = 'force-dynamic'; // never serve a frozen build-time (possibly empty) sitemap

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function iso8601(sec: number | null): string | null {
  if (sec == null || sec <= 0) return null;
  const s = Math.round(sec);
  return `PT${Math.floor(s / 60)}M${s % 60}S`;
}

export async function GET() {
  const entries = await getVideoSitemap();
  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">\n` +
    entries
      .map((e) => {
        // Only emit a <video:video> when the minimum real fields exist.
        const hasVideo = e.thumbnailUrl && e.title && (e.contentUrl || e.loc);
        const dur = iso8601(e.durationSec);
        const parts = [`  <url>`, `    <loc>${xmlEscape(e.loc)}</loc>`];
        if (hasVideo) {
          parts.push(`    <video:video>`);
          parts.push(`      <video:thumbnail_loc>${xmlEscape(e.thumbnailUrl!)}</video:thumbnail_loc>`);
          parts.push(`      <video:title>${xmlEscape(e.title)}</video:title>`);
          if (e.description) parts.push(`      <video:description>${xmlEscape(e.description)}</video:description>`);
          if (e.contentUrl) parts.push(`      <video:player_loc>${xmlEscape(e.contentUrl)}</video:player_loc>`);
          if (e.publicationDate) parts.push(`      <video:publication_date>${e.publicationDate}</video:publication_date>`);
          if (dur) parts.push(`      <video:duration>${Math.round(e.durationSec!)}</video:duration>`);
          parts.push(`    </video:video>`);
        }
        parts.push(`  </url>`);
        return parts.join('\n');
      })
      .join('\n') +
    `\n</urlset>\n`;
  return new Response(body, { headers: { 'content-type': 'application/xml; charset=utf-8' } });
}
