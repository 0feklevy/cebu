import { MarkItDownService } from './MarkItDownService.js';
import { logger } from '../../lib/logger.js';

export class PDFIngester {
  private markItDown = new MarkItDownService();

  async extract(fileBuffer: Buffer, filename: string): Promise<string> {
    // Primary: MarkItDown (handles PDF natively with pdfminer)
    if (await this.markItDown.isAvailable()) {
      try {
        const md = await this.markItDown.convert(fileBuffer, filename);
        logger.info({ filename, chars: md.length }, 'PDFIngester: MarkItDown succeeded');
        return md;
      } catch (err) {
        logger.warn({ err, filename }, 'PDFIngester: MarkItDown failed, trying Docling');
      }
    }

    // Secondary: Docling via subprocess / API
    try {
      return await this.extractWithDocling(fileBuffer, filename);
    } catch (err) {
      logger.warn({ err, filename }, 'Docling failed, falling back to LlamaParse');
      return this.extractWithLlamaParse(fileBuffer, filename);
    }
  }

  private async extractWithDocling(fileBuffer: Buffer, filename: string): Promise<string> {
    // Docling is typically run as a local service or subprocess.
    // For now we call the Docling HTTP API if DOCLING_URL is set.
    const doclingUrl = process.env.DOCLING_URL;
    if (!doclingUrl) throw new Error('DOCLING_URL not configured');

    const form = new FormData();
    form.append('file', new Blob([fileBuffer], { type: 'application/pdf' }), filename);

    const res = await fetch(`${doclingUrl}/convert`, {
      method: 'POST',
      body: form,
    });
    if (!res.ok) throw new Error(`Docling returned ${res.status}`);
    const json = (await res.json()) as { markdown?: string; text?: string };
    return json.markdown ?? json.text ?? '';
  }

  private async extractWithLlamaParse(fileBuffer: Buffer, filename: string): Promise<string> {
    const apiKey = process.env.LLAMAPARSE_API_KEY;
    if (!apiKey) throw new Error('LLAMAPARSE_API_KEY not configured');

    // LlamaParse upload + poll pattern
    const form = new FormData();
    form.append('file', new Blob([fileBuffer], { type: 'application/pdf' }), filename);

    const uploadRes = await fetch('https://api.cloud.llamaindex.ai/api/parsing/upload', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    if (!uploadRes.ok) throw new Error(`LlamaParse upload failed: ${uploadRes.status}`);
    const { id } = (await uploadRes.json()) as { id: string };

    // Poll for completion
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const statusRes = await fetch(
        `https://api.cloud.llamaindex.ai/api/parsing/job/${id}`,
        { headers: { Authorization: `Bearer ${apiKey}` } },
      );
      const status = (await statusRes.json()) as { status: string };
      if (status.status === 'SUCCESS') {
        const mdRes = await fetch(
          `https://api.cloud.llamaindex.ai/api/parsing/job/${id}/result/markdown`,
          { headers: { Authorization: `Bearer ${apiKey}` } },
        );
        const md = (await mdRes.json()) as { markdown: string };
        return md.markdown;
      }
      if (status.status === 'ERROR') throw new Error('LlamaParse job failed');
    }
    throw new Error('LlamaParse timed out');
  }
}
