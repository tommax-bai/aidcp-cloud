import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ContentCreatorRole } from '../../src/publish-agent/roles/content-creator.js';
import { PipelineContext } from '../../src/publish-agent/pipeline-context.js';
import type { PipelineFields, TriggerInput, ScoutDecision } from '../../src/publish-agent/types.js';

const clock = () => 1700000000000;
const silentLogger = { log() {}, warn() {}, error() {} };

function makeTriggerInput(
  platform: TriggerInput['platform'] = 'xiaohongshu',
  writingLanguage: 'zh-CN' | 'en' | 'vi' = 'en',
): TriggerInput {
  const trigger: TriggerInput = {
    metrics: { hoursSinceLastPublish: 30, newConceptCount: 3, likedSinceLastPublish: 20 },
    generateInput: {
      concepts: [{ keyword: 'RAG 重排' }, { keyword: 'vLLM 量化' }],
      likedContents: [{ id: 1, title: 'RAG 实战', summary: '分块很关键', author: '老王' }],
      soul: {
        identity: { name: '小林', role: 'AI研发', background: '3年', tone: '理性' },
        interests: { primary: ['LLM'], secondary: [], seed_keywords: ['RAG'] },
        engagement_rules: { like: [], skip: [], comment_trigger: [] },
        browse_patterns: {
          mode: 'state_machine',
          states: { browse: { action: 'x', transitions: [] } },
          session: { max_duration_min: 10, max_likes: 8, max_searches: 3, cooldown_between_actions_sec: [3, 8] },
        },
      },
      recentPosts: [],
    },
    recentPublished: [],
    platform,
  };
  if (platform === 'facebook') trigger.generateInput.soul.writing_language = writingLanguage;
  return trigger;
}

function makeScoutDecision(shouldPublish: boolean): ScoutDecision {
  return {
    shouldPublish,
    publishDirection: 'RAG 检索优化',
    keyPoints: ['向量切块', '召回率'],
    confidence: 0.8,
    reason: '素材充足',
    scoutedAt: 1700000000000,
  };
}

describe('ContentCreatorRole', () => {
  test('shouldActivate 守卫：scoutDecision.shouldPublish=false 时不激活', async () => {
    const fakeLlm = { chat: async () => '{}', complete: async () => '' };
    const role = new ContentCreatorRole({ llmClient: fakeLlm as any, clock, logger: silentLogger });
    const ctx = new PipelineContext<PipelineFields>();
    ctx.write('trigger', makeTriggerInput());
    role.register(ctx);
    ctx.write('scoutDecision', makeScoutDecision(false));

    await new Promise(r => setTimeout(r, 50));

    // 不应写入 createdContent
    assert.equal(ctx.get('createdContent'), undefined);
  });

  test('mock LLM 返回有效文案 → 正确解析 CreatedContent', async () => {
    const fakeLlm = {
      chat: async () => JSON.stringify({
        title: 'vLLM 部署踩坑',
        content: '昨天试了 vLLM 跑 14B，显存直接爆了',
        tags: ['vLLM', '大模型部署'],
        tone: 'casual',
        style: { type: '踩坑记录' },
      }),
      complete: async () => '',
    };

    const role = new ContentCreatorRole({ llmClient: fakeLlm as any, clock, logger: silentLogger });
    const ctx = new PipelineContext<PipelineFields>();
    ctx.write('trigger', makeTriggerInput());
    role.register(ctx);
    ctx.write('scoutDecision', makeScoutDecision(true));

    await new Promise(r => setTimeout(r, 50));

    const content = ctx.get('createdContent');
    assert.ok(content);
    assert.equal(content.title, 'vLLM 部署踩坑');
    assert.match(content.content, /vLLM/);
    // change split-topic-roles：正文角色不再产标签（即便 LLM 吐了 tags 也丢弃）；话题由 TopicGenerator/TopicEvaluator 另生成。
    assert.deepEqual(content.tags, []);
    assert.equal(content.tone, 'casual');
    assert.equal(content.createdAt, 1700000000000);
  });

  test('超长标题被截断至 20 字（小红书硬上限，超限「发布」会静默失效）', async () => {
    const longTitle = '别迷信 vLLM 开箱即用，默认参数在生产环境简直是灾难'; // 30 字
    const fakeLlm = {
      chat: async () => JSON.stringify({
        title: longTitle,
        content: '正文内容',
        tags: ['vLLM'],
        tone: 'casual',
        style: { type: '踩坑记录' },
      }),
      complete: async () => '',
    };
    const role = new ContentCreatorRole({ llmClient: fakeLlm as any, clock, logger: silentLogger });
    const ctx = new PipelineContext<PipelineFields>();
    ctx.write('trigger', makeTriggerInput());
    role.register(ctx);
    ctx.write('scoutDecision', makeScoutDecision(true));

    await new Promise(r => setTimeout(r, 50));

    const content = ctx.get('createdContent');
    assert.ok(content);
    assert.ok(content.title.length <= 20, `标题应≤20字，实际 ${content.title.length}`);
    assert.equal(content.title, longTitle.slice(0, 20));
  });

  test('Facebook 从初稿阶段按账号发言语言创作，不复用小红书模板', async () => {
    let prompt = '';
    const fakeLlm = {
      chat: async (messages: Array<{ content: string }>) => {
        prompt = messages.map((item) => item.content).join('\n');
        return JSON.stringify({
          title: 'RAG lessons',
          content: 'I changed the chunking strategy and the retrieval results became much more reliable.',
          tone: 'casual',
          style: { type: 'post' },
        });
      },
      complete: async () => '',
    };
    const role = new ContentCreatorRole({ llmClient: fakeLlm as any, clock, logger: silentLogger });
    const ctx = new PipelineContext<PipelineFields>();
    ctx.write('trigger', makeTriggerInput('facebook'));
    role.register(ctx);
    ctx.write('scoutDecision', makeScoutDecision(true));
    await new Promise(r => setTimeout(r, 50));

    assert.match(ctx.get('createdContent')?.content ?? '', /retrieval results/);
    assert.match(prompt, /最终公开正文必须只使用英文自然表达/);
    assert.match(prompt, /Facebook 帖子创作者/);
    assert.doesNotMatch(prompt, /你在写一篇要发到小红书的笔记/);
  });

  test('Facebook 初稿语言与账号配置不符时 fail closed', async () => {
    const fakeLlm = {
      chat: async () => JSON.stringify({ title: '错误语言', content: '这是一段不该进入候审的中文正文。', tone: 'casual', style: {} }),
      complete: async () => '',
    };
    const role = new ContentCreatorRole({ llmClient: fakeLlm as any, clock, logger: silentLogger });
    const ctx = new PipelineContext<PipelineFields>();
    ctx.write('trigger', makeTriggerInput('facebook'));
    role.register(ctx);
    ctx.write('scoutDecision', makeScoutDecision(true));
    await new Promise(r => setTimeout(r, 50));
    assert.equal(ctx.get('createdContent'), undefined);
  });

  test('Facebook 中文与越南语账号都从初稿直接使用配置语言', async () => {
    const cases = [
      { language: 'zh-CN' as const, content: '这是一段从初稿开始自然写成的中文内容。' },
      { language: 'vi' as const, content: 'Cảm ơn bạn, đây là một bài viết rất hữu ích.' },
    ];
    for (const item of cases) {
      const fakeLlm = {
        chat: async () => JSON.stringify({ title: 'summary', content: item.content, tone: 'casual', style: {} }),
        complete: async () => '',
      };
      const role = new ContentCreatorRole({ llmClient: fakeLlm as any, clock, logger: silentLogger });
      const ctx = new PipelineContext<PipelineFields>();
      ctx.write('trigger', makeTriggerInput('facebook', item.language));
      role.register(ctx);
      ctx.write('scoutDecision', makeScoutDecision(true));
      await new Promise(r => setTimeout(r, 50));
      assert.equal(ctx.get('createdContent')?.content, item.content);
    }
  });

  test('LLM 失败（retry 2次后）→ abort（不写入 createdContent）', async () => {
    let callCount = 0;
    const fakeLlm = {
      chat: async () => { callCount++; throw new Error('LLM unavailable'); },
      complete: async () => '',
    };

    const role = new ContentCreatorRole({ llmClient: fakeLlm as any, clock, logger: silentLogger });
    const ctx = new PipelineContext<PipelineFields>();
    ctx.write('trigger', makeTriggerInput());
    role.register(ctx);
    ctx.write('scoutDecision', makeScoutDecision(true));

    await new Promise(r => setTimeout(r, 2000));

    // ContentCreator fallback='abort'，不写入 output
    assert.equal(ctx.get('createdContent'), undefined);
    // 应该重试 3 次（初始1次 + retry 2次）
    assert.equal(callCount, 3);
  });
});
