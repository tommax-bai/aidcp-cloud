import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalGatekeeperRole } from '../../src/publish-agent/roles/approval-gatekeeper.js';
import { PipelineContext } from '../../src/publish-agent/pipeline-context.js';
import type { PipelineFields, AssembledContent } from '../../src/publish-agent/types.js';

const clock = () => 1700000000000;
const silentLogger = { log() {}, warn() {}, error() {} };

function makeAssembledContent(overrides?: Partial<AssembledContent>): AssembledContent {
  return {
    finalContent: '昨天试了 vLLM 跑 14B，显存直接爆了',
    finalTags: ['vLLM', '大模型部署'],
    imageUrl: null,
    aiScore: 0.1,
    qualityScore: 80,
    rewritten: false,
    flaggedPhrases: [],
    assembledAt: 1700000000000,
    ...overrides,
  };
}

describe('ApprovalGatekeeperRole', () => {
  test('LLM 返回 auto_publish → GateDecision 正确', async () => {
    const fakeLlm = {
      chat: async () => JSON.stringify({
        needsApproval: false,
        recommendedAction: 'auto_publish',
        reason: 'AI味极低，质量达标',
      }),
      complete: async () => '',
    };

    const role = new ApprovalGatekeeperRole({ llmClient: fakeLlm as any, clock, logger: silentLogger });
    const ctx = new PipelineContext<PipelineFields>();
    role.register(ctx);
    ctx.write('assembledContent', makeAssembledContent());

    await new Promise(r => setTimeout(r, 50));

    const decision = ctx.get('gateDecision');
    assert.ok(decision);
    assert.equal(decision.needsApproval, false);
    assert.equal(decision.recommendedAction, 'auto_publish');
    assert.match(decision.reason, /AI味|质量/);
    assert.equal(decision.decidedAt, 1700000000000);
  });

  test('LLM 返回 manual_review → GateDecision 正确', async () => {
    const fakeLlm = {
      chat: async () => JSON.stringify({
        needsApproval: true,
        recommendedAction: 'manual_review',
        reason: 'AI味偏高需人工审核',
      }),
      complete: async () => '',
    };

    const role = new ApprovalGatekeeperRole({ llmClient: fakeLlm as any, clock, logger: silentLogger });
    const ctx = new PipelineContext<PipelineFields>();
    role.register(ctx);
    ctx.write('assembledContent', makeAssembledContent({ aiScore: 0.4 }));

    await new Promise(r => setTimeout(r, 50));

    const decision = ctx.get('gateDecision');
    assert.ok(decision);
    assert.equal(decision.needsApproval, true);
    assert.equal(decision.recommendedAction, 'manual_review');
    assert.equal(decision.decidedAt, 1700000000000);
  });

  test('LLM 失败 → 硬编码规则降级（aiScore >= 0.5 → manual_review）', async () => {
    const fakeLlm = {
      chat: async () => { throw new Error('LLM down'); },
      complete: async () => '',
    };

    const role = new ApprovalGatekeeperRole({ llmClient: fakeLlm as any, clock, logger: silentLogger });
    const ctx = new PipelineContext<PipelineFields>();
    role.register(ctx);
    ctx.write('assembledContent', makeAssembledContent({ aiScore: 0.5, qualityScore: 70 }));

    // executeWithFallback retries with delays
    await new Promise(r => setTimeout(r, 2500));

    const decision = ctx.get('gateDecision');
    assert.ok(decision);
    assert.equal(decision.recommendedAction, 'manual_review');
    assert.match(decision.reason, /硬编码/);
  });

  test('LLM 失败 → 硬编码规则降级（aiScore < 0.5 且 qualityScore >= 60 → auto_publish）', async () => {
    const fakeLlm = {
      chat: async () => { throw new Error('LLM down'); },
      complete: async () => '',
    };

    const role = new ApprovalGatekeeperRole({ llmClient: fakeLlm as any, clock, logger: silentLogger });
    const ctx = new PipelineContext<PipelineFields>();
    role.register(ctx);
    ctx.write('assembledContent', makeAssembledContent({ aiScore: 0.2, qualityScore: 80 }));

    // executeWithFallback retries with delays
    await new Promise(r => setTimeout(r, 2500));

    const decision = ctx.get('gateDecision');
    assert.ok(decision);
    assert.equal(decision.recommendedAction, 'auto_publish');
    assert.match(decision.reason, /硬编码/);
  });

  test('LLM 失败 → 硬编码规则降级（aiScore > 0.6 + 多禁用词 → abort）', async () => {
    const fakeLlm = {
      chat: async () => { throw new Error('LLM down'); },
      complete: async () => '',
    };

    const role = new ApprovalGatekeeperRole({ llmClient: fakeLlm as any, clock, logger: silentLogger });
    const ctx = new PipelineContext<PipelineFields>();
    role.register(ctx);
    ctx.write('assembledContent', makeAssembledContent({
      aiScore: 0.7,
      flaggedPhrases: ['首先', '其次', '综上所述'],
    }));

    // executeWithFallback retries with delays
    await new Promise(r => setTimeout(r, 2500));

    const decision = ctx.get('gateDecision');
    assert.ok(decision);
    assert.equal(decision.recommendedAction, 'abort');
    assert.match(decision.reason, /硬编码/);
  });
});
