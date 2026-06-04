import { PlaylistViewer } from '@/components/viewer/playlist/PlaylistViewer';

// Public, no auth — the shareable playlist link
export default async function PlaylistShareRoute({ params }: { params: Promise<{ shareToken: string }> }) {
  const { shareToken } = await params;
  return (
    <div className="w-screen h-screen bg-black">
      <PlaylistViewer shareToken={shareToken} />
    </div>
  );
}
