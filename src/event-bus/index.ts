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
/**
 * 通配订阅者。第三个参数 `originTs`（epoch ms）**只在跨进程回放时**由转发方给出：
 * 事件原本发生在另一个进程的那一刻。进程内正常 emit 恒为 undefined（= 就是此刻）。
 * 可选参数 ⇒ 既有的两参 handler 原样兼容。
 */
type WildcardHandler = (event: string, data: unknown, originTs?: number) => void;

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
   * 同步触发事件（fire-and-forget）。同步抛错和异步 rejection 都只记录当前 handler，
   * 不影响其他订阅者，也不升级成进程级未处理拒绝。
   */
  emit<K extends keyof AllEventMap>(event: K, data: AllEventMap[K]): void {
    this.dispatch(event as string, data, undefined);
  }

  /**
   * 类型擦除的转发用 emit：用于跨总线转发 / 聚合（每连接私有通道 tee 到全局观测总线、
   * 看板事件扇出聚合）。语义同 emit（fire-and-forget），仅放宽编译期类型约束。
   *
   * `originTs`（epoch ms，可选）：**跨进程回放**专用——事件原本发生的时刻。转发方给了它，
   * 通配订阅者（面板推送）才不会把一条历史事件显示成「刚刚发生」。进程内转发不传即可。
   */
  emitRaw(event: string, data: unknown, originTs?: number): void {
    this.dispatch(event, data, originTs);
  }

  /** emit / emitRaw 共用的分发体（同步 fire-and-forget）。 */
  private dispatch(key: string, data: unknown, originTs: number | undefined): void {
    const set = this.handlers.get(key);
    if (set) {
      for (const h of set) {
        try {
          const result = h(data);
          if (result && typeof (result as Promise<void>).then === 'function') {
            void (result as Promise<void>).catch((err) => {
              console.error(`[EventBus] async handler error on "${key}":`, err);
            });
          }
        } catch (err) {
          console.error(`[EventBus] handler error on "${key}":`, err);
        }
      }
    }
    // wildcard
    for (const wh of this.wildcardHandlers) {
      try {
        wh(key, data, originTs);
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
