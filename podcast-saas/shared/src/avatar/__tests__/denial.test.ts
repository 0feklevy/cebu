/**
 * What a refused viewer is told.
 *
 * Two things are being protected and they pull against each other: the message has to be useful
 * enough that somebody waits instead of leaving, and vague enough that it does not describe the
 * shape of the rate limiter to whoever is probing it.
 */
import { describe, it, expect } from 'vitest';
import {
  publicDenialReason,
  normaliseRetryAfter,
  avatarDenialCopy,
  avatarDenialBody,
  parseAvatarDenial,
} from '../denial.js';

describe('what the viewer is allowed to know', () => {
  it('never leaks WHICH limiter dimension fired', () => {
    // `ip`, `uid` and `project` are what an operator needs in a log and exactly what a viewer must
    // not be handed: it describes the defence to whoever is testing it, and means nothing to the
    // person who wanted the avatar to talk.
    for (const internal of ['ip', 'uid', 'project', 'uid_hourly', 'ip_burst']) {
      const body = avatarDenialBody({ deniedBy: internal, retryAfterSec: 30 });
      expect(JSON.stringify(body), internal).not.toContain(internal);
    }
  });

  it('calls a platform-wide refusal BUSY, so it does not read as the viewer\'s fault', () => {
    // Somebody refused for a reason they cannot influence retries immediately unless told why.
    expect(publicDenialReason('global')).toBe('busy');
    expect(publicDenialReason('global_concurrency')).toBe('busy');
  });

  it('calls a broken meter UNAVAILABLE', () => {
    expect(publicDenialReason('meter_unavailable')).toBe('unavailable');
  });

  it('defaults an unknown dimension to LIMITED, not to unavailable', () => {
    // An unrecognised dimension is far more likely to be a new per-subject limit than a broken
    // meter, and telling somebody the service is down when they have used their share sends them
    // to support instead of to a cup of tea.
    expect(publicDenialReason('some_new_bucket')).toBe('limited');
    expect(publicDenialReason(null)).toBe('limited');
    expect(publicDenialReason(undefined)).toBe('limited');
  });
});

describe('the retry time', () => {
  it('is never zero — that invites an immediate retry and a second refusal', () => {
    for (const v of [0, -5, NaN, null, undefined]) {
      expect(normaliseRetryAfter(v as number), String(v)).toBeGreaterThanOrEqual(1);
    }
  });

  it('is capped at an hour, because a bigger number reads as "never"', () => {
    expect(normaliseRetryAfter(999_999)).toBe(3600);
    expect(normaliseRetryAfter(Infinity)).toBe(3600);
  });

  it('passes an ordinary value through', () => {
    expect(normaliseRetryAfter(45)).toBe(45);
  });
});

describe('the sentence a viewer reads', () => {
  it('does not print a countdown under a minute', () => {
    // "Try again in 7 seconds" invites the viewer to count, and being wrong by a second makes the
    // product look broken. "In a moment" is honest at that resolution and no clock can falsify it.
    const copy = avatarDenialCopy({ reason: 'limited', retryAfterSec: 7 });
    expect(copy).toContain('in a moment');
    expect(copy).not.toMatch(/\d/);
  });

  it('scales its vagueness with the wait', () => {
    expect(avatarDenialCopy({ reason: 'limited', retryAfterSec: 200 })).toContain('a few minutes');
    expect(avatarDenialCopy({ reason: 'limited', retryAfterSec: 1800 })).toContain('a little while');
  });

  it('says a platform-wide refusal is not about the viewer', () => {
    expect(avatarDenialCopy({ reason: 'busy', retryAfterSec: 30 })).toMatch(/across the platform/i);
  });

  it('promises NO time when the meter is unreachable', () => {
    // That is not a countdown, and a fabricated estimate is what erodes trust in every other
    // message here.
    const copy = avatarDenialCopy({ reason: 'unavailable', retryAfterSec: 30 });
    expect(copy).not.toMatch(/in a moment|few minutes|little while/);
    expect(copy).toMatch(/temporarily unavailable/i);
  });
});

describe('the body on the wire', () => {
  it('keeps `message` for every client that only reads that field', () => {
    // The field already shipped. Removing it to make room for the structured one would break the
    // clients this change exists to help.
    const body = avatarDenialBody({ deniedBy: 'uid', retryAfterSec: 20 });
    expect(typeof body.message).toBe('string');
    expect(body.message.length).toBeGreaterThan(0);
  });

  it('carries the machine-readable pair a client can act on', () => {
    const body = avatarDenialBody({ deniedBy: 'global', retryAfterSec: 90 });
    expect(body.reason).toBe('busy');
    expect(body.retryAfterSec).toBe(90);
  });

  it('lets a caller override the copy without losing the structure', () => {
    const body = avatarDenialBody({ deniedBy: 'uid', retryAfterSec: 5, message: 'Avatar capability required' });
    expect(body.message).toBe('Avatar capability required');
    expect(body.reason).toBe('limited');
  });
});

describe('the shapes the runtime actually emits', () => {
  // These strings are not hypothetical — they are what avatarBudgetRuntime.ts returns today.
  it('judges the DIMENSION behind a burst: prefix, not the prefix', () => {
    // `burst:global` used to fall through to the per-subject default and tell a viewer they had
    // used their share, during a platform-wide surge they had no part in.
    expect(publicDenialReason('burst:global')).toBe('busy');
    expect(publicDenialReason('burst:ip')).toBe('limited');
  });

  it('treats the emergency stop as unavailable, never as the viewer\'s limit', () => {
    // An operator pulling the stop is not the viewer running out of anything.
    expect(publicDenialReason('kill_switch')).toBe('unavailable');
  });

  it('still hides the dimension when it arrives with a prefix', () => {
    const body = avatarDenialBody({ deniedBy: 'burst:project', retryAfterSec: 12 });
    expect(JSON.stringify(body)).not.toContain('project');
    expect(JSON.stringify(body)).not.toContain('burst');
  });
});

describe('reading a denial back off the wire', () => {
  it('round-trips one of ours', () => {
    const sent = avatarDenialBody({ deniedBy: 'burst:global', retryAfterSec: 42 });
    const read = parseAvatarDenial(JSON.parse(JSON.stringify(sent)));
    expect(read).toEqual(sent);
  });

  it('refuses anything that is not recognisably ours', () => {
    // The client shows a fixed generic string on failure on purpose. Rendering a message merely
    // because it was present would put proxy errors, WAF pages and stack traces on a viewer's
    // screen — the exact rule (ui-ux-205) this parser has to keep intact.
    for (const hostile of [
      null, undefined, 'a string', 42, [],
      { message: 'ECONNREFUSED 10.0.0.4:5432' },
      { message: 'Set DATABASE_URL', reason: 'other' },
      { reason: 'BUSY' },                                  // wrong case is not the enum
      { retryAfterSec: 30 },                               // no reason at all
    ]) {
      expect(parseAvatarDenial(hostile), JSON.stringify(hostile)).toBeNull();
    }
  });

  it('REGENERATES the copy rather than trusting the string it was sent', () => {
    // The load-bearing assertion. A valid `reason` must not become a licence to render whatever
    // text arrived beside it.
    const read = parseAvatarDenial({
      reason: 'busy',
      retryAfterSec: 30,
      message: 'FATAL: password authentication failed for user "flowvid"',
    });
    expect(read?.message).not.toMatch(/password|FATAL|flowvid/);
    expect(read?.message).toBe(avatarDenialCopy({ reason: 'busy', retryAfterSec: 30 }));
  });

  it('survives a nonsense retry value without rejecting a genuine denial', () => {
    // A denial with a broken number is still a denial; dropping it would put the viewer back on
    // the generic screen for a case we can explain.
    const read = parseAvatarDenial({ reason: 'limited', retryAfterSec: 'soon' });
    expect(read?.reason).toBe('limited');
    expect(read?.retryAfterSec).toBe(1);
  });
});
