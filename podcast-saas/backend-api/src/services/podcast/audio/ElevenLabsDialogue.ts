/**
 * ElevenLabs v3 Text-to-Dialogue client (with timestamps).
 *
 * We use the dialogue endpoint (not per-turn TTS) so v3 keeps emotional continuity
 * ACROSS speakers within a chunk, and the `voice_segments` timestamps let us recut
 * the stitched audio per line and rebuild the timing ourselves (that's how we strip
 * v3's inter-line dead air). Verified against the live API:
 *   POST /v1/text-to-dialogue/with-timestamps
 *   body: { inputs:[{text, voice_id}], model_id:'eleven_v3', seed, settings:{stability},
 *           language_code, apply_text_normalization }
 *   caps: ≤ 2,000 chars total across inputs, ≤ 10 unique voices.
 */

import { ApiKeyService } from '../../secrets/ApiKeyService.js';
import { AppError, LLMErrorType } from 'shared';
import { logger } from '../../../lib/logger.js';

const EL_BASE = 'https://api.elevenlabs.io/v1';

export interface DialogueInput { text: string; voice_id: string }

export interface VoiceSegment {
  voice_id: string;
  start_time_seconds: number;
  end_time_seconds: number;
  character_start_index: number;
  character_end_index: number;
  dialogue_input_index: number;
}

export interface DialogueResult {
  audio: Buffer;
  format: 'mp3' | 'pcm';
  sampleRate: number;
  voiceSegments: VoiceSegment[];
}

export class ElevenLabsDialogue {
  constructor(private readonly apiKeyService: ApiKeyService = new ApiKeyService()) {}

  private async getKey(): Promise<string> {
    const key = (await this.apiKeyService.getSystemKey('elevenlabs')) ?? process.env.ELEVENLABS_API_KEY ?? null;
    if (!key) throw new AppError(LLMErrorType.LLM_ERROR, 'ElevenLabs API key not configured (Admin → API Keys or ELEVENLABS_API_KEY)', 500);
    return key;
  }

  /**
   * Synthesize one chunk of dialogue. `outputFormat` defaults to mp3_44100_128;
   * pass a pcm format if the plan tier allows (avoids mp3 encoder-delay guesswork).
   */
  async synthesize(params: {
    inputs: DialogueInput[];
    seed?: number;
    languageCode?: string;
    outputFormat?: string;
    stability?: number;
    signal?: AbortSignal;
  }): Promise<DialogueResult> {
    const key = await this.getKey();
    const outputFormat = params.outputFormat ?? 'mp3_44100_128';
    const isPcm = outputFormat.startsWith('pcm_');
    const sampleRate = Number(outputFormat.split('_')[1] ?? '44100');

    const body: Record<string, unknown> = {
      inputs: params.inputs,
      model_id: 'eleven_v3',
      settings: { stability: params.stability ?? 0.5 },
      apply_text_normalization: 'off', // the compiler already spelled numbers; keeps char indices stable
    };
    if (params.seed != null) body.seed = params.seed;
    if (params.languageCode) body.language_code = params.languageCode;

    const res = await fetch(`${EL_BASE}/text-to-dialogue/with-timestamps?output_format=${encodeURIComponent(outputFormat)}`, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: params.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      logger.warn({ status: res.status, detail: detail.slice(0, 300) }, 'ElevenLabs dialogue failed');
      throw new AppError(LLMErrorType.LLM_ERROR, `ElevenLabs dialogue error ${res.status}: ${detail.slice(0, 200)}`, 502);
    }

    const data = (await res.json()) as { audio_base64?: string; voice_segments?: VoiceSegment[] };
    if (!data.audio_base64) throw new AppError(LLMErrorType.LLM_ERROR, 'ElevenLabs returned no audio', 502);

    return {
      audio: Buffer.from(data.audio_base64, 'base64'),
      format: isPcm ? 'pcm' : 'mp3',
      sampleRate,
      voiceSegments: data.voice_segments ?? [],
    };
  }
}
