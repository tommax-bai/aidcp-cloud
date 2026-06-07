/**
 * 内存事件总线 — typed EventEmitter，用于模块间解耦通信。
 * fire-and-forget 语义，handler 异常不阻塞其他订阅者。
 */

import type { EventMap, RoleEventMap } from './types.js';

export type { EventMap } from './types.js';
export * from './types.js';

// 合并事件映射：同时支持旧的 EventMap 和新的 RoleEventMap
type AllEventMap = EventMap & RoleEventMap;

type Handler<T = unknown> = (data: T) => void | Promise<void>;
type WildcardHandler = (event: string, data: unknown) => void;

export class EventBus {
  private handlers = new Map<string, Set<Handler>>();
  private wildcardHandlers = new Set<WildcardHandler>();

  /**
   * 订阅事件，返回取消订阅函数。
   */
  on<K extends keyof AllEventMap>(event: K, handler: Handler<AllEventMap[K]>): () => void {
    const key = event as string;
    if (!this.handlers.has(key)) {
      this.handlers.set(key, new Set());
    }
    const set = this.handlers.get(key)!;
    set.add(handler as Handler);
    return () => { set.delete(handler as Handler); };
  }

  /**
   * 一次性订阅，触发后自动取消。
   */
  once<K extends keyof AllEventMap>(event: K, handler: Handler<AllEventMap[K]>): () => void {
    const wrapper: Handler<AllEventMap[K]> = (data) => {
      unsub();
      return handler(data);
    };
    const unsub = this.on(event, wrapper);
    return unsub;
  }

  /**
   * 手动取消订阅。
   */
  off<K extends keyof AllEventMap>(event: K, handler: Handler<AllEventMap[K]>): void {
    const set = this.handlers.get(event as string);
    if (set) {
      set.delete(handler as Handler);
    }
  }

  /**
   * 同步触发事件（fire-and-forget）。handler 的 Promise 被忽略，抛错不影响其他 handler。
   */
  emit<K extends keyof AllEventMap>(event: K, data: AllEventMap[K]): void {
    const key = event as string;
    const set = this.handlers.get(key);
    if (set) {
      for (const h of set) {
        try {
          h(data);
        } catch (err) {
          console.error(`[EventBus] handler error on "${key}":`, err);
        }
      }
    }
    // wildcard
    for (const wh of this.wildcardHandlers) {
      try {
        wh(key, data);
      } catch (err) {
        console.error(`[EventBus] wildcard handler error on "${key}":`, err);
      }
    }
  }

  /**
   * 异步触发事件，等待所有 handler resolve。
   */
  async emitAsync<K extends keyof AllEventMap>(event: K, data: AllEventMap[K]): Promise<void> {
    const key = event as string;
    const set = this.handlers.get(key);
    const promises: Promise<void>[] = [];
    if (set) {
      for (const h of set) {
        try {
          const result = h(data);
          if (result && typeof (result as Promise<void>).then === 'function') {
            promises.push(result as Promise<void>);
          }
        } catch (err) {
          console.error(`[EventBus] handler error on "${key}":`, err);
        }
      }
    }
    // wildcard
    for (const wh of this.wildcardHandlers) {
      try {
        wh(key, data);
      } catch (err) {
        console.error(`[EventBus] wildcard handler error on "${key}":`, err);
      }
    }
    if (promises.length > 0) {
      await Promise.all(promises);
    }
  }

  /**
   * 通配监听所有事件。
   */
  onAny(handler: WildcardHandler): () => void {
    this.wildcardHandlers.add(handler);
    return () => { this.wildcardHandlers.delete(handler); };
  }

  /**
   * 移除所有监听器。
   */
  removeAllListeners(): void {
    this.handlers.clear();
    this.wildcardHandlers.clear();
  }
}
