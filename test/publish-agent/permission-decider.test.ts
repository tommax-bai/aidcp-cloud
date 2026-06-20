import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionDeciderRole } from '../../src/publish-agent/roles/permission-decider.js';
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

describe('PermissionDeciderRole', () => {
  test('createdContent 就绪 → 人设鼓励互动：comment=allow / save=allow + decidedAt', async () => {
    const role = new PermissionDeciderRole({ clock, logger: silentLogger });
    const ctx = new PipelineContext<PipelineFields>();
    role.register(ctx);
    ctx.write('createdContent', createdContent());
    await new Promise((r) => setTimeout(r, 30));
    const out = ctx.get('permissionDecision');
    assert.equal(out?.comment, 'allow');
    assert.equal(out?.save, 'allow');
    assert.equal(out?.decidedAt, 1700000000000);
  });

  test('绝不落 null：comment/save/decidedAt 均有值', async () => {
    const role = new PermissionDeciderRole({ clock, logger: silentLogger });
    const ctx = new PipelineContext<PipelineFields>();
    role.register(ctx);
    ctx.write('createdContent', createdContent());
    await new Promise((r) => setTimeout(r, 30));
    const out = ctx.get('permissionDecision');
    assert.notEqual(out, undefined);
    assert.notEqual(out!.comment, null);
    assert.notEqual(out!.save, null);
    assert.notEqual(out!.decidedAt, null);
  });

  test('getDefaultOutput 保守默认：comment=disable / save=disable（绝不隐式放开）', () => {
    const role = new PermissionDeciderRole({ clock, logger: silentLogger });
    const def = (
      role as unknown as { getDefaultOutput(): { comment: string; save: string; decidedAt: number } }
    ).getDefaultOutput();
    assert.equal(def.comment, 'disable');
    assert.equal(def.save, 'disable');
    assert.notEqual(def.comment, 'allow');
    assert.notEqual(def.save, 'allow');
    assert.equal(def.decidedAt, 1700000000000);
  });
});
