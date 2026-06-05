import { PlaylistViewer } from '@/components/viewer/playlist/PlaylistViewer';

// Owner preview — requires auth (the viewer attaches the Firebase token)
export default async function PlaylistPreviewRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div className="h-dvh w-screen overflow-hidden bg-black">
      <PlaylistViewer playlistId={id} />
    </div>
  );
}
