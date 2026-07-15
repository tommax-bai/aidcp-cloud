import type { DelegatedTask } from './types.js';

export function delegatedTaskNotificationFingerprint(task: DelegatedTask): string {
  return JSON.stringify({
    status: task.status,
    currentStep: task.status === 'waiting_approval' ? 'waiting_approval' : task.currentStep,
    progress: task.progress,
    terminalOutcome: task.terminalOutcome,
    pauseRequested: task.pauseRequested,
    cancelRequested: task.cancelRequested,
  });
}

/**
 * 委托层是否要为这个任务终态补发一张「正常业务结果卡」。
 *
 * 设计（change feishu-delegated-suppress-progress-cards）：委托层**不再主动推送任务进度卡**；
 * 每类任务的结果由它自己的正常业务结果卡承担——
 *  - 评论（actionFamily 'comment'）：CommentScheduler 每轮 `postResultCard` 已发结果卡 → 委托层不重复发。
 *  - 发帖成功 / 等待人审（'publish' 且 completed / waiting_approval）：发布人审卡自证（成功不重复报绿、
 *    等待由人审卡本身承担）→ 委托层不发。
 *  - 候选稿管理（'candidate_control'）：由 console 侧自报 → 委托层不发。
 *  - **发帖类终态失败**（'publish' 且 failed / 有缺口的 partially_completed）：没有独立结果卡，委托层
 *    必须补一张，否则失败静默（红线：绝不静默失败）。
 *
 * 返回 null = 委托层不发卡。
 */
export function delegatedPublishOutcomeReceipt(
  task: DelegatedTask,
): { level: 'warning' | 'error'; title: string; message: string } | null {
  if (task.actionFamily !== 'publish') return null;
  const successCount = task.progress.successCount;
  const failedTerminal =
    task.status === 'failed' ||
    (task.status === 'partially_completed' && successCount < task.targetSuccessCount);
  if (!failedTerminal) return null;
  const detail = task.terminalOutcome?.message ?? `真实完成 ${successCount}/${task.targetSuccessCount}`;
  return successCount > 0
    ? { level: 'warning', title: '发帖任务部分完成', message: detail }
    : { level: 'error', title: '发帖任务未成', message: detail };
}

export class DelegatedTaskNotificationGate {
  private readonly sent = new Map<string, string>();

  shouldSend(task: DelegatedTask): boolean {
    return this.sent.get(task.id) !== delegatedTaskNotificationFingerprint(task);
  }

  markSent(task: DelegatedTask): void {
    this.sent.set(task.id, delegatedTaskNotificationFingerprint(task));
  }
}
