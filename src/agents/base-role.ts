/**
 * BaseRole — 事件驱动角色的抽象基类（automation 侧）。
 *
 * 新架构中每个角色继承 BaseRole，通过 EventBus 订阅/发布事件实现协作。
 * 取代旧的黑板模式 BaseAgent（后者仍保留用于兼容）。
 *
 * **实现只有一份**（change cloud-coupling-phase5 P5-2）：人设解析 / 模型补全 / 日志 / 超时归一
 * 这几段无状态逻辑已提进 `src/kernel/role-runtime.ts`，本类与 content 侧的 `ContentRole`
 * 都只是它的外壳。MUST NOT 在任一壳里另写一份——同一段逻辑长两处，漂了没有任何机械手段会说话。
 *
 * 本类保留的、`ContentRole` 没有的两样：完整的进程内 `EventBus`（含 `emit`）与
 * `RoleName` 联合标注。automation 侧角色确实要往总线回灌事件，故这两样留在这里。
 */

import type { EventBus } from '../event-bus/index.js';
import type { RoleEventMap, RoleName } from '../event-bus/types.js';
import type { Soul } from '../kernel/soul-types.js';
import type { TextCompletionPort } from '../kernel/llm-contract.js';
import { positiveTimeoutMs, resolveSoul, roleLog, runRoleCompletion } from '../kernel/role-runtime.js';

/** 角色侧只需文本补全（保留弱接口，便于测试桩只实现 complete）；opts 可选，按角色解析模型/温度。 */
/** 收口到 kernel 的 TextCompletionPort：本文件此前私藏第三份逐字相同的声明。 */
type RoleLlm = TextCompletionPort;

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
  /** 可选 per-role 模型硬 deadline；缺省继续使用共享客户端构造默认。 */
  llmTimeoutMs?: number;
}

export abstract class BaseRole {
  abstract readonly roleName: RoleName;
  protected readonly eventBus: EventBus;
  private readonly soulSnapshot?: Soul;
  private readonly getSoulFn?: () => Soul;
  protected readonly llm?: RoleLlm;
  private readonly llmTimeoutMs?: number;

  constructor(options: RoleOptions) {
    this.eventBus = options.eventBus;
    this.soulSnapshot = options.soul;
    this.getSoulFn = options.getSoul;
    this.llm = options.llm;
    this.llmTimeoutMs = positiveTimeoutMs(options.llmTimeoutMs);
  }

  /**
   * 人设取值口：注入 getSoul 优先（热加载，按当前账号解析），否则回落构造期快照。
   * getter 透明替换原 `protected readonly soul` 字段——各 agent `this.soul.xxx` 读法零改动。
   * 缺失时抛出的判据与理由见 kernel `resolveSoul` 的文档（副本陈旧那类降级在入口闸收敛，
   * 这里的抛出只覆盖「会话中途被真实解绑」这条防御路径）。
   */
  protected get soul(): Soul {
    return resolveSoul(
      { ...(this.soulSnapshot ? { soul: this.soulSnapshot } : {}), ...(this.getSoulFn ? { getSoul: this.getSoulFn } : {}) },
      this.roleName,
    );
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
    roleLog(this.roleName, msg);
  }

  /**
   * 调用 LLM 做一次决策，并打印可观测日志（角色 / LLM 原始判定 / 失败原因）。
   * 设置 AIDCP_LLM_DEBUG=true 时额外打印完整 prompt。各 LLM 角色统一用此方法
   * 替代直接调用 this.llm.complete，便于分析“服务在做什么、判得对不对”。
   */
  protected decide(prompt: string): Promise<string> {
    return runRoleCompletion(prompt, {
      llm: this.llm,
      roleName: this.roleName,
      ...(this.llmTimeoutMs !== undefined ? { llmTimeoutMs: this.llmTimeoutMs } : {}),
    });
  }
}
