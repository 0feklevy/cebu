import type { Metadata, Route } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { getLibraryPage } from '@/lib/libraryApi';
import { LibraryMiniSite } from '@/components/library/LibraryMiniSite';
import {
  LIBRARY_TYPE_ALIASES, LIBRARY_TYPE_SEGMENTS, libraryTypeLabel,
} from 'shared/src/types/library-view';
import type { LibraryMaterialType } from 'shared/src/types/library-view';

/**
 * One typed sub-page per bucket: `/library/simulation`, `/images`, `/videos`, `/sounds`.
 *
 * The canonical names are the owner's own words — `simulation` singular, the rest plural — and the
 * obvious near-misses 308 to them rather than 404ing, because a link that has already been sent
 * cannot be corrected. Everything else is a 404: this is not a search box.
 *
 * Its own `generateMetadata` ("Simulations — {title}") is what makes each of these a real landing
 * page rather than a client-side tab.
 */
export const revalidate = 60;

const SLUG_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

type Params = { params: Promise<{ slug: string; type: string }> };

interface Resolution {
  kind: 'ok';
  type: LibraryMaterialType;
}

/** null → 404. A string → 308 to that canonical segment. */
function resolveSegment(segment: string): Resolution | { kind: 'redirect'; to: string } | null {
  if (segment in LIBRARY_TYPE_SEGMENTS) return { kind: 'ok', type: LIBRARY_TYPE_SEGMENTS[segment] };
  const alias = LIBRARY_TYPE_ALIASES[segment];
  return alias ? { kind: 'redirect', to: alias } : null;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug, type } = await params;
  const notIndexed = { title: 'Not found', robots: { index: false, follow: false } } satisfies Metadata;
  if (!SLUG_SHAPE.test(slug)) return notIndexed;

  const resolved = resolveSegment(type);
  if (!resolved || resolved.kind !== 'ok') return notIndexed;

  const result = await getLibraryPage(slug, resolved.type);
  if (result.status !== 'ok') return notIndexed;

  const bucket = libraryTypeLabel(resolved.type);
  const title = `${bucket} — ${result.data.title}`;
  const description = `${bucket} from ${result.data.title}.`;
  return {
    title,
    description,
    alternates: { canonical: `${result.data.canonicalUrl}/${type}` },
    openGraph: { title, description, type: 'website' },
    robots: { index: false, follow: false },
  };
}

export default async function LibraryTypePage({ params }: Params) {
  const { slug, type } = await params;
  if (!SLUG_SHAPE.test(slug)) notFound();

  const resolved = resolveSegment(type);
  if (!resolved) notFound();
  // `as Route` — a target the SERVER picks at request time is not in the route table, so
  // typedRoutes cannot express it. Same escape hatch the `/c/` pages use for their redirects.
  if (resolved.kind === 'redirect') permanentRedirect(`/${slug}/library/${resolved.to}` as Route);

  const result = await getLibraryPage(slug, resolved.type);
  // A type excluded from the share's scope 404s here, because the backend refuses it: an excluded
  // bucket does not exist, as distinct from an empty one, which renders with an honest empty state.
  if (result.status !== 'ok') notFound();

  return <LibraryMiniSite view={result.data} slug={slug} activeType={resolved.type} />;
}
