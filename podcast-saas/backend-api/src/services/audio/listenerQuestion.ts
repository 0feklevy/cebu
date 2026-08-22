/**
 * Raise Your Hand — the rules, P3-B / A2.4.
 *
 * A listener at a moment in a lesson asks a question and gets an answer grounded in what was
 * being said at that moment. Two things about that sentence carry the whole design:
 *
 * **The listener is driving.** Typing is not always available, so a question can be SAVED rather
 * than asked — a marker with a timestamp, costing nothing, reviewed when stopped. The design rules
 * out any interaction that requires looking at the screen while driving, and this is what those
 * interactions degrade to rather than being dropped.
 *
 * **The listener is not the payer.** The project owner pays for every answer, and the asking
 * surface is public. An endpoint that turns an anonymous request into an LLM call is a way to
 * spend someone else's money, so the cap here is not a nicety — it is the difference between a
 * feature and a billing incident. `$0 while listening` is the design's phrase for it: listening
 * costs nothing, and only a question that is actually ANSWERED costs anything at all.
 */

/** One caption cue, in the edition's timebase. */
export interface Cue {
  startMs: number;
  endMs: number;
  text: string;
}

/**
 * Parse an edition's WebVTT into cues.
 *
 * Deliberately tolerant of what real caption files contain — cue identifiers on their own line,
 * `NOTE` blocks, settings after the timestamps, CRLF, the comma decimal separator some tools
 * emit. A parser that only accepts the shape WE write is a parser that fails on the first file
 * that came from anywhere else, and the failure is a question answered from an empty transcript
 * rather than an error.
 */
export function parseVtt(vtt: string): Cue[] {
  const cues: Cue[] = [];
  if (!vtt) return cues;

  const TIME = /(\d{1,3}):([0-5]\d):([0-5]\d)[.,](\d{1,3})\s*-->\s*(\d{1,3}):([0-5]\d):([0-5]\d)[.,](\d{1,3})/;
  const lines = vtt.replace(/\r\n?/g, '\n').split('\n');

  for (let i = 0; i < lines.length; i++) {
    const m = TIME.exec(lines[i]);
    if (!m) continue;
    const startMs = toMs(m[1], m[2], m[3], m[4]);
    const endMs = toMs(m[5], m[6], m[7], m[8]);

    // Text runs until the next blank line. A cue with no text is skipped rather than stored: it
    // would take up a slot in the window and contribute nothing to the answer.
    const text: string[] = [];
    for (let j = i + 1; j < lines.length && lines[j].trim() !== ''; j++) text.push(lines[j].trim());
    const joined = text.join(' ').trim();
    if (joined) cues.push({ startMs, endMs, text: joined });
    i += text.length;
  }
  return cues;
}

function toMs(h: string, m: string, s: string, ms: string): number {
  return Number(h) * 3_600_000 + Number(m) * 60_000 + Number(s) * 1000 + Number(ms.padEnd(3, '0'));
}

/** How much lesson to send with a question, in milliseconds either side of the moment. */
export const CONTEXT_BEFORE_MS = 90_000;
export const CONTEXT_AFTER_MS = 30_000;
// ASYMMETRIC, and that is the point. A listener asks about something they just heard, so the
// useful context is mostly BEHIND them. Including as much ahead as behind doubles the prompt for
// material the question cannot be about — and on a per-answer budget, prompt size is the cost.

/** Roughly how many characters of transcript one answer may carry. */
export const MAX_CONTEXT_CHARS = 6000;
// A ceiling in CHARACTERS rather than cues, because cue length varies wildly between a
// machine-transcribed lesson and a hand-written one, and the thing being bounded is the bill.

/**
 * The transcript around a moment.
 *
 * Clamped to `MAX_CONTEXT_CHARS` by dropping from the FRONT — the oldest material — so the cues
 * nearest the question always survive. Trimming from the end would discard exactly the sentence
 * the listener is asking about.
 */
export function contextAround(cues: readonly Cue[], positionMs: number): string {
  const from = positionMs - CONTEXT_BEFORE_MS;
  const to = positionMs + CONTEXT_AFTER_MS;
  const window = cues.filter((c) => c.endMs >= from && c.startMs <= to);

  const parts: string[] = [];
  let total = 0;
  // Walk BACKWARDS from the question, taking cues until the budget runs out, then restore order.
  for (let i = window.length - 1; i >= 0; i--) {
    const t = window[i].text;
    if (total + t.length > MAX_CONTEXT_CHARS) break;
    parts.push(t);
    total += t.length + 1;
  }
  return parts.reverse().join(' ');
}

/** What a listener may do with a question. */
export type QuestionIntent = 'answer' | 'save';

export interface SpendDecision {
  allowed: boolean;
  /** Why not, in words the listener can act on. Null when allowed. */
  reason: string | null;
  /** Machine-readable, for metrics that need to distinguish the refusals. */
  code: 'ok' | 'daily_cap' | 'too_long' | 'empty' | 'disabled';
}

/** The longest question that will be answered. */
export const MAX_QUESTION_CHARS = 500;
// Not a UX preference. The question is attacker-controlled text that goes into a prompt the owner
// pays for, so its length is a cost lever anyone can pull. Five hundred characters is longer than
// any real spoken question and short enough that the ceiling on one answer is knowable.

export interface SpendInput {
  intent: QuestionIntent;
  question: string;
  /** Answers already produced for this project inside the current window. */
  answeredToday: number;
  /** The owner's cap. */
  dailyCap: number;
  /** Whether the owner has the feature on at all. */
  enabled: boolean;
}

/**
 * May this question be ANSWERED, and therefore paid for?
 *
 * Saving is always allowed and never consults the cap: a saved question costs nothing, and
 * refusing to record one because the answer budget is exhausted would take away the driver's only
 * hands-free option for the reason that has least to do with them.
 */
export function decideSpend(input: SpendInput): SpendDecision {
  const q = input.question.trim();
  if (!q) return { allowed: false, reason: 'A question needs some words in it.', code: 'empty' };
  if (q.length > MAX_QUESTION_CHARS) {
    return {
      allowed: false,
      reason: `Questions are limited to ${MAX_QUESTION_CHARS} characters.`,
      code: 'too_long',
    };
  }
  // Saving is checked AFTER the shape checks and BEFORE anything about money, because an empty
  // saved marker is still useless, and a well-formed one is still free.
  if (input.intent === 'save') return { allowed: true, reason: null, code: 'ok' };

  if (!input.enabled) {
    return { allowed: false, reason: 'The creator has not enabled questions on this lesson.', code: 'disabled' };
  }
  if (input.answeredToday >= input.dailyCap) {
    // The listener is told the truth without being told the creator's numbers: a cap that reveals
    // its own size is a cap someone can plan around.
    return {
      allowed: false,
      reason: 'This lesson has answered all its questions for today. Your question was saved.',
      code: 'daily_cap',
    };
  }
  return { allowed: true, reason: null, code: 'ok' };
}

/**
 * What happens to a question the cap refused.
 *
 * It is SAVED, not discarded. The listener asked something real, the creator wants to know what
 * their listeners are confused about, and throwing it away to enforce a spending limit loses the
 * data the limit was protecting the budget FOR. This is also the demand signal A2.5 waits on.
 */
export function fallbackIntent(decision: SpendDecision): QuestionIntent | null {
  if (decision.allowed) return null;
  return decision.code === 'daily_cap' || decision.code === 'disabled' ? 'save' : null;
}
