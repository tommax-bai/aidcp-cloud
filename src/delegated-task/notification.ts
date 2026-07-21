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
 * 设计（change feishu-delegated-suppress-progress-cards + delegated-executor-operator-authority-parity）：
 * 委托层**不再主动推送任务进度卡**；每类任务的结果由它自己的正常业务结果卡承担——
 *  - 发帖成功 / 等待人审（'publish' 且 completed / waiting_approval）：发布人审卡自证（成功不重复报绿、
 *    等待由人审卡本身承担）→ 委托层不发。
 *  - 候选稿管理（'candidate_control'）：由 console 侧自报 → 委托层不发。
 *  - **发帖类终态失败**（'publish' 且 failed / 有缺口的 partially_completed）：没有独立结果卡，委托层
 *    必须补一张，否则失败静默（红线：绝不静默失败）。
 *  - **评论类「起跑前触发闸失败」**（'comment' 且 failed、successCount=0、终态码 `non_retryable_failure`）：
 *    评论链的 `postResultCard` 只在异步任务真正起跑到终态时才发；人设未绑 / 联系方式缺 / 平台不支持 /
 *    未接线等在起跑前就早退，从未发过结果卡。此类**必须补一张诚实卡**（红线）。**已起跑再失败**的评论
 *    由评论链自报，委托层**不补、避免双发**——判据＝终态码是否为 `non_retryable_failure`（仅起跑前失败
 *    走该非重试终态，起跑后失败走 max_attempts / deadline，各自已有卡或属 Finding D 另治）。
 *
 * 返回 null = 委托层不发卡。
 */
export function delegatedTaskFailureReceipt(
  task: DelegatedTask,
): { level: 'warning' | 'error'; title: string; message: string } | null {
  if (task.terminalOutcome?.code === 'candidate_cancelled_by_user') return null;
  const successCount = task.progress.successCount;
  if (task.actionFamily === 'publish') {
    const failedTerminal =
      task.status === 'failed' ||
      (task.status === 'partially_completed' && successCount < task.targetSuccessCount);
    if (!failedTerminal) return null;
    const detail = task.terminalOutcome?.message ?? `真实完成 ${successCount}/${task.targetSuccessCount}`;
    return successCount > 0
      ? { level: 'warning', title: '发帖任务部分完成', message: detail }
      : { level: 'error', title: '发帖任务未成', message: detail };
  }
  if (task.actionFamily === 'comment') {
    // fallback-only：仅补「起跑前触发闸失败」（评论链从未发结果卡的唯一一类），绝不与 postResultCard 双发。
    const preLaunchFail =
      task.status === 'failed' && successCount === 0 &&
      task.terminalOutcome?.code === 'non_retryable_failure';
    if (!preLaunchFail) return null;
    return { level: 'error', title: '评论任务未触发', message: task.terminalOutcome?.message ?? '触发失败，任务未执行。' };
  }
  return null;
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
