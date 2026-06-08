import { describe, it, expect } from 'vitest';
import * as Ld from '../JsonLdService.js';

describe('JsonLdService', () => {
  it('secondsToISO8601 formats real durations and rejects junk', () => {
    expect(Ld.secondsToISO8601(3725)).toBe('PT1H2M5S');
    expect(Ld.secondsToISO8601(45)).toBe('PT45S');
    expect(Ld.secondsToISO8601(0)).toBeNull();
    expect(Ld.secondsToISO8601(null)).toBeNull();
  });

  it('builds a Course with provider organization', () => {
    const c = Ld.course({ name: 'C', description: 'D', url: 'https://x/c/c', inLanguage: 'en', lessons: [] });
    expect(c['@type']).toBe('Course');
    expect((c.provider as Record<string, unknown>)['@type']).toBe('Organization');
  });

  it('builds an ordered ItemList', () => {
    const list = Ld.itemList([{ title: 'A', url: 'u1' }, { title: 'B', url: 'u2' }]);
    const items = list.itemListElement as Array<Record<string, unknown>>;
    expect(items.map((i) => i.position)).toEqual([1, 2]);
    expect(items[1].name).toBe('B');
  });

  it('VideoObject omits fields that are not real, includes the ones that are', () => {
    const v = Ld.videoObject({
      name: 'V', description: 'D', url: 'https://x/c/c/l', thumbnailUrl: 'https://t/img.jpg',
      uploadDate: '2025-01-01T00:00:00.000Z', durationSec: 120, contentUrl: 'https://h/master.m3u8', inLanguage: 'en',
    })!;
    expect(v['@type']).toBe('VideoObject');
    expect(v.thumbnailUrl).toBe('https://t/img.jpg');
    expect(v.duration).toBe('PT2M');
    expect(v.contentUrl).toBe('https://h/master.m3u8');
    expect(v).not.toHaveProperty('aggregateRating'); // never fabricated
  });

  it('VideoObject is null when there is no real video', () => {
    expect(Ld.videoObject({ name: 'V', description: 'D', url: 'u', thumbnailUrl: null, uploadDate: null, durationSec: null, contentUrl: null, inLanguage: 'en' })).toBeNull();
  });

  it('Clips only emitted for real labelled timestamps', () => {
    const clips = Ld.clips('https://x/c/c/l', [
      { label: 'Intro', startSec: 0, endSec: 30 },
      { label: '', startSec: 30, endSec: 60 },        // no label → dropped
      { label: 'End', startSec: 60, endSec: 0 },       // no valid end → still a clip, no endOffset
    ]);
    expect(clips).toHaveLength(2);
    expect(clips[0]).toMatchObject({ '@type': 'Clip', name: 'Intro', startOffset: 0, endOffset: 30 });
    expect(clips[0].url).toBe('https://x/c/c/l#t=0');
    expect(clips[1]).not.toHaveProperty('endOffset');
  });

  it('BreadcrumbList positions are 1-based', () => {
    const bc = Ld.breadcrumbList([{ name: 'Home', url: 'h' }, { name: 'Course', url: 'c' }]);
    const items = bc.itemListElement as Array<Record<string, unknown>>;
    expect(items.map((i) => i.position)).toEqual([1, 2]);
  });
});
