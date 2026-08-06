/**
 * 验收用例 AC-PUB-DETECH / AC-CONCEPT-NEUTRAL — 内容管线去技术化的 prompt 面断言
 * （change persona-driven-content-pipeline，task 1.3 / 4.6 的确定性部分）。
 *
 * 断言层次说明：这里锁死「prompt 面」——非技术人设账号的正文/标题/概念抽取 prompt 必须体现
 * 该账号人设与领域、不得残留「技术帖 / 小林 / 技术博主」写死。「LLM 产出内容确实呈现该领域」
 * 属模型运行时行为，须真机回归，单测桩不覆盖（诚实边界，不假装已验证）。
 */
import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCreatorPrompt, buildTitlePrompt, buildTopicGenerationPrompt } from '@content/publish-agent/prompts.js';
import { ContentCreatorRole } from '@content/publish-agent/roles/content-creator.js';
import { PipelineContext } from '@content/publish-agent/pipeline-context.js';
import type { PipelineFields, TriggerInput, ScoutDecision } from '@content/publish-agent/types.js';
import { ConceptExtractorRole } from '@automation/agents/concept-extractor-role.js';
import { EventBus } from '@automation/event-bus/index.js';
import type { Soul } from '@kernel/kernel/soul-types.js';
import { XHS_COMMENT_PROFILE } from '@automation/platform/registry.js';

/** 非技术（美食）人设：验证内容管线跟随人设、不再写死技术领域。 */
const foodSoul: Soul = {
  identity: { name: '阿棠', role: '家常菜美食博主', background: '五年家宴掌勺', tone: '烟火气、实在' },
  interests: { primary: ['家常菜', '砂锅菜'], secondary: ['烘焙'], seed_keywords: ['空气炸锅', '一人食'] },
};

function makeTrigger(): TriggerInput {
  return {
    metrics: { hoursSinceLastPublish: 30, newConceptCount: 3, likedSinceLastPublish: 5 },
    generateInput: {
      concepts: [{ keyword: '砂锅焗饭' }],
      likedContents: [{ id: 1, title: '砂锅焗饭火候', summary: '锅气关键', author: '老徐' }],
      soul: foodSoul,
      recentPosts: [],
    },
    recentPublished: [],
  };
}

const scoutDecision: ScoutDecision = {
  shouldPublish: true,
  publishDirection: '砂锅焗饭火候',
  keyPoints: ['锅底焦香', '火候节奏'],
  confidence: 0.9,
  reason: '素材充足',
  scoutedAt: 1700000000000,
};

describe('AC-PUB-DETECH 发布侧 prompt 人设驱动、无技术写死', () => {
  it('AC-PUB-DETECH-01 正文创作 prompt 以账号人设开场（身份/领域），无「技术帖/小林」写死', () => {
    const prompt = buildCreatorPrompt(scoutDecision, makeTrigger());
    assert.match(prompt, /阿棠/, '必须使用账号人设身份');
    assert.match(prompt, /家常菜美食博主/, '必须体现人设角色');
    assert.match(prompt, /家常菜|砂锅菜/, '必须体现人设兴趣领域');
    assert.ok(!prompt.includes('技术帖'), '不得残留「技术帖」写死');
    assert.ok(!prompt.includes('小林'), '不得残留「小林」硬编码人设');
  });

  it('AC-PUB-DETECH-02 标题/话题 prompt 话题中立：跟随传入人设，无「技术帖/技术博主」写死', () => {
    const persona = '家常菜美食博主｜五年家宴掌勺（语气：烟火气）';
    const title = buildTitlePrompt('今天砂锅焗饭的火候终于稳了', persona, 'plain');
    assert.match(title, /家常菜美食博主/);
    assert.ok(!title.includes('技术帖') && !title.includes('技术博主'));
    const topics = buildTopicGenerationPrompt('今天砂锅焗饭的火候终于稳了', persona);
    assert.match(topics, /家常菜美食博主/);
    assert.ok(!topics.includes('技术帖') && !topics.includes('技术博主'));
  });

  it('AC-PUB-DETECH-03 正文创作 system 提示为中立「笔记创作者」，不再是「技术博主」', async () => {
    const captured: Array<{ role: string; content: string }> = [];
    const fakeLlm = {
      chat: async (messages: Array<{ role: string; content: string }>) => {
        captured.push(...messages);
        return JSON.stringify({ title: 't', content: 'c', tags: [], tone: 'x', style: 'y' });
      },
      complete: async () => '',
    };
    const role = new ContentCreatorRole({
      llmClient: fakeLlm as never,
      clock: () => 1700000000000,
      logger: { log() {}, warn() {}, error() {} },
    });
    const ctx = new PipelineContext<PipelineFields>();
    ctx.write('trigger', makeTrigger());
    role.register(ctx);
    ctx.write('scoutDecision', scoutDecision);
    await new Promise((r) => setTimeout(r, 50));
    const system = captured.find((m) => m.role === 'system');
    assert.ok(system, '应有 system 提示');
    assert.match(system!.content, /笔记创作者/);
    assert.ok(!system!.content.includes('技术博主'), 'system 不得写死技术博主');
  });
});

test('AC-CONCEPT-NEUTRAL 概念抽取 prompt 话题中立：按人设兴趣抽任意领域概念，保留「抽不到即空、不编造」红线', () => {
  const role = new ConceptExtractorRole({
    eventBus: new EventBus(),
    soul: foodSoul,
    llm: { complete: async () => '[]' },
    conceptStore: { addCandidate: async () => true },
    platformProfile: XHS_COMMENT_PROFILE,
  });
  const prompt = role.previewPrompt();
  assert.match(prompt, /阿棠/, '抽取 prompt 以账号人设身份展开');
  assert.match(prompt, /家常菜/, '兴趣领域来自人设');
  assert.match(prompt, /领域\/话题概念/, '抽取目标为任意领域/话题概念（话题中立）');
  assert.match(prompt, /不限技术领域/, '明示不限技术领域');
  assert.match(prompt, /不要编造/, '保留「抽不到即空、不编造」红线');
  assert.ok(!prompt.includes('技术概念'), '不得再限定只抽技术概念');
});
