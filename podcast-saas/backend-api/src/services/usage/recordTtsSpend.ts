/**
 * Write down a speech-synthesis charge — the one-liner the short paths needed.
 *
 * `PodcastRenderer` meters inline because it accumulates across a whole episode and writes one row
 * at the end. The preview and re-voice paths are the opposite shape: a single synthesis, no state
 * to carry, and no natural end to hook. Repeating the renderer's twenty lines in each of them is
 * how two of the three drift apart, so the shared half lives here.
 *
 * ── FIRE-AND-FORGET, AND WHY THAT IS THE RIGHT TRADE ──────────────────────────────────────────
 * Callers use `void recordTtsSpend(...)`. The audio is already made and already paid for by the
 * time this runs; making the creator wait on a metering write, or failing their preview because
 * the usage table is busy, spends their time to protect a report. A missing row is a reporting
 * gap. A thrown error here would be a broken feature.
 *
 * That is a real trade and not a free one: a row lost to a database blip is a charge the surface
 * will never show. It is the right way round because the alternative — a preview that fails when
 * metering fails — makes the product worse in exactly the moment it is already struggling.
 */
import { logger } from '../../lib/logger.js';
import { UsageTrackingService } from './UsageTrackingService.js';
import { estimateTtsCost, usdPerCreditFromEnv } from './ttsCost.js';

const usage = new UsageTrackingService();

export interface TtsSpend {
  userId: string | null;
  /** What was being made — `podcast_preview`, `podcast_revoice`, and so on. */
  task: string;
  /** Characters that actually reached the vendor, retries already multiplied in. */
  characters: number;
  projectId?: string | null;
  model?: string;
}

/** Record one synthesis. Never throws, never rejects, never blocks the caller's result. */
export async function recordTtsSpend(spend: TtsSpend): Promise<void> {
  // Nothing synthesised — a cache hit, or an empty request — is not a zero-cost EVENT, it is a
  // non-event. A zero row would put a meaningless entry in every per-day total.
  if (!Number.isFinite(spend.characters) || spend.characters <= 0) return;

  const cost = estimateTtsCost({ characters: spend.characters, usdPerCredit: usdPerCreditFromEnv() });
  try {
    await usage.record({
      userId: spend.userId,
      projectId: spend.projectId ?? null,
      provider: 'elevenlabs',
      model: spend.model ?? 'eleven_v3',
      task: spend.task,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      costCents: cost.costCents,
      usedPersonalKey: false,
      quantity: cost.characters,
      unit: 'characters',
    });
  } catch (err) {
    logger.warn(
      { task: spend.task, characters: spend.characters, err: (err as Error).message?.slice(0, 160) },
      '[usage] a speech synthesis was paid for but not recorded',
    );
  }
}
