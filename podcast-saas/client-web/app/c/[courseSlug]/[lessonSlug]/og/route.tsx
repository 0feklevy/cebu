import { ImageResponse } from 'next/og';
import { getLessonPage } from '@/lib/courseApi';

export const revalidate = 300;

const BRAND = process.env.PUBLIC_BRAND_NAME ?? 'Interactive Video Studio';
const SIZE = { width: 1200, height: 630 };

// Deterministic lesson OG image. Cache-busted by the ?v= version on the URL.
export async function GET(_req: Request, { params }: { params: Promise<{ courseSlug: string; lessonSlug: string }> }) {
  const { courseSlug, lessonSlug } = await params;
  const result = await getLessonPage(courseSlug, lessonSlug);
  const title = result.status === 'ok' ? result.data.title : BRAND;
  const courseTitle = result.status === 'ok' ? result.data.courseTitle : BRAND;

  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 20, background: '#0b0b0f', color: 'white', padding: 80, fontFamily: 'sans-serif' }}>
        <div style={{ fontSize: 26, opacity: 0.65, display: 'flex' }}>{courseTitle.slice(0, 80)}</div>
        <div style={{ fontSize: 60, fontWeight: 700, lineHeight: 1.1, display: 'flex' }}>{title.slice(0, 110)}</div>
        <div style={{ fontSize: 26, opacity: 0.6 }}>{BRAND}</div>
      </div>
    ),
    {
      ...SIZE,
      headers: { 'Cache-Control': 'public, max-age=300, s-maxage=86400, stale-while-revalidate=604800' },
    },
  );
}
