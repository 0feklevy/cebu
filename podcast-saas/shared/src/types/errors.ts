import { z } from 'zod';

export enum LLMErrorType {
  CONTENT_REJECTED = 'content_rejected',
  LIMIT_EXCEEDED = 'limit_exceeded',
  PARSING_ERROR = 'parsing_error',
  ABORTED = 'aborted',
  CONNECTION_ERROR = 'connection_error',
  LLM_ERROR = 'llm_error',
  GENERATION_PAUSED = 'generation_paused',
}

export const ApiErrorSchema = z.object({
  error_type: z.nativeEnum(LLMErrorType),
  message: z.string(),
  details: z.record(z.unknown()).optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export class AppError extends Error {
  constructor(
    public readonly error_type: LLMErrorType,
    message: string,
    public readonly statusCode: number = 400,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
