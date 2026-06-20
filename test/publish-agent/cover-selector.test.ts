import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CoverSelectorRole } from '../../src/publish-agent/roles/cover-selector.js';
import { PipelineContext } from '../../src/publish-agent/pipeline-context.js';
import type { PipelineFields, ImageDirective } from '../../src/publish-agent/types.js';

const clock = () => 1700000000000;
const silentLogger = { log() {}, warn() {}, error() {} };

function directive(imageUrl: string | null): ImageDirective {
  return { imagePrompt: imageUrl ? 'p' : null, imageUrl, imageStyle: imageUrl ? 'illustration' : null, fallbackStrategy: 'skip', directedAt: clock() };
}

function run(d: ImageDirective) {
  const role = new CoverSelectorRole({ clock, logger: silentLogger });
  const ctx = new PipelineContext<PipelineFields>();
  role.register(ctx);
  ctx.write('imageDirective', d);
  return new Promise<NonNullable<PipelineFields['coverSelection']>>((resolve) =>
    setTimeout(() => resolve(ctx.get('coverSelection')!), 30),
  );
}

describe('CoverSelectorRole', () => {
  test('有图 → 选首图 hasCover:true', async () => {
    const c = await run(directive('https://cdn/x.png'));
    assert.equal(c.imageUrl, 'https://cdn/x.png');
    assert.equal(c.hasCover, true);
  });

  test('无图 → 诚实回 imageUrl:null hasCover:false（不选占位图）', async () => {
    const c = await run(directive(null));
    assert.equal(c.imageUrl, null);
    assert.equal(c.hasCover, false);
  });
});
