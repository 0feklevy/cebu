import { permanentRedirect } from 'next/navigation';

/**
 * The podcast EDITOR moved to /edit-podcasts (P3-A). This shim is why every link anyone has
 * already shared still works.
 *
 * A 308 rather than a rewrite: the old path is not an alias, it is a former address, and telling
 * browsers and crawlers so is what eventually retires it. `podcasts` also stays in RESERVED_SLUGS
 * after the move — releasing it would let a creator claim the exact URL every one of those old
 * links points at, which is a far worse outcome than an unused reservation.
 */
export default function LegacyPodcastsIndex(): never {
  permanentRedirect('/edit-podcasts');
}
