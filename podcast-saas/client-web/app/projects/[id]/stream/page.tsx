import { SSEProgressView } from '../../../../components/SSEProgressView';

export default function StreamPage({ params }: { params: { id: string } }) {
  return (
    <div className="h-full overflow-hidden bg-background">
      <SSEProgressView projectId={params.id} />
    </div>
  );
}
