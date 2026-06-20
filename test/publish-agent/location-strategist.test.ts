import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { LocationStrategistRole } from '../../src/publish-agent/roles/location-strategist.js';
import { PipelineContext } from '../../src/publish-agent/pipeline-context.js';
import type { PipelineFields, CreatedContent } from '../../src/publish-agent/types.js';

const clock = () => 1700000000000;
const silentLogger = { log() {}, warn() {}, error() {} };

function createdContent(): CreatedContent {
  return {
    title: 'x',
    content: 'body',
    tags: ['a'],
    tone: 'casual',
    style: {},
    createdAt: clock(),
  };
}

describe('LocationStrategistRole', () => {
  test('createdContent 写入 → 无地点源、诚实回 null（不编造）', async () => {
    const role = new LocationStrategistRole({ clock, logger: silentLogger });
    const ctx = new PipelineContext<PipelineFields>();
    role.register(ctx);
    ctx.write('createdContent', createdContent());
    await new Promise((r) => setTimeout(r, 30));
    const out = ctx.get('locationSelection');
    assert.equal(out?.selectedLocation, null);
    assert.equal(out?.selectedAt, clock());
  });
});
