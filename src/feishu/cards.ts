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

function formatAccountDisplay(accountName?: string, accountId?: string): string {
  const name = accountName?.trim();
  if (name) return name;
  return accountId?.trim() ? '（未获取昵称）' : '';
}

/** P0/P1 告警卡片 */
export function buildAlertCard(alert: AlertData): FeishuCard {
  const acc = formatAccountDisplay(alert.accountName, alert.accountId);
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
  // 三态配色：缺省按 ok 推导（绿/红双态，老回执零改）；warning 走黄色 ⚠️，专治「触发成功但编排没成」被误染绿色。
  const level = result.level ?? (result.ok ? 'success' : 'error');
  const template: FeishuHeaderTemplate =
    level === 'success' ? 'green' : level === 'warning' ? 'yellow' : 'red';
  const icon = level === 'success' ? '✅' : level === 'warning' ? '⚠️' : '❌';
  const acc = formatAccountDisplay(result.accountName, result.accountId);
  const accLine = acc ? `\n**账号**：${acc}` : '';
  const platformLine = result.platformName ? `\n**平台**：${result.platformName}` : '';
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
          content: `**指令**：\`${result.command}\`${accLine}${platformLine}\n${result.message}`,
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
  const accountLabel = formatAccountDisplay(payload.accountName, payload.accountId);
  const fields: FeishuField[] = [
    ...(accountLabel
      ? [
          {
            is_short: false,
            text: { tag: 'lark_md' as const, content: `**账号**\n${accountLabel}` },
          },
        ]
      : []),
    ...(payload.platformName
      ? [
          {
            is_short: true,
            text: { tag: 'lark_md' as const, content: `**平台**\n${payload.platformName}` },
          },
        ]
      : []),
    ...(typeof payload.mediaCount === 'number'
      ? [
          {
            is_short: true,
            text: { tag: 'lark_md' as const, content: `**素材**\n${payload.mediaCount} 张` },
          },
        ]
      : []),
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
  // 编号（change edge-companion-ui 8.1）：与客户端发布卡「编号」对暗号（同源=发布记录 id）。
  // 仅 publish-<n> 形态的 requestId 展示（/publish_test 等调试卡不带，宁缺毋假）。
  const recordIdMatch = /^publish-(\d+)$/.exec(payload.requestId);
  if (recordIdMatch) {
    fields.push({
      is_short: true,
      text: { tag: 'lark_md', content: `**编号**\n#${recordIdMatch[1]}` },
    });
  }
  const callbackValue = {
    requestId: payload.requestId,
    payload: {
      title: payload.title,
      content: payload.content,
      tags: payload.tags,
      // 烤入本卡构建时的内容版本号（edit-note-draft-before-publish）：点授权时随签名落盘，
      // 下发闸据此守「审=发」。构建时未编辑草稿恒 0；卡片发出后草稿被后台改则活版本 >0、此值仍为旧。
      contentVersion: payload.contentVersion ?? 0,
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
      ...(payload.mediaImageKeys ?? []).slice(0, 3).map((imgKey, index) => ({
        tag: 'img' as const,
        img_key: imgKey,
        alt: { tag: 'plain_text' as const, content: `发帖素材 ${index + 1}` },
      })),
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

/**
 * 草稿已在控制台改过、原卡片失效的替换卡（edit-note-draft-before-publish）。
 * 云端无法主动刷新已发出的老卡片；命中版本不符时，作为卡片回调响应就地替换成本卡，引导到控制台重新审批。
 * 无授权按钮——旧卡片的授权权威被作废，避免「看着旧字节批出新字节」。
 */
export function buildSupersededPublishApprovalCard(requestId: string): FeishuCard {
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'grey',
      title: { tag: 'plain_text', content: '草稿已更新' },
    },
    elements: [
      {
        tag: 'div',
        fields: [
          {
            is_short: false,
            text: {
              tag: 'lark_md',
              content: `该草稿（\`${requestId}\`）已在控制台修改，此卡片内容已过期、授权已失效。\n请到**管理后台**查看最新内容并在那里审批。`,
            },
          },
        ],
      },
    ],
  };
}
