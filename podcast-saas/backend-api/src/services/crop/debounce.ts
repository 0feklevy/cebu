/**
 * Speaker-continuity debounce for two-shot crop switching.
 *
 * A new speaker must hold the floor for MIN_SPEAKER_DURATION of continuous
 * speech before the crop commits to their face — brief interjections (< 1 s) are
 * suppressed so the framing doesn't ping-pong. Direct port of the Python state
 * machine.
 */

import type { SpeakerLabel } from './speaker.js';

const MIN_SPEAKER_DURATION = 1.0; // s of continuous speech before a switch commits
const SILENCE_HOLD = 1.5;         // s of silence before the active speaker resets

export class DebounceState {
  currentSpeaker: SpeakerLabel | null = null;
  currentFaceX: number | null = null;
  pendingSpeaker: SpeakerLabel | null = null;
  pendingSince = 0;
  lastSpeechT = -999;
}

/**
 * Mutates `state` and returns the committed crop target (or null if no speaker
 * has committed yet).
 */
export function applyDebounce(
  state: DebounceState,
  speaker: SpeakerLabel,
  t: number,
  faceXCandidate: number | null,
): number | null {
  if (speaker === 'silence') {
    if (t - state.lastSpeechT > SILENCE_HOLD) {
      state.currentSpeaker = null;
      state.pendingSpeaker = null;
    }
    return state.currentFaceX;
  }

  if (speaker === 'unclear') {
    return state.currentFaceX; // ambiguous — hold, don't reset silence timer
  }

  // Active speaker ('male' | 'female')
  state.lastSpeechT = t;

  if (state.currentSpeaker === null) {
    state.currentSpeaker = speaker;
    state.currentFaceX = faceXCandidate;
    state.pendingSpeaker = null;
    return state.currentFaceX;
  }

  if (speaker === state.currentSpeaker) {
    state.pendingSpeaker = null;
    if (faceXCandidate !== null) state.currentFaceX = faceXCandidate;
    return state.currentFaceX;
  }

  // Different speaker — build up a pending switch.
  if (speaker === state.pendingSpeaker) {
    if (t - state.pendingSince >= MIN_SPEAKER_DURATION) {
      state.currentSpeaker = speaker;
      state.currentFaceX = faceXCandidate;
      state.pendingSpeaker = null;
    }
  } else {
    state.pendingSpeaker = speaker;
    state.pendingSince = t;
  }

  return state.currentFaceX;
}
