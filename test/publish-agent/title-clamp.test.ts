import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { clampTitle, graphemeCount, firstSentence } from '../../src/kernel/title-clamp.js';

describe('AC-TITLE-CLAMP 字形安全标题截断', () => {
  test('恰 18 可见字符 → 原样不变', () => {
    const s = '一二三四五六七八九十一二三四五六七八'; // 18 汉字
    assert.equal(graphemeCount(s), 18);
    assert.equal(clampTitle(s, 18), s);
  });

  test('19 字 → 截断到 ≤18（连续汉字无边界 → 硬切到 18）', () => {
    const s = '一二三四五六七八九十一二三四五六七八九'; // 19 汉字
    const out = clampTitle(s, 18);
    assert.equal(graphemeCount(out), 18);
    assert.equal(out, s.slice(0, 18));
  });

  test('25 连续汉字 → 返回恰 18、绝不返空', () => {
    const s = '床前明月光疑是地上霜举头望明月低头思故乡你好世界一'; // 25 汉字
    assert.equal(graphemeCount(s), 25);
    const out = clampTitle(s, 18);
    assert.equal(graphemeCount(out), 18);
    assert.ok(out.length > 0, '绝不返空');
  });

  test('emoji 不拆代理对：按 grapheme 切，绝不切碎多码元', () => {
    const s = '😀'.repeat(20); // 20 个 emoji grapheme（每个 2 个 UTF-16 码元）
    const out = clampTitle(s, 18);
    assert.equal(graphemeCount(out), 18, '应保留 18 个完整 emoji（非 9 个=18码元的盲切）');
    assert.equal(out, '😀'.repeat(18));
    // 末尾不是孤立高代理（盲切会留半个 emoji）。
    assert.ok(!/[\uD800-\uDBFF]$/u.test(out), '结尾不得是孤立高代理（emoji 未被切碎）');
  });

  test('含空格 → 在窗口内回退到空格边界（不在词中间切）', () => {
    const s = 'abcdefghijklmnop qrstuv'; // 16 字母 + 空格(17) + 'qrstuv'
    const out = clampTitle(s, 18);
    assert.equal(out, 'abcdefghijklmnop', '回退到空格边界、丢弃尾随空格');
    assert.ok(!out.endsWith(' '), '不以空格结尾');
    assert.ok(graphemeCount(out) <= 18);
  });

  test('空串入 → 空串出（空标题策略由调用方定，绝不编造占位）', () => {
    assert.equal(clampTitle(''), '');
    assert.equal(clampTitle('', 18), '');
  });

  test('max<=0 → 空串（防御性）', () => {
    assert.equal(clampTitle('任何内容', 0), '');
  });

  test('firstSentence：取首行首句（deriveTitle 兜底用）', () => {
    assert.equal(firstSentence('这是第一句。第二句不要'), '这是第一句。');
    assert.equal(firstSentence('第一行\n第二行'), '第一行');
    assert.equal(firstSentence('没有句末标点的一整行'), '没有句末标点的一整行');
    assert.equal(firstSentence(''), '');
  });
});
