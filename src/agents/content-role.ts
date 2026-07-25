/**
 * ContentRole —— content 侧事件驱动角色的薄壳基类（change cloud-coupling-phase5 · P5-2）。
 *
 * 与 automation 的 `BaseRole` 是**同一份实现的两个外壳**：判定逻辑（人设解析 / 模型补全 / 日志 /
 * 超时归一）全在 `src/kernel/role-runtime.ts` 的函数里，两边各自只做「存字段 + 转调」。
 * MUST NOT 在这里另写一份——同一段逻辑长两处，漂了没有任何机械手段会说话。
 *
 * 与 `BaseRole` 的**唯一实质差别**，也是本文件存在的全部理由：
 *   - 事件总线只收 kernel 的 {@link RoleEventSource}（**只订阅、不发布**），不收 automation 的
 *     进程内总线实现；
 *   - 角色名是裸 `string`，不标注 automation 的 `RoleName` 联合。
 *     那道闸没有丢：`test/agents/content-role-names.test.ts` 在测试侧做编译期断言
 *     （`src/` 才是边界闸的扫描范围，测试里跨引用不造边）。写错一个字母仍然编译红。
 *
 * 拆仓后本文件随四个 content 角色进 aidcp-content，届时它引的全是 kernel，零跨仓依赖。
 */
import type { Soul } from '../kernel/soul-types.js';
import type { TextCompletionPort } from '../kernel/llm-contract.js';
import {
  positiveTimeoutMs,
  resolveSoul,
  roleLog,
  runRoleCompletion,
  type RoleEventSource,
} from '../kernel/role-runtime.js';

export interface ContentRoleOptions {
  /** 只订阅、不发布。automation 的进程内总线结构上满足它。 */
  eventBus: RoleEventSource;
  /**
   * 人设注入。两种形态至少给一个：
   * - getSoul：按当前账号解析的取值口（热加载，改人设即时生效）——生产路径；
   * - soul：构造期快照（向后兼容旧构造 / 测试桩）。
   * 两者皆给时 getSoul 优先；皆缺则读 `this.soul` 时抛（构造契约违背，诚实失败不静默）。
   */
  soul?: Soul;
  getSoul?: () => Soul;
  llm?: TextCompletionPort;
  /** 可选 per-role 模型硬 deadline；缺省沿用共享客户端构造默认。 */
  llmTimeoutMs?: number;
}

export abstract class ContentRole {
  abstract readonly roleName: string;
  protected readonly eventBus: RoleEventSource;
  private readonly soulSnapshot?: Soul;
  private readonly getSoulFn?: () => Soul;
  protected readonly llm?: TextCompletionPort;
  private readonly llmTimeoutMs?: number;

  constructor(options: ContentRoleOptions) {
    this.eventBus = options.eventBus;
    this.soulSnapshot = options.soul;
    this.getSoulFn = options.getSoul;
    this.llm = options.llm;
    this.llmTimeoutMs = positiveTimeoutMs(options.llmTimeoutMs);
  }

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

  protected log(msg: string): void {
    roleLog(this.roleName, msg);
  }

  protected decide(prompt: string): Promise<string> {
    return runRoleCompletion(prompt, {
      llm: this.llm,
      roleName: this.roleName,
      ...(this.llmTimeoutMs !== undefined ? { llmTimeoutMs: this.llmTimeoutMs } : {}),
    });
  }
}
