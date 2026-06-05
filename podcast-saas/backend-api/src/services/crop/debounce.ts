/**
 * Speaker-continuity debounce for two-shot crop switching.
 *
 * A new speaker must hold the floor for MIN_SPEAKER_DURATION before the crop
 * commits to their face — brief interjections are suppressed so the framing
 * doesn't ping-pong. The "speaker" is a free-form identity key: it can be a
 * gender ('male'/'female') or a head-region id ('region0'/'region1'). Two special
 * keys are handled distinctly:
 *   • 'silence' — hold the last crop, reset the active speaker after a long pause.
 *   • 'unclear' — hold the crop, don't touch the silence timer.
 */

const MIN_SPEAKER_DURATION = 0.8; // s of continuous speech before a switch commits
const SILENCE_HOLD = 1.5;         // s of silence before the active speaker resets

export class DebounceState {
  currentSpeaker: string | null = null;
  currentFaceX: number | null = null;
  pendingSpeaker: string | null = null;
  pendingSince = 0;
  lastSpeechT = -999;
}

/**
 * Mutates `state` and returns the committed crop target (or null if no speaker
 * has committed yet).
 */
export function applyDebounce(
  state: DebounceState,
  speaker: string,
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

  // Active speaker (gender or region id)
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
