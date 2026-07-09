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
 * - **发帖全局串行**：下发前过注入的 isPublishBusy()（真全局闸），忙则本槽顺延（本小时不发）。
 * - **fire-and-forget**：triggerPost 走耗时生成管线；心跳绝不 await 它（否则单分钟被阻塞、其它账号饿死、错峰被击穿）。
 * - **幂等**：(account, 小时格) 同格不重触发；**tick 重入护栏**：上轮未完即跳过本轮。
 * - **日上限原子**：已发历史 + 在途未审草稿之和 >= cap 则不发（防重启丢内存态 / 双扳机超发）。
 * - **风控 normal 闸**：非 normal 态不自动放量。
 *
 * localDayKey：本模块自带（服务器本地 YYYY-MM-DD），刻意不导出 role-dispatcher 的同名函数以避开热点文件。
 */

import { isValidWeekActiveMask, isWeekActiveAt } from '../risk/session-limits.js';

/** 调度器每 tick 现读的生效排期（effectiveMask 已由 store 解析：override ?? global）。 */
export interface ContentScheduleView {
  autoEnabled: boolean;
  postEnabled: boolean;
  postDailyCap: number;
  /** 自动评论开关 / 日上限（change content-schedule-comments）。 */
  commentEnabled: boolean;
  commentDailyCap: number;
  /** 自动带联系方式评论开关 / 每日尝试上限（change content-schedule-group-comments）。 */
  contactCommentEnabled: boolean;
  contactCommentDailyCap: number;
  effectiveMask: string | null;
}

export interface ContentSchedulerDeps {
  /** 当前在线账号（连接注册表访问器）。 */
  onlineAccounts(): string[];
  /** 单账号生效排期（store.effectiveScheduleFor，内存现读）。 */
  scheduleFor(accountId: string): ContentScheduleView;
  /** 风控状态（只 'normal' 才自动）。可同步或异步（server 侧按账号 registry 解析是 async）。 */
  riskStatus(accountId: string): string | Promise<string>;
  /** 今日已发帖数（持久历史，按账号 Asia/Shanghai 自然日）。 */
  postedTodayCount(accountId: string): Promise<number>;
  /** 是否有在途未审发帖草稿（防 TOCTOU 超发）。 */
  hasPendingPost(accountId: string): Promise<boolean>;
  /** 发帖是否全局忙（全局串行闸，无 accountId）。 */
  isPublishBusy(): boolean;
  /**
   * 当前是否在「可活跃时间」（浏览周历掩码）内 —— **自动内容时窗 ⊆ 活跃时段** 的强制闸（用户拍板：
   * 休眠格绝不自动发内容，账号"睡着"的时段准点发帖本身就是不自然信号）。语义沿浏览掩码的 fail-open
   * （缺失/未配=全天活跃=不额外限制）；缺省不注入=不限制（零回归、纯测试桩兼容）。
   */
  browseActiveAt?(now: Date): boolean;
  /** 触发排期发帖：**fire-and-forget**——返回一个在生成完成/失败时 settle 的 promise，调度器只挂 finally、绝不 await。
   *  该实现负责走既有提议→人审→派发、并异步补飞书结果卡（成功/空槽/失败）。 */
  triggerPost(accountId: string): Promise<unknown>;
  /**
   * 评论动作三件套（change content-schedule-comments）。可选：任一未注入 → 评论动作整体跳过（零回归）。
   * triggerComment 的实现负责 canDo('comment') 配额闸 + 调命令式评论入口 + 触发失败回黄卡（终态结果卡由评论链自补）。
   */
  triggerComment?(accountId: string): Promise<unknown>;
  /** 该账号评论任务是否在跑（= commentScheduler.isRunning，单飞闸）。 */
  isCommentBusy?(accountId: string): boolean;
  /** 该账号今日已发评论数（持久互动记录，Asia/Shanghai 自然日）。 */
  commentedTodayCount?(accountId: string): Promise<number>;
  /**
   * 带联系方式评论两件套（change content-schedule-group-comments）。可选：任一未注入 → 该动作整体跳过（零回归）。
   * triggerContactComment 实现负责 canDo('comment') 配额闸 + triggerManual(injectContact:true) + 回执 ok 记持久 attempt +
   * 触发失败回黄卡（缺联系方式 fail-closed 由触发回执透传；终态结果卡评论链自补）。单飞复用 isCommentBusy（同一评论机器）。
   */
  triggerContactComment?(accountId: string): Promise<unknown>;
  /** 该账号今日带联系方式评论自动尝试数（持久 attempts 台账，Asia/Shanghai 自然日；尝试型上限）。 */
  contactAttemptsTodayCount?(accountId: string): Promise<number>;
  now?: () => number;
  logger?: { warn: (m: string) => void; info?: (m: string) => void };
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

export class ContentScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private tickRunning = false;
  /**
   * 发帖全局串行（同步置位）：防同一 tick 内先后给两个账号 fire → 两次并发发帖污染 publishAccountRef 全局槽 /
   * finally-复位竞态（对抗评审阻断项）。fire 时同步置 true、triggerPost settle 时清；配合注入的 isPublishBusy()
   * （覆盖手动 /publish）构成「同刻至多一个账号在发帖」。
   */
  private postFiring = false;
  /** 每账号跨动作单飞（本 Phase 只发帖；为 Phase 2/3 预留背板）。 */
  private readonly inFlight = new Set<string>();
  /** 幂等：`account|action` → 上次触发的小时格键（每动作独立，发帖触发不吞同小时评论槽）。 */
  private readonly lastFired = new Map<string, string>();

  constructor(private readonly deps: ContentSchedulerDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
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

      for (const accountId of this.deps.onlineAccounts()) {
        try {
          const s = this.deps.scheduleFor(accountId);
          // 账号级闸（对所有动作统一）：总开关 / fail-closed 内容格 / 自动 ⊆ 活跃 / 单飞。
          if (!s.autoEnabled) continue;
          if (!isValidWeekActiveMask(s.effectiveMask) || !isWeekActiveAt(s.effectiveMask, now)) continue;
          if (this.deps.browseActiveAt && !this.deps.browseActiveAt(now)) continue;
          if (this.inFlight.has(accountId)) continue;

          // 动作循环（post 在前：纯云端、不接管边端；每账号每 tick 至多 fire 一个动作）。
          for (const action of ['post', 'comment', 'contact_comment'] as const) {
            if (action === 'post' && (!s.postEnabled || s.postDailyCap <= 0)) continue;
            if (action === 'comment') {
              if (!s.commentEnabled || s.commentDailyCap <= 0) continue;
              // 评论三件套未注入（如 commentScheduler 未建）→ 评论动作整体跳过（零回归）。
              if (!this.deps.triggerComment || !this.deps.isCommentBusy || !this.deps.commentedTodayCount) continue;
            }
            if (action === 'contact_comment') {
              if (!s.contactCommentEnabled || s.contactCommentDailyCap <= 0) continue;
              // 带联系方式评论两件套未注入（或评论机器缺）→ 该动作整体跳过（零回归）。
              if (!this.deps.triggerContactComment || !this.deps.isCommentBusy || !this.deps.contactAttemptsTodayCount) continue;
            }
            // 分钟错峰（按动作独立哈希，动作间自然岔开）。
            if (minute !== offsetMinute(accountId, now, action)) continue;
            // 幂等：每动作独立小时格键（发帖触发绝不吞同小时评论槽）。
            const fireKey = `${accountId}|${action}`;
            if (this.lastFired.get(fireKey) === cell) continue;
            // 风控 normal 闸（账号级，靠后放：仅命中分钟才付 async 成本）。
            if ((await this.deps.riskStatus(accountId)) !== 'normal') break;

            if (action === 'post') {
              // 发帖全局串行：本调度器已有发帖在飞 或 手动 /publish 在跑 → 本槽顺延（不 burst）。
              if (this.postFiring || this.deps.isPublishBusy()) continue;
              // 日上限原子：已发历史 + 在途未审草稿。
              const [posted, pending] = await Promise.all([
                this.deps.postedTodayCount(accountId),
                this.deps.hasPendingPost(accountId),
              ]);
              if (posted + (pending ? 1 : 0) >= s.postDailyCap) continue;

              this.lastFired.set(fireKey, cell);
              this.inFlight.add(accountId);
              this.postFiring = true;
              void this.deps
                .triggerPost(accountId)
                .catch((e) => this.deps.logger?.warn(`[content-scheduler] triggerPost 异常 account=${accountId}：${(e as Error).message}`))
                .finally(() => {
                  this.inFlight.delete(accountId);
                  this.postFiring = false;
                });
            } else if (action === 'comment') {
              // 评论单飞：任务在跑不重触发（cap 的「在跑?1:0」项在此恒 0——在跑早被拦下）。
              if (this.deps.isCommentBusy!(accountId)) continue;
              // 日上限原子：持久已发计数（评论管线任务内联等审 + 单飞，无排队草稿窗口，无需在途台账）。
              const sent = await this.deps.commentedTodayCount!(accountId);
              if (sent >= s.commentDailyCap) continue;

              this.lastFired.set(fireKey, cell);
              this.inFlight.add(accountId);
              void this.deps
                .triggerComment!(accountId)
                .catch((e) => this.deps.logger?.warn(`[content-scheduler] triggerComment 异常 account=${accountId}：${(e as Error).message}`))
                .finally(() => this.inFlight.delete(accountId));
            } else {
              // 带联系方式评论：单飞复用评论机器（同一 isRunning，评论/带联系方式评论互斥天然成立）。
              if (this.deps.isCommentBusy!(accountId)) continue;
              // 尝试型日上限：持久 attempts 台账（被拒/无目标也占额度，保守方向；重启不清零）。
              const attempts = await this.deps.contactAttemptsTodayCount!(accountId);
              if (attempts >= s.contactCommentDailyCap) continue;

              this.lastFired.set(fireKey, cell);
              this.inFlight.add(accountId);
              void this.deps
                .triggerContactComment!(accountId)
                .catch((e) => this.deps.logger?.warn(`[content-scheduler] triggerContactComment 异常 account=${accountId}：${(e as Error).message}`))
                .finally(() => this.inFlight.delete(accountId));
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
