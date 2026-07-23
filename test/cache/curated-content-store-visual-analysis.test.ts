import { test } from 'node:test';
import { ensureCapabilitySchema } from '../../src/schema/schema-capability.js';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { CuratedContentStore } from '../../src/cache/curated-content-store.js';
import type { ReferenceVisualAnalysis } from '../../src/kernel/visual-reference-types.js';

const analysis: ReferenceVisualAnalysis = {
  status: 'analyzed', schemaVersion: 'visual-reference-v3', cacheKey: 'cache', provider: 'dashscope', model: 'qwen3.7-plus', analyzedAt: 1000, sourceCount: 1,
  setStyleBible: { summary: '极简', palette: ['白'], colorTemperature: 'neutral', contrast: 'medium', visualDensity: 'sparse', whitespace: '多', hierarchy: '单一', mood: ['安静'], texture: ['纸'], continuityRules: ['统一'], avoid: ['水印'] },
  styleClusters: [{ id: 'c1', label: '极简', frameIndexes: [0], summary: '极简', palette: ['白'], traits: ['留白'] }],
  frameSpecs: [{
    sourceArrayIndex: 0, sourceIndex: 3, kind: 'text_layout', confidence: 0.9, clusterId: 'c1', sequenceRole: 'cover',
    common: { aspectRatio: '3:4', subject: '排版块', composition: '居中', focalHierarchy: '标题区和正文区', palette: ['白'], lightingOrContrast: '黑白对比', negativeSpace: '四周留白', texture: '纸', mood: '克制', avoid: ['具体文字'] },
    details: { family: 'text_layout', grid: '单列', textBlockRatio: '60%', hierarchy: '三级', alignment: '左对齐', weightContrast: '强', colorBlocks: '无', decorations: '细线' },
  }],
};

test('visual analysis 缓存单语句核有序图片锚且不抬 updated_at', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = { query: async (sql: string, params: unknown[]) => { calls.push({ sql, params }); return { rows: [], rowCount: 1 }; } } as unknown as pg.Pool;
  const store = new CuratedContentStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  const ok = await store.annotateReferenceVisualAnalysis(9, analysis, [{ sourceArrayIndex: 0, sourceIndex: 3, capturedAt: 88, url: 'https://oss/a.jpg' }]);
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /^\s*UPDATE curated_content/);
  assert.match(calls[0].sql, /jsonb_array_elements\(reference_images\)/);
  assert.match(calls[0].sql, /row_number\(\) OVER \(ORDER BY pos\)/, '空 URL 槽不应污染有效图片的 sourceArrayIndex');
  assert.doesNotMatch(calls[0].sql, /updated_at/);
  assert.deepEqual(JSON.parse(calls[0].params[2] as string), [{ sourceArrayIndex: 0, sourceIndex: 3, capturedAt: 88, url: 'https://oss/a.jpg' }]);
});

test('unavailable 结果不写缓存，避免负缓存/假 analyzed', async () => {
  let called = false;
  const pool = { query: async () => { called = true; return { rows: [], rowCount: 1 }; } } as unknown as pg.Pool;
  const store = new CuratedContentStore({ schemaEnsurer: ensureCapabilitySchema, pool });
  const ok = await store.annotateReferenceVisualAnalysis(9, { ...analysis, status: 'unavailable' }, [{ sourceArrayIndex: 0, sourceIndex: 3, capturedAt: 88, url: 'u' }]);
  assert.equal(ok, false);
  assert.equal(called, false);
});
