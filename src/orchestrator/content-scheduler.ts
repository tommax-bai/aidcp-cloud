/**
 * ContentScheduler —— 多账号「按时段自动发帖」的触发扇入（change content-schedule-auto-publish，Phase 1 只发帖）。
 *
 * 定位：**触发扇入、不是新发送通道**。每分钟心跳遍历在线账号，判「此刻是否该对某账号试发帖」，
 * 命中即调注入的 triggerPost（走既有 提议→人审→派发 管线），发不发全过既有人审 + 风控 + 日上限。
 * 它是命令式触发器（同 CommentScheduler / PublishScheduler），**不进 RoleDispatcher 角色注册、不走 EventBus**。
 *
 * 正确性闸（对抗评审挖出的必须项）：
 * - **fail-closed**：内容格缺失 / 非法一律「不活跃、跳过」（isValidWeekActiveMask && isWeekActiveAt），绝不回落全天。
 * - **分钟错峰**：offset = hash(accountId + 本地日期 + 'post') % 60，逐日变、账号间错开；仅命中分钟才尝试。
 * - **账号粒度自主单飞**（change parallel-rewrite-drafts）：过注入的 isPublishBusy(accountId)——该账号自主轮
 *   在跑则本槽顺延；洗稿在途不让槽；全局并发帽在调度器 claim 层另行兜底（帽满触发诚实 skipped）。
 * - **fire-and-forget**：triggerPost 走耗时生成管线；心跳绝不 await 它（否则单分钟被阻塞、其它账号饿死、错峰被击穿）。
 * - **幂等**：(account, 小时格) 同格不重触发；**tick 重入护栏**：上轮未完即跳过本轮。
 * - **日上限原子**：已发历史 + 在途**自主**草稿真实条数之和 >= cap 则不发（防两张自动草稿都获批超发；
 *   洗稿候选不占排期日上限，由账号在途帽独立兜量）。
 * - **风控 normal 闸**：非 normal 态不自动放量。
 *
 * localDayKey：本模块自带（服务器本地 YYYY-MM-DD），刻意不导出 role-dispatcher 的同名函数以避开热点文件。
 */

import { isValidWeekActiveMask, isWeekActiveAt } from '../risk/session-limits.js';
import { actionModeEnabled, type ContentScheduleActionMode, type ContentScheduleApprovalMode } from '../config/content-schedule-store.js';
import type { PlatformId } from '../kernel/platform-types.js';
import type { DeploymentTarget } from '../deployment-target.js';

export interface OnlineAccountIdentity {
  accountId: string;
  /** null keeps legacy scheduled comment/join behavior; automatic posting requires a non-null verified envKey. */
  envKey: string | null;
}

export type VerifiedOnlineAccountIdentity = OnlineAccountIdentity & { envKey: string };

export interface ScheduledPostExecution {
  executionTarget: DeploymentTarget;
  envKey: string;
  hourCell: string;
}

/** 调度器每 tick 现读的生效排期（effectiveMask 已由 store 解析：override ?? global）。 */
export interface ContentScheduleView {
  autoEnabled: boolean;
  postEnabled: boolean;
  postMode: ContentScheduleActionMode;
  postDailyCap: number;
  /** 自动评论开关 / 日上限（change content-schedule-comments）。 */
  commentEnabled: boolean;
  commentMode: ContentScheduleActionMode;
  commentDailyCap: number;
  /** 自动联系评论开关 / 每日尝试上限（change content-schedule-group-comments）。 */
  contactCommentEnabled: boolean;
  contactCommentMode: ContentScheduleActionMode;
  contactCommentDailyCap: number;
  effectiveMask: string | null;
}

export interface ContentSchedulerDeps {
  /** 当前完成欢迎握手的在线账号；envKey 可空以保持非发帖动作兼容，自动发帖单独 fail closed。 */
  onlineAccounts(): OnlineAccountIdentity[];
  /** Cloud 本地严格解析的部署目标；绝不接受 Edge 自报。 */
  executionTarget: DeploymentTarget;
  /** 自动发帖小时格的数据库原子占位；false 表示其它进程或重启前已触发该格。 */
  claimPostHourCell(identity: VerifiedOnlineAccountIdentity, hourCell: string): Promise<boolean>;
  /** 单账号生效排期（store.effectiveScheduleFor，内存现读）。 */
  scheduleFor(accountId: string): ContentScheduleView;
  /** 风控状态（只 'normal' 才自动）。可同步或异步（server 侧按账号 registry 解析是 async）。 */
  riskStatus(accountId: string): string | Promise<string>;
  /** 今日已发帖数（持久历史，按账号 Asia/Shanghai 自然日）。 */
  postedTodayCount(accountId: string): Promise<number>;
  /**
   * 在途**自主来源**未审草稿真实条数（change parallel-rewrite-drafts）：日上限原子判定
   * posted + pendingAutonomous >= cap——自主候选按条数计防两张都获批超发；洗稿候选不占排期日上限
   * （人工发起、由账号在途帽独立兜量）。
   */
  pendingAutonomousCount(accountId: string): Promise<number>;
  /** 账号平台事实源；缺省 xiaohongshu。 */
  getPlatform?(accountId: string): PlatformId | Promise<PlatformId>;
  /** Facebook 发帖素材池可用 set 数；FB 排期发帖必须 >0。 */
  availablePublishMediaCount?(accountId: string): Promise<number>;
  /** 该账号自主发帖轮是否在跑（change parallel-rewrite-drafts：账号粒度单飞；洗稿在途不让排期槽）。 */
  isPublishBusy(accountId: string): boolean;
  /** Active delegated ownership wins over periodic work for the same account/action family. Busy skips do not consume a slot. */
  delegatedOwnershipBusy?(accountId: string, family: 'comment' | 'publish'): boolean | Promise<boolean>;
  /**
   * 当前是否在「可活跃时间」（浏览周历掩码）内 —— **自动内容时窗 ⊆ 活跃时段** 的强制闸（用户拍板：
   * 休眠格绝不自动发内容，账号"睡着"的时段准点发帖本身就是不自然信号）。语义沿浏览掩码的 fail-open
   * （缺失/未配=全天活跃=不额外限制）；缺省不注入=不限制（零回归、纯测试桩兼容）。
   */
  browseActiveAt?(accountId: string, now: Date): boolean;
  /** 触发排期发帖：**fire-and-forget**——返回一个在生成完成/失败时 settle 的 promise，调度器只挂 finally、绝不 await。
   *  该实现负责走既有提议→人审→派发、并异步补飞书结果卡（成功/空槽/失败）。 */
  triggerPost(
    accountId: string,
    approvalMode: ContentScheduleApprovalMode,
    execution: ScheduledPostExecution,
  ): Promise<unknown>;
  /**
   * 评论动作三件套（change content-schedule-comments）。可选：任一未注入 → 评论动作整体跳过（零回归）。
   * triggerComment 的实现负责 canDo('comment') 配额闸 + 调命令式评论入口 + 触发失败回黄卡（终态结果卡由评论链自补）。
   */
  triggerComment?(accountId: string, approvalMode: ContentScheduleApprovalMode): Promise<unknown>;
  /** 该账号评论任务是否在跑（= commentScheduler.isRunning，单飞闸）。 */
  isCommentBusy?(accountId: string): boolean;
  /** 该账号今日已发评论数（持久互动记录，Asia/Shanghai 自然日）。 */
  commentedTodayCount?(accountId: string): Promise<number>;
  /**
   * Facebook 加群动作三件套（change facebook-group-join-and-commenting）。可选：任一未注入 → join 动作整体跳过（零回归）。
   * triggerJoin 内部负责 kill switch / shadow / canDo('join_group') / lazy-claim / judge / ledger。
   */
  triggerJoin?(accountId: string): Promise<unknown>;
  /** 该账号加群任务是否在跑（= FacebookGroupJoinScheduler.isRunning，单飞闸）。 */
  isJoinBusy?(accountId: string): boolean;
  /** 该账号今日已确认加入的群数（membership ledger joined_at，Asia/Shanghai 自然日）。 */
  joinedTodayCount?(accountId: string): Promise<number>;
  /** join_group 的日上限（通常来自 RiskController.effectiveQuotas().day.join_group）。 */
  joinDailyCap?(accountId: string): number | Promise<number>;
  /** 每账号 Facebook 自动加群领域配置；未注入/无行均默认关闭。 */
  joinAutomationFor?(accountId: string): { enabled: boolean; dailyCap: number; weekMask: string | null };
  /**
   * 联系评论两件套（change content-schedule-group-comments）。可选：任一未注入 → 该动作整体跳过（零回归）。
   * triggerContactComment 实现负责 canDo('comment') 配额闸 + triggerManual(injectContact:true) + 回执 ok 记持久 attempt +
   * 触发失败回黄卡（缺联系方式 fail-closed 由触发回执透传；终态结果卡评论链自补）。单飞复用 isCommentBusy（同一评论机器）。
   */
  triggerContactComment?(accountId: string, approvalMode: ContentScheduleApprovalMode): Promise<unknown>;
  /** 该账号今日联系评论自动尝试数（持久 attempts 台账，Asia/Shanghai 自然日；尝试型上限）。 */
  contactAttemptsTodayCount?(accountId: string): Promise<number>;
  /**
   * 本小时格的有界重试全部用尽、诚实放弃时回调一次（change browser-slot-scheduling）。
   *
   * 为什么在这里、而不是每次未开始都回卡：瞬时失败会在本小时内重试，每次都发卡 = 每分钟刷一张告警。
   * 一个小时格只发**一张**放弃卡，运维看到的就是「这一小时没做成，原因是 X」，不是一串噪声。
   */
  onCellAbandoned?(accountId: string, action: string, reason: string): void;
  now?: () => number;
  logger?: { warn: (m: string) => void; info?: (m: string) => void };
}

/**
 * 触发回执（change browser-slot-scheduling）：触发实现 MAY 返回它来如实声明「本次根本没开跑」。
 *
 * 为什么需要：小时格是**每小时只有一分钟**的开火窗口（分钟错峰），而那一分钟**全天固定**。若一次
 * 「根本没开跑」的失败（边缘离线 / 浏览器停泊唤醒失败 / 租约不可得 / 配额拒）也把这小时的名额烧掉，
 * 相位一旦不利，账号会**整天一次都触发不了**。started=false ⇒ 归还小时格，本小时剩余分钟可再试。
 *
 * 未返回该形状的触发（老实现 / 返回任意值）一律按「已开跑」处理——零回归、保守方向。
 */
export interface ScheduleTriggerOutcome {
  /** false = 本次未开始任何业务动作（未搜索、未选中、未发布）；名额可归还。 */
  started: boolean;
  /** 机器可读的未开始原因（如 edge_offline / browser_wake_failed / lease_unavailable / quota_denied）。 */
  reason?: string;
}

function notStartedReason(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const outcome = result as ScheduleTriggerOutcome;
  return outcome.started === false ? (outcome.reason ?? 'not_started') : undefined;
}

/** 稳定字符串哈希（djb2），→ 无符号 32 位。纯函数、可复现。 */
function hash32(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

/** 服务器本地 YYYY-MM-DD。 */
function localDayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 小时格键（服务器本地 YYYY-MM-DD-HH），幂等键用。 */
function hourCellKey(d: Date): string {
  return `${localDayKey(d)}-${String(d.getHours()).padStart(2, '0')}`;
}

/** 账号在某日某动作的错峰分钟（0..59）。 */
export function offsetMinute(accountId: string, day: Date, action: string): number {
  return hash32(`${accountId}|${localDayKey(day)}|${action}`) % 60;
}

/** 「未开始」后，同一小时格内最多再试几次（有界；一个起不来的边缘不得被叫醒 59 次）。 */
const MAX_RETRIES_PER_CELL = 5;

export class ContentScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private tickRunning = false;
  /**
   * 同 tick 发帖单发旗标（change parallel-rewrite-drafts 语义降级保留）：旧槽污染理由已随全局槽消灭，
   * 保留它是防同一 tick 内多账号齐发（错峰被同分钟命中击穿时的成本/风控尖峰缓冲）；跨 tick 的并发
   * 准入由调度器 claim 层（账号自主单飞 + 全局帽）负责。
   */
  private postFiring = false;
  /** 每账号跨动作单飞（本 Phase 只发帖；为 Phase 2/3 预留背板）。 */
  private readonly inFlight = new Set<string>();
  /** 幂等：`account|action` → 上次触发的小时格键（每动作独立，发帖触发不吞同小时评论槽）。 */
  private readonly lastFired = new Map<string, string>();
  /**
   * 小时内重试窗（change browser-slot-scheduling）：`account|action` → { 小时格, 剩余重试次数 }。
   *
   * 归还小时格只是**必要**条件——开火窗口本身每小时只有错峰的那一分钟，光归还名额、下一分钟仍不开火，
   * 名额就白还了。所以「未开始」之后在**本小时格内**打开重试窗：任意分钟都可再试，直到成功或次数用尽。
   * 有界（MAX_RETRIES_PER_CELL）是刚性的：否则一个起不来的边缘会在一小时里被反复叫醒 59 次。
   */
  private readonly retry = new Map<string, { cell: string; left: number }>();

  constructor(private readonly deps: ContentSchedulerDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /**
   * 触发一个动作（change browser-slot-scheduling）。
   *
   * 小时格**先乐观占住**——在途期间它是「同格不重触发」的第二道闸（第一道是 inFlight / isXxxBusy 单飞）。
   * 触发若如实声明「根本没开跑」（started=false）则**归还小时格**：本小时剩余分钟可再试。
   *
   * 抛异常**不归还**：异常可能发生在业务动作已经真实落地之后（如评论已发出、回卡失败）。宁可这一小时
   * 少发一次，也绝不重复发——「自愈不自残」的保守侧。
   */
  private fire(
    accountId: string,
    action: string,
    fireKey: string,
    cell: string,
    run: () => Promise<unknown>,
    onSettled?: () => void,
  ): void {
    this.lastFired.set(fireKey, cell);
    this.inFlight.add(accountId);
    void run()
      .then((result) => {
        const reason = notStartedReason(result);
        if (reason === undefined) {
          // 评论触发入口只证明异步任务已启动，真正的 edge acquire 失败会在稍后经 reportNotStarted()
          // 回流。若本格已经处于重试窗，此时删掉 retry 会让每次终态回流都重新从 5 开始，退化成
          // 整小时每分钟无限重试。保留本格预算；真成功时 lastFired 仍会阻止同格再次触发。
          const retry = this.retry.get(fireKey);
          if (!retry || retry.cell !== cell) this.retry.delete(fireKey);
        } else {
          this.releaseHourCell(accountId, action, fireKey, cell, reason);
        }
      })
      .catch((e) => this.deps.logger?.warn(`[content-scheduler] trigger:${action} 异常 account=${accountId}：${(e as Error).message}`))
      .finally(() => {
        this.inFlight.delete(accountId);
        onSettled?.();
      });
  }

  /**
   * 外部回流「这次任务根本没开始」（change browser-slot-scheduling）。
   *
   * 触发回执只能告诉我们「有没有派出去」；接管边端失败（浏览器停泊唤不醒 / acquire 超时 / 边端掉线）
   * 发生在**任务已经异步跑起来之后**，那时小时格早被记为已消耗。评论管线跑完发现 not_started 时调这里，
   * 把这一小时的名额还回来。
   */
  reportNotStarted(accountId: string, action: string, reason: string): boolean {
    const cell = hourCellKey(new Date(this.now()));
    return this.releaseHourCell(accountId, action, `${accountId}|${action}`, cell, reason);
  }

  /**
   * 归还小时格并打开小时内重试窗（仅当它仍是本次占住的那一格；跨小时或已被后续触发改写则不动）。
   * 返回 true 表示本次终态已由小时格重试/放弃通知接管，调用方可抑制逐次结果卡。
   */
  private releaseHourCell(accountId: string, action: string, fireKey: string, cell: string, reason: string): boolean {
    if (this.lastFired.get(fireKey) !== cell) return false;
    const prev = this.retry.get(fireKey);
    const left = prev && prev.cell === cell ? prev.left : MAX_RETRIES_PER_CELL;
    if (left <= 0) {
      // 重试用尽：本小时格保持已消耗（诚实放弃，绝不无界重叫）。整格只在此处回一张卡。
      this.deps.logger?.warn(
        `[content-scheduler] 触发未开始且本小时重试已用尽，放弃本格 account=${accountId} action=${action} cell=${cell} reason=${reason}`,
      );
      if (!this.deps.onCellAbandoned) return false;
      try {
        this.deps.onCellAbandoned(accountId, action, reason);
      } catch (e) {
        this.deps.logger?.warn(`[content-scheduler] onCellAbandoned 回调异常：${(e as Error).message}`);
        return false;
      }
      return true;
    }
    this.retry.set(fireKey, { cell, left: left - 1 });
    this.lastFired.delete(fireKey);
    this.deps.logger?.warn(
      `[content-scheduler] 触发未开始，归还小时格 account=${accountId} action=${action} cell=${cell} reason=${reason}（本小时剩余 ${left} 次重试）`,
    );
    return true;
  }

  /** 本 tick 是否放行该动作：命中错峰分钟，或落在「未开始」后打开的小时内重试窗。 */
  private shouldFireNow(accountId: string, action: string, fireKey: string, cell: string, now: Date, minute: number): boolean {
    if (minute === offsetMinute(accountId, now, action)) return true;
    return this.retry.get(fireKey)?.cell === cell;
  }

  /** 启动每分钟心跳。 */
  start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.onTick();
    }, intervalMs);
    this.deps.logger?.info?.('[content-scheduler] 已启动（每分钟心跳）');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 一次心跳：遍历在线账号，逐账号闸序判定，命中即 fire-and-forget 触发发帖。
   * 重入护栏：上轮未完即跳过本轮（不叠加）。可被测试直接 await 调用。
   */
  async onTick(): Promise<void> {
    if (this.tickRunning) return;
    this.tickRunning = true;
    try {
      const now = new Date(this.now());
      const minute = now.getMinutes();
      const cell = hourCellKey(now);

      for (const identity of this.deps.onlineAccounts()) {
        const { accountId } = identity;
        try {
          const s = this.deps.scheduleFor(accountId);
          // 账号级闸（对所有动作统一）：总开关 / fail-closed 内容格 / 自动 ⊆ 活跃 / 单飞。
          if (!s.autoEnabled) continue;
          if (!isValidWeekActiveMask(s.effectiveMask) || !isWeekActiveAt(s.effectiveMask, now)) continue;
          if (this.deps.browseActiveAt && !this.deps.browseActiveAt(accountId, now)) continue;
          if (this.inFlight.has(accountId)) continue;

          // 动作循环（post 在前：纯云端、不接管边端；join/comment/contact 共用账号级 inFlight，物理边端单槽）。
          // join_group 与 comment 的最坏日活动量由 joinDailyCap + commentDailyCap 显式相加评估：
          // 默认 normal=3 joins/day，若排期 commentDailyCap=8，则该账号自动互动上界 11/day；restricted/frozen 在 riskStatus 闸处停。
          let joinAutomation: { enabled: boolean; dailyCap: number; weekMask: string | null } | null = null;
          for (const action of ['post', 'join', 'comment', 'contact_comment'] as const) {
            if (action === 'post' && (!actionModeEnabled(s.postMode) || s.postDailyCap <= 0)) continue;
            if (action === 'join') {
              if (!this.deps.triggerJoin || !this.deps.isJoinBusy || !this.deps.joinedTodayCount || !this.deps.joinDailyCap) continue;
              const platform = this.deps.getPlatform ? await this.deps.getPlatform(accountId) : 'xiaohongshu';
              if (platform !== 'facebook') continue;
              joinAutomation = this.deps.joinAutomationFor?.(accountId) ?? null;
              if (!joinAutomation?.enabled || joinAutomation.dailyCap <= 0) continue;
              if (joinAutomation.weekMask !== null) {
                if (!isValidWeekActiveMask(joinAutomation.weekMask) || !isWeekActiveAt(joinAutomation.weekMask, now)) continue;
              }
            }
            if (action === 'comment') {
              if (!actionModeEnabled(s.commentMode) || s.commentDailyCap <= 0) continue;
              // 评论三件套未注入（如 commentScheduler 未建）→ 评论动作整体跳过（零回归）。
              if (!this.deps.triggerComment || !this.deps.isCommentBusy || !this.deps.commentedTodayCount) continue;
            }
            if (action === 'contact_comment') {
              if (!actionModeEnabled(s.contactCommentMode) || s.contactCommentDailyCap <= 0) continue;
              // 联系评论两件套未注入（或评论机器缺）→ 该动作整体跳过（零回归）。
              if (!this.deps.triggerContactComment || !this.deps.isCommentBusy || !this.deps.contactAttemptsTodayCount) continue;
            }
            const delegatedFamily = action === 'post' ? 'publish' : 'comment';
            if (this.deps.delegatedOwnershipBusy && await this.deps.delegatedOwnershipBusy(accountId, delegatedFamily)) {
              this.deps.logger?.info?.(
                `[content-scheduler] 委托任务持有 ownership，排期诚实让位 account=${accountId} family=${delegatedFamily}`,
              );
              continue;
            }
            // 幂等：每动作独立小时格键（发帖触发绝不吞同小时评论槽）。
            const fireKey = `${accountId}|${action}`;
            // 分钟错峰（按动作独立哈希，动作间自然岔开）；「未开始」后本小时格内的重试窗同样放行。
            if (!this.shouldFireNow(accountId, action, fireKey, cell, now, minute)) continue;
            if (this.lastFired.get(fireKey) === cell) continue;
            // 风控 normal 闸（账号级，靠后放：仅命中分钟才付 async 成本）。
            if ((await this.deps.riskStatus(accountId)) !== 'normal') break;

            if (action === 'post') {
              // Only automatic posting needs a frozen browser environment. Other scheduled actions retain the
              // established online-account behavior and are not silently disabled for legacy edge identities.
              if (!identity.envKey) continue;
              const postIdentity: VerifiedOnlineAccountIdentity = { accountId, envKey: identity.envKey };
              // 账号粒度自主单飞（change parallel-rewrite-drafts）：该账号已有自主轮在跑 → 本槽顺延；
              // 洗稿在途不让槽（全局并发帽由 claim 层兜底，帽满触发同样诚实 skipped）。postFiring 保留：
              // 防同一 tick 内多账号齐发的错峰意义独立于旧槽污染理由。
              if (this.postFiring || this.deps.isPublishBusy(accountId)) continue;
              // 日上限原子：已发历史 + 在途自主草稿真实条数（洗稿候选不计入）。
              const [posted, pendingAuto] = await Promise.all([
                this.deps.postedTodayCount(accountId),
                this.deps.pendingAutonomousCount(accountId),
              ]);
              if (posted + pendingAuto >= s.postDailyCap) continue;

              const postMode = s.postMode;
              if (!actionModeEnabled(postMode)) continue;
              const platform = this.deps.getPlatform ? await this.deps.getPlatform(accountId) : 'xiaohongshu';
              if (platform === 'facebook') {
                if (postMode === 'auto_approve') {
                  this.deps.logger?.warn(`[content-scheduler] Facebook 发帖 MVP 不支持 auto_approve account=${accountId}，本槽跳过`);
                  continue;
                }
                const available = this.deps.availablePublishMediaCount
                  ? await this.deps.availablePublishMediaCount(accountId).catch(() => 0)
                  : 0;
                if (available <= 0) {
                  this.deps.logger?.warn(`[content-scheduler] Facebook 发帖素材不足 account=${accountId}，本槽跳过`);
                  continue;
                }
              }
              const claimed = await this.deps.claimPostHourCell(postIdentity, cell);
              if (!claimed) {
                this.deps.logger?.info?.(
                  `[content-scheduler] 自动发帖小时格已被占用 account=${accountId} env=${postIdentity.envKey} target=${this.deps.executionTarget} cell=${cell}`,
                );
                continue;
              }
              const execution: ScheduledPostExecution = {
                executionTarget: this.deps.executionTarget,
                envKey: postIdentity.envKey,
                hourCell: cell,
              };
              this.postFiring = true;
              this.fire(
                accountId,
                action,
                fireKey,
                cell,
                () => this.deps.triggerPost(accountId, postMode, execution),
                () => {
                  this.postFiring = false;
                },
              );
            } else if (action === 'comment') {
              // 评论单飞：任务在跑不重触发（cap 的「在跑?1:0」项在此恒 0——在跑早被拦下）。
              if (this.deps.isCommentBusy!(accountId)) continue;
              // 跨调度器互斥（change facebook-manual-join-comment）：该账号正在加群（含手动 /comment --join 的加群阶段）→ 本 tick 不再起评论，
              // 让同一物理边端不被 join↔comment 交错驱动（isJoinBusy 未注入则不闸、零回归）。
              if (this.deps.isJoinBusy?.(accountId)) continue;
              // 日上限原子：持久已发计数（评论管线任务内联等审 + 单飞，无排队草稿窗口，无需在途台账）。
              const sent = await this.deps.commentedTodayCount!(accountId);
              if (sent >= s.commentDailyCap) continue;

              const commentMode = s.commentMode;
              if (!actionModeEnabled(commentMode)) continue;
              this.fire(accountId, action, fireKey, cell, () => this.deps.triggerComment!(accountId, commentMode));
            } else if (action === 'join') {
              if (this.deps.isJoinBusy!(accountId)) continue;
              // 跨调度器互斥（change facebook-manual-join-comment）：该账号正在评论（含手动 /comment [--join] 的评论阶段）→ 本 tick 不起加群，
              // 后台自动加群绝不闯入正在进行的评论、抢同一物理边端（isCommentBusy 未注入则不闸、零回归）。
              if (this.deps.isCommentBusy?.(accountId)) continue;
              const [joined, riskCap] = await Promise.all([
                this.deps.joinedTodayCount!(accountId),
                this.deps.joinDailyCap!(accountId),
              ]);
              const effectiveCap = Math.min(joinAutomation?.dailyCap ?? 0, riskCap);
              if (effectiveCap <= 0 || joined >= effectiveCap) continue;

              this.fire(accountId, action, fireKey, cell, () => this.deps.triggerJoin!(accountId));
            } else {
              // 联系评论：单飞复用评论机器（同一 isRunning，评论/联系评论互斥天然成立）。
              if (this.deps.isCommentBusy!(accountId)) continue;
              // 跨调度器互斥（change facebook-manual-join-comment）：正在加群 → 本 tick 不起联系评论（同一物理边端，isJoinBusy 未注入则不闸）。
              if (this.deps.isJoinBusy?.(accountId)) continue;
              // 尝试型日上限：持久 attempts 台账（被拒/无目标也占额度，保守方向；重启不清零）。
              const attempts = await this.deps.contactAttemptsTodayCount!(accountId);
              if (attempts >= s.contactCommentDailyCap) continue;

              const contactCommentMode = s.contactCommentMode;
              if (!actionModeEnabled(contactCommentMode)) continue;
              this.fire(accountId, action, fireKey, cell, () => this.deps.triggerContactComment!(accountId, contactCommentMode));
            }
            break; // 每账号每 tick 至多一动作（防同分钟双动作抢边端）。
          }
        } catch (e) {
          this.deps.logger?.warn(`[content-scheduler] tick 账号处理异常 account=${accountId}：${(e as Error).message}`);
        }
      }
    } finally {
      this.tickRunning = false;
    }
  }
}
