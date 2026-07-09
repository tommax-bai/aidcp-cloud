/**
 * 受闸自动评论触发 helper（change feed-hot-lead-auto-group-comment）。
 *
 * 非人工命令（自动化）场景——排期评论、排期联系评论、浏览触发联系评论——的**统一安全闸序 + 记账时机**，
 * 一处定义、三源共用，杜绝两份漂移（CLAUDE.md 热点纪律）。
 *
 * 统一模型（用户 2026-07-09 定）：群评（联系评论）与普通评论**共用同一评论安全上限**——
 *  - 场次：单场会话评论预算（`getSessionCommentBudgetRemaining`，仅浏览路径给；排期无会话概念）；
 *  - 时/日：`canDo('comment')`（共用评论安全配额，自动化触达发出后 `recordComment` 消费之）；
 *  - 子上限：`contact_comment_daily_cap`（`countAttemptsToday < cap`），生效 = min(配置, 上面两层)——
 *    因 canDo 与场次先过闸，故子上限只需与配置比较，min 由闸序天然实现。
 *
 * 红线：任一闸不过 MUST 不触发；**仅当触发回执 `ok`** 才记尝试。`recordComment` 默认为触发 ok 后消费
 * 共用配额；调用方可用 `recordCommentOnTrigger=false` 改为在最终 `commented` 回调里消费，避免「未产出但占 comment」。
 * 人工 `/comment` 命令不走本 helper（人是刹车）。
 */

export type AutoCommentSource = 'scheduled_comment' | 'scheduled_contact' | 'hot_lead';

export interface GatedAutoCommentSnapshot {
  noteId?: string;
  velocity?: number;
  ageHours?: number;
}

export interface GatedAutoCommentDeps {
  /** 共用评论安全配额（时/日）当下是否放行。接 riskController.canDo('comment')。 */
  canComment: (accountId: string) => Promise<boolean>;
  /** 消费共用评论安全配额。接 riskController.record('comment')。仅触发 ok 后调。 */
  recordComment: (accountId: string) => Promise<boolean>;
  /** 今日该账号联系评论尝试数（子上限计数）。接 store.countContactAttemptsToday。 */
  countAttemptsToday: (accountId: string) => Promise<number>;
  /** 子上限配置（contact_comment_daily_cap）。 */
  getDailyCap: (accountId: string) => Promise<number>;
  /** 记一条尝试（子上限 + 审计快照）。接 store.recordContactCommentAttempt。仅触发 ok 后调。 */
  recordAttempt: (accountId: string, source: AutoCommentSource, snapshot?: GatedAutoCommentSnapshot) => Promise<void>;
  /** 场次：单场会话评论预算剩余（仅浏览路径给；缺省视为不限，排期无会话）。 */
  getSessionCommentBudgetRemaining?: (accountId: string) => number;
}

export interface TriggerReceiptLike {
  ok: boolean;
  reason?: string;
  /** 缺省 true；false 表示触发成功不立刻消耗 comment 配额，由触发方在最终 commented 后自行 recordComment。 */
  recordCommentOnTrigger?: boolean;
}

export interface GatedAutoCommentResult {
  fired: boolean;
  /** 未触发原因：session_budget / risk_blocked / daily_cap / 或触发闭包回执 reason。 */
  reason?: string;
}

/**
 * 过统一安全闸后触发一次自动评论/联系评论，回执 ok 才记尝试；comment 配额可按回执策略触发即记或最终成功后记。
 * triggerFn 为触发闭包（排期＝triggerManual({injectContact})；浏览＝triggerTargeted({noteId,title},{injectContact})）。
 */
export async function triggerGatedAutoComment(
  args: {
    accountId: string;
    source: AutoCommentSource;
    snapshot?: GatedAutoCommentSnapshot;
    triggerFn: () => Promise<TriggerReceiptLike>;
  },
  deps: GatedAutoCommentDeps,
): Promise<GatedAutoCommentResult> {
  const { accountId, source, snapshot, triggerFn } = args;

  // 场次（单场评论预算）——仅浏览路径给取值口。
  if (deps.getSessionCommentBudgetRemaining) {
    const remaining = deps.getSessionCommentBudgetRemaining(accountId);
    if (!(remaining > 0)) return { fired: false, reason: 'session_budget' };
  }

  // 时/日共用评论安全配额（状态 + 时窗）。
  if (!(await deps.canComment(accountId))) return { fired: false, reason: 'risk_blocked' };

  // 子上限（配置），与上面两层叠加即 min。
  const [attempts, cap] = await Promise.all([deps.countAttemptsToday(accountId), deps.getDailyCap(accountId)]);
  if (attempts >= cap) return { fired: false, reason: 'daily_cap' };

  // 触发。
  const receipt = await triggerFn();
  if (!receipt.ok) return { fired: false, reason: receipt.reason ?? 'trigger_rejected' };

  // 仅 ok 才记账：子上限/审计记录触发尝试；comment 配额默认触发即记，hot-lead 当前笔记直评改为最终 commented 后记。
  if (receipt.recordCommentOnTrigger !== false) {
    await deps.recordComment(accountId).catch(() => false);
  }
  await deps.recordAttempt(accountId, source, snapshot).catch(() => {});
  return { fired: true };
}
