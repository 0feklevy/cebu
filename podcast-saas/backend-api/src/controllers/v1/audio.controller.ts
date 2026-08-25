import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { audio_files, timeline_sections, video_files } from '../../db/schema.js';
import { eq, and, asc } from 'drizzle-orm';
import { buildMainSegmentTimeline, deriveAnchorForAbsoluteSec } from 'shared';
import { firebaseAuthMiddleware } from '../../middleware/firebase-auth.js';
import { editableProject } from '../../services/collabAccess.js';
import { getStorageAdapter } from '../../services/storage/getStorageAdapter.js';
import { deleteWithFallback } from '../../services/storage/deleteWithFallback.js';
import { uploadWithFallback } from '../../services/storage/uploadWithFallback.js';
import { uploadFileFromDisk } from '../../services/storage/uploadFromDisk.js';
import {
  declaredTooLarge,
  tooLargeMessage,
  UPLOAD_MAX_BYTES,
  UploadTooLargeError,
  withBoundedTempFile,
} from '../../services/security/uploadLimits.js';
import { probeMediaDuration } from '../../services/video/HLSTranscoder.js';
import { ApiKeyService } from '../../services/secrets/ApiKeyService.js';
import { UsageTrackingService } from '../../services/usage/UsageTrackingService.js';
import { estimateSfxCost, usdPerSfxSecondFromEnv } from '../../services/usage/sfxCost.js';
import { randomUUID } from 'crypto';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { extname, join } from 'path';

const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io/v1';

const ALLOWED_MIME = new Set([
  'audio/wav', 'audio/wave', 'audio/x-wav',
  'audio/mpeg', 'audio/mp3',
  'audio/mp4', 'audio/x-m4a', 'audio/aac',
  'audio/ogg', 'audio/flac',
  'audio/webm',
]);

function isAllowedAudio(mime: string): boolean {
  const base = mime.toLowerCase().split(';')[0].trim();
  return ALLOWED_MIME.has(base) || base.startsWith('audio/');
}

async function probeUploadedAudioDuration(buf: Buffer, ext: string): Promise<number | null> {
  const workDir = await mkdtemp(join(tmpdir(), 'audio-probe-'));
  const inputPath = join(workDir, `source${ext || '.audio'}`);
  try {
    await writeFile(inputPath, buf);
    return await probeAudioFileDuration(inputPath);
  } catch {
    return null;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** ffprobe a file already on disk. Never throws — an unreadable duration is simply unknown. */
async function probeAudioFileDuration(path: string): Promise<number | null> {
  try {
    const duration = await probeMediaDuration(path);
    return Number.isFinite(duration) && duration > 0 ? duration : null;
  } catch {
    return null;
  }
}

export async function registerAudioRoutes(app: FastifyInstance): Promise<void> {
  const storage = getStorageAdapter();

  // POST /api/v1/projects/:id/audio — upload an audio file
  //
  // BOUNDED AND SPOOLED TO DISK (performance-001). This used to be `await data.toBuffer()` with no
  // ceiling of any kind: the whole file entered the Node heap, was written to a temp file anyway
  // for the ffprobe, and was then handed to the uploader as a second reference to the same bytes.
  // Two concurrent uploads of a large file were an OOM kill of the API on the 2-vCPU host.
  //
  // Now the part streams straight to the temp file the probe already needed, cut off at the
  // ceiling as it goes, and the upload reads back from that file — so peak heap is one 64 KiB
  // chunk no matter how big the audio is, and nothing over the limit is ever written to storage.
  app.post<{ Params: { id: string } }>(
    '/api/v1/projects/:id/audio',
    // NO `bodyLimit` HERE, DELIBERATELY. It looks like the obvious guard and it is the opposite
    // of one: Fastify's multipart parser bypasses `bodyLimit` entirely — which is exactly why the
    // declared-size check and the bounded spool below exist — while RAISING the ceiling for every
    // other content type on this route from Fastify's 1 MiB default to the proxy limit. And the
    // body is parsed BEFORE preHandler runs, so an anonymous caller gets a 401 with the payload
    // already materialised in the heap. An adversarial reviewer demonstrated it with a standalone
    // app: 401 returned, `req.body` already at 4 MiB. Adding it bought nothing and opened a hole.
    { preHandler: [firebaseAuthMiddleware] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await editableProject(request.params.id, user);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const declared = declaredTooLarge(request.headers['content-length'], UPLOAD_MAX_BYTES.audio);
      if (declared !== null) {
        return reply.code(413).send({ message: tooLargeMessage('Audio file', declared, UPLOAD_MAX_BYTES.audio) });
      }

      const data = await request.file();
      if (!data) return reply.code(400).send({ message: 'No file uploaded' });

      if (!isAllowedAudio(data.mimetype)) {
        return reply.code(400).send({ message: 'Only audio files (wav, mp3, m4a, ogg, flac) are supported' });
      }

      const ext = extname(data.filename || 'audio').replace(/[^a-z0-9.]/gi, '').toLowerCase() || '.mp3';
      const key = `audio/${project.id}/${randomUUID()}${ext}`;
      const contentType = data.mimetype.split(';')[0].trim();

      try {
        return await withBoundedTempFile(
          data.file,
          { limitBytes: UPLOAD_MAX_BYTES.audio, what: 'Audio file', suffix: ext || '.audio' },
          async ({ path }) => {
            const durationSec = await probeAudioFileDuration(path);
            const url = await uploadFileFromDisk(key, path, contentType);

            const [row] = await db
              .insert(audio_files)
              .values({
                project_id:  project.id,
                filename:    data.filename || `audio${ext}`,
                storage_key: key,
                url,
                duration_sec: durationSec,
              })
              .returning();

            return reply.code(201).send(row);
          },
        );
      } catch (err) {
        if (err instanceof UploadTooLargeError) return reply.code(413).send({ message: err.message });
        throw err;
      }
    },
  );

  // GET /api/v1/projects/:id/audio — list audio files for a project
  app.get<{ Params: { id: string } }>(
    '/api/v1/projects/:id/audio',
    { preHandler: [firebaseAuthMiddleware] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await editableProject(request.params.id, user);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const files = await db.query.audio_files.findMany({
        where: eq(audio_files.project_id, project.id),
        orderBy: (t, { desc }) => [desc(t.created_at)],
      });
      return reply.send(files);
    },
  );

  // DELETE /api/v1/projects/:id/audio/:audioId
  app.delete<{ Params: { id: string; audioId: string } }>(
    '/api/v1/projects/:id/audio/:audioId',
    { preHandler: [firebaseAuthMiddleware] },
    async (request: FastifyRequest<{ Params: { id: string; audioId: string } }>, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await editableProject(request.params.id, user);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const file = await db.query.audio_files.findFirst({
        where: and(eq(audio_files.id, request.params.audioId), eq(audio_files.project_id, project.id)),
      });
      if (file) {
        // Through the chokepoint, not the adapter: audio_files carries a `blob_id` (078), so this
        // key can become a SHARED, content-addressed one the moment upload wiring lands — and a
        // direct adapter call would delete bytes other projects reference. deleteWithFallback
        // refuses `blobs/` keys and is identical for every other key.
        try { await deleteWithFallback(file.storage_key); } catch { /* ignore */ }
      }

      await db
        .delete(audio_files)
        .where(and(eq(audio_files.id, request.params.audioId), eq(audio_files.project_id, project.id)));
      return reply.code(204).send();
    },
  );

  // POST /api/v1/projects/:id/audio/generate — generate music or SFX via ElevenLabs
  app.post<{ Params: { id: string } }>(
    '/api/v1/projects/:id/audio/generate',
    { preHandler: [firebaseAuthMiddleware] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await editableProject(request.params.id, user);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const body = z.object({
        prompt:           z.string().min(1).max(500),
        type:             z.enum(['sfx', 'music']).default('sfx'),
        duration_seconds: z.number().min(0.5).max(22).optional(),
      }).safeParse(request.body);
      if (!body.success) return reply.code(400).send({ message: body.error.message });

      const apiKey = (await new ApiKeyService().getSystemKey('elevenlabs')) ?? process.env.ELEVENLABS_API_KEY ?? null;
      if (!apiKey) return reply.code(503).send({ message: 'ElevenLabs API key not configured. Set it in Admin → API Keys.' });

      const elBody: Record<string, unknown> = {
        text: body.data.type === 'music' ? `Background music: ${body.data.prompt}` : body.data.prompt,
        prompt_influence: body.data.type === 'music' ? 0.5 : 0.3,
      };
      if (body.data.duration_seconds) elBody.duration_seconds = body.data.duration_seconds;

      // Call ElevenLabs sound-generation
      let elRes: Response;
      try {
        elRes = await fetch(`${ELEVENLABS_API_BASE}/sound-generation`, {
          method: 'POST',
          headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
          body: JSON.stringify(elBody),
        });
      } catch (err) {
        return reply.code(502).send({ message: `Could not reach ElevenLabs: ${(err as Error).message ?? err}` });
      }

      if (!elRes.ok) {
        const errText = await elRes.text().catch(() => '');
        return reply.code(502).send({ message: `ElevenLabs error ${elRes.status}: ${errText.slice(0, 300)}` });
      }

      // SPEND, RECORDED. Sound generation is billed by the DURATION of the audio produced, so the
      // row carries seconds rather than characters — see `sfxCost.ts` for why the rate is a single
      // overridable constant with a pessimistic default, and why the SECONDS being right matters
      // more than the rate: a usage row with a measured quantity can be re-priced later, one with
      // a guessed quantity cannot.
      //
      // Recorded on a 2xx, because the failure branches above return before the audio exists —
      // and a request the vendor rejected outright is not billed.
      {
        const sfx = estimateSfxCost({
          durationSeconds: body.data.duration_seconds ?? null,
          usdPerSecond: usdPerSfxSecondFromEnv(),
        });
        void new UsageTrackingService().record({
          userId: request.dbUser?.id ?? null,
          projectId: project.id,
          provider: 'elevenlabs',
          model: 'sound-generation',
          task: body.data.type === 'music' ? 'sfx_music' : 'sfx_effect',
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          costCents: sfx.costCents,
          usedPersonalKey: false,
          quantity: sfx.seconds,
          unit: 'seconds',
        }).catch(() => { /* a reporting gap must never fail a generation the creator is waiting on */ });
      }

      let audioBuf: Buffer;
      try {
        audioBuf = Buffer.from(await elRes.arrayBuffer());
      } catch (err) {
        return reply.code(502).send({ message: `Failed to read ElevenLabs response: ${(err as Error).message ?? err}` });
      }
      if (!audioBuf.length) {
        return reply.code(502).send({ message: 'ElevenLabs returned an empty audio response' });
      }

      const key = `audio/${project.id}/${randomUUID()}.mp3`;
      // Falls back to local storage when the primary write is denied (read-only R2),
      // so generated music/SFX still saves instead of failing with "Access Denied".
      const url = await uploadWithFallback(key, audioBuf, 'audio/mpeg');

      const durationSec = await probeUploadedAudioDuration(audioBuf, '.mp3');
      const label = body.data.type === 'music' ? 'music' : 'sfx';
      const filename = `${label}-${Date.now()}.mp3`;

      const [row] = await db.insert(audio_files).values({
        project_id:  project.id,
        filename,
        storage_key: key,
        url,
        duration_sec: durationSec,
      }).returning();

      return reply.code(201).send(row);
    },
  );

  // POST /api/v1/projects/:id/audio/insert-cutaway — create an audio-only timeline section
  app.post<{ Params: { id: string } }>(
    '/api/v1/projects/:id/audio/insert-cutaway',
    { preHandler: [firebaseAuthMiddleware] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await editableProject(request.params.id, user);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const body = z.object({
        audio_file_id:     z.string().uuid(),
        global_offset_sec: z.number().min(0),
        duration_sec:      z.number().min(0.5),
        video_file_id:     z.string().uuid(),
      }).safeParse(request.body);
      if (!body.success) return reply.code(400).send({ message: body.error.message });

      const audioFile = await db.query.audio_files.findFirst({
        where: and(eq(audio_files.id, body.data.audio_file_id), eq(audio_files.project_id, project.id)),
      });
      if (!audioFile) return reply.code(404).send({ message: 'Audio file not found' });

      const videoFile = await db.query.video_files.findFirst({
        where: and(eq(video_files.id, body.data.video_file_id), eq(video_files.project_id, project.id)),
      });
      if (!videoFile) return reply.code(404).send({ message: 'Video file not found' });

      // ANCHORED ON CREATION, the same way a b-roll is (D-01, "same abstraction for audio
      // cutaways"). An audio cutaway is positioned by its own absolute second and therefore drifts
      // by the same mechanism: re-transcode a main video and the cutaway keeps firing at the second
      // it was dropped at, which is now a different moment. A NEW row is the author placing it
      // against the timeline in front of them, so recording that as a segment offset is an intent,
      // not the backfill the ruling forbids. Null anchor when the project has no main video —
      // nothing to anchor to, and the row behaves exactly as it did before.
      const projectVideos = await db.query.video_files.findMany({
        where: eq(video_files.project_id, project.id),
        orderBy: [asc(video_files.created_at)],
        columns: { id: true, duration_sec: true, is_broll: true },
      });
      const anchor = deriveAnchorForAbsoluteSec(
        buildMainSegmentTimeline(projectVideos ?? []),
        body.data.global_offset_sec,
      );

      const [section] = await db
        .insert(timeline_sections)
        .values({
          project_id:          project.id,
          video_file_id:       body.data.video_file_id,
          start_sec:           0,
          end_sec:             body.data.duration_sec,
          type:                'audio',
          track:               'audio',
          global_offset_sec:   body.data.global_offset_sec,
          anchor_video_file_id: anchor?.anchor_video_file_id ?? null,
          anchor_offset_sec:    anchor?.anchor_offset_sec ?? null,
          placement_mode:       anchor ? 'segment' : 'legacy_absolute',
          clip_source_audio_id: body.data.audio_file_id,
          broll_volume:        1.0,
          label:               audioFile.filename,
        })
        .returning();

      return reply.code(201).send(section);
    },
  );
}
