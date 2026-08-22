/**
 * Write down a transcription charge.
 *
 * The sibling of `recordTtsSpend`, and it carries one extra decision: what to do when the vendor
 * did not report a duration.
 *
 * ── AN UNKNOWN QUANTITY IS NOT A ZERO ONE ─────────────────────────────────────────────────────
 * `reportedDurationSec` returns null when the response carried no duration. Writing a row with
 * `quantity: 0` would say the transcription was free, which is false and worse than silence: a
 * per-day total built from it would be confidently wrong, and confidently wrong numbers are what
 * this whole effort exists to stop.
 *
 * So an unknown duration writes NO row and logs a warning naming the task. The gap is visible in
 * the logs rather than invisible in a total, and whoever reconciles against the invoice has a
 * thread to pull.
 */
import { logger } from '../../lib/logger.js';
import { UsageTrackingService } from './UsageTrackingService.js';
import { estimateSttCost, usdPerAudioHourFromEnv } from './sttCost.js';

const usage = new UsageTrackingService();

export interface SttSpend {
  userId: string | null;
  projectId: string | null;
  /** What was being transcribed — `corpus_audio_transcribe`, `captions`, and so on. */
  task: string;
  /** Seconds the vendor reported. Null means it reported none — see the header. */
  durationSec: number | null;
  model?: string;
}

/** Record one transcription. Never throws, never rejects, never blocks the caller. */
export async function recordSttSpend(spend: SttSpend): Promise<void> {
  if (spend.durationSec === null || !Number.isFinite(spend.durationSec) || spend.durationSec <= 0) {
    logger.warn(
      { task: spend.task, projectId: spend.projectId },
      '[usage] a transcription was paid for but reported no duration — not recorded rather than recorded as free',
    );
    return;
  }

  const cost = estimateSttCost({ durationSec: spend.durationSec, usdPerHour: usdPerAudioHourFromEnv() });
  try {
    await usage.record({
      userId: spend.userId,
      projectId: spend.projectId,
      provider: 'groq',
      model: spend.model ?? 'whisper-large-v3',
      task: spend.task,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      costCents: cost.costCents,
      usedPersonalKey: false,
      quantity: cost.seconds,
      unit: 'seconds',
    });
  } catch (err) {
    logger.warn(
      { task: spend.task, err: (err as Error).message?.slice(0, 160) },
      '[usage] a transcription was paid for but not recorded',
    );
  }
}
