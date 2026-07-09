type WatchHandler<T = unknown> = (value: T, ctx: PipelineContext<any>) => void | Promise<void>;
type Unsubscribe = () => void;

export class PipelineContext<T extends Record<string, any>> {
  private state: Partial<T> = {};
  /**
   * 中止标记（change parallel-rewrite-drafts 僵尸轮拦截）：本轮对外收敛（含超时判 failed）后置位。
   * 管线超时不取消在途角色链——超时后角色仍会接力；落库/发卡等对外副作用点 MUST 检查此位，
   * 已对外报终态的轮次绝不再产生第二结局（一次触发两个结局 = 静默假成功变体）。
   */
  private aborted = false;

  /** 置中止位（编排器在本轮收敛后调用；不可逆）。 */
  markAborted(): void {
    this.aborted = true;
  }

  /** 本轮是否已中止/收敛（副作用点检查用）。 */
  isAborted(): boolean {
    return this.aborted;
  }
  private watchers: Map<string, Array<{ handler: WatchHandler; once: boolean }>> = new Map();
  private waitAllGroups: Array<{
    keys: string[];
    ready: Set<string>;
    handler: (values: any, ctx: PipelineContext<T>) => void | Promise<void>;
    once: boolean;
  }> = [];

  /** 写入字段，触发所有 watch 该字段的回调 */
  write<K extends keyof T & string>(key: K, value: T[K]): void {
    this.state[key] = value;
    // 触发单字段 watchers
    const handlers = this.watchers.get(key);
    if (handlers) {
      const toRemove: number[] = [];
      for (let i = 0; i < handlers.length; i++) {
        const { handler, once } = handlers[i];
        try {
          handler(value, this);
        } catch (err) {
          // handler 异常不阻塞其他 watcher
          console.error(`[PipelineContext] watch handler error for "${key}":`, err);
        }
        if (once) toRemove.push(i);
      }
      // 移除 once handlers (倒序)
      for (let i = toRemove.length - 1; i >= 0; i--) {
        handlers.splice(toRemove[i], 1);
      }
    }
    // 触发 watchAll groups
    for (const group of this.waitAllGroups) {
      if (group.keys.includes(key)) {
        group.ready.add(key);
        if (group.ready.size === group.keys.length) {
          const values: Record<string, unknown> = {};
          for (const k of group.keys) {
            values[k] = this.state[k as keyof T];
          }
          try {
            group.handler(values, this);
          } catch (err) {
            console.error(`[PipelineContext] watchAll handler error:`, err);
          }
          if (group.once) {
            group.ready.clear(); // 防止重复触发
          }
        }
      }
    }
  }

  /** 注册 watch：单字段变化时触发 */
  watch<K extends keyof T & string>(key: K, handler: WatchHandler<T[K]>, options?: { once?: boolean }): Unsubscribe {
    if (!this.watchers.has(key)) {
      this.watchers.set(key, []);
    }
    const entry = { handler: handler as WatchHandler, once: options?.once ?? false };
    this.watchers.get(key)!.push(entry);
    // 如果字段已有值，立即触发
    if (key in this.state && this.state[key] !== undefined) {
      try { handler(this.state[key] as T[K], this); } catch { /* noop */ }
      if (entry.once) {
        const arr = this.watchers.get(key)!;
        const idx = arr.indexOf(entry);
        if (idx >= 0) arr.splice(idx, 1);
      }
    }
    return () => {
      const arr = this.watchers.get(key);
      if (arr) {
        const idx = arr.indexOf(entry);
        if (idx >= 0) arr.splice(idx, 1);
      }
    };
  }

  /** 注册 watchAll：多字段全部就绪时触发（AND 条件） */
  watchAll<K extends keyof T & string>(
    keys: K[],
    handler: (values: Pick<T, K>, ctx: PipelineContext<T>) => void | Promise<void>,
    options?: { once?: boolean }
  ): Unsubscribe {
    const ready = new Set<string>();
    // 检查已有字段
    for (const k of keys) {
      if (k in this.state && this.state[k] !== undefined) {
        ready.add(k);
      }
    }
    const group = { keys: [...keys], ready, handler: handler as any, once: options?.once ?? false };
    this.waitAllGroups.push(group);
    // 如果所有字段已就绪，立即触发
    if (ready.size === keys.length) {
      const values: Record<string, unknown> = {};
      for (const k of keys) values[k] = this.state[k];
      try { handler(values as Pick<T, K>, this); } catch { /* noop */ }
      if (group.once) {
        const idx = this.waitAllGroups.indexOf(group);
        if (idx >= 0) this.waitAllGroups.splice(idx, 1);
        return () => {};
      }
    }
    return () => {
      const idx = this.waitAllGroups.indexOf(group);
      if (idx >= 0) this.waitAllGroups.splice(idx, 1);
    };
  }

  /** 读取字段当前值 */
  get<K extends keyof T>(key: K): T[K] | undefined {
    return this.state[key] as T[K] | undefined;
  }

  /** Promise 形式等待字段就绪 */
  waitFor<K extends keyof T & string>(key: K, timeoutMs?: number): Promise<T[K]> {
    // 如果已有值直接返回
    if (key in this.state && this.state[key] !== undefined) {
      return Promise.resolve(this.state[key] as T[K]);
    }
    return new Promise<T[K]>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const unsub = this.watch(key, (value) => {
        if (timer) clearTimeout(timer);
        resolve(value);
      }, { once: true });
      if (timeoutMs && timeoutMs > 0) {
        timer = setTimeout(() => {
          unsub();
          reject(new Error(`waitFor("${key}") timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
    });
  }

  /** 当前管道状态快照 */
  snapshot(): Partial<T> {
    return { ...this.state };
  }

  /** 重置上下文 */
  reset(): void {
    this.state = {};
    this.watchers.clear();
    this.waitAllGroups = [];
  }
}
