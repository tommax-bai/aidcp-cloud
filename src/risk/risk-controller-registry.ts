import { RiskController } from './risk-controller.js';
import type { QuotaProvider, RiskState, RiskStore } from './types.js';

/**
 * 每账号 RiskController 注册表（V1 task 9.1）：懒加载、**单写 PER ACCOUNT**。
 *
 * 现役路径（record / dispatcher）与 Web 写都经此取对应账号的 controller，保证单一来源
 * （绝不出现两个内存 controller 写同一 risk_state）。共享一个 RiskStore（按 accountId
 * 读写 risk_state / risk_counters）。registry 只路由，单写仍在各账号自己的 controller。
 */
export class RiskControllerRegistry {
  private readonly controllers = new Map<string, Promise<RiskController>>();

  constructor(
    private readonly store: RiskStore,
    private readonly clock?: () => number,
    /** 配额数字提供者（change safety-quota-config）：透传给每账号 controller，effectiveQuotas 热加载用。缺省回落写死默认。 */
    private readonly quotaProvider?: QuotaProvider,
  ) {}

  /** 取（或懒加载）某账号的 controller。create 会 load 持久化 state + 回放计数。 */
  getController(accountId: string): Promise<RiskController> {
    let p = this.controllers.get(accountId);
    if (!p) {
      p = RiskController.create({ accountId, store: this.store, clock: this.clock, quotaProvider: this.quotaProvider });
      this.controllers.set(accountId, p);
    }
    return p;
  }

  /** 列出指定账号的当前状态（dashboard；按 accounts 表的账号列表传入）。 */
  async listStates(accountIds: string[]): Promise<RiskState[]> {
    return Promise.all(accountIds.map((id) => this.getController(id).then((c) => c.getState())));
  }
}
