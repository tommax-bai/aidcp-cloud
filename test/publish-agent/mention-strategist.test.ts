import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MentionStrategistRole } from '../../src/publish-agent/roles/mention-strategist.js';
import { PipelineContext } from '../../src/publish-agent/pipeline-context.js';
import type { PipelineFields, CreatedContent } from '../../src/publish-agent/types.js';

const clock = () => 1700000000000;
const silentLogger = { log() {}, warn() {}, error() {} };

function content(overrides: Partial<CreatedContent> = {}): CreatedContent {
  return {
    title: 'T',
    content: '正文里随手提到 @某人 @another 但并非真实可 @ 句柄',
    tags: ['a', 'b'],
    tone: 'casual',
    style: {},
    createdAt: clock(),
    ...overrides,
  };
}

describe('MentionStrategistRole', () => {
  test('恒回 [] — 本阶段无 @ 数据源，不伪造句柄', async () => {
    const role = new MentionStrategistRole({ clock, logger: silentLogger });
    const ctx = new PipelineContext<PipelineFields>();
    role.register(ctx);
    ctx.write('createdContent', content());
    await new Promise((r) => setTimeout(r, 30));
    const out = ctx.get('mentionSelection');
    assert.deepEqual(out?.selectedMentions, []);
    assert.equal(out?.selectedAt, clock());
  });

  test('正文含疑似 @ 文本也不抽取 — 不编造可 @ 对象', async () => {
    const role = new MentionStrategistRole({ clock, logger: silentLogger });
    const ctx = new PipelineContext<PipelineFields>();
    role.register(ctx);
    ctx.write('createdContent', content({ content: '@张三 @李四 @everyone' }));
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(ctx.get('mentionSelection')?.selectedMentions, []);
  });

  test('getDefaultOutput 返回保守默认（空提及）', () => {
    const role = new MentionStrategistRole({ clock, logger: silentLogger });
    const def = (role as unknown as { getDefaultOutput(): { selectedMentions: string[]; selectedAt: number } }).getDefaultOutput();
    assert.deepEqual(def.selectedMentions, []);
    assert.equal(def.selectedAt, clock());
  });
});
