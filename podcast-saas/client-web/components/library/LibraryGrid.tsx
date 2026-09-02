'use client';

import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { Search } from 'lucide-react';
import { LibraryCard, TYPE_LABEL } from './LibraryCard';
import { LibraryOverlay } from './LibraryOverlay';
import { libraryTypeLabel } from 'shared/src/types/library-view';
import type { LibraryMaterial } from 'shared/src/types/library-view';

/**
 * The tile grid and the page's client state: which material is open, and the search query.
 *
 * It exists as its own component because a tile has to be a real `<button>` with an `onClick`, the
 * overlay has to be unmounted on close, and filter-as-you-type is client state by definition —
 * while the title, the filter pills and the page metadata stay server-rendered. THE TYPE FILTER IS
 * STILL THE URL: the pills arrive here as `typeNav`, a server-rendered slot of real anchors to real
 * sub-routes, so type filtering keeps working with JavaScript disabled and each bucket stays its
 * own shareable landing page. The search box is the deliberate exception — it narrows material the
 * visitor ALREADY has, entirely client-side, so it costs the backend nothing and belongs to no URL.
 *
 * Focus is restored to the invoking tile on close, which is the half of a modal that keyboard users
 * actually notice.
 */

const FIRST_ROW = 5; // matches the widest grid (2xl:grid-cols-5) — the reference page's eager-first trick

/**
 * The search rule, exported as a pure function so a test can exercise the RULE and not a
 * re-implementation of it: every whitespace-separated token must appear somewhere in the
 * material's name or its type label (singular or plural, so "video" and "videos" both hit).
 */
export function filterMaterials(materials: readonly LibraryMaterial[], query: string): LibraryMaterial[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [...materials];
  return materials.filter((m) => {
    const haystack = `${m.name} ${TYPE_LABEL[m.type]} ${libraryTypeLabel(m.type)}`.toLowerCase();
    return tokens.every((t) => haystack.includes(t));
  });
}

interface Props {
  materials: LibraryMaterial[];
  /** The server-rendered filter pills — real anchors, passed through so they stay in the toolbar. */
  typeNav: ReactNode;
  /** The server-composed message for a bucket that is genuinely empty (as opposed to filtered empty). */
  emptyMessage: string;
}

export function LibraryGrid({ materials, typeNav, emptyMessage }: Props) {
  const [open, setOpen] = useState<LibraryMaterial | null>(null);
  const [query, setQuery] = useState('');
  const tiles = useRef(new Map<string, HTMLButtonElement | null>());
  const openedFrom = useRef<string | null>(null);

  const handleOpen = useCallback((material: LibraryMaterial) => {
    openedFrom.current = material.id;
    setOpen(material);
  }, []);

  // A pointer going down on a simulation tile is ~100 ms ahead of the click that opens it: enough
  // to have the entry document in flight before the frame mounts (night run 2026-09-03 §6).
  const handleWarm = useCallback((material: LibraryMaterial) => {
    if (material.type !== 'simulation' || typeof document === 'undefined') return;
    if (document.querySelector(`link[rel="prefetch"][href="${material.url}"]`)) return;
    const link = document.createElement('link');
    link.rel = 'prefetch';
    link.as = 'document';
    link.href = material.url;
    document.head.appendChild(link);
  }, []);

  const handleClose = useCallback(() => {
    setOpen(null);
    const id = openedFrom.current;
    openedFrom.current = null;
    if (id) tiles.current.get(id)?.focus();
  }, []);

  const trimmed = query.trim();
  const visible = useMemo(() => filterMaterials(materials, query), [materials, query]);

  return (
    <>
      <div className="mb-5 flex flex-col gap-3 sm:mb-6 lg:flex-row lg:items-center lg:justify-between lg:gap-4">
        {typeNav}
        {materials.length > 0 && (
          <div className="relative w-full lg:w-80 lg:shrink-0">
            <Search
              size={15}
              strokeWidth={1.8}
              aria-hidden
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/70"
            />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search this library"
              placeholder="Search by keyword…"
              className="h-10 w-full rounded-lg border border-input bg-card pl-9 pr-3 text-sm text-foreground shadow-sm-soft outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-primary/45 focus:ring-2 focus:ring-ring/20"
            />
          </div>
        )}
      </div>

      {/* aria-live so a screen-reader hears the result count change as they type. The region is
          MOUNTED WHENEVER THE BUCKET HAS ITEMS, not conditionally on the query: a live region
          added to the DOM in the same pass as its first content is not reliably announced —
          assistive tech watches EXISTING regions for changes. Empty while there is no query, it
          costs nothing visually and makes the first keystroke's announcement dependable. */}
      {materials.length > 0 && (
        <p aria-live="polite" className="mb-4 min-h-5 text-sm text-muted-foreground">
          {trimmed && visible.length > 0
            ? `${visible.length} of ${materials.length} ${materials.length === 1 ? 'item' : 'items'} match “${trimmed}”`
            : ''}
        </p>
      )}

      {materials.length === 0 ? (
        // An empty BUCKET is 200 with an honest empty state, never a 404: the bucket exists, it has
        // nothing in it, and the pills stay visible with real counts so the visitor can move on.
        <p className="rounded-lg border border-border bg-card px-4 py-10 text-center text-sm text-muted-foreground">
          {emptyMessage}
        </p>
      ) : visible.length === 0 ? (
        <div role="status" className="rounded-lg border border-border bg-card px-4 py-10 text-center">
          <p className="text-sm text-muted-foreground">
            No materials match &ldquo;{trimmed}&rdquo;.
          </p>
          <button
            type="button"
            onClick={() => setQuery('')}
            className="mt-3 inline-flex h-8 items-center rounded-full border border-border bg-card px-3 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-ring"
          >
            Clear search
          </button>
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
          {visible.map((m, i) => (
            <li key={m.id} className="min-h-0">
              <LibraryCard
                material={m}
                eager={i < FIRST_ROW}
                onOpen={handleOpen}
                onWarm={handleWarm}
                buttonRef={(el) => { tiles.current.set(m.id, el); }}
              />
            </li>
          ))}
        </ul>
      )}

      {/* Conditional render, never a hidden mount — see LibraryOverlay's header for why. */}
      {open && <LibraryOverlay material={open} onClose={handleClose} />}
    </>
  );
}
