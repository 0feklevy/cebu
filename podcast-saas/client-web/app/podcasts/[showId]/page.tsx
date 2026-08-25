import { permanentRedirect } from 'next/navigation';

/** Deep link to one show, from before the move to /edit-podcasts (P3-A). */
export default async function LegacyPodcastShow(
  { params }: { params: Promise<{ showId: string }> },
): Promise<never> {
  const { showId } = await params;
  permanentRedirect(`/edit-podcasts/${showId}`);
}
