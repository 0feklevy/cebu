import Link from 'next/link';
import type { Route } from 'next';
import { Play } from 'lucide-react';
import { LibraryGrid } from './LibraryGrid';
import {
  LIBRARY_MATERIAL_TYPES, librarySegmentFor, libraryTypeLabel,
} from 'shared/src/types/library-view';
import type { LibraryMaterialType, LibraryView } from 'shared/src/types/library-view';

/**
 * The mini-site shell: title, item count, then one toolbar row of filter pills + search over a
 * responsive card grid. A Server Component, so the visitor's first paint is the finished page —
 * there is no loading state, and a skeleton for content that arrives with the HTML would be
 * theatre.
 *
 * THE TYPE FILTER IS THE URL. Every pill is a real `next/link` anchor to a real sub-route, not a
 * client tab — which is why the pills are built HERE and handed to the client grid as a slot
 * (`typeNav`) rather than rebuilt inside it. That keeps `/library/images` its own shareable landing
 * page with its own metadata, keeps type filtering working with JavaScript disabled, and leaves the
 * search box as the only client filter state. `as Route` because `experimental.typedRoutes` is on
 * and these hrefs are built from a server value rather than drawn from the route table — the same
 * escape hatch the `/c/` pages already use.
 *
 * LAYOUT: full viewport width under a `max-w-screen-2xl` ceiling, one to five grid columns by
 * breakpoint. The banner images are the card's visual anchor, so the page reads as a gallery on a
 * desktop and a single column on a phone.
 *
 * Every colour is a token. The `/c/` pages hardcode `text-black/50` and go unreadable in dark mode;
 * this page must not, and a test asserts it.
 */

/**
 * The product's name, the same way the `/c/` OG routes resolve it: the deploy's brand when set,
 * the app's own name otherwise. A Server Component, so the env read happens on the server.
 */
const BRAND = process.env.PUBLIC_BRAND_NAME ?? 'Interactive Video Studio';

interface Props {
  view: LibraryView;
  slug: string;
  /** The bucket being shown, or null for the all-materials landing page. */
  activeType: LibraryMaterialType | null;
}

export function LibraryMiniSite({ view, slug, activeType }: Props) {
  const total = LIBRARY_MATERIAL_TYPES.reduce((n, t) => n + view.counts[t], 0);
  const activeLabel = activeType ? libraryTypeLabel(activeType).toLowerCase() : 'materials';
  const emptyMessage = total === 0
    ? 'The owner has not published any materials to this library yet.'
    : `No ${activeLabel} in this library yet.`;

  return (
    // The main element is the page's scroller (h-svh + overflow-y-auto, the PlaylistLobby
    // pattern), so the product's `fine-scrollbar` treatment actually applies to the bar the
    // visitor sees rather than sitting on an element that never scrolls.
    <main className="h-svh w-full overflow-y-auto fine-scrollbar bg-background">
      <div className="mx-auto w-full max-w-screen-2xl px-4 py-6 sm:px-6 sm:py-8 lg:px-8 lg:py-10">
        {/* The product's chrome, compact and public-appropriate: the mark (the favicon's
            gradient-and-play, via the house `gradient-action` class) and the brand name.
            No account button, no editor links — a visitor here is anonymous by design. */}
        <div className="mb-5 flex items-center gap-2.5 border-b border-border pb-4 sm:mb-6">
          <span aria-hidden className="gradient-action flex h-7 w-7 shrink-0 items-center justify-center rounded-lg">
            <Play size={13} strokeWidth={0} fill="currentColor" />
          </span>
          <span className="text-sm font-semibold tracking-tight text-foreground">{BRAND}</span>
        </div>

        <header className="mb-5 sm:mb-7">
          <h1 className="text-2xl font-bold leading-tight tracking-tight text-foreground sm:text-3xl lg:text-4xl">
            {view.title}
          </h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {total} {total === 1 ? 'item' : 'items'} in this library
          </p>
        </header>

        <LibraryGrid
          materials={view.materials}
          emptyMessage={emptyMessage}
          typeNav={
            <nav aria-label="Filter by material type" className="flex min-w-0 flex-wrap gap-2">
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
          }
        />
      </div>
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
