import { ProjectHeader } from '@/components/ProjectHeader';
import { VideoEditor } from '@/components/VideoEditor';

export default async function EditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div className="flex flex-col h-screen">
      <ProjectHeader projectId={id} />
      <div className="flex-1 overflow-hidden min-h-0">
        <VideoEditor projectId={id} />
      </div>
    </div>
  );
}
