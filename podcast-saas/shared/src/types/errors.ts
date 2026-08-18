export enum LLMErrorType {
  CONTENT_REJECTED = 'content_rejected',
  LIMIT_EXCEEDED = 'limit_exceeded',
  PARSING_ERROR = 'parsing_error',
  ABORTED = 'aborted',
  CONNECTION_ERROR = 'connection_error',
  LLM_ERROR = 'llm_error',
  GENERATION_PAUSED = 'generation_paused',
}

/**
 * There is deliberately no `ApiError` envelope type here (types-007).
 *
 * One existed, with `error_type: z.nativeEnum(LLMErrorType)`, and nothing in the repo ever
 * imported it. It could not have been used: the API's single error boundary
 * (`backend-api/src/lib/apiErrorHandler.ts`) sends `{ error_type, message }` where `error_type`
 * defaults to `'server_error'` and is `'invalid_identifier'` for a malformed uuid — neither is a
 * member of that enum — and it never sends the `details` field the schema declared optional. So
 * the schema would have REJECTED every error response this service actually produces. Restating
 * the real envelope here instead was rejected too: it would create a second owner for a shape
 * whose only writer is that one function, and no reader has ever asked for it.
 */

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
