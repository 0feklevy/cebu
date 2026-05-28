'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '../lib/firebase';
import { api } from '../lib/api';
import { connectSSEStream } from '../lib/sse-client';
import type { StreamEvent, SSEStage } from 'shared';

interface Props {
  projectId: string;
}

type StageStatus = 'queued' | 'running' | 'done' | 'error';

interface StageState {
  status: StageStatus;
  message: string;
}

interface SceneRow {
  id: string;
  idx: number;
  speaker: 'host_a' | 'host_b';
  start_ms: number;
  end_ms: number;
  transcript: string;
  emotion: string;
  audio_tags: string[];
  is_hook: boolean;
  audio_chunk_url: string | null;
  shot: string | null;
}

const AUDIO_STAGES: SSEStage[] = [
  'audio_tts',
  'audio_assemble',
  'audio_align',
  'scene_segment',
  'camera_plan',
];

const STAGE_LABELS: Record<SSEStage, string> = {
  content_moderation: 'Safety check',
  corpus_ingest: 'Reading source material',
  structural_analysis: 'Building topic map',
  script_draft: 'Writing first draft',
  script_rewrite: 'Dramatic rewrite',
  script_validate: 'Validating schema',
  audio_tts: 'Synthesising voices',
  audio_assemble: 'Assembling master audio',
  audio_align: 'Aligning text to audio',
  scene_segment: 'Segmenting scenes',
  camera_plan: 'Planning camera cuts',
};

export function StudioView({ projectId }: Props) {
  const router = useRouter();
  const { getIdToken, loading: authLoading } = useAuth();

  // Generation state
  const [stages, setStages] = useState<Record<SSEStage, StageState>>(
    () =>
      Object.fromEntries(
        AUDIO_STAGES.map((s) => [s, { status: 'queued' as StageStatus, message: '' }]),
      ) as Record<SSEStage, StageState>,
  );
  const [ttsTurnIndex, setTtsTurnIndex] = useState(0);
  const [ttsTotalTurns, setTtsTotalTurns] = useState(0);
  const [masterAudioUrl, setMasterAudioUrl] = useState<string | null>(null);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const [sceneCount, setSceneCount] = useState<number | null>(null);
  const [cutCount, setCutCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Ready state (after generation completes or on re-visit)
  const [isReady, setIsReady] = useState(false);
  const [scenes, setScenes] = useState<SceneRow[]>([]);
  const [selectedScene, setSelectedScene] = useState<number | null>(null);

  // Loading / init
  const [initLoading, setInitLoading] = useState(true);

  const abortRef = useRef<(() => void) | null>(null);

  // On mount: check if render already exists; if so skip to ready state
  useEffect(() => {
    if (authLoading) return;
    let mounted = true;

    (async () => {
      try {
        // Check for existing render
        const render = await api.getAudioRender(projectId);
        if (render.status === 'ready' && render.master_audio_url) {
          // Already done — load scenes and go straight to ready state
          const [sceneRows] = await Promise.all([api.getScenes(projectId)]);
          if (!mounted) return;
          setMasterAudioUrl(render.master_audio_url);
          setDurationMs(render.duration_ms);
          setSceneCount(sceneRows.length);
          setScenes(sceneRows);
          setIsReady(true);
          setInitLoading(false);
          return;
        }
        if (render.status === 'failed') {
          if (!mounted) return;
          setError(render.error ?? 'Audio generation failed');
          setInitLoading(false);
          return;
        }
        // Still processing — fall through to SSE
      } catch {
        // No render yet — trigger and stream
      }

      if (!mounted) return;
      setInitLoading(false);
      startGeneration();
    })();

    return () => {
      mounted = false;
      abortRef.current?.();
    };
  }, [projectId, authLoading]);

  const startGeneration = async () => {
    try {
      await api.triggerAudio(projectId);
    } catch (err) {
      const msg = (err as Error).message ?? 'Failed to start audio generation';
      // 409 / "already generating" is fine — just connect SSE
      if (!msg.includes('already') && !msg.includes('generating')) {
        setError(msg);
        return;
      }
    }

    const abort = await connectSSEStream(
      projectId,
      getIdToken,
      handleEvent,
      undefined,
      `/api/v1/projects/${projectId}/audio/stream`,
    );
    abortRef.current = abort;
  };

  const handleEvent = (event: StreamEvent) => {
    if (event.type === 'status' && AUDIO_STAGES.includes(event.stage as SSEStage)) {
      setStages((prev) => ({
        ...prev,
        [event.stage]: { status: 'running', message: event.message },
      }));
    }

    if (event.type === 'audio_turn_done') {
      setTtsTurnIndex(event.turn_index + 1);
      setTtsTotalTurns(event.total_turns);
      setStages((prev) => ({
        ...prev,
        audio_tts: { ...prev.audio_tts, status: 'running', message: '' },
      }));
    }

    if (event.type === 'audio_ready') {
      setMasterAudioUrl(event.master_audio_url);
      setDurationMs(event.duration_ms);
      setStages((prev) => ({
        ...prev,
        audio_tts: { status: 'done', message: '' },
        audio_assemble: { status: 'done', message: 'Master audio ready' },
      }));
    }

    if (event.type === 'scenes_ready') {
      setSceneCount(event.scene_count);
      setStages((prev) => ({
        ...prev,
        audio_align: { status: 'done', message: '' },
        scene_segment: { status: 'done', message: `${event.scene_count} scenes` },
      }));
    }

    if (event.type === 'camera_plan_ready') {
      setCutCount(event.cut_count);
      setStages((prev) => ({
        ...prev,
        camera_plan: { status: 'done', message: `${event.cut_count} cuts` },
      }));
    }

    if (event.type === 'done') {
      abortRef.current?.();
      // Load scenes then switch to ready state
      api.getScenes(projectId).then((rows) => {
        setScenes(rows);
        setIsReady(true);
      });
    }

    if (event.type === 'error') {
      setError(event.message);
      setStages((prev) => {
        const runningStage = AUDIO_STAGES.find((s) => prev[s]?.status === 'running');
        if (!runningStage) return prev;
        return { ...prev, [runningStage]: { status: 'error', message: event.message } };
      });
    }
  };

  if (authLoading || initLoading) {
    return (
      <div className="min-h-full flex items-center justify-center">
        <div className="text-muted-foreground animate-pulse text-sm">Loading…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-full flex items-center justify-center">
        <div className="rounded-xl bg-destructive/10 border border-destructive/50 p-6 max-w-md w-full mx-4">
          <p className="text-destructive font-medium mb-1">Generation failed</p>
          <p className="text-sm text-muted-foreground mb-4">{error}</p>
          <button
            onClick={() => router.refresh()}
            className="text-sm px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (isReady) {
    return <StudioReadyView
      projectId={projectId}
      masterAudioUrl={masterAudioUrl}
      durationMs={durationMs}
      sceneCount={sceneCount ?? scenes.length}
      cutCount={cutCount}
      scenes={scenes}
      selectedScene={selectedScene}
      onSelectScene={setSelectedScene}
    />;
  }

  // Generation in progress
  return (
    <div className="max-w-2xl mx-auto px-4 py-12 space-y-8">
      <div>
        <h1 className="text-2xl font-bold mb-1">Generating audio</h1>
        <p className="text-muted-foreground text-sm">Synthesising voices, assembling, and planning camera cuts…</p>
      </div>

      <div className="space-y-3">
        {AUDIO_STAGES.map((stage) => {
          const s = stages[stage];
          const icon =
            s.status === 'done' ? '✓'
              : s.status === 'running' ? '⟳'
              : s.status === 'error' ? '✗'
              : '○';
          const color =
            s.status === 'done' ? 'text-green-400'
              : s.status === 'running' ? 'text-primary animate-pulse'
              : s.status === 'error' ? 'text-destructive'
              : 'text-muted-foreground';

          const label = stage === 'audio_tts' && ttsTotalTurns > 0 && s.status === 'running'
            ? `${STAGE_LABELS[stage]} (${ttsTurnIndex} / ${ttsTotalTurns})`
            : STAGE_LABELS[stage];

          return (
            <div key={stage} className="flex items-start gap-3">
              <span className={`font-mono text-lg w-6 text-center ${color}`}>{icon}</span>
              <div>
                <div className={`text-sm font-medium ${s.status === 'queued' ? 'text-muted-foreground' : 'text-foreground'}`}>
                  {label}
                </div>
                {s.message && (
                  <div className="text-xs text-muted-foreground">{s.message}</div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {masterAudioUrl && (
        <div className="bg-card border border-border rounded-xl p-4 space-y-2">
          <p className="text-xs text-muted-foreground font-medium">Master audio — ready</p>
          <audio controls src={masterAudioUrl} className="w-full h-10" />
          {durationMs && (
            <p className="text-xs text-muted-foreground">
              {Math.round(durationMs / 60000)} min {Math.round((durationMs % 60000) / 1000)} sec
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Ready view (two-column studio layout) ─────────────────────────────────────

interface ReadyProps {
  projectId: string;
  masterAudioUrl: string | null;
  durationMs: number | null;
  sceneCount: number;
  cutCount: number | null;
  scenes: SceneRow[];
  selectedScene: number | null;
  onSelectScene: (i: number) => void;
}

function StudioReadyView({
  masterAudioUrl,
  durationMs,
  sceneCount,
  cutCount,
  scenes,
  selectedScene,
  onSelectScene,
}: ReadyProps) {
  return (
    <div className="flex flex-col h-full bg-background">
      {/* Top bar */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border">
        <div>
          <h1 className="font-semibold text-lg">Studio</h1>
          <p className="text-xs text-muted-foreground">
            {sceneCount} scenes
            {cutCount !== null ? ` · ${cutCount} cuts` : ''}
            {durationMs !== null ? ` · ${Math.round(durationMs / 60000)} min ${Math.round((durationMs % 60000) / 1000)} sec` : ''}
          </p>
        </div>
      </div>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: scene list */}
        <div className="w-[55%] overflow-y-auto border-r border-border p-4 space-y-2">
          <p className="text-xs text-muted-foreground font-medium px-2 pb-2">Scenes</p>
          {scenes.map((scene, i) => (
            <SceneCard
              key={scene.id}
              scene={scene}
              index={i}
              isSelected={selectedScene === i}
              onSelect={() => onSelectScene(i)}
            />
          ))}
        </div>

        {/* Right: master player + info */}
        <div className="w-[45%] overflow-y-auto p-6 space-y-6">
          {masterAudioUrl ? (
            <div className="space-y-3">
              <h2 className="text-sm font-medium text-muted-foreground">Master audio</h2>
              <audio controls src={masterAudioUrl} className="w-full" />
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">No audio available</div>
          )}

          {selectedScene !== null && scenes[selectedScene] && (
            <SceneDetail scene={scenes[selectedScene]} />
          )}

          {/* Layer 6 placeholder */}
          <div className="rounded-xl border border-dashed border-border p-6 text-center space-y-2">
            <div className="text-2xl">🎬</div>
            <p className="text-sm font-medium text-muted-foreground">Visual generation</p>
            <p className="text-xs text-muted-foreground/60">Layer 6 — coming soon</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function SceneCard({
  scene,
  index,
  isSelected,
  onSelect,
}: {
  scene: SceneRow;
  index: number;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const durationSec = Math.round((scene.end_ms - scene.start_ms) / 1000);
  const isA = scene.speaker === 'host_a';

  return (
    <button
      onClick={onSelect}
      className={`w-full text-left rounded-xl border px-3 py-2.5 transition-colors ${
        isSelected
          ? 'border-primary/50 bg-primary/5'
          : 'border-border bg-card hover:border-border/80 hover:bg-accent/30'
      }`}
    >
      <div className="flex items-start gap-2">
        <span className="text-xs text-muted-foreground w-5 shrink-0 mt-0.5">{index + 1}</span>
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-center gap-1.5">
            <span
              className={`text-xs px-1.5 py-0.5 rounded font-mono ${
                isA ? 'bg-blue-500/20 text-blue-400' : 'bg-emerald-500/20 text-emerald-400'
              }`}
            >
              {isA ? 'A' : 'B'}
            </span>
            <span className="text-xs text-muted-foreground">{durationSec}s</span>
            {scene.is_hook && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 font-mono">hook</span>
            )}
            {scene.shot && (
              <span className="text-xs text-muted-foreground/60 font-mono">{scene.shot}</span>
            )}
          </div>
          <p className="text-xs text-foreground/80 line-clamp-2 leading-relaxed">{scene.transcript}</p>
        </div>
      </div>
    </button>
  );
}

function SceneDetail({ scene }: { scene: SceneRow }) {
  const durationSec = ((scene.end_ms - scene.start_ms) / 1000).toFixed(1);
  const startSec = (scene.start_ms / 1000).toFixed(2);
  const isA = scene.speaker === 'host_a';

  return (
    <div className="space-y-4 border-t border-border pt-4">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">Scene {scene.idx + 1}</span>
        <span
          className={`text-xs px-2 py-0.5 rounded font-mono ${
            isA ? 'bg-blue-500/20 text-blue-400' : 'bg-emerald-500/20 text-emerald-400'
          }`}
        >
          {isA ? 'Host A' : 'Host B'}
        </span>
        {scene.shot && (
          <span className="text-xs px-2 py-0.5 rounded font-mono bg-card border border-border text-muted-foreground">
            {scene.shot}
          </span>
        )}
      </div>

      <p className="text-sm text-foreground/90 leading-relaxed">{scene.transcript}</p>

      <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
        <span>{startSec}s → {(scene.end_ms / 1000).toFixed(2)}s</span>
        <span>({durationSec}s)</span>
        <span className="capitalize">{scene.emotion}</span>
      </div>

      {scene.audio_tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {scene.audio_tags.map((tag) => (
            <span key={tag} className="text-xs px-2 py-0.5 rounded-full border border-border font-mono text-muted-foreground">
              [{tag}]
            </span>
          ))}
        </div>
      )}

      {scene.audio_chunk_url && (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground font-medium">Scene audio</p>
          <audio controls src={scene.audio_chunk_url} className="w-full h-8" />
        </div>
      )}
    </div>
  );
}
