'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { connectSSEStream } from '../lib/sse-client';
import { useAuth } from '../lib/firebase';
import type { StreamEvent, SSEStage } from 'shared';

interface Props {
  projectId: string;
}

type StageStatus = 'queued' | 'running' | 'done' | 'error';

interface StageState {
  status: StageStatus;
  message: string;
}

const STAGE_ORDER: SSEStage[] = [
  'content_moderation',
  'corpus_ingest',
  'structural_analysis',
  'script_draft',
  'script_rewrite',
  'script_validate',
];

const STAGE_LABELS: Record<SSEStage, string> = {
  content_moderation: 'Safety check',
  corpus_ingest: 'Reading source material',
  structural_analysis: 'Building topic map (Pass 0)',
  script_draft: 'Writing first draft (Pass 1)',
  script_rewrite: 'Dramatic rewrite (Pass 2)',
  script_validate: 'Validating schema (Pass 3)',
  audio_tts: 'Generating voice lines',
  audio_assemble: 'Assembling audio',
  audio_align: 'Aligning transcript',
  scene_segment: 'Segmenting scenes',
  camera_plan: 'Planning camera cuts',
};

export function SSEProgressView({ projectId }: Props) {
  const router = useRouter();
  const { getIdToken } = useAuth();
  const [stages, setStages] = useState<Record<SSEStage, StageState>>(
    () =>
      Object.fromEntries(
        STAGE_ORDER.map((s) => [s, { status: 'queued' as StageStatus, message: '' }]),
      ) as Record<SSEStage, StageState>,
  );
  const [tokenStream, setTokenStream] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const abortRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let mounted = true;

    (async () => {
      const abort = await connectSSEStream(
        projectId,
        getIdToken,
        (event: StreamEvent) => {
          if (!mounted) return;

          if (event.type === 'status') {
            setStages((prev) => ({
              ...prev,
              [event.stage]: { status: 'running', message: event.message },
            }));
          }

          if (event.type === 'corpus_ready') {
            setStages((prev) => ({
              ...prev,
              corpus_ingest: { status: 'done', message: 'Source material processed' },
            }));
          }

          if (event.type === 'structural_ready') {
            setStages((prev) => ({
              ...prev,
              structural_analysis: { status: 'done', message: 'Topic map complete' },
            }));
          }

          if (event.type === 'script_draft_token') {
            setTokenStream((s) => s + event.chunk);
          }

          if (event.type === 'script_draft_ready') {
            setStages((prev) => ({
              ...prev,
              script_draft: { status: 'done', message: 'First draft complete' },
            }));
          }

          if (event.type === 'script_rewrite_ready') {
            setStages((prev) => ({
              ...prev,
              script_rewrite: { status: 'done', message: 'Rewrite complete' },
              script_validate: { status: 'running', message: 'Validating…' },
            }));
          }

          if (event.type === 'script_ready') {
            setStages((prev) => ({
              ...prev,
              script_validate: { status: 'done', message: 'Script validated' },
            }));
          }

          if (event.type === 'done') {
            setDone(true);
            abortRef.current?.();
            setTimeout(() => router.push(`/projects/${projectId}/script`), 1500);
          }

          if (event.type === 'error') {
            setError(event.message);
            const currentStage = STAGE_ORDER.find(
              (s) => stages[s].status === 'running',
            );
            if (currentStage) {
              setStages((prev) => ({
                ...prev,
                [currentStage]: { status: 'error', message: event.message },
              }));
            }
          }
        },
      );
      if (mounted) abortRef.current = abort;
    })();

    return () => {
      mounted = false;
      abortRef.current?.();
    };
  }, [projectId]);

  return (
    <div className="max-w-2xl mx-auto px-4 py-12 space-y-8">
      <div>
        <h1 className="text-2xl font-bold mb-1">Generating your script</h1>
        <p className="text-muted-foreground text-sm">This takes 1–3 minutes. Stay on this page.</p>
      </div>

      {/* Stage indicators */}
      <div className="space-y-3">
        {STAGE_ORDER.map((stage) => {
          const s = stages[stage];
          const icon =
            s.status === 'done'
              ? '✓'
              : s.status === 'running'
              ? '⟳'
              : s.status === 'error'
              ? '✗'
              : '○';
          const color =
            s.status === 'done'
              ? 'text-green-400'
              : s.status === 'running'
              ? 'text-primary animate-pulse'
              : s.status === 'error'
              ? 'text-destructive'
              : 'text-muted-foreground';

          return (
            <div key={stage} className="flex items-start gap-3">
              <span className={`font-mono text-lg w-6 text-center ${color}`}>{icon}</span>
              <div>
                <div className={`text-sm font-medium ${s.status === 'queued' ? 'text-muted-foreground' : 'text-foreground'}`}>
                  {STAGE_LABELS[stage]}
                </div>
                {s.message && (
                  <div className="text-xs text-muted-foreground">{s.message}</div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Live token stream preview */}
      {tokenStream && (
        <div className="bg-card border border-border rounded-xl p-4">
          <p className="text-xs text-muted-foreground font-mono mb-2">Live script preview</p>
          <div className="text-sm text-foreground/80 font-mono max-h-48 overflow-y-auto whitespace-pre-wrap break-words">
            {tokenStream}
            {!done && <span className="inline-block w-1 h-4 bg-primary animate-blink ml-0.5" />}
          </div>
        </div>
      )}

      {/* Done state */}
      {done && (
        <div className="text-center py-4">
          <div className="text-4xl mb-2">🎙</div>
          <p className="font-semibold">Script ready! Redirecting to editor…</p>
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="rounded-xl bg-destructive/10 border border-destructive/50 p-4">
          <p className="text-destructive font-medium mb-1">Generation failed</p>
          <p className="text-sm text-muted-foreground mb-3">{error}</p>
          <button
            onClick={() => window.location.reload()}
            className="text-sm px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90"
          >
            Retry
          </button>
        </div>
      )}
    </div>
  );
}
