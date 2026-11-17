import { z, type ZodTypeAny } from 'zod';
import { badRequest } from './errors.js';

/** Validate untrusted input with zod; throws 400 with field errors. */
export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) throw badRequest('Validation failed', r.error.flatten());
  return r.data;
}

export const PageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const offset = (q: { page: number; pageSize: number }) => (q.page - 1) * q.pageSize;

export const slugify = (s: string) =>
  s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_-]+/g, '-').slice(0, 48) || 'item';
