import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ComplianceDeciderRole,
  AI_FLAVOR_THRESHOLD,
} from '../../src/publish-agent/roles/compliance-decider.js';
import { PipelineContext } from '../../src/publish-agent/pipeline-context.js';
import type { PipelineFields, AssembledContent } from '../../src/publish-agent/types.js';

const clock = () => 1700000000000;
const silentLogger = { log() {}, warn() {}, error() {} };

function assembled(over: Partial<AssembledContent>): AssembledContent {
  return {
    finalContent: '正文',
    finalTags: [],
    imageUrls: [],
    imageUrl: null,
    aiScore: 0,
    qualityScore: 0,
    qualityStatus: 'scored',
    rewritten: false,
    flaggedPhrases: [],
    assembledAt: clock(),
    ...over,
  };
}

describe('ComplianceDeciderRole', () => {
  test('aiScore=0.7（超阈）→ ai=true + aiEnforced=true', async () => {
    const role = new ComplianceDeciderRole({ clock, logger: silentLogger });
    const ctx = new PipelineContext<PipelineFields>();
    role.register(ctx);
    ctx.write('assembledContent', assembled({ aiScore: 0.7, finalContent: '一段普通正文' }));
    await new Promise((r) => setTimeout(r, 30));
    const out = ctx.get('complianceDecision');
    assert.equal(out?.compliance.ai, true);
    assert.equal(out?.compliance.aiEnforced, true);
  });

  test('aiScore=0.2 但 finalContent 含 "本文由 AI 生成" → ai=true + aiEnforced=true（关键词强制）', async () => {
    const role = new ComplianceDeciderRole({ clock, logger: silentLogger });
    const ctx = new PipelineContext<PipelineFields>();
    role.register(ctx);
    ctx.write('assembledContent', assembled({ aiScore: 0.2, finalContent: '本文由 AI 生成，仅供参考' }));
    await new Promise((r) => setTimeout(r, 30));
    const out = ctx.get('complianceDecision');
    assert.equal(out?.compliance.ai, true);
    assert.equal(out?.compliance.aiEnforced, true);
  });

  test('aiScore=0.2 无关键词 → 不强制（ai 非 true、aiEnforced 缺省）', async () => {
    const role = new ComplianceDeciderRole({ clock, logger: silentLogger });
    const ctx = new PipelineContext<PipelineFields>();
    role.register(ctx);
    ctx.write('assembledContent', assembled({ aiScore: 0.2, finalContent: '一段普通正文，没有声明' }));
    await new Promise((r) => setTimeout(r, 30));
    const out = ctx.get('complianceDecision');
    assert.notEqual(out?.compliance.ai, true);
    assert.equal(out?.compliance.aiEnforced, undefined);
  });

  test('aiScore 恰等于阈值 0.6 → 不强制（严格大于才触发）', async () => {
    const role = new ComplianceDeciderRole({ clock, logger: silentLogger });
    const ctx = new PipelineContext<PipelineFields>();
    role.register(ctx);
    ctx.write('assembledContent', assembled({ aiScore: AI_FLAVOR_THRESHOLD, finalContent: '一段普通正文' }));
    await new Promise((r) => setTimeout(r, 30));
    const out = ctx.get('complianceDecision');
    assert.notEqual(out?.compliance.ai, true);
  });

  test('AIGC 关键词命中 → 强制', async () => {
    const role = new ComplianceDeciderRole({ clock, logger: silentLogger });
    const ctx = new PipelineContext<PipelineFields>();
    role.register(ctx);
    ctx.write('assembledContent', assembled({ aiScore: 0, finalContent: '配图为 AIGC 出品' }));
    await new Promise((r) => setTimeout(r, 30));
    const out = ctx.get('complianceDecision');
    assert.equal(out?.compliance.ai, true);
    assert.equal(out?.compliance.aiEnforced, true);
  });

  test('AI_FLAVOR_THRESHOLD 导出为模块常量且为 0.6', () => {
    assert.equal(AI_FLAVOR_THRESHOLD, 0.6);
  });
});
