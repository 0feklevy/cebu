import { permanentRedirect } from 'next/navigation';

/**
 * The deepest of the old links, and the one most likely to have been shared: a specific episode.
 * Both ids are carried through, so the redirect lands on the exact episode rather than the index.
 */
export default async function LegacyPodcastEpisode(
  { params }: { params: Promise<{ showId: string; episodeId: string }> },
): Promise<never> {
  const { showId, episodeId } = await params;
  permanentRedirect(`/edit-podcasts/${showId}/episodes/${episodeId}`);
}
