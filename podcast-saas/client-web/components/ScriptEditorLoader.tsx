'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
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

const STILL_GENERATING_STATUSES = new Set(['drafting', 'rewriting', 'validating']);
const POLL_INTERVAL_MS = 3000;

export function ScriptEditorLoader({ projectId }: Props) {
  const router = useRouter();
  const { loading: authLoading } = useAuth();
  const [scriptData, setScriptData] = useState<ScriptVersion | null>(null);
  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [hostAName, setHostAName] = useState('Host A');
  const [hostBName, setHostBName] = useState('Host B');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [polling, setPolling] = useState(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchScript = async (isInitial = false) => {
    try {
      const [projectRes, scriptRes, versionsRes] = await Promise.all([
        api.getProject(projectId),
        api.getScript(projectId),
        api.listScriptVersions(projectId),
      ]);

      if (projectRes.host_a) setHostAName(projectRes.host_a.name);
      if (projectRes.host_b) setHostBName(projectRes.host_b.name);

      setVersions(
        (versionsRes as VersionSummary[]).map((v) => ({
          version: v.version,
          status: v.status,
          approved_at: v.approved_at,
          created_at: v.created_at,
        })),
      );

      const isReady = scriptRes.body_json &&
        !STILL_GENERATING_STATUSES.has(scriptRes.status);

      if (isReady) {
        setScriptData(scriptRes);
        setPolling(false);
      } else {
        // Still generating — keep polling
        setPolling(true);
        pollRef.current = setTimeout(() => fetchScript(), POLL_INTERVAL_MS);
      }
    } catch (err) {
      const msg = (err as Error).message ?? 'Failed to load script';
      // "No script yet" → pipeline hasn't started writing; keep polling
      if (msg.includes('No script yet') || msg.includes('not found')) {
        setPolling(true);
        pollRef.current = setTimeout(() => fetchScript(), POLL_INTERVAL_MS);
      } else {
        setError(msg);
      }
    } finally {
      if (isInitial) setLoading(false);
    }
  };

  useEffect(() => {
    if (authLoading) return;
    fetchScript(true);
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
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

  if (polling || !scriptData?.body_json) {
    router.replace(`/projects/${projectId}/stream`);
    return null;
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
