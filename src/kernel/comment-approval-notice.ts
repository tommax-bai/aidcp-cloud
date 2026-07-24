/**
 * 评论人审/免审通知的**纯输入数据模型**（原定义在 src/agents/comment-approval-gate.ts，automation）。
 * 抬入 kernel（change decouple-longtail-sweep）供飞书卡片层跨边界共导。
 * 零 import、零 SQL、零 HTTP、零 LLM、无进程内活状态，满足 §4.7 kernel 准入。
 */
export interface CommentApprovalNoticeInput {
  requestId: string;
  noteId: string;
  text: string;
  title?: string;
  authorName?: string;
  accountId?: string;
  accountName?: string;
  approvalSource?: 'mandatory_persona' | 'account_global';
}
