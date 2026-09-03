/**
 * The interactive answer: heard → the first sentence's audio while the model is still writing →
 * more sentences in order → done; the same refusals as the one-shot path; the ledger written
 * once; a synthesis failure skips a sentence, never the answer; a ceiling refusal means text only.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
const ceiling = vi.hoisted(() => ({ refuse: false, reason: null as string | null }));
vi.mock('../../usage/spendCeiling.js', () => ({ evaluateSpendCeiling: async () => ({ refuse: ceiling.refuse, reason: ceiling.reason }) }));
vi.mock('../../usage/recordSttSpend.js', () => ({ recordSttSpend: vi.fn() }));
vi.mock('../../usage/recordTtsSpend.js', () => ({ recordTtsSpend: vi.fn() }));
vi.mock('../../captions/groqKey.js', () => ({ resolveGroqKey: async () => null }));
vi.mock('../GuidanceTTSService.js', () => ({ GuidanceTTSService: class {}, resolveGuidanceVoice: async () => ({ voiceId: 'v', model: 'm' }) }));
vi.mock('../ListenerQuestionService.js', () => ({ askListenerQuestion: vi.fn() }));

import { answerVoiceQuestionStream, type VoiceQuestionDeps } from '../VoiceQuestionService.js';
import type { VoiceStreamEvent } from 'shared';

const ANSWER = 'The sky is blue because shorter wavelengths scatter more. Red light passes almost straight through. That is why sunsets are red.';

function deps(over: Partial<VoiceQuestionDeps> & { failSentence?: number } = {}) {
  const calls = { synthesized: [] as string[], stt: 0, tts: [] as Array<{ characters: number }>, askInput: null as Record<string, unknown> | null };
  const d: VoiceQuestionDeps = {
    transcribe: async () => ({ text: 'why is the sky blue', durationSec: 2.5, model: 'whisper' }),
    ask: async (input) => {
      calls.askInput = input as unknown as Record<string, unknown>;
      // The model writes in small pieces; the splitter should already be speaking sentence one
      // before the last piece arrives.
      for (const piece of ANSWER.match(/.{1,17}/g) ?? []) input.onTokenChunk?.(piece);
      return { status: 'answered', answer: ANSWER, questionId: 'q1' };
    },
    synthesize: async (text) => {
      if (over.failSentence !== undefined && calls.synthesized.length === over.failSentence) { calls.synthesized.push('FAILED:' + text); throw new Error('tts down'); }
      calls.synthesized.push(text);
      return { audio: Buffer.from('mp3:' + text), model: 'eleven' };
    },
    recordStt: (() => { calls.stt += 1; }) as never,
    recordTts: ((spend: { characters: number }) => { calls.tts.push(spend); }) as never,
    ...over,
  };
  return { d, calls };
}

async function run(d: VoiceQuestionDeps, signal?: AbortSignal) {
  const events: VoiceStreamEvent[] = [];
  await answerVoiceQuestionStream({ projectId: 'p1', language: 'en', positionMs: 1000, audioPath: '/tmp/x.wav', userId: null }, (e) => events.push(e), d, signal);
  return events;
}

describe('answerVoiceQuestionStream', () => {
  it('streams heard, then one audio chunk per sentence in order, then done with the whole answer', async () => {
    ceiling.refuse = false;
    const { d, calls } = deps();
    const events = await run(d);
    expect(events[0]).toEqual({ type: 'heard', question: 'why is the sky blue' });
    const audio = events.filter((e): e is Extract<VoiceStreamEvent, { type: 'audio' }> => e.type === 'audio');
    expect(audio.map((a) => a.seq)).toEqual([0, 1, 2]);
    expect(audio.map((a) => a.text)).toEqual([
      'The sky is blue because shorter wavelengths scatter more.',
      'Red light passes almost straight through.',
      'That is why sunsets are red.',
    ]);
    expect(Buffer.from(audio[0]!.audio_base64, 'base64').toString()).toBe('mp3:' + audio[0]!.text);
    expect(events.at(-1)).toEqual({ type: 'done', status: 'answered', question: 'why is the sky blue', answer: ANSWER, message: null, audio_chunks: 3 });
    // One STT spend, one TTS spend for the whole spoken text.
    expect(calls.stt).toBe(1);
    expect(calls.tts).toEqual([{ characters: ANSWER.replace(/\s+/g, ' ').length - 2 + 0 } ].map(() => expect.objectContaining({ characters: audio.reduce((n, a) => n + a.text.length, 0) })));
    expect(calls.askInput).toMatchObject({ intent: 'answer', question: 'why is the sky blue', positionMs: 1000 });
  });

  it('the first sentence is synthesised before the model has finished', async () => {
    const order: string[] = [];
    const { d } = deps({
      ask: async (input) => {
        input.onTokenChunk?.('First sentence of the answer is here. ');
        await new Promise((r) => setTimeout(r, 30));
        order.push('model-done');
        return { status: 'answered', answer: 'First sentence of the answer is here. Second one.', questionId: 'q1' };
      },
      synthesize: async (text) => { order.push('tts:' + text.slice(0, 5)); return { audio: Buffer.from('x'), model: 'm' }; },
    });
    await run(d);
    expect(order[0]).toBe('tts:First');
    expect(order.indexOf('tts:First')).toBeLessThan(order.indexOf('model-done'));
  });

  it('a synthesis failure skips that sentence and the answer still completes', async () => {
    ceiling.refuse = false;
    const { d } = deps({ failSentence: 1 });
    const events = await run(d);
    const audio = events.filter((e) => e.type === 'audio');
    expect(audio).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'answered', audio_chunks: 3 });
  });

  it('the ceiling refusal means text only: no audio chunks, done carries the answer', async () => {
    ceiling.refuse = true; ceiling.reason = 'monthly limit';
    const { d, calls } = deps();
    const events = await run(d);
    ceiling.refuse = false;
    expect(events.filter((e) => e.type === 'audio')).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'answered', answer: ANSWER, audio_chunks: 0 });
    expect(calls.tts).toEqual([]);
  });

  it('nothing heard and an over-long recording end with done and no model call', async () => {
    const asked = vi.fn();
    const { d } = deps({ transcribe: async () => ({ text: 'thank you', durationSec: 1, model: 'w' }), ask: asked as never });
    expect(await run(d)).toEqual([{ type: 'done', status: 'nothing_heard', question: null, answer: null, message: null, audio_chunks: 0 }]);
    const { d: d2 } = deps({ transcribe: async () => ({ text: 'a long dictation of many words', durationSec: 45, model: 'w' }), ask: asked as never });
    const events = await run(d2);
    expect(events[0]).toMatchObject({ type: 'done', status: 'refused' });
    expect(asked).not.toHaveBeenCalled();
  });

  it('a saved / refused answer ends with done and its reason, with no audio', async () => {
    const { d } = deps({ ask: async () => ({ status: 'saved', reason: 'Daily limit reached.', questionId: 'q1' }) });
    const events = await run(d);
    expect(events.at(-1)).toEqual({ type: 'done', status: 'saved', question: 'why is the sky blue', answer: null, message: 'Daily limit reached.', audio_chunks: 0 });
  });

  it('an aborted request stops synthesising', async () => {
    const controller = new AbortController();
    const { d, calls } = deps({ ask: async (input) => { input.onTokenChunk?.('One full sentence here, spoken. '); controller.abort(); input.onTokenChunk?.('Another full sentence here. '); return { status: 'answered', answer: 'x', questionId: 'q' }; } });
    await run(d, controller.signal);
    expect(calls.synthesized.length).toBeLessThanOrEqual(1);
  });
});
