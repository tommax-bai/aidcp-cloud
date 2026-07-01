import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CoverSelectorRole } from '../../src/publish-agent/roles/cover-selector.js';
import { PipelineContext } from '../../src/publish-agent/pipeline-context.js';
import type { PipelineFields, ImageDirective } from '../../src/publish-agent/types.js';

const clock = () => 1700000000000;
const silentLogger = { log() {}, warn() {}, error() {} };

function directive(imageUrls: string[]): ImageDirective {
  return {
    imagePrompt: imageUrls[0] ? 'p' : null,
    imageUrls,
    imageUrl: imageUrls[0] ?? null,
    imageStyle: imageUrls[0] ? 'illustration' : null,
    fallbackStrategy: 'skip',
    directedAt: clock(),
  };
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

describe('CoverSelectorRole（多图透传，封面恒取首张）', () => {
  test('多图 → 透传全集、封面=首张、hasCover:true', async () => {
    const c = await run(directive(['https://cdn/a.png', 'https://cdn/b.png', 'https://cdn/c.png']));
    assert.deepEqual(c.imageUrls, ['https://cdn/a.png', 'https://cdn/b.png', 'https://cdn/c.png']);
    assert.equal(c.imageUrls[0], 'https://cdn/a.png', '封面 = 成功序列首张');
    assert.equal(c.hasCover, true);
  });

  test('单图 → 透传 1 张、hasCover:true', async () => {
    const c = await run(directive(['https://cdn/x.png']));
    assert.deepEqual(c.imageUrls, ['https://cdn/x.png']);
    assert.equal(c.hasCover, true);
  });

  test('无图 → 诚实回 imageUrls:[] hasCover:false（不选占位图）', async () => {
    const c = await run(directive([]));
    assert.deepEqual(c.imageUrls, []);
    assert.equal(c.hasCover, false);
  });
});
