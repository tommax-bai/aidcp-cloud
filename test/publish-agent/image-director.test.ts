import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ImageDirectorRole } from '../../src/publish-agent/roles/image-director.js';
import { PipelineContext } from '../../src/publish-agent/pipeline-context.js';
import type { PipelineFields, CreatedContent } from '../../src/publish-agent/types.js';

const clock = () => 1700000000000;
const silentLogger = { log() {}, warn() {}, error() {} };

function makeCreatedContent(): CreatedContent {
  return {
    title: 'vLLM 部署踩坑',
    content: '昨天试了 vLLM 跑 14B，显存直接爆了，后来换了 AWQ 量化才搞定',
    tags: ['vLLM', '大模型部署'],
    tone: 'casual',
    style: { type: '踩坑记录' },
    createdAt: 1700000000000,
  };
}

describe('ImageDirectorRole', () => {
  test('enableImageGeneration=false → 立即返回空 ImageDirective', async () => {
    const fakeLlm = { chat: async () => '', complete: async () => '' };
    const fakeImageProvider = { generate: async () => ({ url: 'https://example.com/img.png' }) };

    const role = new ImageDirectorRole({
      llmClient: fakeLlm as any,
      imageProvider: fakeImageProvider,
      enableImageGeneration: false,
      clock,
      logger: silentLogger,
    });

    const ctx = new PipelineContext<PipelineFields>();
    role.register(ctx);
    ctx.write('createdContent', makeCreatedContent());

    await new Promise(r => setTimeout(r, 50));

    const directive = ctx.get('imageDirective');
    assert.ok(directive);
    assert.equal(directive.imagePrompt, null);
    assert.equal(directive.imageUrl, null);
    assert.equal(directive.imageStyle, null);
    assert.equal(directive.fallbackStrategy, 'skip');
  });

  test('mock LLM + mock ImageProvider 正常返回 → imageUrl 有值', async () => {
    const fakeLlm = {
      chat: async () => JSON.stringify({
        imagePrompt: 'minimalist flat illustration of GPU computing',
        imageStyle: 'illustration',
        fallbackStrategy: 'skip',
      }),
      complete: async () => '',
    };
    const fakeImageProvider = {
      generate: async (prompt: string, style?: string) => ({ url: 'https://example.com/generated.png', taskId: 'task-1' }),
    };

    const role = new ImageDirectorRole({
      llmClient: fakeLlm as any,
      imageProvider: fakeImageProvider,
      enableImageGeneration: true,
      clock,
      logger: silentLogger,
    });

    const ctx = new PipelineContext<PipelineFields>();
    role.register(ctx);
    ctx.write('createdContent', makeCreatedContent());

    await new Promise(r => setTimeout(r, 50));

    const directive = ctx.get('imageDirective');
    assert.ok(directive);
    assert.equal(directive.imagePrompt, 'minimalist flat illustration of GPU computing');
    assert.equal(directive.imageUrl, 'https://example.com/generated.png');
    assert.equal(directive.imageStyle, 'illustration');
    assert.equal(directive.directedAt, 1700000000000);
  });

  test('ImageProvider.generate 失败 → fallback skip，imageUrl=null', async () => {
    const fakeLlm = {
      chat: async () => JSON.stringify({
        imagePrompt: 'some prompt',
        imageStyle: 'photography',
        fallbackStrategy: 'skip',
      }),
      complete: async () => '',
    };
    const fakeImageProvider = {
      generate: async () => ({ url: null, error: 'generation failed' }),
    };

    const role = new ImageDirectorRole({
      llmClient: fakeLlm as any,
      imageProvider: fakeImageProvider,
      enableImageGeneration: true,
      clock,
      logger: silentLogger,
    });

    const ctx = new PipelineContext<PipelineFields>();
    role.register(ctx);
    ctx.write('createdContent', makeCreatedContent());

    await new Promise(r => setTimeout(r, 50));

    const directive = ctx.get('imageDirective');
    assert.ok(directive);
    assert.equal(directive.imageUrl, null);
    assert.equal(directive.fallbackStrategy, 'skip');
  });

  test('LLM 解析失败 → fallback skip（getDefaultOutput 空 directive）', async () => {
    const fakeLlm = {
      chat: async () => { throw new Error('LLM down'); },
      complete: async () => '',
    };
    const fakeImageProvider = {
      generate: async () => ({ url: 'https://example.com/img.png' }),
    };

    const role = new ImageDirectorRole({
      llmClient: fakeLlm as any,
      imageProvider: fakeImageProvider,
      enableImageGeneration: true,
      clock,
      logger: silentLogger,
    });

    const ctx = new PipelineContext<PipelineFields>();
    role.register(ctx);
    ctx.write('createdContent', makeCreatedContent());

    // executeWithFallback retries 2 times with 500ms+1000ms delay
    await new Promise(r => setTimeout(r, 2500));

    const directive = ctx.get('imageDirective');
    assert.ok(directive);
    assert.equal(directive.imageUrl, null);
    assert.equal(directive.imagePrompt, null);
  });
});
