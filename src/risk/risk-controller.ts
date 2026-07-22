// 注意：本 import 指向 `src/config-mirror-freshness.ts`（src 根、无依赖的中立模块），**不是**
// `src/config/`。`src/risk/` 对 `src/config/` 的 import 必须保持为 0——那条既成事实正是定稿方案
// §11.4 要求一把四类限频配置判给自动化服务的依据，也有静态断言测试守着（test/config/module-boundary）。
import { isMirrorStale } from '../config-mirror-freshness.js';
import { coldStartDailyCap } from './cold-start-planner.js';
import { deriveWindowQuotas, deriveWindowQuotasFromDaily, minWindowQuotas, scaleWindowQuotas, zeroInteractionQuotas } from './quotas.js';
import { createRiskState, RiskStateMachine } from './risk-state-machine.js';
import { SlidingWindowCounter, WINDOW_MS } from './sliding-window-counter.js';
import { RISK_ACTIONS } from './types.js';
import type { AccountNurtureProvider, QuotaProvider, RiskAction, RiskQuotaLevel, RiskSignal, RiskState, RiskStatus, RiskStore, RiskWindow, WindowQuotas } from './types.js';

/**
 * 支持慢启动的平台白名单（change account-level-slow-start，design D12）：第一版只放 facebook /
 * xiaohongshu，视频号如实拒绝。理由：applyColdStartClamp 的平台分叉（视频号走 XHS 曲线 + dm_reply
 * 豁免、FB 专属曲线）因默认关在生产几乎从未执行过——开关一放开就是首次批量生效。零成本的风险削减。
 */
export const SLOW_START_PLATFORMS: readonly string[] = ['facebook', 'xiaohongshu'];

function supportsSlowStart(platform: string | null | undefined): platform is string {
  return platform != null && SLOW_START_PLATFORMS.includes(platform);
}

/** 逐位比较两份配额：clamped 是否至少在一处严格小于 base（即 clamp 真收紧了）。 */
function isStrictlyTighter(clamped: WindowQuotas, base: WindowQuotas): boolean {
  const windows: RiskWindow[] = ['minute', 'hour', 'day'];
  return windows.some((w) => RISK_ACTIONS.some((a) => clamped[w][a] < base[w][a]));
}

export interface RiskControllerOptions {
  accountId?: string;
  quotaLevel?: RiskQuotaLevel;
  clock?: () => number;
  store?: RiskStore;
  initialState?: RiskState;
  minViewsForLikeRatio?: number;
  /**
   * 配额数字提供者（change safety-quota-config）：effectiveQuotas 的基准三档数字来源。
   * 缺省（不注入）→ 回落 deriveWindowQuotas 写死默认（与历史行为逐位一致，零回归）。只读、永不抛。
   */
  quotaProvider?: QuotaProvider;
  /**
   * 账号养号事实提供者（change account-level-slow-start）：平台 / 慢启动起点 / 入库时刻的**现读**来源。
   * 由 AccountStore 实现（同步读内存镜像）。缺省（不注入）→ 无 anchor、不叠 clamp（零回归）。
   *
   * 取代了原先构造期冻结的 createdAt / platform 两个 readonly 字段（change
   * account-nurture-discipline-spine 遗留）。构造期快照的后果是：勾选慢启动会「写库成功、
   * HTTP 回 200、行为纹丝不动到重启，且零日志」——因为 registry 的 controller Map 永不驱逐。
   */
  nurtureProvider?: AccountNurtureProvider;
  /**
   * 冷启动爬坡的 **env 全局旁路**（默认 **false = 关**，change disable-account-age-coldstart-ramp）。
   * 关（默认）→ 该路径不提供 anchor。true → 全体账号按 created_at 现算年龄爬坡（历史行为，
   * 因生产事故保留的回滚拉杆）。
   *
   * **与环境级慢启动严格「显式环境设置优先」，MUST NOT OR / AND / min 合成**（见 resolveNurtureAnchor）。
   */
  coldStartRampEnabled?: boolean;
  /**
   * 全局停用闸：置真 → 无视所有环境级开关与历史 env 旁路、全体不 clamp。
   */
  slowStartDisabled?: boolean;
  /**
   * 记账 fail-closed 现读（change risk-state-cross-process-integrity）：该账号的记账链路是否已断
   * （outbox 入队失败）。返回 true ⇒ 一切互动动作准入判定直接拒绝。
   *
   * 为什么闸设在这里而不是在下发处新加一道：`canDo` / `explain` 是**全部**自动路径的公共必经点
   * （角色调度、命令桥、评论评估、发布闸都调它）。新加一道独立闸必然漏接线；接在这里，覆盖是结构性的。
   *
   * 契约同 QuotaProvider / AccountNurtureProvider：**同步、零 IO、永不抛**。
   */
  interactionBlockedProvider?: (accountId: string) => boolean;
  /**
   * `risk_state` 条件写被数据库拒绝（非属主，影响 0 行）时的唯一正确处理入口
   * （change risk-state-cross-process-integrity，design D3/D4）。
   *
   * 由 registry 注入、转调 `handleNotOwned`（驱逐本地缓存 controller + P1 告警）。**这条接线不可省**：
   * 没有它，`saveState` 抛出的 `RiskStateNotOwnedError` 会被上游某个 catch 吞成一行日志，旧属主
   * 继续拿着一份**从未落库**的内存状态给该账号做准入判定，直到进程重启——「条件写是最后一道」
   * 就只剩一行日志。
   *
   * 契约：**同步、永不抛**（内部已 try/catch）；本方法调用后错误照常向上抛给写的发起方。
   */
  onStateWriteRejected?: (err: unknown) => void;
}

/**
 * 客户环境「解除受限」的原子结果（change facebook-environment-restriction-recovery）。
 * accepted=false 只会发生在 warned/frozen；normal 视为幂等已完成，避免双端同时恢复时把真成功报成失败。
 */
export interface RestrictedRecoveryResult {
  accepted: boolean;
  refusal?: 'state_not_restricted';
  statusBefore: RiskStatus;
  state: RiskState;
  changed: boolean;
}

/** 慢启动的生效锚点：环境级显式设置，或历史 AIDCP_COLDSTART_RAMP 旁路。 */
interface NurtureAnchor {
  /** 爬坡第 1 天的起点（epoch ms）。 */
  since: number;
  source: 'environment' | 'legacy_env';
}

/** 慢启动对外投影（change account-level-slow-start）：供 ui.snapshot 组装，与 clamp 同源同格。 */
export interface SlowStartView {
  state: 'off' | 'active' | 'graduated';
  /** active 时 1..7。 */
  day?: number;
  totalDays: number;
  since?: number;
  /** active 时：clamp 是否至少收紧一项。false = 勾了但当前档位已更严、不额外限制（见 design D6）。 */
  binding?: boolean;
  eligible: boolean;
  ineligibleReason?: SlowStartIneligibleReason;
}

export type SlowStartIneligibleReason =
  | 'platform_unsupported'
  | 'platform_unknown'
  | 'globally_disabled'
  | 'binding_unknown'
  | 'binding_conflict';

/** 慢启动曲线总天数（COLD_START_PLANS / FB_COLD_START_PLANS 均为 7 天）。 */
export const SLOW_START_TOTAL_DAYS = 7;

export interface CanDoResult {
  allowed: boolean;
  reason?: string;
  retryAfterMs?: number;
  /** 同次配额判定快照，避免调用方二次读取热配置后展示出与判定不一致的窗口或上限。 */
  quota?: { window: RiskWindow; used: number; limit: number };
}

export class RiskController {
  private readonly accountId: string;
  private readonly clock: () => number;
  private readonly counter: SlidingWindowCounter;
  private readonly stateMachine = new RiskStateMachine();
  private readonly store?: RiskStore;
  private readonly minViewsForLikeRatio: number;
  private readonly quotaProvider?: QuotaProvider;
  private readonly nurtureProvider?: AccountNurtureProvider;
  private readonly coldStartRampEnabled: boolean;
  private readonly slowStartDisabled: boolean;
  private readonly interactionBlockedProvider?: (accountId: string) => boolean;
  private readonly onStateWriteRejected?: (err: unknown) => void;
  private state: RiskState;
  /** 每账号串行化：所有改 state + saveState 的写经此链，避免并发 read-modify-write 丢更新（D7）。 */
  private mutationChain: Promise<unknown> = Promise.resolve();

  constructor(options: RiskControllerOptions = {}) {
    const now = options.clock?.() ?? Date.now();
    this.accountId = options.accountId ?? '__unbound__';
    this.clock = options.clock ?? Date.now;
    this.store = options.store;
    this.state = options.initialState ?? createRiskState(this.accountId, now);
    this.state.quotaLevel = options.quotaLevel ?? this.state.quotaLevel;
    this.counter = new SlidingWindowCounter({ clock: this.clock });
    this.minViewsForLikeRatio = options.minViewsForLikeRatio ?? 10;
    this.quotaProvider = options.quotaProvider;
    this.nurtureProvider = options.nurtureProvider;
    this.coldStartRampEnabled = options.coldStartRampEnabled ?? false;
    this.slowStartDisabled = options.slowStartDisabled ?? false;
    this.interactionBlockedProvider = options.interactionBlockedProvider;
    this.onStateWriteRejected = options.onStateWriteRejected;
  }

  static async create(options: RiskControllerOptions = {}): Promise<RiskController> {
    const accountId = options.accountId ?? '__unbound__';
    const now = options.clock?.() ?? Date.now();
    await options.store?.init?.();
    const state = (await options.store?.loadState(accountId)) ?? options.initialState ?? createRiskState(accountId, now);
    const events = (await options.store?.loadCounters(accountId, now - WINDOW_MS.day)) ?? [];
    const controller = new RiskController({ ...options, accountId, initialState: state });
    for (const event of events) controller.counter.record(event.action, event.occurredAt, event.count);
    return controller;
  }

  canDo(action: RiskAction): boolean {
    return this.explain(action).allowed;
  }

  explain(action: RiskAction): CanDoResult {
    // 记账链路已断（outbox 入队失败）⇒ 停止一切互动动作，形状同 restricted（浏览仍放行，
    // 否则连「看看现在什么情况」都做不到）。这不是风控态迁移——状态机一个字都没改，
    // 这是「记不上账就不许再制造要记的账」的结构性背压（change risk-state-cross-process-integrity）。
    if (action !== 'view' && this.interactionBlockedProvider?.(this.accountId)) {
      return { allowed: false, reason: 'accounting:blocked' };
    }
    if (this.state.status === 'frozen') return { allowed: false, reason: 'state:frozen' };
    if (this.state.status === 'restricted' && action !== 'view') return { allowed: false, reason: 'state:restricted' };
    if (this.state.status === 'warned' && action === 'publish') return { allowed: false, reason: 'state:warned_publish_paused' };

    const quotas = this.effectiveQuotas();
    for (const window of ['minute', 'hour', 'day'] as const) {
      const quota = quotas[window][action];
      const used = this.counter.count(action, window);
      if (used >= quota) {
        return {
          allowed: false,
          reason: `quota:${window}`,
          retryAfterMs: this.counter.retryAfterMs(action, window, quota),
          quota: { window, used, limit: quota },
        };
      }
    }
    if (action === 'like' && !this.likeRatioAllowsNextLike()) return { allowed: false, reason: 'ratio:like_view' };
    return { allowed: true };
  }

  /**
   * 某动作当日剩余配额（按账号、按当前档位与状态）。当前被拦（状态/任一窗口耗尽）→ 0。
   * 供评论评估在最便宜阶段预判每日上限（与 dispatch 前 canDo 同源，避免空跑撰写）。
   */
  dailyRemaining(action: RiskAction): number {
    if (!this.canDo(action)) return 0;
    const quotas = this.effectiveQuotas();
    return Math.max(0, quotas.day[action] - this.counter.count(action, 'day'));
  }

  /**
   * Read-only release timing for a specific quota window.
   * Returns 0 when the window has spare quota, undefined when no finite release
   * can be computed (for example quota <= 0).
   */
  quotaReleaseAfterMs(action: RiskAction, window: RiskWindow): number | undefined {
    const quota = this.effectiveQuotas()[window][action];
    if (this.counter.count(action, window) < quota) return 0;
    return this.counter.retryAfterMs(action, window, quota);
  }

  /**
   * 记下一次**已经真实发生**的动作，并回答「它在不在策略内」。
   *
   * **两个问题，两个答案，别混**（change risk-record-actuated-facts）：
   * - **返回值**答「这个动作在策略内吗」——被 `canDo` 拒时仍返 `false`（背压语义逐字不变，红线不变：
   *   绝不 `applySignal`、绝不自升威胁态；change decouple-quota-hit-from-risk）。
   * - **计数器**答「这个动作发生过吗」——**无条件写入**。
   *
   * 本方法的调用点全都是**事后回执**（边缘回报「我已在真实页面上做完了」之后才驱动）。此时再判一次
   * 「该账号现在还允许做这个吗」并据此**不写**，销毁的只有证据，改变不了已发生的事：拒绝记录一次真实
   * 点击，并不能把它变回没点过。**「该不该做」MUST 在下发前判定**——那道预闸是唯一能真正阻止动作的
   * 地方，且每条自动路径都已过它；这里的事后重判只在预闸失效的缝里开火（运营手动绕闸、飞行途中状态
   * 翻转、突发窗在预闸与回执之间被填满、并发），而那正是真相最要紧的时候。
   *
   * 少记真实活动量与谎报成功同属不诚实（前者是后者的镜像）：计数器同时是配额分母的来源，少记会让
   * 后续 `canDo` **误以为尚有余量**而放行更多真实动作——紧窗口的拒绝会就此污染松窗口的账本。
   *
   * ⚠️ **求值顺序不可换**：`canDo` 读的就是这个计数器。必须**先取判定、再写入**——先写后判会把刚写的
   * 这一笔算进自己，撞顶那一次的返回值会从 `false` 翻成 `true`。
   *
   * 注：某条路径若确实不该消耗预算，正确表达是**在接线层显式不驱动本方法**，而不是让它内部静默丢弃
   * ——后者使「豁免」与「丢数」不可区分。
   *
   * ---
   * **常规路径已迁到 outbox**（change risk-state-cross-process-integrity，design D5）：
   * `RiskAccounting` 先把事实落进 outbox、apply 成功后才经 `recordFact` 递增内存计数。
   *
   * ⚠️ **漏斗可用时，生产路径 MUST 经 `RiskAccounting.record` / `.enqueue`，MUST NOT 直接调本方法**
   * ——那会让同一笔事实既走 outbox 又走这里，计成两次。
   *
   * 本方法保留为**漏斗未启用时的降级路径**（target 缺失 / outbox 起不来），语义与改动前逐字一致：
   * 内存计数与 `risk_counters` **同时**写。`appendCounter` MUST NOT 被摘掉——摘掉之后降级路径
   * 就成了纯内存记账，重启即把当日已消耗的配额全部归零，而告警文案还在宣称「回落改动前的进程内
   * 记账，行为逐位一致」。那是一句假陈述，且对账器检不出（内存 0 == 库 0）。
   */
  async record(action: RiskAction): Promise<boolean> {
    const allowed = this.canDo(action);
    const now = this.clock();
    this.recordFact(action, now);
    // 落库（降级路径的持久账本）。这里的行没有 outbox_id，与 apply 写下的行共存于同一张表，
    // 对账按总量比对 ⇒ 内存与库同增同减，零偏差。
    await this.store?.appendCounter(this.accountId, action, now);
    return allowed;
  }

  /**
   * 只记「这个动作发生过」——递增内存滑动窗计数，不落库、不判定。
   *
   * **由 outbox apply 驱动，且只由它驱动**：库内那一行写成功之后才调这里，内存与库因此同源。
   * `occurredAt` 取事实发生时刻（回执时间），MUST NOT 取 apply 时刻——否则跨小时窗的动作会被
   * 记到错误的突发窗里。
   */
  recordFact(action: RiskAction, occurredAt: number = this.clock()): void {
    this.counter.record(action, occurredAt);
  }

  /**
   * 以库内事实为准重建计数（change risk-state-cross-process-integrity，design D6）。
   * 用于：归属占位成功 / 归属变更后重新解析 / 周期对账检出偏差。
   * **整段替换，MUST NOT 增量合并**——增量合并解决不了「内存多记了一笔」这个方向的偏差。
   */
  async reloadCounters(): Promise<void> {
    const now = this.clock();
    const events = (await this.store?.loadCounters(this.accountId, now - WINDOW_MS.day)) ?? [];
    this.counter.reset(events, now);
  }

  getState(): RiskState {
    return { ...this.state };
  }

  /**
   * `risk_state` 的唯一落库出口（change risk-state-cross-process-integrity）。
   *
   * **三个写入口（applySignal / recoverRestricted / setQuotaLevel）MUST 全部经此**，不要在任一处
   * 直接 `await this.store?.saveState(...)`：条件写被拒后的驱逐与告警接在这里，漏一处就漏一条
   * 「旧属主拿着从未落库的内存状态继续做准入判定」的静默路径。
   *
   * 失败照常向上抛（调用方与改动前逐字一致地看到失败）；这里只额外把「非属主」这一类失败告诉 registry。
   */
  private async persistState(): Promise<void> {
    try {
      await this.store?.saveState(this.state);
    } catch (err) {
      try {
        this.onStateWriteRejected?.(err);
      } catch {
        // 驱逐/告警链路故障绝不改变写失败这个事实，也绝不掩盖原始错误。
      }
      throw err;
    }
  }

  /** 把一个 state 写排进每账号串行链（transition+saveState 或 setQuotaLevel+saveState 原子）。 */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutationChain.then(fn, fn); // 前一个成败都继续
    this.mutationChain = run.then(
      () => undefined,
      () => undefined,
    ); // 链不因 error 断
    return run;
  }

  async applySignal(signal: RiskSignal): Promise<RiskState> {
    return this.enqueue(async () => {
      this.state = this.stateMachine.transition(this.state, signal, signal.at ?? this.clock());
      await this.persistState();
      return this.getState();
    });
  }

  /**
   * 只允许 restricted → normal 的人工恢复，并与其它账号风险写共享同一 mutation queue。
   * MUST NOT 用 getState()+applySignal() 在路由层拼：两次调用中间可插入另一条信号，形成 TOCTOU。
   */
  async recoverRestricted(reason: string): Promise<RestrictedRecoveryResult> {
    const auditReason = String(reason ?? '').trim();
    if (!auditReason) throw new Error('restricted_recovery_requires_reason');
    return this.enqueue(async () => {
      const statusBefore = this.state.status;
      if (statusBefore === 'normal') {
        return { accepted: true, statusBefore, state: this.getState(), changed: false };
      }
      if (statusBefore !== 'restricted') {
        return {
          accepted: false,
          refusal: 'state_not_restricted',
          statusBefore,
          state: this.getState(),
          changed: false,
        };
      }
      this.state = this.stateMachine.transition(
        this.state,
        { kind: 'operator_override_recover', reason: auditReason },
        this.clock(),
      );
      await this.persistState();
      return { accepted: true, statusBefore, state: this.getState(), changed: true };
    });
  }

  /**
   * 改账号配额档位（V1 task 8.3）：controller 单写 state.quotaLevel + 持久 + 经串行链。
   * 状态机从不碰 quotaLevel，故必须经此方法（绝不 raw UPDATE）。
   */
  async setQuotaLevel(level: RiskQuotaLevel): Promise<RiskState> {
    return this.enqueue(async () => {
      this.state = { ...this.state, quotaLevel: level, updatedAt: this.clock() };
      await this.persistState();
      return this.getState();
    });
  }

  effectiveQuotas(): WindowQuotas {
    return this.applyColdStartClamp(this.riskScaledQuotas());
  }

  /**
   * 风控缩放后、叠 clamp 之前的配额（change account-level-slow-start 从 effectiveQuotas 抽出）。
   * 抽出的唯一理由：slowStartView() 的 binding 需要与 effectiveQuotas 逐字同源的 clamp 前基准，
   * 两处各写一份就是「显示的 ≠ 生效的」的经典入口。
   *
   * 基准三档数字：provider（热加载库值）优先，缺则回落 deriveWindowQuotas 写死默认（零回归）。
   * 注意：warned/restricted/frozen 基准固定 'conservative'（与历史一致，非 state.quotaLevel）。
   */
  private riskScaledQuotas(): WindowQuotas {
    const base = (level: RiskQuotaLevel): WindowQuotas =>
      this.quotaProvider?.windowQuotasFor(level) ?? deriveWindowQuotas(level);
    if (this.state.status === 'warned') return scaleWindowQuotas(base('conservative'), 0.7);
    if (this.state.status === 'restricted') return zeroInteractionQuotas(base('conservative'));
    if (this.state.status === 'frozen') return scaleWindowQuotas(base('conservative'), 0);
    return base(this.state.quotaLevel);
  }

  /**
   * 解析慢启动锚点（change account-level-slow-start）：**clamp 与投影共用此函数 + 同一次 clock()**
   * ——这是「显示的 = 生效的」的唯一机制保障（否则会出现「徽章说 D7、clamp 已按 D8 放行」）。
   *
   * 优先级严格是：① 当前唯一绑定环境 slow_start_since 非 NULL → 用它；② 否则历史 env 旁路开且有 created_at
   * → 用 created_at（历史路径原样保留）；③ 否则 null（逐位零回归）。
   *
   * **MUST NOT OR / AND / min 合成两条路径**：合成一次就会把 FB 全车队夹回 view=70
   * ——正是 2026-07-15 判为 bug 根因的那个上限。
   */
  private resolveNurtureAnchor(): NurtureAnchor | null {
    const state = this.nurtureAnchorState();
    // clamp 侧：`unknown` 退到**最保守锚点（第 1 天）**——收紧配额，方向安全。
    if (state.kind === 'unknown') return { since: this.clock(), source: 'environment' };
    return state.kind === 'anchor' ? state.anchor : null;
  }

  /**
   * 锚点解析的**三态**内核。`unknown` 与 `none` 必须分开表达：
   * clamp 侧两者的安全方向不同（unknown 取最严），投影侧两者的诚实说法也不同
   * （unknown MUST NOT 显示成「已入组、第 1 天」——那是把「读不到」编成一个确定的「是」）。
   */
  private nurtureAnchorState():
    | { kind: 'anchor'; anchor: NurtureAnchor }
    | { kind: 'none' }
    | { kind: 'unknown' } {
    // 全局停用闸：无视所有账号级开关与 env 旁路（raw SQL 改库不刷镜像时的秒级止血手段）。
    if (this.slowStartDisabled) return { kind: 'none' };
    // 副本陈旧（change config-mirror-cross-process-invalidation task 4.7）：锚点事实源在客户业务侧
    // （client_environments.slow_start_since），这里读的是本进程的只读副本。副本超过陈旧上限时**读不到
    // 锚点 ≠ 该环境没开慢启动**——当成 null 等于「未开启慢启动」，也就是让一个刚开启慢启动的新号按
    // 毕业档满配额跑，正是「未知压成否」的配额版本。
    //
    // 这**不是**用「回落最严档继续跑」代替停手：真正的停手在上层闸（会话启动闸与命令泵，见
    // src/config/mirror-stop-work.ts 的统一实现），本处只是不让配额层在停手生效前把闸放到最松。
    //
    // **本方法是纯取值口，不记账**：它挂在 effectiveQuotas 的热路径上（canDo / remaining / retryAfter
    // 每次都走到），也被什么都没拒绝的徽章投影调用。记账收口在真正的拒绝点（统一停手闸）。
    if (isMirrorStale('client_environment_slow_start')) return { kind: 'unknown' };
    const environmentSince = this.nurtureProvider?.slowStartSinceFor(this.accountId) ?? null;
    if (environmentSince != null) return { kind: 'anchor', anchor: { since: environmentSince, source: 'environment' } };
    const createdAt = this.coldStartRampEnabled ? this.nurtureProvider?.createdAtFor(this.accountId) : undefined;
    if (createdAt != null) return { kind: 'anchor', anchor: { since: createdAt, source: 'legacy_env' } };
    return { kind: 'none' };
  }

  /** 按锚点与 now 现算天数（1-based）。day > 7 即毕业（coldStartDailyCap 返回 null）。 */
  private dayIndexFor(anchor: NurtureAnchor, now: number): number {
    return Math.max(0, Math.floor((now - anchor.since) / 86_400_000)) + 1;
  }

  /**
   * 慢启动 clamp（change account-nurture-discipline-spine → account-level-slow-start）：
   * effectiveQuotas = min(当日天花板, 风控缩放配额)。取 min 保证「逐日爬坡」与
   * 「风控降速(warned/restricted/frozen)」两条闸同时生效、谁更紧谁生效、互不架空。
   *
   * 无锚点 / 平台未知 / 账号已毕业（超 7 天窗口）→ 原样返回风控缩放（逐位零回归）。
   * 天花板走确定性 coldStartDailyCap（区间上界），绝不随机采样、逐调用稳定。
   *
   * **平台未知 MUST NOT 回落小红书曲线**（design D5）：回落一次就是 FB 号按 XHS 曲线跑
   * （D1 view=50 而非 20，差 2.5 倍），且无日志无告警。FB 那条更保守的曲线正是本功能唯一的存在理由。
   */
  private applyColdStartClamp(riskScaled: WindowQuotas): WindowQuotas {
    const anchor = this.resolveNurtureAnchor();
    if (!anchor) return riskScaled;
    const platform = this.nurtureProvider?.platformFor(this.accountId);
    if (!supportsSlowStart(platform)) return riskScaled;
    const cap = coldStartDailyCap(this.dayIndexFor(anchor, this.clock()) - 1, platform);
    if (!cap) return riskScaled;
    const windowCap = deriveWindowQuotasFromDaily(cap);
    return minWindowQuotas(riskScaled, windowCap);
  }

  /**
   * 慢启动对外投影（change account-level-slow-start）：供 ui.snapshot 组装。
   * **与 clamp 共用 resolveNurtureAnchor + 同一次 clock()** → 徽章天数与生效天数同源同格。
   *
   * `binding` 是 clamp 是否至少收紧一项（逐位比较 clamp 前后两份数字）。**这个布尔必须真算**：
   * 曲线写死、档位数字面板可热编辑，两者之间没有任何不变量保证曲线更紧——小红书 conservative 档
   * 在曲线 D5-7 下 view/like/comment/publish 逐位不变。让「没变」成为一个被明说的态，
   * 而不是一个看起来像 bug 的沉默（design D6）。
   */
  slowStartView(): SlowStartView {
    const totalDays = SLOW_START_TOTAL_DAYS;
    if (this.slowStartDisabled) {
      return { state: 'off', totalDays, eligible: false, ineligibleReason: 'globally_disabled' };
    }
    const anchorState = this.nurtureAnchorState();
    // 副本陈旧 → 投影 MUST NOT 把「读不到」编成「已入组、第 1 天」（clamp 侧取最严是收紧配额，
    // 与对外宣称已入组是两件事）。这里如实回一个「暂时无法判定」态、不带 since、不给天数。
    // 复用既有 `binding_unknown`（客户端已有对应文案与降级路径），**绝不新增枚举值**——边缘对
    // ineligibleReason 做白名单校验，未知值会让整段慢启动投影被整体丢弃。
    if (anchorState.kind === 'unknown') {
      return { state: 'off', totalDays, eligible: false, ineligibleReason: 'binding_unknown' };
    }
    const anchor = anchorState.kind === 'anchor' ? anchorState.anchor : null;
    if (!anchor) return { state: 'off', totalDays, eligible: true };

    const platform = this.nurtureProvider?.platformFor(this.accountId);
    if (platform == null) {
      return { state: 'off', totalDays, since: anchor.since, eligible: false, ineligibleReason: 'platform_unknown' };
    }
    if (!supportsSlowStart(platform)) {
      return {
        state: 'off',
        totalDays,
        since: anchor.since,
        eligible: false,
        ineligibleReason: 'platform_unsupported',
      };
    }
    // 历史 env 全局旁路没有用户可操作的环境开关，UI MUST NOT 把它显示成用户勾过的配置。
    if (anchor.source !== 'environment') return { state: 'off', totalDays, eligible: true };

    const now = this.clock();
    const day = this.dayIndexFor(anchor, now);
    if (day > totalDays) return { state: 'graduated', totalDays, since: anchor.since, eligible: true };

    // binding：拿 clamp 前后两份数字逐位比较。effectiveQuotas() 内已叠 clamp，这里重算一次
    // 未 clamp 的基准做对照——同一次 clock()、同一个 anchor，故两者必然同格。
    const riskScaled = this.riskScaledQuotas();
    const clamped = this.applyColdStartClamp(riskScaled);
    return {
      state: 'active',
      day,
      totalDays,
      since: anchor.since,
      binding: isStrictlyTighter(clamped, riskScaled),
      eligible: true,
    };
  }

  counts() {
    return this.counter.snapshot();
  }

  private likeRatioAllowsNextLike(): boolean {
    const views = this.counter.count('view', 'day');
    if (views < this.minViewsForLikeRatio) return true;
    const projectedRatio = (this.counter.count('like', 'day') + 1) / views;
    return projectedRatio <= 0.35;
  }
}
