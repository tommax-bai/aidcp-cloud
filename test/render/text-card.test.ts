import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_FONT_ASSETS_DIR,
  OUTPUT_HEIGHT,
  OUTPUT_WIDTH,
  PALETTES,
  createTextCardRenderer,
  hexToRgb,
  selectTheme,
} from '../../src/render/index.js';
import type { TextCardCopy, TextCardRenderer, TextCardSourceStyle } from '../../src/render/index.js';
import type { TextCardRendererInternal } from '../../src/render/text-card.js';

// 端到端：真 satori + 真 @resvg/resvg-js + 仓内字体资产（pin 版本 golden）。

const GOLDEN_COPY: TextCardCopy = {
  title: '出租屋改造：3平米阳台变身自习角',
  bullets: [
    '预算500元以内，宜家+闲鱼淘货清单',
    '光线：4000K落地灯别买错',
    '隔音：EVA地垫比隔音棉实用',
  ],
  tags: ['出租屋改造', '自习室'],
};
const GOLDEN_SEED = { accountId: 'acct-golden', postKey: 'note-0001' };

function pngDims(png: Buffer): { width: number; height: number } {
  // PNG 签名 + IHDR：宽高分别在第 16/20 字节起的大端 UInt32。
  assert.deepEqual(
    Array.from(png.subarray(0, 8)),
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    'not a PNG buffer',
  );
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

async function mustCreateRenderer(): Promise<TextCardRenderer> {
  const renderer = await createTextCardRenderer();
  assert.ok(renderer, 'factory must return a renderer with intact repo assets');
  return renderer;
}

test('工厂返回非空渲染器（仓内资产 + lazy 渲染栈齐备）', async () => {
  await mustCreateRenderer();
});

test('golden 同输入两次渲染字节全等，PNG 1728×2304，meta 合理', async () => {
  const renderer = await mustCreateRenderer();
  const first = await renderer.render(GOLDEN_COPY, GOLDEN_SEED);
  const second = await renderer.render(GOLDEN_COPY, GOLDEN_SEED);
  assert.ok(first.ok, `render failed: ${JSON.stringify(first)}`);
  assert.ok(second.ok);
  assert.ok(first.png.length > 0);
  assert.ok(first.png.equals(second.png), 'same input must be byte-identical');
  assert.deepEqual(pngDims(first.png), { width: OUTPUT_WIDTH, height: OUTPUT_HEIGHT });

  const meta = first.meta;
  assert.ok(PALETTES.some((p) => p.key === meta.paletteKey));
  assert.ok(meta.layoutKey === 'editorial' || meta.layoutKey === 'poster');
  assert.ok([116, 100, 84].includes(meta.titleFontSize));
  assert.ok(meta.titleLineCount >= 1 && meta.titleLineCount <= 3);
  assert.equal(meta.truncated, false);
  assert.equal(meta.sanitized, false);
  assert.deepEqual(meta.reductions, []);
  assert.equal(meta.themeKey, `${meta.paletteKey}:${meta.layoutKey}:${meta.themeKey.split(':')[2]}`);
});

test('重试恒定跨实例：新工厂实例渲同 (账号, 帖子) 与首次字节全等', async () => {
  const rendererA = await mustCreateRenderer();
  const rendererB = await mustCreateRenderer();
  const a = await rendererA.render(GOLDEN_COPY, GOLDEN_SEED);
  const b = await rendererB.render(GOLDEN_COPY, GOLDEN_SEED);
  assert.ok(a.ok && b.ok);
  assert.ok(a.png.equals(b.png), 'retry with a fresh renderer must be byte-identical');
});

test('文章内页固定为简洁阅读模板，同输入字节一致并记录密度', async () => {
  const renderer = await mustCreateRenderer();
  const copy: TextCardCopy = {
    title: '外界为何会替代内在',
    bullets: [],
    tags: [],
    layoutKind: 'article_page',
    paragraphs: Array.from({ length: 12 }, (_, index) => `这是重新理解自己的第${index + 1}个完整句子。`),
  };
  const first = await renderer.render(copy, GOLDEN_SEED);
  const second = await renderer.render(copy, GOLDEN_SEED);
  assert.ok(first.ok, JSON.stringify(first));
  assert.ok(second.ok);
  assert.ok(first.png.equals(second.png));
  assert.deepEqual(pngDims(first.png), { width: OUTPUT_WIDTH, height: OUTPUT_HEIGHT });
  assert.equal(first.meta.themeKey, 'article-simple-v1');
  assert.equal(first.meta.contentLayoutKind, 'article_page');
  assert.equal(first.meta.paragraphCount, 12);
  assert.ok((first.meta.occupancyRatio ?? 0) >= 0.80);

  const raw = await (renderer as TextCardRendererInternal).renderRaw(copy, GOLDEN_SEED);
  assert.ok(raw.ok);
  assert.doesNotMatch(raw.svg, /MIND NOTES|\d{2}\s*\/\s*\d{2}|border-radius/i);
});

test('不同账号 → 不同色板 → 产物字节互异', async () => {
  // 先用主题选取器找两个色板互异的账号（确定性，不靠碰运气）。
  const candidates = Array.from({ length: 32 }, (_, i) => `acct-${i}`);
  const base = selectTheme(candidates[0], GOLDEN_SEED.postKey);
  const other = candidates.find(
    (id) => selectTheme(id, GOLDEN_SEED.postKey).palette.key !== base.palette.key,
  );
  assert.ok(other, 'expected some account with a different palette');
  const renderer = await mustCreateRenderer();
  const a = await renderer.render(GOLDEN_COPY, { accountId: candidates[0], postKey: GOLDEN_SEED.postKey });
  const b = await renderer.render(GOLDEN_COPY, { accountId: other, postKey: GOLDEN_SEED.postKey });
  assert.ok(a.ok && b.ok);
  assert.ok(!a.png.equals(b.png), 'different accounts must not produce identical cards');
  assert.notEqual(a.meta.paletteKey, b.meta.paletteKey);
});

test('来源设计令牌覆盖账号模板，并渲染网格、信息卡和分页元数据', async () => {
  const renderer = (await mustCreateRenderer()) as TextCardRendererInternal;
  const sourceStyle: TextCardSourceStyle = {
    source: 'reference_analysis',
    paletteKey: 'mint',
    layout: 'editorial',
    decoration: 'none',
    backgroundTreatment: 'soft_gradient',
    backgroundPattern: 'fine_grid',
    bulletPresentation: 'numbered_cards',
    showPageMarker: true,
    pageIndex: 1,
    pageTotal: 7,
    wordAwareCjk: true,
    fidelityMode: 'balanced',
  };
  const raw = await renderer.renderRaw(
    {
      title: '核心逻辑：自我迭代闭环',
      bullets: ['同一模型分饰两角', '先生成答案后定标', '验证标准反哺训练'],
      tags: ['算法原理'],
    },
    { accountId: 'acct-oat-default', postKey: 'note-source', sourceStyle },
  );
  assert.ok(raw.ok, `render failed: ${JSON.stringify(raw)}`);
  assert.equal(raw.meta.paletteKey, 'mint');
  assert.equal(raw.meta.styleSource, 'reference_analysis');
  assert.equal(raw.meta.backgroundPattern, 'fine_grid');
  assert.equal(raw.meta.bulletPresentation, 'numbered_cards');
  assert.equal(raw.meta.pageMarker, '2/7');
  assert.match(raw.meta.themeKey, /^mint:editorial:/);
  assert.match(raw.svg, /<linearGradient/);
});

test('标题带 emoji → 剥离后照常渲染且 meta.sanitized=true', async () => {
  const renderer = await mustCreateRenderer();
  const res = await renderer.render(
    { ...GOLDEN_COPY, title: '搬砖人也要好好吃饭🍱香喷喷' },
    GOLDEN_SEED,
  );
  assert.ok(res.ok, `render failed: ${JSON.stringify(res)}`);
  assert.equal(res.meta.sanitized, true);
});

test('剥后过短标题 → invalid_copy 显式失败（不产 PNG）', async () => {
  const renderer = await mustCreateRenderer();
  const res = await renderer.render({ title: '好🔥了', bullets: [], tags: [] }, GOLDEN_SEED);
  assert.ok(!res.ok);
  assert.equal(res.reason, 'invalid_copy');
});

test('边缘像素带 = 所选色板 bg：文字绝无越界出 padding（安全系数生效证明）', async () => {
  const renderer = (await mustCreateRenderer()) as TextCardRendererInternal;
  // 用最坏混排标题（Latin kerning/标点挤压吃余量的方向）做越界断言。
  const raw = await renderer.renderRaw(
    {
      title: '2026年AI副业指南：RTX 5090+LLM本地部署，月入3万？！',
      bullets: ['预算1000元拿下90%效果（真实测评）', 'Type-C口速率实测：10Gbps！！！'],
      tags: ['数码', 'AI工具'],
    },
    { accountId: 'acct-7', postKey: 'note-777' },
  );
  assert.ok(raw.ok, `render failed: ${JSON.stringify(raw)}`);
  assert.equal(raw.width, OUTPUT_WIDTH);
  assert.equal(raw.height, OUTPUT_HEIGHT);
  assert.equal(raw.pixels.length, OUTPUT_WIDTH * OUTPUT_HEIGHT * 4);

  const [bgR, bgG, bgB] = hexToRgb(raw.theme.palette.bg);
  const sample = (x: number, y: number): void => {
    const i = (y * OUTPUT_WIDTH + x) * 4;
    assert.deepEqual(
      [raw.pixels[i], raw.pixels[i + 1], raw.pixels[i + 2], raw.pixels[i + 3]],
      [bgR, bgG, bgB, 255],
      `pixel at (${x},${y}) is not palette bg`,
    );
  };
  // 采样点刻意避开角部装饰（装饰只落画布顶部两角）：
  // 左中带 / 右中带 / 底部中带，均在 padding（96×1.6=154px）以内。
  const midY = Math.floor(OUTPUT_HEIGHT / 2);
  for (const x of [6, 24, 60]) sample(x, midY);
  for (const x of [OUTPUT_WIDTH - 7, OUTPUT_WIDTH - 25, OUTPUT_WIDTH - 61]) sample(x, midY);
  const midX = Math.floor(OUTPUT_WIDTH / 2);
  for (const y of [OUTPUT_HEIGHT - 7, OUTPUT_HEIGHT - 25, OUTPUT_HEIGHT - 61]) sample(midX, y);
  // 左右边带再各取上下四分位点，加密覆盖。
  for (const y of [Math.floor(OUTPUT_HEIGHT * 0.75)]) {
    sample(10, y);
    sample(OUTPUT_WIDTH - 11, y);
  }
});

test('resvg 像素与 PNG 编码一致（同一 render() 产物）', async () => {
  const renderer = (await mustCreateRenderer()) as TextCardRendererInternal;
  const raw = await renderer.renderRaw(GOLDEN_COPY, GOLDEN_SEED);
  assert.ok(raw.ok);
  assert.deepEqual(pngDims(raw.png), { width: raw.width, height: raw.height });
});

test('篡改防线：assetsDir 不存在 → 工厂返 null + 显式告警、绝不 throw', async () => {
  const warnings: string[] = [];
  const renderer = await createTextCardRenderer({
    assetsDir: join(tmpdir(), 'aidcp-no-such-fonts-dir'),
    logger: { warn: (msg) => warnings.push(msg) },
  });
  assert.equal(renderer, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /renderer unavailable/);
});

test('篡改防线：字体文件被改 → sha256 校验不过 → 工厂返 null', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aidcp-font-tamper-'));
  copyFileSync(join(DEFAULT_FONT_ASSETS_DIR, 'font-manifest.json'), join(dir, 'font-manifest.json'));
  copyFileSync(join(DEFAULT_FONT_ASSETS_DIR, 'AidcpSansSC-Regular.ttf'), join(dir, 'AidcpSansSC-Regular.ttf'));
  // Bold 被篡改：内容与 manifest sha256 不符。
  writeFileSync(join(dir, 'AidcpSansSC-Bold.ttf'), Buffer.from('tampered'));
  const warnings: string[] = [];
  const renderer = await createTextCardRenderer({
    assetsDir: dir,
    logger: { warn: (msg) => warnings.push(msg) },
  });
  assert.equal(renderer, null);
  assert.match(warnings[0], /sha256 mismatch/);
});
