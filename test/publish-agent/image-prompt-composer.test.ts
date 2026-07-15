import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ImagePromptComposerRole } from '../../src/publish-agent/roles/image-prompt-composer.js';
import { PipelineContext } from '../../src/publish-agent/pipeline-context.js';
import { REFERENCE_IMAGE_MAX_COUNT } from '../../src/publish-agent/reference-image-guidance.js';
import type { PipelineFields, ImageSetPlan, ImageTheme, ImageCategory, TriggerInput, CoverCardPlan } from '../../src/publish-agent/types.js';
import type { ReferenceVisualAnalysis } from '../../src/publish-agent/visual-reference-types.js';

const clock = () => 1700000000000;
const silentLogger = { log() {}, warn() {}, error() {} };

function setPlan(themes: ImageTheme[], wantImage = true): ImageSetPlan {
  return { wantImage, imageCount: themes.length, themes, styleHint: null, plannedAt: clock() };
}

/** 缺省生成式决策（change textcard-cover-form：composer 现 waitAll 三键，CoverCardWriter 恒写此键）。 */
function generativeCoverPlan(): CoverCardPlan {
  return { coverForm: 'generative', card: null, sensedForm: 'unknown', sensedSource: 'none', gateReason: 'flag_off', decidedAt: clock() };
}

// composer 现 waitAll [imageSetPlan, postCategory, coverCardPlan]：三键都写才触发（category 决定品类风格档）。
function run(
  llm: unknown,
  plan: ImageSetPlan,
  waitMs = 60,
  category: ImageCategory = 'food',
  trigger?: TriggerInput,
  coverPlan: CoverCardPlan = generativeCoverPlan(),
) {
  const role = new ImagePromptComposerRole({ llmClient: llm as never, clock, logger: silentLogger });
  const ctx = new PipelineContext<PipelineFields>();
  role.register(ctx);
  if (trigger) ctx.write('trigger', trigger);
  ctx.write('postCategory', { category, classifiedAt: clock() });
  ctx.write('coverCardPlan', coverPlan);
  ctx.write('referenceVisualAnalysis', {
    status: 'disabled', schemaVersion: 'visual-reference-v2', cacheKey: null, provider: null, model: null,
    analyzedAt: null, sourceCount: 0,
  });
  ctx.write('imageSetPlan', plan);
  return new Promise<NonNullable<PipelineFields['imagePlan']>>((resolve) =>
    setTimeout(() => resolve(ctx.get('imagePlan')!), waitMs),
  );
}

describe('ImagePromptComposerRole（配图指令，仅桩 LLM、不依赖图源）', () => {
  test('每主题一条 prompt + 共享本帖品类风格档 + 保序', async () => {
    let n = 0;
    const llm = { chat: async () => JSON.stringify({ imagePrompt: `distinct-desc-${n++}` }), complete: async () => '' };
    const plan = await run(llm, setPlan([{ subject: 'a' }, { subject: 'b' }, { subject: 'c' }]));
    assert.equal(plan.wantImage, true);
    assert.equal(plan.imageCount, 3);
    assert.equal(plan.imagePrompts.length, 3);
    // 每条都含本帖品类风格档（此处 category='food'，系统注入、非 LLM 产）。
    plan.imagePrompts.forEach((p) => assert.match(p, /food photography/, '共享本帖品类风格档'));
    // 图 0 用封面变体（顶部留白供后期叠字）。
    assert.match(plan.imagePrompts[0], /negative space at the top/, '封面档留白');
    // 不再产 imageStyle 枚举（风格由品类风格档承载、不由 provider 二次拼）。
    assert.equal(plan.imageStyle, null);
  });

  test('reference images are included as visual guidance and preserved on ImagePlan', async () => {
    let userPrompt = '';
    const referenceImages = Array.from({ length: 10 }, (_, i) => ({
      index: i,
      sourceUrl: `https://img.test/source-${i}.jpg`,
      ossUrl: `https://oss.test/source-${i}.jpg`,
      width: 800,
      height: 600,
      alt: i === 0 ? 'desk setup' : `reference ${i}`,
    }));
    const llm = {
      chat: async (msgs: Array<{ content: string }>) => {
        userPrompt = msgs[1]?.content ?? '';
        return JSON.stringify({ imagePrompt: 'reference aware scene' });
      },
      complete: async () => '',
    };
    const trigger = {
      accountId: 'acc-test',
      generateInput: {
        concepts: [],
        likedContents: [],
        referenceNote: {
          sourceId: 'note-ref',
          title: 'ref',
          body: 'body',
          topics: [],
          images: referenceImages,
        },
        soul: {} as TriggerInput['generateInput']['soul'],
        recentPosts: [],
      },
      metrics: { hoursSinceLastPublish: 999, newConceptCount: 0, likedSinceLastPublish: 0 },
      recentPublished: [],
      forced: true,
      reason: 'manual_reference',
      triggeredAt: clock(),
    } as TriggerInput;

    const plan = await run(llm, setPlan([{ subject: 'desk' }]), 60, 'knowledge', trigger);
    assert.match(userPrompt, /Reference image guidance/);
    assert.match(userPrompt, /https:\/\/oss\.test\/source-0\.jpg/);
    assert.match(userPrompt, /https:\/\/oss\.test\/source-8\.jpg/);
    assert.doesNotMatch(userPrompt, /https:\/\/oss\.test\/source-9\.jpg/);
    assert.match(userPrompt, /desk setup/);
    assert.equal(plan.referenceImages?.length, REFERENCE_IMAGE_MAX_COUNT);
    assert.deepEqual(plan.referenceImages, referenceImages.slice(0, REFERENCE_IMAGE_MAX_COUNT));
  });

  test('反推可用时使用无 URL 的结构化视觉指导、源风格优先，并建立逐槽主参考', async () => {
    let userPrompt = '';
    const llm = { chat: async (messages: Array<{ content: string }>) => {
      userPrompt = messages[1].content;
      return JSON.stringify({ imagePrompt: '原创静物画面' });
    }, complete: async () => '' };
    const trigger = {
      accountId: 'a', generateInput: { concepts: [], likedContents: [], recentPosts: [], soul: {}, referenceNote: {
        sourceId: 'n', title: 't', body: 'b', topics: [], images: [{ index: 7, sourceUrl: 'https://secret.ref/a.jpg' }],
      } }, metrics: {}, recentPublished: [],
    } as unknown as TriggerInput;
    const analysis: ReferenceVisualAnalysis = {
      status: 'analyzed', schemaVersion: 'visual-reference-v2', cacheKey: 'k', provider: 'p', model: 'm', analyzedAt: 1, sourceCount: 1,
      setStyleBible: { summary: '冷色硬光极简静物', palette: ['冷蓝'], colorTemperature: 'cool', contrast: 'high', visualDensity: 'sparse', whitespace: '大面积留白', hierarchy: '单主体', mood: ['克制'], texture: ['金属'], continuityRules: ['冷色统一'], avoid: ['水印'] },
      styleClusters: [{ id: 'c1', label: '冷蓝', frameIndexes: [0], summary: '冷蓝硬光', palette: ['冷蓝'], traits: ['极简'] }],
      frameSpecs: [{
        sourceArrayIndex: 0, sourceIndex: 7, kind: 'still_life_photo', confidence: 0.95, clusterId: 'c1', sequenceRole: 'cover',
        common: { aspectRatio: '3:4', subject: '单一产品静物', composition: '偏心构图', focalHierarchy: '单焦点', palette: ['冷蓝'], lightingOrContrast: '硬侧光高对比', negativeSpace: '顶部留白', texture: '金属', mood: '克制', avoid: ['水印'] },
        details: { family: 'photo', cameraAngle: '45度', focalLengthFeel: '中焦', depthOfField: '浅', focus: '产品', light: '硬侧光', colorGrade: '冷色', grainSharpness: '高清锐利' },
      }],
    };
    const role = new ImagePromptComposerRole({ llmClient: llm as never, sourceStyleEnabled: () => true, bindingEnabled: () => true, clock, logger: silentLogger });
    const ctx = new PipelineContext<PipelineFields>();
    role.register(ctx);
    ctx.write('trigger', trigger);
    ctx.write('postCategory', { category: 'food', classifiedAt: clock() });
    ctx.write('coverCardPlan', generativeCoverPlan());
    ctx.write('referenceVisualAnalysis', analysis);
    ctx.write('imageSetPlan', setPlan([{ subject: '产品', sourceArrayIndex: 0, sourceIndex: 7 }]));
    await new Promise((resolve) => setTimeout(resolve, 60));
    const plan = ctx.get('imagePlan')!;
    assert.match(userPrompt, /视觉模型对主参考图的结构化反推/);
    assert.doesNotMatch(userPrompt, /secret\.ref/, '结构化指导不得把 URL 写入文本 prompt');
    assert.match(plan.imagePrompts[0], /冷色硬光|硬侧光高对比/);
    assert.doesNotMatch(plan.imagePrompts[0], /food photography/, '源风格不被食品通用暖色档覆盖');
    assert.deepEqual(plan.referenceBindings?.[0].references, [{ sourceArrayIndex: 0, sourceIndex: 7, url: 'https://secret.ref/a.jpg', role: 'primary' }]);
    assert.equal(plan.visualStyleSources?.[0], 'reference_analysis');
  });

  test('文字卡反推派生白名单设计令牌并随 ImagePlan 逐槽下发', async () => {
    const llm = { chat: async () => JSON.stringify({ imagePrompt: '原创知识卡内容' }), complete: async () => '' };
    const trigger = {
      accountId: 'a', generateInput: { referenceNote: {
        sourceId: 'cards', title: 't', body: 'b', topics: [],
        images: [{ index: 0, sourceUrl: 'https://ref.test/0.jpg' }],
      } },
    } as unknown as TriggerInput;
    const analysis: ReferenceVisualAnalysis = {
      status: 'analyzed', schemaVersion: 'visual-reference-v2', cacheKey: 'k2', provider: 'p', model: 'm', analyzedAt: 1, sourceCount: 1,
      setStyleBible: {
        summary: '薄荷绿渐变细网格知识卡', palette: ['薄荷绿', '米白'], colorTemperature: 'cool', contrast: 'medium',
        visualDensity: 'balanced', whitespace: '下半留白', hierarchy: '标题、圆角卡片、分页', mood: ['理性'], texture: ['细网格'],
        continuityRules: ['统一分页'], avoid: ['水印'],
      },
      styleClusters: [{ id: 'c1', label: '知识卡', frameIndexes: [0], summary: '薄荷网格与圆角卡片', palette: ['薄荷绿'], traits: ['分页'] }],
      frameSpecs: [{
        sourceArrayIndex: 0, sourceIndex: 0, kind: 'text_layout', confidence: 0.96, clusterId: 'c1', sequenceRole: 'cover',
        common: {
          aspectRatio: '3:4', subject: '知识卡', composition: '标题与圆角信息卡', focalHierarchy: '标题优先', palette: ['薄荷绿'],
          lightingOrContrast: '中等对比', negativeSpace: '下部留白', texture: '细网格', mood: '理性', avoid: [],
        },
        details: {
          family: 'text_layout', grid: '细方格', textBlockRatio: '中等', hierarchy: '标题与卡片', alignment: '左对齐',
          weightContrast: '粗细对比', colorBlocks: '圆角信息卡', decorations: '分页标记',
        },
      }],
    };
    const card = { title: '奖励难给？看模型自进化', bullets: ['动态生成评分标准'], tags: ['强化学习'] };
    const coverPlan: CoverCardPlan = {
      coverForm: 'text_card', card, cardSet: [card], sensedForm: 'text_card', sensedSource: 'vision', gateReason: 'ok', decidedAt: clock(),
    };
    const role = new ImagePromptComposerRole({ llmClient: llm as never, sourceStyleEnabled: () => true, bindingEnabled: () => true, clock, logger: silentLogger });
    const ctx = new PipelineContext<PipelineFields>();
    role.register(ctx);
    ctx.write('trigger', trigger);
    ctx.write('postCategory', { category: 'tech', classifiedAt: clock() });
    ctx.write('coverCardPlan', coverPlan);
    ctx.write('referenceVisualAnalysis', analysis);
    ctx.write('imageSetPlan', setPlan([{ subject: 'EvoRubric', sourceArrayIndex: 0, sourceIndex: 0 }]));
    await new Promise((resolve) => setTimeout(resolve, 60));
    const plan = ctx.get('imagePlan')!;
    assert.equal(plan.textCardStyles?.[0]?.paletteKey, 'mint');
    assert.equal(plan.textCardStyles?.[0]?.backgroundPattern, 'fine_grid');
    assert.equal(plan.textCardStyles?.[0]?.bulletPresentation, 'callout');
    assert.equal(plan.visualRoutes?.[0], 'deterministic_text_card');
    assert.equal(plan.visualStyleSources?.[0], 'reference_analysis');
  });

  test('反推 unavailable 继续透传到执行审计，不降成 none', async () => {
    const llm = { chat: async () => JSON.stringify({ imagePrompt: 'fallback scene' }), complete: async () => '' };
    const role = new ImagePromptComposerRole({ llmClient: llm as never, sourceStyleEnabled: () => true, bindingEnabled: () => true, clock, logger: silentLogger });
    const ctx = new PipelineContext<PipelineFields>();
    role.register(ctx);
    ctx.write('trigger', {
      accountId: 'a', generateInput: { referenceNote: { sourceId: 'n', images: [{ index: 0, sourceUrl: 'https://ref.test/0.jpg' }] } },
    } as unknown as TriggerInput);
    ctx.write('postCategory', { category: 'tech', classifiedAt: clock() });
    ctx.write('coverCardPlan', generativeCoverPlan());
    ctx.write('referenceVisualAnalysis', {
      status: 'unavailable', schemaVersion: 'visual-reference-v2', cacheKey: 'failed-k', provider: 'p', model: 'm',
      analyzedAt: null, sourceCount: 1, error: 'vision timeout',
    });
    ctx.write('imageSetPlan', setPlan([{ subject: 'fallback', sourceArrayIndex: 0, sourceIndex: 0 }]));
    await new Promise((resolve) => setTimeout(resolve, 60));
    const plan = ctx.get('imagePlan')!;
    assert.equal(plan.referenceVisualAnalysis?.status, 'unavailable');
    assert.equal(plan.referenceVisualAnalysis?.error, 'vision timeout');
    assert.equal(plan.visualStyleSources?.[0], 'category_fallback');
  });

  test('近重复主体 → 丢弃，但永远保住第 0 张（wantImage:true → ≥1）', async () => {
    // 所有主题 LLM 都返回相同描述 → 全近重复；护栏只保住第 0 张、不补不复用。
    const llm = { chat: async () => JSON.stringify({ imagePrompt: 'identical scene same words', imageStyle: 'illustration' }), complete: async () => '' };
    const plan = await run(llm, setPlan([{ subject: 'a' }, { subject: 'b' }, { subject: 'c' }]));
    assert.equal(plan.imagePrompts.length, 1, '近重复全丢，只留第 0 张');
    assert.equal(plan.wantImage, true);
  });

  test('某主题 LLM 失败 → 退回主体文本（该张不凭空消失）', async () => {
    const llm = {
      chat: async (msgs: Array<{ content: string }>) => {
        const u = msgs[1]?.content ?? '';
        if (u.includes('第二张主体')) throw new Error('llm down');
        return JSON.stringify({ imagePrompt: 'ok scene alpha', imageStyle: 'illustration' });
      },
      complete: async () => '',
    };
    const plan = await run(llm, setPlan([{ subject: '第一张主体' }, { subject: '第二张主体' }]));
    assert.equal(plan.imagePrompts.length, 2, '失败主题退回文本、不丢张');
    assert.match(plan.imagePrompts[1], /第二张主体/, '退回主体文本');
  });

  test('wantImage:false → 空 plan（不产 prompt、不调 LLM）', async () => {
    let called = false;
    const llm = { chat: async () => { called = true; return '{}'; }, complete: async () => '' };
    const plan = await run(llm, setPlan([], false));
    assert.equal(plan.wantImage, false);
    assert.equal(plan.imagePrompts.length, 0);
    assert.equal(called, false, '不配图计划不调 LLM');
  });

  // ─── change textcard-cover-form：封面形态决策盖章透传 ───

  test('text_card 决策盖章进 imagePlan 且 0 号生成式提示词恒在（降级兜底就位）', async () => {
    const llm = { chat: async () => JSON.stringify({ imagePrompt: 'cover scene' }), complete: async () => '' };
    const coverPlan: CoverCardPlan = {
      coverForm: 'text_card',
      card: { title: '这5个坑我替你踩了', bullets: ['坑一', '坑二'], tags: ['避坑'] },
      sensedForm: 'text_card',
      sensedSource: 'vision',
      gateReason: 'ok',
      decidedAt: clock(),
    };
    const plan = await run(llm, setPlan([{ subject: 'a' }]), 60, 'food', undefined, coverPlan);
    assert.equal(plan.coverForm, 'text_card');
    assert.deepEqual(plan.coverCard, coverPlan.card);
    assert.deepEqual(plan.coverGate, { sensedForm: 'text_card', sensedSource: 'vision', gateReason: 'ok' });
    assert.equal(plan.imagePrompts.length, 1, 'text_card 决策下 0 号生成式提示词照常产出');
    assert.match(plan.imagePrompts[0], /negative space at the top/, '0 号仍为封面档生成式提示词');
  });

  test('缺省生成式决策盖章为常量（flag-off 零回归面）', async () => {
    const llm = { chat: async () => JSON.stringify({ imagePrompt: 'x' }), complete: async () => '' };
    const plan = await run(llm, setPlan([{ subject: 'a' }]));
    assert.equal(plan.coverForm, 'generative');
    assert.equal(plan.coverCard, null);
    assert.equal(plan.coverGate?.gateReason, 'flag_off');
  });
});
