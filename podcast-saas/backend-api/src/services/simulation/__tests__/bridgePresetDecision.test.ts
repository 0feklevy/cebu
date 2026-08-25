/**
 * Which path a saved-bridge load takes: instant paste, or regenerate from the recipe.
 *
 * The stake: an artifact pasted onto content it was not written for finds nothing and no-ops
 * SILENTLY — a dead section in production with no error anywhere. So every test about the recipe
 * fallback is the load-bearing kind, and the one thing that must never happen is `artifact` on
 * anything unproven.
 */
import { describe, it, expect } from 'vitest';
import { judgeBridgeLoad, describeLoadPath, type PresetForLoad, type TargetForLoad } from '../bridgePresetDecision.js';

const preset = (over: Partial<PresetForLoad> = {}): PresetForLoad => ({
  mainBody: 'window.__murmuration.pluck();',
  contract: { ids: [], selectors: [], texts: [], classes: [], globals: ['__murmuration'], members: [] } as never,
  sourceBridgeHash: 'hash-a',
  sourceHash: 'src-a',
  ...over,
});
const target = (over: Partial<TargetForLoad> = {}): TargetForLoad => ({
  bridgeHash: 'hash-b',
  verification: { missing: [], checked: 1 },
  ...over,
});

describe('when the artifact applies', () => {
  it('takes the instant path when every anchor verifies', () => {
    const v = judgeBridgeLoad(preset(), target());
    expect(v).toEqual({ path: 'artifact', sameContent: false });
  });

  it('reports same-content as context when the hashes also match', () => {
    const v = judgeBridgeLoad(preset(), target({ bridgeHash: 'hash-a' }));
    expect(v).toEqual({ path: 'artifact', sameContent: true });
  });
});

describe('when it must not', () => {
  it('regenerates when anchors are MISSING — and names them for the UI', () => {
    const missing = [{ kind: 'global', token: 'window.__murmuration' }] as never[];
    const v = judgeBridgeLoad(preset(), target({ verification: { missing, checked: 5 } }));
    expect(v).toMatchObject({ path: 'recipe', why: 'anchors-missing' });
    expect((v as { missing: unknown[] }).missing).toEqual(missing);
  });

  it('MATCHING HASHES do not shortcut past a failed verification', () => {
    // Hash equality makes compatibility likely, not proven — and the shortcut is the one hole
    // through which a silently-dead section could ship. The verification verdict always wins.
    const missing = [{ kind: 'id', token: '#speed' }] as never[];
    const v = judgeBridgeLoad(
      preset({ sourceBridgeHash: 'same' }),
      target({ bridgeHash: 'same', verification: { missing, checked: 3 } }),
    );
    expect(v.path).toBe('recipe');
  });

  it('treats "verification could not run" as recipe, never as assumed-fit', () => {
    // The target's sources being unreadable must not resolve to "paste it anyway".
    const v = judgeBridgeLoad(preset(), target({ verification: null }));
    expect(v).toMatchObject({ path: 'recipe', why: 'verification-unavailable' });
  });

  it('treats a contract-less body as recipe — an unjudgable paste is the silent no-op itself', () => {
    const v = judgeBridgeLoad(preset({ contract: null }), target());
    expect(v).toMatchObject({ path: 'recipe', why: 'no-contract' });
  });

  it('handles a recipe-only preset (no script ever generated) as a first-class case', () => {
    const v = judgeBridgeLoad(preset({ mainBody: null }), target());
    expect(v).toMatchObject({ path: 'recipe', why: 'no-artifact' });
  });
});

describe('the sentence beside the Load button', () => {
  it('says instant when instant', () => {
    expect(describeLoadPath({ path: 'artifact', sameContent: true })).toMatch(/exact simulation.*instantly/);
    expect(describeLoadPath({ path: 'artifact', sameContent: false })).toMatch(/instantly/);
  });

  it('names what the target is missing, capped so three selectors do not become a wall', () => {
    const missing = Array.from({ length: 5 }, (_, i) => ({ kind: 'id', token: `#ctl-${i}` })) as never[];
    const s = describeLoadPath({ path: 'recipe', why: 'anchors-missing', missing });
    expect(s).toContain('#ctl-0');
    expect(s).toContain('and 2 more');
    expect(s).not.toContain('#ctl-4');
  });

  it('never promises instant on any recipe path', () => {
    for (const why of ['no-artifact', 'no-contract', 'verification-unavailable'] as const) {
      expect(describeLoadPath({ path: 'recipe', why, missing: [] }), why).not.toMatch(/instantly/);
    }
  });
});
