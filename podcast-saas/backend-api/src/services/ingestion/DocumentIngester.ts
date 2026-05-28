import { MarkItDownService } from './MarkItDownService.js';
import { logger } from '../../lib/logger.js';

// File extensions that MarkItDown handles well.
export const MARKITDOWN_EXTENSIONS = new Set([
  'docx', 'doc', 'pptx', 'ppt', 'xlsx', 'xls',
  'odt', 'ods', 'odp',
  'html', 'htm',
  'csv', 'tsv',
  'md', 'txt',
  'json', 'xml',
  'rtf',
]);

export class DocumentIngester {
  private markItDown = new MarkItDownService();

  async extract(buffer: Buffer, filename: string): Promise<string> {
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';

    // Primary: MarkItDown
    if (await this.markItDown.isAvailable()) {
      try {
        const md = await this.markItDown.convert(buffer, filename);
        logger.info({ filename, chars: md.length }, 'DocumentIngester: MarkItDown succeeded');
        return md;
      } catch (err) {
        logger.warn({ err, filename }, 'DocumentIngester: MarkItDown failed, trying fallback');
      }
    }

    // Fallback: raw text for plain-text formats
    if (['txt', 'md', 'csv', 'tsv', 'json', 'xml', 'html', 'htm'].includes(ext)) {
      const text = buffer.toString('utf8');
      logger.info({ filename, chars: text.length }, 'DocumentIngester: raw text fallback');
      return text;
    }

    throw new Error(
      `Cannot extract text from ${filename}: MarkItDown is not installed and no text fallback exists for .${ext}. ` +
      `Install with: pip install "markitdown[all]"`,
    );
  }
}
