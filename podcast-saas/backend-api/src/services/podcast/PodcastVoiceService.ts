/**
 * PodcastVoiceService — ElevenLabs voice library access for Podcast Studio.
 *
 * - Search the shared voice library (Phase 4 picker) with ElevenLabs filters.
 * - Add a shared voice to the workspace (required before text-to-dialogue can use it).
 * - Resolve the two default hosts (teacher=Brittney, learner=Titan) at show-create
 *   time: find them in the library, add them idempotently, return their workspace
 *   voice ids. Best-effort — if no ElevenLabs key is configured the show is still
 *   created with null voice ids and the Phase 4 picker (or env) can fill them later.
 */

import { ApiKeyService } from '../secrets/ApiKeyService.js';
import { logger } from '../../lib/logger.js';

const EL_BASE = 'https://api.elevenlabs.io/v1';

/** Candidate library voice ids per the plan (search resolves the owner + confirms the match). */
export const DEFAULT_TEACHER_VOICE_ID = 'kPzsL2i3teMYv0FxEYQ6'; // Brittney - Social Media Voice
export const DEFAULT_LEARNER_VOICE_ID = 'dtSEyYGNJqjrtBArPCVZ'; // Titan - Deep, Bold & Powerful (verify)

export interface SharedVoice {
  voice_id: string;
  public_owner_id: string;
  name: string;
  gender?: string | null;
  age?: string | null;
  accent?: string | null;
  descriptive?: string | null;
  use_case?: string | null;
  category?: string | null;
  language?: string | null;
  preview_url?: string | null;
}

export interface SharedVoiceSearch {
  search?: string;
  gender?: string;
  age?: string;
  accent?: string;
  language?: string;
  category?: string;
  use_cases?: string[];
  page?: number;
  page_size?: number;
}

export class PodcastVoiceService {
  constructor(private readonly apiKeyService: ApiKeyService = new ApiKeyService()) {}

  private async getKey(): Promise<string | null> {
    return (
      (await this.apiKeyService.getSystemKey('elevenlabs')) ??
      process.env.ELEVENLABS_API_KEY ??
      null
    );
  }

  /** Search the shared voice library. Returns [] (never throws) when no key or on error. */
  async searchSharedVoices(params: SharedVoiceSearch): Promise<{ voices: SharedVoice[]; has_more: boolean }> {
    const key = await this.getKey();
    if (!key) return { voices: [], has_more: false };

    const q = new URLSearchParams();
    if (params.search) q.set('search', params.search);
    if (params.gender) q.set('gender', params.gender);
    if (params.age) q.set('age', params.age);
    if (params.accent) q.set('accent', params.accent);
    if (params.language) q.set('language', params.language);
    if (params.category) q.set('category', params.category);
    for (const uc of params.use_cases ?? []) q.append('use_cases', uc);
    q.set('page', String(params.page ?? 0));
    q.set('page_size', String(Math.min(params.page_size ?? 30, 100)));

    try {
      const res = await fetch(`${EL_BASE}/shared-voices?${q.toString()}`, {
        headers: { 'xi-api-key': key },
      });
      if (!res.ok) {
        logger.warn({ status: res.status }, 'ElevenLabs shared-voices search failed');
        return { voices: [], has_more: false };
      }
      const data = (await res.json()) as { voices?: SharedVoice[]; has_more?: boolean };
      return { voices: data.voices ?? [], has_more: Boolean(data.has_more) };
    } catch (err) {
      logger.warn({ err }, 'ElevenLabs shared-voices search error');
      return { voices: [], has_more: false };
    }
  }

  /** Own workspace voice ids (for idempotency — skip re-adding a voice already present). */
  private async ownVoiceIds(key: string): Promise<Set<string>> {
    try {
      const res = await fetch(`${EL_BASE}/voices`, { headers: { 'xi-api-key': key } });
      if (!res.ok) return new Set();
      const data = (await res.json()) as { voices?: Array<{ voice_id: string }> };
      return new Set((data.voices ?? []).map((v) => v.voice_id));
    } catch {
      return new Set();
    }
  }

  /**
   * Add a shared voice to the workspace. Returns the workspace voice id (which may
   * differ from the library voice id). Idempotent — a voice already present returns
   * its existing id. Returns null on failure.
   */
  async addSharedVoice(publicOwnerId: string, voiceId: string, newName: string): Promise<string | null> {
    const key = await this.getKey();
    if (!key) return null;
    try {
      const res = await fetch(`${EL_BASE}/voices/add/${publicOwnerId}/${voiceId}`, {
        method: 'POST',
        headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_name: newName }),
      });
      if (res.ok) {
        const data = (await res.json()) as { voice_id?: string };
        return data.voice_id ?? voiceId;
      }
      // Already-in-library / duplicate: treat the library id as usable.
      if (res.status === 400 || res.status === 409) {
        logger.info({ voiceId, status: res.status }, 'ElevenLabs voice add returned duplicate — using library id');
        return voiceId;
      }
      logger.warn({ voiceId, status: res.status }, 'ElevenLabs voice add failed');
      return null;
    } catch (err) {
      logger.warn({ err, voiceId }, 'ElevenLabs voice add error');
      return null;
    }
  }

  /**
   * Resolve one default host: find it in the shared library by name + candidate id,
   * add it to the workspace, return the usable voice id. Falls back to the candidate
   * id if it is already in the workspace but not found via search.
   */
  private async resolveDefault(searchName: string, candidateId: string, ownName: string, own: Set<string>): Promise<string | null> {
    // ALWAYS return the exact requested voice id — never a fuzzy "first result". If the
    // exact voice is found in the shared library, add it to the workspace (best-effort)
    // so v3 can use it; either way the returned id is the one the owner asked for.
    if (own.has(candidateId)) return candidateId;
    const { voices } = await this.searchSharedVoices({ search: searchName, page_size: 30 });
    const exact = voices.find((v) => v.voice_id === candidateId);
    if (exact) return (await this.addSharedVoice(exact.public_owner_id, exact.voice_id, ownName)) ?? candidateId;
    // Not surfaced by search — use the exact id directly (v3 accepts known public voice ids).
    return candidateId;
  }

  /**
   * Seed the two default hosts. Best-effort: returns whatever it could resolve
   * (nulls when no key / not found). Called at show creation.
   */
  async resolveDefaultVoices(teacherName = 'Brittney', learnerName = 'Titan'): Promise<{
    teacher_voice_id: string | null;
    learner_voice_id: string | null;
  }> {
    const key = await this.getKey();
    if (!key) return { teacher_voice_id: null, learner_voice_id: null };
    const own = await this.ownVoiceIds(key);
    const [teacher, learner] = await Promise.all([
      this.resolveDefault('Brittney Social Media', DEFAULT_TEACHER_VOICE_ID, teacherName, own),
      this.resolveDefault('Titan Deep Bold Powerful', DEFAULT_LEARNER_VOICE_ID, learnerName, own),
    ]);
    return { teacher_voice_id: teacher, learner_voice_id: learner };
  }
}
