/**
 * The `/{slug}/audio` mini-site's data source.
 *
 * Mirrors `libraryApi.ts` deliberately, including the part that looks like paranoia: the response
 * is parsed against a schema and a mismatch is logged LOUDLY rather than 404ing quietly. The two
 * halves of this contract are hand-maintained on both sides — nothing generates them — so drift
 * produces a page that renders "not found" for audio that exists, with nothing anywhere saying why.
 */
import { z } from 'zod';

const BACKEND =
  process.env.BACKEND_API_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:8080');

/** How long the container holds a rendered audio page before rebuilding it from the database. */
export const AUDIO_REVALIDATE_SECONDS = 60;
// Sixty seconds, matching the library. It also bounds how stale a SIGNED URL in the cached HTML
// can be, which is the real constraint here: the URL itself lives six hours, so a page cached for
// a minute can never hand out one that is close to expiring.

export const AudioChapterSchema = z.object({
  startMs: z.number(),
  endMs: z.number(),
  title: z.string(),
});

export const AudioEditionViewSchema = z.object({
  title: z.string().nullable(),
  description: z.string().nullable(),
  audio_url: z.string(),
  duration_ms: z.number().nullable(),
  chapters: z.array(AudioChapterSchema),
  captions_url: z.string().nullable(),
  language: z.string().nullable(),
  updated_at: z.union([z.string(), z.date()]).nullable(),
});

export type AudioEditionView = z.infer<typeof AudioEditionViewSchema>;
export type AudioChapter = z.infer<typeof AudioChapterSchema>;

export type PageResult<T> = { status: 'ok'; data: T } | { status: 'not_found' };

export async function getAudioEditionPage(
  slug: string,
  language?: string,
): Promise<PageResult<AudioEditionView>> {
  const query = language ? `?language=${encodeURIComponent(language)}` : '';
  try {
    const res = await fetch(
      `${BACKEND}/api/v1/public/audio/${encodeURIComponent(slug)}${query}`,
      {
        next: {
          revalidate: AUDIO_REVALIDATE_SECONDS,
          // Two tags, as the library does: one to purge every audio page at once, one to purge
          // exactly this project's. Rebuilding an edition must be able to invalidate the page
          // that holds its previous signed URL.
          tags: ['audio-edition', `audio-edition:${slug}`],
        },
      },
    );
    if (res.status !== 200) return { status: 'not_found' };

    const parsed = AudioEditionViewSchema.safeParse(await res.json().catch(() => null));
    if (parsed.success) return { status: 'ok', data: parsed.data };

    console.error(
      `[audioEditionApi] /public/audio/${slug} did not match its schema:`,
      parsed.error.issues.slice(0, 5),
    );
    return { status: 'not_found' };
  } catch (err) {
    console.error(`[audioEditionApi] /public/audio/${slug} fetch failed:`, err);
    return { status: 'not_found' };
  }
}

/** `1h 04m` / `4m 12s` / `31s` — a duration a listener reads before deciding to start. */
export function formatDuration(ms: number | null): string {
  if (!ms || ms <= 0) return '';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  // Hours drop the seconds: nobody choosing between two hour-long episodes cares about the 12.
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/** `04:12` — the running clock beside a scrubber, where alignment matters more than words. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Which chapter contains this moment.
 *
 * Returns an index, or -1 before the first chapter starts. Half-open intervals — `[start, end)` —
 * so a position exactly on a boundary belongs to the chapter it BEGINS, never the one it ends.
 * Getting that backwards makes "next chapter" land on the boundary and immediately report the
 * previous chapter as current, which on a lock screen looks like the skip button not working.
 */
export function chapterIndexAt(chapters: readonly AudioChapter[], positionMs: number): number {
  for (let i = 0; i < chapters.length; i++) {
    if (positionMs >= chapters[i].startMs && positionMs < chapters[i].endMs) return i;
  }
  // Past the end of the last chapter — which happens at exactly the final millisecond — belongs
  // to the last chapter rather than to nothing.
  if (chapters.length && positionMs >= chapters[chapters.length - 1].endMs) return chapters.length - 1;
  return -1;
}
