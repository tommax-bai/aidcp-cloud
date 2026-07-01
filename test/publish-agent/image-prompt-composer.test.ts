import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ImagePromptComposerRole } from '../../src/publish-agent/roles/image-prompt-composer.js';
import { PipelineContext } from '../../src/publish-agent/pipeline-context.js';
import type { PipelineFields, ImageSetPlan, ImageTheme } from '../../src/publish-agent/types.js';

const clock = () => 1700000000000;
const silentLogger = { log() {}, warn() {}, error() {} };

function setPlan(themes: ImageTheme[], wantImage = true): ImageSetPlan {
  return { wantImage, imageCount: themes.length, themes, styleHint: null, plannedAt: clock() };
}

function run(llm: unknown, plan: ImageSetPlan, waitMs = 60) {
  const role = new ImagePromptComposerRole({ llmClient: llm as never, clock, logger: silentLogger });
  const ctx = new PipelineContext<PipelineFields>();
  role.register(ctx);
  ctx.write('imageSetPlan', plan);
  return new Promise<NonNullable<PipelineFields['imagePlan']>>((resolve) =>
    setTimeout(() => resolve(ctx.get('imagePlan')!), waitMs),
  );
}

describe('ImagePromptComposerRole（配图指令，仅桩 LLM、不依赖图源）', () => {
  test('每主题一条 prompt + 共享固定风格基底 + 保序', async () => {
    let n = 0;
    const llm = { chat: async () => JSON.stringify({ imagePrompt: `distinct-desc-${n++}`, imageStyle: 'isometric' }), complete: async () => '' };
    const plan = await run(llm, setPlan([{ subject: 'a' }, { subject: 'b' }, { subject: 'c' }]));
    assert.equal(plan.wantImage, true);
    assert.equal(plan.imageCount, 3);
    assert.equal(plan.imagePrompts.length, 3);
    // 每条都含固定风格基底（系统注入，非 LLM 产）。
    plan.imagePrompts.forEach((p) => assert.match(p, /no text/, '共享固定风格基底'));
    assert.equal(plan.imageStyle, 'isometric');
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
