/**
 * BaseRole — 事件驱动角色的抽象基类。
 *
 * 新架构中每个角色继承 BaseRole，通过 EventBus 订阅/发布事件实现协作。
 * 取代旧的黑板模式 BaseAgent（后者仍保留用于兼容）。
 */

import type { EventBus } from '../event-bus/index.js';
import type { RoleEventMap, RoleName } from '../event-bus/types.js';
import type { Soul } from '../soul/types.js';

export interface RoleOptions {
  eventBus: EventBus;
  soul: Soul;
  llm?: { complete(prompt: string): Promise<string> };
}

export abstract class BaseRole {
  abstract readonly roleName: RoleName;
  protected readonly eventBus: EventBus;
  protected readonly soul: Soul;
  protected readonly llm?: { complete(prompt: string): Promise<string> };

  constructor(options: RoleOptions) {
    this.eventBus = options.eventBus;
    this.soul = options.soul;
    this.llm = options.llm;
  }

  /** 子类实现：注册事件订阅 */
  abstract subscribe(): void;

  /** 子类实现：取消事件订阅 */
  abstract unsubscribe(): void;

  /** 辅助方法：发布事件 */
  protected emit<K extends keyof RoleEventMap>(event: K, payload: RoleEventMap[K]): void {
    this.eventBus.emit(event, payload as any);
  }
}
