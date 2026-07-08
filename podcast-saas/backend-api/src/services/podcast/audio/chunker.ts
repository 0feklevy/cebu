/**
 * Chunk a script into ElevenLabs dialogue requests — one chunk per beat (so an
 * edit invalidates exactly one beat's cache, never reflows everything). Each chunk
 * carries the last 1–2 turns of the previous chunk as CONTEXT inputs (their audio
 * is discarded after synthesis) so v3 doesn't render a cold opening line flat.
 *
 * overlap:true turns (backchannels) are EXCLUDED here — they're synthesized
 * separately as reusable 1-input clips and overlaid by the stitcher.
 */

import { createHash } from 'crypto';
import type { PodcastTurn } from 'shared';
import type { DialogueInput } from './ElevenLabsDialogue.js';

const MAX_CHUNK_CHARS = 1500;   // per-beat real-turn budget
const MAX_TOTAL_CHARS = 1850;   // hard ceiling for real+context inputs (margin under the 2,000 cap)
const CONTEXT_TURNS = 2;

export interface Chunk {
  beat: string;
  inputs: DialogueInput[];      // [context…, real…]
  contextCount: number;         // leading inputs whose audio is discarded
  turnIds: string[];            // ids of the REAL (non-context) turns, in order
  hash: string;                 // sha256 of the exact request payload
}

export interface BackchannelJob {
  turnId: string;
  /** [context?, backchannel] — context audio (if any) is discarded after synthesis. */
  inputs: DialogueInput[];
  contextCount: number;
  hash: string;                 // reusable across the show for identical (voice,text,context)
}

export interface ChunkPlan {
  chunks: Chunk[];
  backchannels: BackchannelJob[];
}

function payloadHash(obj: unknown): string {
  return createHash('sha256').update(JSON.stringify(obj)).digest('hex');
}

/** Last full sentence(s) of a line, capped at maxChars — prosody context for a backchannel. */
function sentenceTail(text: string, maxChars: number): string {
  const clean = text.trim();
  if (clean.length <= maxChars) return clean;
  const tail = clean.slice(-maxChars);
  const cut = Math.max(tail.indexOf('. '), tail.indexOf('? '), tail.indexOf('! '));
  return (cut >= 0 ? tail.slice(cut + 2) : tail).trim();
}

/**
 * Text as sent to the voice engine. A scripted cut-off ends on an em-dash, but v3
 * occasionally STUTTERS (repeats a syllable) when asked to render a hard mid-clause
 * stop — so for synthesis the trailing dash becomes an ellipsis (a natural trail-off,
 * no stutter). The interruption illusion comes from the stitcher's timing anyway.
 * The script/editor text keeps the dash.
 */
function ttsText(text: string): string {
  return text.replace(/\s*[—–]\s*(["']?)\s*$/, '…$1');
}

export function planChunks(
  turns: PodcastTurn[],
  voiceFor: (speaker: 'teacher' | 'learner') => string,
  opts: { seed?: number; languageCode?: string; outputFormat: string; stability: number },
): ChunkPlan {
  const chunks: Chunk[] = [];
  const backchannels: BackchannelJob[] = [];

  // Drop blank lines (e.g. a freshly-inserted turn the user never filled in) — an
  // empty text would produce an empty ElevenLabs input and break synthesis. A
  // tag-only line like "[laughs]" is a valid non-verbal input, so trim-check only.
  const audible = turns.filter((t) => t.text.trim().length > 0);

  // Sequential (non-overlap) turns become the chunk stream; overlaps go aside.
  // Each backchannel gets a short CONTEXT input (the tail of the line it rides) so
  // v3 delivers the reaction in the conversation's energy — a bare 2-word input is
  // documented to render unstable/flat. Context audio is cut away after synthesis.
  const seq: PodcastTurn[] = [];
  let lastSeq: PodcastTurn | null = null;
  for (const t of audible) {
    if (t.overlap) {
      const bcInput = { text: ttsText(t.text), voice_id: voiceFor(t.speaker) };
      const ctxTail = lastSeq ? sentenceTail(ttsText(lastSeq.text), 160) : '';
      const inputs: DialogueInput[] = ctxTail
        ? [{ text: ctxTail, voice_id: voiceFor(lastSeq!.speaker) }, bcInput]
        : [bcInput];
      const contextCount = inputs.length - 1;
      backchannels.push({
        turnId: t.id, inputs, contextCount,
        hash: payloadHash({ inputs, contextCount, seed: opts.seed, model: 'eleven_v3', stability: opts.stability, lang: opts.languageCode, fmt: opts.outputFormat }),
      });
    } else {
      seq.push(t);
      lastSeq = t;
    }
  }

  // Group by beat, splitting an oversized beat at turn boundaries within the beat —
  // but NEVER between a scripted cut-off ("…—") and the line that interrupts it:
  // that pair must share a request so v3 performs the interruption as one moment.
  const groups: PodcastTurn[][] = [];
  let cur: PodcastTurn[] = [];
  let curBeat: string | null = null;
  let curChars = 0;
  const prevEndsCutOff = () => cur.length > 0 && /[—–]\s*["']?\s*$/.test(cur[cur.length - 1].text);
  for (const t of seq) {
    const same = t.beat === curBeat;
    const mustStayTogether = prevEndsCutOff();
    if ((!same || curChars + t.text.length > MAX_CHUNK_CHARS) && !mustStayTogether) {
      if (cur.length) groups.push(cur);
      cur = [];
      curChars = 0;
      curBeat = t.beat;
    }
    cur.push(t);
    curChars += t.text.length;
  }
  if (cur.length) groups.push(cur);

  // Build chunks with context prepended from the tail of the previous group.
  for (let g = 0; g < groups.length; g++) {
    const group = groups[g];
    const groupChars = group.reduce((n, t) => n + t.text.length, 0);
    // Fit as many trailing context turns (nearest first) as stay under the total cap,
    // so real + context never exceeds MAX_TOTAL_CHARS (and thus the 2,000-char API cap).
    const context: PodcastTurn[] = [];
    if (g > 0) {
      let budget = MAX_TOTAL_CHARS - groupChars;
      const candidates = groups[g - 1].slice(-CONTEXT_TURNS);
      for (let i = candidates.length - 1; i >= 0; i--) {
        const len = candidates[i].text.length;
        if (len > budget) break;
        budget -= len;
        context.unshift(candidates[i]);
      }
    }
    const inputs: DialogueInput[] = [
      ...context.map((t) => ({ text: ttsText(t.text), voice_id: voiceFor(t.speaker) })),
      ...group.map((t) => ({ text: ttsText(t.text), voice_id: voiceFor(t.speaker) })),
    ];
    const hash = payloadHash({
      inputs, contextCount: context.length, seed: opts.seed, model: 'eleven_v3',
      stability: opts.stability, lang: opts.languageCode, fmt: opts.outputFormat,
    });
    chunks.push({ beat: group[0].beat, inputs, contextCount: context.length, turnIds: group.map((t) => t.id), hash });
  }

  return { chunks, backchannels };
}
