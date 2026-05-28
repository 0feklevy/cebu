import { GoogleGenAI } from '@google/genai';
import type { DialogueTurn, AlignedWord } from 'shared';
import type { TTSProvider, TTSTurnResult } from './TTSProvider.js';
import { formatTurnText } from './TTSProvider.js';
import { logger } from '../../lib/logger.js';

// Build a minimal WAV header around raw PCM (16-bit signed LE, mono or stereo)
function pcmToWav(pcm: Buffer, sampleRate: number, numChannels = 1, bitsPerSample = 16): Buffer {
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);       // PCM chunk size
  header.writeUInt16LE(1, 20);        // PCM format
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}

function extractSampleRate(mimeType: string): number {
  const match = mimeType.match(/rate=(\d+)/);
  return match ? parseInt(match[1], 10) : 24000;
}

// Gemini 2.5 Flash TTS — single-speaker path (multi-speaker handled at pipeline level)
// Used as a cost-optimal fallback when ElevenLabs is not configured.
export class GeminiTTSProvider implements TTSProvider {
  readonly providerName = 'gemini' as const;
  private readonly client: GoogleGenAI;

  constructor(apiKey: string) {
    this.client = new GoogleGenAI({ apiKey });
  }

  async synthesizeTurn(
    turn: DialogueTurn,
    turnIndex: number,
    _voiceId: string,
  ): Promise<TTSTurnResult> {
    const text = formatTurnText(turn);

    logger.debug({ turnIndex, chars: text.length }, 'Gemini TTS synthesizeTurn');

    // Gemini Flash TTS — single speaker, no per-turn voice selection
    const response = await this.client.models.generateContent({
      model: 'gemini-2.5-flash-preview-tts',
      contents: [{ role: 'user', parts: [{ text }] }],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: 'Charon' },
          },
        },
      } as Record<string, unknown>,
    });

    const candidates = response.candidates ?? [];
    const parts = (candidates[0]?.content?.parts ?? []) as any[];
    const audioPart = parts.find((p: any) => p?.inlineData?.mimeType?.startsWith('audio/'));

    if (!audioPart || !audioPart.inlineData?.data) {
      throw new Error('Gemini TTS returned no audio data');
    }

    const mimeType: string = audioPart.inlineData.mimeType ?? 'audio/wav';
    const rawBuffer = Buffer.from(audioPart.inlineData.data as string, 'base64');

    // Gemini may return raw PCM (audio/L16 or audio/pcm) — wrap in WAV header
    const isPcm = mimeType.includes('L16') || mimeType.includes('pcm');
    const audioBuffer = isPcm
      ? pcmToWav(rawBuffer, extractSampleRate(mimeType))
      : rawBuffer;

    // Gemini TTS returns PCM — no timestamp data available
    // Duration estimate: 130 wpm average
    const wordCount = text.split(/\s+/).length;
    const durationMs = Math.round((wordCount / 130) * 60 * 1000);

    // No word alignment from Gemini — forced alignment runs separately
    const alignedWords: AlignedWord[] = [];

    // Gemini cost is very low: $0.003 / 1K characters
    const costCents = Math.round(text.length * 0.0003);

    return { audioBuffer, audioFormat: 'wav', durationMs, alignedWords, costCents };
  }
}
