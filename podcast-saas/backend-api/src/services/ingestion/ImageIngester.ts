import { GoogleGenAI } from '@google/genai';
import { logger } from '../../lib/logger.js';

export class ImageIngester {
  private client: GoogleGenAI | null = null;

  constructor() {
    const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    if (apiKey) this.client = new GoogleGenAI({ apiKey });
  }

  async caption(imageBuffer: Buffer, mimeType: string): Promise<string> {
    if (!this.client) throw new Error('GOOGLE_GENERATIVE_AI_API_KEY not configured');

    const base64 = imageBuffer.toString('base64');

    const response = await this.client.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          role: 'user',
          parts: [
            {
              inlineData: { data: base64, mimeType },
            },
            {
              text: 'Describe this image in detail. Focus on any text, data, charts, diagrams, or factual content visible. Output as a structured markdown description that would be useful for a podcast researcher.',
            },
          ],
        },
      ],
    });

    return response.text ?? '';
  }
}
