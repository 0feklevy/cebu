import { ApiKeyService } from '../secrets/ApiKeyService.js';
import { db } from '../../db/index.js';
import { logger } from '../../lib/logger.js';

const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io/v1';

// Last-resort public default voice (multilingual-capable). Overridden by env / admin_settings.
const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM';

export interface GuidanceVoiceConfig {
  voiceId: string;
  model:   string;
}

/**
 * Resolve the TTS voice + model for a guidance language.
 * Priority: env override → admin_settings → sensible multilingual default.
 * `eleven_multilingual_v2` handles English well too and keeps us forward-compatible
 * with additional languages, so it is the default for every language.
 */
export async function resolveGuidanceVoice(language: string): Promise<GuidanceVoiceConfig> {
  const settings = await db.query.admin_settings.findFirst();
  const voiceId =
    process.env.GUIDANCE_TTS_VOICE_ID ||
    settings?.default_voice_id_a ||
    DEFAULT_VOICE_ID;
  const model =
    process.env.GUIDANCE_TTS_MODEL ||
    (language === 'en'
      ? (settings?.elevenlabs_model ?? 'eleven_multilingual_v2')
      : 'eleven_multilingual_v2');
  return { voiceId, model };
}

/**
 * Lean ElevenLabs text-to-speech for guidance narration.
 * Uses the plain `/text-to-speech/{voiceId}` endpoint, which returns raw mp3 bytes
 * (the `/with-timestamps` variant used by the archived podcast pipeline returns base64 JSON —
 *  we don't need word alignment for guidance, only the audio clip).
 */
export class GuidanceTTSService {
  constructor(private readonly apiKeyService: ApiKeyService = new ApiKeyService()) {}

  async synthesize(text: string, cfg: GuidanceVoiceConfig): Promise<Buffer> {
    const apiKey =
      (await this.apiKeyService.getSystemKey('elevenlabs')) ??
      process.env.ELEVENLABS_API_KEY ??
      null;
    if (!apiKey) {
      throw new Error('ElevenLabs API key not configured (set it in Admin → API Keys, or ELEVENLABS_API_KEY)');
    }

    const resp = await fetch(
      `${ELEVENLABS_API_BASE}/text-to-speech/${cfg.voiceId}?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: {
          'xi-api-key':   apiKey,
          'Content-Type': 'application/json',
          'Accept':       'audio/mpeg',
        },
        body: JSON.stringify({
          text,
          model_id: cfg.model,
          voice_settings: {
            stability:         0.5,
            similarity_boost:  0.75,
            style:             0.0,
            use_speaker_boost: true,
          },
        }),
      },
    );

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      logger.error({ status: resp.status, body: body.slice(0, 300) }, 'ElevenLabs guidance TTS failed');
      throw new Error(`ElevenLabs TTS error ${resp.status}: ${body.slice(0, 200)}`);
    }

    return Buffer.from(await resp.arrayBuffer());
  }
}
