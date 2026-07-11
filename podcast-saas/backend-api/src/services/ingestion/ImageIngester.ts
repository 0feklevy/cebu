import { getGeminiClient, recordChatUsage } from '../llm/systemAi.js';

const CAPTION_MODEL = 'gemini-2.5-flash';

export class ImageIngester {
  async caption(imageBuffer: Buffer, mimeType: string): Promise<string> {
    const client = await getGeminiClient();
    if (!client) throw new Error('Google AI API key is not configured');

    const base64 = imageBuffer.toString('base64');

    const response = await client.models.generateContent({
      model: CAPTION_MODEL,
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

    const meta = response.usageMetadata;
    await recordChatUsage({
      userId: null,
      projectId: null,
      provider: 'gemini',
      model: CAPTION_MODEL,
      task: 'image_caption',
      usage: { prompt_tokens: meta?.promptTokenCount ?? 0, completion_tokens: meta?.candidatesTokenCount ?? 0 },
    });

    return response.text ?? '';
  }
}
