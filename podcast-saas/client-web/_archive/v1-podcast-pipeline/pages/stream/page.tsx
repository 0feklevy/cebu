import { SSEProgressView } from '../../../../components/SSEProgressView';

export default async function StreamPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div className="h-full overflow-hidden bg-background">
      <SSEProgressView projectId={id} />
    </div>
  );
}
