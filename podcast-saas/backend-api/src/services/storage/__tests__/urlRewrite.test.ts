/**
 * The URL rewrite planner: a URL under a FROM base becomes TO + key; anything else is untouched,
 * including one already under TO; JSON is walked and every string that plans is rewritten.
 */
import { describe, it, expect } from 'vitest';
import { planUrlRewrite, rewriteJsonUrls } from '../urlRewrite.js';

const FROM = ['https://ref.supabase.co/storage/v1/object/public/media', 'https://api.flowvidco.com/sim-public'];
const TO = 'https://media.flowvidco.com/';

describe('planUrlRewrite', () => {
  it('rewrites a URL under a FROM base to TO + key, trimming the trailing slash of TO', () => {
    expect(planUrlRewrite('https://ref.supabase.co/storage/v1/object/public/media/images/p1/a.png', FROM, TO)).toEqual({
      from: 'https://ref.supabase.co/storage/v1/object/public/media/images/p1/a.png',
      to: 'https://media.flowvidco.com/images/p1/a.png',
      key: 'images/p1/a.png',
    });
    expect(planUrlRewrite('https://api.flowvidco.com/sim-public/simulations/p1/s1/index.html', FROM, TO)?.key).toBe('simulations/p1/s1/index.html');
  });

  it('leaves alone: null, a foreign URL, a bare key, and a URL already under TO', () => {
    expect(planUrlRewrite(null, FROM, TO)).toBeNull();
    expect(planUrlRewrite('https://elsewhere.example/a.png', FROM, TO)).toBeNull();
    expect(planUrlRewrite('images/p1/a.png', FROM, TO)).toBeNull();
    expect(planUrlRewrite('https://media.flowvidco.com/images/p1/a.png', FROM, TO)).toBeNull();
  });
});

describe('rewriteJsonUrls', () => {
  it('walks nested guidance JSON and rewrites every URL that plans, keeping the shape', () => {
    const guidance = {
      mdUrl: 'https://ref.supabase.co/storage/v1/object/public/media/simulations/p1/s1/guidance/understanding.md',
      entries: [
        { id: 'e1', audioUrl: 'https://api.flowvidco.com/sim-public/simulations/p1/s1/guidance/en/e1.abc.mp3', text: 'hello' },
        { id: 'e2', audioUrl: 'https://media.flowvidco.com/simulations/p1/s1/guidance/en/e2.mp3' },
      ],
      n: 3,
    };
    const { value, plans } = rewriteJsonUrls(guidance, FROM, TO);
    expect(plans.map((p) => p.key)).toEqual(['simulations/p1/s1/guidance/understanding.md', 'simulations/p1/s1/guidance/en/e1.abc.mp3']);
    expect(value).toEqual({
      mdUrl: 'https://media.flowvidco.com/simulations/p1/s1/guidance/understanding.md',
      entries: [
        { id: 'e1', audioUrl: 'https://media.flowvidco.com/simulations/p1/s1/guidance/en/e1.abc.mp3', text: 'hello' },
        { id: 'e2', audioUrl: 'https://media.flowvidco.com/simulations/p1/s1/guidance/en/e2.mp3' },
      ],
      n: 3,
    });
  });

  it('a value with nothing to rewrite plans nothing and comes back equal', () => {
    const { value, plans } = rewriteJsonUrls({ a: [1, 'x', null] }, FROM, TO);
    expect(plans).toEqual([]);
    expect(value).toEqual({ a: [1, 'x', null] });
  });
});
