import type { DialogueTurn } from 'shared';
import type { AlignedWord } from 'shared';

export interface TTSTurnResult {
  audioBuffer: Buffer;   // MP3 or WAV bytes
  audioFormat: 'mp3' | 'wav';
  durationMs: number;
  alignedWords: AlignedWord[];
  costCents: number;
}

export interface TTSProvider {
  readonly providerName: 'elevenlabs' | 'gemini';
  synthesizeTurn(
    turn: DialogueTurn,
    turnIndex: number,
    voiceId: string,
  ): Promise<TTSTurnResult>;
}

// Format audio_tags inline into the text for ElevenLabs
export function formatTurnText(turn: DialogueTurn): string {
  const tagPrefix = turn.audio_tags.length
    ? turn.audio_tags.map((t) => `[${t}]`).join(' ') + ' '
    : '';
  return tagPrefix + turn.text;
}

// Map emotion to ElevenLabs style value (0.0–1.0)
export function emotionToStyle(emotion: string): number {
  const map: Record<string, number> = {
    neutral: 0.2,
    enthusiastic: 0.75,
    excited: 0.85,
    thoughtful: 0.3,
    analytical: 0.25,
    amused: 0.6,
    surprised: 0.7,
    curious: 0.5,
    concerned: 0.3,
    confused: 0.35,
    impressed: 0.65,
    skeptical: 0.3,
    empathetic: 0.4,
    agreeing: 0.45,
  };
  return map[emotion] ?? 0.3;
}
