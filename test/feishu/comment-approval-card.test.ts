/**
 * 评论审批卡同形复用验证：卡片按钮 callback value 必须能被现有 AC-PUB 接收端
 * parseApprovalActionValue 原样解析（零改共享审批代码）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildCommentApprovalCard } from '../../src/feishu/comment-approval-card.js';
import { parseApprovalActionValue } from '../../src/feishu/ws-receiver.js';

describe('buildCommentApprovalCard', () => {
  it('approve/cancel 按钮 value 可被 parseApprovalActionValue 解析、requestId/评论文本透传', () => {
    const card = buildCommentApprovalCard({ requestId: 'comment-n1-123', noteId: 'n1', text: '学到了，感谢分享' });
    const action = card.elements.find((e) => e.tag === 'action');
    assert.ok(action && action.tag === 'action');
    const [approveBtn, cancelBtn] = action.actions;

    const approve = parseApprovalActionValue(approveBtn.behaviors?.[0].value);
    assert.ok(approve, 'approve value 应可解析');
    assert.equal(approve!.action, 'approve');
    assert.equal(approve!.requestId, 'comment-n1-123');
    assert.equal(approve!.payload.content, '学到了，感谢分享');

    const cancel = parseApprovalActionValue(cancelBtn.behaviors?.[0].value);
    assert.ok(cancel, 'cancel value 应可解析');
    assert.equal(cancel!.action, 'cancel');
    assert.equal(cancel!.requestId, 'comment-n1-123');
  });
});
