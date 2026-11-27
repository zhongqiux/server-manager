import type { z } from 'zod';
import { ApiError } from '../errors.ts';

export function parseBody<S extends z.ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first && first.path.length > 0 ? first.path.join('.') : '请求体';
    const message = first ? `${path}：${first.message}` : '请求参数不合法';
    throw new ApiError(400, 'VALIDATION_FAILED', message, parsed.error.issues);
  }
  return parsed.data;
}