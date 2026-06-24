/**
 * BaseRole — 事件驱动角色的抽象基类。
 *
 * 新架构中每个角色继承 BaseRole，通过 EventBus 订阅/发布事件实现协作。
 * 取代旧的黑板模式 BaseAgent（后者仍保留用于兼容）。
 */

import type { EventBus } from '../event-bus/index.js';
import type { RoleEventMap, RoleName } from '../event-bus/types.js';
import type { Soul } from '../soul/types.js';
import type { LlmCallOpts } from '../llm/qwen.js';

/** 角色侧只需文本补全（保留弱接口，便于测试桩只实现 complete）；opts 可选，按角色解析模型/温度。 */
type RoleLlm = { complete(prompt: string, opts?: LlmCallOpts): Promise<string> };

export interface RoleOptions {
  eventBus: EventBus;
  /**
   * 人设注入（change account-persona-config）。两种形态，至少给一个：
   * - getSoul：派发时按当前账号解析的取值口（热加载，PUT 人设后即时生效）——生产路径；
   * - soul：构造期人设快照（向后兼容旧构造 / 测试桩）。
   * 两者皆给时 getSoul 优先；皆缺则读 `this.soul` 时抛（构造契约违背，诚实失败不静默）。
   */
  soul?: Soul;
  getSoul?: () => Soul;
  llm?: RoleLlm;
}

export abstract class BaseRole {
  abstract readonly roleName: RoleName;
  protected readonly eventBus: EventBus;
  private readonly soulSnapshot?: Soul;
  private readonly getSoulFn?: () => Soul;
  protected readonly llm?: RoleLlm;

  constructor(options: RoleOptions) {
    this.eventBus = options.eventBus;
    this.soulSnapshot = options.soul;
    this.getSoulFn = options.getSoul;
    this.llm = options.llm;
  }

  /**
   * 人设取值口：注入 getSoul 优先（热加载，按当前账号解析），否则回落构造期快照。
   * getter 透明替换原 `protected readonly soul` 字段——各 agent `this.soul.xxx` 读法零改动。
   */
  protected get soul(): Soul {
    if (this.getSoulFn) return this.getSoulFn();
    if (this.soulSnapshot) return this.soulSnapshot;
    throw new Error(`${this.roleName} 缺少人设注入（soul / getSoul 至少给一个）`);
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
      // 带上角色键（browse: 前缀）→ 客户端按角色解析模型/温度（change console-role-model-config）。
      raw = await this.llm.complete(prompt, { role: `browse:${this.roleName}` });
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
