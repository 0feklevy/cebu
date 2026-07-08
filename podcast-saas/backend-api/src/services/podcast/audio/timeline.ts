/**
 * Build the conversation timeline — absolute start time for every clip.
 *
 * Grounded in the turn-taking literature (Stivers et al. 2009 PNAS; Levinson &
 * Torreira 2015; Roberts, Torreira & Levinson 2015; Kendrick & Torreira 2015;
 * CANDOR corpus), with one hard product rule on top:
 *
 *   TWO VOICES NEVER SPEAK WORDS AT THE SAME TIME.
 *
 * Sequential turns therefore never overlap — gaps are sampled from skewed
 * per-class distributions (variance is the realism; uniform gaps are the AI
 * tell) but always ≥ a small positive floor. The ONLY audio allowed to ride on
 * top of a line is a short NON-LEXICAL murmur ("mm-hm", "huh", a laugh) — and
 * a scripted reaction that contains real words is automatically demoted to a
 * normal sequential turn, placed snappily AFTER the line it reacts to.
 *
 * Class targets (speech-to-speech): answers ≈ +180ms after polar questions,
 * ≈ +280ms after why/how; disagreement arrives late (≥600ms — the delay carries
 * meaning); same-speaker sentence joins 150–400ms; beat bridges get a real
 * breath; scripted "—" cut-offs and latches snap in fast but never simultaneous.
 */

export interface TimelineTurn {
  turnId: string;
  speaker: 'teacher' | 'learner';
  overlap: boolean;
  durationMs: number;
  pauseAfterMs?: number;
  beat: string;
  text: string;
}

export interface Placement { turnId: string; delayMs: number; gainDb?: number }
export interface TimelineResult { placements: Placement[]; totalMs: number }

/** Murmurs sit clearly under the floor-holder so the words always win. */
const MURMUR_DUCK_DB = -6;
/** Jefferson's "standard maximum" tolerable silence. */
const MAX_GAP_MS = 1300;
/** Sequential turns never overlap — hard positive floor between them. */
const MIN_SEQ_GAP_MS = 30;
/** A murmur longer than this can't ride a line — it gets demoted to sequential. */
const MAX_MURMUR_MS = 900;
/**
 * Sampled targets are speech-to-speech FTOs, but clips keep an EDGE_PAD (~45ms)
 * of silence at each edge after trimming — so the file-to-file gap runs ~90ms
 * tighter than the target FTO for the EAR to hear the intended gap.
 */
const EDGE_COMPENSATION_MS = 90;
/**
 * Global pace: scale every SAMPLED gap (owner feedback: the exchange dragged).
 * Explicit editor pauses are exempt. Combined with the final-mix tempo lift this
 * keeps the show snappy without collapsing the meaningful delays (dispreferred
 * answers still land clearly later than confirmations).
 */
const GAP_PACE = 0.85;

/** Triangular sample in [min, max] with the given mode — skewed, never uniform. */
function tri(min: number, mode: number, max: number): number {
  const u = Math.random();
  const f = (mode - min) / (max - min);
  const v = u < f
    ? min + Math.sqrt(u * (max - min) * (mode - min))
    : max - Math.sqrt((1 - u) * (max - min) * (max - mode));
  return Math.round(v);
}

// ── Text classifiers (heuristics over the scripted line) ─────────────────────

const stripTags = (s: string) => s.replace(/\[[^\]]*\]/g, '').trim();

/** Scripted cut-off: the turn ends mid-clause on an em/en dash — the next line snaps in. */
const endsCutOff = (t: TimelineTurn) => /[—–]\s*["']?\s*$/.test(t.text);

/** Explicit latch: the turn starts on a dash or an interruption tag — fast handoff. */
const startsLatch = (t: TimelineTurn) =>
  /^\s*[—–]/.test(stripTags(t.text)) || /^\s*\[(interrupting|overlapping|cuts in)\]/i.test(t.text);

const isQuestion = (t: TimelineTurn) => /\?\s*["']?\s*$/.test(t.text);
const isWhQuestion = (t: TimelineTurn) =>
  isQuestion(t) && /^(what|how|why|where|when|who|which)\b/i.test(stripTags(t.text));

/** Short confirmation/reaction ("Exactly.", "No way.") — lands fast, right after the line. */
const isShortReaction = (t: TimelineTurn) => {
  const words = stripTags(t.text).split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= 4;
};

/** Dispreferred opener — disagreement/hesitation. The long pause before it carries meaning. */
const isDispreferred = (t: TimelineTurn) =>
  /^(well|hmm+|uh+|um+|i mean|i don't know|okay,? but|but wait|see,|honestly)\b/i.test(stripTags(t.text)) ||
  /^\s*\[(sighs|hesitates|exhales)\]/i.test(t.text);

const hasLaugh = (t: TimelineTurn) => /\[(laughs|laughs harder|chuckles|giggles|snorts)\]/i.test(t.text);

/**
 * True murmur: non-lexical (or near-non-lexical) listener noise that stays
 * intelligible UNDER speech. Anything with real words is not a murmur and must
 * not play in parallel with the other host.
 */
const MURMUR_RE = /^(mm+-?hm+m*|mm+m*|hm+m*|uh-?huh|huh|whoa+|wow|oh+|ooh+|ah+|yeah|right|ha(ha)*)[.!?…—-]*$/i;
export function isMurmurText(text: string): boolean {
  const clean = stripTags(text).toLowerCase();
  if (!clean) return /\[(laughs|laughs harder|chuckles|giggles|snorts|gasps|exhales|sighs|breathes)\]/i.test(text);
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length > 2) return false;
  return words.every((w) => MURMUR_RE.test(w)) || MURMUR_RE.test(clean.replace(/\s+/g, ''));
}

/** Floor-transfer offset (speech-to-speech) for prev → next. Always ≥ 0 in file terms after clamping. */
function ftoFor(prev: TimelineTurn, next: TimelineTurn): number {
  if (endsCutOff(prev)) return tri(100, 140, 210);              // scripted cut-off — snaps in, never simultaneous
  if (startsLatch(next)) return tri(110, 150, 230);             // latch — immediate pickup
  if (prev.speaker === next.speaker) return tri(150, 250, 400); // same-speaker sentence join (SLOWER than exchange)
  if (prev.beat !== next.beat) return tri(600, 900, 1250);      // beat/topic bridge — a real breath
  if (isDispreferred(next)) return tri(600, 850, 1200);         // disagreement arrives late; the delay is the meaning
  if (hasLaugh(prev) || hasLaugh(next)) return tri(110, 170, 280); // laughter pulls turns together
  if (isQuestion(prev)) {
    return isWhQuestion(prev) ? tri(150, 280, 500) : tri(90, 180, 300); // answers take thinking time
  }
  if (isShortReaction(next)) return tri(90, 140, 260);          // quick reactions land right on the tail
  // Normal exchange — a skewed MIXTURE, not a band: mostly the ~200ms mode,
  // sometimes a longer thinking gap. Variance is the realism.
  return Math.random() < 0.75 ? tri(90, 200, 330) : tri(300, 420, 700);
}

function gapFor(prev: TimelineTurn, next: TimelineTurn): number {
  if (prev.pauseAfterMs != null) return prev.pauseAfterMs;      // editor decision — verbatim
  const gap = Math.round(ftoFor(prev, next) * GAP_PACE) - EDGE_COMPENSATION_MS;
  return Math.min(Math.max(gap, MIN_SEQ_GAP_MS), MAX_GAP_MS);
}

export function buildTimeline(turns: TimelineTurn[]): TimelineResult {
  const placements: Placement[] = [];
  let mainEnd = 0;
  let prevStart = 0;
  let firstSeq = true;
  let prevSeq: TimelineTurn | null = null;
  let overlapFloor = 0;                                    // next seq start must clear this
  let lastMurmur: { speaker: 'teacher' | 'learner'; end: number } | null = null;
  let maxEnd = 0;

  for (const t of turns) {
    // Only true non-lexical murmurs may ride on top of a line — and only short
    // ones. A worded/long "reaction" is demoted to a sequential turn below.
    if (t.overlap && prevSeq && isMurmurText(t.text) && t.durationMs <= MAX_MURMUR_MS) {
      // Ride the TAIL of the previous line (its last stretch), ducked, and never
      // spill more than ~250ms past its end.
      const prevDur = prevSeq.durationMs;
      const rel = tri(65, 78, 88) / 100;
      let start = Math.round(prevStart + rel * prevDur);
      start = Math.max(start, prevStart + 200);
      const spill = start + t.durationMs - mainEnd;
      if (spill > 250) start = Math.max(prevStart + 200, mainEnd + 250 - t.durationMs);
      const end = start + t.durationMs;
      placements.push({ turnId: t.turnId, delayMs: start, gainDb: MURMUR_DUCK_DB });
      overlapFloor = Math.max(overlapFloor, end - 120);   // next line may start just under the murmur tail
      lastMurmur = { speaker: t.speaker, end };
      maxEnd = Math.max(maxEnd, end);
      continue;
    }

    let start: number;
    if (firstSeq) {
      start = 0;
      firstSeq = false;
    } else {
      // Demoted reactions (worded overlap:true turns) land fast but sequentially.
      const gap = t.overlap
        ? Math.max(Math.round(tri(60, 110, 200) * GAP_PACE) - EDGE_COMPENSATION_MS, MIN_SEQ_GAP_MS)
        : gapFor(prevSeq!, t);
      start = mainEnd + gap;
      start = Math.max(start, overlapFloor);
      if (lastMurmur && lastMurmur.speaker === t.speaker) {
        start = Math.max(start, lastMurmur.end + 120);    // a voice can't overlap itself
      }
      start = Math.max(0, start);
    }
    placements.push({ turnId: t.turnId, delayMs: start });
    prevStart = start;
    mainEnd = start + t.durationMs;
    maxEnd = Math.max(maxEnd, mainEnd);
    prevSeq = t;
    lastMurmur = null;
    overlapFloor = 0;
  }

  return { placements, totalMs: maxEnd };
}
