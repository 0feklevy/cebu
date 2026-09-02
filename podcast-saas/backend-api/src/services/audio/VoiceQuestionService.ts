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
import { askListenerQuestion, type AskResult } from './ListenerQuestionService.js';

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
  const model = process.env.CAPTIONS_GROQ_MODEL || 'whisper-large-v3';
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

async function synthesizeWithElevenLabs(text: string, language: string) {
  const cfg = await resolveGuidanceVoice(language);
  const audio = await new GuidanceTTSService().synthesize(text, cfg);
  return { audio, model: cfg.model };
}

export const defaultVoiceQuestionDeps: VoiceQuestionDeps = {
  transcribe: transcribeWithGroq,
  ask: (input) => askListenerQuestion(input),
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
