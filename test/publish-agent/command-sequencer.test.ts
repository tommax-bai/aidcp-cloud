import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CommandSequencer } from '../../src/publish-agent/command-sequencer.js';
import type { PublishSequenceInput } from '../../src/publish-agent/command-sequencer.js';
import type { PublishCommandPayload, PublishCommandResultPayload } from '../../src/comm/protocol.js';

type Responder = (cmd: PublishCommandPayload) => PublishCommandResultPayload | null;

/** 构造 sequencer + 一个会按 responder 同步回报的 pusher（responder 返回 null = 不回报，模拟超时）。 */
function makeSequencer(responder: Responder, timeoutMs = 50) {
  let seq: CommandSequencer;
  const pushed: PublishCommandPayload[] = [];
  const pusher = {
    pushToEdges(env: unknown): number {
      const cmd = (env as { payload: PublishCommandPayload }).payload;
      pushed.push(cmd);
      const res = responder(cmd);
      // 同步回报：pending 已在 sendAndWaitResult 内注册，onResult 可立即 resolve。
      if (res) seq.onResult(res, 'env-id-ignored');
      return 1;
    },
  };
  seq = new CommandSequencer({ pusher, clock: () => 0, timeoutMs });
  return { seq, pushed };
}

const input = (over: Partial<PublishSequenceInput> = {}): PublishSequenceInput => ({
  recordId: 1,
  title: 'T',
  content: 'C',
  tags: ['a', 'b'],
  approvedByUser: true,
  ...over,
});

const okFor = (cmd: PublishCommandPayload): PublishCommandResultPayload => ({
  recordId: cmd.recordId,
  seq: cmd.seq,
  kind: cmd.kind,
  ok: true,
  value: cmd.kind === 'capture_postId' ? 'post_xyz' : undefined,
});

describe('AC-CMD CommandSequencer（云端编排驱动）', () => {
  it('AC-CMD-SEQ-01 已授权序列结构：nav→select_mode→title→content→tag×N→submit→capture，seq 连续', () => {
    const { seq } = makeSequencer(() => null);
    const cmds = seq.buildCommandSequence(input({ tags: ['a', 'b'] }));
    assert.deepEqual(cmds.map((c) => c.kind), [
      'navigate_entry', 'select_mode', 'fill_field', 'fill_field',
      'add_with_candidate', 'add_with_candidate', 'submit_publish', 'capture_postId',
    ]);
    assert.deepEqual(cmds.map((c) => c.seq), [0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('AC-CMD-SEQ-02 AC-PUB 第2道：未授权 → 序列截止于提交前（无 submit/capture）', () => {
    const { seq } = makeSequencer(() => null);
    const cmds = seq.buildCommandSequence(input({ approvedByUser: false }));
    assert.ok(!cmds.some((c) => c.kind === 'submit_publish'), '未授权不得含 submit_publish');
    assert.ok(!cmds.some((c) => c.kind === 'capture_postId'), '未授权不得含 capture_postId');
  });

  it('AC-CMD-SEQ-03 驱动成功 → ok:true + 真实 postId，pending 清零无泄漏', async () => {
    const { seq, pushed } = makeSequencer(okFor);
    const r = await seq.executePublishSequence(input({ tags: ['a'] }));
    assert.equal(r.ok, true);
    assert.equal(r.postId, 'post_xyz');
    assert.equal(seq.pendingCount, 0, 'pending 应清零');
    assert.equal(pushed[pushed.length - 1].kind, 'capture_postId');
  });

  it('AC-CMD-SEQ-04 失败按序停止：content 校验失败 → ok:false failedAt，后续 submit 绝不下发（红线）', async () => {
    const { seq, pushed } = makeSequencer((cmd) => ({
      recordId: cmd.recordId, seq: cmd.seq, kind: cmd.kind,
      ok: !(cmd.kind === 'fill_field' && cmd.params.fieldType === 'content'),
      error: 'post_validation_failed',
    }));
    const r = await seq.executePublishSequence(input({ tags: ['a'] }));
    assert.equal(r.ok, false);
    assert.equal(r.failedAt?.kind, 'fill_field');
    assert.equal(r.failedAt?.seq, 3);
    assert.ok(!pushed.some((c) => c.kind === 'submit_publish'), '失败后绝不下发 submit');
    assert.ok(!pushed.some((c) => c.kind === 'add_with_candidate'), '失败后绝不继续下发');
    assert.equal(seq.pendingCount, 0);
  });

  it('AC-CMD-SEQ-05 AC-PUB 红线：未授权驱动 → ok:false 且全程不下发 submit_publish', async () => {
    const { seq, pushed } = makeSequencer(okFor);
    const r = await seq.executePublishSequence(input({ approvedByUser: false }));
    assert.equal(r.ok, false);
    assert.ok(!pushed.some((c) => c.kind === 'submit_publish'), 'AC-PUB：未授权绝不下发 submit');
  });

  it('AC-CMD-SEQ-06 关联回报：recordId+seq 配对 resolve（envelope.id 变化不影响）', async () => {
    // responder 用与请求一致的 recordId+seq 回报，但 envelopeId 传任意值 → 仍能配对。
    const { seq } = makeSequencer((cmd) => okFor(cmd));
    const r = await seq.executePublishSequence(input({ tags: [] }));
    assert.equal(r.ok, true);
    assert.equal(seq.pendingCount, 0);
  });

  it('AC-CMD-SEQ-07 回执缺失 → 超时失败、pending 清理（不假成功）', async () => {
    const { seq } = makeSequencer(() => null, 20); // 永不回报
    const r = await seq.executePublishSequence(input({ tags: [] }));
    assert.equal(r.ok, false);
    assert.equal(seq.pendingCount, 0, '超时后 pending 必须清理');
  });
});
