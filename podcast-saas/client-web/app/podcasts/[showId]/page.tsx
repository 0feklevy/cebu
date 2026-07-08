import { PodcastShowPage } from '@/components/podcast/PodcastShowPage';

export default async function ShowPage({ params }: { params: Promise<{ showId: string }> }) {
  const { showId } = await params;
  return <PodcastShowPage showId={showId} />;
}
