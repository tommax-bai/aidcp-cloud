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
}

export function buildCommentApprovalCard(data: CommentApprovalCardData): FeishuCard {
  const callbackValue = {
    requestId: data.requestId,
    payload: { title: `评论·笔记 ${data.noteId}`, content: data.text, tags: [] as string[] },
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
          { is_short: false, text: { tag: 'lark_md', content: `**笔记**\n${data.noteId}` } },
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
