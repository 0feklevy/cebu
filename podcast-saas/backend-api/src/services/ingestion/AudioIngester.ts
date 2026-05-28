import Groq from 'groq-sdk';
import { logger } from '../../lib/logger.js';

export class AudioIngester {
  private client: Groq | null = null;

  constructor() {
    const apiKey = process.env.GROQ_API_KEY;
    if (apiKey) this.client = new Groq({ apiKey });
  }

  async transcribe(audioBuffer: Buffer, filename: string): Promise<string> {
    if (!this.client) throw new Error('GROQ_API_KEY not configured');

    const file = new File([audioBuffer], filename, { type: this.mimeType(filename) });

    logger.debug({ filename, size: audioBuffer.length }, 'Transcribing audio via Groq Whisper');

    const transcription = await this.client.audio.transcriptions.create({
      file,
      model: 'whisper-large-v3',
      response_format: 'verbose_json',
    });

    return transcription.text;
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
