import type { Metadata, Viewport } from 'next';
import { notFound } from 'next/navigation';
import { AudioEditionPlayer } from '@/components/audio/AudioEditionPlayer';
import { formatDuration, getAudioEditionPage } from '@/lib/audioEditionApi';

/**
 * The audio edition mini-site: `/{slug}/audio` — P3-B / A2.2, rebuilt as the car-mode player
 * (night run 2026-09-03 §4).
 *
 * A static child of the existing `[slug]` dynamic segment, exactly as `/{slug}/library` is, so it
 * claims no new top-level path and cannot shadow a creator's permalink. `audio` is nonetheless in
 * RESERVED_SLUGS: without the reservation a creator could claim the permalink `audio`, making
 * `/audio/audio` a real page and permanently blocking the future top-level `/audio` category
 * landing this feature's own design already calls for.
 *
 * Like the library page it does NOT read `searchParams`: that would opt the route out of static
 * rendering and destroy the ISR cache. The one query this surface would want — `?language=` — is
 * therefore a separate concern, and dubbed editions get their own path when A2.x needs them.
 *
 * The page itself is now nothing but the player: full viewport, dark, safe-area aware. Every word
 * that used to sit above and below the controls (duration line, description, footer) belongs to
 * the metadata and to the sheet, not to a screen someone glances at while driving.
 */
export const revalidate = 60;

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Draw under the notch and the home indicator; the player pads with the safe-area insets.
  viewportFit: 'cover',
  themeColor: '#0a0a0a',
};

// Mirrors the shared SLUG_PATTERN. Anything else short-circuits to 404 without a backend call.
const SLUG_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

type Params = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  if (!SLUG_SHAPE.test(slug)) return { title: 'Not found', robots: { index: false, follow: false } };

  const result = await getAudioEditionPage(slug);
  if (result.status !== 'ok') return { title: 'Not found', robots: { index: false, follow: false } };

  const title = result.data.title ?? 'Audio';
  const length = formatDuration(result.data.duration_ms);
  const description = result.data.description ?? (length ? `Listen — ${length}.` : 'Listen to this lesson.');

  return {
    title: `${title} — audio`,
    description,
    openGraph: { title, description, type: 'music.song' },
    robots: { index: true, follow: true },
  };
}

export default async function AudioEditionPage({ params }: Params) {
  const { slug } = await params;
  if (!SLUG_SHAPE.test(slug)) notFound();

  const result = await getAudioEditionPage(slug);
  // A private project, a project with no edition yet, and a slug that never existed all arrive
  // here identically — the backend refuses to say which, and this page must not infer it either.
  if (result.status !== 'ok') notFound();

  const { data } = result;

  return (
    <main className="min-h-dvh bg-neutral-950">
      <AudioEditionPlayer view={data} slug={slug} artworkUrl={data.artwork_url ?? null} />
      {/* The way back has to be on the page rather than assumed — under the player, for when it is stopped. */}
      <a href={`/${slug}`} className="sr-only">Watch the full lesson</a>
    </main>
  );
}
