'use client';

/**
 * The device half of the hands-free loop (night run 2026-09-03 §4).
 *
 * `lib/voiceLoop.ts` decides; this hook does. It owns the microphone (an on-device Silero VAD —
 * @ricky0123/vad-web, ISC; onnxruntime-web, MIT; model MIT — served from /vad/ on our origin), the
 * earcon, the answer voice, the timers and the request, and it turns every effect the reducer
 * emits into exactly one device call. Nothing here reasons about state; if a transition looks
 * wrong, the fix is in the reducer and its tests.
 *
 * ── THE EPISODE STAYS A PLAIN <audio> ELEMENT ──────────────────────────────────────────────────
 * The player's design commitment holds: the episode never touches WebAudio, so it survives a
 * locked screen. The microphone runs through its own AudioContext (the VAD needs a worklet), and
 * that context is allowed to die on lock — hands-free simply pauses until the phone wakes. The
 * answer plays through a SECOND plain <audio> element for the same reason.
 *
 * ── ECHO ──────────────────────────────────────────────────────────────────────────────────────
 * `echoCancellation: true` cancels audio the browser itself plays through <audio> elements — which
 * is exactly the episode and the answer — and the episode is paused the instant speech starts, so
 * the podcast voice never reaches the model as a "question". A misfire from road noise costs a
 * few hundred milliseconds of pause and nothing else: the VAD is on-device and free.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { VoiceQuestionResponse } from 'shared/src/audio/listener';
import { VOICE_QUESTION_MAX_SECONDS } from 'shared/src/audio/listener';
import {
  INITIAL_VOICE_STATE, reduceVoice,
  type VoiceEffect, type VoiceEvent, type VoiceState,
} from '@/lib/voiceLoop';
import { earconWav, encodeWav, pcmDurationSec } from '@/lib/wav';

interface MicVADLike {
  start(): void;
  pause(): void;
  destroy(): void;
}

export interface VoiceLoopOptions {
  /** Hands-free listening on/off. The Ask button works either way (push-to-talk when off). */
  handsFree: boolean;
  /** The episode's <audio> element. */
  episode: React.RefObject<HTMLAudioElement | null>;
  /** A second, hidden <audio> element for the earcon and the spoken answer. */
  voice: React.RefObject<HTMLAudioElement | null>;
  /** Ships one utterance; never throws — a failure is a response with a message. */
  submit: (wav: Blob, durationSec: number) => Promise<VoiceQuestionResponse>;
}

export interface VoiceLoop {
  state: VoiceState;
  /** The last thing worth glancing at — an answer's text, or why there was none. */
  note: string | null;
  /** The transcript of the last spoken question, when the server heard one. */
  heard: string | null;
  /** True when this browser can run the loop at all (mic + AudioWorklet). */
  supported: boolean;
  /** A microphone/model failure the listener can act on, or null. */
  error: string | null;
  askTap(): void;
  stop(): void;
}

const VAD_ASSETS = '/vad/';

export function useVoiceLoop(opts: VoiceLoopOptions): VoiceLoop {
  const [state, setState] = useState<VoiceState>(INITIAL_VOICE_STATE);
  const [note, setNote] = useState<string | null>(null);
  const [heard, setHeard] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stateRef = useRef<VoiceState>(INITIAL_VOICE_STATE);
  const handsFreeRef = useRef(opts.handsFree);
  handsFreeRef.current = opts.handsFree;
  const submitRef = useRef(opts.submit);
  submitRef.current = opts.submit;

  const vadRef = useRef<MicVADLike | null>(null);
  const vadLoading = useRef<Promise<MicVADLike | null> | null>(null);
  const resumeTimer = useRef<number | null>(null);
  const readingTimer = useRef<number | null>(null);
  const earconUrl = useRef<string | null>(null);
  const answerUrl = useRef<string | null>(null);
  const lastResponse = useRef<VoiceQuestionResponse | null>(null);
  const dispatchRef = useRef<(e: VoiceEvent) => void>(() => {});

  const supported =
    typeof window !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof (window as unknown as { AudioWorkletNode?: unknown }).AudioWorkletNode !== 'undefined';

  // ── the microphone ──────────────────────────────────────────────────────────────────────────
  const ensureVad = useCallback(async (): Promise<MicVADLike | null> => {
    if (vadRef.current) return vadRef.current;
    if (vadLoading.current) return vadLoading.current;
    vadLoading.current = (async () => {
      try {
        const { MicVAD } = await import('@ricky0123/vad-web');
        const vad = await MicVAD.new({
          model: 'v5',
          baseAssetPath: VAD_ASSETS,
          onnxWASMBasePath: VAD_ASSETS,
          // Deliberately conservative: a car is loud, and a false start pauses the episode.
          positiveSpeechThreshold: 0.6,
          negativeSpeechThreshold: 0.4,
          minSpeechMs: 250,
          redemptionMs: 1100,        // the silence that ends an utterance
          preSpeechPadMs: 300,
          submitUserSpeechOnPause: true,
          getStream: () => navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
          }),
          onSpeechStart: () => dispatchRef.current({ type: 'SPEECH_START', playing: !(opts.episode.current?.paused ?? true) }),
          onSpeechEnd: (audio: Float32Array) => dispatchRef.current({ type: 'SPEECH_END', audio }),
          onVADMisfire: () => dispatchRef.current({ type: 'MISFIRE' }),
        });
        vadRef.current = vad;
        setError(null);
        return vad;
      } catch (e) {
        const msg = (e as Error)?.name === 'NotAllowedError'
          ? 'Microphone access was refused — allow it to ask by voice.'
          : 'The microphone could not be started.';
        setError(msg);
        return null;
      } finally {
        vadLoading.current = null;
      }
    })();
    return vadLoading.current;
  }, [opts.episode]);

  // ── the answer voice ────────────────────────────────────────────────────────────────────────
  const speakWithDevice = useCallback((text: string) => {
    const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
    if (synth && typeof SpeechSynthesisUtterance !== 'undefined') {
      const u = new SpeechSynthesisUtterance(text);
      u.onend = () => dispatchRef.current({ type: 'SPEAKING_ENDED' });
      u.onerror = () => dispatchRef.current({ type: 'SPEAKING_ENDED' });
      synth.cancel();
      synth.speak(u);
      return;
    }
    // No voice at all: leave the text on screen for about as long as it takes to read it.
    readingTimer.current = window.setTimeout(
      () => dispatchRef.current({ type: 'SPEAKING_ENDED' }),
      Math.min(8000, 1500 + text.length * 50),
    );
  }, []);

  const stopVoice = useCallback(() => {
    const el = opts.voice.current;
    if (el) { el.onended = null; el.onerror = null; el.pause(); }
    if (answerUrl.current) { URL.revokeObjectURL(answerUrl.current); answerUrl.current = null; }
    if (typeof window !== 'undefined') window.speechSynthesis?.cancel();
    if (readingTimer.current !== null) { window.clearTimeout(readingTimer.current); readingTimer.current = null; }
  }, [opts.voice]);

  // ── effects ─────────────────────────────────────────────────────────────────────────────────
  const runEffect = useCallback((fx: VoiceEffect) => {
    switch (fx.type) {
      case 'PAUSE_PLAYBACK':
        opts.episode.current?.pause();
        return;
      case 'RESUME_PLAYBACK':
        void opts.episode.current?.play().catch(() => { /* autoplay refused: the listener taps play */ });
        return;
      case 'PLAY_EARCON': {
        const el = opts.voice.current;
        if (!el) return;
        if (!earconUrl.current) earconUrl.current = URL.createObjectURL(earconWav());
        el.onended = null;
        el.src = earconUrl.current;
        void el.play().catch(() => { /* muted tab, or no gesture yet — the ring still pulses */ });
        return;
      }
      case 'START_CAPTURE':
        void ensureVad().then((vad) => {
          if (vad) vad.start();
          else if (stateRef.current.kind === 'listening') dispatchRef.current({ type: 'STOP' });
        });
        return;
      case 'END_CAPTURE':
        // With hands-free off the mic is released after every capture; on, it keeps listening
        // for a barge-in or a follow-up. `pause()` submits any speech in flight (submitUserSpeechOnPause).
        if (!handsFreeRef.current) vadRef.current?.pause();
        return;
      case 'SUBMIT': {
        const max = VOICE_QUESTION_MAX_SECONDS * 16000;
        const audio = fx.audio.length > max ? fx.audio.subarray(0, max) : fx.audio;
        const wav = encodeWav(audio, 16000);
        setHeard(null);
        submitRef.current(wav, pcmDurationSec(audio, 16000)).then((res) => {
          lastResponse.current = res;
          if (res.question) setHeard(res.question);
          const note =
            res.status === 'nothing_heard' ? 'Didn’t catch that.'
            : res.status === 'answered' ? null
            : (res.message ?? (res.status === 'saved' ? 'Saved for the creator.' : 'Could not answer that.'));
          dispatchRef.current({ type: 'ANSWER', text: res.answer, hasAudio: !!res.audio_base64, note });
        }, (e: unknown) => {
          dispatchRef.current({ type: 'ANSWER_FAILED', note: (e as Error)?.message || 'Could not reach the server.' });
        });
        return;
      }
      case 'PLAY_ANSWER': {
        const res = lastResponse.current;
        if (!res) { dispatchRef.current({ type: 'SPEAKING_ENDED' }); return; }
        if (res.answer) setNote(res.answer);
        const el = opts.voice.current;
        if (res.audio_base64 && el) {
          try {
            const bytes = Uint8Array.from(atob(res.audio_base64), (c) => c.charCodeAt(0));
            if (answerUrl.current) URL.revokeObjectURL(answerUrl.current);
            answerUrl.current = URL.createObjectURL(new Blob([bytes], { type: res.audio_mime ?? 'audio/mpeg' }));
            el.onended = () => dispatchRef.current({ type: 'SPEAKING_ENDED' });
            el.onerror = () => { if (res.answer) speakWithDevice(res.answer); else dispatchRef.current({ type: 'SPEAKING_ENDED' }); };
            el.src = answerUrl.current;
            void el.play().catch(() => { if (res.answer) speakWithDevice(res.answer); else dispatchRef.current({ type: 'SPEAKING_ENDED' }); });
            return;
          } catch { /* fall through to the device voice */ }
        }
        if (res.answer) speakWithDevice(res.answer);
        else dispatchRef.current({ type: 'SPEAKING_ENDED' });
        return;
      }
      case 'STOP_ANSWER':
        stopVoice();
        return;
      case 'START_RESUME_TIMER':
        if (resumeTimer.current !== null) window.clearTimeout(resumeTimer.current);
        resumeTimer.current = window.setTimeout(() => {
          resumeTimer.current = null;
          dispatchRef.current({ type: 'RESUME_TIMER_DONE' });
        }, fx.ms);
        return;
      case 'CANCEL_RESUME_TIMER':
        if (resumeTimer.current !== null) { window.clearTimeout(resumeTimer.current); resumeTimer.current = null; }
        return;
      case 'NOTE':
        setNote(fx.text);
        return;
    }
  }, [ensureVad, opts.episode, opts.voice, speakWithDevice, stopVoice]);

  const dispatch = useCallback((event: VoiceEvent) => {
    const t = reduceVoice(stateRef.current, event);
    stateRef.current = t.state;
    setState(t.state);
    for (const fx of t.effects) runEffect(fx);
  }, [runEffect]);
  dispatchRef.current = dispatch;

  // ── hands-free on/off ───────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!supported) return;
    if (opts.handsFree) {
      dispatch({ type: 'ENABLE' });
      void ensureVad().then((vad) => {
        if (vad) vad.start();
        else dispatch({ type: 'DISABLE' });
      });
    } else {
      dispatch({ type: 'DISABLE' });
      vadRef.current?.pause();
    }
  }, [opts.handsFree, supported, dispatch, ensureVad]);

  // ── teardown ────────────────────────────────────────────────────────────────────────────────
  useEffect(() => () => {
    vadRef.current?.destroy();
    vadRef.current = null;
    if (resumeTimer.current !== null) window.clearTimeout(resumeTimer.current);
    if (readingTimer.current !== null) window.clearTimeout(readingTimer.current);
    if (earconUrl.current) URL.revokeObjectURL(earconUrl.current);
    if (answerUrl.current) URL.revokeObjectURL(answerUrl.current);
    if (typeof window !== 'undefined') window.speechSynthesis?.cancel();
  }, []);

  const askTap = useCallback(() => {
    if (!supported) { setError('This browser cannot listen — type your question instead.'); return; }
    dispatch({ type: 'ASK_TAP', playing: !(opts.episode.current?.paused ?? true) });
  }, [dispatch, opts.episode, supported]);

  const stop = useCallback(() => dispatch({ type: 'STOP' }), [dispatch]);

  return { state, note, heard, supported, error, askTap, stop };
}
