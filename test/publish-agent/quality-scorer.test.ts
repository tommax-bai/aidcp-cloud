import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { QualityScorerRole } from '../../src/publish-agent/roles/quality-scorer.js';
import { PipelineContext } from '../../src/publish-agent/pipeline-context.js';
import type { PipelineFields, CreatedContent } from '../../src/publish-agent/types.js';

const clock = () => 1700000000000;
const silentLogger = { log() {}, warn() {}, error() {} };
const created: CreatedContent = { title: 'T', content: '正文', tags: ['a'], tone: 'casual', style: {}, createdAt: clock() };

function run(llm: any, aiScore: number, waitMs = 50, platform: 'xiaohongshu' | 'facebook' = 'xiaohongshu') {
  const role = new QualityScorerRole({ llmClient: llm, clock, logger: silentLogger });
  const ctx = new PipelineContext<PipelineFields>();
  role.register(ctx);
  ctx.write('trigger', {
    platform,
    generateInput: { soul: null },
  } as any);
  ctx.write('createdContent', created);
  ctx.write('cleanedContent', { content: 'c', rewritten: false, flaggedPhrases: [], aiScore, cleanedAt: clock() });
  return new Promise<NonNullable<PipelineFields['qualityReport']>>((resolve) =>
    setTimeout(() => resolve(ctx.get('qualityReport')!), waitMs),
  );
}

describe('QualityScorerRole', () => {
  test('评审成功 → qualityScore 来自 LLM', async () => {
    const llm = { chat: async () => JSON.stringify({ qualityScore: 88 }), complete: async () => '' };
    const r = await run(llm, 0.1);
    assert.equal(r.qualityScore, 88);
    assert.equal(r.status, 'scored');
  });

  test('评审失败 → 按 aiScore 公式降级（分数随 aiScore 变化，绝不硬编码满分）', async () => {
    const llm = { chat: async () => { throw new Error('LLM down'); }, complete: async () => '' };
    // 公式 round((1-aiScore)*70)：aiScore=0.3 → 49
    const r = await run(llm, 0.3, 2600);
    assert.equal(r.qualityScore, 49);
    // 不同 aiScore 得不同分，证明非硬编码
    const r2 = await run(llm, 0.0, 2600);
    assert.equal(r2.qualityScore, 70);
  });

  test('Facebook → 不调用质量评分 LLM，显式产出 not_applicable', async () => {
    let calls = 0;
    const llm = {
      chat: async () => {
        calls += 1;
        throw new Error('Facebook must not call quality scorer');
      },
      complete: async () => '',
    };
    const r = await run(llm, 0.2, 50, 'facebook');
    assert.equal(calls, 0);
    assert.equal(r.qualityScore, null);
    assert.equal(r.status, 'not_applicable');
  });
});

// ─── change llm-role-review-remediation:评审对象必须是将发布文本 ─────────────
describe('QualityScorerRole — 评审清洗稿', () => {
  test('rewritten=true 时 prompt 嵌入清洗稿、不再嵌入草稿正文', async () => {
    let prompt = '';
    const llm = {
      chat: async (msgs: { role: string; content: string }[]) => {
        prompt = msgs[1].content;
        return JSON.stringify({ qualityScore: 80 });
      },
      complete: async () => '',
    };
    const role = new QualityScorerRole({ llmClient: llm as any, clock, logger: silentLogger });
    const ctx = new PipelineContext<PipelineFields>();
    role.register(ctx);
    ctx.write('trigger', { platform: 'xiaohongshu', generateInput: { soul: null } } as any);
    ctx.write('createdContent', { ...created, content: '重写前草稿DRAFT' });
    ctx.write('cleanedContent', { content: '重写后清洗稿CLEAN', rewritten: true, flaggedPhrases: ['首先'], aiScore: 0.4, cleanedAt: clock() });
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(ctx.get('qualityReport'), '评审应正常产出');
    assert.ok(prompt.includes('重写后清洗稿CLEAN'), '评审 prompt 必须嵌入清洗稿（将发布文本）');
    assert.ok(!prompt.includes('重写前草稿DRAFT'), '评审 prompt 不得再嵌入重写前草稿');
  });
});
