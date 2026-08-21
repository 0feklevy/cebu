import Link from 'next/link';
import type { Route } from 'next';
import { LibraryGrid } from './LibraryGrid';
import {
  LIBRARY_MATERIAL_TYPES, librarySegmentFor, libraryTypeLabel,
} from 'shared/src/types/library-view';
import type { LibraryMaterialType, LibraryView } from 'shared/src/types/library-view';

/**
 * The mini-site shell: title, item count, filter pills, grid. A Server Component, so the visitor's
 * first paint is the finished page — there is no loading state, and a skeleton for content that
 * arrives with the HTML would be theatre.
 *
 * THE FILTER IS THE URL. Every pill is a real `next/link` anchor to a real sub-route, not a client
 * tab. That is what makes `/library/images` its own shareable landing page with its own metadata,
 * what keeps it working with JavaScript disabled, and what keeps client filter state at zero.
 * `as Route` because `experimental.typedRoutes` is on and these hrefs are built from a server value
 * rather than drawn from the route table — the same escape hatch the `/c/` pages already use.
 *
 * Every colour is a token. The `/c/` pages hardcode `text-black/50` and go unreadable in dark mode;
 * this page must not, and a test asserts it.
 */

interface Props {
  view: LibraryView;
  slug: string;
  /** The bucket being shown, or null for the all-materials landing page. */
  activeType: LibraryMaterialType | null;
}

export function LibraryMiniSite({ view, slug, activeType }: Props) {
  const total = LIBRARY_MATERIAL_TYPES.reduce((n, t) => n + view.counts[t], 0);
  const activeLabel = activeType ? libraryTypeLabel(activeType).toLowerCase() : 'materials';

  return (
    <main className="mx-auto min-h-svh w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
      <header className="mb-6 sm:mb-8">
        <h1 className="text-2xl font-bold leading-tight text-foreground sm:text-3xl">{view.title}</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          {total} {total === 1 ? 'item' : 'items'} in this library
        </p>

        <nav aria-label="Filter by material type" className="mt-4 flex flex-wrap gap-2">
          <Pill
            href={`/${slug}/library` as Route}
            label="All"
            count={total}
            active={activeType === null}
          />
          {LIBRARY_MATERIAL_TYPES.map((type) => (
            <Pill
              key={type}
              href={`/${slug}/library/${librarySegmentFor(type)}` as Route}
              label={libraryTypeLabel(type)}
              count={view.counts[type]}
              active={activeType === type}
            />
          ))}
        </nav>
      </header>

      {view.materials.length > 0 ? (
        <LibraryGrid materials={view.materials} />
      ) : (
        // An empty BUCKET is 200 with an honest empty state, never a 404: the bucket exists, it has
        // nothing in it, and the pills stay visible with real counts so the visitor can move on.
        <p className="rounded-lg border border-border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
          {total === 0
            ? 'The owner has not published any materials to this library yet.'
            : `No ${activeLabel} in this library yet.`}
        </p>
      )}
    </main>
  );
}

function Pill({ href, label, count, active }: { href: Route; label: string; count: number; active: boolean }) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={`inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold transition-colors focus-ring ${
        active
          ? 'border-primary/40 bg-primary/10 text-foreground'
          : 'border-border bg-card text-muted-foreground hover:bg-muted/60 hover:text-foreground'
      }`}
    >
      {label}
      <span className="text-[10px] font-normal text-muted-foreground">{count}</span>
    </Link>
  );
}
