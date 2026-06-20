import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TopicStrategistRole } from '../../src/publish-agent/roles/topic-strategist.js';
import { PipelineContext } from '../../src/publish-agent/pipeline-context.js';
import type { PipelineFields, CreatedContent } from '../../src/publish-agent/types.js';

const clock = () => 1700000000000;
const silentLogger = { log() {}, warn() {}, error() {} };

function created(tags: string[]): CreatedContent {
  return {
    title: 't',
    content: 'c',
    tags,
    tone: 'technical',
    style: {},
    createdAt: clock(),
  };
}

describe('TopicStrategistRole', () => {
  test('原 tags 透传 → selectedTopics 与 selectedAt', async () => {
    const role = new TopicStrategistRole({ clock, logger: silentLogger });
    const ctx = new PipelineContext<PipelineFields>();
    role.register(ctx);
    ctx.write('createdContent', created(['ai', 'rust', 'web']));
    await new Promise((r) => setTimeout(r, 30));
    const out = ctx.get('topicSelection');
    assert.deepEqual(out?.selectedTopics, ['ai', 'rust', 'web']);
    assert.equal(out?.selectedAt, 1700000000000);
  });

  test('去重（保序）', async () => {
    const role = new TopicStrategistRole({ clock, logger: silentLogger });
    const ctx = new PipelineContext<PipelineFields>();
    role.register(ctx);
    ctx.write('createdContent', created(['ai', 'rust', 'ai', 'web', 'rust']));
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(ctx.get('topicSelection')?.selectedTopics, ['ai', 'rust', 'web']);
  });

  test('>30 截断到 30', async () => {
    const role = new TopicStrategistRole({ clock, logger: silentLogger });
    const ctx = new PipelineContext<PipelineFields>();
    role.register(ctx);
    const tags = Array.from({ length: 50 }, (_, i) => `tag${i}`);
    ctx.write('createdContent', created(tags));
    await new Promise((r) => setTimeout(r, 30));
    const out = ctx.get('topicSelection');
    assert.equal(out?.selectedTopics.length, 30);
    assert.deepEqual(out?.selectedTopics, tags.slice(0, 30));
  });

  test('空 tags → [] (不编造补足)', async () => {
    const role = new TopicStrategistRole({ clock, logger: silentLogger });
    const ctx = new PipelineContext<PipelineFields>();
    role.register(ctx);
    ctx.write('createdContent', created([]));
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(ctx.get('topicSelection')?.selectedTopics, []);
  });

  test('不足 3 个也不补足（如实回报 1 个）', async () => {
    const role = new TopicStrategistRole({ clock, logger: silentLogger });
    const ctx = new PipelineContext<PipelineFields>();
    role.register(ctx);
    ctx.write('createdContent', created(['solo']));
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(ctx.get('topicSelection')?.selectedTopics, ['solo']);
  });
});
