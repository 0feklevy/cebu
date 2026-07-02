import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { audio_files, timeline_sections, video_files } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { firebaseAuthMiddleware } from '../../middleware/firebase-auth.js';
import { editableProject } from '../../services/collabAccess.js';
import { getStorageAdapter } from '../../services/storage/getStorageAdapter.js';
import { uploadWithFallback } from '../../services/storage/uploadWithFallback.js';
import { probeMediaDuration } from '../../services/video/HLSTranscoder.js';
import { ApiKeyService } from '../../services/secrets/ApiKeyService.js';
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
    const duration = await probeMediaDuration(inputPath);
    return Number.isFinite(duration) && duration > 0 ? duration : null;
  } catch {
    return null;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function registerAudioRoutes(app: FastifyInstance): Promise<void> {
  const storage = getStorageAdapter();

  // POST /api/v1/projects/:id/audio — upload an audio file
  app.post<{ Params: { id: string } }>(
    '/api/v1/projects/:id/audio',
    { preHandler: [firebaseAuthMiddleware] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await editableProject(request.params.id, user);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const data = await request.file();
      if (!data) return reply.code(400).send({ message: 'No file uploaded' });

      if (!isAllowedAudio(data.mimetype)) {
        return reply.code(400).send({ message: 'Only audio files (wav, mp3, m4a, ogg, flac) are supported' });
      }

      const ext = extname(data.filename || 'audio').replace(/[^a-z0-9.]/gi, '').toLowerCase() || '.mp3';
      const key = `audio/${project.id}/${randomUUID()}${ext}`;
      const buf = await data.toBuffer();
      const durationSec = await probeUploadedAudioDuration(buf, ext);

      const url = await uploadWithFallback(key, buf, data.mimetype.split(';')[0].trim());

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
        try { await storage.deleteFile(file.storage_key); } catch { /* ignore */ }
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
          clip_source_audio_id: body.data.audio_file_id,
          broll_volume:        1.0,
          label:               audioFile.filename,
        })
        .returning();

      return reply.code(201).send(section);
    },
  );
}
