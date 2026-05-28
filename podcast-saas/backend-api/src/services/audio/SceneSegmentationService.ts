import type { Script, DialogueTurn, AlignedWord } from 'shared';
import type { MasterAlignment } from './ForcedAlignmentService.js';

export interface RawScene {
  idx: number;
  speaker: 'host_a' | 'host_b';
  start_ms: number;
  end_ms: number;
  transcript: string;
  aligned_words: AlignedWord[];
  emotion: string;
  audio_tags: string[];
  is_hook: boolean;
}

const MIN_SCENE_MS = 4_000;
const MAX_SCENE_MS = 9_000;
const TARGET_MIN_MS = 5_000;
const TARGET_MAX_MS = 8_000;
const SENTENCE_END = /[.?!]+$/;
const ALIGNMENT_GAP_MS = 250;

export class SceneSegmentationService {
  segment(script: Script, alignment: MasterAlignment, totalDurationMs: number): RawScene[] {
    // Build turn time ranges from word alignment
    const turnRanges = this.computeTurnRanges(script.turns, alignment, totalDurationMs);

    // Step 1: one scene per turn
    const turnScenes: RawScene[] = script.turns.map((turn, i) => ({
      idx: i,
      speaker: turn.speaker,
      start_ms: turnRanges[i].start,
      end_ms: turnRanges[i].end,
      transcript: turn.text,
      aligned_words: alignment.words.filter((w) => w.turn_index === i),
      emotion: turn.emotion,
      audio_tags: turn.audio_tags as string[],
      is_hook: turn.is_hook,
    }));

    // Step 2: split long turns (>MAX_SCENE_MS) at sentence boundaries
    const split = this.splitLongScenes(turnScenes);

    // Step 3: merge short scenes (<MIN_SCENE_MS) with neighbors
    const merged = this.mergeShortScenes(split);

    // Step 4: re-index
    return merged.map((s, i) => ({ ...s, idx: i }));
  }

  private computeTurnRanges(
    turns: DialogueTurn[],
    alignment: MasterAlignment,
    totalDurationMs: number,
  ): Array<{ start: number; end: number }> {
    const ranges: Array<{ start: number; end: number }> = [];

    for (let i = 0; i < turns.length; i++) {
      const turnWords = alignment.words.filter((w) => w.turn_index === i);
      if (turnWords.length === 0) {
        // No alignment for this turn — estimate from position
        const prevEnd = ranges[i - 1]?.end ?? 0;
        const wordCount = turns[i].text.split(/\s+/).length;
        const estDuration = Math.round((wordCount / 130) * 60 * 1000);
        ranges.push({ start: prevEnd, end: prevEnd + estDuration });
      } else {
        ranges.push({
          start: turnWords[0].start_ms,
          end: turnWords[turnWords.length - 1].end_ms,
        });
      }
    }

    // Clamp last turn to total duration
    if (ranges.length > 0 && totalDurationMs > 0) {
      ranges[ranges.length - 1].end = Math.min(
        ranges[ranges.length - 1].end,
        totalDurationMs,
      );
    }

    return ranges;
  }

  private splitLongScenes(scenes: RawScene[]): RawScene[] {
    const result: RawScene[] = [];

    for (const scene of scenes) {
      const duration = scene.end_ms - scene.start_ms;
      if (duration <= MAX_SCENE_MS || scene.aligned_words.length < 4) {
        result.push(scene);
        continue;
      }

      // Find split points: sentence-ending words followed by alignment gap ≥250ms
      const splitPoints: number[] = [];
      for (let i = 0; i < scene.aligned_words.length - 1; i++) {
        const word = scene.aligned_words[i];
        const nextWord = scene.aligned_words[i + 1];
        const gap = nextWord.start_ms - word.end_ms;
        if (SENTENCE_END.test(word.word) && gap >= ALIGNMENT_GAP_MS) {
          splitPoints.push(word.end_ms);
        }
      }

      if (splitPoints.length === 0) {
        result.push(scene);
        continue;
      }

      // Choose split points that keep chunks near TARGET range
      const splits = this.chooseSplits(scene.start_ms, scene.end_ms, splitPoints);
      const boundaries = [scene.start_ms, ...splits, scene.end_ms];

      for (let k = 0; k < boundaries.length - 1; k++) {
        const segStart = boundaries[k];
        const segEnd = boundaries[k + 1];
        const segWords = scene.aligned_words.filter(
          (w) => w.start_ms >= segStart && w.end_ms <= segEnd,
        );
        const segText = segWords.map((w) => w.word).join(' ') || scene.transcript;

        result.push({
          ...scene,
          start_ms: segStart,
          end_ms: segEnd,
          transcript: segText,
          aligned_words: segWords,
          is_hook: k === 0 && scene.is_hook,
        });
      }
    }

    return result;
  }

  private chooseSplits(
    start: number,
    end: number,
    candidates: number[],
  ): number[] {
    const chosen: number[] = [];
    let cursor = start;

    for (const pt of candidates) {
      if (pt - cursor >= TARGET_MIN_MS) {
        if (end - pt >= TARGET_MIN_MS) {
          chosen.push(pt);
          cursor = pt;
        }
      }
    }

    return chosen;
  }

  private mergeShortScenes(scenes: RawScene[]): RawScene[] {
    if (scenes.length <= 1) return scenes;
    const result: RawScene[] = [...scenes];
    let changed = true;

    while (changed) {
      changed = false;
      for (let i = 0; i < result.length; i++) {
        const scene = result[i];
        if (scene.end_ms - scene.start_ms >= MIN_SCENE_MS) continue;

        // Merge with shorter neighbor (prefer same speaker)
        const prevDur = i > 0 ? result[i - 1].end_ms - result[i - 1].start_ms : Infinity;
        const nextDur = i < result.length - 1 ? result[i + 1].end_ms - result[i + 1].start_ms : Infinity;

        let target: number;
        if (prevDur <= nextDur && i > 0) {
          target = i - 1;
        } else if (i < result.length - 1) {
          target = i + 1;
        } else {
          continue;
        }

        const a = target < i ? result[target] : result[i];
        const b = target < i ? result[i] : result[target];

        const merged: RawScene = {
          ...a,
          end_ms: b.end_ms,
          transcript: `${a.transcript} ${b.transcript}`.trim(),
          aligned_words: [...a.aligned_words, ...b.aligned_words],
          is_hook: a.is_hook || b.is_hook,
        };

        result.splice(Math.min(i, target), 2, merged);
        changed = true;
        break;
      }
    }

    return result;
  }
}
