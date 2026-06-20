import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ContentTypeSelectorRole } from '../../src/publish-agent/roles/content-type-selector.js';
import { PipelineContext } from '../../src/publish-agent/pipeline-context.js';
import type { PipelineFields, ScoutDecision } from '../../src/publish-agent/types.js';

const clock = () => 1700000000000;
const silentLogger = { log() {}, warn() {}, error() {} };

function scout(shouldPublish: boolean): ScoutDecision {
  return { shouldPublish, publishDirection: 'x', keyPoints: [], confidence: 0.8, reason: 'r', scoutedAt: clock() };
}

describe('ContentTypeSelectorRole', () => {
  test('shouldPublish=true → 产出 contentType image_text', async () => {
    const role = new ContentTypeSelectorRole({ clock, logger: silentLogger });
    const ctx = new PipelineContext<PipelineFields>();
    role.register(ctx);
    ctx.write('scoutDecision', scout(true));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(ctx.get('contentType')?.kind, 'image_text');
  });

  test('shouldPublish=false → 守卫不通过、不写键（不阻塞短路）', async () => {
    const role = new ContentTypeSelectorRole({ clock, logger: silentLogger });
    const ctx = new PipelineContext<PipelineFields>();
    role.register(ctx);
    ctx.write('scoutDecision', scout(false));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(ctx.get('contentType'), undefined);
  });
});
