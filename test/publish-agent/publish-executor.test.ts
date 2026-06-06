import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PublishExecutorRole } from '../../src/publish-agent/roles/publish-executor.js';
import { PipelineContext } from '../../src/publish-agent/pipeline-context.js';
import type { PipelineFields, AssembledContent, GateDecision } from '../../src/publish-agent/types.js';

const clock = () => 1700000000000;
const silentLogger = { log() {}, warn() {}, error() {} };

function makeAssembledContent(): AssembledContent {
  return {
    finalContent: '昨天试了 vLLM 跑 14B，显存直接爆了',
    finalTags: ['vLLM', '大模型部署'],
    imageUrl: 'https://example.com/img.png',
    aiScore: 0.1,
    qualityScore: 80,
    rewritten: false,
    flaggedPhrases: [],
    assembledAt: 1700000000000,
  };
}

function makeGateDecision(action: GateDecision['recommendedAction']): GateDecision {
  return {
    needsApproval: action === 'manual_review',
    recommendedAction: action,
    reason: 'test reason',
    decidedAt: 1700000000000,
  };
}

describe('PublishExecutorRole', () => {
  test('auto_publish → 调用 store.insert + pusher.pushToEdges', async () => {
    const insertedRecords: any[] = [];
    const pushedEnvelopes: any[] = [];
    const fakeStore = {
      insert: async (record: any) => { insertedRecords.push(record); return 42; },
    };
    const fakePusher = {
      pushToEdges: (envelope: any, edgeId?: string) => { pushedEnvelopes.push({ envelope, edgeId }); return 1; },
    };

    const role = new PublishExecutorRole({
      store: fakeStore,
      pusher: fakePusher,
      idGen: () => 'test-env-001',
      clock,
      logger: silentLogger,
    });

    const ctx = new PipelineContext<PipelineFields>();
    ctx.write('assembledContent', makeAssembledContent());
    role.register(ctx);
    ctx.write('gateDecision', makeGateDecision('auto_publish'));

    await new Promise(r => setTimeout(r, 50));

    const result = ctx.get('publishResult');
    assert.ok(result);
    assert.equal(result.recordId, 42);
    assert.equal(result.status, 'draft');
    assert.equal(result.dispatched, true);
    assert.ok(result.envelope);

    // 验证 store.insert 参数
    assert.equal(insertedRecords.length, 1);
    assert.equal(insertedRecords[0].status, 'draft');
    assert.match(insertedRecords[0].content, /vLLM/);

    // 验证 pusher 被调用
    assert.equal(pushedEnvelopes.length, 1);
    assert.equal(pushedEnvelopes[0].envelope.type, 'publish.request');
    assert.equal(pushedEnvelopes[0].envelope.id, 'test-env-001');
  });

  test('manual_review → 调用 store.insert + messenger.sendApprovalCard', async () => {
    const insertedRecords: any[] = [];
    const sentCards: any[] = [];
    const fakeStore = {
      insert: async (record: any) => { insertedRecords.push(record); return 99; },
    };
    const fakePusher = {
      pushToEdges: () => 0,
    };
    const fakeMessenger = {
      sendApprovalCard: async (chatId: string, card: any) => { sentCards.push({ chatId, card }); },
    };
    const fakeBotChatStore = {
      getDefaultChat: async () => ({ chatId: 'chat-123' }),
    };

    const role = new PublishExecutorRole({
      store: fakeStore,
      pusher: fakePusher,
      messenger: fakeMessenger,
      botChatStore: fakeBotChatStore,
      idGen: () => 'test-env-002',
      clock,
      logger: silentLogger,
    });

    const ctx = new PipelineContext<PipelineFields>();
    ctx.write('assembledContent', makeAssembledContent());
    role.register(ctx);
    ctx.write('gateDecision', makeGateDecision('manual_review'));

    await new Promise(r => setTimeout(r, 50));

    const result = ctx.get('publishResult');
    assert.ok(result);
    assert.equal(result.recordId, 99);
    assert.equal(result.status, 'needs_review');
    assert.equal(result.dispatched, false);
    assert.equal(result.envelope, null);

    // 验证 store.insert 参数
    assert.equal(insertedRecords.length, 1);
    assert.equal(insertedRecords[0].status, 'needs_review');

    // 验证 messenger 被调用
    assert.equal(sentCards.length, 1);
    assert.equal(sentCards[0].chatId, 'chat-123');
    assert.equal(sentCards[0].card.recordId, 99);
  });

  test('abort → 调用 store.insert(status=failed)', async () => {
    const insertedRecords: any[] = [];
    const fakeStore = {
      insert: async (record: any) => { insertedRecords.push(record); return 77; },
    };
    const fakePusher = {
      pushToEdges: () => 0,
    };

    const role = new PublishExecutorRole({
      store: fakeStore,
      pusher: fakePusher,
      idGen: () => 'test-env-003',
      clock,
      logger: silentLogger,
    });

    const ctx = new PipelineContext<PipelineFields>();
    ctx.write('assembledContent', makeAssembledContent());
    role.register(ctx);
    ctx.write('gateDecision', makeGateDecision('abort'));

    await new Promise(r => setTimeout(r, 50));

    const result = ctx.get('publishResult');
    assert.ok(result);
    assert.equal(result.recordId, 77);
    assert.equal(result.status, 'failed');
    assert.equal(result.dispatched, false);
    assert.equal(result.envelope, null);

    // 验证 store.insert 参数
    assert.equal(insertedRecords.length, 1);
    assert.equal(insertedRecords[0].status, 'failed');
  });
});
