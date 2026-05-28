import { StudioView } from '../../../../components/StudioView';

export default async function StudioPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div className="h-full overflow-hidden bg-background">
      <StudioView projectId={id} />
    </div>
  );
}
