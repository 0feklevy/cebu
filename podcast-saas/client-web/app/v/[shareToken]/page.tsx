import { SharedViewerPage } from '@/components/viewer/SharedViewerPage';

// Public, no auth — the shareable video link
export default async function SharedVideoRoute({ params }: { params: Promise<{ shareToken: string }> }) {
  const { shareToken } = await params;
  return (
    <div className="w-screen h-screen bg-black">
      <SharedViewerPage shareToken={shareToken} />
    </div>
  );
}
