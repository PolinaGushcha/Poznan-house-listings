import { z } from 'zod';

/** Error codes returned by the API in `{ error: { code, message, details, requestId } }`. */
export const ErrorCode = {
  ValidationFailed: 'VALIDATION_FAILED',
  Unauthenticated: 'UNAUTHENTICATED',
  Forbidden: 'FORBIDDEN',
  NotFound: 'NOT_FOUND',
  Conflict: 'CONFLICT',
  RateLimited: 'RATE_LIMITED',
  Internal: 'INTERNAL_ERROR'
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.array(z.unknown()).optional(),
    requestId: z.string().optional()
  })
});

export type ApiError = z.infer<typeof apiErrorSchema>;

/** The five historical districts of Poznań used for analytics. */
export const DISTRICTS = ['Stare Miasto', 'Nowe Miasto', 'Jeżyce', 'Grunwald', 'Wilda'] as const;
export type District = (typeof DISTRICTS)[number];

export const healthSchema = z.object({
  status: z.enum(['ok', 'error']),
  service: z.string(),
  version: z.string()
});
export type Health = z.infer<typeof healthSchema>;
