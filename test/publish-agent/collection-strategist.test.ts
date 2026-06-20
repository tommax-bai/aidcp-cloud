import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CollectionStrategistRole } from '../../src/publish-agent/roles/collection-strategist.js';
import { PipelineContext } from '../../src/publish-agent/pipeline-context.js';
import type { PipelineFields, CreatedContent } from '../../src/publish-agent/types.js';

const clock = () => 1700000000000;
const silentLogger = { log() {}, warn() {}, error() {} };

function created(): CreatedContent {
  return {
    title: 't',
    content: 'c',
    tags: ['a', 'b'],
    tone: 'technical',
    style: {},
    createdAt: clock(),
  };
}

describe('CollectionStrategistRole', () => {
  test('createdContent 写入 → 本阶段无合集源，恒回 null（不编造）', async () => {
    const role = new CollectionStrategistRole({ clock, logger: silentLogger });
    const ctx = new PipelineContext<PipelineFields>();
    role.register(ctx);
    ctx.write('createdContent', created());
    await new Promise((r) => setTimeout(r, 30));
    const out = ctx.get('collectionSelection');
    assert.equal(out?.selectedCollection, null);
    assert.equal(out?.selectedAt, clock());
  });
});
