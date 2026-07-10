import { RiskController } from './risk-controller.js';
import type { QuotaProvider, RiskState, RiskStore } from './types.js';

/** 账号养号元数据（change account-nurture-discipline-spine）：冷启动配额爬坡的输入。 */
export interface NurtureMeta {
  /** 账号创建时刻（epoch ms）——按此现算账号年龄。 */
  createdAt: number;
  /** 账号平台——facebook 用更保守冷启动曲线。 */
  platform: string;
}

export interface RiskControllerRegistryOptions {
  /**
   * 懒解析某账号的养号元数据（created_at + platform），供冷启动 clamp。只在首次建 controller 时解析一次
   * （created_at 不变、controller 进程内长驻）。返回 null / 抛错 → 该账号不叠冷启动（安全回退、零回归）。
   */
  nurtureMetaResolver?: (accountId: string) => Promise<NurtureMeta | null>;
  /** 冷启动爬坡旁路开关（默认 true=开，安全方向）。透传给每账号 controller。 */
  coldStartRampEnabled?: boolean;
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

  private readonly nurtureMetaResolver?: RiskControllerRegistryOptions['nurtureMetaResolver'];
  private readonly coldStartRampEnabled?: boolean;

  constructor(
    private readonly store: RiskStore,
    private readonly clock?: () => number,
    /** 配额数字提供者（change safety-quota-config）：透传给每账号 controller，effectiveQuotas 热加载用。缺省回落写死默认。 */
    private readonly quotaProvider?: QuotaProvider,
    /** 养号冷启动配置（change account-nurture-discipline-spine）。缺省 → 不叠冷启动（零回归）。 */
    options?: RiskControllerRegistryOptions,
  ) {
    this.nurtureMetaResolver = options?.nurtureMetaResolver;
    this.coldStartRampEnabled = options?.coldStartRampEnabled;
  }

  /** 取（或懒加载）某账号的 controller。create 会 load 持久化 state + 回放计数 + 解析养号元数据。 */
  getController(accountId: string): Promise<RiskController> {
    let p = this.controllers.get(accountId);
    if (!p) {
      p = this.createController(accountId);
      this.controllers.set(accountId, p);
    }
    return p;
  }

  private async createController(accountId: string): Promise<RiskController> {
    // 养号元数据只在建 controller 时解析一次；解析失败 → 不叠冷启动（安全回退、绝不阻断）。
    const meta = this.nurtureMetaResolver
      ? await this.nurtureMetaResolver(accountId).catch(() => null)
      : null;
    return RiskController.create({
      accountId,
      store: this.store,
      clock: this.clock,
      quotaProvider: this.quotaProvider,
      createdAt: meta?.createdAt,
      platform: meta?.platform,
      coldStartRampEnabled: this.coldStartRampEnabled,
    });
  }

  /** 列出指定账号的当前状态（dashboard；按 accounts 表的账号列表传入）。 */
  async listStates(accountIds: string[]): Promise<RiskState[]> {
    return Promise.all(accountIds.map((id) => this.getController(id).then((c) => c.getState())));
  }
}
