import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ContentAssemblerRole } from '../../src/publish-agent/roles/content-assembler.js';
import { PipelineContext } from '../../src/publish-agent/pipeline-context.js';
import type { PipelineFields, CreatedContent, ImageDirective } from '../../src/publish-agent/types.js';

const clock = () => 1700000000000;
const silentLogger = { log() {}, warn() {}, error() {} };

function makeCreatedContent(): CreatedContent {
  return {
    title: 'vLLM 部署踩坑',
    content: '昨天试了 vLLM 跑 14B，显存直接爆了',
    tags: ['vLLM', '大模型部署'],
    tone: 'casual',
    style: { type: '踩坑记录' },
    createdAt: 1700000000000,
  };
}

function makeImageDirective(withUrl = false): ImageDirective {
  return {
    imagePrompt: withUrl ? 'some prompt' : null,
    imageUrl: withUrl ? 'https://example.com/img.png' : null,
    imageStyle: withUrl ? 'illustration' : null,
    fallbackStrategy: 'skip',
    directedAt: 1700000000000,
  };
}

describe('ContentAssemblerRole', () => {
  test('watchAll 等待 createdContent 和 imageDirective 都就绪', async () => {
    const fakeLlm = {
      chat: async () => JSON.stringify({ qualityScore: 80 }),
      complete: async () => '',
    };
    const fakePostProcessor = {
      process: async (content: string) => ({
        content,
        aiScore: 0.1,
        rewritten: false,
        flaggedPhrases: [],
      }),
    };

    const role = new ContentAssemblerRole({
      llmClient: fakeLlm as any,
      postProcessor: fakePostProcessor,
      clock,
      logger: silentLogger,
    });

    const ctx = new PipelineContext<PipelineFields>();
    role.register(ctx);

    // 只写入一个字段，不应触发
    ctx.write('createdContent', makeCreatedContent());
    await new Promise(r => setTimeout(r, 50));
    assert.equal(ctx.get('assembledContent'), undefined);

    // 写入第二个字段后触发
    ctx.write('imageDirective', makeImageDirective());
    await new Promise(r => setTimeout(r, 50));
    assert.ok(ctx.get('assembledContent'));
  });

  test('mock PostProcessor + mock LLM → 正确组装 AssembledContent', async () => {
    const fakeLlm = {
      chat: async () => JSON.stringify({ qualityScore: 85, issues: [], suggestions: [] }),
      complete: async () => '',
    };
    const fakePostProcessor = {
      process: async (content: string) => ({
        content: content + '(processed)',
        aiScore: 0.15,
        rewritten: true,
        flaggedPhrases: ['首先'],
      }),
    };

    const role = new ContentAssemblerRole({
      llmClient: fakeLlm as any,
      postProcessor: fakePostProcessor,
      clock,
      logger: silentLogger,
    });

    const ctx = new PipelineContext<PipelineFields>();
    role.register(ctx);
    ctx.write('createdContent', makeCreatedContent());
    ctx.write('imageDirective', makeImageDirective(true));

    await new Promise(r => setTimeout(r, 50));

    const assembled = ctx.get('assembledContent');
    assert.ok(assembled);
    assert.match(assembled.finalContent, /processed/);
    assert.deepEqual(assembled.finalTags, ['vLLM', '大模型部署']);
    assert.equal(assembled.imageUrl, 'https://example.com/img.png');
    assert.equal(assembled.aiScore, 0.15);
    assert.equal(assembled.qualityScore, 85);
    assert.equal(assembled.rewritten, true);
    assert.deepEqual(assembled.flaggedPhrases, ['首先']);
    assert.equal(assembled.assembledAt, 1700000000000);
  });

  test('LLM 评审失败 → 降级用 postProcessor 的 aiScore 计算 qualityScore', async () => {
    const fakeLlm = {
      chat: async () => { throw new Error('LLM down'); },
      complete: async () => '',
    };
    const fakePostProcessor = {
      process: async (content: string) => ({
        content,
        aiScore: 0.3,
        rewritten: false,
        flaggedPhrases: [],
      }),
    };

    const role = new ContentAssemblerRole({
      llmClient: fakeLlm as any,
      postProcessor: fakePostProcessor,
      clock,
      logger: silentLogger,
    });

    const ctx = new PipelineContext<PipelineFields>();
    role.register(ctx);
    ctx.write('createdContent', makeCreatedContent());
    ctx.write('imageDirective', makeImageDirective());

    // executeWithFallback retries 2 times with 500ms+1000ms delay
    await new Promise(r => setTimeout(r, 2500));

    const assembled = ctx.get('assembledContent');
    assert.ok(assembled);
    // 降级公式: Math.round((1 - aiScore) * 70) = Math.round(0.7 * 70) = 49
    assert.equal(assembled.qualityScore, 49);
    assert.equal(assembled.aiScore, 0.3);
  });
});
