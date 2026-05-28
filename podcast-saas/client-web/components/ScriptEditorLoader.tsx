'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '../lib/firebase';
import { api } from '../lib/api';
import { ScriptEditor } from './ScriptEditor';
import type { ScriptVersion } from 'shared';

interface VersionSummary {
  version: number;
  status: string;
  approved_at: string | null;
  created_at: string;
}

interface Props {
  projectId: string;
}

export function ScriptEditorLoader({ projectId }: Props) {
  const { loading: authLoading } = useAuth();
  const [scriptData, setScriptData] = useState<ScriptVersion | null>(null);
  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [hostAName, setHostAName] = useState('Host A');
  const [hostBName, setHostBName] = useState('Host B');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (authLoading) return;

    Promise.all([
      api.getProject(projectId),
      api.getScript(projectId),
      api.listScriptVersions(projectId),
    ])
      .then(([projectRes, scriptRes, versionsRes]) => {
        const project = projectRes;
        if (project.host_a) setHostAName(project.host_a.name);
        if (project.host_b) setHostBName(project.host_b.name);
        setScriptData(scriptRes);
        setVersions(
          (versionsRes as VersionSummary[]).map((v) => ({
            version: v.version,
            status: v.status,
            approved_at: v.approved_at,
            created_at: v.created_at,
          })),
        );
      })
      .catch((err) => {
        setError((err as Error).message ?? 'Failed to load script');
      })
      .finally(() => setLoading(false));
  }, [projectId, authLoading]);

  if (authLoading || loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-muted-foreground animate-pulse">Loading script…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center space-y-3">
          <p className="text-destructive">{error}</p>
          <a href={`/projects/${projectId}/stream`} className="text-primary text-sm hover:underline">
            Go back to generation
          </a>
        </div>
      </div>
    );
  }

  if (!scriptData?.body_json) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center space-y-3">
          <p className="text-muted-foreground">Script not ready yet.</p>
          <a href={`/projects/${projectId}/stream`} className="text-primary text-sm hover:underline">
            Watch generation progress
          </a>
        </div>
      </div>
    );
  }

  return (
    <ScriptEditor
      projectId={projectId}
      version={scriptData.version}
      script={scriptData.body_json}
      hostAName={hostAName}
      hostBName={hostBName}
      isApproved={!!scriptData.approved_at}
      versions={versions}
    />
  );
}
