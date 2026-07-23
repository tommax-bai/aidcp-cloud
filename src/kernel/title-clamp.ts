/**
 * 标题长度收口（change dedicated-title-creator-role）。
 *
 * 红线：长度收口必须发生在「写 DB / 下发 edge」之前、且字形安全——绝不从汉字/英文词/emoji 代理对
 * 中间盲切（旧 `String.slice(0, n)` 会切碎多码元 grapheme）。本模块按 `Intl.Segmenter` 的
 * grapheme 计数与切分，保证：① 计数 == 人眼可见字符数；② 切分点永远落在 grapheme 边界。
 *
 * 收口点单一：TitleCreator 写 `titleSelection.title` 即已 ≤max；PublishExecutor 仅在字段意外缺失时
 * 用 `clampTitle(firstSentence(...))` 兜底。edge 不再做任何标题截断（策略收口云端一处）。
 */

/** grapheme 切分器（zh locale；标题含中英混排，locale 仅影响极少数边界，无碍）。 */
const GRAPHEME_SEGMENTER = new Intl.Segmenter('zh', { granularity: 'grapheme' });

/** 把字符串切成 grapheme 数组（每个 emoji / 代理对 / 组合字符算 1 个）。 */
function toGraphemes(s: string): string[] {
  const out: string[] = [];
  for (const { segment } of GRAPHEME_SEGMENTER.segment(s)) out.push(segment);
  return out;
}

/** 可见字符数（grapheme 计数；emoji / 汉字 / 英文字母 / 标点各算 1）。 */
export function graphemeCount(s: string): number {
  if (!s) return 0;
  return toGraphemes(s).length;
}

/** 回退边界判定：空白或标点视为可断点（在其之前切，丢弃尾随的边界符与空白）。 */
function isBreakable(grapheme: string): boolean {
  return /^\s$/u.test(grapheme) || /^\p{P}$/u.test(grapheme);
}

/**
 * 字形安全截断：
 * - `max <= 0` 或空输入 → 返回空串（空标题策略由调用方决定；XHS 允许空标题，绝不编造占位）。
 * - 可见字符数 ≤ max → 原样返回。
 * - 超 max → 取前 max 个 grapheme 作硬上限，再在 `[max-WINDOW, max]` 窗口内回退到最近的词/标点边界；
 *   窗口内无边界（如连续汉字）则硬切到 max。
 * - **绝不返空**（非空输入至少返回硬切到 max 的前缀）、**绝不切碎 grapheme**。
 */
export function clampTitle(s: string, max = 18): string {
  if (max <= 0) return '';
  const input = s ?? '';
  if (input.length === 0) return '';

  const graphemes = toGraphemes(input);
  if (graphemes.length <= max) return input;

  const hard = graphemes.slice(0, max);
  // 在窗口内回退到最近的词/标点边界，避免在词中间切断。窗口外（连续汉字）则接受硬切。
  const WINDOW = 4;
  const floor = Math.max(1, max - WINDOW);
  for (let i = max; i >= floor; i--) {
    if (isBreakable(hard[i - 1])) {
      const cut = hard.slice(0, i - 1).join('').replace(/\s+$/u, '');
      if (cut.length > 0) return cut; // 回退结果非空才采纳，否则继续/硬切
    }
  }
  return hard.join('');
}

/**
 * 取正文首句（供 deriveTitle 兜底复用）：先取首行，再到首个句末标点为止；无句末标点则用整行。
 * 仅用于「titleSelection 意外缺失」的最后兜底；正常路径标题来自 TitleCreator。
 */
export function firstSentence(s: string): string {
  const input = (s ?? '').trim();
  if (!input) return '';
  const firstLine = input.split('\n')[0]?.trim() ?? input;
  if (!firstLine) return input;
  const end = firstLine.search(/[。！？.!?]/u);
  if (end >= 0) return firstLine.slice(0, end + 1).trim();
  return firstLine;
}
