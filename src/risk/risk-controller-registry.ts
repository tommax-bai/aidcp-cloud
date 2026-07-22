import type { DeploymentTarget } from '../deployment-target.js';
import { RiskController } from './risk-controller.js';
import {
  RiskStateNotOwnedError,
  isRiskStateNotOwnedError,
  type AccountOwnershipPort,
  type OwnershipMode,
} from './ownership.js';
import type { AccountNurtureProvider, QuotaProvider, RiskState, RiskStore } from './types.js';

export interface RiskControllerRegistryOptions {
  /**
   * 账号养号事实提供者（change account-level-slow-start）：平台 / 慢启动起点 / 入库时刻的现读来源，
   * 原样透传给每账号 controller。缺省 → 不叠 clamp（零回归）。
   */
  nurtureProvider?: AccountNurtureProvider;
  /** 冷启动爬坡的 env 全局旁路（默认 false=关）。透传给每账号 controller。 */
  coldStartRampEnabled?: boolean;
  /** 慢启动全局停用闸（change account-level-slow-start）。透传给每账号 controller。 */
  slowStartDisabled?: boolean;
  /** 记账 fail-closed 现读（change risk-state-cross-process-integrity）。透传给每账号 controller。 */
  interactionBlockedProvider?: (accountId: string) => boolean;
  /** 本进程的部署目标。缺省 → 归属模式恒为 'off'（fail-closed 时风控写路径本就不该启用）。 */
  executionTarget?: DeploymentTarget;
  /** 归属强制模式，与 PgRiskStore 同源。缺省 'off'。 */
  ownershipMode?: OwnershipMode;
  /** 归属事实的窄读口（实现方是 account-store；见 AccountOwnershipPort 的跨边界说明）。 */
  ownershipPort?: AccountOwnershipPort;
  /** 驱逐 / 归属冲突告警。永不抛。 */
  onOwnershipAlert?: (info: {
    accountId: string;
    writerTarget: DeploymentTarget | null;
    ownerTarget: DeploymentTarget | null | undefined;
    kind: 'evicted_not_owned' | 'read_only_denied';
    detail: string;
  }) => void;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

/**
 * 每账号 RiskController 注册表（V1 task 9.1）：懒加载、**单写 PER ACCOUNT**。
 *
 * 现役路径（记账 / dispatcher）与 Web 写都经此取对应账号的 controller。registry 只路由，
 * 单写仍在各账号自己的 controller。共享一个 RiskStore（按 accountId 读写 risk_state / risk_counters）。
 *
 * **「同一账号只有一个内存 controller」这句话的作用域**（change risk-state-cross-process-integrity 校正）：
 * 它只在**单个进程内**成立。dev 与 ol 是两个进程、共用一个库，两边各有一份 Map，谁也看不见谁。
 * 跨进程的单写靠另外三条机制合起来保证：① 每 target 单实例（写者锁）；② 账号归属唯一
 * （accounts.execution_target）；③ risk_state 条件写 + 0 行诚实拒绝。本 Map 只是③的本地缓存。
 *
 * **本 Map 现在有失效路径了**（原注释「永不驱逐是不再相关的事实」只对养号配置成立，
 * 对 state / counter 从来不成立）：条件写因非属主被拒 ⇒ `handleNotOwned` 驱逐该账号 + 告警，
 * 下次解析从库重新加载状态与计数。归属占位成功 / 归属变更后也 MUST 强制重放计数。
 */
export class RiskControllerRegistry {
  private readonly controllers = new Map<string, Promise<RiskController>>();

  private readonly nurtureProvider?: AccountNurtureProvider;
  private readonly coldStartRampEnabled?: boolean;
  private readonly slowStartDisabled?: boolean;
  private readonly interactionBlockedProvider?: (accountId: string) => boolean;
  private readonly executionTarget: DeploymentTarget | null;
  private readonly ownershipMode: OwnershipMode;
  private readonly ownershipPort?: AccountOwnershipPort;
  private readonly onOwnershipAlert?: RiskControllerRegistryOptions['onOwnershipAlert'];
  private readonly logger?: Pick<Console, 'log' | 'warn' | 'error'>;

  constructor(
    private readonly store: RiskStore,
    private readonly clock?: () => number,
    /** 配额数字提供者（change safety-quota-config）：透传给每账号 controller，effectiveQuotas 热加载用。缺省回落写死默认。 */
    private readonly quotaProvider?: QuotaProvider,
    /** 养号冷启动配置（change account-nurture-discipline-spine → account-level-slow-start）。缺省 → 不叠 clamp（零回归）。 */
    options?: RiskControllerRegistryOptions,
  ) {
    this.nurtureProvider = options?.nurtureProvider;
    this.coldStartRampEnabled = options?.coldStartRampEnabled;
    this.slowStartDisabled = options?.slowStartDisabled;
    this.interactionBlockedProvider = options?.interactionBlockedProvider;
    this.executionTarget = options?.executionTarget ?? null;
    this.ownershipMode = options?.executionTarget ? options?.ownershipMode ?? 'off' : 'off';
    this.ownershipPort = options?.ownershipPort;
    this.onOwnershipAlert = options?.onOwnershipAlert;
    this.logger = options?.logger;
  }

  /**
   * @deprecated 请改用 `getWritableController`（要写权）或 `getReadOnlyState`（只读投影）。
   * 保留为薄别名，避免一次性改动全部历史调用点时把语义判断藏进 diff 里。
   */
  getController(accountId: string): Promise<RiskController> {
    return this.getWritableController(accountId);
  }

  /**
   * 取该账号的**可写** controller：先校验本 target 是否为属主，非属主在 enforce 模式下直接抛
   * `RiskStateNotOwnedError`（不物化、不缓存）。
   *
   * 观察模式下不拒绝，但每一次本会被拒的解析都留一条告警——观察模式的意义是「先证明零争用」，
   * 不是「先假装没事」。
   */
  async getWritableController(accountId: string): Promise<RiskController> {
    if (this.ownershipMode !== 'off' && this.ownershipPort && this.executionTarget) {
      const owner = await this.ownershipPort.getExecutionTarget(accountId);
      if (owner !== this.executionTarget) {
        const detail =
          `账号 ${accountId} 的归属 target 是 ${owner ?? '<未归属>'}，本进程是 ${this.executionTarget}；` +
          `请在 ${owner ?? '归属确定后的'} 后台操作，或先在旧属主停止该账号自动化再改归属。`;
        this.alert({ accountId, ownerTarget: owner, kind: 'read_only_denied', detail });
        if (this.ownershipMode === 'enforce') {
          this.controllers.delete(accountId);
          throw new RiskStateNotOwnedError(
            accountId,
            this.executionTarget,
            owner,
            owner ? 'owned_by_other' : 'unowned',
          );
        }
      }
    }
    return this.materialize(accountId);
  }

  /**
   * 取 controller 用于**记账**（outbox apply）——刻意**不过归属闸**。
   *
   * 理由：`risk_counters` 是 append-only 的既成事实账本，按 design D4「分裂的是写权限，不分裂的是
   * 事实」，它不带属主谓词。归属刚变更时飞在半路的回执仍然要记进同一本账；用归属闸挡住它，
   * 丢的是真实发生过的动作，而后续 canDo 会据此以为尚有余量——正是本 change 要消灭的那类缺陷。
   */
  getControllerForAccounting(accountId: string): Promise<RiskController> {
    return this.materialize(accountId);
  }

  /** 本 target 是否对该账号有写权。归属模式为 off 时恒为 true（单进程语义，零回归）。 */
  async isWritable(accountId: string): Promise<boolean> {
    if (this.ownershipMode === 'off' || !this.ownershipPort || !this.executionTarget) return true;
    return (await this.ownershipPort.getExecutionTarget(accountId)) === this.executionTarget;
  }

  /**
   * 只读风险状态投影：直读 `risk_state`，**不物化 controller**。
   * 面板对非属主账号只能走这条路——物化即意味着这个进程凭一份陈旧快照随时可能写回去。
   * 库里没有该账号的状态行 → null（诚实缺省，MUST NOT 编造一个 normal）。
   */
  async getReadOnlyState(accountId: string): Promise<RiskState | null> {
    return this.store.loadState(accountId);
  }

  /**
   * 条件写因非属主被拒之后的唯一正确处理：**驱逐 + 告警**。
   * MUST NOT 重试同一次写、MUST NOT 立刻用同一份陈旧内存状态重建 controller
   * （重建发生在下一次真实解析时，那时会从库重新加载）。
   */
  handleNotOwned(err: unknown): boolean {
    if (!isRiskStateNotOwnedError(err)) return false;
    this.controllers.delete(err.accountId);
    this.alert({
      accountId: err.accountId,
      ownerTarget: err.actualTarget,
      kind: 'evicted_not_owned',
      detail:
        `本进程（${err.expectedTarget}）对账号 ${err.accountId} 的 risk_state 写被数据库拒绝（影响 0 行，` +
        `原因 ${err.cause2}）。已驱逐本地缓存控制器；该账号的自动化 MUST 在真实属主上运行。`,
    });
    return true;
  }

  /** 手动驱逐（归属变更后由运维口调用）。返回是否真的驱逐了缓存项。 */
  evict(accountId: string): boolean {
    return this.controllers.delete(accountId);
  }

  /** 当前已物化的账号（对账只对这些做，账号量级几十）。 */
  materializedAccountIds(): string[] {
    return [...this.controllers.keys()];
  }

  /** 已物化则同步返回，未物化返回 undefined（对账用，绝不因对账而物化新 controller）。 */
  peek(accountId: string): Promise<RiskController> | undefined {
    return this.controllers.get(accountId);
  }

  private materialize(accountId: string): Promise<RiskController> {
    let p = this.controllers.get(accountId);
    if (!p) {
      p = this.createController(accountId);
      this.controllers.set(accountId, p);
    }
    return p;
  }

  private async createController(accountId: string): Promise<RiskController> {
    return RiskController.create({
      accountId,
      store: this.store,
      clock: this.clock,
      quotaProvider: this.quotaProvider,
      nurtureProvider: this.nurtureProvider,
      coldStartRampEnabled: this.coldStartRampEnabled,
      slowStartDisabled: this.slowStartDisabled,
      interactionBlockedProvider: this.interactionBlockedProvider,
    });
  }

  private alert(info: {
    accountId: string;
    ownerTarget: DeploymentTarget | null | undefined;
    kind: 'evicted_not_owned' | 'read_only_denied';
    detail: string;
  }): void {
    this.logger?.warn?.(`[risk-registry] ${info.detail}`);
    try {
      this.onOwnershipAlert?.({ ...info, writerTarget: this.executionTarget });
    } catch {
      // 告警链路故障绝不反噬风控解析路径。
    }
  }

  /** 列出指定账号的当前状态（dashboard）。只读语义 → 走投影，绝不为看一眼而物化可写 controller。 */
  async listStates(accountIds: string[]): Promise<RiskState[]> {
    const states = await Promise.all(accountIds.map((id) => this.getReadOnlyState(id)));
    return states.filter((s): s is RiskState => s != null);
  }
}
