/**
 * The hands-free voice loop — a PURE state machine (night run 2026-09-03 §4).
 *
 * The listener is driving. The loop's whole contract is one sentence: when they speak, the
 * episode pauses and listens; when they stop, the question is answered aloud; after a few seconds
 * of silence the episode resumes exactly where it paused. Everything that touches a device — the
 * microphone, the two audio elements, timers, the network — is an EFFECT this reducer emits and
 * the hook executes, so every transition here is a unit test rather than a road test.
 *
 * States
 *   off        hands-free is disabled; the Ask button still works as push-to-talk
 *   idle       armed — the VAD is listening, the episode plays (or is paused by the listener)
 *   listening  speech detected (or Ask tapped): episode paused, capturing until silence
 *   thinking   the utterance is on its way to the server
 *   speaking   the answer is playing
 *   resuming   answer over; a short silence window, then the episode continues
 */

/** Where an exchange goes back to when it is over: armed ('idle') or hands-free off ('off'). */
export type Home = 'off' | 'idle';

export type VoiceState =
  | { kind: 'off' }
  | { kind: 'idle' }
  | { kind: 'listening'; wasPlaying: boolean; manual: boolean; home: Home }
  | { kind: 'thinking'; wasPlaying: boolean; home: Home }
  | { kind: 'speaking'; wasPlaying: boolean; text: string | null; home: Home }
  | { kind: 'resuming'; wasPlaying: boolean; note: string | null; home: Home };

export type VoiceEvent =
  | { type: 'ENABLE' }
  | { type: 'DISABLE' }
  /** The VAD heard speech begin. `playing` is whether the episode was playing at that instant. */
  | { type: 'SPEECH_START'; playing: boolean }
  /** The VAD heard speech end and hands over the utterance. */
  | { type: 'SPEECH_END'; audio: Float32Array }
  /** The VAD decided it was not speech after all. */
  | { type: 'MISFIRE' }
  /** The Ask button: start listening now, end a manual capture, or stop an answer. */
  | { type: 'ASK_TAP'; playing: boolean }
  | { type: 'ANSWER'; text: string | null; hasAudio: boolean; note: string | null }
  | { type: 'ANSWER_FAILED'; note: string }
  | { type: 'SPEAKING_ENDED' }
  | { type: 'RESUME_TIMER_DONE' }
  /** The Stop button: everything off, the episode stays paused. */
  | { type: 'STOP' };

export type VoiceEffect =
  | { type: 'PAUSE_PLAYBACK' }
  | { type: 'RESUME_PLAYBACK' }
  | { type: 'PLAY_EARCON' }
  | { type: 'START_CAPTURE' }
  | { type: 'END_CAPTURE' }
  | { type: 'SUBMIT'; audio: Float32Array }
  | { type: 'PLAY_ANSWER' }
  | { type: 'STOP_ANSWER' }
  | { type: 'START_RESUME_TIMER'; ms: number }
  | { type: 'CANCEL_RESUME_TIMER' }
  | { type: 'NOTE'; text: string };

/** How long the silence after an answer lasts before the episode continues. */
export const RESUME_AFTER_MS = 3000;

export interface Transition { state: VoiceState; effects: VoiceEffect[] }

export const INITIAL_VOICE_STATE: VoiceState = { kind: 'off' };

export function reduceVoice(state: VoiceState, event: VoiceEvent): Transition {
  const same: Transition = { state, effects: [] };

  switch (event.type) {
    case 'ENABLE':
      return state.kind === 'off' ? { state: { kind: 'idle' }, effects: [] } : same;

    case 'DISABLE':
    case 'STOP': {
      // Everything off. The episode is left PAUSED on STOP (that is what stop means) and left
      // alone on DISABLE unless a capture or an answer was mid-flight, in which case it resumes
      // — the listener turned off hands-free, not the episode.
      const effects: VoiceEffect[] = [];
      if (state.kind === 'listening') effects.push({ type: 'END_CAPTURE' });
      if (state.kind === 'speaking') effects.push({ type: 'STOP_ANSWER' });
      if (state.kind === 'resuming') effects.push({ type: 'CANCEL_RESUME_TIMER' });
      if (event.type === 'DISABLE' && (state.kind === 'listening' || state.kind === 'thinking' || state.kind === 'speaking' || state.kind === 'resuming') && state.wasPlaying) {
        effects.push({ type: 'RESUME_PLAYBACK' });
      }
      if (event.type === 'STOP' && state.kind === 'idle') effects.push({ type: 'PAUSE_PLAYBACK' });
      return { state: { kind: 'off' }, effects };
    }

    case 'SPEECH_START': {
      if (state.kind === 'idle') {
        return {
          state: { kind: 'listening', wasPlaying: event.playing, manual: false, home: 'idle' },
          effects: [{ type: 'PAUSE_PLAYBACK' }, { type: 'PLAY_EARCON' }, { type: 'START_CAPTURE' }],
        };
      }
      // Barge-in: speaking over the answer stops it and starts a new question.
      if (state.kind === 'speaking') {
        return {
          state: { kind: 'listening', wasPlaying: state.wasPlaying, manual: false, home: state.home },
          effects: [{ type: 'STOP_ANSWER' }, { type: 'START_CAPTURE' }],
        };
      }
      // Speaking during the silence window is a follow-up: the episode does NOT resume yet.
      if (state.kind === 'resuming') {
        return {
          state: { kind: 'listening', wasPlaying: state.wasPlaying, manual: false, home: state.home },
          effects: [{ type: 'CANCEL_RESUME_TIMER' }, { type: 'START_CAPTURE' }],
        };
      }
      return same;   // off, thinking, or already listening
    }

    case 'SPEECH_END':
      if (state.kind !== 'listening') return same;
      return {
        state: { kind: 'thinking', wasPlaying: state.wasPlaying, home: state.home },
        effects: [{ type: 'END_CAPTURE' }, { type: 'SUBMIT', audio: event.audio }],
      };

    case 'MISFIRE':
      // Not speech after all (a door, the road). Straight back to the episode, no answer window.
      // A MANUAL capture that ended with nothing says so — the listener pressed the button.
      if (state.kind !== 'listening') return same;
      return {
        state: { kind: state.home },
        effects: [
          { type: 'END_CAPTURE' },
          ...(state.manual ? [{ type: 'NOTE', text: 'Didn’t catch that.' } as const] : []),
          ...(state.wasPlaying ? [{ type: 'RESUME_PLAYBACK' } as const] : []),
        ],
      };

    case 'ASK_TAP': {
      switch (state.kind) {
        case 'off':
        case 'idle':
          // Push-to-talk: works with hands-free off, and while it is on, for a noisy car.
          return {
            state: { kind: 'listening', wasPlaying: event.playing, manual: true, home: state.kind },
            effects: [{ type: 'PAUSE_PLAYBACK' }, { type: 'PLAY_EARCON' }, { type: 'START_CAPTURE' }],
          };
        case 'listening':
          // A second tap ends a manual capture: "I'm done talking". The VAD's SPEECH_END will
          // still arrive with the audio; nothing to do here but signal the capture to close.
          return state.manual ? { state, effects: [{ type: 'END_CAPTURE' }] } : same;
        case 'speaking':
          // Tapping during an answer means "enough": stop it and go straight to resuming.
          return {
            state: { kind: 'resuming', wasPlaying: state.wasPlaying, note: null, home: state.home },
            effects: [{ type: 'STOP_ANSWER' }, { type: 'START_RESUME_TIMER', ms: RESUME_AFTER_MS }],
          };
        case 'resuming':
          // Tapping during the silence window means "continue now".
          return {
            state: { kind: state.home },
            effects: [{ type: 'CANCEL_RESUME_TIMER' }, ...(state.wasPlaying ? [{ type: 'RESUME_PLAYBACK' } as const] : [])],
          };
        default:
          return same;   // thinking: nothing to interrupt yet
      }
    }

    case 'ANSWER': {
      if (state.kind !== 'thinking') return same;
      if (event.hasAudio || event.text) {
        return {
          state: { kind: 'speaking', wasPlaying: state.wasPlaying, text: event.text, home: state.home },
          effects: [{ type: 'PLAY_ANSWER' }],
        };
      }
      // Nothing to say (nothing heard, or saved for the creator): a note, then the episode goes on.
      return {
        state: { kind: 'resuming', wasPlaying: state.wasPlaying, note: event.note, home: state.home },
        effects: [...(event.note ? [{ type: 'NOTE', text: event.note } as const] : []), { type: 'START_RESUME_TIMER', ms: RESUME_AFTER_MS }],
      };
    }

    case 'ANSWER_FAILED':
      if (state.kind !== 'thinking') return same;
      return {
        state: { kind: 'resuming', wasPlaying: state.wasPlaying, note: event.note, home: state.home },
        effects: [{ type: 'NOTE', text: event.note }, { type: 'START_RESUME_TIMER', ms: RESUME_AFTER_MS }],
      };

    case 'SPEAKING_ENDED':
      if (state.kind !== 'speaking') return same;
      return {
        state: { kind: 'resuming', wasPlaying: state.wasPlaying, note: null, home: state.home },
        effects: [{ type: 'START_RESUME_TIMER', ms: RESUME_AFTER_MS }],
      };

    case 'RESUME_TIMER_DONE':
      if (state.kind !== 'resuming') return same;
      return {
        state: { kind: state.home },
        effects: state.wasPlaying ? [{ type: 'RESUME_PLAYBACK' }] : [],
      };

    default:
      return same;
  }
}

/** One glanceable word per state, for the ring under the Ask button. */
export function voiceStatusLabel(state: VoiceState): string {
  switch (state.kind) {
    case 'off': return 'Tap to ask';
    case 'idle': return 'Listening';
    case 'listening': return 'Go ahead';
    case 'thinking': return 'Thinking';
    case 'speaking': return 'Answering';
    case 'resuming': return 'Resuming';
  }
}
