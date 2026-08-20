'use client';

import { useCallback, useRef, useState } from 'react';
import { LibraryCard } from './LibraryCard';
import { LibraryOverlay } from './LibraryOverlay';
import type { LibraryMaterial } from 'shared/src/types/library-view';

/**
 * The tile grid, and the one piece of client state on this page: which material is open.
 *
 * It exists as its own component because a tile has to be a real `<button>` with an `onClick` and
 * the overlay has to be unmounted on close — both client concerns — while the header, the filter
 * pills and the page metadata stay server-rendered. Keeping the boundary here is what lets THE
 * FILTER BE THE URL: the pills are ordinary anchors to real sub-routes, so filtering works with
 * JavaScript disabled and each filtered view is its own shareable landing page.
 *
 * Focus is restored to the invoking tile on close, which is the half of a modal that keyboard users
 * actually notice.
 */

const FIRST_ROW = 4; // matches the widest grid (xl:grid-cols-4) — the reference page's eager-first trick

export function LibraryGrid({ materials }: { materials: LibraryMaterial[] }) {
  const [open, setOpen] = useState<LibraryMaterial | null>(null);
  const tiles = useRef(new Map<string, HTMLButtonElement | null>());
  const openedFrom = useRef<string | null>(null);

  const handleOpen = useCallback((material: LibraryMaterial) => {
    openedFrom.current = material.id;
    setOpen(material);
  }, []);

  const handleClose = useCallback(() => {
    setOpen(null);
    const id = openedFrom.current;
    openedFrom.current = null;
    if (id) tiles.current.get(id)?.focus();
  }, []);

  return (
    <>
      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {materials.map((m, i) => (
          <li key={m.id} className="min-h-0">
            <LibraryCard
              material={m}
              eager={i < FIRST_ROW}
              onOpen={handleOpen}
              buttonRef={(el) => { tiles.current.set(m.id, el); }}
            />
          </li>
        ))}
      </ul>

      {/* Conditional render, never a hidden mount — see LibraryOverlay's header for why. */}
      {open && <LibraryOverlay material={open} onClose={handleClose} />}
    </>
  );
}
