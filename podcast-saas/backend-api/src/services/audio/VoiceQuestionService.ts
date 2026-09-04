/**
 * A spoken question, answered aloud — the car-mode half of Raise Your Hand (night run 2026-09-03 §4).
 *
 * Chained, on purpose: speech-to-text (Groq Whisper, already metered) → the SAME question path the
 * typed flow uses (`askListenerQuestion`: record first, cap, transcript window, utility-tier model)
 * → text-to-speech (ElevenLabs, already metered). No new vendor, no new ledger, no new abuse
 * surface: the daily answer cap and the per-IP limit that protect the typed route protect this
 * one, and every paid call leaves a `token_usage` row.
 *
 * What this file adds is exactly two things and their failure rules:
 *   - an utterance that transcribes to nothing is a MISFIRE, not a question: no row, no cap,
 *     `nothing_heard`, so wind noise cannot burn a creator's day;
 *   - a text-to-speech failure never loses the answer: the text still goes back, and the client
 *     speaks it with the device's own voice.
 */
import { readFile, stat } from 'node:fs/promises';
import Groq from 'groq-sdk';
import { logger } from '../../lib/logger.js';
import { resolveGroqKey } from '../captions/groqKey.js';
import { recordSttSpend } from '../usage/recordSttSpend.js';
import { recordTtsSpend } from '../usage/recordTtsSpend.js';
import { evaluateSpendCeiling } from '../usage/spendCeiling.js';
import { VOICE_QUESTION_MAX_SECONDS } from 'shared';
import { reportedDurationSec } from '../usage/sttCost.js';
import { GuidanceTTSService, resolveGuidanceVoice } from './GuidanceTTSService.js';
import { askListenerQuestion, prefetchAskContext, type AskResult } from './ListenerQuestionService.js';
import { SentenceSplitter } from './sentenceStream.js';
import type { VoiceStreamEvent } from 'shared';

export interface VoiceQuestionInput {
  projectId: string;
  language?: string | null;
  positionMs: number;
  /** A WAV/PCM file on disk, already bounded by the route. */
  audioPath: string;
  userId?: string | null;
}

export interface VoiceQuestionResult {
  status: 'answered' | 'saved' | 'refused' | 'nothing_heard';
  question: string | null;
  answer: string | null;
  message: string | null;
  /** mp3 bytes of the spoken answer, or null when synthesis failed or there was no answer. */
  audio: Buffer | null;
  audioMime: string | null;
}

/** The seams, injectable so the unit test never touches a vendor. */
export interface VoiceQuestionDeps {
  transcribe: (audioPath: string, language: string | null) => Promise<{ text: string; durationSec: number | null; model: string }>;
  ask: (input: Parameters<typeof askListenerQuestion>[0]) => Promise<AskResult>;
  /** Grounding rows fetched concurrently with STT; optional so older test doubles need no change. */
  prefetchAsk?: (projectId: string, language: string | null) => ReturnType<typeof prefetchAskContext>;
  synthesize: (text: string, language: string) => Promise<{ audio: Buffer; model: string }>;
  recordStt: typeof recordSttSpend;
  recordTts: typeof recordTtsSpend;
}

/** Groq Whisper on one bounded file; plain text, and the vendor's own duration for the ledger. */
async function transcribeWithGroq(audioPath: string, language: string | null) {
  const apiKey = await resolveGroqKey();
  if (!apiKey) throw new Error('Groq key not configured (Admin → API Keys, or GROQ_API_KEY)');
  const { size } = await stat(audioPath);
  const groq = new Groq({ apiKey });
  // Its OWN default, not the captions pipeline's: a live question needs latency, and turbo is
  // several times faster at accuracy that is ample for short conversational speech. Captions keep
  // whisper-large-v3 for archival quality; override here with VOICE_STT_MODEL when needed.
  const model = process.env.VOICE_STT_MODEL || 'whisper-large-v3-turbo';
  const file = new File([await readFile(audioPath)], 'question.wav', { type: 'audio/wav' });
  const res = await groq.audio.transcriptions.create({
    file,
    model,
    response_format: 'verbose_json',
    ...(language ? { language } : {}),
  } as Parameters<typeof groq.audio.transcriptions.create>[0]);
  const text = String((res as unknown as { text?: string }).text ?? '').trim();
  logger.debug({ bytes: size, chars: text.length }, '[voice-question] transcribed');
  return { text, durationSec: reportedDurationSec(res), model };
}

/**
 * Voice-question TTS: the FAST model, resolved once and cached, synthesized by a singleton.
 *
 * The old shape constructed `new GuidanceTTSService()` per SENTENCE (its ApiKeyService cache was
 * always cold) and ran `resolveGuidanceVoice`'s admin_settings read per sentence too — two DB
 * round-trips inside every spoken sentence of every answer. And it inherited guidance narration's
 * quality-first `eleven_multilingual_v2`, the slowest model, for an interactive reply where the
 * listener is waiting. Flash is the conversational-latency model; guidance publishing keeps its
 * own resolution untouched.
 */
const voiceTts = new GuidanceTTSService();
let voiceCfgCache: { cfg: { voiceId: string; model: string }; language: string; at: number } | null = null;
const VOICE_CFG_TTL_MS = 5 * 60_000;
async function resolveVoiceAnswerConfig(language: string) {
  const now = Date.now();
  if (voiceCfgCache && voiceCfgCache.language === language && now - voiceCfgCache.at < VOICE_CFG_TTL_MS) {
    return voiceCfgCache.cfg;
  }
  const base = await resolveGuidanceVoice(language);
  const cfg = { voiceId: base.voiceId, model: process.env.VOICE_TTS_MODEL || 'eleven_flash_v2_5' };
  voiceCfgCache = { cfg, language, at: now };
  return cfg;
}

async function synthesizeWithElevenLabs(text: string, language: string) {
  const cfg = await resolveVoiceAnswerConfig(language);
  const audio = await voiceTts.synthesize(text, cfg);
  return { audio, model: cfg.model };
}

export const defaultVoiceQuestionDeps: VoiceQuestionDeps = {
  transcribe: transcribeWithGroq,
  ask: (input) => askListenerQuestion(input),
  prefetchAsk: (projectId, language) => prefetchAskContext(projectId, language),
  synthesize: synthesizeWithElevenLabs,
  // Written as CALLS, not references: the spend contract (spendContract.test.ts) recognises a
  // recorder by `record*Spend(` on the path from a paid vendor, and a bare reference reads as an
  // import that never fires.
  recordStt: (spend) => recordSttSpend(spend),
  recordTts: (spend) => recordTtsSpend(spend),
};

/** Whisper's habit on silence: it hallucinates a stock phrase. These are not questions. */
const NOISE_TRANSCRIPTS = new Set([
  '', '.', 'you', 'thank you', 'thank you.', 'thanks for watching', 'thanks for watching.',
  'bye', 'bye.', 'hmm', 'mm', 'uh', 'um',
]);

export function isNoiseTranscript(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/\s+/g, ' ');
  if (NOISE_TRANSCRIPTS.has(t)) return true;
  // Fewer than two real words is not a question anyone meant to ask.
  return t.replace(/[^\p{L}\p{N}\s]/gu, '').split(' ').filter(Boolean).length < 2;
}

export async function answerVoiceQuestion(
  input: VoiceQuestionInput,
  deps: VoiceQuestionDeps = defaultVoiceQuestionDeps,
): Promise<VoiceQuestionResult> {
  const language = input.language?.trim() || null;

  // 1. Hear it. Billed on the vendor's reported duration whatever we decide about the words.
  const heard = await deps.transcribe(input.audioPath, language);
  void deps.recordStt({
    userId: input.userId ?? null,
    projectId: input.projectId,
    task: 'listener_voice_question',
    durationSec: heard.durationSec,
    model: heard.model,
  });
  if (isNoiseTranscript(heard.text)) {
    return { status: 'nothing_heard', question: null, answer: null, message: null, audio: null, audioMime: null };
  }
  // The client truncates at 30 s; the SERVER holds the line, because 2 MB of 16 kHz mono is a
  // minute of audio and a non-browser caller could otherwise double the STT and model spend per
  // question. Judged on the vendor's own duration, after it was (unavoidably) billed.
  if (heard.durationSec !== null && heard.durationSec > VOICE_QUESTION_MAX_SECONDS) {
    return {
      status: 'refused', question: heard.text, answer: null,
      message: `That was longer than a question — keep it under ${VOICE_QUESTION_MAX_SECONDS} seconds.`,
      audio: null, audioMime: null,
    };
  }

  // 2. Answer it — the typed path, unchanged: record before answer, cap, grounding, utility tier.
  const asked = await deps.ask({
    projectId: input.projectId,
    language,
    positionMs: input.positionMs,
    question: heard.text,
    intent: 'answer',
    userId: input.userId ?? null,
  });
  if (asked.status !== 'answered' || !asked.answer) {
    return {
      status: asked.status,
      question: heard.text,
      answer: null,
      message: asked.reason ?? null,
      audio: null,
      audioMime: null,
    };
  }

  // 3. Say it. A synthesis failure keeps the answer — the client has a voice of its own.
  // THE CEILING FIRST (ceilingCoverage.test.ts): an anonymous listener's question must never be
  // the call that takes the account past its monthly ElevenLabs limit. Shadow by default, like
  // every other spender; under enforce a refusal degrades to the device voice, not to silence.
  let audio: Buffer | null = null;
  let audioMime: string | null = null;
  try {
    const ceiling = await evaluateSpendCeiling({ provider: 'elevenlabs' });
    if (ceiling.refuse) throw new Error(ceiling.reason ?? 'Monthly ElevenLabs spend ceiling reached.');
    const spoken = await deps.synthesize(asked.answer, language ?? 'en');
    audio = spoken.audio;
    audioMime = 'audio/mpeg';
    void deps.recordTts({
      userId: input.userId ?? null,
      projectId: input.projectId,
      task: 'listener_voice_answer',
      characters: asked.answer.length,
      model: spoken.model,
    });
  } catch (err) {
    logger.warn({ err, projectId: input.projectId }, '[voice-question] text-to-speech failed — returning text only');
  }

  return { status: 'answered', question: heard.text, answer: asked.answer, message: null, audio, audioMime };
}

/**
 * The interactive answer (owner ruling 2026-09-03 — Tap to ask like NotebookLM's interrupt):
 * hear → answer → speak, but the speaking starts on the FIRST SENTENCE while the model is still
 * writing. Every event goes to `onEvent` in order; the caller streams them to the listener.
 *
 * Same guards and the same ledger as the one-shot path: the STT spend on the vendor's duration,
 * the noise and length refusals, the typed path's record-before-answer and daily cap (through
 * deps.ask), the ElevenLabs ceiling before the first synthesis, one TTS spend for the whole
 * answer. Synthesis runs one sentence behind the model, in order, on a promise chain; a synthesis
 * failure drops that sentence's audio (the client's device voice reads the final text when no
 * chunk had audio) and never the answer.
 */
export async function answerVoiceQuestionStream(
  input: VoiceQuestionInput,
  onEvent: (event: VoiceStreamEvent) => void,
  deps: VoiceQuestionDeps = defaultVoiceQuestionDeps,
  signal?: AbortSignal,
): Promise<void> {
  const language = input.language?.trim() || null;
  const t0 = Date.now();

  // Everything that does NOT need the transcript starts NOW, concurrently with Whisper: the
  // TTS spend ceiling and the grounding rows (project, day-count, edition) were serial stages
  // on the critical path — pure added latency for a listener who is waiting in silence.
  const ceilingPromise: Promise<boolean> = evaluateSpendCeiling({ provider: 'elevenlabs' })
    .then((ceiling) => {
      if (ceiling.refuse) logger.warn({ reason: ceiling.reason, projectId: input.projectId }, '[voice-question] ceiling reached — text only');
      return !ceiling.refuse;
    })
    .catch((err) => {
      logger.warn({ err, projectId: input.projectId }, '[voice-question] ceiling check failed — text only');
      return false;
    });
  const prefetchPromise = deps.prefetchAsk?.(input.projectId, language).catch((err) => {
    logger.warn({ err, projectId: input.projectId }, '[voice-question] context prefetch failed — fetching inline');
    return undefined;
  });

  const heard = await deps.transcribe(input.audioPath, language);
  const sttMs = Date.now() - t0;
  void deps.recordStt({
    userId: input.userId ?? null, projectId: input.projectId,
    task: 'listener_voice_question', durationSec: heard.durationSec, model: heard.model,
  });
  if (isNoiseTranscript(heard.text)) {
    onEvent({ type: 'done', status: 'nothing_heard', question: null, answer: null, message: null, audio_chunks: 0 });
    return;
  }
  if (heard.durationSec !== null && heard.durationSec > VOICE_QUESTION_MAX_SECONDS) {
    onEvent({ type: 'done', status: 'refused', question: heard.text, answer: null, message: `That was longer than a question — keep it under ${VOICE_QUESTION_MAX_SECONDS} seconds.`, audio_chunks: 0 });
    return;
  }
  onEvent({ type: 'heard', question: heard.text });

  // Resolved concurrently with the transcription above; a refusal means text only.
  const speak = await ceilingPromise;

  // firstMinChars 12: the opener is what the listener is waiting on — a short first clause
  // reaching TTS sooner beats a longer one.
  const splitter = new SentenceSplitter({ firstMinChars: 12 });
  let seq = 0;
  let spokenChars = 0;
  let model: string | null = null;
  let firstAudioMs: number | null = null;
  // TWO synths in flight, emission strictly ordered: launch is gated on the request two back
  // having settled (so a long sentence cannot starve the pipeline, and ElevenLabs sees at most
  // two concurrent requests), while the emit chain releases each clip in seq order.
  const synths: Promise<{ audio: Buffer; model: string } | null>[] = [];
  let emitChain: Promise<void> = Promise.resolve();
  const speakSentence = (text: string) => {
    if (!speak || signal?.aborted) return;
    const mine = seq++;
    const launchGate = synths[mine - 2]?.catch(() => null) ?? Promise.resolve(null);
    const synth = launchGate.then(async () => {
      if (signal?.aborted) return null;
      try {
        return await deps.synthesize(text, language ?? 'en');
      } catch (err) {
        logger.warn({ err, projectId: input.projectId, seq: mine }, '[voice-question] sentence synthesis failed — skipped');
        return null;
      }
    });
    synths.push(synth);
    emitChain = emitChain.then(async () => {
      const spoken = await synth;
      if (!spoken || signal?.aborted) return;
      model = spoken.model;
      spokenChars += text.length;
      if (firstAudioMs === null) firstAudioMs = Date.now() - t0;
      onEvent({ type: 'audio', seq: mine, audio_base64: spoken.audio.toString('base64'), audio_mime: 'audio/mpeg', text });
    });
  };

  const asked = await deps.ask({
    projectId: input.projectId, language, positionMs: input.positionMs,
    question: heard.text, intent: 'answer', userId: input.userId ?? null,
    prefetched: prefetchPromise ? await prefetchPromise : undefined,
    onTokenChunk: (chunk) => { for (const sentence of splitter.push(chunk)) speakSentence(sentence); },
    abortSignal: signal,
  });
  for (const sentence of splitter.flush()) speakSentence(sentence);
  await emitChain;
  // The phase timings ARE the health check for "fast": without them a latency regression is
  // invisible until an owner complains (which is how this rework started).
  logger.info(
    { projectId: input.projectId, sttMs, firstAudioMs, totalMs: Date.now() - t0, sentences: seq },
    '[voice-question] stream timings',
  );

  if (asked.status !== 'answered' || !asked.answer) {
    onEvent({ type: 'done', status: asked.status, question: heard.text, answer: null, message: asked.reason ?? null, audio_chunks: 0 });
    return;
  }
  if (spokenChars > 0) {
    void deps.recordTts({
      userId: input.userId ?? null, projectId: input.projectId,
      task: 'listener_voice_answer', characters: spokenChars, model: model ?? 'unknown',
    });
  }
  onEvent({ type: 'done', status: 'answered', question: heard.text, answer: asked.answer, message: null, audio_chunks: seq });
}
