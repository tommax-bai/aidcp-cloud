import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { VisibilityDeciderRole } from '../../src/publish-agent/roles/visibility-decider.js';
import { PipelineContext } from '../../src/publish-agent/pipeline-context.js';
import type { PipelineFields, CreatedContent } from '../../src/publish-agent/types.js';

const clock = () => 1700000000000;
const silentLogger = { log() {}, warn() {}, error() {} };

function createdContent(): CreatedContent {
  return {
    title: 't',
    content: 'c',
    tags: ['a'],
    tone: 'technical',
    style: {},
    createdAt: clock(),
  };
}

describe('VisibilityDeciderRole', () => {
  test('createdContent 就绪 → 刻意产出 public + reason + decidedAt', async () => {
    const role = new VisibilityDeciderRole({ clock, logger: silentLogger });
    const ctx = new PipelineContext<PipelineFields>();
    role.register(ctx);
    ctx.write('createdContent', createdContent());
    await new Promise((r) => setTimeout(r, 30));
    const out = ctx.get('visibilityDecision');
    assert.equal(out?.visibility, 'public');
    assert.ok(out?.reason && out.reason.length > 0, 'reason 必须非空（刻意决策说明）');
    assert.equal(out?.decidedAt, 1700000000000);
  });

  test('绝不落 null：visibility/reason/decidedAt 均有值', async () => {
    const role = new VisibilityDeciderRole({ clock, logger: silentLogger });
    const ctx = new PipelineContext<PipelineFields>();
    role.register(ctx);
    ctx.write('createdContent', createdContent());
    await new Promise((r) => setTimeout(r, 30));
    const out = ctx.get('visibilityDecision');
    assert.notEqual(out, undefined);
    assert.notEqual(out!.visibility, null);
    assert.notEqual(out!.reason, null);
    assert.notEqual(out!.decidedAt, null);
  });

  test('getDefaultOutput 保守 self_only（绝不隐式 public）', () => {
    const role = new VisibilityDeciderRole({ clock, logger: silentLogger });
    const def = (role as unknown as { getDefaultOutput(): { visibility: string; reason: string; decidedAt: number } }).getDefaultOutput();
    assert.equal(def.visibility, 'self_only');
    assert.notEqual(def.visibility, 'public');
    assert.ok(def.reason && def.reason.length > 0);
    assert.equal(def.decidedAt, 1700000000000);
  });
});
