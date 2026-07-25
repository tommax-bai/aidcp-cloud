import type { DeploymentTarget } from '../deployment-target.js';
import { RiskController } from './risk-controller.js';
import { isRiskStateNotOwnedError } from './ownership.js';
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
  /** 本进程的部署目标。仅用于驱逐告警的 writerTarget 标注。 */
  executionTarget?: DeploymentTarget;
  /** 条件写被拒（并发接管）后的驱逐告警。永不抛。 */
  onOwnershipAlert?: (info: {
    accountId: string;
    writerTarget: DeploymentTarget | null;
    ownerTarget: DeploymentTarget | null | undefined;
    kind: 'evicted_not_owned';
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
 * **「同一账号只有一个内存 controller」这句话的作用域**：它只在**单个进程内**成立。dev 与 ol 是两个
 * 进程、共用一个库，两边各有一份 Map，谁也看不见谁。归属已改为「跟随当次连接」
 * （change risk-target-follows-active-session）：同一账号分时接入 dev / ol 是正常的，握手会把
 * accounts.execution_target 更新为当前 target。跨进程止血靠：① 每 target 单实例（写者锁）；
 * ② risk_state 条件写 + 0 行作废先写方。本 Map 只是②的本地缓存。
 *
 * **本 Map 有失效路径**：条件写因并发接管被拒 ⇒ `handleNotOwned` 驱逐该账号 + 告警，
 * 下次解析从库重新加载状态与计数。归属切换后由握手侧强制重放计数（见 connection-runtime）。
 */
export class RiskControllerRegistry {
  private readonly controllers = new Map<string, Promise<RiskController>>();

  private readonly nurtureProvider?: AccountNurtureProvider;
  private readonly coldStartRampEnabled?: boolean;
  private readonly slowStartDisabled?: boolean;
  private readonly interactionBlockedProvider?: (accountId: string) => boolean;
  private readonly executionTarget: DeploymentTarget | null;
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
   * 取该账号的可写 controller（change risk-target-follows-active-session）。
   *
   * 归属已改为「跟随当次连接」，握手会把 accounts.execution_target 设成本 target，故此处不再有
   * 「非属主拒绝」这道闸——直接物化。真正的止血在写那一层：controller 的 saveState 走条件写，
   * 若写入前一瞬账号被另一连接接管（execution_target 已变），数据库返 0 行 → 抛
   * `RiskStateNotOwnedError` → 经 `onStateWriteRejected` 回调 `handleNotOwned` 驱逐 + 告警。
   */
  getWritableController(accountId: string): Promise<RiskController> {
    return this.materialize(accountId);
  }

  /**
   * 取 controller 用于**记账**（outbox apply）。与 getWritableController 同为物化——记账更不带谓词：
   * `risk_counters` 是 append-only 的既成事实账本（design D4「分裂的是写权限，不分裂的是事实」），
   * 归属刚切换时飞在半路的回执仍然要记进同一本账。
   */
  getControllerForAccounting(accountId: string): Promise<RiskController> {
    return this.materialize(accountId);
  }

  /**
   * 只读风险状态投影：直读 `risk_state`，**不物化 controller**（dashboard 列表用）。
   * 库里没有该账号的状态行 → null（诚实缺省，MUST NOT 编造一个 normal）。
   */
  async getReadOnlyState(accountId: string): Promise<RiskState | null> {
    return this.store.loadState(accountId);
  }

  /**
   * 条件写因并发接管被拒之后的唯一正确处理：**驱逐 + 告警**。
   * MUST NOT 重试同一次写、MUST NOT 立刻用同一份陈旧内存状态重建 controller
   * （重建发生在下一次真实解析时，那时会从库重新加载）。
   *
   * **接线点在 `createController`**：每个 controller 出厂即带 `onStateWriteRejected`，
   * 它的 `saveState` 一被数据库拒就直接回调到这里。MUST NOT 指望调用侧逐处 catch——
   * 真实链路上唯一的捕获者是验证码协调器，它只打一行日志，那样这条机制就是死代码：
   * 无告警、无驱逐，旧属主继续拿着一份从未落库的内存状态给该账号做准入判定直到重启。
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
        `原因 ${err.cause2}）：写入前一瞬账号已被另一连接接管。已驱逐本地缓存控制器；下次解析从库重读最新态。`,
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
      let retained!: Promise<RiskController>;
      retained = this.createController(accountId).catch((err) => {
        // 创建失败不是一个可用 controller。只驱逐当前这条 Promise，避免永久重放同一个 rejection；
        // 下一次真实请求会重新从 store 初始化/读库，但这里不做自动重试。
        if (this.controllers.get(accountId) === retained) this.controllers.delete(accountId);
        throw err;
      });
      p = retained;
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
      // 条件写被拒 → 驱逐 + 告警（design D3/D4 的「最后一道」）。见 handleNotOwned 的接线说明。
      onStateWriteRejected: (err) => {
        this.handleNotOwned(err);
      },
    });
  }

  private alert(info: {
    accountId: string;
    ownerTarget: DeploymentTarget | null | undefined;
    kind: 'evicted_not_owned';
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
