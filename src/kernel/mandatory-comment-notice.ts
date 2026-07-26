/**
 * 强制评论收敛结局与其通知的**纯数据模型**（原定义在 src/orchestrator/role-dispatcher.ts，automation）。
 * 抬入 kernel（change decouple-longtail-sweep）供飞书卡片层跨边界共导。
 * 零 import、零 SQL、零 HTTP、零 LLM、无进程内活状态，满足 §4.7 kernel 准入。
 * 角色调度器实现留 role-dispatcher.ts（automation）并等值再导出。
 */
export type MandatoryCommentOutcome = 'confirmed' | 'pending' | 'failed' | 'unknown';

export interface MandatoryCommentOutcomeNoticeInput {
  requestId: string;
  noteId: string;
  text: string;
  outcome: MandatoryCommentOutcome;
  reason?: string;
  accountId?: string;
  accountName?: string;
  /** 命令来源会话；API owner 只用它做 origin-first 路由。 */
  originChatId?: string;
  title?: string;
  authorName?: string;
}
