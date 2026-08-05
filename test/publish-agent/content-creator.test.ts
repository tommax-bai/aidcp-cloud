import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ContentCreatorRole } from '../../src/publish-agent/roles/content-creator.js';
import { PipelineContext } from '../../src/publish-agent/pipeline-context.js';
import type { PipelineFields, TriggerInput, ScoutDecision } from '../../src/publish-agent/types.js';
import { BODY_LENGTH_BANDS, BODY_LENGTH_TOLERANCE } from '../../src/publish-agent/body-length-band.js';

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
    assert.match(prompt, /全文 100-350 字（Facebook 最佳阅读区间）/);
    assert.doesNotMatch(prompt, /全文 100-500 字/);
    assert.doesNotMatch(prompt, /正文约 80-600 个字符/);
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

  // —— 5.3b 正文长度确定性闸 ——
  // 在此之前区间只活在 prompt 一行文案里，云端一个字都不数；唯一数字数的 content_too_long
  // 要等到发布指令下发前才响——图已生成、人已审过。

  const XHS_BAND = BODY_LENGTH_BANDS.xiaohongshu!;
  const XHS_SLACK = Math.round((XHS_BAND.max - XHS_BAND.min) * BODY_LENGTH_TOLERANCE);

  async function runCreator(bodies: string[]) {
    const prompts: string[] = [];
    const fakeLlm = {
      chat: async (messages: Array<{ content: string }>) => {
        prompts.push(messages.map((m) => m.content).join('\n'));
        const body = bodies[Math.min(prompts.length - 1, bodies.length - 1)]!;
        return JSON.stringify({ title: '标题', content: body, tone: 'casual', style: {} });
      },
      complete: async () => '',
    };
    const role = new ContentCreatorRole({ llmClient: fakeLlm as any, clock, logger: silentLogger });
    const ctx = new PipelineContext<PipelineFields>();
    ctx.write('trigger', makeTriggerInput());
    role.register(ctx);
    ctx.write('scoutDecision', makeScoutDecision(true));
    await new Promise(r => setTimeout(r, 50));
    return { prompts, content: ctx.get('createdContent') };
  }

  test('正文合区间 → 只生成一次，绝不多烧一次模型调用', async () => {
    const { prompts, content } = await runCreator(['字'.repeat(XHS_BAND.min + 20)]);
    assert.equal(prompts.length, 1);
    assert.equal(content?.content.length, XHS_BAND.min + 20);
  });

  test('略越界（容差内）→ 采用，不重写：超几个字就重掷骰子等于给几乎每一篇多烧一次调用', async () => {
    const near = '字'.repeat(XHS_BAND.max + XHS_SLACK);
    const { prompts, content } = await runCreator([near]);
    assert.equal(prompts.length, 1, '容差内不得触发重写');
    assert.equal(content?.content, near);
  });

  test('越出容差 → 带纠正说明重写一次，且说明里必须点名实测字数与目标区间', async () => {
    const tooShort = '字'.repeat(XHS_BAND.min - XHS_SLACK - 50);
    const good = '字'.repeat(XHS_BAND.min + 20);
    const { prompts, content } = await runCreator([tooShort, good]);

    assert.equal(prompts.length, 2, '应重写一次');
    assert.ok(!prompts[0]!.includes('【重写要求】'), '首次生成不带纠正说明');
    assert.match(prompts[1]!, /【重写要求】/);
    assert.match(prompts[1]!, new RegExp(`实测 ${tooShort.length} 字`));
    assert.match(prompts[1]!, new RegExp(`${XHS_BAND.min}-${XHS_BAND.max} 字`));
    assert.equal(content?.content, good, '合区间的重写稿应被采用');
  });

  test('重写有界：第二稿仍离谱也不再重写，取偏离较小的一稿', async () => {
    const first = '字'.repeat(XHS_BAND.max + 200); // 偏离 200
    const second = '字'.repeat(XHS_BAND.max + 400); // 偏离 400
    const { prompts, content } = await runCreator([first, second]);

    assert.equal(prompts.length, 2, '重写有界：只重写一次');
    assert.equal(content?.content, first, '应保留偏离较小的那一稿');
  });

  test('两稿都离谱也 MUST NOT 截断、MUST NOT 中止管线——区间是质量目标不是物理约束', async () => {
    const long = '字'.repeat(XHS_BAND.max + 300);
    const { content } = await runCreator([long]);
    assert.ok(content, '不得因长度越界而废掉整篇稿子');
    assert.equal(content.content.length, long.length, '不得截断：截出来的是残句，还会把「模型没听话」伪装成正常');
  });
});
