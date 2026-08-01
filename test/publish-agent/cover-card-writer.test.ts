import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  CoverCardWriterRole,
  groupArticleSourceSlots,
  isArticleFlowSource,
  shouldUseArticleFlowSource,
} from '../../src/publish-agent/roles/cover-card-writer.js';
import { PipelineContext } from '../../src/publish-agent/pipeline-context.js';
import type { PipelineFields, TriggerInput, CoverCardPlan, PostFormProfileResult } from '../../src/publish-agent/types.js';
import type { CoverFormSensor, CoverFormSenseResult } from '../../src/publish-agent/cover-form-sensor.js';
import type { PostImageFormProfileService } from '../../src/publish-agent/post-image-form-profile.js';
import type { CuratedReferenceImageFormGuess } from '../../src/cache/curated-content-store.js';
import type { TextCardRenderer } from '../../src/render/index.js';

const silentLogger = { log() {}, warn() {}, error() {} };

/** 桩帖级形态档服务：固定返回一个形态档；enabled 可控。 */
function stubProfileService(result: PostFormProfileResult, enabled: boolean): PostImageFormProfileService & { computed: number } {
  const svc = {
    computed: 0,
    enabled: () => enabled,
    compute: async () => {
      svc.computed++;
      return result;
    },
  };
  return svc;
}

function guess(form: CuratedReferenceImageFormGuess['form'], confidence: number): CuratedReferenceImageFormGuess {
  return { form, confidence, detectedAt: 1, detectedFor: 1, model: 'stub-vl' };
}

function stubSensor(result: CoverFormSenseResult, calls?: { count: number }): CoverFormSensor {
  return {
    sense: async () => {
      if (calls) calls.count++;
      return result;
    },
    // 封面写手只走 sense()。senseAt 现为必选（task 2.7 层③），桩里给一个**会响的**实现，
    // 而不是回一个像模像样的错误态 —— 后者一旦被误调，测试会绿着跑完一条根本没判过形的路径。
    senseAt: async () => {
      throw new Error('stubSensor.senseAt 不该被调用：封面写手只用 sense()');
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
  profileService?: PostImageFormProfileService | null;
  renderEnabled?: boolean;
  carouselEnabled?: boolean;
  rendererAvailable?: boolean;
  ossAvailable?: boolean;
  trigger?: TriggerInput;
  clockImpl?: () => number;
  llmAdvance?: () => void;
  getTextCardRenderer?: () => TextCardRenderer | null;
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
    profileService: opts.profileService,
    renderEnabled: () => opts.renderEnabled ?? true,
    carouselEnabled: () => opts.carouselEnabled ?? false,
    rendererAvailable: () => opts.rendererAvailable ?? true,
    getTextCardRenderer: opts.getTextCardRenderer,
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

describe('CoverCardWriterRole × 连续长文文章卡', () => {
  test('文章判定与 13→9 连续分桶稳定覆盖结尾', () => {
    const source = Array.from({ length: 13 }, (_, sourceArrayIndex) => ({
      sourceArrayIndex,
      text: `来源第${sourceArrayIndex + 1}页先解释一个完整观点。随后补充它的形成原因。再说明外界反馈如何影响自己。关系与物品也会承担原本属于内在的功能。这个过程会不断改变一个人看待自己的方式。最后承接到下一页的叙事位置。`,
    }));
    assert.equal(isArticleFlowSource(source), true);
    assert.equal(shouldUseArticleFlowSource(source, 14), true);
    assert.equal(shouldUseArticleFlowSource(source.slice(0, 3), 14), false, '少量 OCR 不足以代表整套来源');
    const groups = groupArticleSourceSlots(source, 9);
    assert.deepEqual(groups.map((group) => group.sourceArrayIndices), [
      [0, 1], [2, 3], [4, 5], [6, 7], [8], [9], [10], [11], [12],
    ]);
    assert.match(groups[8].text, /来源第13页/);
    assert.deepEqual(groupArticleSourceSlots(source, 9), groups, '相同输入分桶确定性一致');
  });

  test('14 张来源中 13 张成功转写时，生成 9 张文章卡并记录全部来源组', async () => {
    const trigger = makeTrigger(true, { title: '旧标题', body: '旧正文只用于防搬运。' });
    trigger.generateInput.referenceNote!.images = Array.from({ length: 14 }, (_, index) => ({
      index,
      sourceUrl: `https://cdn.example/article-${index}.webp`,
      ossUrl: `https://oss.example/article-${index}.webp`,
      capturedAt: 1,
    }));
    trigger.generateInput.referenceNote!.textCardTranscription = {
      version: 1,
      status: 'partial',
      anchor: `sha256:${'b'.repeat(64)}`,
      provider: 'dashscope',
      model: 'ocr-model',
      transcribedAt: 2,
      cards: [
        ...Array.from({ length: 13 }, (_, sourceArrayIndex) => ({
          sourceArrayIndex,
          sourceIndex: sourceArrayIndex,
          capturedAt: 1,
          status: 'transcribed' as const,
          text: `原始第${sourceArrayIndex + 1}页先讨论稳定感从哪里来。它解释外部评价带来的摇摆。然后补充关系和物品承担的作用。外在评价一旦变化，旧有确定感也会跟着松动。重新理解这些反应，才能把注意力收回自身。最后把叙事继续推向文章结论。`,
        })),
        { sourceArrayIndex: 13, sourceIndex: 13, capturedAt: 1, status: 'failed' as const, reason: 'missing_card_result' as const },
      ],
    };
    const articleOutput = JSON.stringify({
      cards: Array.from({ length: 9 }, (_, cardIndex) => ({
        cardTitle: `重新理解自己的第${cardIndex + 1}层`,
        paragraphs: Array.from(
          { length: cardIndex === 0 ? 5 : 12 },
          (_, sentenceIndex) => `改写后的第${cardIndex + 1}页第${sentenceIndex + 1}个完整观点。`,
        ),
      })),
    });
    const preflightRenderer: TextCardRenderer = {
      render: async () => ({ ok: false, reason: 'render_failed' }),
      preflightArticle: () => ({ ok: true } as never),
    };
    const profile: PostFormProfileResult = {
      profile: 'all_text_card',
      gateReason: 'all_text_card',
      perImageForms: [],
      innerSensed: 13,
    };
    const { plan, llmCalls } = await run({
      sensor: stubSensor({ status: 'detected', guess: guess('text_card', 0.99), cached: false }),
      profileService: stubProfileService(profile, true),
      carouselEnabled: true,
      trigger,
      llmOutputs: [articleOutput],
      getTextCardRenderer: () => preflightRenderer,
    });
    assert.equal(plan.coverForm, 'text_card');
    assert.equal(plan.cardSet?.length, 9);
    assert.equal(plan.cardSet?.[0]?.layoutKind, 'article_cover');
    assert.equal(plan.cardSet?.[8]?.layoutKind, 'article_page');
    assert.deepEqual(plan.cardSet?.[1]?.bullets, []);
    assert.equal(plan.cardSet?.[1]?.paragraphs?.length, 12);
    assert.deepEqual(plan.cardSourceArrayIndexGroups, [
      [0, 1], [2, 3], [4, 5], [6, 7], [8], [9], [10], [11], [12],
    ]);
    assert.match(llmCalls[0], /生成第 9 张 ↔ 来源数组下标 12/);
    assert.match(llmCalls[0], /原始第13页/);
    assert.match(llmCalls[0], /"paragraphs"/);
    assert.doesNotMatch(llmCalls[0], /"bullets"/);
  });
});

describe('CoverCardWriterRole × 帖级形态档（change textcard-carousel-form-parity，阶段0 影子）', () => {
  const ALL_CARD: PostFormProfileResult = {
    profile: 'all_text_card',
    gateReason: 'all_text_card',
    perImageForms: [{ index: 0, form: 'text_card', source: 'vision' }],
    innerSensed: 0,
  };

  test('未装配形态档服务 → 计划不含 formProfile 键（byte-identical 零回归）', async () => {
    const { plan } = await run({
      sensor: stubSensor({ status: 'detected', guess: guess('text_card', 0.9), cached: false }),
      llmOutputs: [GOOD_COPY],
    });
    assert.equal(plan.coverForm, 'text_card'); // 既有决策不变
    assert.equal('formProfile' in plan, false);
    assert.equal('formProfileGate' in plan, false);
    assert.equal('perImageForms' in plan, false);
  });

  test('形态档旗标关（enabled=false）→ 不调 compute、计划不含 formProfile（零回归）', async () => {
    const svc = stubProfileService(ALL_CARD, false);
    const { plan } = await run({
      sensor: stubSensor({ status: 'detected', guess: guess('text_card', 0.9), cached: false }),
      profileService: svc,
      llmOutputs: [GOOD_COPY],
    });
    assert.equal(svc.computed, 0);
    assert.equal('formProfile' in plan, false);
  });

  test('形态档旗标开 → 影子盖章 formProfile，但既有封面决策完全不变（阶段0 不改渲染）', async () => {
    const svc = stubProfileService(ALL_CARD, true);
    const { plan } = await run({
      sensor: stubSensor({ status: 'detected', guess: guess('text_card', 0.9), cached: false }),
      profileService: svc,
      llmOutputs: [GOOD_COPY],
    });
    // 影子形态档已记录
    assert.equal(svc.computed, 1);
    assert.equal(plan.formProfile, 'all_text_card');
    assert.equal(plan.formProfileGate, 'all_text_card');
    assert.deepEqual(plan.perImageForms, ALL_CARD.perImageForms);
    // 但封面决策仍是原来的 text_card + 文案（阶段0 只记录，不改任何渲染/门禁结局）
    assert.equal(plan.coverForm, 'text_card');
    assert.equal(plan.gateReason, 'ok');
    assert.ok(plan.card);
  });

  test('形态档旗标开但封面走生成式（form_not_text_card）→ 形态档并列盖章、封面决策仍生成式', async () => {
    const svc = stubProfileService(
      { profile: 'generative', gateReason: 'generative_cover_not_card', perImageForms: [{ index: 0, form: 'photo', source: 'vision' }], innerSensed: 0 },
      true,
    );
    const { plan } = await run({
      sensor: stubSensor({ status: 'detected', guess: guess('photo', 0.95), cached: false }),
      profileService: svc,
    });
    assert.equal(plan.coverForm, 'generative');
    assert.equal(plan.gateReason, 'form_not_text_card');
    assert.equal(plan.formProfile, 'generative');
    assert.equal(plan.formProfileGate, 'generative_cover_not_card');
  });
});

describe('CoverCardWriterRole × 轮播整帖多卡（change textcard-carousel-form-parity 阶段1）', () => {
  const ALL_CARD: PostFormProfileResult = {
    profile: 'all_text_card',
    gateReason: 'all_text_card',
    perImageForms: [
      { index: 0, form: 'text_card', source: 'vision' },
      { index: 1, form: 'text_card', source: 'vision' },
      { index: 2, form: 'text_card', source: 'vision' },
    ],
    innerSensed: 2,
  };
  // 3 张有效源图（referenceImagesForGeneration 计 3 → N=3）。
  function trigger3(): TriggerInput {
    const t = makeTrigger(true);
    t.generateInput.referenceNote!.images = [0, 1, 2].map((i) => ({
      index: i,
      sourceUrl: `https://cdn.example/o${i}.webp`,
      ossUrl: `https://oss.example/o${i}.webp`,
      capturedAt: 1,
    }));
    return t;
  }
  function trigger3WithTranscription(): TriggerInput {
    const t = trigger3();
    t.generateInput.referenceNote!.textCardTranscription = {
      version: 1,
      status: 'complete',
      anchor: `sha256:${'a'.repeat(64)}`,
      provider: 'dashscope',
      model: 'ocr-model',
      transcribedAt: 2,
      cards: [
        { sourceArrayIndex: 0, sourceIndex: 0, capturedAt: 1, status: 'transcribed', text: '封面讲本地迁移的价值' },
        { sourceArrayIndex: 1, sourceIndex: 1, capturedAt: 1, status: 'transcribed', text: '先安装环境并检查路径' },
        { sourceArrayIndex: 2, sourceIndex: 2, capturedAt: 1, status: 'transcribed', text: '备份数据再逐条导入' },
      ],
    };
    return t;
  }
  const SET3 = JSON.stringify({
    cards: [
      { cardTitle: '三分钟搬走AI记忆', bullets: ['告别云端依赖'], tags: ['干货'] },
      { cardTitle: '第一步装好环境', bullets: ['选对版本', '配好路径'], tags: [] },
      { cardTitle: '第二步导入数据', bullets: ['备份先行', '逐条迁移'], tags: [] },
    ],
  });

  test('all_text_card + 轮播旗标开 + 合法多卡 → cardSet 三张、coverForm text_card、card=cardSet[0]', async () => {
    const { plan } = await run({
      sensor: stubSensor({ status: 'detected', guess: guess('text_card', 0.9), cached: false }),
      profileService: stubProfileService(ALL_CARD, true),
      carouselEnabled: true,
      trigger: trigger3(),
      llmOutputs: [SET3],
    });
    assert.equal(plan.coverForm, 'text_card');
    assert.equal(plan.gateReason, 'ok');
    assert.equal(plan.cardSet?.length, 3);
    assert.equal(plan.card?.title, '三分钟搬走AI记忆');
    assert.equal(plan.cardSet?.[0]?.title, plan.card?.title, 'card 兼作 cardSet[0]');
    assert.equal(plan.cardSet?.[2]?.title, '第二步导入数据');
    assert.equal(plan.formProfile, 'all_text_card');
    assert.equal(plan.cardContentMapping, 'body_fallback');
  });

  test('完整逐卡转写 → 按参考图顺序交给文案服务并记录 ordered_transcription 映射', async () => {
    const { plan, llmCalls } = await run({
      sensor: stubSensor({ status: 'detected', guess: guess('text_card', 0.9), cached: false }),
      profileService: stubProfileService(ALL_CARD, true),
      carouselEnabled: true,
      trigger: trigger3WithTranscription(),
      llmOutputs: [SET3],
    });
    assert.equal(plan.cardContentMapping, 'ordered_transcription');
    assert.deepEqual(plan.cardSourceArrayIndices, [0, 1, 2]);
    assert.match(llmCalls[0], /生成第 1 张 ↔ 来源数组下标 0[\s\S]*封面讲本地迁移的价值/);
    assert.match(llmCalls[0], /生成第 2 张 ↔ 来源数组下标 1[\s\S]*先安装环境并检查路径/);
    assert.match(llmCalls[0], /生成第 3 张 ↔ 来源数组下标 2[\s\S]*备份数据再逐条导入/);
    assert.match(llmCalls[0], /若来源槽与终稿冲突，以终稿为准/);
  });

  test('任一实际生成槽缺转写 → 整套回落 body_fallback，不做部分映射', async () => {
    const trigger = trigger3WithTranscription();
    trigger.generateInput.referenceNote!.textCardTranscription!.cards[1] = {
      sourceArrayIndex: 1,
      sourceIndex: 1,
      capturedAt: 1,
      status: 'failed',
      reason: 'missing_card_result',
    };
    trigger.generateInput.referenceNote!.textCardTranscription!.status = 'partial';
    const { plan, llmCalls } = await run({
      sensor: stubSensor({ status: 'detected', guess: guess('text_card', 0.9), cached: false }),
      profileService: stubProfileService(ALL_CARD, true),
      carouselEnabled: true,
      trigger,
      llmOutputs: [SET3],
    });
    assert.equal(plan.cardContentMapping, 'body_fallback');
    assert.equal(plan.cardSourceArrayIndices, undefined);
    assert.doesNotMatch(llmCalls[0], /来源文字卡的有序信息槽/);
  });

  test('轮播旗标关（默认）→ 即使 all_text_card 也只走单封面卡（无 cardSet）', async () => {
    const { plan } = await run({
      sensor: stubSensor({ status: 'detected', guess: guess('text_card', 0.9), cached: false }),
      profileService: stubProfileService(ALL_CARD, true),
      carouselEnabled: false,
      trigger: trigger3(),
      llmOutputs: [GOOD_COPY], // 单封面卡路径
    });
    assert.equal(plan.coverForm, 'text_card');
    assert.equal(plan.cardSet, undefined, '轮播关：不产 cardSet');
    assert.equal(plan.formProfile, 'all_text_card', '影子形态档仍记录');
  });

  test('任一张逐字搬运（重试后仍违规）→ 整帖回落生成式 + formProfileGate=carousel_copy_failed', async () => {
    // 第 2 张 bullet 与原正文 ≥12 字逐字重叠 → 违规；两版都违规 → 整帖回落。
    const plagiar = JSON.stringify({
      cards: [
        { cardTitle: '正常封面卡片标题', bullets: ['正常要点'], tags: [] },
        { cardTitle: '正常小标题', bullets: ['用某工具这段时间踩过的坑挑了5个'], tags: [] },
        { cardTitle: '另一个小标题', bullets: ['正常要点二'], tags: [] },
      ],
    });
    const { plan } = await run({
      sensor: stubSensor({ status: 'detected', guess: guess('text_card', 0.9), cached: false }),
      profileService: stubProfileService(ALL_CARD, true),
      carouselEnabled: true,
      trigger: trigger3(),
      llmOutputs: [plagiar, plagiar], // 首发 + 重试都违规
    });
    assert.equal(plan.coverForm, 'generative', '整帖回落生成式（绝不只替换违规张）');
    assert.equal(plan.cardSet, undefined);
    assert.equal(plan.formProfileGate, 'carousel_copy_failed', '诚实记因');
  });
});
