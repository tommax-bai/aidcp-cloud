/**
 * notification_triage — 分诊（拟人优先级 + 循环到未读清零，有界且诚实放弃）。
 *
 * 收 notification.home.arrived（每趟一次）→ 按优先级（评论和@ > 赞和收藏 > 新增关注）挑
 * **仍有未读且未超尝试上限**的最高类，记一次尝试 → category_selected。该类被看后下一轮 home 重报，
 * 若仍 > 0 则继续重挑（loop-to-zero），直到三栏全 0；某类到尝试上限仍未清零 → 诚实放弃该类
 * （记日志，不再选它、不空转、不假报已清）。无可挑（全 0 或全放弃）→ triage_done（交 resumer 收尾）。
 *
 * 取代旧的「选中即标记已处理、≤3 轮、不回头」——旧法「奔着收尾去」会在一眼没清干净时遗留未读；
 * 新法「奔着清零去」（change notification-clear-to-zero），终止由 MAX_ATTEMPTS_PER_CATEGORY 兜底。
 *
 * 消费事件：notification.home.arrived
 * 产出事件：notification.category_selected / notification.triage_done
 */

import { BaseRole } from './base-role.js';
import type { RoleOptions } from './base-role.js';
import { SessionContext } from './session-context.js';
import type { RoleName, NotificationCategory } from '../event-bus/types.js';

/** 拟人优先级：评论和@ 最高，其次赞和收藏，最后新增关注。 */
const PRIORITY: NotificationCategory[] = ['comments', 'likes', 'follows'];

/** 每类最多尝试清理次数（loop-to-zero 有界兜底）：到顶仍有未读 → 诚实放弃该类，绝不无限重选。 */
const DEFAULT_MAX_ATTEMPTS_PER_CATEGORY = 3;

export interface NotificationTriageOptions extends RoleOptions {
  /** 每类清理尝试上限（缺省 3）。测试可调小以缩短用例。 */
  maxAttemptsPerCategory?: number;
}

export class NotificationTriage extends BaseRole {
  readonly roleName: RoleName = 'notification_triage';
  private readonly ctx: SessionContext;
  private readonly maxAttempts: number;
  private unsubscribers: (() => void)[] = [];

  constructor(options: NotificationTriageOptions, ctx: SessionContext) {
    super(options);
    this.ctx = ctx;
    this.maxAttempts = options.maxAttemptsPerCategory ?? DEFAULT_MAX_ATTEMPTS_PER_CATEGORY;
  }

  subscribe(): void {
    this.unsubscribers.push(
      this.eventBus.on('notification.home.arrived', (p) => this.triage(p)),
    );
  }

  unsubscribe(): void {
    for (const u of this.unsubscribers) u();
    this.unsubscribers = [];
  }

  private triage(home: { comments: number; likes: number; follows: number }): void {
    if (!this.ctx.excursionActive) return; // 非巡视期的杂散首页上报，忽略
    const epoch = this.ctx.excursionEpoch ?? 0;
    const counts: Record<NotificationCategory, number> = {
      comments: home.comments,
      likes: home.likes,
      follows: home.follows,
    };
    const givenUp: string[] = [];
    for (const cat of PRIORITY) {
      if (counts[cat] <= 0) continue; // 已清零，跳过
      const attempts = this.ctx.getCategoryAttempts(cat);
      if (attempts >= this.maxAttempts) {
        // 到尝试上限仍有未读 → 诚实放弃该类（不再选它），继续看下一类
        givenUp.push(`${cat}(未读${counts[cat]}，已尝试${attempts}次)`);
        continue;
      }
      const n = this.ctx.incrementCategoryAttempts(cat); // 记一次尝试（loop-to-zero 的有界兜底）
      this.log(`选中分类 ${cat}（未读 ${counts[cat]}，第 ${n}/${this.maxAttempts} 次清理）epoch=${epoch}`);
      this.emit('notification.category_selected', { category: cat, epoch, ts: Date.now() });
      return;
    }
    // 无可挑：三栏全清零，或剩余未读都已到尝试上限被放弃
    if (givenUp.length > 0) {
      this.log(`诚实放弃未清零分类：${givenUp.join('、')}（到尝试上限仍有未读，不空转、不假报已清）epoch=${epoch}`);
    }
    this.log(`三栏均已清零或放弃，分诊完成 epoch=${epoch}`);
    this.emit('notification.triage_done', { epoch, ts: Date.now() });
  }
}
