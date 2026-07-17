import { RiskController } from './risk-controller.js';
import type { AccountNurtureProvider, QuotaProvider, RiskState, RiskStore } from './types.js';

export interface RiskControllerRegistryOptions {
  /**
   * 账号养号事实提供者（change account-level-slow-start）：平台 / 慢启动起点 / 入库时刻的现读来源，
   * 原样透传给每账号 controller。缺省 → 不叠 clamp（零回归）。
   *
   * 取代了原先的 `nurtureMetaResolver`（change account-nurture-discipline-spine）。那条是
   * **构造期解析一次**的 async resolver，配 controller Map 永不驱逐 → 账号级开关写库成功、
   * HTTP 回 200、行为纹丝不动到重启。改成同步 provider 现读后，**registry 不需要任何缓存失效机制**
   * ——「Map 永不驱逐」从一个需要被绕开的坑变成一个不再相关的事实。
   */
  nurtureProvider?: AccountNurtureProvider;
  /** 冷启动爬坡的 env 全局旁路（默认 false=关）。透传给每账号 controller。 */
  coldStartRampEnabled?: boolean;
  /** 慢启动全局停用闸（change account-level-slow-start）。透传给每账号 controller。 */
  slowStartDisabled?: boolean;
}

/**
 * 每账号 RiskController 注册表（V1 task 9.1）：懒加载、**单写 PER ACCOUNT**。
 *
 * 现役路径（record / dispatcher）与 Web 写都经此取对应账号的 controller，保证单一来源
 * （绝不出现两个内存 controller 写同一 risk_state）。共享一个 RiskStore（按 accountId
 * 读写 risk_state / risk_counters）。registry 只路由，单写仍在各账号自己的 controller。
 */
export class RiskControllerRegistry {
  private readonly controllers = new Map<string, Promise<RiskController>>();

  private readonly nurtureProvider?: AccountNurtureProvider;
  private readonly coldStartRampEnabled?: boolean;
  private readonly slowStartDisabled?: boolean;

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
  }

  /** 取（或懒加载）某账号的 controller。create 会 load 持久化 state + 回放计数。 */
  getController(accountId: string): Promise<RiskController> {
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
    });
  }

  /** 列出指定账号的当前状态（dashboard；按 accounts 表的账号列表传入）。 */
  async listStates(accountIds: string[]): Promise<RiskState[]> {
    return Promise.all(accountIds.map((id) => this.getController(id).then((c) => c.getState())));
  }
}
