import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TitleCreatorRole } from '../../src/publish-agent/roles/title-creator.js';
import { PipelineContext } from '../../src/publish-agent/pipeline-context.js';
import { graphemeCount } from '../../src/publish-agent/title-clamp.js';
import type { PipelineFields, AssembledContent, CreatedContent, TriggerInput } from '../../src/publish-agent/types.js';

const clock = () => 1700000000000;
const silentLogger = { log() {}, warn() {}, error() {} };

function makeAssembled(finalContent = '昨天试了 vLLM 跑 14B，显存直接爆了，调小 max_model_len 才起来'): AssembledContent {
  return {
    finalContent, finalTags: ['vLLM'], imageUrls: [], imageUrl: null,
    aiScore: 0.1, qualityScore: 80, rewritten: false, flaggedPhrases: [], assembledAt: clock(),
  };
}

function makeCreated(): CreatedContent {
  return { title: '草稿标题', content: '草稿正文OTHER', tags: ['vLLM'], tone: 'casual', style: { type: '踩坑记录' }, createdAt: clock() };
}

function makeTrigger(): TriggerInput {
  return {
    metrics: { hoursSinceLastPublish: 30, newConceptCount: 3, likedSinceLastPublish: 20 },
    generateInput: {
      concepts: [], likedContents: [],
      soul: { identity: { name: '小林', role: 'AI研发', background: '3年', tone: '理性' } } as any,
      recentPosts: [],
    },
    recentPublished: [],
  };
}

/** 装好 trigger + createdContent，再写 assembledContent 触发角色，等待结算。 */
async function run(role: TitleCreatorRole, assembled: AssembledContent, ms = 60) {
  const ctx = new PipelineContext<PipelineFields>();
  ctx.write('trigger', makeTrigger());
  ctx.write('createdContent', makeCreated());
  role.register(ctx);
  ctx.write('assembledContent', assembled);
  await new Promise((r) => setTimeout(r, ms));
  return ctx;
}

describe('AC-TITLE-ROLE TitleCreator', () => {
  test('有效干净标题（首次即合规）→ 写 titleSelection、source=llm、≤18', async () => {
    let calls = 0;
    const fakeLlm = { chat: async () => { calls++; return JSON.stringify({ title: 'vLLM 部署踩坑' }); }, complete: async () => '' };
    const role = new TitleCreatorRole({ llmClient: fakeLlm as any, clock, logger: silentLogger });

    const ctx = await run(role, makeAssembled());
    const sel = ctx.get('titleSelection');
    assert.ok(sel);
    assert.equal(sel.title, 'vLLM 部署踩坑');
    assert.equal(sel.source, 'llm');
    assert.ok(graphemeCount(sel.title) <= 18);
    assert.equal(calls, 1, '合规即停，不多调');
  });

  test('LLM 标题 >18 → 重试用尽后 clamp 收口至 ≤18、source 仍 llm', async () => {
    let calls = 0;
    const longTitle = '别迷信 vLLM 开箱即用默认参数在生产环境简直就是一场灾难现场'; // >18
    const fakeLlm = { chat: async () => { calls++; return JSON.stringify({ title: longTitle }); }, complete: async () => '' };
    const role = new TitleCreatorRole({ llmClient: fakeLlm as any, clock, logger: silentLogger });

    const ctx = await run(role, makeAssembled());
    const sel = ctx.get('titleSelection');
    assert.ok(sel);
    assert.equal(graphemeCount(sel.title), 18, '收口恰 18');
    assert.equal(sel.source, 'llm');
    assert.equal(calls, 3, '不合规语义重试：首次 + 2 次重试');
  });

  test('红线：LLM 连续失败 → 抛错走 abort，不写 titleSelection、不派生假标题，并写 pipelineAbort 信号', async () => {
    let calls = 0;
    const fakeLlm = { chat: async () => { calls++; throw new Error('LLM unavailable'); }, complete: async () => '' };
    const role = new TitleCreatorRole({ llmClient: fakeLlm as any, clock, logger: silentLogger });

    const ctx = await run(role, makeAssembled(), 80);
    assert.equal(ctx.get('titleSelection'), undefined, '红线：失败绝不写标题/派生假标题');
    assert.equal(calls, 3, '首次 + 2 次重试后放弃');
    const abort = ctx.get('pipelineAbort');
    assert.ok(abort, 'abort 须写中止信号 → 编排器即时判 failed');
    assert.equal(abort.role, 'TitleCreator');
  });

  test('取定稿正文 finalContent（非 createdContent.content 草稿）喂给 LLM', async () => {
    let userMsg = '';
    const fakeLlm = {
      chat: async (messages: any[]) => { userMsg = messages[1]?.content ?? ''; return JSON.stringify({ title: 'T' }); },
      complete: async () => '',
    };
    const role = new TitleCreatorRole({ llmClient: fakeLlm as any, clock, logger: silentLogger });

    await run(role, makeAssembled('定稿正文DISTINCT_MARKER 才是标题依据'));
    assert.ok(userMsg.includes('定稿正文DISTINCT_MARKER'), '标题须基于定稿 finalContent');
    assert.ok(!userMsg.includes('草稿正文OTHER'), '不得用 createdContent.content 草稿');
  });

  test('空定稿正文 → 诚实空标题（source=derived），不白调 LLM', async () => {
    let calls = 0;
    const fakeLlm = { chat: async () => { calls++; return JSON.stringify({ title: 'X' }); }, complete: async () => '' };
    const role = new TitleCreatorRole({ llmClient: fakeLlm as any, clock, logger: silentLogger });

    const ctx = await run(role, makeAssembled(''));
    const sel = ctx.get('titleSelection');
    assert.ok(sel);
    assert.equal(sel.title, '');
    assert.equal(sel.source, 'derived');
    assert.equal(calls, 0, '空正文不调 LLM');
  });
});
