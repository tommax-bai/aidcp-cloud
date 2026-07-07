import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DECORATIONS,
  LAYOUT_VARIANTS,
  PALETTES,
  contrastRatio,
  fnv1a,
  selectTheme,
} from '../../src/render/index.js';

// 主题模板表离线可证（spec「主题确定性与反指纹」：全表对比度 + 账号稳定 + 重试恒定）。

test('模板表规模：8 色板 × 2 版式 × 3 装饰', () => {
  assert.equal(PALETTES.length, 8);
  assert.equal(LAYOUT_VARIANTS.length, 2);
  assert.equal(DECORATIONS.length, 3);
});

test('色板 key 与 bg 全表互异', () => {
  assert.equal(new Set(PALETTES.map((p) => p.key)).size, PALETTES.length);
  assert.equal(new Set(PALETTES.map((p) => p.bg)).size, PALETTES.length);
});

test('全表对比度红线：标题/背景 与 胶囊文字/胶囊底 均 ≥ 4.5:1', () => {
  for (const palette of PALETTES) {
    const titleOnBg = contrastRatio(palette.title, palette.bg);
    const pillTextOnPill = contrastRatio(palette.pillText, palette.pillBg);
    assert.ok(titleOnBg >= 4.5, `${palette.key}: title/bg = ${titleOnBg.toFixed(2)}`);
    assert.ok(pillTextOnPill >= 4.5, `${palette.key}: pillText/pillBg = ${pillTextOnPill.toFixed(2)}`);
  }
});

test('装饰叠底安全：标题/bgAccent 亦 ≥ 4.5:1（标题行可与角部装饰相交）', () => {
  for (const palette of PALETTES) {
    const ratio = contrastRatio(palette.title, palette.bgAccent);
    assert.ok(ratio >= 4.5, `${palette.key}: title/bgAccent = ${ratio.toFixed(2)}`);
  }
});

test('FNV-1a 标准测试向量', () => {
  assert.equal(fnv1a(''), 0x811c9dc5);
  assert.equal(fnv1a('a'), 0xe40c292c);
  assert.equal(fnv1a('foobar'), 0xbf9cf968);
});

test('账号视觉身份稳定：同账号跨帖色板+版式一致，只有装饰随帖变化', () => {
  const accountId = 'acct-8f3e2c17';
  const themes = Array.from({ length: 30 }, (_, i) =>
    selectTheme(accountId, `post-${i}`),
  );
  const paletteKeys = new Set(themes.map((t) => t.palette.key));
  const layouts = new Set(themes.map((t) => t.layout));
  assert.equal(paletteKeys.size, 1, 'palette must be stable per account');
  assert.equal(layouts.size, 1, 'layout must be stable per account');
  const decorations = new Set(themes.map((t) => t.decoration));
  assert.ok(decorations.size > 1, 'decoration should vary across posts');
});

test('重试恒定：同 (账号, 帖子) 两次选取 themeKey 全等', () => {
  const a = selectTheme('acct-42', 'note-777');
  const b = selectTheme('acct-42', 'note-777');
  assert.deepEqual(a, b);
  assert.match(a.themeKey, /^[a-z-]+:(editorial|poster):(none|corner-arc|dot-grid)$/);
});

test('账号间分散：40 个账号覆盖多个色板与两种版式', () => {
  const themes = Array.from({ length: 40 }, (_, i) => selectTheme(`account-${i}`, 'post'));
  const paletteKeys = new Set(themes.map((t) => t.palette.key));
  const layouts = new Set(themes.map((t) => t.layout));
  assert.ok(paletteKeys.size > 1, `expected >1 palette, got ${paletteKeys.size}`);
  assert.equal(layouts.size, 2, 'expected both layout variants to appear');
});
