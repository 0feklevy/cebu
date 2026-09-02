/**
 * The spoken question — the order of operations and the two failure rules (night run §4).
 *
 * Every vendor is a stub injected through `deps`: the test proves WHAT is called, in WHICH order,
 * with WHAT, and what comes back on each branch. Nothing here can reach Groq or ElevenLabs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { answerVoiceQuestion, isNoiseTranscript, type VoiceQuestionDeps } from '../VoiceQuestionService.js';

function deps(over: Partial<VoiceQuestionDeps> = {}): VoiceQuestionDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    transcribe: vi.fn(async () => { calls.push('transcribe'); return { text: 'why do the birds turn together', durationSec: 3.2, model: 'whisper-large-v3' }; }),
    ask: vi.fn(async () => { calls.push('ask'); return { status: 'answered' as const, answer: 'Each bird follows its neighbours.', questionId: 'q1' }; }),
    synthesize: vi.fn(async () => { calls.push('synthesize'); return { audio: Buffer.from('mp3-bytes'), model: 'eleven_multilingual_v2' }; }),
    recordStt: vi.fn(async () => { calls.push('recordStt'); }),
    recordTts: vi.fn(async () => { calls.push('recordTts'); }),
    ...over,
  };
}

const input = { projectId: 'proj-1', language: 'en', positionMs: 83_000, audioPath: '/tmp/q.wav', userId: null };

beforeEach(() => vi.clearAllMocks());

describe('answerVoiceQuestion', () => {
  it('hears → records the STT spend → asks through the TYPED path → speaks → records the TTS spend, in that order', async () => {
    const d = deps();
    const res = await answerVoiceQuestion(input, d);
    expect(d.calls).toEqual(['transcribe', 'recordStt', 'ask', 'synthesize', 'recordTts']);
    expect(res).toEqual({
      status: 'answered',
      question: 'why do the birds turn together',
      answer: 'Each bird follows its neighbours.',
      message: null,
      audio: Buffer.from('mp3-bytes'),
      audioMime: 'audio/mpeg',
    });
    // The typed path receives the transcript as the question, anchored at the spoken moment,
    // always as an 'answer' intent — the server-side cap decides what that is allowed to cost.
    expect(d.ask).toHaveBeenCalledWith({
      projectId: 'proj-1', language: 'en', positionMs: 83_000,
      question: 'why do the birds turn together', intent: 'answer', userId: null,
    });
    expect(d.recordStt).toHaveBeenCalledWith(expect.objectContaining({ task: 'listener_voice_question', durationSec: 3.2, projectId: 'proj-1' }));
    expect(d.recordTts).toHaveBeenCalledWith(expect.objectContaining({ task: 'listener_voice_answer', characters: 'Each bird follows its neighbours.'.length }));
  });

  it('an utterance that transcribes to nothing is a MISFIRE: no question row, no cap, STT still billed', async () => {
    const d = deps({ transcribe: vi.fn(async () => ({ text: '  ', durationSec: 0.8, model: 'm' })) });
    const res = await answerVoiceQuestion(input, d);
    expect(res.status).toBe('nothing_heard');
    expect(d.ask).not.toHaveBeenCalled();
    expect(d.synthesize).not.toHaveBeenCalled();
    expect(d.recordStt).toHaveBeenCalledTimes(1);   // the vendor processed audio; that is not free
  });

  it("Whisper's silence hallucinations ('Thank you.') are misfires too", async () => {
    const d = deps({ transcribe: vi.fn(async () => ({ text: 'Thank you.', durationSec: 1, model: 'm' })) });
    expect((await answerVoiceQuestion(input, d)).status).toBe('nothing_heard');
    expect(d.ask).not.toHaveBeenCalled();
  });

  it('a capped or saved question comes back as saved with the reason, and is never synthesised', async () => {
    const d = deps({ ask: vi.fn(async () => ({ status: 'saved' as const, reason: 'Today’s answers are used up.', questionId: 'q2' })) });
    const res = await answerVoiceQuestion(input, d);
    expect(res).toMatchObject({ status: 'saved', question: 'why do the birds turn together', answer: null, message: 'Today’s answers are used up.', audio: null });
    expect(d.synthesize).not.toHaveBeenCalled();
    expect(d.recordTts).not.toHaveBeenCalled();
  });

  it('a text-to-speech failure keeps the ANSWER — text goes back, audio is null, no TTS spend recorded', async () => {
    const d = deps({ synthesize: vi.fn(async () => { throw new Error('elevenlabs 503'); }) });
    const res = await answerVoiceQuestion(input, d);
    expect(res).toMatchObject({ status: 'answered', answer: 'Each bird follows its neighbours.', audio: null, audioMime: null });
    expect(d.recordTts).not.toHaveBeenCalled();
  });

  it('a missing language falls back to English for the voice, and is passed as null to the question path', async () => {
    const d = deps();
    await answerVoiceQuestion({ ...input, language: null }, d);
    expect(d.ask).toHaveBeenCalledWith(expect.objectContaining({ language: null }));
    expect(d.synthesize).toHaveBeenCalledWith('Each bird follows its neighbours.', 'en');
  });
});

describe('isNoiseTranscript', () => {
  it('rejects empty, one-word and stock-phrase transcripts; accepts a real question', () => {
    for (const t of ['', '   ', 'you', 'Thank you.', 'Thanks for watching', 'hmm', 'why?']) expect(isNoiseTranscript(t), t).toBe(true);
    for (const t of ['why do they', 'what is a boid', 'and then what happens next']) expect(isNoiseTranscript(t), t).toBe(false);
  });
});
