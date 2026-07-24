import type { DelegatedTaskConfirmationSummary, DelegatedTaskServicePort } from '../kernel/delegated-task-types.js';
import { DelegatedTaskServiceError } from '../kernel/delegated-task-types.js';
import type { DelegatedTask } from '../kernel/delegated-task-types.js';
import type { FeishuCard, FeishuField, FeishuHeaderTemplate } from './types.js';

export type DelegatedTaskCardAction = 'confirm' | 'cancel' | 'pause' | 'resume' | 'status';

export interface DelegatedTaskCardActionValue {
  action: `delegated_task_${DelegatedTaskCardAction}`;
  taskId: string;
  version: number;
}

export function parseDelegatedTaskCardAction(value: unknown): DelegatedTaskCardActionValue | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.action !== 'string' || !/^delegated_task_(confirm|cancel|pause|resume|status)$/.test(row.action)) return null;
  if (typeof row.taskId !== 'string' || !/^[0-9a-f-]{36}$/i.test(row.taskId)) return null;
  if (!Number.isInteger(row.version)) return null;
  return row as unknown as DelegatedTaskCardActionValue;
}

export function buildDelegatedTaskConfirmationCard(summary: DelegatedTaskConfirmationSummary): FeishuCard {
  const fields: FeishuField[] = [
    { is_short: true, text: { tag: 'lark_md', content: `**账号**\n${summary.accountName}` } },
    { is_short: true, text: { tag: 'lark_md', content: `**平台**\n${summary.platformLabel}${summary.capability === 'beta' ? '（Beta）' : ''}` } },
    { is_short: false, text: { tag: 'lark_md', content: `**动作**\n${summary.actionLabel}` } },
    { is_short: true, text: { tag: 'lark_md', content: `**目标**\n${summary.target}` } },
    { is_short: true, text: { tag: 'lark_md', content: `**尝试上限**\n${summary.attempts}` } },
    { is_short: false, text: { tag: 'lark_md', content: `**执行窗口**\n${summary.schedule}` } },
    { is_short: false, text: { tag: 'lark_md', content: `**人审**\n${summary.approval}` } },
    { is_short: true, text: { tag: 'lark_md', content: `**优先级**\n${summary.priority}` } },
  ];
  if (summary.constraints.length > 0) {
    fields.push({ is_short: false, text: { tag: 'lark_md', content: `**约束**\n${summary.constraints.join('\n')}` } });
  }
  if (summary.capabilityReason) {
    fields.push({ is_short: false, text: { tag: 'lark_md', content: `**Beta 边界**\n${summary.capabilityReason}` } });
  }
  return {
    config: { wide_screen_mode: true },
    header: { template: summary.capability === 'beta' ? 'orange' : 'blue', title: { tag: 'plain_text', content: '请确认用户委托任务' } },
    elements: [
      { tag: 'div', fields },
      { tag: 'div', text: { tag: 'lark_md', content: `任务编号：\`${summary.taskId}\`\n成功数只按平台验证结果计算；候选不足可能部分完成，不会降级凑数。` } },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button', text: { tag: 'plain_text', content: '确认并排队' }, type: 'primary',
            value: { action: 'delegated_task_confirm', taskId: summary.taskId, version: summary.version },
          },
          {
            tag: 'button', text: { tag: 'plain_text', content: '取消' }, type: 'danger',
            value: { action: 'delegated_task_cancel', taskId: summary.taskId, version: summary.version },
          },
        ],
      },
    ],
  };
}

function taskTemplate(task: DelegatedTask): FeishuHeaderTemplate {
  if (task.status === 'completed') return 'green';
  if (task.status === 'failed' || task.status === 'cancelled') return 'red';
  if (task.status === 'partially_completed' || task.status === 'deferred') return 'yellow';
  return 'blue';
}

export function buildDelegatedTaskProgressCard(task: DelegatedTask): FeishuCard {
  const p = task.progress;
  const controls = [];
  if (!['completed', 'partially_completed', 'cancelled', 'failed'].includes(task.status)) {
    if (task.pauseRequested || task.status === 'deferred' && task.currentStep === 'paused_by_user') {
      controls.push({
        tag: 'button' as const, text: { tag: 'plain_text' as const, content: '恢复' }, type: 'primary' as const,
        value: { action: 'delegated_task_resume', taskId: task.id, version: task.version },
      });
    } else {
      controls.push({
        tag: 'button' as const, text: { tag: 'plain_text' as const, content: '完成当前安全动作后暂停' },
        value: { action: 'delegated_task_pause', taskId: task.id, version: task.version },
      });
    }
    controls.push({
      tag: 'button' as const, text: { tag: 'plain_text' as const, content: '取消剩余部分' }, type: 'danger' as const,
      value: { action: 'delegated_task_cancel', taskId: task.id, version: task.version },
    });
  }
  controls.push({
    tag: 'button' as const, text: { tag: 'plain_text' as const, content: '刷新状态' },
    value: { action: 'delegated_task_status', taskId: task.id, version: task.version },
  });
  const outcome = task.terminalOutcome
    ? `\n**结果**：${task.terminalOutcome.message}${task.terminalOutcome.submittedUnknown ? '\n⚠️ 已提交但未验证，为防重复未自动重试。' : ''}`
    : '';
  return {
    config: { wide_screen_mode: true },
    header: { template: taskTemplate(task), title: { tag: 'plain_text', content: `委托任务 · ${task.status}` } },
    elements: [
      {
        tag: 'div', text: { tag: 'lark_md', content:
          `**账号**：${task.accountName}\n**平台 / 动作**：${task.platform} / ${task.action}\n` +
          `**成功**：${p.successCount}/${task.targetSuccessCount}　**尝试**：${p.attemptCount}/${task.maxAttempts}\n` +
          `**跳过**：${p.skippedCount}　**失败**：${p.failureCount}\n**当前步骤**：${task.currentStep ?? '—'}${outcome}\n` +
          `任务编号：\`${task.id}\``,
        },
      },
      { tag: 'action', actions: controls },
    ],
  };
}

export async function handleDelegatedTaskCardAction(
  service: DelegatedTaskServicePort,
  value: unknown,
): Promise<{ toast: { type: 'success' | 'error' | 'info'; content: string }; card?: { type: 'raw'; data: FeishuCard } } | null> {
  const parsed = parseDelegatedTaskCardAction(value);
  if (!parsed) return null;
  try {
    const task = parsed.action === 'delegated_task_confirm'
      ? await service.confirm(parsed.taskId, parsed.version)
      : parsed.action === 'delegated_task_cancel'
        ? await service.cancel(parsed.taskId, parsed.version)
        : parsed.action === 'delegated_task_pause'
          ? await service.pause(parsed.taskId, parsed.version)
          : parsed.action === 'delegated_task_resume'
            ? await service.resume(parsed.taskId, parsed.version)
            : await service.get(parsed.taskId);
    const content = parsed.action === 'delegated_task_confirm'
      ? '已确认并排队'
      : parsed.action === 'delegated_task_cancel'
        ? '已取消剩余部分'
        : parsed.action === 'delegated_task_pause'
          ? '将在当前安全动作完成后暂停'
          : parsed.action === 'delegated_task_resume'
            ? '已恢复排队'
            : '已刷新任务状态';
    // card.action.trigger 回调响应里的 card 必须按新版卡片协议包成 { type: 'raw', data }——
    // 直接回裸 FeishuCard 会触发飞书错误 200672（与发布审批卡同源，见 18c6f2b / feishu-publish-approval-e2e.md）。
    return { toast: { type: 'success', content }, card: { type: 'raw', data: buildDelegatedTaskProgressCard(task) } };
  } catch (err) {
    const known = err instanceof DelegatedTaskServiceError;
    return {
      toast: { type: known && err.code === 'version_conflict' ? 'info' : 'error', content: (err as Error).message },
      ...(known && err.code === 'version_conflict'
        ? { card: { type: 'raw' as const, data: buildDelegatedTaskProgressCard(await service.get(parsed.taskId)) } }
        : {}),
    };
  }
}
