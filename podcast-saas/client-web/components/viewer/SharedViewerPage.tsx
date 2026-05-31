'use client';

import { useEffect, useRef, useState } from 'react';
import type { PlayerConfig } from './types';
import { HLSPlayerShell } from './HLSPlayerShell';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080';
const POLL_INTERVAL_MS = 5000;

interface Props {
  shareToken: string;
}

export function SharedViewerPage({ shareToken }: Props) {
  const [config, setConfig]         = useState<PlayerConfig | null>(null);
  const [error, setError]           = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const check = async () => {
      try {
        const r = await fetch(`${API_URL}/api/v1/share/${shareToken}`);
        if (r.status === 404) {
          setError('This link is no longer active or does not exist.');
          clearInterval(intervalRef.current!);
          return;
        }
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);

        const data = (await r.json()) as PlayerConfig;

        if (!data.segments.length) {
          setError('This project has no videos yet.');
          clearInterval(intervalRef.current!);
          return;
        }

        const hasReady  = data.segments.some((s) => s.hls_status === 'ready' || s.fallback_url);
        const allFailed = data.segments.every((s) => s.hls_status === 'failed');

        if (allFailed) {
          setError('Video processing failed — please contact the owner.');
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
  }, [shareToken]);

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 w-full h-full bg-black">
        <svg width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden>
          <circle cx="20" cy="20" r="19" stroke="rgba(255,255,255,0.15)" strokeWidth="2" />
          <path d="M20 12v10M20 28v1" stroke="rgba(255,255,255,0.4)" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <p className="text-white/50 text-sm text-center max-w-xs">{error}</p>
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
