import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getLibraryPage } from '@/lib/libraryApi';
import { LibraryMiniSite } from '@/components/library/LibraryMiniSite';

/**
 * The public materials mini-site: `/{librarySlug}/library`.
 *
 * A static child of the existing `[slug]` dynamic segment, so it claims no new top-level path and
 * cannot shadow a creator's permalink.
 *
 * "TEMPORARY HTML MINI-SITE" IS THIS, LITERALLY. Nothing is written to storage: the page is
 * assembled at request time from URLs the materials already have, held in the container's ISR cache
 * for 60 seconds, and rebuilt from the database after that. Delete a material and it is gone from
 * the page within a minute; revoke the link and the page stops existing.
 *
 * It deliberately does NOT read `searchParams` — that would opt the route out of static rendering
 * and destroy the ISR cache that the whole capacity argument rests on.
 */
export const revalidate = 60;

// Mirrors the shared SLUG_PATTERN and `app/[slug]/page.tsx:14`. Anything else — `favicon.ico`, a
// title someone pasted with spaces — short-circuits to 404 without a backend round-trip.
const SLUG_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

type Params = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  if (!SLUG_SHAPE.test(slug)) return { title: 'Not found', robots: { index: false, follow: false } };

  const result = await getLibraryPage(slug);
  if (result.status !== 'ok') return { title: 'Not found', robots: { index: false, follow: false } };

  const { title, canonicalUrl } = result.data;
  const description = `Simulations, images, videos and sounds from ${title}.`;
  return {
    title,
    description,
    alternates: { canonical: canonicalUrl },
    openGraph: { title, description, url: canonicalUrl, type: 'website' },
    // Phase 1 is noindex, decided explicitly rather than by omission: a title-derived URL that is
    // guessable is one thing, one that is searchable is another.
    robots: { index: false, follow: false },
  };
}

export default async function LibraryPage({ params }: Params) {
  const { slug } = await params;
  if (!SLUG_SHAPE.test(slug)) notFound();

  const result = await getLibraryPage(slug);
  // Revoked, expired and unknown all arrive here identically, because the backend refuses to say
  // which one it was.
  if (result.status !== 'ok') notFound();

  return <LibraryMiniSite view={result.data} slug={slug} activeType={null} />;
}
