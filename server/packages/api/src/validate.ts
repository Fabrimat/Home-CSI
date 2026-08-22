import type { ZodError, ZodTypeAny, z } from 'zod';

export class ValidationError extends Error {
  constructor(public readonly issues: ZodError['issues']) {
    super('validation failed');
  }
}

/** Parses `input` against `schema`, throwing `ValidationError` (caught by the route's error handler) on failure. */
export function parseOrThrow<Schema extends ZodTypeAny>(schema: Schema, input: unknown): z.infer<Schema> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(result.error.issues);
  }
  return result.data;
}
