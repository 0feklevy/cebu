import { PodcastEpisodePage } from '@/components/podcast/PodcastEpisodePage';

export default async function EpisodePage({
  params,
}: {
  params: Promise<{ showId: string; episodeId: string }>;
}) {
  const { showId, episodeId } = await params;
  return <PodcastEpisodePage showId={showId} episodeId={episodeId} />;
}
