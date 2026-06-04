/**
 * 飞书交互式卡片模板构建器。
 *
 * 按 product-feishu.md §3 的卡片 JSON 结构，把业务数据填充成 FeishuCard：
 * - buildDailySummaryCard：每日汇总（§2.1）；
 * - buildAlertCard：P0/P1 告警（§2.4）；
 * - buildCommandResultCard：指令回执（§2.2）。
 *
 * 卡片模板集中维护，业务侧只管传数据。
 */

import type {
  AccountStatus,
  AlertData,
  AlertSeverity,
  CommandResult,
  DailySummaryData,
  FeishuCard,
  FeishuField,
  FeishuHeaderTemplate,
  PublishApprovalCardData,
} from './types.js';

type PublishApprovalTerminalState = 'approved' | 'cancelled';

/** 各账号状态对应的徽标 emoji */
const STATUS_BADGE: Record<AccountStatus, string> = {
  normal: '🟢 normal',
  warned: '🟡 warned',
  restricted: '🔴 restricted',
  banned: '⚫ banned',
};

/** 告警严重度对应的卡片头部色 */
const SEVERITY_TEMPLATE: Record<AlertSeverity, FeishuHeaderTemplate> = {
  P0: 'red',
  P1: 'red',
  P2: 'orange',
  P3: 'yellow',
};

/** 把状态分布拼成 "🟢 normal × 6　🟡 warned × 1" 这样的一行 */
function formatStatusBreakdown(breakdown: Partial<Record<AccountStatus, number>>): string {
  const order: AccountStatus[] = ['normal', 'warned', 'restricted', 'banned'];
  const parts = order
    .filter((s) => (breakdown[s] ?? 0) > 0)
    .map((s) => `${STATUS_BADGE[s]} × ${breakdown[s]}`);
  return parts.length > 0 ? parts.join('　') : '（无账号）';
}

/** 每日汇总卡片 */
export function buildDailySummaryCard(data: DailySummaryData): FeishuCard {
  const likePct = `${Math.round(data.likeRate * 100)}%`;
  const likeBadge = data.likeRateHealthy ? '✅' : '⚠️';
  const fields: FeishuField[] = [
    {
      is_short: true,
      text: {
        tag: 'lark_md',
        content: `**在线账号**\n${data.onlineAccounts} / ${data.totalAccounts}`,
      },
    },
    {
      is_short: true,
      text: { tag: 'lark_md', content: `**总浏览**\n${data.totalViews}` },
    },
    {
      is_short: true,
      text: { tag: 'lark_md', content: `**点赞率**\n${likePct} ${likeBadge}` },
    },
    {
      is_short: true,
      text: { tag: 'lark_md', content: `**今日发布**\n${data.publishCount}` },
    },
  ];
  if (typeof data.newFollowers === 'number') {
    fields.push({
      is_short: true,
      text: { tag: 'lark_md', content: `**涨粉**\n${data.newFollowers}` },
    });
  }

  const card: FeishuCard = {
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: `AIDCP 昨日汇总 · ${data.date}` },
    },
    elements: [
      { tag: 'div', fields },
      { tag: 'hr' },
      {
        tag: 'div',
        text: { tag: 'lark_md', content: formatStatusBreakdown(data.statusBreakdown) },
      },
    ],
  };

  if (data.dashboardUrl) {
    card.elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '查看大盘' },
          type: 'primary',
          url: data.dashboardUrl,
        },
      ],
    });
  }
  return card;
}

/** P0/P1 告警卡片 */
export function buildAlertCard(alert: AlertData): FeishuCard {
  const acc = alert.accountName
    ? `${alert.accountName}${alert.accountId ? `(${alert.accountId})` : ''}`
    : (alert.accountId ?? '');
  const titleSuffix = acc ? ` · ${acc}` : '';
  const card: FeishuCard = {
    header: {
      template: SEVERITY_TEMPLATE[alert.severity],
      title: {
        tag: 'plain_text',
        content: `⚠️ ${alert.severity} ${alert.title}${titleSuffix}`,
      },
    },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content: alert.detail } }],
  };

  if (alert.actionUrl) {
    card.elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: alert.actionText ?? '去处理' },
          type: 'primary',
          url: alert.actionUrl,
        },
      ],
    });
  }
  return card;
}

/** 指令回执卡片 */
export function buildCommandResultCard(result: CommandResult): FeishuCard {
  const template: FeishuHeaderTemplate = result.ok ? 'green' : 'red';
  const icon = result.ok ? '✅' : '❌';
  const accLine = result.accountId ? `\n**账号**：${result.accountId}` : '';
  return {
    header: {
      template,
      title: { tag: 'plain_text', content: `${icon} ${result.title}` },
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**指令**：\`${result.command}\`${accLine}\n${result.message}`,
        },
      },
    ],
  };
}

function summarizeContent(content: string, maxLength = 120): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized || '（无正文）';
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function formatTags(tags: string[]): string {
  if (tags.length === 0) return '（无话题）';
  return tags.map((tag) => `#${tag}`).join(' ');
}

export function buildPublishApprovalCard(payload: PublishApprovalCardData): FeishuCard {
  return buildPublishApprovalStateCard(payload, 'pending');
}

function buildPublishApprovalStateCard(
  payload: PublishApprovalCardData,
  state: 'pending' | PublishApprovalTerminalState,
): FeishuCard {
  const summary = summarizeContent(payload.content);
  const tags = formatTags(payload.tags);
  const fields: FeishuField[] = [
    {
      is_short: false,
      text: { tag: 'lark_md', content: `**标题**\n${payload.title || '（无标题）'}` },
    },
    {
      is_short: false,
      text: { tag: 'lark_md', content: `**正文摘要**\n${summary}` },
    },
    {
      is_short: false,
      text: { tag: 'lark_md', content: `**话题**\n${tags}` },
    },
  ];
  const callbackValue = {
    requestId: payload.requestId,
    payload: {
      title: payload.title,
      content: payload.content,
      tags: payload.tags,
    },
  };
  const terminalText =
    state === 'approved'
      ? '**状态**\n✅ 已授权发布'
      : state === 'cancelled'
        ? '**状态**\n❌ 已取消发布'
        : null;

  if (terminalText) {
    fields.push({
      is_short: false,
      text: { tag: 'lark_md', content: terminalText },
    });
  }

  const card: FeishuCard = {
    config: { wide_screen_mode: true },
    header: {
      template: state === 'approved' ? 'green' : state === 'cancelled' ? 'grey' : 'orange',
      title: {
        tag: 'plain_text',
        content:
          state === 'approved' ? '已授权发布' : state === 'cancelled' ? '已取消发布' : '待授权发布',
      },
    },
    elements: [
      {
        tag: 'div',
        fields,
      },
    ],
  };

  if (state === 'pending') {
    card.elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '授权发布' },
          type: 'primary',
          behaviors: [{ type: 'callback', value: { action: 'approve', ...callbackValue } }],
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '取消' },
          type: 'danger',
          behaviors: [{ type: 'callback', value: { action: 'cancel', ...callbackValue } }],
        },
      ],
    });
  }

  return card;
}

export function buildApprovedPublishApprovalCard(payload: PublishApprovalCardData): FeishuCard {
  return buildPublishApprovalStateCard(payload, 'approved');
}

export function buildCancelledPublishApprovalCard(payload: PublishApprovalCardData): FeishuCard {
  return buildPublishApprovalStateCard(payload, 'cancelled');
}
