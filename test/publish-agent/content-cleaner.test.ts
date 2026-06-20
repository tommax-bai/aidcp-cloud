import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ContentCleanerRole } from '../../src/publish-agent/roles/content-cleaner.js';
import { PipelineContext } from '../../src/publish-agent/pipeline-context.js';
import type { PipelineFields, CreatedContent } from '../../src/publish-agent/types.js';

const clock = () => 1700000000000;
const silentLogger = { log() {}, warn() {}, error() {} };
const created: CreatedContent = { title: 'T', content: '原始正文', tags: ['a'], tone: 'casual', style: {}, createdAt: clock() };

function run(postProcessor: any, waitMs = 50) {
  const role = new ContentCleanerRole({ postProcessor, clock, logger: silentLogger });
  const ctx = new PipelineContext<PipelineFields>();
  role.register(ctx);
  ctx.write('createdContent', created);
  return new Promise<NonNullable<PipelineFields['cleanedContent']>>((resolve) =>
    setTimeout(() => resolve(ctx.get('cleanedContent')!), waitMs),
  );
}

describe('ContentCleanerRole', () => {
  test('清洗成功 → cleanedContent 带 aiScore/rewritten/flaggedPhrases', async () => {
    const pp = { process: async (c: string) => ({ content: c + '(cleaned)', aiScore: 0.2, rewritten: true, flaggedPhrases: ['首先'] }) };
    const cleaned = await run(pp);
    assert.equal(cleaned.content, '原始正文(cleaned)');
    assert.equal(cleaned.aiScore, 0.2);
    assert.equal(cleaned.rewritten, true);
    assert.deepEqual(cleaned.flaggedPhrases, ['首先']);
  });

  test('process 抛错 → 降级退回原文、键必写（不死锁）', async () => {
    const pp = { process: async () => { throw new Error('pp down'); } };
    const cleaned = await run(pp, 2600); // executeWithFallback 重试
    assert.ok(cleaned, 'cleanedContent 键必须被写（防 waitAll 死锁）');
    assert.equal(cleaned.content, '原始正文');
    assert.equal(cleaned.rewritten, false);
  });
});
