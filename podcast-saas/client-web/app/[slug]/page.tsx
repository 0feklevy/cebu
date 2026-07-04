import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SharedViewerPage } from '@/components/viewer/SharedViewerPage';
import { PlaylistViewer } from '@/components/viewer/playlist/PlaylistViewer';

/**
 * Creator-controlled permalink route (migration 043): {PUBLIC_SITE_URL}/{slug}
 * resolves to a PUBLIC project or playlist. Static app routes always win over
 * this catch-all, and the backend refuses reserved slugs, so there is no overlap.
 */

const BACKEND = process.env.BACKEND_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080';
// Mirrors shared SLUG_PATTERN — anything else (favicon.ico, …) short-circuits to 404.
const SLUG_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

interface ResolvedPermalink {
  type: 'project' | 'playlist';
  title: string | null;
  description: string | null;
  image: string | null;
}

async function resolvePermalink(slug: string): Promise<ResolvedPermalink | null> {
  if (!SLUG_SHAPE.test(slug)) return null;
  try {
    const r = await fetch(`${BACKEND}/api/v1/public/permalink/${encodeURIComponent(slug)}`, { cache: 'no-store' });
    if (!r.ok) return null;
    return (await r.json()) as ResolvedPermalink;
  } catch {
    return null;
  }
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const resolved = await resolvePermalink(slug);
  if (!resolved) return {};
  return {
    title: resolved.title ?? undefined,
    description: resolved.description ?? undefined,
    openGraph: {
      title: resolved.title ?? undefined,
      description: resolved.description ?? undefined,
      images: resolved.image ? [resolved.image] : undefined,
    },
  };
}

// Public, no auth — the creator-controlled permalink.
export default async function PermalinkRoute({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const resolved = await resolvePermalink(slug);
  if (!resolved) notFound();
  return (
    <div className="h-dvh w-screen overflow-hidden bg-black">
      {resolved.type === 'project'
        ? <SharedViewerPage permalinkSlug={slug} />
        : <PlaylistViewer permalinkSlug={slug} />}
    </div>
  );
}
