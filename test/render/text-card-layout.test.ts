import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BULLET_MAX_COUNT,
  CONTENT_WIDTH,
  TAG_MAX_COUNT,
  ARTICLE_PAGE_MIN_OCCUPANCY,
  ARTICLE_PAGE_MAX_OCCUPANCY,
  createTextMetrics,
  layoutArticleTextCard,
  layoutTextCard,
} from '../../src/render/index.js';
import type { TextCardLayoutModel } from '../../src/render/index.js';

// 纯布局层单测：全部走仓内 assets/fonts 的 font-manifest（确定性 advance 度量，零字体解析）。

const metrics = createTextMetrics();

function assertOk(result: ReturnType<typeof layoutTextCard>): TextCardLayoutModel {
  assert.ok(result.ok, `expected layout ok, got ${JSON.stringify(result)}`);
  return result;
}

// —— 字号阶梯 ——

test('短标题用最大字号 116 单行，无任何缩减/截断', () => {
  const res = assertOk(layoutTextCard({ title: '早安人间', bullets: [], tags: [] }, metrics));
  assert.equal(res.title.fontSize, 116);
  assert.deepEqual(res.title.lines, ['早安人间']);
  assert.equal(res.title.lineHeightPx, 145);
  assert.equal(res.contentHeight, 145);
  assert.equal(res.truncated, false);
  assert.equal(res.sanitized, false);
  assert.deepEqual(res.reductions, []);
  assert.equal(res.bullets, null);
  assert.equal(res.tags, null);
});

test('22 字标题在 116 超 3 行 → 阶梯降到 100 收进 3 行', () => {
  const title = '深夜书桌整理术让出租屋秒变自习室的十个小步骤';
  assert.equal(Array.from(title).length, 22);
  const res = assertOk(layoutTextCard({ title, bullets: [], tags: [] }, metrics));
  assert.equal(res.title.fontSize, 100);
  assert.equal(res.title.lines.length, 3);
  assert.equal(res.truncated, false);
  assert.equal(res.title.lines.join(''), title);
});

test('超长标题 84 仍超 3 行 → 末行字形边界硬截加省略号并标记 truncated', () => {
  const title = '字'.repeat(60);
  const res = assertOk(layoutTextCard({ title, bullets: [], tags: [] }, metrics));
  assert.equal(res.title.fontSize, 84);
  assert.equal(res.title.lines.length, 3);
  assert.ok(res.title.lines[2].endsWith('…'));
  assert.equal(res.truncated, true);
  for (const line of res.title.lines) {
    assert.ok(
      metrics.measureWidth(line, 84, 'bold') <= CONTENT_WIDTH,
      `line overflows budget: ${line}`,
    );
  }
});

// —— 断行规则 ——

test('有空格可断时绝不从 Latin 词中间折行', () => {
  const title = '用 Notion 和 Obsidian 打造第二大脑的完整工作流搭建指南';
  const res = assertOk(layoutTextCard({ title, bullets: [], tags: [] }, metrics));
  assert.ok(res.title.lines.length > 1, 'expected the title to wrap');
  const inputTokens = new Set(title.match(/[0-9A-Za-z]+/g) ?? []);
  for (const line of res.title.lines) {
    for (const run of line.match(/[0-9A-Za-z]+/g) ?? []) {
      assert.ok(inputTokens.has(run), `latin word split mid-word: "${run}" in line "${line}"`);
    }
  }
});

test('来源文字卡启用中文词组断行时，不把“模型”拆成跨行的“模/型”', () => {
  const res = assertOk(layoutTextCard(
    { title: '奖励难给？ 看模型自进化评分标准', bullets: [], tags: [] },
    metrics,
    { wordAwareCjk: true },
  ));
  for (let i = 0; i < res.title.lines.length - 1; i++) {
    assert.notEqual(
      `${res.title.lines[i].slice(-1)}/${res.title.lines[i + 1][0]}`,
      '模/型',
      `word split across lines: ${JSON.stringify(res.title.lines)}`,
    );
  }
});

test('单个 Latin 词自身超行宽时允许字形边界内折且不超预算', () => {
  const title = 'supercalifragilisticexpialidocious2026notasinglespace 效率工具全解析';
  const res = assertOk(layoutTextCard({ title, bullets: [], tags: [] }, metrics));
  for (const line of res.title.lines) {
    assert.ok(
      metrics.measureWidth(line, res.title.fontSize, 'bold') <= CONTENT_WIDTH,
      `line overflows budget: ${line}`,
    );
  }
});

// —— 剥离与显式失败 ——

test('纯 emoji 标题全部剥离 → glyph_uncovered 显式失败', () => {
  const res = layoutTextCard({ title: '🔥🚀😀✨', bullets: [], tags: [] }, metrics);
  assert.ok(!res.ok);
  assert.equal(res.reason, 'glyph_uncovered');
});

test('剥离后标题不足 4 字形 → invalid_copy 显式失败', () => {
  const res = layoutTextCard({ title: '好🔥了', bullets: [], tags: [] }, metrics);
  assert.ok(!res.ok);
  assert.equal(res.reason, 'invalid_copy');
});

test('emoji 混入标题与要点 → 确定性剥离并标记 sanitized，其余照常排版', () => {
  const res = assertOk(
    layoutTextCard(
      {
        title: '搬砖人也要好好吃饭🍱',
        bullets: ['带饭省钱又健康💰', '🥦🥦🥦'],
        tags: ['打工人日常'],
      },
      metrics,
    ),
  );
  assert.equal(res.sanitized, true);
  assert.ok(!res.title.lines.join('').includes('🍱'));
  // 全 emoji 要点剥空后整条丢弃。
  assert.ok(res.bullets);
  assert.equal(res.bullets.items.length, 1);
  assert.ok(!res.bullets.items[0].lines.join('').includes('💰'));
});

test('连续空白（含剥离残留）折叠为单空格', () => {
  const res = assertOk(layoutTextCard({ title: '早安  人间🔥  好', bullets: [], tags: [] }, metrics));
  assert.equal(res.title.lines[0], '早安 人间 好');
  assert.equal(res.sanitized, true);
});

// —— 要点与标签 ——

test('要点最多 2 行，超出在字形边界截断加省略号（meta.truncated 仍只表标题硬截）', () => {
  const res = assertOk(
    layoutTextCard({ title: '好好学习天天向上', bullets: ['测'.repeat(60)], tags: [] }, metrics),
  );
  assert.ok(res.bullets);
  assert.equal(res.bullets.items[0].lines.length, 2);
  assert.ok(res.bullets.items[0].lines[1].endsWith('…'));
  assert.equal(res.truncated, false);
  for (const line of res.bullets.items[0].lines) {
    assert.ok(metrics.measureWidth(line, 44, 'regular') <= CONTENT_WIDTH);
  }
});

test('要点超 5 条钳制并记账；标签超 3 个钳制并记账、自动补 # 前缀', () => {
  const res = assertOk(
    layoutTextCard(
      {
        title: '好好学习天天向上',
        bullets: ['一', '二', '三', '四', '五', '六', '七'],
        tags: ['效率', '#自习室', '打工人', '第四个'],
      },
      metrics,
    ),
  );
  assert.ok(res.bullets);
  assert.equal(res.bullets.items.length, BULLET_MAX_COUNT);
  assert.ok(res.reductions.includes(`bullets_capped_to_${BULLET_MAX_COUNT}`));
  assert.ok(res.tags);
  assert.equal(res.tags.pills.length, TAG_MAX_COUNT);
  assert.deepEqual(
    res.tags.pills.map((p) => p.text),
    ['#效率', '#自习室', '#打工人'],
  );
  assert.ok(res.reductions.includes(`tags_capped_to_${TAG_MAX_COUNT}`));
});

// —— 垂直缩减阶梯 ——

const LONG_BULLETS = ['测'.repeat(25), '试'.repeat(25), '排'.repeat(25), '版'.repeat(25), '高'.repeat(25)];

test('默认预算下最坏组合触发第一级缩减：要点 2 行 → 1 行且逐项记账', () => {
  // 3 行标题(435) + 间距(64) + 5×2 行要点(756) = 1255 > 1248 → 降 1 行后 925 收敛。
  const res = assertOk(
    layoutTextCard({ title: '字'.repeat(20), bullets: LONG_BULLETS, tags: [] }, metrics),
  );
  assert.equal(res.title.lines.length, 3);
  assert.deepEqual(res.reductions, ['bullet_maxlines_2_to_1']);
  assert.ok(res.bullets);
  for (const item of res.bullets.items) {
    assert.equal(item.lines.length, 1);
    assert.ok(item.lines[0].endsWith('…'));
  }
  assert.ok(res.contentHeight <= 1248);
});

test('收紧预算走满缩减阶梯：行数 → 条数 → 丢标签，全程记账', () => {
  const res = assertOk(
    layoutTextCard(
      { title: '好好学习天天向', bullets: LONG_BULLETS, tags: ['效率', '自习', '搬砖'] },
      metrics,
      { contentHeightPx: 500 },
    ),
  );
  assert.deepEqual(res.reductions, [
    'bullet_maxlines_2_to_1',
    'bullet_count_5_to_3',
    'drop_tags',
  ]);
  assert.ok(res.bullets);
  assert.equal(res.bullets.items.length, 3);
  assert.equal(res.tags, null);
  assert.ok(res.contentHeight <= 500);
});

test('阶梯走完仍无法消解 → 显式失败绝不出溢出卡', () => {
  const res = layoutTextCard(
    { title: '好好学习天天向', bullets: LONG_BULLETS, tags: ['效率'] },
    metrics,
    { contentHeightPx: 300 },
  );
  assert.ok(!res.ok);
  assert.equal(res.reason, 'invalid_copy');
  assert.ok(res.detail?.startsWith('vertical_overflow_unresolved'));
});

// —— 混排样例：中英数字混合、全角半角标点相邻，测量行宽全部不超预算 ——

const MIXED_TITLES = [
  '2026年AI副业指南：RTX 5090+LLM本地部署，月入3万？！',
  'iPhone 17 Pro Max（256GB）值不值？看完这篇再买！',
  '「Vibe Coding」真香警告：Claude Code 上手72小时实录',
  'Wi-Fi 6E vs 有线：居家办公网络优化全攻略（2026版）',
];

test('混排标题（CJK+Latin+数字+全角半角标点相邻）逐行测量宽 ≤ 行宽预算', () => {
  for (const title of MIXED_TITLES) {
    const res = assertOk(
      layoutTextCard(
        { title, bullets: ['预算1000元拿下90%效果（真实测评）', 'Type-C 口速率实测：10Gbps！'], tags: ['数码'] },
        metrics,
      ),
    );
    assert.equal(res.sanitized, false, `unexpected strip in: ${title}`);
    for (const line of res.title.lines) {
      assert.ok(
        metrics.measureWidth(line, res.title.fontSize, 'bold') <= CONTENT_WIDTH,
        `title line overflows: "${line}" (${title})`,
      );
    }
    assert.ok(res.bullets);
    for (const item of res.bullets.items) {
      for (const line of item.lines) {
        assert.ok(
          metrics.measureWidth(line, 44, 'regular') <= CONTENT_WIDTH,
          `bullet line overflows: "${line}"`,
        );
      }
    }
  }
});

// —— 覆盖预检抽查：常用标点/数字/全角（任务 2.1 验证项） ——

test('字体覆盖抽查：ASCII/全角标点/CJK 标点/破折省略号/〇 全部在册', () => {
  const samples = ['0', '9', 'A', 'z', '，', '。', '：', '！', '？', '（', '）', '「', '」', '—', '…', '·', '〇', '％', '＋'];
  for (const ch of samples) {
    assert.ok(
      metrics.isCovered(ch.codePointAt(0)!, 'regular'),
      `expected covered (regular): ${ch}`,
    );
    assert.ok(metrics.isCovered(ch.codePointAt(0)!, 'bold'), `expected covered (bold): ${ch}`);
  }
  assert.ok(!metrics.isCovered('🔥'.codePointAt(0)!, 'regular'));
});

// —— 连续文章卡：固定字号、短句分段与密度门禁 ——

const ARTICLE_PARAGRAPHS = Array.from(
  { length: 12 },
  (_, index) => `这是重新理解自己的第${index + 1}个完整句子。`,
);

test('文章内页使用固定正文参数且占用率落在 0.80~0.96', () => {
  const res = layoutArticleTextCard({
    layoutKind: 'article_page',
    title: '外界为何会替代内在',
    paragraphs: ARTICLE_PARAGRAPHS,
  }, metrics);
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal(res.paragraphs.fontSize, 36);
  assert.equal(res.paragraphs.lineHeightPx, 58);
  assert.equal(res.paragraphs.items.length, 12);
  assert.ok(res.occupancyRatio >= ARTICLE_PAGE_MIN_OCCUPANCY);
  assert.ok(res.occupancyRatio <= ARTICLE_PAGE_MAX_OCCUPANCY);
});

test('文章内页内容过疏显式失败，不靠放大行高填空', () => {
  const res = layoutArticleTextCard({
    layoutKind: 'article_page',
    title: '外界为何会替代内在',
    paragraphs: ARTICLE_PARAGRAPHS.slice(0, 2),
  }, metrics);
  assert.ok(!res.ok);
  assert.equal(res.reason, 'invalid_copy');
  assert.match(res.detail ?? '', /too sparse/);
});

test('文章内页内容过多显式失败，不截断末尾段落', () => {
  const res = layoutArticleTextCard({
    layoutKind: 'article_page',
    title: '外界为何会替代内在',
    paragraphs: Array.from({ length: 20 }, (_, index) => `这是不能被删掉的第${index + 1}个完整句子。`),
  }, metrics);
  assert.ok(!res.ok);
  assert.equal(res.reason, 'invalid_copy');
  assert.match(res.detail ?? '', /too dense/);
});

test('文章卡出现未覆盖字形时显式失败，不静默删字符', () => {
  const res = layoutArticleTextCard({
    layoutKind: 'article_page',
    title: '外界为何会替代内在',
    paragraphs: [...ARTICLE_PARAGRAPHS.slice(0, 11), '这一句带有未覆盖表情🔥。'],
  }, metrics);
  assert.ok(!res.ok);
  assert.equal(res.reason, 'glyph_uncovered');
});

test('文章正文换行不让中文闭合标点孤立到下一行', () => {
  const res = layoutArticleTextCard({
    layoutKind: 'article_page',
    title: '稳定的自我感如何形成',
    paragraphs: Array.from({ length: 7 }, () => '当一句很长的话接近边界的时候，标点仍然跟随前面的语义词组。'),
  }, metrics);
  assert.ok(res.ok, JSON.stringify(res));
  for (const item of res.paragraphs.items) {
    for (const line of item.lines) assert.doesNotMatch(line, /^[，。！？；：、）】》」』’”]/u);
  }
});
