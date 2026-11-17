import type { Ctx } from '../ctx.ts';
import { fail } from '../core/errors.ts';
import { newHex } from '../core/ids.ts';
import { citationsIn, type Citation, type Source } from './context.ts';
import { AiProviderError, type AiProvider, type AiRequest } from './provider.ts';

/**
 * Long answers (summaries, search answers) are streamed to the person who
 * asked, and only to them: `ai_stream` events carry the text as it arrives and
 * one `ai_done` event closes the request. Nothing is stored.
 */

const MAX_RUNNING_PER_USER = 2;
const FLUSH_MS = 80;
const running = new Map<string, number>();

export interface JobSpec {
  provider: AiProvider;
  request: AiRequest;
  sources: Source[];
  /** Extra fields for the `ai_done` event (e.g. how much input was left out). */
  extra?: Record<string, unknown>;
}

function emit(ctx: Ctx, userId: string, event: { type: string; [key: string]: unknown }): void {
  ctx.bus.emit({ event, audience: { users: [userId] }, clientOnly: true });
}

/** Start a streamed request for `userId` and return its id at once. */
export function startJob(ctx: Ctx, userId: string, kind: string, spec: JobSpec): string {
  const count = running.get(userId) ?? 0;
  if (count >= MAX_RUNNING_PER_USER) fail('ai_busy');
  running.set(userId, count + 1);
  const requestId = `ai_${newHex(8)}`;

  void (async () => {
    let text = '';
    let pending = '';
    let timer: NodeJS.Timeout | null = null;
    const flush = (): void => {
      timer = null;
      if (!pending) return;
      emit(ctx, userId, { type: 'ai_stream', request_id: requestId, kind, delta: pending });
      pending = '';
    };
    try {
      const outcome = await spec.provider.run(spec.request, (delta) => {
        text += delta;
        pending += delta;
        timer ??= setTimeout(flush, FLUSH_MS);
      });
      if (timer) clearTimeout(timer);
      flush();
      const citations: Citation[] = citationsIn(text, spec.sources);
      emit(ctx, userId, { type: 'ai_done', request_id: requestId, kind, text, citations, stop: outcome.stop, ...spec.extra });
    } catch (error) {
      if (timer) clearTimeout(timer);
      const reason = error instanceof AiProviderError ? error.reason : 'internal_error';
      if (!(error instanceof AiProviderError)) console.error('[ai] request failed', error);
      emit(ctx, userId, { type: 'ai_done', request_id: requestId, kind, text, citations: [], error: reason });
    } finally {
      const left = (running.get(userId) ?? 1) - 1;
      if (left > 0) running.set(userId, left);
      else running.delete(userId);
    }
  })();

  return requestId;
}

/** Run a short request to completion (translations, writing help). */
export async function complete(provider: AiProvider, request: AiRequest): Promise<{ text: string; stop: string }> {
  let text = '';
  try {
    const outcome = await provider.run(request, (delta) => {
      text += delta;
    });
    return { text: text.trim(), stop: outcome.stop };
  } catch (error) {
    if (error instanceof AiProviderError) fail('ai_provider_error', { detail: error.reason });
    throw error;
  }
}
