/**
 * Single-turn regenerate — rewrite one line with a user hint, keeping it consistent
 * with the surrounding turns and the host contract.
 */

import type { ZodSchema } from 'zod';
import { LLMService } from '../llm/LLMService.js';
import { ApiKeyService } from '../secrets/ApiKeyService.js';
import { UsageTrackingService } from '../usage/UsageTrackingService.js';
import { loadPodcastPrompt, fillPrompt } from './prompts.js';
import { RegenTurnSchema } from './schemas.js';
import type { PodcastShow } from '../../db/schema.js';
import type { PodcastTurn } from 'shared';

export async function regenerateTurn(params: {
  show: PodcastShow;
  turns: PodcastTurn[];
  index: number;
  hint: string;
  userId: string;
}): Promise<PodcastTurn> {
  const { show, turns, index, hint, userId } = params;
  const target = turns[index];
  const context = turns.slice(Math.max(0, index - 2), Math.min(turns.length, index + 3));

  const teacherPersona = show.teacher_persona?.trim() ? `- Extra note on the teacher: ${show.teacher_persona.trim()}\n` : '';
  const learnerPersona = show.learner_persona?.trim() ? `- Extra note on the learner: ${show.learner_persona.trim()}\n` : '';

  const sys = fillPrompt(await loadPodcastPrompt('podcast_turn_regen'), {
    TEACHER_NAME: show.teacher_name,
    LEARNER_NAME: show.learner_name,
    TEACHER_PERSONA: teacherPersona,
    LEARNER_PERSONA: learnerPersona,
    DRAFT_TURNS: JSON.stringify(target),
    STORY_JSON: JSON.stringify(context),
    DIRECTOR_NOTES: hint.trim() || 'Make this line sharper and more natural without changing what it conveys.',
  });

  const llm = new LLMService(new ApiKeyService(), new UsageTrackingService());
  const res = await llm.sendStructured({
    task: 'podcast_turn_regen',
    systemPrompt: sys,
    userPrompt: 'Rewrite the single turn as specified. Output only the raw JSON object.',
    // Zod input≠output (from .catch()/.default()); cast to the output-typed schema.
    schema: RegenTurnSchema as unknown as ZodSchema<PodcastTurn>,
    userId,
    projectId: null,
    abortSignal: new AbortController().signal,
  });
  return res.data;
}
