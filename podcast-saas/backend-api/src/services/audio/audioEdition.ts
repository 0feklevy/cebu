/**
 * The rules an audio edition is built from — pure, so they can be argued with.
 *
 * P3-B / A2.1. An edition is DERIVED from a project that already exists: its narration, its
 * guidance audio, its sections, its captions. Everything in this file is a decision about how
 * those become one listenable thing, separated from the ffmpeg call that does the work because
 * the decisions are where the mistakes live and the ffmpeg call is where they are invisible.
 *
 * The listener this is for has a dark screen. That governs more than it looks: a chapter with no
 * label is useless on a lock screen, a gap between segments sounds like the episode ended, and a
 * caption cue that still carries its per-segment timing points at nothing once the segments are
 * one file.
 */
import { createHash } from 'node:crypto';

/** A project segment as the edition builder needs it — the subset `buildPlayerConfig` resolves. */
export interface EditionSegment {
  /** Storage key of the audio to take from this segment. */
  audioKey: string;
  /** Duration in milliseconds. Segments with no measurable duration are not editions material. */
  durationMs: number;
  /** WebVTT for this segment, in ITS OWN timebase (starting at 0). */
  captionsVtt?: string | null;
}

/** A section of the project's timeline, as stored. */
export interface EditionSection {
  startSec: number;
  endSec: number;
  label?: string | null;
  type?: string | null;
  sortOrder?: number | null;
}

/** A chapter mark, in the edition's timebase. */
export interface EditionChapter {
  startMs: number;
  endMs: number;
  title: string;
}

/**
 * Chapter marks for the lock screen.
 *
 * Sections are the project's own structure and are the right source, but three things about them
 * make a direct copy wrong:
 *
 *  - **Unlabelled sections exist.** The editor does not require a label, and `Section 4` on a lock
 *    screen is worse than no chapter at all — it takes a slot in the skip order and tells the
 *    listener nothing. Unlabelled sections are FOLDED INTO the previous chapter rather than
 *    dropped, so skipping never lands in silence the chapter list did not mention.
 *  - **Sections can overlap or leave gaps**, because nothing in the editor forbids it. Chapters
 *    that overlap make `nexttrack` ambiguous, so each chapter ends where the next begins.
 *  - **Sections are stored in seconds, floats.** Media Session wants milliseconds, and rounding
 *    at read time twice gives two different answers.
 */
export function deriveChapters(sections: readonly EditionSection[], totalDurationMs: number): EditionChapter[] {
  if (totalDurationMs <= 0) return [];

  const ordered = [...sections]
    .filter((s) => Number.isFinite(s.startSec) && s.startSec >= 0)
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.startSec - b.startSec);

  const marks: EditionChapter[] = [];
  for (const s of ordered) {
    const title = (s.label ?? '').trim();
    const startMs = Math.round(s.startSec * 1000);
    if (startMs >= totalDurationMs) continue;   // a section past the end of the audio labels nothing
    if (!title) continue;                        // folded into whatever chapter is already open
    // A second section starting at the same millisecond as the previous one would create a
    // zero-length chapter, which a lock screen renders as an unreachable skip target.
    if (marks.length && startMs <= marks[marks.length - 1].startMs) continue;
    marks.push({ startMs, endMs: totalDurationMs, title });
  }

  if (marks.length === 0) return [];

  // The first chapter always starts at 0. A listener who presses "previous chapter" during the
  // opening must land at the beginning, not at whatever the first LABELLED section happened to be.
  if (marks[0].startMs !== 0) marks[0] = { ...marks[0], startMs: 0 };

  for (let i = 0; i < marks.length - 1; i++) marks[i].endMs = marks[i + 1].startMs;
  return marks;
}

/**
 * Re-time a segment's captions into the edition's single timeline.
 *
 * Each segment's VTT starts at zero because each segment is its own file. Concatenated, every cue
 * after the first segment points at the wrong moment — and increasingly wrong as the episode goes
 * on, which is the kind of bug that looks fine in the first thirty seconds of testing.
 */
export function shiftVtt(vtt: string, offsetMs: number): string {
  if (!vtt.trim()) return '';
  return vtt.replace(
    /(\d{1,3}):([0-5]\d):([0-5]\d)[.,](\d{1,3})/g,
    (_m, h: string, min: string, sec: string, ms: string) => {
      const t = Number(h) * 3_600_000 + Number(min) * 60_000 + Number(sec) * 1000 + Number(ms.padEnd(3, '0'));
      return formatVttTime(t + offsetMs);
    },
  );
}

function formatVttTime(totalMs: number): string {
  const ms = Math.max(0, Math.round(totalMs));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const rem = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(rem).padStart(3, '0')}`;
}

/**
 * One VTT for the whole edition, from the per-segment ones.
 *
 * A segment with no captions contributes nothing but still advances the offset — otherwise every
 * later cue drifts by that segment's length, and the captions would be perfectly correct up to the
 * first silent segment and wrong for the rest of the episode.
 */
export function concatCaptions(segments: readonly EditionSegment[]): string {
  const bodies: string[] = [];
  let offsetMs = 0;
  for (const seg of segments) {
    const vtt = (seg.captionsVtt ?? '').trim();
    if (vtt) {
      // Drop each segment's own WEBVTT header and any leading blank lines; the edition emits one.
      const body = vtt.replace(/^WEBVTT[^\n]*\n+/i, '').trim();
      if (body) bodies.push(shiftVtt(body, offsetMs));
    }
    offsetMs += seg.durationMs;
  }
  return bodies.length ? `WEBVTT\n\n${bodies.join('\n\n')}\n` : '';
}

/**
 * The identity of an edition's INPUTS.
 *
 * The same discipline captions and crop already use, and for the same reason: without it,
 * "regenerate" is either always-work or never-work and both are wrong. Re-running with an
 * unchanged hash must cost nothing; editing a section title must produce a new edition.
 *
 * What goes in is everything that can change the OUTPUT — the segment keys and their order, each
 * duration, the section boundaries and labels, the caption text, and the language. What stays out
 * is everything that cannot: row ids, timestamps, view counts. A hash over the whole project row
 * would change every time anything at all was touched, and an artifact that rebuilds on every
 * unrelated edit is one nobody leaves enabled.
 */
export function editionSourceHash(input: {
  language: string | null;
  segments: readonly EditionSegment[];
  sections: readonly EditionSection[];
}): string {
  const canonical = JSON.stringify({
    // Explicitly, not the object itself: a field added to EditionSegment later must be a
    // deliberate decision about whether it changes the artifact, not an accident of spreading.
    l: input.language ?? '',
    g: input.segments.map((s) => [s.audioKey, Math.round(s.durationMs), (s.captionsVtt ?? '').trim()]),
    s: [...input.sections]
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.startSec - b.startSec)
      .map((x) => [Math.round(x.startSec * 1000), Math.round(x.endSec * 1000), (x.label ?? '').trim()]),
  });
  return sha256Hex(canonical);
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Total playable length of the edition. */
export function totalDurationMs(segments: readonly EditionSegment[]): number {
  return segments.reduce((sum, s) => sum + Math.max(0, Math.round(s.durationMs)), 0);
}

/**
 * Is this project derivable into an edition at all?
 *
 * Returns the reason it is not, or null when it is. A REASON rather than a boolean because this
 * answer reaches the creator: "no audio to derive from" is actionable and "cannot build edition"
 * is not, and the difference is what decides whether they file a support message.
 */
export function editionRefusalReason(segments: readonly EditionSegment[]): string | null {
  if (segments.length === 0) return 'This project has no media to derive audio from.';
  const withAudio = segments.filter((s) => s.audioKey && s.durationMs > 0);
  if (withAudio.length === 0) return 'None of this project’s segments have playable audio yet.';
  if (withAudio.length < segments.length) {
    // Deliberately NOT a refusal. A project part-way through transcoding would otherwise be
    // permanently un-derivable, and the edition can be rebuilt for free once the rest lands.
    return null;
  }
  return null;
}
