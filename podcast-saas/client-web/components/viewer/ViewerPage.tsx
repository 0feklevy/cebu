'use client';

import { useEffect, useRef, useState } from 'react';
import type { PlayerConfig } from './types';
import { HLSPlayerShell } from './HLSPlayerShell';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080';
const POLL_INTERVAL_MS = 5000;

interface Props {
  projectId: string;
}

export function ViewerPage({ projectId }: Props) {
  const [config, setConfig] = useState<PlayerConfig | null>(null);
  const [error, setError]   = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const check = async () => {
      try {
        const r = await fetch(`${API_URL}/api/v1/projects/${projectId}/player-config`);
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        const data = (await r.json()) as PlayerConfig;

        if (!data.segments.length) {
          setError('This project has no videos yet.');
          clearInterval(intervalRef.current!);
          return;
        }

        const hasReady = data.segments.some((s) => s.hls_status === 'ready' || s.fallback_url);
        const allFailed = data.segments.every((s) => s.hls_status === 'failed');

        if (allFailed) {
          setError('Video processing failed. Please re-upload and try again.');
          clearInterval(intervalRef.current!);
          return;
        }

        if (hasReady) {
          setConfig(data);
          setProcessing(false);
          clearInterval(intervalRef.current!);
        } else {
          setProcessing(true);
        }
      } catch (e) {
        setError((e as Error).message);
        clearInterval(intervalRef.current!);
      }
    };

    check();
    intervalRef.current = setInterval(check, POLL_INTERVAL_MS);
    return () => clearInterval(intervalRef.current!);
  }, [projectId]);

  if (error) {
    return (
      <div className="flex items-center justify-center w-full h-full bg-black text-white/60 text-sm">
        {error}
      </div>
    );
  }

  if (!config) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 w-full h-full bg-black">
        <div className="w-8 h-8 border-2 border-white/30 border-t-white rounded-full animate-spin" />
        {processing && (
          <p className="text-white/40 text-xs">Video is processing — this may take a few minutes…</p>
        )}
      </div>
    );
  }

  return <HLSPlayerShell config={config} />;
}
