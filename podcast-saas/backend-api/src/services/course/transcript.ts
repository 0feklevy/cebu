/**
 * WebVTT helpers. The captions VTT lives at a public URL (set by buildPlayerConfig);
 * we fetch it server-side and reduce it to plain transcript text for SSR.
 */

/** Strip WebVTT structure → readable plain text. Pure; safe on empty input. */
export function vttToPlainText(vtt: string): string {
  if (!vtt) return '';
  const lines = vtt.replace(/\r/g, '').split('\n');
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line === 'WEBVTT' || line.startsWith('WEBVTT')) continue;
    if (line.startsWith('NOTE') || line.startsWith('STYLE') || line.startsWith('REGION')) continue;
    if (line.includes('-->')) continue;           // timing line
    if (/^\d+$/.test(line)) continue;             // cue index
    // Drop inline tags like <v Speaker> and <00:00:01.000>
    const text = line.replace(/<[^>]+>/g, '').trim();
    if (text) out.push(text);
  }
  // De-dupe consecutive identical lines (common in rolling captions).
  const deduped = out.filter((l, i) => l !== out[i - 1]);
  return deduped.join(' ').replace(/\s+/g, ' ').trim();
}

/** Best-effort fetch + parse of a transcript VTT. Never throws; returns null on failure. */
export async function fetchTranscript(url: string | null | undefined, timeoutMs = 4000): Promise<string | null> {
  if (!url) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    const text = vttToPlainText(await r.text());
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}
