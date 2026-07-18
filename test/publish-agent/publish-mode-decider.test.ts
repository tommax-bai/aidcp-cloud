import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  PublishModeDeciderRole,
  clampScheduledTime,
} from '../../src/publish-agent/roles/publish-mode-decider.js';
import { PipelineContext } from '../../src/publish-agent/pipeline-context.js';
import type { PipelineFields, CreatedContent } from '../../src/publish-agent/types.js';

const clock = () => 1700000000000;
const silentLogger = { log() {}, warn() {}, error() {} };

function created(): CreatedContent {
  return {
    title: 't',
    content: 'c',
    tags: ['a'],
    tone: 'technical',
    style: {},
    createdAt: clock(),
  };
}

describe('PublishModeDeciderRole', () => {
  test('createdContent 写入 → 默认产出 immediate + publishTime=null', async () => {
    const role = new PublishModeDeciderRole({ clock, logger: silentLogger });
    const ctx = new PipelineContext<PipelineFields>();
    role.register(ctx);
    ctx.write('createdContent', created());
    await new Promise((r) => setTimeout(r, 30));
    const out = ctx.get('publishModeDecision');
    assert.equal(out?.mode, 'immediate');
    assert.equal(out?.publishTime, null);
    assert.equal(out?.decidedAt, clock());
  });
});

describe('clampScheduledTime', () => {
  const now = 1700000000000;

  test('null 输入 → null', () => {
    assert.equal(clampScheduledTime(null, now), null);
  });

  test('非有限值（NaN/Infinity）→ null', () => {
    assert.equal(clampScheduledTime(NaN, now), null);
    assert.equal(clampScheduledTime(Infinity, now), null);
  });

  test('过去或当下 → null（必须严格未来）', () => {
    assert.equal(clampScheduledTime(now - 1, now), null);
    assert.equal(clampScheduledTime(now, now), null);
  });

  test('不足 1 小时 → null', () => {
    const underOneHour = now + 60 * 60 * 1000 - 1;
    assert.equal(clampScheduledTime(underOneHour, now), null);
  });

  test('未来 1 小时至 14 天（含边界）→ 原样返回', () => {
    const oneHour = now + 60 * 60 * 1000;
    assert.equal(clampScheduledTime(oneHour, now), oneHour);
    const fourteenDays = now + 14 * 24 * 60 * 60 * 1000;
    assert.equal(clampScheduledTime(fourteenDays, now), fourteenDays);
  });

  test('超过 14 天 → null', () => {
    const overFourteen = now + 14 * 24 * 60 * 60 * 1000 + 1;
    assert.equal(clampScheduledTime(overFourteen, now), null);
  });
});
