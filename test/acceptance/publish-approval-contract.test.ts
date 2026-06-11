/**
 * 验收用例 AC-PUB-* — 发布审批信号契约（云端侧）
 *
 * 守护点：云端飞书卡片回调写入的信号文件路径，必须与边缘 `waitForPublishApproval` 读取的一致。
 *   约定路径格式：/tmp/aidcp-publish-approve-<requestId>.json
 *   边缘对照测试：aidcp-edge/test/acceptance/publish-approval-contract.test.ts（断言同一格式）。
 *
 * 环境层级：离线 / 逻辑级（无外部依赖）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getApprovalSignalPath, parseApprovalActionValue } from '../../src/feishu/ws-receiver.js';

describe('AC-PUB 发布审批信号契约（cloud）', () => {
  it('AC-PUB-01 信号路径格式与边缘约定一致', () => {
    assert.equal(getApprovalSignalPath('req-x'), '/tmp/aidcp-publish-approve-req-x.json');
  });

  it('AC-PUB-07 卡片 approve 回调可解析为审批动作', () => {
    const parsed = parseApprovalActionValue({
      action: 'approve',
      requestId: 'req-1',
      payload: { title: 'T', content: 'C', tags: ['a'] },
    });
    assert.ok(parsed);
    assert.equal(parsed!.action, 'approve');
    assert.equal(parsed!.requestId, 'req-1');
  });

  it('AC-PUB-08 非法卡片回调返回 null（不误触发发布）', () => {
    assert.equal(parseApprovalActionValue(null), null);
    assert.equal(parseApprovalActionValue({ foo: 'bar' }), null);
  });
});
