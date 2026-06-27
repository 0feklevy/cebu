import { logger } from '../../lib/logger.js';
import { assertPublicHost } from '../security/assertPublicHost.js';

export class WebIngester {
  async extract(url: string): Promise<string> {
    // SSRF guard: reject internal/loopback/metadata hosts before fetching or
    // forwarding the URL to firecrawl/reader.
    await assertPublicHost(url);
    try {
      return await this.extractWithFirecrawl(url);
    } catch (err) {
      logger.warn({ err, url }, 'Firecrawl failed, falling back to Reader API');
      return this.extractWithReader(url);
    }
  }

  private async extractWithFirecrawl(url: string): Promise<string> {
    const apiKey = process.env.FIRECRAWL_API_KEY;
    if (!apiKey) throw new Error('FIRECRAWL_API_KEY not configured');

    const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true }),
    });
    if (!res.ok) throw new Error(`Firecrawl ${res.status}`);
    const json = (await res.json()) as { data?: { markdown?: string } };
    return json.data?.markdown ?? '';
  }

  private async extractWithReader(url: string): Promise<string> {
    const res = await fetch(`https://r.jina.ai/${encodeURIComponent(url)}`, {
      headers: { Accept: 'text/plain', 'X-Return-Format': 'markdown' },
    });
    if (!res.ok) throw new Error(`Reader API ${res.status}`);
    return res.text();
  }
}
