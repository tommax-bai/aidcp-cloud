import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ImagePromptComposerRole } from '../../src/publish-agent/roles/image-prompt-composer.js';
import { PipelineContext } from '../../src/publish-agent/pipeline-context.js';
import { REFERENCE_IMAGE_MAX_COUNT } from '../../src/publish-agent/reference-image-guidance.js';
import type { PipelineFields, ImageSetPlan, ImageTheme, ImageCategory, TriggerInput, CoverCardPlan } from '../../src/publish-agent/types.js';

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
