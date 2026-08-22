import Groq from 'groq-sdk';
import { logger } from '../../lib/logger.js';
import { reportedDurationSec } from '../usage/sttCost.js';

/**
 * What one transcription produced, and how much audio the VENDOR says it processed.
 *
 * The duration rides back with the text because this class has no idea who is paying — it is
 * handed a buffer. Its caller knows the corpus, the project and the user, which is what a usage
 * row needs. Reporting rather than recording is the same split the dialogue client makes with
 * `attempts`, for the same reason.
 */
export interface TranscriptionResult {
  text: string;
  /** Seconds of audio, from the vendor's own `verbose_json`. Null when it reported none. */
  durationSec: number | null;
}

export class AudioIngester {
  private client: Groq | null = null;

  constructor() {
    const apiKey = process.env.GROQ_API_KEY;
    if (apiKey) this.client = new Groq({ apiKey });
  }

  async transcribe(audioBuffer: Buffer, filename: string): Promise<TranscriptionResult> {
    if (!this.client) throw new Error('GROQ_API_KEY not configured');

    const file = new File([audioBuffer], filename, { type: this.mimeType(filename) });

    logger.debug({ filename, size: audioBuffer.length }, 'Transcribing audio via Groq Whisper');

    const transcription = await this.client.audio.transcriptions.create({
      file,
      model: 'whisper-large-v3',
      response_format: 'verbose_json',
    });

    // `verbose_json` above is what makes this available — the length of audio the vendor actually
    // processed, which is the quantity it bills on. Null when absent, never zero: "unknown" and
    // "free" must not look the same to the caller deciding whether to record a charge.
    return { text: transcription.text, durationSec: reportedDurationSec(transcription) };
  }

  private mimeType(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase();
    const types: Record<string, string> = {
      mp3: 'audio/mpeg',
      mp4: 'audio/mp4',
      wav: 'audio/wav',
      m4a: 'audio/m4a',
      ogg: 'audio/ogg',
      webm: 'audio/webm',
    };
    return types[ext ?? ''] ?? 'audio/mpeg';
  }
}
