import { ViewerPage } from '@/components/viewer/ViewerPage';

// Public, no auth — sharable interactive player
export default async function ViewerRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div className="h-dvh w-screen overflow-hidden bg-black">
      <ViewerPage projectId={id} />
    </div>
  );
}
