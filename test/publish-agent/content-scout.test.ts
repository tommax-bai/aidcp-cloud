import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ContentScoutRole } from '../../src/publish-agent/roles/content-scout.js';
import { PipelineContext } from '../../src/publish-agent/pipeline-context.js';
import type { PipelineFields, TriggerInput } from '../../src/publish-agent/types.js';
import type { QwenChatMessage } from '../../src/llm/qwen.js';

const clock = () => 1700000000000;
const silentLogger = { log() {}, warn() {}, error() {} };

function makeTriggerInput(): TriggerInput {
  return {
    metrics: { hoursSinceLastPublish: 30, newConceptCount: 3, likedSinceLastPublish: 20 },
    generateInput: {
      concepts: [{ keyword: 'RAG 重排' }, { keyword: 'vLLM 量化' }, { keyword: 'KV cache' }],
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
  };
}

describe('ContentScoutRole', () => {
  test('mock LLM 返回有效 JSON → 正确解析 ScoutDecision', async () => {
    let capturedMessages: QwenChatMessage[] = [];
    const fakeLlm = {
      chat: async (messages: QwenChatMessage[]) => {
        capturedMessages = messages;
        return JSON.stringify({
          shouldPublish: true,
          publishDirection: 'RAG 检索优化',
          keyPoints: ['向量切块', '重叠窗口'],
          confidence: 0.85,
          reason: '素材充足',
        });
      },
      complete: async (prompt: string) => '',
    };

    const role = new ContentScoutRole({ llmClient: fakeLlm as any, clock, logger: silentLogger });
    const ctx = new PipelineContext<PipelineFields>();
    role.register(ctx);
    ctx.write('trigger', makeTriggerInput());

    // 等待异步执行完成
    await new Promise(r => setTimeout(r, 50));

    const decision = ctx.get('scoutDecision');
    assert.ok(decision);
    assert.equal(decision.shouldPublish, true);
    assert.equal(decision.publishDirection, 'RAG 检索优化');
    assert.deepEqual(decision.keyPoints, ['向量切块', '重叠窗口']);
    assert.equal(decision.confidence, 0.85);
    assert.equal(decision.scoutedAt, 1700000000000);
  });

  test('mock LLM 返回 shouldPublish=false → decision 反映', async () => {
    const fakeLlm = {
      chat: async () => JSON.stringify({
        shouldPublish: false,
        publishDirection: 'none',
        keyPoints: [],
        confidence: 0.3,
        reason: '素材不足',
      }),
      complete: async () => '',
    };

    const role = new ContentScoutRole({ llmClient: fakeLlm as any, clock, logger: silentLogger });
    const ctx = new PipelineContext<PipelineFields>();
    role.register(ctx);
    ctx.write('trigger', makeTriggerInput());

    await new Promise(r => setTimeout(r, 50));

    const decision = ctx.get('scoutDecision');
    assert.ok(decision);
    assert.equal(decision.shouldPublish, false);
    assert.equal(decision.reason, '素材不足');
  });

  test('mock LLM 抛错 → 走 fallback，返回 shouldPublish=false', async () => {
    const fakeLlm = {
      chat: async () => { throw new Error('network error'); },
      complete: async () => '',
    };

    const role = new ContentScoutRole({ llmClient: fakeLlm as any, clock, logger: silentLogger });
    const ctx = new PipelineContext<PipelineFields>();
    role.register(ctx);
    ctx.write('trigger', makeTriggerInput());

    // executeWithFallback retries 2 times with 500ms+1000ms delay
    await new Promise(r => setTimeout(r, 2500));

    const decision = ctx.get('scoutDecision');
    assert.ok(decision);
    assert.equal(decision.shouldPublish, false);
    assert.equal(decision.publishDirection, 'fallback');
  });

  test('验证调用了 buildScoutPrompt（LLM 收到 user message 含度量信息）', async () => {
    let capturedMessages: QwenChatMessage[] = [];
    const fakeLlm = {
      chat: async (messages: QwenChatMessage[]) => {
        capturedMessages = messages;
        return JSON.stringify({ shouldPublish: true, publishDirection: 'test', keyPoints: [], confidence: 0.5, reason: 'ok' });
      },
      complete: async () => '',
    };

    const role = new ContentScoutRole({ llmClient: fakeLlm as any, clock, logger: silentLogger });
    const ctx = new PipelineContext<PipelineFields>();
    role.register(ctx);
    ctx.write('trigger', makeTriggerInput());

    await new Promise(r => setTimeout(r, 50));

    assert.equal(capturedMessages.length, 2);
    assert.equal(capturedMessages[0].role, 'system');
    assert.equal(capturedMessages[1].role, 'user');
    // buildScoutPrompt 应包含度量数据关键信息
    assert.match(capturedMessages[1].content, /新概念|新积累/);
    assert.match(capturedMessages[1].content, /RAG 重排/);
  });
});
