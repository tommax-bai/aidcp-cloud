import type { CommentApprovalNoticeInput } from '../kernel/comment-approval-notice.js';
import type { MandatoryCommentOutcomeNoticeInput } from '../kernel/mandatory-comment-notice.js';
import { buildCommandResultCard } from './cards.js';
import type { FeishuCard } from './types.js';

const COMMAND = '人设强制互动评论（免审授权）';

function targetLabel(input: { title?: string; authorName?: string }): string {
  return input.title?.trim() || input.authorName?.trim() || '目标内容';
}

function preview(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 160) || '（空）';
}

/** 机器原因只用于审计；操作员卡片一律转成人话，避免把内部 token 直接甩给用户。 */
export function mandatoryCommentOutcomeReason(reason?: string): string {
  if (!reason) return '平台未返回更具体的原因';
  if (reason === 'pending_group_approval') return '评论已提交，但所在群需要管理员批准后才会公开显示';
  if (reason === 'receipt_timeout') return '等待平台执行回执超时，无法确认评论是否已显示';
  if (reason === 'submitted_unconfirmed' || reason === 'verification_ambiguous') {
    return '提交动作可能已经发生，但页面校验不足，系统不会冒充成功或自动重发';
  }
  if (reason === 'preempted_by_task') return '执行期间账号被更高优先级任务接管，最终结果无法确认';
  if (reason.startsWith('session_ended:')) return '执行期间边缘连接或浏览会话结束，最终结果无法确认';
  if (reason.includes('quota:minute')) return '触发每分钟评论限额，本次没有下发';
  if (reason.includes('quota:hour')) return '触发每小时评论限额，本次没有下发';
  if (reason.includes('quota:day')) return '触发今日评论限额，本次没有下发';
  if (reason.includes('state:restricted') || reason.includes('state:frozen')) return '账号当前风控状态不允许评论，本次没有下发';
  if (reason.startsWith('risk:')) return '最终下发前风控未放行，本次没有发布';
  if (reason === 'comment_migration_suppressed') return '打开目标内容的步骤未能下发，评论没有发布';
  if (reason === 'comment_dispatch_suppressed') return '评论指令未能下发，评论没有发布';
  if (reason === 'nav_failed' || reason.includes('open_failed') || reason.includes('no_target')) {
    return '未能可靠打开或确认目标内容，为避免发错位置，评论没有发布';
  }
  if (reason.includes('captcha') || reason.includes('verification')) return '平台要求额外验证，评论没有发布';
  if (reason.includes('editor') || reason.includes('input')) return '页面上未找到可用的评论输入区域，评论没有发布';
  return '平台执行失败，系统没有把它标记为成功';
}

export function buildMandatoryCommentPreAuthorizationCard(input: CommentApprovalNoticeInput): FeishuCard {
  return buildCommandResultCard({
    command: COMMAND,
    ok: false,
    level: 'warning',
    title: '人设强制互动评论已预授权，等待平台执行',
    message:
      '该账号的人设结构化规则已明确授权此类内容必评，评论终稿已经生成；这只是允许系统尝试执行，不代表评论已经发布。平台返回结果后会再发一张终态卡。\n' +
      `**目标**：${targetLabel(input)}\n**正文预览**：${preview(input.text)}`,
    accountId: input.accountId,
    accountName: input.accountName,
  });
}

export function buildMandatoryCommentOutcomeCard(input: MandatoryCommentOutcomeNoticeInput): FeishuCard {
  const target = targetLabel(input);
  const reason = input.outcome === 'confirmed' && !input.reason
    ? '平台已确认评论成功发布'
    : mandatoryCommentOutcomeReason(input.reason);
  const common = `**目标**：${target}\n**正文预览**：${preview(input.text)}\n**结果说明**：${reason}`;
  if (input.outcome === 'confirmed') {
    return buildCommandResultCard({
      command: COMMAND,
      ok: true,
      level: 'success',
      title: '人设强制互动评论已由平台确认',
      message: `平台已返回真实成功回执，本次评论可以确认已发布。\n${common}`,
      accountId: input.accountId,
      accountName: input.accountName,
    });
  }
  if (input.outcome === 'pending') {
    return buildCommandResultCard({
      command: COMMAND,
      ok: false,
      level: 'warning',
      title: '评论已提交，等待群管理员批准',
      message: `评论尚未公开显示，不能算发布成功。\n${common}`,
      accountId: input.accountId,
      accountName: input.accountName,
    });
  }
  if (input.outcome === 'failed') {
    return buildCommandResultCard({
      command: COMMAND,
      ok: false,
      level: 'error',
      title: '人设强制互动评论未能发布',
      message: `本次执行已经明确失败，没有把评论标记为成功。\n${common}`,
      accountId: input.accountId,
      accountName: input.accountName,
    });
  }
  return buildCommandResultCard({
    command: COMMAND,
    ok: false,
    level: 'warning',
    title: '人设强制互动评论结果待确认',
    message: `当前拿不到可靠的平台终态；系统不会冒充成功，也不会自动重发以免重复评论。\n${common}`,
    accountId: input.accountId,
    accountName: input.accountName,
  });
}
