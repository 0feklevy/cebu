import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SharedViewerPage } from '@/components/viewer/SharedViewerPage';

/**
 * Language-suffixed permalink: {PUBLIC_SITE_URL}/{slug}/{lang} — e.g. /my-lesson/he (migration 067).
 *
 * WHY THE LANGUAGE SET IS A CLOSED LIST HERE. `/[slug]/[lang]` is a catch-all under another
 * catch-all, so without a shape test it would swallow every two-segment path under a permalink —
 * including sibling routes another branch is adding beneath the same prefix. Matching only the
 * language codes this product actually dubs into keeps this route as narrow as the feature is, and
 * makes a collision with a future /{slug}/something route impossible rather than merely unlikely.
 *
 * The list is deliberately duplicated from the backend's `DUBBING_LANGUAGES` rather than imported:
 * this file is a server component in a different package, and the two are already coupled by the
 * URL contract. A language added to one and not the other fails closed — the route 404s — which is
 * the safe direction.
 */
const DUB_LANGUAGES = new Set(['en', 'es', 'he']);
/** Mirrors the shared SLUG_PATTERN, exactly as `/[slug]` does. */
const SLUG_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const BACKEND = process.env.BACKEND_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:8080');

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

export async function generateMetadata({ params }: { params: Promise<{ slug: string; lang: string }> }): Promise<Metadata> {
  const { slug, lang } = await params;
  if (!DUB_LANGUAGES.has(lang)) return {};
  const resolved = await resolvePermalink(slug);
  if (!resolved) return {};
  return {
    title: resolved.title ?? undefined,
    description: resolved.description ?? undefined,
    // The dubbed page is a translation of the same work, not a separate one. Declaring the
    // language lets a crawler treat it as such, and `canonical` points each translation at itself
    // so they are not read as duplicates of the original.
    alternates: { canonical: `/${slug}/${lang}` },
    openGraph: {
      title: resolved.title ?? undefined,
      description: resolved.description ?? undefined,
      locale: lang,
      images: resolved.image ? [resolved.image] : undefined,
    },
  };
}

// Public, no auth — the language-suffixed twin of the permalink route.
export default async function PermalinkLanguageRoute({ params }: { params: Promise<{ slug: string; lang: string }> }) {
  const { slug, lang } = await params;
  // A playlist has no language dimension yet, so only projects are served here; anything else
  // 404s rather than silently rendering the original and lying about the URL.
  if (!DUB_LANGUAGES.has(lang)) notFound();
  const resolved = await resolvePermalink(slug);
  if (!resolved || resolved.type !== 'project') notFound();

  return (
    <div className="h-dvh w-screen overflow-hidden bg-black">
      <SharedViewerPage permalinkSlug={slug} language={lang} />
    </div>
  );
}
