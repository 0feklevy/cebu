import { ImageResponse } from 'next/og';
import { getCoursePage } from '@/lib/courseApi';

export const revalidate = 300;

const BRAND = process.env.PUBLIC_BRAND_NAME ?? 'Interactive Video Studio';
const SIZE = { width: 1200, height: 630 };

// Deterministic course OG image. Title + cover + branding; safe branded fallback
// when no cover exists. Only text (escaped by JSX) and an image URL are passed in
// — never raw user-controlled HTML. Cache-busted by the ?v= version on the URL.
export async function GET(_req: Request, { params }: { params: Promise<{ courseSlug: string }> }) {
  const { courseSlug } = await params;
  const result = await getCoursePage(courseSlug);
  const title = result.status === 'ok' ? result.data.title : BRAND;
  const cover = result.status === 'ok' ? result.data.coverImageUrl : null;

  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', background: '#0b0b0f', color: 'white', padding: 64, fontFamily: 'sans-serif' }}>
        {cover ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={cover} alt="" width={1072} height={360} style={{ objectFit: 'cover', borderRadius: 16 }} />
        ) : (
          <div style={{ fontSize: 28, opacity: 0.6 }}>Course</div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 56, fontWeight: 700, lineHeight: 1.1, display: 'flex' }}>{title.slice(0, 120)}</div>
          <div style={{ fontSize: 28, opacity: 0.7 }}>{BRAND}</div>
        </div>
      </div>
    ),
    {
      ...SIZE,
      headers: { 'Cache-Control': 'public, max-age=300, s-maxage=86400, stale-while-revalidate=604800' },
    },
  );
}
