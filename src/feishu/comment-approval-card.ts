/**
 * 评论循环内人审卡（待审核）。
 *
 * 复用策略（零改 AC-PUB 共享代码）：按钮 callback `value` 故意采用与发帖审批**同形**的
 * `{ action, requestId, payload: { title, content, tags } }`，使现有 `parseApprovalActionValue` +
 * `writeApprovalSignal`（按 requestId 写 `/tmp` 先到先得信号）原样接住评论审批——评论文本放进 `content`，
 * `requestId` 为评论专属命名空间（`comment-<noteId>-<ts>`）。读侧 `isPublishApproved(requestId)` 本就泛化按 requestId。
 */

import type { FeishuCard } from './types.js';

export interface CommentApprovalCardData {
  requestId: string;
  noteId: string;
  text: string;
  /** 评论账号 id；仅用于存在性判断，不进入授权 payload、不作为卡片可见文案。 */
  accountId?: string;
  /** 评论账号展示名/昵称；卡片可见文案只用昵称，不展示 id。 */
  accountName?: string;
  /** 笔记标题（供人识别）。缺省/为空 → 显示未获取标题，不展示 noteId。 */
  title?: string;
  /** 笔记作者/用户昵称；缺省/为空 → 显示未获取昵称，不展示 authorId。 */
  authorName?: string;
}

function formatAccountDisplay(accountName?: string, accountId?: string): string {
  const name = accountName?.trim();
  if (name) return name;
  return accountId?.trim() ? '（未获取昵称）' : '';
}

function formatNicknameDisplay(nickname?: string): string {
  return nickname?.trim() || '（未获取昵称）';
}

function formatNoteLabel(title?: string): string {
  const clean = title?.trim();
  return clean ? `《${clean}》` : '（未获取标题）';
}

export function buildCommentApprovalCard(data: CommentApprovalCardData): FeishuCard {
  // 人识别用：卡片可见字段只展示标题/昵称；noteId 只保留在 requestId 所代表的机器通道里。
  // noteLabel 见于本卡「笔记」字段；callbackTitle 经 payload.title 见于审批后确认卡的「标题」字段。
  const noteLabel = formatNoteLabel(data.title);
  const callbackTitle = `评论·笔记${noteLabel}`;
  const accountLabel = formatAccountDisplay(data.accountName, data.accountId);
  const authorLabel = formatNicknameDisplay(data.authorName);
  const callbackValue = {
    requestId: data.requestId,
    payload: { title: callbackTitle, content: data.text, tags: [] as string[] },
  };
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: '待审核评论' },
    },
    elements: [
      {
        tag: 'div',
        fields: [
          ...(accountLabel
            ? [{ is_short: false, text: { tag: 'lark_md' as const, content: `**账号**\n${accountLabel}` } }]
            : []),
          { is_short: false, text: { tag: 'lark_md', content: `**笔记**\n${noteLabel}` } },
          { is_short: false, text: { tag: 'lark_md', content: `**用户**\n${authorLabel}` } },
          { is_short: false, text: { tag: 'lark_md', content: `**拟发评论**\n${data.text}` } },
        ],
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '同意发布' },
            type: 'primary',
            behaviors: [{ type: 'callback', value: { action: 'approve', ...callbackValue } }],
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '不发' },
            type: 'danger',
            behaviors: [{ type: 'callback', value: { action: 'cancel', ...callbackValue } }],
          },
        ],
      },
    ],
  };
}
