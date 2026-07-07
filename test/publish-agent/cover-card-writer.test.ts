import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CoverCardWriterRole } from '../../src/publish-agent/roles/cover-card-writer.js';
import { PipelineContext } from '../../src/publish-agent/pipeline-context.js';
import type { PipelineFields, TriggerInput, CoverCardPlan } from '../../src/publish-agent/types.js';
import type { CoverFormSensor, CoverFormSenseResult } from '../../src/publish-agent/cover-form-sensor.js';
import type { CuratedReferenceImageFormGuess } from '../../src/cache/curated-content-store.js';

const silentLogger = { log() {}, warn() {}, error() {} };

function guess(form: CuratedReferenceImageFormGuess['form'], confidence: number): CuratedReferenceImageFormGuess {
  return { form, confidence, detectedAt: 1, detectedFor: 1, model: 'stub-vl' };
}

function stubSensor(result: CoverFormSenseResult, calls?: { count: number }): CoverFormSensor {
  return {
    sense: async () => {
      if (calls) calls.count++;
      return result;
    },
  };
}

function makeTrigger(withImages: boolean, overrides?: { author?: string; title?: string; body?: string }): TriggerInput {
  return {
    metrics: { hoursSinceLastPublish: 1, newConceptCount: 0, likedSinceLastPublish: 0 },
    generateInput: {
      concepts: [],
      likedContents: [],
      referenceNote: {
        sourceId: 'note-1',
        title: overrides?.title ?? '这5个坑我替你踩了',
        body: overrides?.body ?? '用某工具这段时间踩过的坑挑了5个，照着避，少走弯路。',
        topics: ['避坑', 'AI编程'],
        author: overrides?.author ?? '某作者',
        curatedContentId: 42,
        images: withImages
          ? [{ index: 0, sourceUrl: 'https://cdn.example/orig.webp', ossUrl: 'https://oss.example/orig.webp', capturedAt: 1 }]
          : [],
      },
      soul: {} as never,
      recentPosts: [],
    },
    recentPublished: [],
    accountId: 'acc-1',
  };
}

interface RunOpts {
  llmOutputs?: string[];
  sensor?: CoverFormSensor | null;
  renderEnabled?: boolean;
  rendererAvailable?: boolean;
  ossAvailable?: boolean;
  trigger?: TriggerInput;
  clockImpl?: () => number;
  llmAdvance?: () => void;
}

function run(opts: RunOpts): Promise<{ plan: CoverCardPlan; llmCalls: string[] }> {
  const llmCalls: string[] = [];
  const outputs = opts.llmOutputs ?? [];
  const llm = {
    chat: async (msgs: Array<{ content: string }>) => {
      llmCalls.push(msgs[1]?.content ?? '');
      opts.llmAdvance?.();
      const out = outputs.shift();
      if (out === undefined) throw new Error('llm down');
      return out;
    },
    complete: async () => '',
  };
  const role = new CoverCardWriterRole({
    llmClient: llm as never,
    sensor: opts.sensor,
    renderEnabled: () => opts.renderEnabled ?? true,
    rendererAvailable: () => opts.rendererAvailable ?? true,
    ossAvailable: () => opts.ossAvailable ?? true,
    clock: opts.clockImpl ?? (() => 1700000000000),
    logger: silentLogger,
  });
  const ctx = new PipelineContext<PipelineFields>();
  role.register(ctx);
  ctx.write('trigger', opts.trigger ?? makeTrigger(true));
  ctx.write('createdContent', {
    title: '避坑指南来了',
    content: '正文：第一坑是配置，第二坑是权限，第三坑是网络。',
    tags: ['避坑'],
    tone: 'casual',
    style: {},
    createdAt: 1,
  });
  ctx.write('postCategory', { category: 'tech', classifiedAt: 1 });
  return new Promise((resolve) =>
    setTimeout(() => resolve({ plan: ctx.get('coverCardPlan')!, llmCalls }), 80),
  );
}

const GOOD_COPY = JSON.stringify({ cardTitle: '五个新手弯路一次讲透', bullets: ['先看配置', '再查权限'], tags: ['避坑'] });

describe('CoverCardWriterRole（封面形态决策 + 卡面文案；恒写键、门禁零智能）', () => {
  test('无参照图 → no_reference_images、零感知零 LLM、恒写生成式兜底', async () => {
    const calls = { count: 0 };
    const { plan, llmCalls } = await run({
      sensor: stubSensor({ status: 'detected', guess: guess('text_card', 0.9), cached: false }, calls),
      trigger: makeTrigger(false),
    });
    assert.equal(plan.coverForm, 'generative');
    assert.equal(plan.gateReason, 'no_reference_images');
    assert.equal(calls.count, 0, '无图不调感知');
    assert.equal(llmCalls.length, 0, '门禁不过零 LLM');
  });

  test('影子模式：渲染旗标关但感知照跑（注解素材已落），gateReason=flag_off 且带真实 sensedForm', async () => {
    const calls = { count: 0 };
    const { plan, llmCalls } = await run({
      sensor: stubSensor({ status: 'detected', guess: guess('text_card', 0.9), cached: false }, calls),
      renderEnabled: false,
    });
    assert.equal(calls.count, 1, '感知独立于渲染旗标先执行（影子模式）');
    assert.equal(plan.coverForm, 'generative');
    assert.equal(plan.gateReason, 'flag_off');
    assert.equal(plan.sensedForm, 'text_card');
    assert.equal(plan.sensedSource, 'vision');
    assert.equal(llmCalls.length, 0);
  });

  test('全门禁过 + 文案合规 → text_card 计划（卡面字段裁剪就位）', async () => {
    const { plan, llmCalls } = await run({
      sensor: stubSensor({ status: 'detected', guess: guess('text_card', 0.9), cached: true }),
      llmOutputs: [GOOD_COPY],
    });
    assert.equal(plan.coverForm, 'text_card');
    assert.equal(plan.gateReason, 'ok');
    assert.equal(plan.sensedSource, 'cached');
    assert.equal(plan.card?.title, '五个新手弯路一次讲透');
    assert.deepEqual(plan.card?.bullets, ['先看配置', '再查权限']);
    assert.equal(llmCalls.length, 1);
  });

  test('低置信 → low_confidence 生成式（判定不猜、阈值在消费端）', async () => {
    const { plan, llmCalls } = await run({
      sensor: stubSensor({ status: 'detected', guess: guess('text_card', 0.6), cached: false }),
    });
    assert.equal(plan.gateReason, 'low_confidence');
    assert.equal(plan.coverForm, 'generative');
    assert.equal(llmCalls.length, 0);
  });

  test('形态非文字卡 → form_not_text_card 生成式', async () => {
    const { plan } = await run({ sensor: stubSensor({ status: 'detected', guess: guess('photo', 0.95), cached: false }) });
    assert.equal(plan.gateReason, 'form_not_text_card');
    assert.equal(plan.sensedForm, 'photo');
  });

  test('感知 error → form_unknown 生成式（缺失绝不猜成 text_card）', async () => {
    const { plan, llmCalls } = await run({ sensor: stubSensor({ status: 'error', cached: false, detail: 'timeout' }) });
    assert.equal(plan.gateReason, 'form_unknown');
    assert.equal(plan.sensedForm, 'unknown');
    assert.equal(llmCalls.length, 0);
  });

  test('感知未装配（sensor 缺席）→ 渲染旗标开时 form_unknown', async () => {
    const { plan } = await run({ sensor: null });
    assert.equal(plan.gateReason, 'form_unknown');
    assert.equal(plan.sensedSource, 'none');
  });

  test('渲染出口不可用 → renderer_unavailable、零 LLM', async () => {
    const { plan, llmCalls } = await run({
      sensor: stubSensor({ status: 'detected', guess: guess('text_card', 0.9), cached: false }),
      rendererAvailable: false,
    });
    assert.equal(plan.gateReason, 'renderer_unavailable');
    assert.equal(llmCalls.length, 0);
  });

  test('文案脏 JSON → 带紧约束重试一次，仍脏 → copy_llm_failed 生成式', async () => {
    const { plan, llmCalls } = await run({
      sensor: stubSensor({ status: 'detected', guess: guess('text_card', 0.9), cached: false }),
      llmOutputs: ['not json at all', 'still not json'],
    });
    assert.equal(plan.gateReason, 'copy_llm_failed');
    assert.equal(plan.coverForm, 'generative');
    assert.equal(llmCalls.length, 2, '违规重试恰一次');
    assert.match(llmCalls[1], /加严/, '重试带紧约束');
  });

  test('与原文 ≥12 连续字重叠 → 重试后合规产物通过', async () => {
    const overlapping = JSON.stringify({
      cardTitle: '五个新手弯路一次讲透',
      bullets: ['这段时间踩过的坑挑了5个照着避'], // 与原文 body 存在 ≥12 连续字符逐字重叠
      tags: [],
    });
    const { plan, llmCalls } = await run({
      sensor: stubSensor({ status: 'detected', guess: guess('text_card', 0.9), cached: false }),
      llmOutputs: [overlapping, GOOD_COPY],
      trigger: makeTrigger(true, { body: '用某工具这段时间踩过的坑挑了5个照着避，少走弯路。' }),
    });
    assert.equal(plan.coverForm, 'text_card');
    assert.equal(llmCalls.length, 2);
  });

  test('卡面含引流词（微信）→ 违规链生效', async () => {
    const promo = JSON.stringify({ cardTitle: '加微信领五个避坑要点', bullets: [], tags: [] });
    const { plan } = await run({
      sensor: stubSensor({ status: 'detected', guess: guess('text_card', 0.9), cached: false }),
      llmOutputs: [promo, promo],
    });
    assert.equal(plan.gateReason, 'copy_llm_failed');
  });

  test('卡面含原作者名 → 违规链生效', async () => {
    const withAuthor = JSON.stringify({ cardTitle: '某作者的五个坑总结', bullets: [], tags: [] });
    const { plan } = await run({
      sensor: stubSensor({ status: 'detected', guess: guess('text_card', 0.9), cached: false }),
      llmOutputs: [withAuthor, withAuthor],
    });
    assert.equal(plan.gateReason, 'copy_llm_failed');
  });

  test('剩余预算不足 → 跳过重试直接回落（评审修正：不做第二次全额调用）', async () => {
    let now = 0;
    const { plan, llmCalls } = await run({
      sensor: stubSensor({ status: 'detected', guess: guess('text_card', 0.9), cached: false }),
      llmOutputs: ['not json', GOOD_COPY],
      clockImpl: () => now,
      llmAdvance: () => {
        now += 225_000; // 首次文案调用后仅剩 <20s 预算
      },
    });
    assert.equal(llmCalls.length, 1, '预算不足不发起重试');
    assert.equal(plan.gateReason, 'copy_llm_failed');
  });

  test('文案 LLM 抛异常 → copy_llm_failed 恒写兜底（合流不挂死）', async () => {
    const { plan } = await run({
      sensor: stubSensor({ status: 'detected', guess: guess('text_card', 0.9), cached: false }),
      llmOutputs: [], // shift() → undefined → throw
    });
    assert.equal(plan.coverForm, 'generative');
    assert.equal(plan.gateReason, 'copy_llm_failed');
  });
});
