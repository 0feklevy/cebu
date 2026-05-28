import { ScriptEditorLoader } from '../../../../components/ScriptEditorLoader';

export default function ScriptPage({ params }: { params: { id: string } }) {
  return (
    <div className="h-full overflow-hidden">
      <ScriptEditorLoader projectId={params.id} />
    </div>
  );
}
