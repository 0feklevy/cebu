/**
 * Turn a stream of model tokens into a stream of SENTENCES — the unit the voice answer is
 * synthesised and played in (owner ruling 2026-09-03: Tap to ask like NotebookLM's interrupt).
 *
 * The whole point of the interactive mode is that the listener hears the first sentence while the
 * model is still writing the third, so latency is one sentence's worth of model + one sentence's
 * worth of speech, not the whole answer's. This splitter is pure and boundary-aware: a sentence
 * ends at . ! ? … (or a newline) followed by whitespace or the end, never inside "e.g." or "3.5",
 * and a fragment shorter than `minChars` waits for the next boundary so the voice does not chirp
 * two-word clips.
 */
export interface SentenceSplitterOptions {
  /** A boundary before this many characters is kept for the next sentence. */
  minChars?: number;
  /** A run longer than this with no boundary is emitted anyway (a model that never punctuates). */
  maxChars?: number;
  /** Lower boundary floor for the FIRST sentence only — gets audio out sooner. Default: minChars. */
  firstMinChars?: number;
}

const BOUNDARY = /([.!?…]+)(?=\s|$)|\n+/g;
const ABBREVIATION = /(?:^|\s)(?:e\.g|i\.e|etc|vs|mr|mrs|dr|prof|no)\.$/i;

export class SentenceSplitter {
  private buffer = '';
  private emitted = 0;
  private readonly minChars: number;
  private readonly maxChars: number;
  private readonly firstMinChars: number;

  constructor(opts: SentenceSplitterOptions = {}) {
    this.minChars = opts.minChars ?? 24;
    this.maxChars = opts.maxChars ?? 320;
    // The FIRST sentence may cut earlier than the rest: on the voice path it is what the
    // listener waits on (record end → first audible word), and a short opener like "Yes." or
    // "Good question." reaching TTS 200ms sooner is worth more than a longer first clause.
    this.firstMinChars = opts.firstMinChars ?? this.minChars;
  }

  /** Feed a token; returns the sentences that became complete. */
  push(delta: string): string[] {
    this.buffer += delta;
    const out: string[] = [];
    for (;;) {
      const cut = this.nextBoundary();
      if (cut === null) break;
      const sentence = this.buffer.slice(0, cut).trim();
      this.buffer = this.buffer.slice(cut);
      if (sentence) { out.push(sentence); this.emitted += 1; }
    }
    while (this.buffer.length >= this.maxChars) {
      const at = this.buffer.lastIndexOf(' ', this.maxChars);
      const cut = at > this.minChars ? at : this.maxChars;
      const chunk = this.buffer.slice(0, cut).trim();
      this.buffer = this.buffer.slice(cut);
      if (chunk) out.push(chunk);
    }
    return out;
  }

  /** The end of the stream: whatever is left is the last sentence. */
  flush(): string[] {
    const rest = this.buffer.trim();
    this.buffer = '';
    return rest ? [rest] : [];
  }

  private nextBoundary(): number | null {
    BOUNDARY.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = BOUNDARY.exec(this.buffer)) !== null) {
      const end = m.index + m[0].length;
      // A boundary at the very end of the buffer may still be mid-token ("3." then "5"): wait
      // for something after it unless it is a newline.
      if (end >= this.buffer.length && !m[0].includes('\n')) return null;
      const head = this.buffer.slice(0, end);
      if (m[0].startsWith('.') && (ABBREVIATION.test(head.trimEnd()) || /\d\.$/.test(head))) continue;
      if (head.trim().length < (this.emitted === 0 ? this.firstMinChars : this.minChars)) continue;
      // A lowercase word after the mark continues the thought — "Well… maybe not." is ONE
      // spoken sentence, and cutting there would put a synthesis seam mid-phrase. Newlines end a
      // line whatever follows.
      if (!m[0].includes('\n') && /^\s*\p{Ll}/u.test(this.buffer.slice(end))) continue;
      return end;
    }
    return null;
  }
}

/** Split a finished text the same way — for the non-streaming path and for tests. */
export function splitSentences(text: string, opts?: SentenceSplitterOptions): string[] {
  const s = new SentenceSplitter(opts);
  return [...s.push(text), ...s.flush()];
}
