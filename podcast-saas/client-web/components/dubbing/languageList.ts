/**
 * The language list's arithmetic: rolling per-video dubs up to one row per language, and deciding
 * what the creator sees and in what order.
 *
 * SEPARATE FROM THE COMPONENT ON PURPOSE. These functions decide whether a language is reachable
 * at all in a list of ninety-four, and whether a progress bar tells the truth — both are rules, and
 * a rule tested through a rendered component is tested through everything the component also does.
 * This repository has already paid for that lesson once: four viewer regressions shipped past a
 * test that read source text instead of behaviour. A pure module can be mutation-checked; a JSX
 * tree cannot.
 */
import type { DubbingLanguageOption, ProjectDub } from 'shared/src/generated/client-v1';

/** How the panel may be ordered. `popular` is the default; the others are one click away. */
export type DubSortKey = 'popular' | 'name' | 'active';

/** One language's rolled-up state across every video in the project. */
export interface LanguageRow {
  code: string;
  name: string;
  endonym: string;
  /** queued | processing | completed | failed | partial, or null when never requested. */
  status: string | null;
  /** Every video in this language is finished AND servable. */
  ready: boolean;
  /** The language the video is ALREADY in — shown, explained, and never selectable. */
  isSource: boolean;
  /** 0–100 across every video in the project. */
  percent: number;
  /** What is happening right now, in words. Null when nothing has been requested. */
  stageLabel: string | null;
  /** Default sort position, from the server. */
  rank: number;
  total: number;
  done: number;
  error: string | null;
}

/**
 * The mean percentage across a project's videos.
 *
 * The mean and not the minimum: a four-video project whose first dub is finished and whose second
 * is halfway is genuinely 37% done, and reporting the slowest video's 50% would make FINISHING a
 * video move the bar backwards.
 */
function meanPercent(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

/**
 * Roll a project's per-video dub rows up to one row per language.
 *
 * Exported and pure so the rollup can be tested without rendering: "is Hebrew ready?" is a
 * question about every video at once, and answering it per video is what would let a half-dubbed
 * language look finished.
 */
export function rollUpByLanguage(
  dubs: ProjectDub[],
  supported: DubbingLanguageOption[],
  videoCount: number,
): LanguageRow[] {
  return supported.map((lang, index) => {
    const rows = dubs.filter((d) => d.language === lang.code);
    const done = rows.filter((d) => d.servable).length;
    const failed = rows.find((d) => d.status === 'failed');
    const total = Math.max(videoCount, rows.length);

    // Null means "never requested", which is what makes the checkbox selectable. Every other
    // branch is a real state, so the ladder assigns exactly once rather than initialising to a
    // value it always overwrites.
    let status: string | null;
    if (rows.length === 0) status = null;
    else if (failed) status = 'failed';
    else if (done === total && total > 0) status = 'completed';
    else if (rows.some((d) => d.status === 'processing')) status = 'processing';
    else if (done > 0) status = 'partial';
    else status = 'queued';

    // A video with no row yet has not started, and counts as zero — otherwise a three-video
    // project whose first dub is queued would average one row and read as further along than a
    // project where all three are queued.
    const percents = rows.map((d) => d.progress?.percent ?? (d.servable ? 100 : 0));
    while (percents.length < total) percents.push(0);

    // The LEAST advanced video is the one still holding the project up, so its label is the
    // truthful answer to "what is happening right now" — the finished ones are not doing anything.
    const slowest = rows
      .filter((d) => d.progress?.active)
      .sort((a, b) => (a.progress!.percent) - (b.progress!.percent))[0];

    return {
      code: lang.code,
      name: lang.name,
      endonym: lang.endonym,
      isSource: lang.is_source === true,
      // An older backend sends no rank. Falling back to list position keeps the order stable and
      // alphabetical rather than collapsing every language into one tie.
      rank: lang.rank ?? index,
      status,
      ready: total > 0 && done === total,
      percent: status === null ? 0 : meanPercent(percents),
      stageLabel: slowest?.progress?.label
        ?? (status === 'completed' ? 'Ready' : status === 'failed' ? null : rows[0]?.progress?.label ?? null),
      total,
      done,
      error: failed?.error ?? null,
    };
  });
}

/** Fold accents away so `espanol` finds `Español` and `francais` finds `Français`. */
function fold(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Filter and order the language list.
 *
 * Pure, exported and tested, because this is the function that decides whether the feature is
 * usable at all: get it wrong and a creator's language is present but unreachable.
 *
 * TWO ORDERINGS, and which one applies depends on whether the creator is searching.
 *
 *   • NOT SEARCHING — the source language is pinned first, then the chosen sort. The source row is
 *     the one whose position carries meaning: it explains why the language somebody came looking
 *     for is greyed out, and burying it under a sort recreates the confusion it exists to prevent.
 *
 *   • SEARCHING — relevance wins, and the pin is dropped. Someone who typed a query has said what
 *     they want to see, and answering with a different language at the top is not helpfulness.
 *     Matches are graded rather than merely filtered: substring matching alone answers "fr" with
 *     Afrikaans, which contains those letters and is not what anyone meant. An exact code, then a
 *     name that STARTS with the query, then a code that does, then a match anywhere.
 */
export function orderLanguages(
  rows: readonly LanguageRow[],
  query: string,
  sort: DubSortKey,
): LanguageRow[] {
  const needle = fold(query.trim());
  const searching = needle !== '';

  /** Lower is a better match; Infinity means it does not match at all. */
  const relevance = (r: LanguageRow): number => {
    if (!searching) return 0;
    const code = r.code.toLowerCase();
    const name = fold(r.name);
    const endonym = fold(r.endonym);
    if (code === needle) return 0;
    if (name.startsWith(needle) || endonym.startsWith(needle)) return 1;
    if (code.startsWith(needle)) return 2;
    if (name.includes(needle) || endonym.includes(needle)) return 3;
    return Infinity;
  };

  const scored = rows
    .map((r) => ({ row: r, score: relevance(r) }))
    .filter((s) => s.score !== Infinity);

  // Lower sorts first.
  const activity = (r: LanguageRow): number => {
    if (r.status === 'processing' || r.status === 'queued' || r.status === 'partial') return 0;
    if (r.status === 'failed') return 1;
    if (r.status === 'completed') return 2;
    return 3;
  };

  scored.sort((a, b) => {
    if (searching) {
      if (a.score !== b.score) return a.score - b.score;
    } else if (a.row.isSource !== b.row.isSource) {
      return a.row.isSource ? -1 : 1;
    }
    if (sort === 'name') return a.row.name.localeCompare(b.row.name);
    if (sort === 'active') {
      const byActivity = activity(a.row) - activity(b.row);
      if (byActivity !== 0) return byActivity;
    }
    return a.row.rank - b.row.rank;
  });

  return scored.map((s) => s.row);
}
