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
  // uploadTimeoutMs 与 timeoutMs 同小值，便于测 upload_image 超时降级（生产默认 60s）。
  seq = new CommandSequencer({ pusher, clock: () => 0, timeoutMs, uploadTimeoutMs: timeoutMs });
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
  it('AC-MEDIA-SEQ 配图 emit：images → upload_image×N 于 select_mode 后/fill_field 前，随后 set_cover；submit/capture 仍授权后', () => {
    const { seq } = makeSequencer(() => null);
    const cmds = seq.buildCommandSequence(input({ tags: [], images: ['a', 'b'], cover: 'a', approvedByUser: true }));
    const kinds = cmds.map((c) => c.kind);
    const selIdx = kinds.indexOf('select_mode');
    const fillIdx = kinds.indexOf('fill_field');
    const uploads = kinds.map((k, i) => (k === 'upload_image' ? i : -1)).filter((i) => i >= 0);
    assert.equal(uploads.length, 2, 'images=[a,b] → upload_image×2');
    assert.ok(uploads.every((i) => i > selIdx && i < fillIdx), 'upload_image 应在 select_mode 后、fill_field 前');
    const coverIdx = kinds.indexOf('set_cover');
    assert.ok(coverIdx > uploads[uploads.length - 1] && coverIdx < fillIdx, 'set_cover 在 uploads 之后、fill_field 之前');
    assert.ok(kinds.includes('submit_publish') && kinds.includes('capture_postId'), '已授权应含提交/抓取');
  });

  it('AC-MEDIA-SEQ 未授权 + 有配图（多图）→ upload_image/set_cover 在（提交前），但无 submit/capture（AC-PUB 第2闸）', () => {
    const { seq } = makeSequencer(() => null);
    const cmds = seq.buildCommandSequence(input({ tags: [], images: ['a', 'b'], cover: 'a', approvedByUser: false }));
    const kinds = cmds.map((c) => c.kind);
    assert.ok(kinds.includes('upload_image') && kinds.includes('set_cover'), '未授权仍可发配图指令（填页）');
    assert.ok(!kinds.includes('submit_publish') && !kinds.includes('capture_postId'), 'AC-PUB：未授权绝不入提交/抓取');
  });

  it('AC-MEDIA-DEGRADE 图文请求了配图而全失败（ok:false）→ 诚实 failed，绝不下发 fill_field/submit（编辑器被传图门控）', async () => {
    const { seq, pushed } = makeSequencer((cmd) =>
      cmd.kind === 'upload_image'
        ? { recordId: cmd.recordId, seq: cmd.seq, kind: cmd.kind, ok: false, error: 'image_not_attached' }
        : okFor(cmd),
    );
    const r = await seq.executePublishSequence(input({ tags: ['a'], images: ['x'], cover: 'x' }));
    assert.equal(r.ok, false, '图文无图 → 无有效帖，诚实 failed');
    assert.equal(r.attachedCount, 0, '配图全失败 K=0');
    assert.equal(r.failedAt?.kind, 'upload_image');
    assert.equal(r.failedAt?.error, 'all_images_failed');
    assert.ok(pushed.some((c) => c.kind === 'upload_image'), 'upload_image 已尝试');
    assert.ok(!pushed.some((c) => c.kind === 'fill_field'), '全图失败后绝不进 fill_field（不假装纯文字）');
    assert.ok(!pushed.some((c) => c.kind === 'submit_publish'), '绝不提交');
    assert.equal(seq.pendingCount, 0, 'pending 清零');
  });

  it('AC-MEDIA-DEGRADE 配图超时（无回报）→ 同样 K=0、诚实 failed、不提交', async () => {
    const { seq, pushed } = makeSequencer((cmd) => (cmd.kind === 'upload_image' ? null : okFor(cmd)), 20);
    const r = await seq.executePublishSequence(input({ tags: [], images: ['x'], cover: 'x' }));
    assert.equal(r.ok, false);
    assert.equal(r.attachedCount, 0, '超时也算配图失败 K=0');
    assert.equal(r.failedAt?.error, 'all_images_failed');
    assert.ok(!pushed.some((c) => c.kind === 'submit_publish'), '绝不提交');
    assert.equal(seq.pendingCount, 0, '超时后 pending 清理');
  });

  it('AC-MEDIA-PARTIAL 部分成功 K=2/3：K≥1 即有效帖、照发 K 张、继续提交（不 all-or-nothing）', async () => {
    // images=[a,b,c]，b 上传失败 → K=2；仍走到 submit（部分成功不再全帖 failed）。
    const { seq, pushed } = makeSequencer((cmd) =>
      cmd.kind === 'upload_image' && cmd.params.imageUrl === 'b'
        ? { recordId: cmd.recordId, seq: cmd.seq, kind: cmd.kind, ok: false, error: 'image_not_attached' }
        : okFor(cmd),
    );
    const r = await seq.executePublishSequence(input({ tags: [], images: ['a', 'b', 'c'] }));
    assert.equal(r.ok, true, 'K≥1 即有效帖');
    assert.equal(r.attachedCount, 2, '真实附着 K=2（a、c 成功；b 丢弃）');
    assert.ok(pushed.some((c) => c.kind === 'submit_publish'), '部分成功仍提交发布');
    assert.equal(r.postId, 'post_xyz');
  });

  it('AC-MEDIA-SEQ 单图不发 set_cover（封面自动取该图）；多图才发', () => {
    const { seq } = makeSequencer(() => null);
    const single = seq.buildCommandSequence(input({ tags: [], images: ['a'], cover: 'a' })).map((c) => c.kind);
    assert.ok(!single.includes('set_cover'), '单图：封面自动，不下发 set_cover');
    const multi = seq.buildCommandSequence(input({ tags: [], images: ['a', 'b'], cover: 'a' })).map((c) => c.kind);
    assert.ok(multi.includes('set_cover'), '多图：下发 set_cover 选封面');
  });

  it('AC-MEDIA-DEGRADE 红线：非配图指令失败（有配图在场）仍 fail-fast，K 不掩盖', async () => {
    // 配图成功，但正文校验失败 → 整条按既有 fail-fast 停止（绝不套用配图降级语义）。
    const { seq, pushed } = makeSequencer((cmd) => ({
      recordId: cmd.recordId, seq: cmd.seq, kind: cmd.kind,
      ok: !(cmd.kind === 'fill_field' && cmd.params.fieldType === 'content'),
      error: 'post_validation_failed',
    }));
    const r = await seq.executePublishSequence(input({ tags: [], images: ['x'], cover: 'x' }));
    assert.equal(r.ok, false, '非配图失败 → 整体失败');
    assert.equal(r.failedAt?.kind, 'fill_field');
    assert.equal(r.attachedCount, 1, '配图本身成功 K=1，不被误标');
    assert.ok(!pushed.some((c) => c.kind === 'submit_publish'), '失败后绝不下发 submit');
  });

  it('AC-CMD-SEQ-08 stage-4 元数据应用：metadata → 发 mention/location/set_option/set_schedule（submit 前）', () => {
    const { seq } = makeSequencer(() => null);
    const metadata = {
      topics: ['t1'], mentions: ['userA'], location: '上海', collection: '技术',
      visibility: 'public' as const,
      permissions: { comment: 'allow' as const, save: 'allow' as const },
      mode: 'scheduled' as const, publishTime: 1800000000000,
      compliance: { ai: true }, metadataScore: 0.9, decidedAt: 0,
    };
    const cmds = seq.buildCommandSequence(input({ tags: ['a'], metadata, approvedByUser: true }));
    const kinds = cmds.map((c) => c.kind);
    // 元数据指令在 submit 之前
    const submitIdx = kinds.indexOf('submit_publish');
    const optIdx = kinds.indexOf('set_option');
    assert.ok(optIdx >= 0 && optIdx < submitIdx, 'set_option 应在 submit 之前');
    // @ / 地点 / 合集 经 add_with_candidate（按 candidateKind 区分）
    const cands = cmds.filter((c) => c.kind === 'add_with_candidate').map((c) => c.params.candidateKind);
    assert.ok(cands.includes('mention') && cands.includes('location') && cands.includes('collection'));
    // 可见范围/权限/AI声明 set_option + 定时
    const opts = cmds.filter((c) => c.kind === 'set_option').map((c) => c.params.optionKind);
    assert.ok(opts.includes('visibility') && opts.includes('declaration_ai'));
    assert.ok(kinds.includes('set_schedule'), 'scheduled 模式应发 set_schedule');
    assert.ok(kinds.includes('submit_publish') && kinds.includes('capture_postId'));
  });

  it('AC-CMD-SEQ-09 未授权 + 有 metadata → 元数据指令在、但 submit/capture 截止（AC-PUB 第2闸）', () => {
    const { seq } = makeSequencer(() => null);
    const metadata = {
      topics: [], mentions: [], location: null, collection: null,
      visibility: 'self_only' as const, permissions: { comment: 'disable' as const, save: 'disable' as const },
      mode: 'immediate' as const, publishTime: null, compliance: {}, metadataScore: 0, decidedAt: 0,
    };
    const cmds = seq.buildCommandSequence(input({ tags: [], metadata, approvedByUser: false }));
    const kinds = cmds.map((c) => c.kind);
    assert.ok(kinds.includes('set_option'), '未授权仍可发元数据（填页），但不提交');
    assert.ok(!kinds.includes('submit_publish'), 'AC-PUB：未授权绝不入 submit');
  });

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

  it('AC-CMD-SEQ-10 capture_postId 失败但已提交 → ok:true（已发布、postId 未知，非致命，不误判 failed）', async () => {
    const { seq, pushed } = makeSequencer((cmd) =>
      cmd.kind === 'capture_postId'
        ? { recordId: cmd.recordId, seq: cmd.seq, kind: cmd.kind, ok: false, error: 'no_target' }
        : okFor(cmd),
    );
    const r = await seq.executePublishSequence(input({ tags: [] }));
    assert.equal(r.ok, true, '提交成功即已发布，capture 失败非致命');
    assert.equal(r.postId, undefined, 'postId 未抓到则 undefined（绝不伪造）');
    assert.ok(pushed.some((c) => c.kind === 'submit_publish'), '已下发 submit');
    assert.equal(seq.pendingCount, 0);
  });

  it('AC-CMD-SEQ-11 元数据(add_with_candidate/set_option) 失败 → best-effort 跳过、仍提交发布', async () => {
    const metadata = {
      topics: ['t1'], mentions: ['userA'], location: null, collection: null,
      visibility: 'public' as const, permissions: { comment: 'allow' as const, save: 'allow' as const },
      mode: 'immediate' as const, publishTime: null, compliance: {}, metadataScore: 0, decidedAt: 0,
    };
    const { seq, pushed } = makeSequencer((cmd) =>
      cmd.kind === 'add_with_candidate' || cmd.kind === 'set_option'
        ? { recordId: cmd.recordId, seq: cmd.seq, kind: cmd.kind, ok: false, error: 'guard_persist' }
        : okFor(cmd),
    );
    const r = await seq.executePublishSequence(input({ tags: ['a'], metadata }));
    assert.equal(r.ok, true, '元数据增强项失败不阻断发布');
    assert.ok(pushed.some((c) => c.kind === 'submit_publish'), '仍下发 submit');
    assert.equal(r.postId, 'post_xyz');
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
