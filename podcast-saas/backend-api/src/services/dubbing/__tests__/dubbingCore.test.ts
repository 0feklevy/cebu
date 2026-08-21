/**
 * The pure decisions the dubbing pipeline rests on — the ones where being wrong costs money.
 *
 * Everything under test here is a pure function precisely so it can be pinned without a database,
 * a queue or a vendor. The three groups map onto the three ways this feature can fail expensively:
 * spending twice, spending on silence, and telling the creator a price that is not the price.
 */
import { describe, it, expect } from 'vitest';

import { shouldSkipDub, hasAudibleSpeech, dubReference, STALE_CLAIM_MS, FAILED_RETRY_MS } from '../DubbingService.js';
import { isLanguageOutputFresh } from '../ElevenLabsDubbingClient.js';
import {
  estimateDubbingCost,
  usdPerMinutePerLanguage,
  CREDITS_PER_MINUTE_AUTOMATIC_CLEAN,
  CREDITS_PER_MINUTE_AUTOMATIC_WATERMARKED,
} from '../cost.js';
import {
  normalizeDubbingLanguage,
  vendorTargetLanguage,
  sourceLanguageTag,
  isSupportedDubbingLanguage,
  DUBBING_LANGUAGES,
} from '../languages.js';
import { dubbingWatermarkPolicy, dubbingNumSpeakers, dubbingUsdPerCredit } from '../config.js';

const NOW = 1_700_000_000_000;

describe('shouldSkipDub — the gate that stands between a retry and a second invoice', () => {
  it('skips a completed dub whose source has not changed', () => {
    expect(shouldSkipDub({ status: 'completed', hashMatches: true, updatedAtMs: NOW, now: NOW })).toBe(true);
  });

  it('does NOT skip when the source changed — the existing dub describes a video that is gone', () => {
    expect(shouldSkipDub({ status: 'completed', hashMatches: false, updatedAtMs: NOW, now: NOW })).toBe(false);
  });

  it('skips a FRESH processing claim, so two workers cannot both pay for one dub', () => {
    expect(shouldSkipDub({
      status: 'processing', hashMatches: true, updatedAtMs: NOW - 60_000, now: NOW,
    })).toBe(true);
  });

  it('reclaims a STALE processing claim, so a crashed worker does not strand the dub forever', () => {
    expect(shouldSkipDub({
      status: 'processing', hashMatches: true, updatedAtMs: NOW - STALE_CLAIM_MS - 1, now: NOW,
    })).toBe(false);
  });

  it('holds a failed dub for the backoff window, then lets it run again', () => {
    expect(shouldSkipDub({
      status: 'failed', hashMatches: true, updatedAtMs: NOW - 60_000, now: NOW,
    })).toBe(true);
    expect(shouldSkipDub({
      status: 'failed', hashMatches: true, updatedAtMs: NOW - FAILED_RETRY_MS - 1, now: NOW,
    })).toBe(false);
  });

  it('never skips a `stale` row — the vendor transcript moved, so the output is out of date', () => {
    expect(shouldSkipDub({ status: 'stale', hashMatches: true, updatedAtMs: NOW, now: NOW })).toBe(false);
  });

  it('force bypasses every gate, including a completed dub', () => {
    expect(shouldSkipDub({
      status: 'completed', hashMatches: true, updatedAtMs: NOW, force: true, now: NOW,
    })).toBe(false);
  });

  it('runs a brand-new queued row', () => {
    expect(shouldSkipDub({ status: 'queued', hashMatches: true, updatedAtMs: 0, now: NOW })).toBe(false);
  });
});

describe('isLanguageOutputFresh — why "outputs is not null" is the wrong test', () => {
  it('accepts a completed target whose output matches its revision', () => {
    expect(isLanguageOutputFresh({ status: 'completed', revision: 3, output_revision: 3 })).toBe(true);
  });

  it('REJECTS a stale target, which keeps the outputs it had before the transcript changed', () => {
    // This is the whole point: a naive non-null check on `outputs` serves the pre-edit dub forever.
    expect(isLanguageOutputFresh({ status: 'stale', revision: 4, output_revision: 3 })).toBe(false);
  });

  it('rejects a completed target whose output was generated from an older revision', () => {
    expect(isLanguageOutputFresh({ status: 'completed', revision: 4, output_revision: 3 })).toBe(false);
  });

  it('rejects anything not yet completed', () => {
    expect(isLanguageOutputFresh({ status: 'queued', revision: 1, output_revision: null })).toBe(false);
    expect(isLanguageOutputFresh({ status: 'processing', revision: 1, output_revision: null })).toBe(false);
    expect(isLanguageOutputFresh({ status: 'failed', revision: 1, output_revision: 1 })).toBe(false);
  });

  it('takes `completed` at face value when the vendor reports no revision counters at all', () => {
    // Absence of the counters is not evidence of staleness, and refusing every dub that omits them
    // would make the feature depend on an optional field.
    expect(isLanguageOutputFresh({ status: 'completed', revision: null, output_revision: null })).toBe(true);
  });
});

describe('hasAudibleSpeech — the free pre-check before any credits are spent', () => {
  it('passes ordinary speech', () => {
    expect(hasAudibleSpeech(JSON.stringify([0.1, 0.6, 0.3, 0.9]))).toBe(true);
  });

  it('rejects a flat, silent waveform — b-roll and screen recordings hit this constantly', () => {
    expect(hasAudibleSpeech(JSON.stringify(new Array(200).fill(0)))).toBe(false);
  });

  it('passes when no waveform was recorded — missing data is not evidence of silence', () => {
    expect(hasAudibleSpeech(null)).toBe(true);
    expect(hasAudibleSpeech(undefined)).toBe(true);
    expect(hasAudibleSpeech('')).toBe(true);
  });

  it('passes on malformed input rather than refusing to dub over a parse failure', () => {
    expect(hasAudibleSpeech('not json')).toBe(true);
    expect(hasAudibleSpeech('{}')).toBe(true);
    expect(hasAudibleSpeech('[]')).toBe(true);
  });
});

describe('dubReference — the handle that finds an already-billed job after a crash', () => {
  it('is derived only from the dub id, so it is reproducible from the row alone', () => {
    expect(dubReference('abc-123')).toBe('flowvid:dub:abc-123');
  });

  it('fits the vendor 500-character limit for any UUID', () => {
    expect(dubReference('00000000-0000-0000-0000-000000000000').length).toBeLessThan(500);
  });
});

describe('cost — the arithmetic the creator sees before the run', () => {
  it('bills per source minute PER LANGUAGE, which is the multiplication creators get wrong', () => {
    const one = estimateDubbingCost({ durationSec: 600, languageCount: 1, watermarked: false });
    const two = estimateDubbingCost({ durationSec: 600, languageCount: 2, watermarked: false });
    expect(two.credits).toBeCloseTo(one.credits * 2);
    // 10 source minutes × 3,000 credits × 2 languages.
    expect(two.credits).toBeCloseTo(10 * CREDITS_PER_MINUTE_AUTOMATIC_CLEAN * 2);
  });

  it('reproduces the vendor headline of $2.20 per source-minute per language', () => {
    expect(usdPerMinutePerLanguage(false)).toBeCloseTo(2.20, 6);
    const hour = estimateDubbingCost({ durationSec: 3600, languageCount: 1, watermarked: false });
    expect(hour.usd).toBeCloseTo(60 * 2.20, 4);
  });

  it('prices the watermarked rate lower — the 1.5x gap the API default silently costs', () => {
    const clean = estimateDubbingCost({ durationSec: 600, languageCount: 1, watermarked: false });
    const marked = estimateDubbingCost({ durationSec: 600, languageCount: 1, watermarked: true });
    expect(clean.creditsPerMinute).toBe(CREDITS_PER_MINUTE_AUTOMATIC_CLEAN);
    expect(marked.creditsPerMinute).toBe(CREDITS_PER_MINUTE_AUTOMATIC_WATERMARKED);
    expect(clean.credits / marked.credits).toBeCloseTo(1.5, 6);
  });

  it('moves with a known per-credit rate, so a better plan shows a better estimate', () => {
    const cheap = estimateDubbingCost({
      durationSec: 600, languageCount: 1, watermarked: false, usdPerCredit: 0.33 / 3000,
    });
    expect(cheap.usd).toBeCloseTo(10 * 0.33, 6);
  });

  it('reports cost_cents in the fractional cents token_usage stores', () => {
    const cost = estimateDubbingCost({ durationSec: 60, languageCount: 1, watermarked: false });
    expect(cost.costCents).toBeCloseTo(220, 4);
  });

  it('prices an unprobed or nonsensical duration as zero instead of throwing on a read path', () => {
    for (const durationSec of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(estimateDubbingCost({ durationSec, languageCount: 2, watermarked: false }).usd).toBe(0);
    }
    expect(estimateDubbingCost({ durationSec: 600, languageCount: 0, watermarked: false }).usd).toBe(0);
  });
});

describe('language codes — the rules that produce a vendor error rather than a fallback', () => {
  it('offers he, es and en, and the URL suffix IS the base code', () => {
    expect(DUBBING_LANGUAGES.map((l) => l.code).sort()).toEqual(['en', 'es', 'he']);
  });

  it('collapses a dialect to its base code for storage and the URL', () => {
    expect(normalizeDubbingLanguage('es-MX')).toBe('es');
    expect(normalizeDubbingLanguage('en-GB')).toBe('en');
  });

  it('keeps a supported dialect for the VENDOR, where it selects the accent', () => {
    expect(vendorTargetLanguage('es-MX')).toBe('es-MX');
    expect(vendorTargetLanguage('es')).toBe('es');
  });

  it('never emits he-IL — Hebrew has no dialects and the tag would not match', () => {
    expect(DUBBING_LANGUAGES.find((l) => l.code === 'he')!.dialects).toEqual([]);
    expect(vendorTargetLanguage('he')).toBe('he');
    expect(isSupportedDubbingLanguage('he-IL')).toBe(false);
    expect(vendorTargetLanguage('he-IL')).toBeNull();
  });

  it('rejects es-419, which is NOT in the supported-dialect table despite claims otherwise', () => {
    expect(isSupportedDubbingLanguage('es-419')).toBe(false);
    expect(vendorTargetLanguage('es-419')).toBeNull();
  });

  it('rejects an unoffered language before any billable call can be made', () => {
    expect(vendorTargetLanguage('fr')).toBeNull();
    expect(normalizeDubbingLanguage('klingon')).toBeNull();
  });

  it('strips region subtags from a SOURCE tag, which the vendor ignores anyway', () => {
    expect(sourceLanguageTag('en-GB')).toBe('en');
    expect(sourceLanguageTag('he')).toBe('he');
    expect(sourceLanguageTag(null)).toBeNull();
    expect(sourceLanguageTag('not a tag')).toBeNull();
  });
});

describe('config — the plan facts that must not be guessed', () => {
  it('assumes WATERMARKED until told otherwise, because the safe default is the blocking one', () => {
    const policy = dubbingWatermarkPolicy({} as NodeJS.ProcessEnv);
    expect(policy.watermarked).toBe(true);
    expect(policy.declared).toBe(false);
    expect(policy.reason).toContain('ELEVENLABS_DUBBING_WATERMARKED');
  });

  it('publishes only when an operator has explicitly declared a non-watermarking plan', () => {
    const policy = dubbingWatermarkPolicy({ ELEVENLABS_DUBBING_WATERMARKED: 'false' } as NodeJS.ProcessEnv);
    expect(policy.watermarked).toBe(false);
    expect(policy.declared).toBe(true);
    expect(policy.reason).toBeNull();
  });

  it('treats an explicit true as declared, so the UI can distinguish it from an unset variable', () => {
    expect(dubbingWatermarkPolicy({ ELEVENLABS_DUBBING_WATERMARKED: 'true' } as NodeJS.ProcessEnv))
      .toMatchObject({ watermarked: true, declared: true });
  });

  it('falls back rather than pricing a dub at zero on a malformed rate', () => {
    expect(dubbingUsdPerCredit({ DUBBING_USD_PER_CREDIT: 'free' } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(dubbingUsdPerCredit({ DUBBING_USD_PER_CREDIT: '0' } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(dubbingUsdPerCredit({ DUBBING_USD_PER_CREDIT: '0.0004' } as NodeJS.ProcessEnv)).toBeCloseTo(0.0004);
  });

  it('declares one speaker by default — auto-detect is a failure mode we can simply avoid', () => {
    expect(dubbingNumSpeakers({} as NodeJS.ProcessEnv)).toBe(1);
    expect(dubbingNumSpeakers({ DUBBING_NUM_SPEAKERS: '4' } as NodeJS.ProcessEnv)).toBe(4);
    // Above the vendor's 32-speaker ceiling, or nonsense, falls back rather than failing the dub.
    expect(dubbingNumSpeakers({ DUBBING_NUM_SPEAKERS: '99' } as NodeJS.ProcessEnv)).toBe(1);
    expect(dubbingNumSpeakers({ DUBBING_NUM_SPEAKERS: 'many' } as NodeJS.ProcessEnv)).toBe(1);
  });
});
