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

  it('有标题：卡片「笔记」字段与 callback payload.title 都显示标题（供人识别，非裸 ID）', () => {
    const card = buildCommentApprovalCard({
      requestId: 'comment-n1-123',
      noteId: '6a3d138a000000001c0246bf',
      text: '学到了',
      title: '北京周末好去处',
    });
    const div = card.elements.find((e) => e.tag === 'div');
    assert.ok(div && div.tag === 'div');
    const noteField = div.fields?.find((f) => f.text.content.startsWith('**笔记**'));
    assert.ok(noteField, '应有「笔记」字段');
    assert.match(noteField!.text.content, /北京周末好去处/);
    assert.doesNotMatch(noteField!.text.content, /6a3d138a/, '有标题时不应再裸露 noteId');

    const action = card.elements.find((e) => e.tag === 'action');
    assert.ok(action && action.tag === 'action');
    const approve = parseApprovalActionValue(action.actions[0].behaviors?.[0].value);
    assert.ok(approve);
    assert.equal(approve!.payload.title, '评论·笔记《北京周末好去处》', '确认卡「标题」应显示真实笔记标题');
  });

  it('卡片显示账号昵称；缺昵称时不回落显示 accountId，且不写入授权 payload', () => {
    const card = buildCommentApprovalCard({
      requestId: 'comment-n1-123',
      noteId: 'n1',
      text: '学到了',
      accountId: 'acc-01',
      accountName: 'Tmax',
    });
    const div = card.elements.find((e) => e.tag === 'div');
    assert.ok(div && div.tag === 'div');
    const accountField = div.fields?.find((f) => f.text.content.startsWith('**账号**'));
    assert.ok(accountField, '应有「账号」字段');
    assert.match(accountField!.text.content, /Tmax/);
    assert.doesNotMatch(accountField!.text.content, /acc-01/);

    const action = card.elements.find((e) => e.tag === 'action');
    assert.ok(action && action.tag === 'action');
    const approve = parseApprovalActionValue(action.actions[0].behaviors?.[0].value);
    assert.ok(approve);
    assert.deepEqual(Object.keys(approve!.payload).sort(), ['content', 'tags', 'title'], '账号只展示，不进入授权 payload');

    const fallback = buildCommentApprovalCard({
      requestId: 'comment-n1-124',
      noteId: 'n1',
      text: '学到了',
      accountId: 'acc-02',
    });
    const fallbackJson = JSON.stringify(fallback);
    assert.match(fallbackJson, /未获取昵称/);
    assert.doesNotMatch(fallbackJson, /acc-02/);
  });

  it('卡片显示笔记用户昵称；缺昵称时不展示 id、只显示未获取昵称', () => {
    const card = buildCommentApprovalCard({
      requestId: 'comment-n1-123',
      noteId: 'n1',
      text: '学到了',
      title: '北京周末好去处',
      authorName: '开源老周',
    });
    const div = card.elements.find((e) => e.tag === 'div');
    assert.ok(div && div.tag === 'div');
    const userField = div.fields?.find((f) => f.text.content.startsWith('**用户**'));
    assert.ok(userField, '应有「用户」字段');
    assert.match(userField!.text.content, /开源老周/);

    const fallback = buildCommentApprovalCard({
      requestId: 'comment-n1-124',
      noteId: 'n1',
      text: '学到了',
      title: '北京周末好去处',
    });
    const fallbackUser = (fallback.elements.find((e) => e.tag === 'div') as { fields?: Array<{ text: { content: string } }> }).fields?.find((f) =>
      f.text.content.startsWith('**用户**'),
    );
    assert.match(fallbackUser!.text.content, /未获取昵称/);
  });

  it('无标题：显示未获取标题，不在可见字段或 callback title 中裸露 noteId', () => {
    const card = buildCommentApprovalCard({ requestId: 'comment-n1-123', noteId: '6a3d138a000000001c0246bf', text: '学到了' });
    const json = JSON.stringify(card);
    assert.match(json, /未获取标题/);
    assert.doesNotMatch(json, /6a3d138a/);
    const action = card.elements.find((e) => e.tag === 'action');
    assert.ok(action && action.tag === 'action');
    const approve = parseApprovalActionValue(action.actions[0].behaviors?.[0].value);
    assert.ok(approve);
    assert.equal(approve!.payload.title, '评论·笔记（未获取标题）');
  });
});
