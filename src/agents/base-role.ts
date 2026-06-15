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

  /** 角色统一日志前缀，便于在服务日志中观测各角色行为。 */
  protected log(msg: string): void {
    console.log(`[${this.roleName}] ${msg}`);
  }

  /**
   * 调用 LLM 做一次决策，并打印可观测日志（角色 / LLM 原始判定 / 失败原因）。
   * 设置 AIDCP_LLM_DEBUG=true 时额外打印完整 prompt。各 LLM 角色统一用此方法
   * 替代直接调用 this.llm.complete，便于分析“服务在做什么、判得对不对”。
   */
  protected async decide(prompt: string): Promise<string> {
    if (!this.llm) throw new Error(`${this.roleName} 需要 LlmClient`);
    if (process.env.AIDCP_LLM_DEBUG === 'true') {
      this.log(`prompt ↓\n${prompt}`);
    }
    let raw: string;
    try {
      raw = await this.llm.complete(prompt);
    } catch (err) {
      this.log(`LLM 调用失败：${(err as Error).message}`);
      throw err;
    }
    this.log(`LLM 判定 → ${oneLinePreview(raw, 240)}`);
    return raw;
  }
}

/** 把多行文本压成单行并截断，用于日志预览。 */
function oneLinePreview(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}
