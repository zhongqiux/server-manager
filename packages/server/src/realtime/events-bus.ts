import type { SseEvent } from '@sm/shared';

type Listener = (event: SseEvent) => void;

const listeners = new Set<Listener>();

export function subscribeGlobal(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publishGlobal(event: SseEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // 单个订阅者异常不影响其他订阅者
    }
  }
}