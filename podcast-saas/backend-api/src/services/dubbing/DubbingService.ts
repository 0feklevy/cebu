/**
 * DubbingService — create a dubbed, captioned rendition of a video in one target language.
 *
 * ── The pipeline ──────────────────────────────────────────────────────────────────────────────
 *   claim → create vendor project → poll to `ready` → add language target → poll to `completed`
 *         → fetch that target's transcript → build WebVTT → download the dubbed audio
 *         → mux it onto the original video → build a per-language HLS rendition → record the spend
 *
 * ── Four facts that shaped this file ──────────────────────────────────────────────────────────
 *
 * 1. THE VENDOR HAS NO IDEMPOTENCY KEY. A retried create is a second invoice, at the most
 *    expensive per-unit rate in the product. Four layers stand against that, and they are listed
 *    in `resolveVendorProject` where the money is actually spent.
 *
 * 2. `status: "ready"` ON A PROJECT IS NOT A DUB. It means transcription finished. The dub lives
 *    on the language target and has its own `completed`. Polling the project and then downloading
 *    gets you nothing — which is why `pollProject` and `pollLanguage` are separate.
 *
 * 3. THE v2 SURFACE RETURNS AUDIO ONLY. `DubbingLanguageOutputs` has exactly one field. The dubbed
 *    VIDEO is our own ffmpeg mux, and the HLS rendition is our own transcode — see `muxAndPublish`.
 *
 * 4. CAPTIONS MUST COME FROM WHATEVER PRODUCED THE AUDIO. Never from an independent translation:
 *    two translations of one source diverge and the viewer reads one wording while hearing
 *    another. `buildCaptions` documents the primary path and the one permitted fallback.
 */
import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { and, eq, or, lt, isNull, ne } from 'drizzle-orm';

import { db } from '../../db/index.js';
import { video_dubs, video_files } from '../../db/schema.js';
import type { VideoDub } from '../../db/schema.js';
import { logger } from '../../lib/logger.js';
import { getStorageAdapter } from '../storage/getStorageAdapter.js';
import { runFfmpegLimited } from '../ffmpegLimit.js';
import { transcodeToHLS } from '../video/HLSTranscoder.js';
import { segmentsToVtt, generateVttValidate } from '../captions/CaptionService.js';
import { UsageTrackingService } from '../usage/UsageTrackingService.js';
import { uploadFileFromDisk } from '../storage/uploadFromDisk.js';
import {
  ElevenLabsDubbingClient,
  ElevenLabsDubbingError,
  isLanguageOutputFresh,
  type DubbingLanguageResponse,
  type DubbingProjectResponse,
} from './ElevenLabsDubbingClient.js';
import { acquireDubbingSlot, releaseDubbingSlot, renewDubbingSlot, type DubbingSlot } from './dubbingSlots.js';
import type { DubStageKey } from './stages.js';
import { vendorTargetLanguage, sourceLanguageTag } from './languages.js';
import { resolveProjectSourceLanguage, recordVendorSourceLanguage } from './sourceLanguage.js';
import { estimateDubbingCost } from './cost.js';
import { dubbingWatermarkPolicy, dubbingUsdPerCredit, WATERMARK_UNSHIPPABLE_REASON } from './config.js';

const execFileAsync = promisify(execFile);

export const DUB_STATUS = {
  queued: 'queued',
  processing: 'processing',
  completed: 'completed',
  stale: 'stale',
  failed: 'failed',
} as const;

export type DubStatus = (typeof DUB_STATUS)[keyof typeof DUB_STATUS];

/**
 * A `processing` claim older than this is a crashed worker and may be reclaimed.
 *
 * Far longer than CaptionService's 20 minutes because a dub is a different order of work: it waits
 * in the vendor's queue, transcribes, dubs per language, then downloads, muxes and transcodes here.
 * Reclaiming too eagerly is not a harmless retry — it is a second invoice.
 */
export const STALE_CLAIM_MS = 2 * 60 * 60 * 1000;

/** How long a failed dub is left alone before another attempt. */
export const FAILED_RETRY_MS = 30 * 60 * 1000;

/** The vendor's own samples poll at 5s. That is the floor; long media backs off from it. */
const POLL_INTERVAL_MS = 5_000;
const POLL_MAX_INTERVAL_MS = 30_000;
/** Nothing about a project or a language target should take longer than this. */
const POLL_TIMEOUT_MS = 90 * 60 * 1000;

/** Raised when the workspace is at its vendor concurrency ceiling. A wait, not a failure. */
export class DubSlotUnavailable extends Error {
  readonly code = 'dub_slot_unavailable' as const;
  constructor() {
    super('All dubbing slots for this workspace are busy — the job will be retried.');
    this.name = 'DubSlotUnavailable';
  }
}

/** Raised when the source has no speech worth dubbing. Terminal, and deliberately not billed. */
export class DubSourceSilent extends Error {
  constructor() {
    super('This video has no detectable speech, so there is nothing to dub.');
    this.name = 'DubSourceSilent';
  }
}

/**
 * Pure skip decision, in the exact shape of CaptionService's `shouldSkipCaption`.
 *
 * Separated from the row so it can be unit-tested without a database, because this is the function
 * that decides whether money is spent. `processing` is skipped only while the claim is FRESH — a
 * stale claim from a crashed worker is reclaimable, or a dead worker would strand the dub forever.
 */
export function shouldSkipDub(args: {
  status: string | null;
  hashMatches: boolean;
  updatedAtMs: number;
  force?: boolean;
  now?: number;
}): boolean {
  const { status, hashMatches, updatedAtMs, force = false, now = Date.now() } = args;
  if (force) return false;
  // The source changed, so whatever exists describes a video that is no longer there.
  if (!hashMatches) return false;
  if (status === DUB_STATUS.completed) return true;
  if (status === DUB_STATUS.processing) return now - updatedAtMs < STALE_CLAIM_MS;
  if (status === DUB_STATUS.failed) return now - updatedAtMs < FAILED_RETRY_MS;
  // `stale` means the vendor's transcript moved under us — regenerate.
  return false;
}

type VideoRow = typeof video_files.$inferSelect;

/** Identical inputs to CaptionService's hash, so "the source changed" means one thing repo-wide. */
export function dubSourceHash(video: Pick<VideoRow, 'storage_key' | 'file_size' | 'duration_sec' | 'filename'>): string {
  return createHash('sha1')
    .update([
      video.storage_key ?? '',
      video.file_size ?? '',
      video.duration_sec ?? '',
      video.filename ?? '',
    ].join(':'))
    .digest('hex');
}

/**
 * Does this video's waveform suggest there is anything to dub?
 *
 * What a dub returns for speechless media is undocumented — it may fail, may return an empty
 * transcript, or may produce a silent-but-billed output. B-roll and screen recordings frequently
 * have no speech, so this is not a rare case. `waveform_peaks` is already computed for every video
 * at transcode time, which makes this a free pre-check BEFORE any credits are spent.
 *
 * Deliberately permissive: a video with no waveform recorded at all passes, because absence of the
 * measurement is not evidence of silence and refusing to dub on missing data would be worse than
 * the occasional wasted job.
 */
export function hasAudibleSpeech(waveformPeaksJson: string | null | undefined): boolean {
  if (!waveformPeaksJson) return true;
  let peaks: unknown;
  try {
    peaks = JSON.parse(waveformPeaksJson);
  } catch {
    return true;
  }
  if (!Array.isArray(peaks) || peaks.length === 0) return true;
  const numeric = peaks.filter((p): p is number => typeof p === 'number' && Number.isFinite(p));
  if (numeric.length === 0) return true;
  // Peaks are normalised 0–1 against the track's own maximum, so a genuinely silent track is flat
  // near zero. A single quiet passage cannot trip this; a whole track of them can.
  const loudest = Math.max(...numeric);
  return loudest > 0.02;
}

export interface DubbingProviderResult {
  audio: Buffer;
  captionsVtt: string | null;
  /**
   * The source language the vendor worked from — echoed back after ITS auto-detection ran.
   *
   * This is the most authoritative reading of the source language anything in this system gets:
   * it comes from a machine that listened to the audio, not from text we inferred. Null when the
   * vendor did not report one.
   */
  sourceLanguage: string | null;
  elProjectId: string;
  elLanguageId: string;
  revision: number | null;
  outputRevision: number | null;
}

/**
 * The provider seam.
 *
 * One implementation exists (ElevenLabs v2). The interface is here so the pipeline below — claim,
 * mux, publish, meter — is written against a capability rather than a vendor, and so a second
 * provider can be added without touching the parts that spend money or write to storage.
 */
export interface DubbingProvider {
  readonly name: string;
  /** Produce dubbed audio and, where the provider can, the captions THAT audio speaks. */
  run(args: {
    dubId: string;
    sourceUrl: string;
    sourceLanguage: string | null;
    targetLanguage: string;
    /** Resume handles from a previous attempt, so a retry never re-creates a billed job. */
    existing: { projectId: string | null; languageId: string | null };
    /** Called with the vendor project id the moment it exists, before anything else can fail. */
    onProjectCreated: (projectId: string) => Promise<void>;
    /** Called with the language id as soon as the target exists. */
    onLanguageCreated: (languageId: string) => Promise<void>;
    /**
     * Called as each step begins, so the creator's bar can say what is happening.
     *
     * Optional because a provider that cannot distinguish its own steps should say nothing rather
     * than report invented ones — a bar that moves on a schedule instead of on progress is the
     * defect this replaced, not the fix for it.
     */
    onStage?: (stage: DubStageKey) => Promise<void>;
    /** Keeps the concurrency lease alive across a long vendor wait. */
    heartbeat: () => Promise<boolean>;
  }): Promise<DubbingProviderResult>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** ElevenLabs Dubbing v2, over the project surface. */
export class ElevenLabsDubbingProvider implements DubbingProvider {
  readonly name = 'elevenlabs';

  constructor(private readonly client: ElevenLabsDubbingClient = new ElevenLabsDubbingClient()) {}

  async run(args: Parameters<DubbingProvider['run']>[0]): Promise<DubbingProviderResult> {
    const target = vendorTargetLanguage(args.targetLanguage);
    if (!target) throw new Error(`Unsupported dubbing target language: ${args.targetLanguage}`);

    const project = await this.resolveVendorProject(args, target);

    // Transcription is the vendor's first job and it is not the dub — see the header note. The
    // stage is announced here rather than before `resolveVendorProject` because until the project
    // exists there is nothing being transcribed.
    await args.onStage?.('transcribing');
    const ready = await this.pollProject(project.project_id, args.heartbeat);

    const languageId = await this.resolveLanguageTarget(project.project_id, args, target);
    await args.onStage?.('translating');
    const language = await this.pollLanguage(project.project_id, languageId, args.heartbeat);

    await args.onStage?.('captioning');
    const captionsVtt = await this.buildCaptions(project.project_id, languageId);
    await args.onStage?.('downloading');

    // Re-fetch immediately before downloading: the signed URL expires about an hour after it is
    // issued, and the poll above may have taken longer than that. Never persist the URL.
    const fresh = await this.client.getLanguage(project.project_id, languageId);
    const signed = fresh.outputs?.lossless_audio;
    if (!signed) {
      throw new Error('Dub completed but the vendor returned no lossless_audio URL');
    }
    const audio = await this.client.downloadSignedUrl(signed);

    return {
      audio,
      captionsVtt,
      // Read from the READY project rather than the create response: auto-detection has finished by
      // then, and the create response can echo back only what we sent it — which, when we sent
      // nothing, is nothing.
      sourceLanguage: ready.source_language ?? project.source_language ?? null,
      elProjectId: project.project_id,
      elLanguageId: languageId,
      revision: language.revision ?? null,
      outputRevision: language.output_revision ?? null,
    };
  }

  /**
   * Get the vendor project for this dub — resuming an existing one wherever possible.
   *
   * THIS IS WHERE THE MONEY IS SPENT, and where the four layers of the double-billing defence meet:
   *
   *   1. the caller's atomic CAS claim, so only one worker is ever here for a given dub;
   *   2. `existing.projectId` — a project id already persisted means a previous attempt already
   *      paid; we resume it rather than buy another;
   *   3. the `reference` reconciliation below, which covers the one window layer 2 cannot: a
   *      worker that died between the vendor's response and our own database write. The money was
   *      already spent and the id was lost, so we go and find it;
   *   4. UNIQUE(video_file_id, target_language, provider) in the database, which holds even if all
   *      three above are somehow bypassed at once.
   */
  private async resolveVendorProject(
    args: Parameters<DubbingProvider['run']>[0],
    target: string,
  ): Promise<DubbingProjectResponse> {
    if (args.existing.projectId) {
      return this.client.getProject(args.existing.projectId);
    }

    const reference = dubReference(args.dubId);

    const recovered = await this.findProjectByReference(reference);
    if (recovered) {
      logger.warn(
        { dubId: args.dubId, projectId: recovered.project_id },
        '[dubbing] recovered an already-created vendor project by reference — not creating a second (already billed)',
      );
      await args.onProjectCreated(recovered.project_id);
      return recovered;
    }

    const created = await this.client.createProject({
      sourceUrl: args.sourceUrl,
      reference,
      sourceLanguage: args.sourceLanguage,
      modelId: 'dubbing_v2',
      targetLanguage: target,
    });
    // Persist the id BEFORE anything else can throw. Everything after this point is recoverable;
    // losing this id is the one failure that costs real money to repair.
    await args.onProjectCreated(created.project_id);
    return created;
  }

  /**
   * Look for a project we already created, by the reference we stamped on it.
   *
   * Best-effort by design: a listing failure must not block the dub, because the alternative is
   * refusing to work whenever the list endpoint is unhappy. The cost of missing a match is one
   * duplicated project; the cost of failing here is the feature not working at all. The pages are
   * bounded so a large workspace history cannot turn this into an unbounded scan.
   */
  private async findProjectByReference(reference: string): Promise<DubbingProjectResponse | null> {
    try {
      let cursor: string | undefined;
      for (let page = 0; page < 5; page += 1) {
        const listed = await this.client.listProjects({ cursor, pageSize: 100 });
        const match = (listed.projects ?? []).find((p) => p.reference === reference);
        if (match) return match;
        if (!listed.has_more || !listed.next_cursor) return null;
        cursor = listed.next_cursor;
      }
      return null;
    } catch (err) {
      logger.warn(
        { err: (err as Error).message?.slice(0, 160) },
        '[dubbing] reference reconciliation failed — proceeding to create',
      );
      return null;
    }
  }

  /** Reuse a language target if one exists for this language; otherwise add one. */
  private async resolveLanguageTarget(
    projectId: string,
    args: Parameters<DubbingProvider['run']>[0],
    target: string,
  ): Promise<string> {
    if (args.existing.languageId) return args.existing.languageId;

    // `createProject` was given `target_language`, which creates the first target as a shortcut —
    // so on the happy path the target already exists and adding another would duplicate it.
    const existing = await this.listLanguagesQuietly(projectId);
    const match = existing.find((l) => l.target_language === target);
    if (match) {
      await args.onLanguageCreated(match.language_id);
      return match.language_id;
    }

    const added = await this.client.addLanguage(projectId, target);
    await args.onLanguageCreated(added.language_id);
    return added.language_id;
  }

  private async listLanguagesQuietly(projectId: string): Promise<DubbingLanguageResponse[]> {
    try {
      return await this.client.listLanguages(projectId);
    } catch (err) {
      logger.warn(
        { projectId, err: (err as Error).message?.slice(0, 160) },
        '[dubbing] could not list language targets',
      );
      return [];
    }
  }

  /**
   * Poll the PROJECT to `ready` — transcription done. This is not yet a dub.
   *
   * Returns the settled project because that response carries the vendor's OWN reading of the
   * source language, which is the one piece of ground truth about the original audio anything in
   * this pipeline ever sees.
   */
  private async pollProject(
    projectId: string,
    heartbeat: () => Promise<boolean>,
  ): Promise<DubbingProjectResponse> {
    return pollUntil(
      () => this.client.getProject(projectId),
      (p) => {
        if (p.status === 'failed') {
          throw new Error(`Vendor project failed: ${p.error?.code ?? 'unknown'} ${p.error?.message ?? ''}`.trim());
        }
        return p.status === 'ready';
      },
      heartbeat,
      `project ${projectId}`,
    );
  }

  /** Poll the LANGUAGE TARGET to `completed` AND fresh. This is the one that means a dub exists. */
  private async pollLanguage(
    projectId: string,
    languageId: string,
    heartbeat: () => Promise<boolean>,
  ): Promise<DubbingLanguageResponse> {
    return pollUntil(
      () => this.client.getLanguage(projectId, languageId),
      (l) => {
        if (l.status === 'failed') {
          // `project_failed` on a target means the PARENT failed; the real cause is on the project.
          const detail = l.error?.code === 'project_failed'
            ? 'the parent project failed — read the project resource for the cause'
            : `${l.error?.code ?? 'unknown'} ${l.error?.message ?? ''}`.trim();
          throw new Error(`Vendor language target failed: ${detail}`);
        }
        // NOT `outputs != null`: a stale target keeps the outputs it had before the transcript
        // changed, so the non-null test would serve the pre-edit dub forever.
        return isLanguageOutputFresh(l);
      },
      heartbeat,
      `language ${languageId}`,
    );
  }

  /**
   * Build the WebVTT this dub speaks.
   *
   * PRIMARY PATH — the target transcript endpoint returns JSON segments carrying `start_s`, `end_s`
   * and `translation`. That text is the exact text spoken in the dubbed audio, produced by the same
   * model with the same segment boundaries, so captions and audio cannot disagree. It is fed
   * through CaptionService's own `segmentsToVtt`, so a dubbed cue is formatted identically to a
   * source-language one and the viewer's single parser handles both.
   *
   * Returning null is not a failure: it means this provider could not supply captions, and the
   * caller then transcribes THE DUBBED AUDIO ITSELF. What must never happen — and cannot happen
   * here — is captions produced by translating the source independently of the dub.
   */
  private async buildCaptions(projectId: string, languageId: string): Promise<string | null> {
    try {
      const transcript = await this.client.getTargetTranscript(projectId, languageId);
      const segments = (transcript.segments ?? [])
        .filter((s) => typeof s.translation === 'string' && s.translation.trim().length > 0)
        .map((s) => ({ start: s.start_s, end: s.end_s, text: s.translation! }));
      if (segments.length === 0) return null;
      return generateVttValidate(segmentsToVtt(segments));
    } catch (err) {
      logger.warn(
        { projectId, languageId, err: (err as Error).message?.slice(0, 200) },
        '[dubbing] target transcript unavailable — captions will be transcribed from the dubbed audio instead',
      );
      return null;
    }
  }
}

/** The `reference` stamped on a vendor project so a crashed worker can find it again. */
export function dubReference(dubId: string): string {
  return `flowvid:dub:${dubId}`;
}

/**
 * Poll `read` until `done` says so, backing off from the vendor's documented 5s floor.
 *
 * `heartbeat` renews the concurrency lease; when it returns false this worker has lost its slot
 * (its lease expired and another worker took it) and must stop rather than keep working while
 * believing it holds a slot it does not.
 */
async function pollUntil<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  heartbeat: () => Promise<boolean>,
  label: string,
): Promise<T> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let interval = POLL_INTERVAL_MS;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label} after ${Math.round(POLL_TIMEOUT_MS / 60000)} minutes`);
    }
    if (!(await heartbeat())) {
      throw new DubSlotUnavailable();
    }
    await sleep(interval);
    interval = Math.min(interval * 1.5, POLL_MAX_INTERVAL_MS);
  }
}

export interface DubbingServiceDeps {
  provider?: DubbingProvider;
  usage?: UsageTrackingService;
}

export class DubbingService {
  private readonly provider: DubbingProvider;
  private readonly usage: UsageTrackingService;

  constructor(deps: DubbingServiceDeps = {}) {
    this.provider = deps.provider ?? new ElevenLabsDubbingProvider();
    this.usage = deps.usage ?? new UsageTrackingService();
  }

  /**
   * Run one dub to completion.
   *
   * Throwing `DubSlotUnavailable` is how this signals "not now" — the queue retries with backoff
   * and the row stays `queued`, untouched and unbilled.
   */
  async run(dubId: string, opts: { force?: boolean } = {}): Promise<void> {
    const dub = await db.query.video_dubs.findFirst({ where: eq(video_dubs.id, dubId) });
    if (!dub) {
      logger.warn({ dubId }, '[dubbing] no such dub row — nothing to do');
      return;
    }

    const video = await db.query.video_files.findFirst({ where: eq(video_files.id, dub.video_file_id) });
    if (!video || !video.storage_key) {
      await this.fail(dubId, 'The source video is missing or has no stored file.');
      return;
    }

    const hash = dubSourceHash(video);
    if (shouldSkipDub({
      status: dub.status,
      hashMatches: dub.source_hash === hash,
      updatedAtMs: dub.updated_at?.getTime() ?? 0,
      force: opts.force,
    })) {
      logger.debug({ dubId, status: dub.status }, '[dubbing] skipping — already settled');
      return;
    }

    // The cheap silence pre-check, BEFORE any credits are spent.
    if (!hasAudibleSpeech(video.waveform_peaks)) {
      await this.fail(dubId, new DubSourceSilent().message);
      return;
    }

    // The workspace ceiling. Taken BEFORE the claim so a deferred job leaves the row exactly as it
    // found it — `queued`, retryable, and with no claim for another worker to have to wait out.
    const slot = await acquireDubbingSlot(dubId);
    if (!slot) {
      logger.info({ dubId }, '[dubbing] workspace at its concurrency ceiling — deferring');
      throw new DubSlotUnavailable();
    }

    try {
      if (!(await this.claim(dub, hash, opts.force ?? false))) {
        logger.debug({ dubId }, '[dubbing] already claimed by another worker — skipping');
        return;
      }
      await this.execute(dub, video, hash, slot);
    } catch (err) {
      if (err instanceof DubSlotUnavailable) {
        // Hand the row back to `queued` so the retry is an ordinary run rather than a reclaim.
        await db.update(video_dubs)
          .set({ status: DUB_STATUS.queued, stage: null, stage_entered_at: null, claimed_at: null, updated_at: new Date() })
          .where(eq(video_dubs.id, dubId))
          .catch(() => {});
        throw err;
      }
      const message = (err as Error).message || 'Dubbing failed';
      const retryable = err instanceof ElevenLabsDubbingError ? err.retryable : true;
      logger.warn({ dubId, retryable, err: message.slice(0, 400) }, '[dubbing] failed');
      await this.fail(dubId, message);
      // A vendor error that describes the input or the account will fail identically next time, so
      // there is nothing to gain from letting the queue retry it — the row records why and stops.
      if (retryable) throw err;
    } finally {
      await releaseDubbingSlot(slot, dubId);
    }
  }

  /**
   * Atomically take the row, in the shape CaptionService's claim established (review arch-008).
   *
   * `RETURNING` is what makes this a claim rather than a write: an empty result means another
   * worker got there first and this one bows out. A stale `processing` claim is reclaimable so a
   * crashed worker does not strand the dub; `force` always re-claims.
   */
  private async claim(dub: VideoDub, hash: string, force: boolean): Promise<boolean> {
    const staleBefore = new Date(Date.now() - STALE_CLAIM_MS);
    const claimed = await db.update(video_dubs).set({
      status: DUB_STATUS.processing,
      error: null,
      source_hash: hash,
      // The claim IS the first stage. Writing it here rather than in `execute` means a row can
      // never be `processing` with no stage at all, which is the state that used to make the
      // creator's panel look stuck.
      stage: 'preparing',
      stage_entered_at: new Date(),
      claimed_at: new Date(),
      updated_at: new Date(),
    }).where(force
      ? eq(video_dubs.id, dub.id)
      : and(
          eq(video_dubs.id, dub.id),
          or(
            isNull(video_dubs.status),
            ne(video_dubs.status, DUB_STATUS.processing),
            lt(video_dubs.claimed_at, staleBefore),
          ),
        ),
    ).returning({ id: video_dubs.id });
    return claimed.length > 0;
  }

  private async execute(dub: VideoDub, video: VideoRow, hash: string, slot: DubbingSlot): Promise<void> {
    const storage = getStorageAdapter();
    // Read the project's declared source language here rather than threading it through every
    // caller: it is one indexed lookup on a job that is about to spend real money, and getting it
    // from the project is the whole point — a deployment-wide env var cannot describe a catalogue
    // whose videos are in different languages.
    // RESOLVED, not merely read. The column is null on every project that predates detection, and
    // a null here means the vendor auto-detects — correct, but it also means the creator's panel
    // never learns what the video is in. Resolving caches the answer as a side effect, so the panel
    // is right the moment the first dub starts rather than only after it finishes.
    const resolved = video.project_id
      ? await resolveProjectSourceLanguage(video.project_id)
      : null;
    const workDir = await mkdtemp(join(tmpdir(), 'dub-'));

    try {
      // A presigned URL rather than an upload: the vendor fetches the media itself, which keeps a
      // multi-gigabyte source out of this process's memory entirely. The TTL covers the vendor's
      // own fetch, not the whole job.
      const sourceUrl = await storage.getPresignedDownloadUrl(video.storage_key!, 6 * 3600);

      const result = await this.provider.run({
        dubId: dub.id,
        sourceUrl,
        // The PROJECT's declared source, falling back to the deployment-wide default. A single
        // global env var is meaningless for a catalogue holding videos in different languages;
        // when neither is set this stays null and the vendor auto-detects, which is a correct
        // outcome rather than a missing one.
        sourceLanguage: sourceLanguageTag(resolved?.code ?? process.env.DUBBING_SOURCE_LANGUAGE),
        targetLanguage: dub.target_language,
        existing: { projectId: dub.el_project_id, languageId: dub.el_language_id },
        onProjectCreated: async (projectId) => {
          await db.update(video_dubs)
            .set({ el_project_id: projectId, updated_at: new Date() })
            .where(eq(video_dubs.id, dub.id));
        },
        onLanguageCreated: async (languageId) => {
          await db.update(video_dubs)
            .set({ el_language_id: languageId, updated_at: new Date() })
            .where(eq(video_dubs.id, dub.id));
        },
        heartbeat: () => renewDubbingSlot(slot, dub.id),
        onStage: (stage) => this.setStage(dub.id, stage),
      });

      // What the vendor heard outranks what we inferred, and this is the only moment it is known.
      if (video.project_id) await recordVendorSourceLanguage(video.project_id, result.sourceLanguage);

      await this.publish(dub, video, hash, result, workDir, storage);
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Mux, transcode, caption, store, meter — everything after the vendor has done its part. */
  private async publish(
    dub: VideoDub,
    video: VideoRow,
    hash: string,
    result: DubbingProviderResult,
    workDir: string,
    storage: ReturnType<typeof getStorageAdapter>,
  ): Promise<void> {
    const audioPath = join(workDir, 'dubbed-audio');
    await writeFile(audioPath, result.audio);

    const audioKey = `dubs/${dub.video_file_id}/${dub.target_language}/audio-${dub.id}`;
    await uploadFileFromDisk(audioKey, audioPath, 'audio/wav');

    await this.setStage(dub.id, 'mixing');

    const captionsVtt = result.captionsVtt
      ?? await transcribeDubbedAudio(audioPath, workDir);

    const { muxedKey, hlsMasterKey } = await this.muxAndPublish(dub, video, audioPath, workDir, storage);

    const watermark = dubbingWatermarkPolicy();
    const cost = estimateDubbingCost({
      durationSec: video.duration_sec ?? 0,
      languageCount: 1,
      watermarked: watermark.watermarked,
      usdPerCredit: dubbingUsdPerCredit(),
    });

    // A watermarked dub is produced and stored — the credits are already spent, and throwing the
    // artifact away would only mean paying again later — but it is NOT marked completed, because
    // `completed` is what the player reads as "safe to serve".
    const publishable = !watermark.watermarked;

    await db.update(video_dubs).set({
      status: publishable ? DUB_STATUS.completed : DUB_STATUS.failed,
      // The stage stays on the LAST step rather than being cleared: on a completed row it is
      // ignored, and on a failed one it is the single most useful thing the row can say.
      stage: 'packaging',
      audio_key: audioKey,
      muxed_video_key: muxedKey,
      hls_master_key: hlsMasterKey,
      captions_vtt: captionsVtt,
      source_hash: hash,
      revision: result.revision,
      output_revision: result.outputRevision,
      billed_minutes: cost.minutes,
      cost_cents: cost.costCents,
      watermarked: watermark.watermarked,
      error: publishable ? null : WATERMARK_UNSHIPPABLE_REASON,
      updated_at: new Date(),
    }).where(eq(video_dubs.id, dub.id));

    await this.meter(dub, video, cost);

    logger.info(
      { dubId: dub.id, language: dub.target_language, publishable, costCents: cost.costCents },
      '[dubbing] dub finished',
    );
  }

  /**
   * Record which step is running.
   *
   * Best-effort on purpose: a dub must not fail because a progress bar could not be updated. The
   * timestamp is what lets the bar move inside a step that reports nothing of its own — see
   * `stages.ts` for why it creeps asymptotically rather than linearly.
   */
  private async setStage(dubId: string, stage: DubStageKey): Promise<void> {
    await db.update(video_dubs)
      .set({ stage, stage_entered_at: new Date(), updated_at: new Date() })
      .where(eq(video_dubs.id, dubId))
      .catch((err: unknown) => {
        logger.debug({ dubId, stage, err: (err as Error).message?.slice(0, 120) }, '[dubbing] stage write failed');
      });
  }

  /**
   * Mux the dubbed audio onto the original video, then build a per-language HLS rendition.
   *
   * The v2 surface returns audio only, so the dubbed VIDEO is ours to make. The mux is a
   * stream-copy of the video track (`-c:v copy`) with only the audio re-encoded, so it costs
   * almost nothing however long the lesson is — no frame is touched, which is also why the dub
   * cannot alter the picture. `-shortest` guards the case where the dubbed track runs marginally
   * long, which would otherwise leave a frozen final frame.
   *
   * The HLS rendition goes through the SAME `transcodeToHLS` the source-language ladder uses, into
   * a parallel key tree — so a dubbed rendition is stored, served and cached exactly like any
   * other, and the viewer needs no special case to play one.
   */
  private async muxAndPublish(
    dub: VideoDub,
    video: VideoRow,
    audioPath: string,
    workDir: string,
    storage: ReturnType<typeof getStorageAdapter>,
  ): Promise<{ muxedKey: string; hlsMasterKey: string }> {
    const sourceUrl = await storage.getPresignedDownloadUrl(video.storage_key!, 6 * 3600);
    const muxedPath = join(workDir, 'dubbed.mp4');

    await runFfmpegLimited(() => execFileAsync('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', sourceUrl,
      '-i', audioPath,
      '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'copy',
      '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart',
      '-shortest',
      muxedPath,
    ], { timeout: 60 * 60 * 1000, maxBuffer: 1024 * 1024 * 8 }));

    const muxedKey = `dubs/${dub.video_file_id}/${dub.target_language}/video-${dub.id}.mp4`;
    await uploadFileFromDisk(muxedKey, muxedPath, 'video/mp4');

    const hlsDir = join(workDir, 'hls');
    await this.setStage(dub.id, 'packaging');
    const { masterKey } = await transcodeToHLS({
      inputPath: muxedPath,
      workDir: hlsDir,
      // Keyed by the dub id, so a regenerated dub writes a NEW tree rather than overwriting one
      // that viewers may still be streaming — the same write-once discipline as the source ladder.
      storageKeyPrefix: `dubs/${dub.video_file_id}/${dub.target_language}/hls/${dub.id}`,
      storage,
    });

    return { muxedKey, hlsMasterKey: masterKey };
  }

  /**
   * Record the spend through the existing usage ledger.
   *
   * `token_usage` is token-shaped and dubbing is minute-shaped, so the token columns are zeroed and
   * the real money goes in `cost_cents`, which is already fractional and correct. The minutes are
   * not lost: they are written into `task`, because per-minute is the number that gets reconciled
   * against the vendor's invoice and a cents figure alone cannot be re-derived once the rate moves.
   *
   * Never throws. Losing a ledger row is bad; failing a dub that has already been paid for and
   * successfully produced, because its bookkeeping row would not insert, is worse.
   */
  private async meter(dub: VideoDub, video: VideoRow, cost: ReturnType<typeof estimateDubbingCost>): Promise<void> {
    try {
      await this.usage.record({
        userId: null,
        projectId: video.project_id,
        provider: 'elevenlabs',
        model: 'dubbing_v2',
        task: `dub:${dub.target_language}:${cost.minutes.toFixed(3)}min`,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        costCents: cost.costCents,
        usedPersonalKey: false,
      });
    } catch (err) {
      logger.error(
        { dubId: dub.id, err: (err as Error).message?.slice(0, 200) },
        '[dubbing] could not record usage — the dub succeeded but the spend is unlogged',
      );
    }
  }

  private async fail(dubId: string, message: string): Promise<void> {
    await db.update(video_dubs).set({
      status: DUB_STATUS.failed,
      error: message.slice(0, 1000),
      updated_at: new Date(),
    }).where(eq(video_dubs.id, dubId)).catch(() => {});
  }
}

/**
 * Transcribe the DUBBED audio, as the captions fallback.
 *
 * This is the only permitted alternative to the vendor's own transcript, and it is permitted for
 * one reason: it transcribes the audio the viewer will actually hear, so the caption text still
 * describes that audio. It is strictly worse than the primary path — Whisper re-derives text the
 * dubbing model already knew exactly, so wording and segment boundaries will differ slightly from
 * what was spoken — but it cannot produce the failure that matters, which is captions that say
 * something different from the audio.
 *
 * Translating the SOURCE independently would be cheaper and is never acceptable here.
 */
async function transcribeDubbedAudio(audioPath: string, workDir: string): Promise<string | null> {
  if (!process.env.GROQ_API_KEY) {
    logger.warn('[dubbing] no vendor transcript and no GROQ_API_KEY — this dub will have no captions');
    return null;
  }
  try {
    const mp3Path = join(workDir, 'dubbed-16k.mp3');
    await runFfmpegLimited(() => execFileAsync('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', audioPath,
      '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k', '-f', 'mp3',
      mp3Path,
    ], { timeout: 30 * 60 * 1000, maxBuffer: 1024 * 1024 * 8 }));

    const { transcribeAudioFileToVtt } = await import('../captions/transcribeAudioFile.js');
    return await transcribeAudioFileToVtt(mp3Path);
  } catch (err) {
    logger.warn(
      { err: (err as Error).message?.slice(0, 200) },
      '[dubbing] fallback transcription of the dubbed audio failed — this dub will have no captions',
    );
    return null;
  }
}

/** Await a single dub (the queue handler and retry tooling both come through here). */
export function runDubJobNow(dubId: string, opts: { force?: boolean } = {}): Promise<void> {
  return new DubbingService().run(dubId, opts);
}
