import type { AlignedWord } from 'shared';
import type { TTSTurnResult } from './TTSProvider.js';
import { logger } from '../../lib/logger.js';

const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io/v1';

export interface MasterAlignment {
  words: AlignedWord[];
}

export class ForcedAlignmentService {
  constructor(private readonly elevenLabsApiKey?: string) {}

  // ElevenLabs path: words already have per-turn timestamps; apply master offsets.
  fromTTSResults(
    turns: TTSTurnResult[],
    turnOffsetMs: number[],
  ): MasterAlignment {
    const words: AlignedWord[] = [];

    for (let i = 0; i < turns.length; i++) {
      const offset = turnOffsetMs[i] ?? 0;
      for (const w of turns[i].alignedWords) {
        words.push({
          ...w,
          start_ms: w.start_ms + offset,
          end_ms: w.end_ms + offset,
          turn_index: i,
        });
      }
    }

    return { words };
  }

  // Gemini path: no per-turn timestamps → call ElevenLabs forced alignment on master audio
  async fromMasterAudio(
    masterBuffer: Buffer,
    fullTranscript: string,
  ): Promise<MasterAlignment> {
    if (!this.elevenLabsApiKey) {
      logger.warn('No ElevenLabs key for forced alignment — returning empty alignment');
      return { words: [] };
    }

    const formData = new FormData();
    formData.append('audio', new Blob([masterBuffer], { type: 'audio/wav' }), 'master.wav');
    formData.append('text', fullTranscript);

    const resp = await fetch(`${ELEVENLABS_API_BASE}/audio-text-alignment`, {
      method: 'POST',
      headers: { 'xi-api-key': this.elevenLabsApiKey },
      body: formData,
    });

    if (!resp.ok) {
      const body = await resp.text();
      logger.error({ status: resp.status, body }, 'ElevenLabs forced alignment failed');
      return { words: [] };
    }

    const data = (await resp.json()) as {
      alignment?: {
        characters: string[];
        character_start_times_seconds: number[];
        character_end_times_seconds: number[];
      };
    };

    const al = data.alignment;
    if (!al) return { words: [] };

    // Convert character-level to word-level, turn_index = -1 (unknown for Gemini path)
    const words: AlignedWord[] = [];
    let wordStart = 0;
    let wordChars = '';

    for (let i = 0; i <= al.characters.length; i++) {
      const ch = al.characters[i];
      const isEnd = ch === ' ' || ch === undefined;

      if (isEnd) {
        if (wordChars.trim()) {
          words.push({
            word: wordChars.trim(),
            start_ms: Math.round(al.character_start_times_seconds[wordStart] * 1000),
            end_ms: Math.round(al.character_end_times_seconds[i - 1] * 1000),
            turn_index: -1,
          });
        }
        wordChars = '';
        wordStart = i + 1;
      } else {
        if (!wordChars) wordStart = i;
        wordChars += ch;
      }
    }

    return { words };
  }
}
