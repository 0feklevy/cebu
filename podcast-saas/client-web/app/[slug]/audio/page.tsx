import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { AudioEditionPlayer } from '@/components/audio/AudioEditionPlayer';
import { formatDuration, getAudioEditionPage } from '@/lib/audioEditionApi';

/**
 * The audio edition mini-site: `/{slug}/audio` — P3-B / A2.2.
 *
 * A static child of the existing `[slug]` dynamic segment, exactly as `/{slug}/library` is, so it
 * claims no new top-level path and cannot shadow a creator's permalink. `audio` is nonetheless in
 * RESERVED_SLUGS: without the reservation a creator could claim the permalink `audio`, making
 * `/audio/audio` a real page and permanently blocking the future top-level `/audio` category
 * landing this feature's own design already calls for.
 *
 * `audio` was checked against `isDubbingLanguageSuffix` before being added, because `/{slug}/audio`
 * and `/{slug}/{lang}` share a path shape — the permalink service exports that function for
 * precisely this check, so the overlap is discovered here rather than in production.
 *
 * Like the library page it does NOT read `searchParams`: that would opt the route out of static
 * rendering and destroy the ISR cache. The one query this surface would want — `?language=` — is
 * therefore a separate concern, and dubbed editions get their own path when A2.x needs them.
 */
export const revalidate = 60;

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
    // Indexable, unlike the library's phase 1. The project this derives from is PUBLIC — that is
    // the only condition under which this route resolves at all — so its audio being findable is
    // the same decision the project's own page already made.
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
  const length = formatDuration(data.duration_ms);

  return (
    <main className="min-h-dvh px-4 py-10">
      <header className="mx-auto max-w-2xl mb-6">
        <h1 className="text-2xl font-bold">{data.title ?? 'Audio'}</h1>
        {length && (
          <p className="mt-1 text-sm text-muted-foreground">
            {length}
            {data.chapters.length > 0 && ` · ${data.chapters.length} chapters`}
          </p>
        )}
        {data.description && <p className="mt-3 text-sm leading-relaxed">{data.description}</p>}
      </header>

      <AudioEditionPlayer view={data} />

      <footer className="mx-auto max-w-2xl mt-10 text-xs text-muted-foreground">
        {/* The listener arrived here from a link, possibly without ever seeing the lesson. The way
            back has to be on the page rather than assumed. */}
        <a href={`/${slug}`} className="underline">Watch the full lesson</a>
      </footer>
    </main>
  );
}
