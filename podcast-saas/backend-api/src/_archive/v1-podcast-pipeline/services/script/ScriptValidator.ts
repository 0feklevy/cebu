import { ScriptSchema, AudioTagSchema, type Script } from 'shared';
import { AppError, LLMErrorType } from 'shared';

export interface ValidationResult {
  valid: boolean;
  script?: Script;
  errors?: unknown;
}

export class ScriptValidator {
  validate(raw: unknown): ValidationResult {
    const result = ScriptSchema.safeParse(raw);

    if (!result.success) {
      return { valid: false, errors: result.error.format() };
    }

    const script = result.data;

    // Additional checks beyond Zod
    const issues: string[] = [];

    // Check audio tags against whitelist
    const validTags = new Set(AudioTagSchema.options);
    for (const turn of script.turns) {
      for (const tag of turn.audio_tags) {
        if (!validTags.has(tag)) {
          issues.push(`Invalid audio tag "${tag}" in turn by ${turn.speaker}`);
        }
      }
    }

    // Check at least one hook turn
    const hasHook = script.turns.some((t) => t.is_hook);
    if (!hasHook) {
      issues.push('Script has no hook turn (is_hook: true)');
    }

    // Check minimum turns
    if (script.turns.length < 4) {
      issues.push('Script has fewer than 4 turns — too short');
    }

    if (issues.length > 0) {
      return { valid: false, errors: { issues } };
    }

    return { valid: true, script };
  }
}
