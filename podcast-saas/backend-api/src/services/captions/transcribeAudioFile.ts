/**
 * Groq Whisper transcription of one audio file to WebVTT.
 *
 * Extracted from `CaptionService.transcribeWithGroq` so that the dubbing pipeline can reuse the
 * exact same transcription — same model, same size limit, same segment-to-cue conversion — rather
 * than growing a second implementation that would drift from it. CaptionService still owns the
 * source-language job (claiming, storage, propagation); this module owns only "bytes in, VTT out".
 *
 * The dubbing caller uses it for one narrow purpose: transcribing the DUBBED audio when the dubbing
 * vendor did not supply its own transcript. That is the only acceptable fallback, because it still
 * describes the audio the viewer hears. Translating the source independently is not.
 */
import { readFile, stat } from 'fs/promises';
import Groq from 'groq-sdk';
import { segmentsToVtt, type VttSegment } from './CaptionService.js';
import { recordSttSpend } from '../usage/recordSttSpend.js';
import { reportedDurationSec } from '../usage/sttCost.js';
import { resolveGroqKey } from './groqKey.js';

/** Groq's audio upload limit (~25 MB). 16 kHz mono mp3 ≈ 0.5 MB/min → roughly 50 minutes. */
export const GROQ_MAX_BYTES = 24 * 1024 * 1024;

/**
 * Transcribe `audioPath` to WebVTT, or return null when there is nothing usable to say.
 *
 * Returns null rather than throwing on an empty transcription: for the dubbing caller a missing
 * caption track is a degraded result, not a reason to fail a dub that has already been paid for.
 * Genuine errors (no key, file too large, vendor failure) still throw, because those describe a
 * misconfiguration the operator needs to see.
 */
export async function transcribeAudioFileToVtt(
  audioPath: string,
  opts: {
    language?: string;
    /**
     * Who to bill this transcription to. Optional, and the recording only happens when it is
     * supplied — an unattributed row is still worth more than none, but the CALLER is the only
     * thing that knows the project, so making it explicit keeps the attribution honest rather
     * than defaulting to null and looking complete.
     */
    spend?: { userId: string | null; projectId: string | null; task: string };
  } = {},
): Promise<string | null> {
  const apiKey = await resolveGroqKey();
  if (!apiKey) throw new Error('Groq key not configured (Admin → API Keys, or GROQ_API_KEY)');

  const { size } = await stat(audioPath);
  if (size > GROQ_MAX_BYTES) {
    throw new Error(
      `Extracted audio is ${(size / 1048576).toFixed(1)} MB, over the ${GROQ_MAX_BYTES / 1048576} MB ` +
      `transcription limit (media too long for single-shot captioning).`,
    );
  }

  const groq = new Groq({ apiKey });
  const model = process.env.CAPTIONS_GROQ_MODEL || 'whisper-large-v3';
  const file = new File([await readFile(audioPath)], 'audio.mp3', { type: 'audio/mpeg' });
  const language = opts.language || process.env.WHISPER_CPP_LANGUAGE || process.env.WHISPER_LANGUAGE;

  const res = await groq.audio.transcriptions.create({
    file,
    model,
    response_format: 'verbose_json',
    ...(language ? { language } : {}),
  } as Parameters<typeof groq.audio.transcriptions.create>[0]);

  // BILLED ON THE VENDOR'S OWN DURATION, recorded before the response is interpreted: whatever
  // this function decides to do with the segments, the audio was processed and charged for.
  if (opts.spend) {
    void recordSttSpend({ ...opts.spend, durationSec: reportedDurationSec(res), model });
  }

  const segments = (res as unknown as { segments?: VttSegment[] }).segments;
  if (Array.isArray(segments) && segments.length > 0) return segmentsToVtt(segments);

  // No timestamps returned → a single full-length cue is still better than nothing.
  const text = (res as unknown as { text?: string }).text?.trim();
  if (text) return `WEBVTT\n\n1\n00:00:00.000 --> 00:00:05.000\n${text}\n`;
  return null;
}
