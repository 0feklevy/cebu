/**
 * Single-line audio preview. Synthesizes the target line WITH its neighbours (a
 * 3-input dialogue) so v3 gives it conversational context — v3 renders <250-char
 * lines inconsistently in isolation — then recuts just the middle line. Cached by
 * a content hash so repeated clicks don't re-synthesize. Labelled "approximate" in
 * the UI because the final render may differ slightly.
 */

import { createHash } from 'crypto';
import { mkdtemp, rm, writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { and, eq } from 'drizzle-orm';
import { db } from '../../../db/index.js';
import { podcast_chunk_audio } from '../../../db/schema.js';
import type { PodcastShow, PodcastEpisode } from '../../../db/schema.js';
import { getStorageAdapter } from '../../storage/getStorageAdapter.js';
import { PodcastVoiceService } from '../PodcastVoiceService.js';
import { ElevenLabsDialogue } from './ElevenLabsDialogue.js';
import { decodeToWav, extractClip, measureLufs, gainToTarget, encodeMp3, probeDurationMs } from './ffmpegAudio.js';
import type { PodcastTurn } from 'shared';

const OUTPUT_FORMAT = process.env.PODCAST_TTS_FORMAT ?? 'mp3_44100_128';
const DL_TTL = 60 * 60;

export async function previewTurn(params: {
  show: PodcastShow;
  episode: PodcastEpisode;
  turns: PodcastTurn[];
  index: number;
}): Promise<string> {
  const { show, episode, turns, index } = params;
  const storage = getStorageAdapter();
  const target = turns[index];

  // Resolve voices.
  let teacher = show.teacher_voice_id;
  let learner = show.learner_voice_id;
  if (!teacher || !learner) {
    const r = await new PodcastVoiceService().resolveDefaultVoices(show.teacher_name, show.learner_name);
    teacher = teacher ?? r.teacher_voice_id;
    learner = learner ?? r.learner_voice_id;
  }
  if (!teacher || !learner) throw new Error('No ElevenLabs voices set for this show');
  const voiceFor = (sp: 'teacher' | 'learner') => (sp === 'teacher' ? teacher! : learner!);

  const prev = index > 0 ? turns[index - 1] : null;
  const next = index < turns.length - 1 ? turns[index + 1] : null;
  const inputs = [
    ...(prev ? [{ text: prev.text, voice_id: voiceFor(prev.speaker) }] : []),
    { text: target.text, voice_id: voiceFor(target.speaker) },
    ...(next ? [{ text: next.text, voice_id: voiceFor(next.speaker) }] : []),
  ];
  const targetInputIndex = prev ? 1 : 0;
  const seed = episode.tts_seed ?? 1234;

  const hash = createHash('sha256').update(JSON.stringify({ inputs, seed, targetInputIndex, fmt: OUTPUT_FORMAT, kind: 'preview' })).digest('hex');

  // Cache hit → presigned URL.
  const cached = await db.query.podcast_chunk_audio.findFirst({
    where: and(eq(podcast_chunk_audio.episode_id, episode.id), eq(podcast_chunk_audio.chunk_hash, hash)),
  });
  if (cached?.storage_key) return storage.getPresignedDownloadUrl(cached.storage_key, DL_TTL);

  const workDir = await mkdtemp(join(tmpdir(), 'podcast-preview-'));
  try {
    const result = await new ElevenLabsDialogue().synthesize({ inputs, seed, outputFormat: OUTPUT_FORMAT, stability: 0.5 });
    const isPcm = result.format === 'pcm';
    const raw = join(workDir, `p.${isPcm ? 'pcm' : 'mp3'}`);
    await writeFile(raw, result.audio);
    const wav = join(workDir, 'p.wav');
    await decodeToWav(raw, wav, isPcm ? { pcm: true, pcmRate: result.sampleRate } : undefined);
    const totalDur = (await probeDurationMs(wav)) / 1000;

    const seg = result.voiceSegments.find((s) => s.dialogue_input_index === targetInputIndex);
    const start = seg ? Math.max(0, seg.start_time_seconds - 0.12) : 0;
    const end = seg ? Math.min(totalDur, seg.end_time_seconds + 0.12) : totalDur;
    const gain = gainToTarget(await measureLufs(wav));
    const clipWav = join(workDir, 'clip.wav');
    await extractClip(wav, clipWav, start, end, gain);
    const mp3 = join(workDir, 'clip.mp3');
    await encodeMp3(clipWav, mp3);

    const key = `podcasts/${episode.id}/previews/${hash}.mp3`;
    await storage.uploadFile(key, await readFile(mp3), 'audio/mpeg', 'public, max-age=3600');
    await db.insert(podcast_chunk_audio).values({
      episode_id: episode.id, chunk_hash: hash, storage_key: key, kind: 'preview',
    }).onConflictDoNothing();

    return storage.getPresignedDownloadUrl(key, DL_TTL);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
