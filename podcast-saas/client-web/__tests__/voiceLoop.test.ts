/**
 * The hands-free loop, transition by transition. Every rule the car-mode design states is a case
 * here, and each case names the effects the hook must execute — so a regression shows up as a
 * red line naming the rule rather than as a listener who spoke and was ignored on a motorway.
 */
import { describe, it, expect } from 'vitest';
import {
  INITIAL_VOICE_STATE, RESUME_AFTER_MS, reduceVoice, voiceStatusLabel,
  type VoiceEvent, type VoiceState,
} from '../lib/voiceLoop';

const audio = new Float32Array(16000);
const run = (start: VoiceState, ...events: VoiceEvent[]) => {
  let state = start;
  const effects: string[] = [];
  for (const e of events) {
    const t = reduceVoice(state, e);
    state = t.state;
    effects.push(...t.effects.map((x) => x.type));
  }
  return { state, effects };
};

describe('the speak → pause → answer → resume loop', () => {
  it('speech while playing pauses the episode, plays the earcon and captures', () => {
    const { state, effects } = run({ kind: 'idle' }, { type: 'SPEECH_START', playing: true });
    expect(state).toEqual({ kind: 'listening', wasPlaying: true, manual: false, home: 'idle' });
    expect(effects).toEqual(['PAUSE_PLAYBACK', 'PLAY_EARCON', 'START_CAPTURE']);
  });

  it('end of speech submits the utterance and waits', () => {
    const { state, effects } = run({ kind: 'listening', wasPlaying: true, manual: false, home: 'idle' }, { type: 'SPEECH_END', audio });
    expect(state).toEqual({ kind: 'thinking', wasPlaying: true, home: 'idle' });
    expect(effects).toEqual(['END_CAPTURE', 'SUBMIT']);
  });

  it('an answer with audio is spoken; when it ends the silence window starts; when that ends the episode resumes', () => {
    const { state, effects } = run(
      { kind: 'thinking', wasPlaying: true, home: 'idle' },
      { type: 'ANSWER', text: 'Because.', hasAudio: true, note: null },
      { type: 'SPEAKING_ENDED' },
      { type: 'RESUME_TIMER_DONE' },
    );
    expect(state).toEqual({ kind: 'idle' });
    expect(effects).toEqual(['PLAY_ANSWER', 'START_RESUME_TIMER', 'RESUME_PLAYBACK']);
  });

  it('the silence window is the ruled three seconds', () => {
    const t = reduceVoice({ kind: 'speaking', wasPlaying: true, text: null, home: 'idle' }, { type: 'SPEAKING_ENDED' });
    expect(t.effects).toEqual([{ type: 'START_RESUME_TIMER', ms: RESUME_AFTER_MS }]);
    expect(RESUME_AFTER_MS).toBe(3000);
  });

  it('never resumes an episode the listener had paused themselves', () => {
    const { state, effects } = run(
      { kind: 'idle' },
      { type: 'SPEECH_START', playing: false },
      { type: 'SPEECH_END', audio },
      { type: 'ANSWER', text: 'x', hasAudio: true, note: null },
      { type: 'SPEAKING_ENDED' },
      { type: 'RESUME_TIMER_DONE' },
    );
    expect(state).toEqual({ kind: 'idle' });
    expect(effects).not.toContain('RESUME_PLAYBACK');
  });
});

describe('barge-in and follow-ups', () => {
  it('speaking over the answer stops it and captures the new question — no earcon, no second pause', () => {
    const t = reduceVoice({ kind: 'speaking', wasPlaying: true, text: 'x', home: 'idle' }, { type: 'SPEECH_START', playing: false });
    expect(t.state).toEqual({ kind: 'listening', wasPlaying: true, manual: false, home: 'idle' });
    expect(t.effects.map((e) => e.type)).toEqual(['STOP_ANSWER', 'START_CAPTURE']);
  });

  it('speaking inside the silence window is a follow-up: the resume is cancelled, the episode stays paused', () => {
    const t = reduceVoice({ kind: 'resuming', wasPlaying: true, note: null, home: 'idle' }, { type: 'SPEECH_START', playing: false });
    expect(t.state).toEqual({ kind: 'listening', wasPlaying: true, manual: false, home: 'idle' });
    expect(t.effects.map((e) => e.type)).toEqual(['CANCEL_RESUME_TIMER', 'START_CAPTURE']);
  });

  it('speech while the server is thinking is ignored rather than queued', () => {
    const t = reduceVoice({ kind: 'thinking', wasPlaying: true, home: 'idle' }, { type: 'SPEECH_START', playing: false });
    expect(t.state).toEqual({ kind: 'thinking', wasPlaying: true, home: 'idle' });
    expect(t.effects).toEqual([]);
  });
});

describe('misfires and empty answers', () => {
  it('a VAD misfire goes straight back to the episode with no answer window', () => {
    const t = reduceVoice({ kind: 'listening', wasPlaying: true, manual: false, home: 'idle' }, { type: 'MISFIRE' });
    expect(t.state).toEqual({ kind: 'idle' });
    expect(t.effects.map((e) => e.type)).toEqual(['END_CAPTURE', 'RESUME_PLAYBACK']);
  });

  it('a misfire on a MANUAL capture says so and goes back to where it started — hands-free stays off', () => {
    const s: VoiceState = { kind: 'listening', wasPlaying: true, manual: true, home: 'off' };
    const t = reduceVoice(s, { type: 'MISFIRE' });
    expect(t.state).toEqual({ kind: 'off' });
    expect(t.effects.map((e) => e.type)).toEqual(['END_CAPTURE', 'NOTE', 'RESUME_PLAYBACK']);
  });

  it('an exchange started from OFF by the Ask button ends back at OFF, not armed', () => {
    const { state, effects } = run(
      INITIAL_VOICE_STATE,
      { type: 'ASK_TAP', playing: true },
      { type: 'SPEECH_END', audio },
      { type: 'ANSWER', text: 'x', hasAudio: true, note: null },
      { type: 'SPEAKING_ENDED' },
      { type: 'RESUME_TIMER_DONE' },
    );
    expect(state).toEqual({ kind: 'off' });
    expect(effects.at(-1)).toBe('RESUME_PLAYBACK');
  });

  it('nothing heard / saved-for-the-creator: the note is shown and the episode resumes after the window', () => {
    const t = reduceVoice({ kind: 'thinking', wasPlaying: true, home: 'idle' }, { type: 'ANSWER', text: null, hasAudio: false, note: 'Saved for the creator.' });
    expect(t.state).toEqual({ kind: 'resuming', wasPlaying: true, note: 'Saved for the creator.', home: 'idle' });
    expect(t.effects).toEqual([{ type: 'NOTE', text: 'Saved for the creator.' }, { type: 'START_RESUME_TIMER', ms: RESUME_AFTER_MS }]);
  });

  it('a failed request never strands the listener: note, then resume', () => {
    const t = reduceVoice({ kind: 'thinking', wasPlaying: true, home: 'idle' }, { type: 'ANSWER_FAILED', note: 'Offline.' });
    expect(t.state.kind).toBe('resuming');
    expect(t.effects.map((e) => e.type)).toEqual(['NOTE', 'START_RESUME_TIMER']);
  });

  it('a text-only answer (TTS failed) is still SPOKEN — the client has its own voice', () => {
    const t = reduceVoice({ kind: 'thinking', wasPlaying: true, home: 'idle' }, { type: 'ANSWER', text: 'Because.', hasAudio: false, note: null });
    expect(t.state).toEqual({ kind: 'speaking', wasPlaying: true, text: 'Because.', home: 'idle' });
    expect(t.effects).toEqual([{ type: 'PLAY_ANSWER' }]);
  });
});

describe('the Ask button', () => {
  it('with hands-free OFF it is push-to-talk: pause, earcon, capture', () => {
    const t = reduceVoice(INITIAL_VOICE_STATE, { type: 'ASK_TAP', playing: true });
    expect(t.state).toEqual({ kind: 'listening', wasPlaying: true, manual: true, home: 'off' });
    expect(t.effects.map((e) => e.type)).toEqual(['PAUSE_PLAYBACK', 'PLAY_EARCON', 'START_CAPTURE']);
  });

  it('a second tap during a manual capture ends it', () => {
    const t = reduceVoice({ kind: 'listening', wasPlaying: true, manual: true, home: 'off' }, { type: 'ASK_TAP', playing: false });
    expect(t.effects).toEqual([{ type: 'END_CAPTURE' }]);
  });

  it('a tap during the answer stops it and starts the resume window', () => {
    const t = reduceVoice({ kind: 'speaking', wasPlaying: true, text: 'x', home: 'idle' }, { type: 'ASK_TAP', playing: false });
    expect(t.state).toEqual({ kind: 'resuming', wasPlaying: true, note: null, home: 'idle' });
    expect(t.effects.map((e) => e.type)).toEqual(['STOP_ANSWER', 'START_RESUME_TIMER']);
  });

  it('a tap during the silence window resumes immediately', () => {
    const t = reduceVoice({ kind: 'resuming', wasPlaying: true, note: null, home: 'idle' }, { type: 'ASK_TAP', playing: false });
    expect(t.state).toEqual({ kind: 'idle' });
    expect(t.effects.map((e) => e.type)).toEqual(['CANCEL_RESUME_TIMER', 'RESUME_PLAYBACK']);
  });
});

describe('enable / disable / stop', () => {
  it('ENABLE arms the loop; DISABLE mid-answer stops the answer and gives the episode back', () => {
    expect(reduceVoice({ kind: 'off' }, { type: 'ENABLE' }).state).toEqual({ kind: 'idle' });
    const t = reduceVoice({ kind: 'speaking', wasPlaying: true, text: 'x', home: 'idle' }, { type: 'DISABLE' });
    expect(t.state).toEqual({ kind: 'off' });
    expect(t.effects.map((e) => e.type)).toEqual(['STOP_ANSWER', 'RESUME_PLAYBACK']);
  });

  it('STOP turns everything off and leaves the episode paused', () => {
    const t = reduceVoice({ kind: 'idle' }, { type: 'STOP' });
    expect(t.state).toEqual({ kind: 'off' });
    expect(t.effects.map((e) => e.type)).toEqual(['PAUSE_PLAYBACK']);
    const t2 = reduceVoice({ kind: 'resuming', wasPlaying: true, note: null, home: 'idle' }, { type: 'STOP' });
    expect(t2.effects.map((e) => e.type)).toEqual(['CANCEL_RESUME_TIMER']);
    expect(t2.effects.map((e) => e.type)).not.toContain('RESUME_PLAYBACK');
  });

  it('every state has a one-word label', () => {
    const states: VoiceState[] = [
      { kind: 'off' }, { kind: 'idle' }, { kind: 'listening', wasPlaying: true, manual: false, home: 'idle' },
      { kind: 'thinking', wasPlaying: true, home: 'idle' }, { kind: 'speaking', wasPlaying: true, text: null, home: 'idle' },
      { kind: 'resuming', wasPlaying: true, note: null, home: 'idle' },
    ];
    for (const s of states) expect(voiceStatusLabel(s).length).toBeGreaterThan(0);
  });
});
