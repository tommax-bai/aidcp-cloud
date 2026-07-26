import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CommandSequencer } from '../../src/publish-agent/command-sequencer.js';
import type { PublishSequenceInput } from '../../src/publish-agent/command-sequencer.js';
import {
  clampFillBudgetToLease,
  computeFillTimeoutMs,
  DEFAULT_FILL_BUDGET,
  isContentTooLong,
  maxFillChars,
  sanitizeFillBudget,
  warnIfFillBudgetUnusable,
} from '../../src/publish-agent/fill-budget.js';
import type { PublishCommandPayload, PublishCommandResultPayload } from '../../src/comm/protocol.js';

function makeSequencer(over: Partial<ConstructorParameters<typeof CommandSequencer>[0]> = {}) {
  let seq: CommandSequencer;
  const pushed: PublishCommandPayload[] = [];
  const pusher = {
    pushToEdges(env: unknown): number {
      const cmd = (env as { payload: PublishCommandPayload }).payload;
      pushed.push(cmd);
      const res: PublishCommandResultPayload = {
        recordId: cmd.recordId,
        seq: cmd.seq,
        kind: cmd.kind,
        ok: true,
        value: cmd.kind === 'capture_postId' ? 'post_xyz' : undefined,
      };
      seq.onResult(res, 'env-id');
      return 1;
    },
  };
  seq = new CommandSequencer({ pusher, clock: () => 0, ...over });
  return { seq, pushed };
}

const input = (over: Partial<PublishSequenceInput> = {}): PublishSequenceInput => ({
  taskId: 'task-1',
  recordId: 1,
  title: 'T',
  content: 'C',
  tags: [],
  approvedByUser: true,
  ...over,
});

describe('正文填写单步预算（FB 逐字输入 vs 固定单步墙）', () => {
  it('预算随正文长度伸缩，并被上限硬钳', () => {
    // 200–500 字是内容管线的设计产出区间，必须全落在预算内。
    assert.equal(computeFillTimeoutMs('字'.repeat(200)), 20_000 + 200 * 250);
    assert.equal(computeFillTimeoutMs('字'.repeat(500)), 20_000 + 500 * 250);
    // 中文/emoji 按码位计，与边缘 Array.from(text) 的分字口径一致。
    assert.equal(computeFillTimeoutMs('🙂'), 20_000 + 250);
    // 上限硬钳。
    assert.equal(computeFillTimeoutMs('字'.repeat(100_000)), DEFAULT_FILL_BUDGET.maxMs);
    assert.equal(maxFillChars(), 1_520, '默认 Facebook 逐字输入硬上限为 1520 字');
    assert.equal(isContentTooLong('字'.repeat(1_520)), false);
    assert.equal(isContentTooLong('字'.repeat(1_521)), true);
  });

  it('预算上限 MUST 按发布租约 TTL 收敛——绝不让边缘在打字途中过期租约', () => {
    const warnings: string[] = [];
    const clamped = clampFillBudgetToLease(DEFAULT_FILL_BUDGET, 120_000, (m) => warnings.push(m));
    assert.equal(clamped.maxMs, 48_000, '120s 租约 → 上限压回 0.4×=48s');
    assert.equal(warnings.length, 1);
    // 默认 1000s 租约容得下默认 400s 上限，不该被动。
    assert.deepEqual(clampFillBudgetToLease(DEFAULT_FILL_BUDGET, 1_000_000), DEFAULT_FILL_BUDGET);
  });

  it('Facebook 的 select_mode/fill_field 带各自预算；小红书全路径不带（30s 常数窗口零回归）', () => {
    const { seq } = makeSequencer();

    const fb = seq.buildCommandSequence(input({ platform: 'facebook', content: '字'.repeat(300), images: ['a'] }));
    const fbSelect = fb.find((c) => c.kind === 'select_mode');
    const fbFill = fb.find((c) => c.kind === 'fill_field');
    assert.equal(fbSelect?.timeoutMs, 40_000);
    assert.equal(fbFill?.timeoutMs, 20_000 + 300 * 250);
    const fbAtLimit = seq.buildCommandSequence(input({ platform: 'facebook', content: '字'.repeat(1_520), images: [] }));
    assert.equal(fbAtLimit.find((c) => c.kind === 'fill_field')?.timeoutMs, 400_000);

    const xhs = seq.buildCommandSequence(input({ platform: 'xiaohongshu', content: '字'.repeat(300), images: ['a'] }));
    for (const cmd of xhs) {
      assert.equal(cmd.timeoutMs, undefined, `小红书指令 ${cmd.kind} MUST NOT 带预算，等待窗口逐字节沿用旧常数`);
    }
  });

  it('正文超出可打完的上限 → 诚实 failed，MUST NOT 截断发出，且一条指令都不下发', async () => {
    const { seq, pushed } = makeSequencer();
    const tooLong = '字'.repeat(maxFillChars() + 1);
    assert.equal(isContentTooLong(tooLong), true);

    const result = await seq.executePublishSequence(input({ platform: 'facebook', content: tooLong, images: ['a'] }));

    assert.equal(result.ok, false);
    assert.equal(result.outcome, 'failed_before_submit');
    assert.match(String(result.failedAt?.error), /^content_too_long/);
    assert.equal(pushed.length, 0, '越界内容绝不进浏览器');
  });

  it('带预算的指令：云端等「预算 + 兜底余量」——边缘必定先答，孤儿执行由构造消失', async () => {
    // responder 永不回报 → 观察云端实际等了多久才判超时。
    let seq: CommandSequencer;
    const timers: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    (globalThis as { setTimeout: unknown }).setTimeout = ((fn: () => void, ms?: number) => {
      timers.push(Number(ms ?? 0));
      return realSetTimeout(fn, 0);
    }) as typeof setTimeout;
    try {
      seq = new CommandSequencer({
        pusher: { pushToEdges: () => 1 },
        clock: () => 0,
        timeoutMs: 30_000,
        resultSlackMs: 8_000,
      });
      await seq
        .sendAndWaitResult({
          taskId: 't',
          recordId: 1,
          seq: 0,
          kind: 'fill_field',
          params: { fieldType: 'content', value: 'x' },
          platform: 'facebook',
          timeoutMs: 95_000,
        })
        .catch(() => {});
      assert.equal(timers.at(-1), 95_000 + 8_000);

      await seq
        .sendAndWaitResult({
          taskId: 't',
          recordId: 1,
          seq: 1,
          kind: 'select_mode',
          params: { optionKind: 'target', optionValue: 'facebook_personal_timeline' },
          platform: 'facebook',
          timeoutMs: 40_000,
        })
        .catch(() => {});
      assert.equal(timers.at(-1), 40_000 + 8_000);

      // 不带预算（小红书）→ 逐字节沿用旧的 30s 常数窗口，绝不叠余量。
      await seq
        .sendAndWaitResult({ taskId: 't', recordId: 1, seq: 2, kind: 'fill_field', params: {}, platform: 'xiaohongshu' })
        .catch(() => {});
      assert.equal(timers.at(-1), 30_000);
    } finally {
      (globalThis as { setTimeout: unknown }).setTimeout = realSetTimeout;
    }
  });
});

describe('预算配置的失效模式（复审补洞）', () => {
  it('非法配置一律回落默认值并告警——绝不让 NaN/0 污染下发的预算', () => {
    const warnings: string[] = [];
    const w = (m: string) => warnings.push(m);

    // perCharMs=0 会让「可打完的上限」变成无穷 → 诚实长度闸整个失效。
    assert.deepEqual(sanitizeFillBudget({ baseMs: 20_000, perCharMs: 0, maxMs: 240_000 }, w).perCharMs, 250);
    // 任一项 NaN 都会一路污染到 timeoutMs，让云端 setTimeout(NaN) 立刻触发 → 孤儿打字级联复活。
    assert.deepEqual(sanitizeFillBudget({ baseMs: NaN, perCharMs: NaN, maxMs: NaN }, w), DEFAULT_FILL_BUDGET);
    // maxMs 不大于 baseMs → 一个字都打不了。
    assert.equal(sanitizeFillBudget({ baseMs: 20_000, perCharMs: 250, maxMs: 5_000 }, w).maxMs, 400_000);
    assert.ok(warnings.length >= 4);
  });

  it('租约非法（NaN/负）时按默认租约算天花板，绝不把 NaN 传下去', () => {
    const warnings: string[] = [];
    const clamped = clampFillBudgetToLease(DEFAULT_FILL_BUDGET, NaN, (m) => warnings.push(m));
    assert.equal(Number.isFinite(clamped.maxMs), true);
    assert.equal(clamped.maxMs, DEFAULT_FILL_BUDGET.maxMs, '默认 1000s 租约容得下 400s 上限');
    assert.equal(warnings.length, 1);
  });

  it('CommandSequencer 自己也挡一道：非法预算不会变成 NaN 的 timeoutMs', () => {
    const { seq } = makeSequencer({ fillBudget: { baseMs: NaN, perCharMs: 0, maxMs: NaN }, logger: { log() {}, warn() {}, error() {} } });
    const fb = seq.buildCommandSequence(input({ platform: 'facebook', content: '字'.repeat(300), images: ['a'] }));
    const fill = fb.find((c) => c.kind === 'fill_field');
    assert.equal(Number.isFinite(fill?.timeoutMs), true);
    assert.equal(fill?.timeoutMs, 20_000 + 300 * 250);
  });

  it('有效正文上限低于管线设计区间 → 启动时吼出来，并指向配置而非内容生成', () => {
    const warnings: string[] = [];
    // 60s 租约 → 上限 24s → 只能打 16 字：每一篇 FB 帖都会以 content_too_long 失败。
    const tiny = clampFillBudgetToLease(DEFAULT_FILL_BUDGET, 60_000, () => {});
    assert.equal(maxFillChars(tiny), 16);
    warnIfFillBudgetUnusable(tiny, (m) => warnings.push(m));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /配置问题、不是内容生成问题/);
    // 正常配置不该吼。
    warnIfFillBudgetUnusable(DEFAULT_FILL_BUDGET, () => assert.fail('正常配置不该告警'));
  });

  it('边缘断开 → 在途发布指令立刻诚实失败，不空等满预算（否则堵死该账号的串行队列）', async () => {
    const seq = new CommandSequencer({ pusher: { pushToEdges: () => 1 }, clock: () => 0, logger: { log() {}, warn() {}, error() {} } });
    const pending = seq.sendAndWaitResult(
      { taskId: 't', recordId: 9, seq: 0, kind: 'fill_field', params: {}, platform: 'facebook', timeoutMs: 240_000 },
      'edge-a',
    );
    seq.invalidateEdge('edge-b'); // 别的节点断开，不该动它
    seq.invalidateEdge('edge-a');
    await assert.rejects(pending, /edge disconnected/);
  });
});
