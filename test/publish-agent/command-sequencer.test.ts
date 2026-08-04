import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CommandSequencer,
  classifyPreSubmitReason,
  STRUCTURAL_PRE_SUBMIT_REASONS,
  RECOVERABLE_PRE_SUBMIT_REASONS,
} from '../../src/publish-agent/command-sequencer.js';
import type { PublishSequenceInput } from '../../src/publish-agent/command-sequencer.js';
import type { PublishCommandPayload, PublishCommandResultPayload } from '../../src/comm/protocol.js';

type Responder = (cmd: PublishCommandPayload) => PublishCommandResultPayload | null;

/** 构造 sequencer + 一个会按 responder 同步回报的 pusher（responder 返回 null = 不回报，模拟超时）。 */
function makeSequencer(responder: Responder, timeoutMs = 50, now = 0) {
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
  seq = new CommandSequencer({ pusher, clock: () => now, timeoutMs, uploadTimeoutMs: timeoutMs });
  return { seq, pushed };
}

const input = (over: Partial<PublishSequenceInput> = {}): PublishSequenceInput => ({
  taskId: 'task-publish-1',
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
    assert.equal(r.failedAt?.seq, 2, 'failedAt.seq 归因真实 upload seq（=2），非触发早停的 fill_field seq');
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
    assert.ok(kinds.includes('submit_publish') && kinds.includes('capture_scheduled'));
    assert.ok(!kinds.includes('capture_postId'), '定时提交不得强求当场公开 postId');
  });

  it('XHS-SCHEDULE set_schedule 是提交前关键步骤：失败即闭锁，绝不退化成立即发布', async () => {
    const now = 1_800_000_000_000;
    const metadata = {
      topics: ['t1'], mentions: [], location: null, collection: null,
      visibility: 'public' as const,
      permissions: { comment: 'allow' as const, save: 'allow' as const },
      mode: 'scheduled' as const, publishTime: now + 2 * 60 * 60 * 1000,
      compliance: {}, metadataScore: 1, decidedAt: now,
    };
    const { seq, pushed } = makeSequencer((cmd) => cmd.kind === 'set_schedule'
      ? { recordId: cmd.recordId, seq: cmd.seq, kind: cmd.kind, ok: false, error: 'schedule_not_confirmed' }
      : okFor(cmd), 50, now);
    const result = await seq.executePublishSequence(input({ metadata }));
    assert.equal(result.ok, false);
    // 边缘回执说「这一步没做成」，没说「重来也做不成」⇒ 可恢复档（提交指令从未推送、零平台副作用）。
    // 本用例守的仍是「绝不退化成立即发布」：submit_publish 一条都不许下发。
    assert.equal(result.outcome, 'deferred_before_submit');
    assert.equal(result.failedAt?.kind, 'set_schedule');
    assert.equal(pushed.some((cmd) => cmd.kind === 'submit_publish'), false);
  });

  it('XHS-SCHEDULE 提交后不强求公开链接：capture_scheduled 失败仍进入 scheduled_pending，且不发 capture_postId', async () => {
    const now = 1_800_000_000_000;
    const publishTime = now + 2 * 60 * 60 * 1000;
    const metadata = {
      topics: [], mentions: [], location: null, collection: null,
      visibility: 'public' as const,
      permissions: { comment: 'allow' as const, save: 'allow' as const },
      mode: 'scheduled' as const, publishTime,
      compliance: {}, metadataScore: 1, decidedAt: now,
    };
    const { seq, pushed } = makeSequencer((cmd) => cmd.kind === 'capture_scheduled'
      ? { recordId: cmd.recordId, seq: cmd.seq, kind: cmd.kind, ok: false, error: 'scheduled_record_not_found' }
      : okFor(cmd), 50, now);
    const result = await seq.executePublishSequence(input({ metadata }));
    assert.equal(result.ok, true);
    assert.equal(result.outcome, 'scheduled_pending');
    assert.equal(result.scheduledAt, publishTime);
    assert.equal(result.postId, undefined);
    assert.equal(pushed.some((cmd) => cmd.kind === 'capture_scheduled'), true);
    assert.equal(pushed.some((cmd) => cmd.kind === 'capture_postId'), false);
  });

  it('XHS-SCHEDULE 云端前置焊死 1 小时至 14 天窗口，非法时间不下发任何命令', async () => {
    const now = 1_800_000_000_000;
    for (const publishTime of [now + 60 * 60 * 1000 - 1, now + 14 * 24 * 60 * 60 * 1000 + 1]) {
      const metadata = {
        topics: [], mentions: [], location: null, collection: null,
        visibility: 'public' as const,
        permissions: { comment: 'allow' as const, save: 'allow' as const },
        mode: 'scheduled' as const, publishTime,
        compliance: {}, metadataScore: 1, decidedAt: now,
      };
      const { seq, pushed } = makeSequencer(okFor, 50, now);
      const result = await seq.executePublishSequence(input({ metadata }));
      // 排期时间来自冻结草稿、上下界是常量 ⇒ 重来必然同样结果 ⇒ 结构性档。
      assert.equal(result.outcome, 'structural_before_submit');
      assert.equal(result.failedAt?.error, 'schedule_time_out_of_range');
      assert.equal(pushed.length, 0);
    }
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

  it('FB-PUBLISH-SEQ Facebook：个人 timeline 只发素材图+正文，不发 XHS 标题/话题/元数据命令', () => {
    const { seq } = makeSequencer(() => null);
    const cmds = seq.buildCommandSequence(input({
      platform: 'facebook',
      title: 'ignored title',
      content: 'facebook body',
      tags: ['topic'],
      images: ['https://oss.example/fb.png'],
      metadata: {
        topics: ['topic'],
        mentions: ['userA'],
        location: '上海',
        collection: '合集',
        visibility: 'public',
        permissions: { comment: 'allow', save: 'allow' },
        mode: 'scheduled',
        publishTime: 1800000000000,
        compliance: { ai: true },
        metadataScore: 1,
        decidedAt: 0,
      },
    }));
    assert.deepEqual(cmds.map((c) => c.kind), [
      'navigate_entry',
      'select_mode',
      'upload_image',
      'fill_field',
      'submit_publish',
      'capture_postId',
    ]);
    assert.equal(cmds.every((c) => c.platform === 'facebook'), true);
    assert.equal(cmds[1].params.optionValue, 'facebook_personal_timeline');
    assert.equal(cmds[1].timeoutMs, 40_000, 'Facebook select_mode 必须给 edge 完整 composer deadline');
    assert.equal(cmds[3].params.fieldType, 'content');
    assert.equal(cmds.some((c) => c.params.fieldType === 'title'), false);
    assert.equal(cmds.some((c) => c.kind === 'add_with_candidate' || c.kind === 'set_option' || c.kind === 'set_schedule'), false);
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

describe('AC-PREEMPT 被抢占分档（change lease-strict-preemption 批 C：被抢占 ≠ 失败）', () => {
  const fail = (cmd: PublishCommandPayload, over: Partial<PublishCommandResultPayload>): PublishCommandResultPayload => ({
    recordId: cmd.recordId,
    seq: cmd.seq,
    kind: cmd.kind,
    ok: false,
    ...over,
  });

  it('AC-PREEMPT-1 submit_publish 回 ok:false + submitDispatched → submitted_unconfirmed（6.2/HOLE-2：不烧成提交前失败）', async () => {
    // 提交按下已派发但确认失败（post_validate_failed）：帖子可能已发出 → 已提交待确认终态、绝不重投。
    const { seq } = makeSequencer((cmd) =>
      cmd.kind === 'submit_publish' ? fail(cmd, { error: 'post_validate_failed', submitDispatched: true }) : okFor(cmd),
    );
    const r = await seq.executePublishSequence(input({ tags: [] }));
    assert.equal(r.ok, false);
    assert.equal(r.outcome, 'submitted_unconfirmed');
  });

  it('AC-PREEMPT-2 核心步回 ok:false + error=preempted_by_task → preempted（独立终局、绝不并入提交前失败档）', async () => {
    const { seq } = makeSequencer((cmd) =>
      cmd.kind === 'fill_field' ? fail(cmd, { error: 'preempted_by_task' }) : okFor(cmd),
    );
    const r = await seq.executePublishSequence(input({ tags: [] }));
    assert.equal(r.outcome, 'preempted');
  });

  it('AC-PREEMPT-3 task_lease_mismatch 亦归 preempted（命令到达时租约已不在＝提交前零副作用）', async () => {
    const { seq } = makeSequencer((cmd) =>
      cmd.kind === 'navigate_entry' ? fail(cmd, { error: 'task_lease_mismatch' }) : okFor(cmd),
    );
    const r = await seq.executePublishSequence(input({ tags: [] }));
    assert.equal(r.outcome, 'preempted');
  });

  it('AC-PREEMPT-4 submitDispatched 压过抢占：submit ok:false + submitDispatched + preempted_by_task → submitted_unconfirmed（防双发）', async () => {
    // 提交后被抢占仍是「已提交待确认」——已派发的按下绝不因抢占而重投。
    const { seq } = makeSequencer((cmd) =>
      cmd.kind === 'submit_publish' ? fail(cmd, { error: 'preempted_by_task', submitDispatched: true }) : okFor(cmd),
    );
    const r = await seq.executePublishSequence(input({ tags: [] }));
    assert.equal(r.outcome, 'submitted_unconfirmed');
  });

  it('AC-PREEMPT-5 preemptTask 就地 reject 在飞指令 → preempted（catch 按类型归类、不 unwind、pending 清零）', async () => {
    const { seq } = makeSequencer(() => null); // 首条命令不回报 → 挂 pending
    const p = seq.executePublishSequence(input({ tags: [] }));
    seq.preemptTask('task-publish-1', 'preempted_by_task');
    const r = await p;
    assert.equal(r.outcome, 'preempted');
    assert.equal(seq.pendingCount, 0);
  });

  it('AC-PREEMPT-8 yield_timeout（控制面故障）→ submitted_unconfirmed，绝不 preempted 自动重投（防卡死写者最终提交 → 双发）', async () => {
    // 复核 HIGH-1：写者收到取消仍不停手＝页面状态未知（可能仍会走完提交）→ 按已提交待确认处置、绝不重投。
    const { seq } = makeSequencer(() => null);
    const p = seq.executePublishSequence(input({ tags: [] }));
    seq.preemptTask('task-publish-1', 'yield_timeout');
    const r = await p;
    assert.equal(r.outcome, 'submitted_unconfirmed', 'yield_timeout MUST NOT 归 preempted（那会自动重投双发）');
  });

  it('AC-PREEMPT-6 真实业务失败非抢占（no_target 走提交前分档，绝不并入 preempted）', async () => {
    const { seq } = makeSequencer((cmd) =>
      cmd.kind === 'fill_field' ? fail(cmd, { error: 'no_target' }) : okFor(cmd),
    );
    const r = await seq.executePublishSequence(input({ tags: [] }));
    assert.notEqual(r.outcome, 'preempted', '业务失败绝不冒充抢占');
    // change defer-transient-publish-predispatch-failures：定位落空是页面姿态类失败，
    // 重新加载后重来有可能不同 ⇒ 可恢复档（此前被一律烧成不可逆 failed）。
    assert.equal(r.outcome, 'deferred_before_submit');
  });

  it('AC-PREEMPT-7 onFirstSideEffect 恰在 submit_publish 下发前触发一次（HOLE-13「已开始」下移）', async () => {
    let fired = 0;
    const { seq } = makeSequencer((cmd) => okFor(cmd));
    await seq.executePublishSequence(input({ tags: [], onFirstSideEffect: () => { fired++; } }));
    assert.equal(fired, 1);
  });
});

// ── change defer-transient-publish-predispatch-failures：提交前失败分档 ──────────────
describe('AC-PREDISPATCH 提交前失败分档（零副作用可恢复 / 零副作用结构性 / 页面状态未知）', () => {
  const fail = (cmd: PublishCommandPayload, over: Partial<PublishCommandResultPayload>): PublishCommandResultPayload => ({
    recordId: cmd.recordId,
    seq: cmd.seq,
    kind: cmd.kind,
    ok: false,
    ...over,
  });

  // ── 1.3 / stop-or-continue §7 唯一可机械化的那条断言 ──────────────────────────
  it('AC-PREDISPATCH-1 结构性集合与可恢复集合互斥，且对原因全集穷尽（无兜底桶、无重叠）', () => {
    const structural = STRUCTURAL_PRE_SUBMIT_REASONS as readonly string[];
    const recoverable = RECOVERABLE_PRE_SUBMIT_REASONS as readonly string[];

    // 互斥：同一个原因不能同时是「重来必然一样」和「重来可能不同」。
    assert.deepEqual(structural.filter((r) => recoverable.includes(r)), [], '两张表 MUST 互斥');

    // 每个具名成员都必须被判到它自己那一档（表与判据不许各说各话）。
    for (const reason of structural) {
      assert.equal(classifyPreSubmitReason(reason).disposition, 'structural', reason);
      assert.equal(classifyPreSubmitReason(reason).recognized, true, reason);
    }
    for (const reason of recoverable) {
      assert.equal(classifyPreSubmitReason(reason).disposition, 'recoverable', reason);
      assert.equal(classifyPreSubmitReason(reason).recognized, true, reason);
    }

    // 穷尽：**任意**字符串都得到一个具名答案，且表外的一律落可恢复侧（证明不了重来必然相同）。
    for (const outside of ['', '   ', 'brand_new_edge_reason', 'unknown', 'null', '未知原因']) {
      const verdict = classifyPreSubmitReason(outside);
      assert.equal(verdict.disposition, 'recoverable', `表外原因 MUST NOT 落结构性: ${outside}`);
      assert.equal(verdict.recognized, false, `表外原因 MUST 标未识别: ${outside}`);
    }
    for (const nullish of [null, undefined]) {
      assert.equal(classifyPreSubmitReason(nullish).disposition, 'recoverable');
    }
  });

  it('AC-PREDISPATCH-2 「码: 明细」形态按码判，明细不参与分档（content_too_long: 800>500）', () => {
    const verdict = classifyPreSubmitReason('content_too_long: 800>500');
    assert.equal(verdict.disposition, 'structural');
    assert.equal(verdict.code, 'content_too_long');
  });

  // ── 3.3 未识别原因不得被折进已有失败值 ────────────────────────────────────────
  it('AC-PREDISPATCH-3 未识别的提交前原因 → 可恢复档，且日志具名标注 + 带原始串', async () => {
    const logs: string[] = [];
    const pushed: PublishCommandPayload[] = [];
    let seq!: CommandSequencer;
    const pusher = {
      pushToEdges(env: unknown): number {
        const cmd = (env as { payload: PublishCommandPayload }).payload;
        pushed.push(cmd);
        seq.onResult(
          cmd.kind === 'select_mode'
            ? fail(cmd, { error: 'hydration_race_v9' })
            : okFor(cmd),
          'env',
        );
        return 1;
      },
    };
    seq = new CommandSequencer({
      pusher,
      clock: () => 0,
      timeoutMs: 50,
      logger: { log() {}, warn: (m: unknown) => logs.push(String(m)), error: (m: unknown) => logs.push(String(m)) },
    });

    const r = await seq.executePublishSequence(input({ tags: [] }));
    assert.equal(r.outcome, 'deferred_before_submit', '没认出来 MUST NOT 折进终局失败值');
    const named = logs.find((l) => l.includes('未识别提交前原因'));
    assert.ok(named, '未识别 MUST 具名说出来，否则跨层传下去就成了终局判决');
    assert.ok(named!.includes('hydration_race_v9'), '原始原因串 MUST 带进日志');
    assert.equal(pushed.some((c) => c.kind === 'submit_publish'), false, '提交指令一条都没推送');
  });

  // ── 3.4 回归：跨过提交点（或证明不了没跨过）的处置逐字未变 ──────────────────────
  it('AC-PREDISPATCH-4 前三档优先级未被削弱：submitDispatched / yield_timeout / 抢占 一字不动', async () => {
    // ① submitDispatched 压过一切（含抢占原因）→ 已提交待确认，绝不重投。
    const dispatched = makeSequencer((cmd) =>
      cmd.kind === 'submit_publish' ? fail(cmd, { error: 'preempted_by_task', submitDispatched: true }) : okFor(cmd),
    );
    assert.equal((await dispatched.seq.executePublishSequence(input({ tags: [] }))).outcome, 'submitted_unconfirmed');

    // ② yield_timeout（控制面故障，卡死写者可能仍会按下提交）→ 已提交待确认，绝不进重投通道。
    const stuck = makeSequencer(() => null);
    const running = stuck.seq.executePublishSequence(input({ tags: [] }));
    stuck.seq.preemptTask('task-publish-1', 'yield_timeout');
    assert.equal((await running).outcome, 'submitted_unconfirmed', 'yield_timeout MUST NOT 变成任何可恢复档');

    // ③ 抢占原因仍归 preempted（走抢占自己的预算，不占提交前恢复预算）。
    const preempted = makeSequencer((cmd) =>
      cmd.kind === 'fill_field' ? fail(cmd, { error: 'task_lease_mismatch' }) : okFor(cmd),
    );
    assert.equal((await preempted.seq.executePublishSequence(input({ tags: [] }))).outcome, 'preempted');
  });

  it('AC-PREDISPATCH-5 提交指令已推送但回执未达 → 页面状态未知，MUST NOT 判可恢复（防重投双发）', async () => {
    // 提交命令推出去了，边缘再没回话（超时）。云端**证明不了**那一下没按下去。
    const { seq, pushed } = makeSequencer((cmd) => (cmd.kind === 'submit_publish' ? null : okFor(cmd)), 20);
    const r = await seq.executePublishSequence(input({ tags: [] }));
    assert.equal(pushed.some((c) => c.kind === 'submit_publish'), true, '提交指令确实推送过');
    assert.equal(r.outcome, 'failed_page_state_unknown');
    assert.notEqual(r.outcome, 'deferred_before_submit', '这一格重投就是双发');
    assert.equal(seq.pendingCount, 0);
  });

  it('AC-PREDISPATCH-6 提交步回 ok:false 且未带 submitDispatched → 仍判页面状态未知（不拿沉默当证据）', async () => {
    const { seq } = makeSequencer((cmd) =>
      cmd.kind === 'submit_publish' ? fail(cmd, { error: 'no_target' }) : okFor(cmd),
    );
    const r = await seq.executePublishSequence(input({ tags: [] }));
    // 同一个 no_target：出现在 fill_field 上是可恢复（AC-PREEMPT-6），出现在**提交步**上就不是——
    // 判据不是原因串，是「提交指令有没有推出去」。
    assert.equal(r.outcome, 'failed_page_state_unknown');
  });

  it('AC-PREDISPATCH-7 提交指令从未推送的失败 → 可恢复档（导航/就绪/探测类，零平台副作用）', async () => {
    for (const reason of ['no_target', 'element_not_found', 'page_not_ready', 'navigation_failed']) {
      const { seq, pushed } = makeSequencer((cmd) =>
        cmd.kind === 'navigate_entry' ? fail(cmd, { error: reason }) : okFor(cmd),
      );
      const r = await seq.executePublishSequence(input({ tags: [] }));
      assert.equal(r.outcome, 'deferred_before_submit', reason);
      assert.equal(pushed.some((c) => c.kind === 'submit_publish'), false, `${reason}: 提交指令零推送`);
    }
  });

  it('AC-PREDISPATCH-8 结构性档的四个入口都落 structural_before_submit（与判据表逐条对齐）', async () => {
    // 未授权：序列截止于提交前，重来仍生成不出提交指令。
    const notApproved = makeSequencer(okFor);
    const a = await notApproved.seq.executePublishSequence(input({ tags: [], approvedByUser: false }));
    assert.equal(a.outcome, 'structural_before_submit');
    assert.equal(a.failedAt?.error, 'not_approved');
    assert.equal(classifyPreSubmitReason(a.failedAt!.error).disposition, 'structural', '入口用的原因串 MUST 在结构性表内');

    // 配图全失败：K=0 无有效图文帖，重来面对同一批 URL。
    const noImages = makeSequencer((cmd) =>
      cmd.kind === 'upload_image' ? fail(cmd, { error: 'image_not_attached' }) : okFor(cmd),
    );
    const b = await noImages.seq.executePublishSequence(input({ tags: [], images: ['x'] }));
    assert.equal(b.outcome, 'structural_before_submit');
    assert.equal(classifyPreSubmitReason(b.failedAt!.error).disposition, 'structural');
  });
});
