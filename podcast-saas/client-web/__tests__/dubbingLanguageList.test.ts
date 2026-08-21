import { describe, it, expect } from 'vitest';
import { rollUpByLanguage, orderLanguages, type LanguageRow } from '../components/dubbing/languageList';
import type { DubbingLanguageOption, ProjectDub } from 'shared/src/generated/client-v1';

const lang = (code: string, name: string, endonym: string, rank: number, is_source = false): DubbingLanguageOption =>
  ({ code, name, endonym, rank, rtl: false, is_source });

const SUPPORTED: DubbingLanguageOption[] = [
  lang('en', 'English', 'English', 0),
  lang('es', 'Spanish', 'Español', 1),
  lang('fr', 'French', 'Français', 4),
  lang('he', 'Hebrew', 'עברית', 18),
  lang('af', 'Afrikaans', 'Afrikaans', 40),
];

const dub = (over: Partial<ProjectDub>): ProjectDub => ({
  id: over.id ?? 'd1',
  video_file_id: over.video_file_id ?? 'v1',
  language: over.language ?? 'es',
  language_name: 'Spanish',
  language_endonym: 'Español',
  rtl: false,
  provider: 'elevenlabs',
  status: over.status ?? 'processing',
  servable: over.servable ?? false,
  hls_url: null,
  captions_url: null,
  cost_cents: null,
  error: over.error ?? null,
  progress: over.progress,
  updated_at: null,
});

describe('rollUpByLanguage — the progress a creator actually sees', () => {
  it('reports the server stage percentage instead of a videos-finished count', () => {
    // THE DEFECT: one video, mid-run. The old bar read `0/1` for the entire dub.
    const rows = rollUpByLanguage(
      [dub({ language: 'es', status: 'processing', progress: { stage: 'translating', label: 'Translating and matching the voices', percent: 52, active: true } })],
      SUPPORTED,
      1,
    );
    const es = rows.find((r) => r.code === 'es')!;
    expect(es.percent).toBe(52);
    expect(es.stageLabel).toBe('Translating and matching the voices');
    expect(es.status).toBe('processing');
  });

  it('averages across videos, and counts a video with no row yet as zero', () => {
    const rows = rollUpByLanguage(
      [dub({ id: 'a', video_file_id: 'v1', language: 'es', servable: true, status: 'completed', progress: { stage: 'completed', label: 'Ready', percent: 100, active: false } })],
      SUPPORTED,
      2, // two videos in the project, only one dub row so far
    );
    const es = rows.find((r) => r.code === 'es')!;
    expect(es.percent).toBe(50);
    expect(es.ready).toBe(false);
  });

  it('speaks for the least advanced video, because that is the one still holding things up', () => {
    const rows = rollUpByLanguage(
      [
        dub({ id: 'a', video_file_id: 'v1', language: 'es', progress: { stage: 'packaging', label: 'Packaging it for streaming', percent: 95, active: true } }),
        dub({ id: 'b', video_file_id: 'v2', language: 'es', progress: { stage: 'transcribing', label: 'Transcribing the original speech', percent: 14, active: true } }),
      ],
      SUPPORTED,
      2,
    );
    const es = rows.find((r) => r.code === 'es')!;
    expect(es.stageLabel).toBe('Transcribing the original speech');
    expect(es.percent).toBe(55);
  });

  it('falls back to a coarse reading when the backend sends no progress at all', () => {
    const rows = rollUpByLanguage(
      [dub({ language: 'es', status: 'completed', servable: true, progress: undefined })],
      SUPPORTED,
      1,
    );
    expect(rows.find((r) => r.code === 'es')!.percent).toBe(100);
  });

  it('leaves an unrequested language at zero rather than inventing a stage for it', () => {
    const rows = rollUpByLanguage([], SUPPORTED, 1);
    expect(rows.every((r) => r.percent === 0 && r.status === null && r.stageLabel === null)).toBe(true);
  });

  it('carries the source flag and the server rank through', () => {
    const supported = SUPPORTED.map((l) => (l.code === 'en' ? { ...l, is_source: true } : l));
    const rows = rollUpByLanguage([], supported, 1);
    expect(rows.find((r) => r.code === 'en')!.isSource).toBe(true);
    expect(rows.find((r) => r.code === 'af')!.rank).toBe(40);
  });
});

const rows = (): LanguageRow[] => rollUpByLanguage([], SUPPORTED.map(
  (l) => (l.code === 'he' ? { ...l, is_source: true } : l),
), 1);

describe('orderLanguages — finding one language among ninety-four', () => {
  it('sorts by the server rank by default, not alphabetically by English name', () => {
    const ordered = orderLanguages(rows(), '', 'popular').map((r) => r.code);
    // Afrikaans is alphabetically first and demonstrably not what anyone wants first.
    expect(ordered.indexOf('es')).toBeLessThan(ordered.indexOf('af'));
  });

  it('pins the source language first in every sort mode', () => {
    for (const sort of ['popular', 'name', 'active'] as const) {
      expect(orderLanguages(rows(), '', sort)[0]!.code).toBe('he');
    }
  });

  it('sorts A–Z when asked, with the source still pinned', () => {
    const ordered = orderLanguages(rows(), '', 'name').map((r) => r.code);
    expect(ordered[0]).toBe('he');
    expect(ordered.slice(1)).toEqual(['af', 'en', 'fr', 'es']);
  });

  it('matches the English name, the endonym and the code', () => {
    const find = (q: string) => orderLanguages(rows(), q, 'popular').map((r) => r.code);
    expect(find('span')).toEqual(['es']);
    expect(find('Español')).toEqual(['es']);
    // "Afrikaans" also contains "fr" — it may appear, but never above the language actually asked for.
    expect(find('fr')[0]).toBe('fr');
    expect(find('עברית')).toEqual(['he']);
  });

  it('ignores accents and case, so a plain keyboard finds an accented name', () => {
    expect(orderLanguages(rows(), 'espanol', 'popular').map((r) => r.code)).toEqual(['es']);
    expect(orderLanguages(rows(), 'FRANCAIS', 'popular').map((r) => r.code)).toEqual(['fr']);
  });

  it('returns nothing rather than everything when the search matches nothing', () => {
    expect(orderLanguages(rows(), 'klingon', 'popular')).toEqual([]);
  });

  it('does not mutate the array it was given', () => {
    const original = rows();
    const codes = original.map((r) => r.code);
    orderLanguages(original, '', 'name');
    expect(original.map((r) => r.code)).toEqual(codes);
  });

  it('puts in-flight languages first in the active sort, finished ones after', () => {
    const withWork = rollUpByLanguage(
      [
        dub({ id: 'a', language: 'af', status: 'processing', progress: { stage: 'mixing', label: 'Mixing', percent: 88, active: true } }),
        dub({ id: 'b', language: 'fr', status: 'completed', servable: true, progress: { stage: 'completed', label: 'Ready', percent: 100, active: false } }),
      ],
      SUPPORTED,
      1,
    );
    const ordered = orderLanguages(withWork, '', 'active').map((r) => r.code);
    expect(ordered[0]).toBe('af');
    expect(ordered.indexOf('fr')).toBeLessThan(ordered.indexOf('en'));
  });
});
