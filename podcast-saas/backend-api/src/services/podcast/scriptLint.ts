/**
 * Deterministic "AI-tell" detector for podcast scripts.
 *
 * Listener studies of AI podcasts (NotebookLM reviews, 200-episode analyses)
 * converge on the same tells: stock enthusiasm filler ("deep dive", "great
 * point"), serial affirmations, hosts claiming fake lived experiences, greeting
 * cold-opens, and one host lecturing for long runs. LLM reviewers miss these
 * (they generate them); a regex pass doesn't. Findings feed the rewrite pass —
 * the playwright gets told exactly which turn to fix and why.
 */

export interface LintTurn {
  speaker: 'teacher' | 'learner';
  text: string;
  overlap: boolean;
}

export interface LintFinding {
  rule: string;
  turn_index: number;
  quote: string;
  problem: string;
}

/** Stock phrases that mark a script as AI-generated (case-insensitive). */
const BANNED_PHRASES = [
  'deep dive', 'deep-dive', "let's unpack", 'let us unpack', 'unpack this',
  'great point', "that's a great point", 'fascinating, isn', 'so fascinating',
  "hmm, that's interesting", "i'm intrigued", 'high-stakes world',
  'buckle up', 'strap in', 'without further ado', 'at the end of the day',
  'game-changer', 'game changer', 'mind-blowing', 'rabbit hole',
];

/** Greeting/announcement openers that kill a cold open (checked in the first 3 turns). */
const BANNED_OPENERS = [
  'welcome', 'hey everyone', 'hello everyone', 'hi everyone', "today we're talking",
  'today we are talking', "in this episode", "on today's episode", "let's talk about",
];

/** Affirmation-only turn openers — allowed sparsely, a chain is a tell. */
const AFFIRMATION_OPENER = /^(right|exactly|absolutely|totally|precisely|definitely|for sure)\b[.,!\s]/i;

/** First-person fake-lived-experience claims (an AI host has no college years). */
const FAKE_EXPERIENCE = /\b(when i was (in|a) (college|school|university|kid|child)|back in my day|in my experience at|my (wife|husband|kids?|boss|coworker)|i remember when i)\b/i;

/**
 * Unanchored continuity in the cold open — referencing rounds/events/characters the
 * episode hasn't established ("Round three… our bloodhound from last time? Frozen.").
 * In-medias-res drops into a SCENE, never into unexplained continuity.
 */
const UNANCHORED_OPEN = /\b(round (two|three|four|five|2|3|4|5)|last time|last round|once again|as we (saw|said|learned)|remember (when|how)|from (before|last time)|previous (round|episode|game))\b/i;

export interface LintOptions {
  /** A show with real prior episodes may legitimately call back ("last time…"). */
  hasSeriesMemory?: boolean;
}

export function lintScript(turns: LintTurn[], opts: LintOptions = {}): LintFinding[] {
  const findings: LintFinding[] = [];
  const seq = turns.filter((t) => !t.overlap);

  // 1) Banned stock phrases anywhere.
  turns.forEach((t, i) => {
    const lower = t.text.toLowerCase();
    for (const p of BANNED_PHRASES) {
      if (lower.includes(p)) {
        findings.push({ rule: 'banned_phrase', turn_index: i, quote: t.text.slice(0, 120), problem: `Stock AI phrase "${p}" — replace with something specific to THIS story.` });
        break;
      }
    }
  });

  // 2) Greeting/announcement in the cold open.
  turns.slice(0, 3).forEach((t, i) => {
    const lower = t.text.toLowerCase();
    for (const p of BANNED_OPENERS) {
      if (lower.includes(p)) {
        findings.push({ rule: 'greeting_open', turn_index: i, quote: t.text.slice(0, 120), problem: 'Cold open must start mid-scene with a concrete surprising fragment — no greetings or topic announcements.' });
        break;
      }
    }
  });

  // 2b) Unanchored continuity in the cold open ("Round three…", "last time…") —
  // orphaned exposition unless the show genuinely has prior episodes to call back to.
  if (!opts.hasSeriesMemory) {
    turns.slice(0, 3).forEach((t, i) => {
      if (UNANCHORED_OPEN.test(t.text)) {
        findings.push({
          rule: 'unanchored_open', turn_index: i, quote: t.text.slice(0, 120),
          problem: 'The open references an event/round/character the listener has no way to know yet. Establish the premise (the game, the players, the place) BEFORE any escalation — or open inside a self-explanatory scene.',
        });
      }
    });
  }

  // 3) Affirmation-opener density: > 1 per 8 sequential turns is a tell.
  const affirmIdx: number[] = [];
  seq.forEach((t, i) => { if (AFFIRMATION_OPENER.test(t.text.trim())) affirmIdx.push(i); });
  if (seq.length > 0 && affirmIdx.length > Math.max(1, Math.floor(seq.length / 8))) {
    findings.push({
      rule: 'affirmation_density', turn_index: affirmIdx[0],
      quote: seq[affirmIdx[0]]?.text.slice(0, 120) ?? '',
      problem: `${affirmIdx.length} turns open with a bare affirmation ("right/exactly/absolutely") — cap is ~1 per 8 turns; open with new content instead.`,
    });
  }

  // 4) Fake lived experience.
  turns.forEach((t, i) => {
    if (FAKE_EXPERIENCE.test(t.text)) {
      findings.push({ rule: 'fake_experience', turn_index: i, quote: t.text.slice(0, 120), problem: 'Host claims a human lived experience they cannot have — cut or reframe as a hypothetical.' });
    }
  });

  // 5) One host lecturing: >3 sequential turns in a row by the same speaker.
  let run = 1;
  for (let i = 1; i < seq.length; i++) {
    run = seq[i].speaker === seq[i - 1].speaker ? run + 1 : 1;
    if (run === 4) {
      findings.push({ rule: 'monologue_run', turn_index: i, quote: seq[i].text.slice(0, 120), problem: 'Four consecutive turns by the same speaker — the other host must enter (question, objection, or reaction).' });
    }
  }

  return findings;
}
