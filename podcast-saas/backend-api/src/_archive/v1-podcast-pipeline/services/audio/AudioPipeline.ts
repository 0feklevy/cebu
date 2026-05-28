import { db } from '../../db/index.js';
import { projects, scripts, hosts, audio_renders, scenes, camera_plans, admin_settings } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { AppError, LLMErrorType, type Script as ScriptData } from 'shared';
import type { SSEEmitter } from '../../lib/sse.js';
import { logger } from '../../lib/logger.js';
import { ApiKeyService } from '../secrets/ApiKeyService.js';
import { R2StorageAdapter } from '../storage/R2StorageAdapter.js';
import { ElevenLabsTTSProvider } from './ElevenLabsTTSProvider.js';
import { GeminiTTSProvider } from './GeminiTTSProvider.js';
import { MasterAudioService } from './MasterAudioService.js';
import { ForcedAlignmentService } from './ForcedAlignmentService.js';
import { SceneSegmentationService } from './SceneSegmentationService.js';
import { CameraFSMService } from './CameraFSMService.js';
import type { TTSTurnResult } from './TTSProvider.js';

export class AudioPipeline {
  private readonly storage = new R2StorageAdapter();
  private readonly masterAudio = new MasterAudioService();
  private readonly segmenter = new SceneSegmentationService();
  private readonly cameraFsm = new CameraFSMService();

  async run(
    projectId: string,
    sse: SSEEmitter,
    abortSignal: AbortSignal,
  ): Promise<void> {
    // ── Load project + approved script ──────────────────────────────────────
    const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
    if (!project) throw new AppError(LLMErrorType.LLM_ERROR, 'Project not found', 404);
    if (project.status !== 'approved') {
      throw new AppError(LLMErrorType.LLM_ERROR, 'Script must be approved before audio generation', 400);
    }

    const approvedScript = await db.query.scripts.findFirst({
      where: and(eq(scripts.project_id, projectId), eq(scripts.status, 'approved')),
    });
    if (!approvedScript?.body_json) {
      throw new AppError(LLMErrorType.LLM_ERROR, 'No approved script found', 404);
    }

    const scriptData = approvedScript.body_json as unknown as ScriptData;
    const scriptVersion = approvedScript.version;

    const hostA = project.host_a_id
      ? await db.query.hosts.findFirst({ where: eq(hosts.id, project.host_a_id) })
      : null;
    const hostB = project.host_b_id
      ? await db.query.hosts.findFirst({ where: eq(hosts.id, project.host_b_id) })
      : null;

    // ── Load admin settings for TTS config ──────────────────────────────────
    const settings = await db.query.admin_settings.findFirst();
    if (!settings) throw new AppError(LLMErrorType.LLM_ERROR, 'Admin settings not found', 500);

    // ── Create audio_render row ──────────────────────────────────────────────
    const [renderRow] = await db
      .insert(audio_renders)
      .values({
        project_id: projectId,
        script_version: scriptVersion,
        status: 'processing',
        provider: (settings.tts_provider as 'elevenlabs' | 'gemini') ?? 'elevenlabs',
      })
      .returning();

    await db.update(projects).set({ status: 'generating' }).where(eq(projects.id, projectId));

    try {
      // ── Build TTS provider ─────────────────────────────────────────────────
      const apiKeyService = new ApiKeyService();
      const elevenLabsKey = await apiKeyService.getSystemKey('elevenlabs' as never);
      const geminiKey = await apiKeyService.getSystemKey('gemini');

      const ttsProvider =
        settings.tts_provider === 'gemini' && geminiKey
          ? new GeminiTTSProvider(geminiKey)
          : elevenLabsKey
            ? new ElevenLabsTTSProvider(elevenLabsKey, settings.elevenlabs_model)
            : null;

      if (!ttsProvider) {
        throw new AppError(LLMErrorType.LLM_ERROR, 'No TTS provider configured — set ElevenLabs or Gemini API key', 500);
      }

      // ── Pass 1: TTS per turn ───────────────────────────────────────────────
      sse.emit({ type: 'status', stage: 'audio_tts', message: 'Synthesising voices…', progress: 5 });

      const turns = scriptData.turns;
      const turnResults: TTSTurnResult[] = [];
      let totalCostCents = 0;

      for (let i = 0; i < turns.length; i++) {
        if (abortSignal.aborted) throw new AppError(LLMErrorType.ABORTED, 'Aborted', 499);

        const turn = turns[i];
        const isHostA = turn.speaker === 'host_a';
        const voiceId =
          (isHostA ? hostA?.voice_id : hostB?.voice_id) ??
          (isHostA ? settings.default_voice_id_a : settings.default_voice_id_b) ??
          (isHostA ? 'JBFqnCBsd6RMkjVDRZzb' : 'pNInz6obpgDQGcFmaJgB');

        const result = await ttsProvider.synthesizeTurn(turn, i, voiceId);
        turnResults.push(result);
        totalCostCents += result.costCents;

        sse.emit({ type: 'audio_turn_done', turn_index: i, total_turns: turns.length });
        logger.debug({ turn: i, durationMs: result.durationMs }, 'Turn TTS complete');
      }

      // ── Pass 2: Master audio assembly ──────────────────────────────────────
      sse.emit({ type: 'status', stage: 'audio_assemble', message: 'Assembling master audio…', progress: 55 });

      const segments = turnResults.map((r, i) => ({
        audioBuffer: r.audioBuffer,
        audioFormat: r.audioFormat,
        durationMs: r.durationMs,
        turnIndex: i,
      }));

      const { masterBuffer, totalDurationMs, turnOffsetMs } =
        await this.masterAudio.assemble(segments);

      // Upload master audio
      const masterPath = `projects/${projectId}/audio/v${scriptVersion}/master.wav`;
      const masterUrl = await this.storage.uploadFile(masterPath, masterBuffer, 'audio/wav');

      sse.emit({
        type: 'audio_ready',
        render_id: renderRow.id,
        duration_ms: totalDurationMs,
        master_audio_url: masterUrl,
      });

      // ── Pass 3: Forced alignment ───────────────────────────────────────────
      sse.emit({ type: 'status', stage: 'audio_align', message: 'Aligning text to audio…', progress: 65 });

      const alignmentService = new ForcedAlignmentService(elevenLabsKey ?? undefined);
      const alignment = ttsProvider.providerName === 'elevenlabs'
        ? alignmentService.fromTTSResults(turnResults, turnOffsetMs)
        : await alignmentService.fromMasterAudio(masterBuffer, turns.map((t) => t.text).join(' '));

      // Upload alignment JSON
      const alignPath = `projects/${projectId}/audio/v${scriptVersion}/alignment.json`;
      const alignUrl = await this.storage.uploadFile(
        alignPath,
        Buffer.from(JSON.stringify(alignment)),
        'application/json',
      );

      // ── Pass 4: Scene segmentation ─────────────────────────────────────────
      sse.emit({ type: 'status', stage: 'scene_segment', message: 'Segmenting scenes…', progress: 75 });

      const rawScenes = this.segmenter.segment(scriptData, alignment, totalDurationMs);

      // Extract and upload scene audio chunks in parallel (batches of 10)
      const CHUNK_BATCH = 10;
      const sceneChunkUrls: (string | null)[] = new Array(rawScenes.length).fill(null);

      for (let batch = 0; batch < rawScenes.length; batch += CHUNK_BATCH) {
        const slice = rawScenes.slice(batch, batch + CHUNK_BATCH);
        await Promise.all(
          slice.map(async (sc, j) => {
            const realIdx = batch + j;
            try {
              const chunkBuf = await this.masterAudio.extractChunk(
                masterBuffer,
                sc.start_ms,
                sc.end_ms,
              );
              const chunkPath = `projects/${projectId}/audio/v${scriptVersion}/scenes/scene_${realIdx}.wav`;
              sceneChunkUrls[realIdx] = await this.storage.uploadFile(
                chunkPath,
                chunkBuf,
                'audio/wav',
              );
            } catch (err) {
              logger.warn({ err, sceneIdx: realIdx }, 'Failed to extract scene chunk');
            }
          }),
        );
      }

      // Persist scenes — delete stale rows first
      await db.delete(scenes).where(
        and(eq(scenes.project_id, projectId), eq(scenes.script_version, scriptVersion)),
      );

      for (let i = 0; i < rawScenes.length; i++) {
        const sc = rawScenes[i];
        await db.insert(scenes).values({
          project_id: projectId,
          script_version: scriptVersion,
          idx: sc.idx,
          speaker: sc.speaker,
          start_ms: sc.start_ms,
          end_ms: sc.end_ms,
          transcript: sc.transcript,
          aligned_words: sc.aligned_words as unknown as Record<string, unknown>[],
          emotion: sc.emotion,
          audio_tags: sc.audio_tags,
          is_hook: sc.is_hook,
          audio_chunk_url: sceneChunkUrls[i],
        });
      }

      sse.emit({ type: 'scenes_ready', scene_count: rawScenes.length });

      // ── Pass 5: Camera plan (FSM) ──────────────────────────────────────────
      sse.emit({ type: 'status', stage: 'camera_plan', message: 'Planning camera cuts…', progress: 88 });

      const pacing = (project.pacing ?? 'standard') as 'relaxed' | 'standard' | 'energetic';
      const cameraPlan = this.cameraFsm.generate(rawScenes, pacing, totalDurationMs);

      // Update scenes with FSM shot assignments
      for (const cut of cameraPlan.cuts) {
        const sc = rawScenes[cut.scene_idx];
        if (sc) {
          await db
            .update(scenes)
            .set({ shot: cut.shot })
            .where(
              and(
                eq(scenes.project_id, projectId),
                eq(scenes.script_version, scriptVersion),
                eq(scenes.idx, sc.idx),
              ),
            );
        }
      }

      // Persist camera plan
      await db
        .insert(camera_plans)
        .values({
          project_id: projectId,
          script_version: scriptVersion,
          cuts_json: cameraPlan as unknown as Record<string, unknown>,
        })
        .onConflictDoUpdate({
          target: [camera_plans.project_id, camera_plans.script_version],
          set: { cuts_json: cameraPlan as unknown as Record<string, unknown> },
        });

      sse.emit({ type: 'camera_plan_ready', cut_count: cameraPlan.cuts.length });

      // ── Finalise render row ────────────────────────────────────────────────
      await db.update(audio_renders).set({
        status: 'ready',
        master_audio_url: masterUrl,
        duration_ms: totalDurationMs,
        alignment_json_url: alignUrl,
        cost_cents: totalCostCents,
        finished_at: new Date(),
      }).where(eq(audio_renders.id, renderRow.id));

      await db.update(projects).set({ status: 'ready' }).where(eq(projects.id, projectId));

      sse.emit({ type: 'done', project_id: projectId });
      logger.info(
        { projectId, scriptVersion, scenes: rawScenes.length, cuts: cameraPlan.cuts.length, totalDurationMs },
        'Audio pipeline complete',
      );
    } catch (err) {
      await db.update(audio_renders).set({
        status: 'failed',
        error: (err as Error).message,
        finished_at: new Date(),
      }).where(eq(audio_renders.id, renderRow.id));

      await db.update(projects).set({ status: 'failed' }).where(eq(projects.id, projectId));
      throw err;
    }
  }
}
