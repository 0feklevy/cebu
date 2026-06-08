import { describe, it, expect, beforeEach } from 'vitest';
import { courseUrl, lessonUrl, validateCanonicalOverride, platformBaseUrl, isPlatformUrl } from '../CanonicalUrlService.js';

beforeEach(() => { process.env.PUBLIC_SITE_URL = 'https://learn.example.com'; });

describe('CanonicalUrlService', () => {
  it('builds course + lesson URLs on the platform host', () => {
    expect(courseUrl('intro')).toBe('https://learn.example.com/c/intro');
    expect(lessonUrl('intro', 'lesson-1')).toBe('https://learn.example.com/c/intro/lesson-1');
  });

  it('normalizes a trailing slash on the base', () => {
    process.env.PUBLIC_SITE_URL = 'https://learn.example.com/';
    expect(platformBaseUrl()).toBe('https://learn.example.com');
  });

  it('uses a verified custom host when provided, ignores an invalid one', () => {
    expect(courseUrl('x', { verifiedCustomHost: 'my.school.com' })).toBe('https://my.school.com/c/x');
    expect(courseUrl('x', { verifiedCustomHost: 'not a host' })).toBe('https://learn.example.com/c/x');
    expect(courseUrl('x', { verifiedCustomHost: null })).toBe('https://learn.example.com/c/x');
  });

  it('validates canonical overrides and strips query/hash', () => {
    expect(validateCanonicalOverride('https://a.com/c/x?utm=1#frag')).toBe('https://a.com/c/x');
    expect(validateCanonicalOverride('https://a.com/c/x/')).toBe('https://a.com/c/x');
  });

  it('rejects relative, non-http, and credentialed overrides', () => {
    expect(validateCanonicalOverride('/c/x')).toBeNull();
    expect(validateCanonicalOverride('javascript:alert(1)')).toBeNull();
    expect(validateCanonicalOverride('ftp://a.com/x')).toBeNull();
    expect(validateCanonicalOverride('https://user:pass@a.com/x')).toBeNull();
    expect(validateCanonicalOverride(null)).toBeNull();
  });

  it('isPlatformUrl detects platform vs external', () => {
    expect(isPlatformUrl('https://learn.example.com/c/x')).toBe(true);
    expect(isPlatformUrl('https://evil.com/c/x')).toBe(false);
  });
});
