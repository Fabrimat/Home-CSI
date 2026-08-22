import { z } from 'zod';

/** Accepts an ISO-8601 timestamp or epoch milliseconds (as a numeric string). */
export const timestampSchema = z
  .string()
  .min(1)
  .transform((value, ctx) => {
    const asNumber = /^-?\d+$/.test(value) ? Number(value) : NaN;
    const date = Number.isFinite(asNumber) ? new Date(asNumber) : new Date(value);
    if (Number.isNaN(date.getTime())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'not a valid timestamp' });
      return z.NEVER;
    }
    return date;
  });

export const macAddressSchema = z
  .string()
  .regex(/^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/, 'invalid MAC address');

export const nodeIdSchema = z.coerce.number().int().min(1).max(65535);

/**
 * Required explicit time range shape, per docs/architecture.md — never
 * query "everything". Kept as a plain `ZodObject` (no `.refine()`) so
 * routes can still `.extend()` it with their own fields; the from-before-to
 * ordering check must be applied separately, via `TIME_ORDER_REFINEMENT`,
 * *after* any `.extend()` — `.refine()`/`.transform()` return a
 * `ZodEffects` wrapper that no longer has `.extend()`.
 */
export const timeRangeQuerySchema = z.object({
  from: timestampSchema,
  to: timestampSchema,
});

export const TIME_ORDER_MESSAGE = 'from must be before to';

/** `v.from < v.to` check, usable directly as a `.refine()` predicate on any schema whose output includes `from`/`to`. */
export function timeOrderCheck(v: { from: Date; to: Date }): boolean {
  return v.from.getTime() < v.to.getTime();
}

export function boundedLimit(defaultValue: number, max: number) {
  return z
    .string()
    .optional()
    .transform((v) => (v === undefined ? defaultValue : Number(v)))
    .refine((v) => Number.isFinite(v) && v > 0, { message: 'limit must be a positive number' })
    .transform((v) => Math.min(Math.floor(v), max));
}
