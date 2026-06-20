import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { QualityScorerRole } from '../../src/publish-agent/roles/quality-scorer.js';
import { PipelineContext } from '../../src/publish-agent/pipeline-context.js';
import type { PipelineFields, CreatedContent } from '../../src/publish-agent/types.js';

const clock = () => 1700000000000;
const silentLogger = { log() {}, warn() {}, error() {} };
const created: CreatedContent = { title: 'T', content: '正文', tags: ['a'], tone: 'casual', style: {}, createdAt: clock() };

function run(llm: any, aiScore: number, waitMs = 50) {
  const role = new QualityScorerRole({ llmClient: llm, clock, logger: silentLogger });
  const ctx = new PipelineContext<PipelineFields>();
  role.register(ctx);
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
});
