import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ScriptSchema, AudioTagSchema, EmotionSchema, type Script } from 'shared';
import type { LLMService } from '../llm/LLMService.js';
import { db } from '../../db/index.js';
import { system_prompts } from '../../db/schema.js';
import { eq } from 'drizzle-orm';

const __dirname = dirname(fileURLToPath(import.meta.url));

export class ScriptRewriteService {
  constructor(private readonly llm: LLMService) {}

  async rewrite(
    project: {
      id: string;
      created_by: string | null;
      style_preset: string | null;
      target_duration_min: number | null;
      emotional_style: string | null;
    },
    hostA: { name: string; role: string } | null,
    hostB: { name: string; role: string } | null,
    draft: Script,
    abortSignal: AbortSignal,
  ): Promise<{
    data: Script;
    model: string;
    inputTokens: number;
    outputTokens: number;
    costCents: number;
  }> {
    const systemPrompt = await this.getPrompt('script_rewrite');
    const resolved = this.substitutePlaceholders(systemPrompt, project, hostA, hostB);

    const userPrompt = `Rewrite this draft podcast script to broadcast quality:

${JSON.stringify(draft, null, 2)}`;

    const result = await this.llm.sendStructured({
      task: 'script_rewrite',
      systemPrompt: resolved,
      userPrompt,
      schema: ScriptSchema,
      userId: project.created_by!,
      projectId: project.id,
      abortSignal,
    });

    return {
      data: result.data as Script,
      model: result.model,
      inputTokens: result.usage.input,
      outputTokens: result.usage.output,
      costCents: result.usage.cost_cents,
    };
  }

  private async getPrompt(key: string): Promise<string> {
    const row = await db.query.system_prompts.findFirst({ where: eq(system_prompts.key, key) });
    if (row && row.is_customized) return row.content;
    try {
      return readFileSync(
        join(__dirname, '../../../../shared/src/prompts/script-rewrite.txt'),
        'utf-8',
      );
    } catch {
      return row?.content ?? '';
    }
  }

  private substitutePlaceholders(
    prompt: string,
    project: {
      style_preset: string | null;
      target_duration_min: number | null;
      emotional_style: string | null;
    },
    hostA: { name: string; role: string } | null,
    hostB: { name: string; role: string } | null,
  ): string {
    return prompt
      .replace(/{{STYLE_PRESET}}/g, project.style_preset ?? 'educational-deep-dive')
      .replace(/{{HOST_A_NAME}}/g, hostA?.name ?? 'Host A')
      .replace(/{{HOST_A_ROLE}}/g, hostA?.role ?? 'Expert')
      .replace(/{{HOST_B_NAME}}/g, hostB?.name ?? 'Host B')
      .replace(/{{HOST_B_ROLE}}/g, hostB?.role ?? 'Curious learner')
      .replace(/{{TARGET_MIN}}/g, String(project.target_duration_min ?? 10))
      .replace(/{{EMOTIONAL_STYLE}}/g, project.emotional_style ?? 'warm')
      .replace(/{{VALID_AUDIO_TAGS}}/g, AudioTagSchema.options.join(', '))
      .replace(/{{VALID_EMOTIONS}}/g, EmotionSchema.options.join(', '));
  }
}
