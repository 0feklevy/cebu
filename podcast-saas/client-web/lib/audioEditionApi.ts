/**
 * The `/{slug}/audio` mini-site's data source.
 *
 * Mirrors `libraryApi.ts` deliberately, including the part that looks like paranoia: the response
 * is parsed against a schema and a mismatch is logged LOUDLY rather than 404ing quietly. The
 * schemas themselves now live in `shared/src/audio/listener.ts` — one definition for the server's
 * replies and this parser, where before each side kept its own hand-written copy.
 */
import {
  AskQuestionResponseSchema,
  AudioEditionViewSchema,
  VoiceQuestionResponseSchema,
  type AskQuestionResponse,
  type AudioChapter,
  type AudioEditionView,
  type VoiceQuestionResponse,
  VoiceStreamEventSchema,
  type VoiceStreamEvent,
} from 'shared/src/audio/listener';

export {
  VoiceStreamEventSchema, type VoiceStreamEvent,
  AskQuestionResponseSchema, AudioEditionViewSchema, VoiceQuestionResponseSchema,
  type AskQuestionResponse, type AudioChapter, type AudioEditionView, type VoiceQuestionResponse,
};

const BACKEND =
  process.env.BACKEND_API_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:8080');

/** How long the container holds a rendered audio page before rebuilding it from the database. */
export const AUDIO_REVALIDATE_SECONDS = 60;
// Sixty seconds, matching the library. It also bounds how stale a SIGNED URL in the cached HTML
// can be, which is the real constraint here: the URL itself lives six hours, so a page cached for
// a minute can never hand out one that is close to expiring.

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

// ── Raise your hand (A2.4, client half) ───────────────────────────────────────────────────────

/**
 * Ask a question at a moment in the audio.
 *
 * The client always requests `intent: 'answer'` — the full experience — and the SERVER decides
 * what the budget allows: it downgrades to `saved` (with the reason) or refuses outright. Spend
 * control belongs to the side that knows the budget; a client-side default of 'save' would just
 * mean nobody ever gets an answer, silently, which is the worse failure.
 *
 * Failures return `refused` with a human sentence rather than throwing: on a locked phone in a
 * car there is nobody to read a stack trace, and the ONE thing this function must never do is
 * leave the asker without any response at all.
 */
export async function askQuestion(
  slug: string,
  input: { question: string; positionMs: number; language?: string | null },
): Promise<AskQuestionResponse> {
  try {
    const res = await fetch(`${BACKEND}/api/v1/public/audio/${encodeURIComponent(slug)}/questions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: input.question,
        position_ms: Math.max(0, Math.round(input.positionMs)),
        language: input.language ?? null,
        intent: 'answer',
      }),
    });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const message = (body as { message?: string } | null)?.message
        ?? (res.status === 429 ? 'Too many questions — please slow down.' : 'Could not send your question.');
      return { status: 'refused', answer: null, message };
    }
    const parsed = AskQuestionResponseSchema.safeParse(body);
    if (!parsed.success) return { status: 'refused', answer: null, message: 'Could not read the answer.' };
    return parsed.data;
  } catch {
    return { status: 'refused', answer: null, message: 'You appear to be offline — your question was not sent.' };
  }
}

// ── The spoken question (car mode) ────────────────────────────────────────────────────────────

const refusedVoice = (message: string): VoiceQuestionResponse => ({
  status: 'refused', question: null, answer: null, message, audio_base64: null, audio_mime: null,
});

/**
 * Ship one utterance — a 16 kHz mono WAV — and get the answer back, spoken (mp3, base64) and as
 * text. Same contract as `askQuestion`: this never throws, so the loop is never left waiting on
 * a listener who cannot look at the screen.
 */
export async function askVoiceQuestion(
  slug: string,
  input: { wav: Blob; positionMs: number; language?: string | null },
): Promise<VoiceQuestionResponse> {
  try {
    const form = new FormData();
    form.append('position_ms', String(Math.max(0, Math.round(input.positionMs))));
    form.append('language', input.language ?? '');
    form.append('audio', input.wav, 'question.wav');
    const res = await fetch(`${BACKEND}/api/v1/public/audio/${encodeURIComponent(slug)}/voice-question`, {
      method: 'POST',
      body: form,
    });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      return refusedVoice((body as { message?: string } | null)?.message
        ?? (res.status === 429 ? 'Too many questions — please slow down.' : 'Could not send your question.'));
    }
    const parsed = VoiceQuestionResponseSchema.safeParse(body);
    return parsed.success ? parsed.data : refusedVoice('Could not read the answer.');
  } catch {
    return refusedVoice('You appear to be offline — your question was not sent.');
  }
}

// ── The interactive answer (owner ruling 2026-09-03: Tap to ask like NotebookLM) ────────────

/**
 * Ask by voice and receive the answer as it is made: `heard`, then an `audio` chunk per
 * sentence while the model is still writing, then `done`. Events are handed over in order as
 * they arrive; the promise resolves when the stream closes. A transport failure is delivered as
 * an `error` event, never thrown — the listener is driving.
 */
export async function askVoiceQuestionStream(
  slug: string,
  input: { wav: Blob; positionMs: number; language?: string | null },
  onEvent: (event: VoiceStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const form = new FormData();
  form.append('position_ms', String(Math.max(0, Math.round(input.positionMs))));
  if (input.language) form.append('language', input.language);
  form.append('audio', input.wav, 'question.wav');
  let res: Response;
  try {
    res = await fetch(`${BACKEND}/api/v1/public/audio/${encodeURIComponent(slug)}/voice-question/stream`, { method: 'POST', body: form, signal });
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') return;
    onEvent({ type: 'error', message: 'You appear to be offline — your question was not sent.' });
    return;
  }
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => null) as { message?: string } | null;
    onEvent({ type: 'error', message: body?.message ?? (res.status === 429 ? 'Too many questions — please slow down.' : 'Could not send your question.') });
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        for (const event of parseSseFrame(frame)) onEvent(event);
      }
    }
  } catch (e) {
    if ((e as Error)?.name !== 'AbortError') onEvent({ type: 'error', message: 'The connection dropped mid-answer.' });
  }
}

/** One SSE frame → the validated events it carries (a comment or an unknown shape is nothing). */
export function parseSseFrame(frame: string): VoiceStreamEvent[] {
  const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
  if (!data) return [];
  try {
    const parsed = VoiceStreamEventSchema.safeParse(JSON.parse(data));
    return parsed.success ? [parsed.data] : [];
  } catch {
    return [];
  }
}
