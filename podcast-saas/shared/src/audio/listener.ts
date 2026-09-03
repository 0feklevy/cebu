/**
 * The listener page's wire contract — what `/api/v1/public/audio/:slug` returns and what the two
 * question routes answer. ONE definition, used by the server to type its replies and by the
 * client to parse them, because until now each side kept its own hand-written copy of these
 * shapes and nothing reconciled them (night run 2026-09-03 §4).
 */
import { z } from 'zod';

export const AudioChapterSchema = z.object({
  startMs: z.number(),
  endMs: z.number(),
  title: z.string(),
});
export type AudioChapter = z.infer<typeof AudioChapterSchema>;

export const AudioEditionViewSchema = z.object({
  title: z.string().nullable(),
  description: z.string().nullable(),
  audio_url: z.string(),
  duration_ms: z.number().nullable(),
  chapters: z.array(AudioChapterSchema),
  captions_url: z.string().nullable(),
  language: z.string().nullable(),
  updated_at: z.union([z.string(), z.date()]).nullable(),
  /** Cover art for the player and the lock screen. Optional so an ISR-cached page keeps parsing. */
  artwork_url: z.string().nullable().optional(),
});
export type AudioEditionView = z.infer<typeof AudioEditionViewSchema>;

/** The typed question's answer (A2.4). */
export const AskQuestionResponseSchema = z.object({
  status: z.enum(['answered', 'saved', 'refused']),
  answer: z.string().nullable(),
  /** Present when the answer was withheld — WHY, so the listener never watches a silent non-response. */
  message: z.string().nullable(),
});
export type AskQuestionResponse = z.infer<typeof AskQuestionResponseSchema>;

/**
 * The spoken question's answer (car mode). `nothing_heard` is the VAD misfire the server can see —
 * an utterance that transcribed to nothing — and costs no answer budget. `audio_base64` is an mp3
 * of the answer when text-to-speech succeeded; the client falls back to the device's own voice
 * when it is null, so a vendor outage degrades to a robotic voice rather than to silence.
 */
export const VoiceQuestionResponseSchema = z.object({
  status: z.enum(['answered', 'saved', 'refused', 'nothing_heard']),
  question: z.string().nullable(),
  answer: z.string().nullable(),
  message: z.string().nullable(),
  audio_base64: z.string().nullable(),
  audio_mime: z.string().nullable(),
});
export type VoiceQuestionResponse = z.infer<typeof VoiceQuestionResponseSchema>;

/**
 * The interactive answer, as the streaming route sends it (SSE). `heard` arrives after the
 * transcript; `audio` chunks are the answer one SENTENCE at a time, in order, each an mp3 —
 * the listener hears the first while the model writes the rest; `done` closes with the whole
 * text (the device voice's fallback when no chunk had audio) and the final status.
 */
export const VoiceStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('heard'), question: z.string() }),
  z.object({ type: z.literal('audio'), seq: z.number().int().nonnegative(), audio_base64: z.string(), audio_mime: z.string(), text: z.string() }),
  z.object({
    type: z.literal('done'),
    status: z.enum(['answered', 'saved', 'refused', 'nothing_heard']),
    question: z.string().nullable(),
    answer: z.string().nullable(),
    message: z.string().nullable(),
    audio_chunks: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export type VoiceStreamEvent = z.infer<typeof VoiceStreamEventSchema>;

/** Upload ceiling for one spoken question: 30 s of 16 kHz 16-bit mono is 960 KB; 2 MB leaves room. */
export const VOICE_QUESTION_MAX_BYTES = 2 * 1024 * 1024;
/** The longest utterance the loop will send. Longer than this and the listener is dictating, not asking. */
export const VOICE_QUESTION_MAX_SECONDS = 30;
