/**
 * JsonLdService — pure builders for schema.org JSON-LD. Real data only: a field
 * is omitted when its source value is absent. Nothing is fabricated (no ratings,
 * reviews, fake durations/dates/chapters). Serialization-time escaping (so stored
 * text cannot break the <script> element) is the renderer's job — see the route's
 * serializeJsonLd helper.
 */
import { brandName } from './SeoResolver.js';
import { platformBaseUrl } from './CanonicalUrlService.js';

export type JsonLd = Record<string, unknown>;

/** Seconds → ISO-8601 duration (e.g. 3725 → "PT1H2M5S"). Null when unknown. */
export function secondsToISO8601(sec: number | null | undefined): string | null {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return null;
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return `PT${h ? `${h}H` : ''}${m ? `${m}M` : ''}${r || (!h && !m) ? `${r}S` : ''}`;
}

export function organization(): JsonLd {
  return { '@type': 'Organization', name: brandName(), url: platformBaseUrl() };
}

export function breadcrumbList(items: Array<{ name: string; url: string }>): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: it.name,
      item: it.url,
    })),
  };
}

export interface CourseLdInput {
  name: string;
  description: string;
  url: string;
  inLanguage: string;
  lessons: Array<{ title: string; url: string }>;
}

export function course(input: CourseLdInput): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'Course',
    name: input.name,
    description: input.description,
    url: input.url,
    inLanguage: input.inLanguage,
    provider: organization(),
  };
}

export function itemList(items: Array<{ title: string; url: string }>): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    itemListElement: items.map((it, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: it.title,
      url: it.url,
    })),
  };
}

export interface VideoLdInput {
  name: string;
  description: string;
  url: string;
  thumbnailUrl: string | null;
  uploadDate: string | null;     // ISO
  durationSec: number | null;
  contentUrl: string | null;     // HLS/player content location
  inLanguage: string;
}

/** Returns null when there is no real video to describe. */
export function videoObject(input: VideoLdInput): JsonLd | null {
  if (!input.contentUrl && !input.thumbnailUrl) return null;
  const ld: JsonLd = {
    '@context': 'https://schema.org',
    '@type': 'VideoObject',
    name: input.name,
    description: input.description,
    url: input.url,
    inLanguage: input.inLanguage,
  };
  if (input.thumbnailUrl) ld.thumbnailUrl = input.thumbnailUrl;
  if (input.uploadDate) ld.uploadDate = input.uploadDate;
  const dur = secondsToISO8601(input.durationSec);
  if (dur) ld.duration = dur;
  if (input.contentUrl) ld.contentUrl = input.contentUrl;
  return ld;
}

/** Clip entries — only when real chapter timestamps exist. */
export function clips(
  lessonUrl: string,
  chapters: Array<{ label: string; startSec: number; endSec: number }>,
): JsonLd[] {
  return chapters
    .filter((c) => Number.isFinite(c.startSec) && c.startSec >= 0 && c.label?.trim())
    .map((c) => ({
      '@context': 'https://schema.org',
      '@type': 'Clip',
      name: c.label,
      startOffset: Math.round(c.startSec),
      ...(Number.isFinite(c.endSec) && c.endSec > c.startSec ? { endOffset: Math.round(c.endSec) } : {}),
      url: `${lessonUrl}#t=${Math.round(c.startSec)}`,
    }));
}
