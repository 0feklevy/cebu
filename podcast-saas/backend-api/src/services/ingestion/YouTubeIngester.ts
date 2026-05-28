import { execFile } from 'child_process';
import { promisify } from 'util';
import { logger } from '../../lib/logger.js';

const execFileAsync = promisify(execFile);

export class YouTubeIngester {
  async extract(url: string): Promise<string> {
    const videoId = this.extractVideoId(url);
    if (!videoId) throw new Error(`Cannot extract video ID from URL: ${url}`);

    try {
      return await this.getTranscriptViaApi(videoId);
    } catch (err) {
      logger.warn({ err, videoId }, 'youtube-transcript-api failed, trying yt-dlp');
      return this.getTranscriptViaYtDlp(url);
    }
  }

  private extractVideoId(url: string): string | null {
    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    ];
    for (const p of patterns) {
      const m = url.match(p);
      if (m) return m[1];
    }
    return null;
  }

  private async getTranscriptViaApi(videoId: string): Promise<string> {
    // youtube-transcript-api is a Python package; call via npx or a bundled wrapper
    const { stdout } = await execFileAsync('python3', [
      '-c',
      `
import json, sys
from youtube_transcript_api import YouTubeTranscriptApi
try:
    transcript = YouTubeTranscriptApi.get_transcript('${videoId}')
    print(json.dumps(transcript))
except Exception as e:
    print(json.dumps({'error': str(e)}), file=sys.stderr)
    sys.exit(1)
      `.trim(),
    ]);
    const entries = JSON.parse(stdout) as Array<{ text: string; start: number }>;
    return entries.map((e) => e.text).join(' ');
  }

  private async getTranscriptViaYtDlp(url: string): Promise<string> {
    const { stdout } = await execFileAsync('yt-dlp', [
      '--write-auto-sub',
      '--sub-lang',
      'en',
      '--skip-download',
      '--print-json',
      '-o',
      '/tmp/%(id)s.%(ext)s',
      url,
    ]);
    const info = JSON.parse(stdout) as { title?: string; description?: string; subtitles?: unknown };
    // Best-effort: return title + description as corpus
    return `# ${info.title ?? 'Video'}\n\n${info.description ?? ''}`;
  }
}
