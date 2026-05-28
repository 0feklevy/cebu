import type { DialogueTurn, AlignedWord } from 'shared';
import type { TTSProvider, TTSTurnResult } from './TTSProvider.js';
import { formatTurnText, emotionToStyle } from './TTSProvider.js';
import { logger } from '../../lib/logger.js';

const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io/v1';

// ElevenLabs character-level alignment → AlignedWord[]
function charsToWords(
  characters: string[],
  startTimes: number[],
  endTimes: number[],
  turnIndex: number,
): AlignedWord[] {
  const words: AlignedWord[] = [];
  let wordStart = 0;
  let wordChars = '';

  for (let i = 0; i <= characters.length; i++) {
    const ch = characters[i];
    const isSpace = ch === ' ' || ch === undefined;

    if (isSpace) {
      if (wordChars.trim()) {
        words.push({
          word: wordChars.trim(),
          start_ms: Math.round(startTimes[wordStart] * 1000),
          end_ms: Math.round(endTimes[i - 1] * 1000),
          turn_index: turnIndex,
        });
      }
      wordChars = '';
      wordStart = i + 1;
    } else {
      if (!wordChars) wordStart = i;
      wordChars += ch;
    }
  }

  return words;
}

export class ElevenLabsTTSProvider implements TTSProvider {
  readonly providerName = 'elevenlabs' as const;

  constructor(
    private readonly apiKey: string,
    private readonly modelId: string = 'eleven_v3',
  ) {
    if (!apiKey) throw new Error('ElevenLabs API key is required');
  }

  async synthesizeTurn(
    turn: DialogueTurn,
    turnIndex: number,
    voiceId: string,
  ): Promise<TTSTurnResult> {
    const text = formatTurnText(turn);

    const resp = await fetch(
      `${ELEVENLABS_API_BASE}/text-to-speech/${voiceId}/with-timestamps`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': this.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text,
          model_id: this.modelId,
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            style: emotionToStyle(turn.emotion),
            use_speaker_boost: true,
          },
        }),
      },
    );

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`ElevenLabs TTS error ${resp.status}: ${body}`);
    }

    const data = (await resp.json()) as {
      audio_base64: string;
      alignment?: {
        characters: string[];
        character_start_times_seconds: number[];
        character_end_times_seconds: number[];
      };
    };

    const audioBuffer = Buffer.from(data.audio_base64, 'base64');

    // Derive duration from last character end time
    const al = data.alignment;
    let durationMs = 0;
    let alignedWords: AlignedWord[] = [];

    if (al && al.characters.length > 0) {
      const lastEnd = al.character_end_times_seconds[al.character_end_times_seconds.length - 1] ?? 0;
      durationMs = Math.round(lastEnd * 1000);
      alignedWords = charsToWords(
        al.characters,
        al.character_start_times_seconds,
        al.character_end_times_seconds,
        turnIndex,
      );
    } else {
      // Fallback: estimate from text length (rough 130 wpm)
      const wordCount = text.split(/\s+/).length;
      durationMs = Math.round((wordCount / 130) * 60 * 1000);
      logger.warn({ turnIndex }, 'ElevenLabs returned no alignment data — estimating duration');
    }

    // Rough cost: $0.30 / 1K characters → 0.03 cents/char
    const costCents = Math.round(text.length * 0.03);

    return { audioBuffer, audioFormat: 'mp3', durationMs, alignedWords, costCents };
  }
}
