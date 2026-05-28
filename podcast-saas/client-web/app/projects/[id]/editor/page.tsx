import { VideoEditor } from '../../../../components/VideoEditor';

export default async function EditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div className="h-full overflow-hidden">
      <VideoEditor projectId={id} />
    </div>
  );
}
