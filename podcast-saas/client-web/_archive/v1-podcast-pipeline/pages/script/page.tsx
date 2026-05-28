import { ScriptEditorLoader } from '../../../../components/ScriptEditorLoader';

export default async function ScriptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div className="h-full overflow-hidden">
      <ScriptEditorLoader projectId={id} />
    </div>
  );
}
