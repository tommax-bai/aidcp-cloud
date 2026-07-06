import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ImagePromptComposerRole } from '../../src/publish-agent/roles/image-prompt-composer.js';
import { PipelineContext } from '../../src/publish-agent/pipeline-context.js';
import { REFERENCE_IMAGE_MAX_COUNT } from '../../src/publish-agent/reference-image-guidance.js';
import type { PipelineFields, ImageSetPlan, ImageTheme, ImageCategory, TriggerInput } from '../../src/publish-agent/types.js';

const clock = () => 1700000000000;
const silentLogger = { log() {}, warn() {}, error() {} };

function setPlan(themes: ImageTheme[], wantImage = true): ImageSetPlan {
  return { wantImage, imageCount: themes.length, themes, styleHint: null, plannedAt: clock() };
}

// composer 现 waitAll [imageSetPlan, postCategory]：两键都写才触发（category 决定品类风格档）。
function run(llm: unknown, plan: ImageSetPlan, waitMs = 60, category: ImageCategory = 'food', trigger?: TriggerInput) {
  const role = new ImagePromptComposerRole({ llmClient: llm as never, clock, logger: silentLogger });
  const ctx = new PipelineContext<PipelineFields>();
  role.register(ctx);
  if (trigger) ctx.write('trigger', trigger);
  ctx.write('postCategory', { category, classifiedAt: clock() });
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
});
