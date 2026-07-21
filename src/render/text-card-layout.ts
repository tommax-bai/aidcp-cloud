/**
 * 文字卡渲染 — 纯排版层（不 import satori）。
 *
 * 布局所有权自持（design D11）：断行/字号阶梯（116/100/84）/垂直缩减阶梯全部在此
 * 依 font-manifest advance 宽度纯函数决定；satori 只做盒子定位（每行 nowrap）。
 * 红线（spec text-card-rendering）：未覆盖码点先确定性剥离并记 sanitized；
 * 剥后标题过短显式失败；硬截记 truncated；垂直缩减逐步记 reductions——绝无静默丢内容。
 * 全层确定性：无 Date.now / Math.random。
 */

import type { FontWeightKey, TextMetrics } from './text-metrics.js';

/** 逻辑画布：1080×1440（3:4），四边 padding 96（design D9）。 */
export const CANVAS_WIDTH = 1080;
export const CANVAS_HEIGHT = 1440;
export const CANVAS_PADDING = 96;
/** 内容区宽/高（画布减两侧 padding）。 */
export const CONTENT_WIDTH = CANVAS_WIDTH - CANVAS_PADDING * 2;
export const CONTENT_HEIGHT = CANVAS_HEIGHT - CANVAS_PADDING * 2;

/** 标题字号阶梯（依次尝试，最小字号仍超行才硬截）。 */
export const TITLE_FONT_LADDER = [116, 100, 84] as const;
export const TITLE_LINE_HEIGHT = 1.25;
export const TITLE_MAX_LINES = 3;
export const TITLE_WEIGHT: FontWeightKey = 'bold';
/** 剥离后标题最少字形数（不含空白），低于此显式失败 invalid_copy。 */
export const TITLE_MIN_GLYPHS = 4;

export const BULLET_FONT_SIZE = 44;
export const BULLET_LINE_HEIGHT = 1.5;
export const BULLET_MAX_COUNT = 5;
export const BULLET_MAX_LINES = 2;
export const BULLET_WEIGHT: FontWeightKey = 'regular';
/** 要点条目间距（px）。 */
export const BULLET_GAP = 24;

export const TAG_FONT_SIZE = 34;
export const TAG_MAX_COUNT = 3;
export const TAG_WEIGHT: FontWeightKey = 'regular';
/** 标签胶囊：高度 / 水平内边距 / 胶囊间距（px）。 */
export const TAG_PILL_HEIGHT = 64;
export const TAG_PILL_PADDING_X = 24;
export const TAG_PILL_GAP = 16;

/** 区块垂直间距：标题→要点 / 要点→标签（px）。 */
export const GAP_TITLE_BULLETS = 64;
export const GAP_BULLETS_TAGS = 56;

const ELLIPSIS = '…';

/** 渲染输入文案（洗稿产物；本层入参不含任何原图信息——防搬运结构隔离）。 */
export interface TextCardLayoutInput {
  title: string;
  bullets: string[];
  tags: string[];
}

/** 标题块：选定字号 + 已断行行数组（每行渲染时 nowrap）。 */
export interface TitleBlockLayout {
  fontSize: number;
  lineHeightPx: number;
  /** 相对内容区顶部的偏移（px）。 */
  offsetY: number;
  lines: string[];
}

/** 要点块：逐条目已断行。 */
export interface BulletBlockLayout {
  fontSize: number;
  lineHeightPx: number;
  offsetY: number;
  gap: number;
  items: Array<{ lines: string[] }>;
}

/** 标签块：胶囊文本（含 # 前缀）与按度量预算好的胶囊宽度。 */
export interface TagBlockLayout {
  fontSize: number;
  pillHeight: number;
  gap: number;
  offsetY: number;
  pills: Array<{ text: string; width: number }>;
}

/** 布局成功产物：定位好的块模型 + 审计旗标。 */
export interface TextCardLayoutModel {
  ok: true;
  canvas: { width: number; height: number; padding: number };
  title: TitleBlockLayout;
  bullets: BulletBlockLayout | null;
  tags: TagBlockLayout | null;
  /** 内容总高（px，自内容区顶部起）；poster 版式据此垂直居中。 */
  contentHeight: number;
  /** 标题被硬截（末行字形边界截断 + 省略号）。 */
  truncated: boolean;
  /** 有未覆盖码点被剥离（含 emoji）。 */
  sanitized: boolean;
  /** 垂直缩减阶梯与输入钳制的逐步审计记录。 */
  reductions: string[];
}

/** 布局显式失败（回落生成式封面的信号，绝不静默出溢出卡）。 */
export interface TextCardLayoutFailure {
  ok: false;
  reason: 'invalid_copy' | 'glyph_uncovered';
  detail?: string;
}

export type TextCardLayoutResult = TextCardLayoutModel | TextCardLayoutFailure;

/** 可选约束；缺省值保持历史渲染逐字节不变。 */
export interface TextCardLayoutOptions {
  contentHeightPx?: number;
  /** 来源文字卡风格开启时，按中文词组断行，避免把“模型”等词拆到两行。 */
  wordAwareCjk?: boolean;
  /** 编号卡为左侧序号徽标预留宽度。 */
  bulletContentWidthPx?: number;
}

/** 断行单元：Latin 字母/数字连成的词不可从中折断（有空格可断时），其余（CJK 等）逐字可断。 */
function splitUnits(text: string, wordAwareCjk = false): string[] {
  if (wordAwareCjk) {
    const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
    return [...segmenter.segment(text)].flatMap(({ segment, isWordLike }) => {
      if (isWordLike) return [segment];
      return Array.from(segment);
    });
  }
  const units: string[] = [];
  let latinRun = '';
  for (const ch of text) {
    if (/[0-9A-Za-z]/.test(ch)) {
      latinRun += ch;
      continue;
    }
    if (latinRun) {
      units.push(latinRun);
      latinRun = '';
    }
    units.push(ch);
  }
  if (latinRun) units.push(latinRun);
  return units;
}

interface WrapOutcome {
  lines: string[];
  /** 超出 maxLines 时，自最后一行起的全部剩余文本（用于字形边界硬截）；未超出为 null。 */
  overflowText: string | null;
}

/**
 * 贪心断行：按测量宽度填行；Latin 词整体挪行（词本身超行宽才允许字形边界内折）；
 * 行首空格丢弃、行尾空格不计入宽度判断（trimEnd 后入行）。
 */
function wrapText(
  text: string,
  fontSize: number,
  weight: FontWeightKey,
  maxWidth: number,
  maxLines: number,
  metrics: TextMetrics,
  wordAwareCjk = false,
  avoidLeadingPunctuation = false,
): WrapOutcome {
  let units = splitUnits(text, wordAwareCjk);
  if (avoidLeadingPunctuation) {
    const grouped: string[] = [];
    for (const unit of units) {
      if (/^[，。！？；：、）】》」』’”!?;,.:]+$/u.test(unit) && grouped.length > 0) {
        grouped[grouped.length - 1] += unit;
      } else {
        grouped.push(unit);
      }
    }
    units = grouped;
  }
  const lines: string[] = [];
  let current = '';
  const fits = (s: string): boolean =>
    metrics.measureWidth(s.trimEnd(), fontSize, weight) <= maxWidth;

  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    if (unit === ' ' && current === '') continue; // 行首空格丢弃
    const candidate = current + unit;
    if (fits(candidate)) {
      current = candidate;
      continue;
    }
    // 装不下 → 需在 unit 前断行。若当前行已是最后一个允许行，剩余全文交给硬截。
    const restAfter = units.slice(i + 1).join('');
    if (current !== '') {
      if (lines.length === maxLines - 1) {
        return { lines, overflowText: candidate + restAfter };
      }
      lines.push(current.trimEnd());
      current = '';
    }
    // 单元自身超行宽（超长 Latin 词）：字形边界内折。
    const chars = Array.from(unit);
    let piece = '';
    for (let j = 0; j < chars.length; j++) {
      const ch = chars[j];
      if (fits(piece + ch)) {
        piece += ch;
        continue;
      }
      if (lines.length === maxLines - 1) {
        return { lines, overflowText: piece + chars.slice(j).join('') + restAfter };
      }
      lines.push(piece);
      piece = ch;
    }
    current = piece;
  }
  if (current.trimEnd() !== '') lines.push(current.trimEnd());
  return { lines, overflowText: null };
}

/** 字形边界硬截：使 (截断串 + …) 宽度不超预算。 */
function truncateToWidth(
  text: string,
  fontSize: number,
  weight: FontWeightKey,
  maxWidth: number,
  metrics: TextMetrics,
): string {
  const chars = Array.from(text);
  while (
    chars.length > 0 &&
    metrics.measureWidth(chars.join('').trimEnd() + ELLIPSIS, fontSize, weight) > maxWidth
  ) {
    chars.pop();
  }
  return chars.join('').trimEnd() + ELLIPSIS;
}

/** 空白归一：剥离产生的连续空格折叠为单个空格并去首尾（保确定性测量）。 */
function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function countGlyphs(text: string): number {
  let n = 0;
  for (const ch of text) {
    if (ch !== ' ') n++;
  }
  return n;
}

interface WrappedBullet {
  lines: string[];
}

function layoutBullets(
  bullets: string[],
  maxLines: number,
  metrics: TextMetrics,
  maxWidth: number,
  wordAwareCjk: boolean,
): WrappedBullet[] {
  return bullets.map((bullet) => {
    const { lines, overflowText } = wrapText(
      bullet,
      BULLET_FONT_SIZE,
      BULLET_WEIGHT,
      maxWidth,
      maxLines,
      metrics,
      wordAwareCjk,
    );
    if (overflowText !== null) {
      lines.push(
        truncateToWidth(overflowText, BULLET_FONT_SIZE, BULLET_WEIGHT, maxWidth, metrics),
      );
    }
    return { lines };
  });
}

function bulletsHeight(items: WrappedBullet[], lineHeightPx: number): number {
  if (items.length === 0) return 0;
  const linesTotal = items.reduce((sum, item) => sum + item.lines.length, 0);
  return linesTotal * lineHeightPx + (items.length - 1) * BULLET_GAP;
}

/**
 * 文字卡纯布局：剥离 → 标题字号阶梯断行 → 要点/标签排布 → 垂直缩减阶梯。
 * 输入仅文案 + 度量句柄；输出定位块模型或显式失败。
 */
export function layoutTextCard(
  input: TextCardLayoutInput,
  metrics: TextMetrics,
  options?: TextCardLayoutOptions,
): TextCardLayoutResult {
  const contentHeight = options?.contentHeightPx ?? CONTENT_HEIGHT;
  const wordAwareCjk = options?.wordAwareCjk ?? false;
  const bulletContentWidth = Math.max(320, Math.min(CONTENT_WIDTH, options?.bulletContentWidthPx ?? CONTENT_WIDTH));
  const reductions: string[] = [];
  let sanitized = false;

  // —— 第一步：未覆盖码点剥离（先于一切排版；spec「字形覆盖与溢出红线」）。 ——
  const titleStrip = metrics.stripUncovered(input.title, TITLE_WEIGHT);
  if (titleStrip.stripped !== '') sanitized = true;
  const title = normalizeWhitespace(titleStrip.kept);
  if (countGlyphs(title) < TITLE_MIN_GLYPHS) {
    if (titleStrip.stripped !== '' && countGlyphs(title) === 0) {
      return {
        ok: false,
        reason: 'glyph_uncovered',
        detail: 'title fully stripped: no covered glyphs remain',
      };
    }
    return {
      ok: false,
      reason: 'invalid_copy',
      detail: `title has ${countGlyphs(title)} glyphs after strip (<${TITLE_MIN_GLYPHS})`,
    };
  }

  const bulletsIn: string[] = [];
  for (const raw of input.bullets) {
    const strip = metrics.stripUncovered(raw, BULLET_WEIGHT);
    if (strip.stripped !== '') sanitized = true;
    const cleaned = normalizeWhitespace(strip.kept);
    if (cleaned !== '') bulletsIn.push(cleaned);
  }
  if (bulletsIn.length > BULLET_MAX_COUNT) {
    bulletsIn.length = BULLET_MAX_COUNT;
    reductions.push(`bullets_capped_to_${BULLET_MAX_COUNT}`);
  }

  const tagsIn: string[] = [];
  for (const raw of input.tags) {
    const strip = metrics.stripUncovered(raw, TAG_WEIGHT);
    if (strip.stripped !== '') sanitized = true;
    const cleaned = normalizeWhitespace(strip.kept).replace(/^#+/, '');
    if (cleaned !== '') tagsIn.push(cleaned);
  }
  if (tagsIn.length > TAG_MAX_COUNT) {
    tagsIn.length = TAG_MAX_COUNT;
    reductions.push(`tags_capped_to_${TAG_MAX_COUNT}`);
  }

  // —— 第二步：标题字号阶梯；最小字号仍超行则末行字形边界硬截 + 省略号。 ——
  let titleFontSize: number = TITLE_FONT_LADDER[TITLE_FONT_LADDER.length - 1];
  let titleLines: string[] = [];
  let truncated = false;
  for (let i = 0; i < TITLE_FONT_LADDER.length; i++) {
    const size = TITLE_FONT_LADDER[i];
    const { lines, overflowText } = wrapText(
      title,
      size,
      TITLE_WEIGHT,
      CONTENT_WIDTH,
      TITLE_MAX_LINES,
      metrics,
      wordAwareCjk,
    );
    if (overflowText === null) {
      titleFontSize = size;
      titleLines = lines;
      break;
    }
    if (i === TITLE_FONT_LADDER.length - 1) {
      titleFontSize = size;
      titleLines = [
        ...lines,
        truncateToWidth(overflowText, size, TITLE_WEIGHT, CONTENT_WIDTH, metrics),
      ];
      truncated = true;
    }
  }
  const titleLineHeightPx = Math.round(titleFontSize * TITLE_LINE_HEIGHT);
  const titleHeight = titleLines.length * titleLineHeightPx;

  // —— 第三步：标签胶囊按度量预算宽度，行内装不下的从尾部裁掉（记账）。 ——
  const bulletLineHeightPx = Math.round(BULLET_FONT_SIZE * BULLET_LINE_HEIGHT);
  const allPills = tagsIn.map((tag) => {
    const text = `#${tag}`;
    return {
      text,
      width: Math.ceil(
        metrics.measureWidth(text, TAG_FONT_SIZE, TAG_WEIGHT) + TAG_PILL_PADDING_X * 2,
      ),
    };
  });
  const pills: Array<{ text: string; width: number }> = [];
  let rowWidth = 0;
  for (const pill of allPills) {
    const next = rowWidth + (pills.length > 0 ? TAG_PILL_GAP : 0) + pill.width;
    if (next > CONTENT_WIDTH) break;
    pills.push(pill);
    rowWidth = next;
  }
  if (pills.length < allPills.length) reductions.push('tags_row_overflow_trimmed');

  // —— 第四步：垂直预算 + 确定性缩减阶梯（要点行数 2→1 → 要点条数 5→3 → 丢标签行）。 ——
  let bulletMaxLines = BULLET_MAX_LINES;
  let maxBullets = BULLET_MAX_COUNT;
  let includeTags = pills.length > 0;
  let bulletItems: WrappedBullet[] = [];
  let totalHeight = 0;
  // 阶梯至多 3 步，循环有界（迭代限界纪律：绝不依赖时钟推进）。
  for (let step = 0; step < 4; step++) {
    bulletItems = layoutBullets(
      bulletsIn.slice(0, maxBullets),
      bulletMaxLines,
      metrics,
      bulletContentWidth,
      wordAwareCjk,
    );
    const bulletsH = bulletsHeight(bulletItems, bulletLineHeightPx);
    totalHeight =
      titleHeight +
      (bulletItems.length > 0 ? GAP_TITLE_BULLETS + bulletsH : 0) +
      (includeTags ? GAP_BULLETS_TAGS + TAG_PILL_HEIGHT : 0);
    if (totalHeight <= contentHeight) break;
    if (bulletMaxLines > 1) {
      bulletMaxLines = 1;
      reductions.push('bullet_maxlines_2_to_1');
    } else if (maxBullets > 3) {
      maxBullets = 3;
      reductions.push('bullet_count_5_to_3');
    } else if (includeTags) {
      includeTags = false;
      reductions.push('drop_tags');
    } else {
      // 生产几何下不可达（最坏组合缩减后必收敛）；测试缝收紧预算时诚实失败，绝不出溢出卡。
      return {
        ok: false,
        reason: 'invalid_copy',
        detail: `vertical_overflow_unresolved: content ${totalHeight}px > budget ${contentHeight}px`,
      };
    }
  }

  // —— 第五步：定位（相对内容区顶部；poster 版式由渲染层用 contentHeight 居中）。 ——
  let y = 0;
  const titleBlock: TitleBlockLayout = {
    fontSize: titleFontSize,
    lineHeightPx: titleLineHeightPx,
    offsetY: 0,
    lines: titleLines,
  };
  y += titleHeight;

  let bulletBlock: BulletBlockLayout | null = null;
  if (bulletItems.length > 0) {
    y += GAP_TITLE_BULLETS;
    bulletBlock = {
      fontSize: BULLET_FONT_SIZE,
      lineHeightPx: bulletLineHeightPx,
      offsetY: y,
      gap: BULLET_GAP,
      items: bulletItems,
    };
    y += bulletsHeight(bulletItems, bulletLineHeightPx);
  }

  let tagBlock: TagBlockLayout | null = null;
  if (includeTags) {
    y += GAP_BULLETS_TAGS;
    tagBlock = {
      fontSize: TAG_FONT_SIZE,
      pillHeight: TAG_PILL_HEIGHT,
      gap: TAG_PILL_GAP,
      offsetY: y,
      pills,
    };
    y += TAG_PILL_HEIGHT;
  }

  return {
    ok: true,
    canvas: { width: CANVAS_WIDTH, height: CANVAS_HEIGHT, padding: CANVAS_PADDING },
    title: titleBlock,
    bullets: bulletBlock,
    tags: tagBlock,
    contentHeight: y,
    truncated,
    sanitized,
    reductions,
  };
}

// ─── 连续文章卡：固定阅读版式，不复用旧要点卡的主题与缩减阶梯 ──────────────

export const ARTICLE_PAGE_MIN_OCCUPANCY = 0.80;
export const ARTICLE_PAGE_MAX_OCCUPANCY = 0.96;
export const ARTICLE_PAGE_TITLE_FONT_SIZE = 50;
export const ARTICLE_PAGE_TITLE_LINE_HEIGHT = 64;
export const ARTICLE_BODY_FONT_SIZE = 36;
export const ARTICLE_BODY_LINE_HEIGHT = 58;
export const ARTICLE_PARAGRAPH_GAP = 25;
export const ARTICLE_COVER_BAND_HEIGHT = 650;

export type ArticleTextCardLayoutKind = 'article_cover' | 'article_page';

export interface ArticleTextCardLayoutInput {
  layoutKind: ArticleTextCardLayoutKind;
  title: string;
  paragraphs: string[];
}

export interface ArticleParagraphLayout {
  fontSize: number;
  lineHeightPx: number;
  offsetY: number;
  gap: number;
  items: Array<{ lines: string[] }>;
}

export interface ArticleTextCardLayoutModel {
  ok: true;
  layoutKind: ArticleTextCardLayoutKind;
  canvas: { width: number; height: number; padding: number };
  title: TitleBlockLayout;
  dividerY: number | null;
  paragraphs: ArticleParagraphLayout;
  contentBottom: number;
  occupancyRatio: number;
  sanitized: boolean;
}

export type ArticleTextCardLayoutResult = ArticleTextCardLayoutModel | TextCardLayoutFailure;

function articleSentences(paragraphs: string[], metrics: TextMetrics): { sentences: string[]; uncovered: boolean } {
  const sentences: string[] = [];
  let uncovered = false;
  for (const raw of paragraphs) {
    const stripped = metrics.stripUncovered(raw, 'regular');
    if (stripped.stripped !== '') uncovered = true;
    const normalized = normalizeWhitespace(stripped.kept);
    if (!normalized) continue;
    const parts = normalized.match(/[^。！？!?；;]+[。！？!?；;]?/gu) ?? [];
    for (const part of parts) {
      const sentence = part.trim();
      if (sentence) sentences.push(sentence);
    }
  }
  return { sentences, uncovered };
}

/**
 * 文章卡纯布局。内容不足和溢出都显式失败，不拉伸行高、不截断、不删除段落。
 * CoverCardWriter 与 renderer 共同调用本函数，因此密度门禁和最终像素使用同一套字宽。
 */
export function layoutArticleTextCard(
  input: ArticleTextCardLayoutInput,
  metrics: TextMetrics,
): ArticleTextCardLayoutResult {
  const titleStrip = metrics.stripUncovered(input.title, TITLE_WEIGHT);
  if (titleStrip.stripped !== '') {
    return { ok: false, reason: 'glyph_uncovered', detail: 'article title contains uncovered glyphs' };
  }
  const title = normalizeWhitespace(titleStrip.kept);
  if (countGlyphs(title) < TITLE_MIN_GLYPHS) {
    return {
      ok: false,
      reason: 'invalid_copy',
      detail: `article title has ${countGlyphs(title)} glyphs after strip (<${TITLE_MIN_GLYPHS})`,
    };
  }

  const normalized = articleSentences(input.paragraphs, metrics);
  if (normalized.uncovered) {
    return { ok: false, reason: 'glyph_uncovered', detail: 'article paragraphs contain uncovered glyphs' };
  }
  if (normalized.sentences.length < 2) {
    return { ok: false, reason: 'invalid_copy', detail: 'article card needs at least 2 sentence paragraphs' };
  }

  const isCover = input.layoutKind === 'article_cover';
  const titleFontSize = isCover ? 78 : ARTICLE_PAGE_TITLE_FONT_SIZE;
  const titleLineHeightPx = isCover ? 96 : ARTICLE_PAGE_TITLE_LINE_HEIGHT;
  const titleMaxLines = isCover ? 4 : 3;
  const titleWrap = wrapText(
    title,
    titleFontSize,
    TITLE_WEIGHT,
    CONTENT_WIDTH,
    titleMaxLines,
    metrics,
    true,
    true,
  );
  if (titleWrap.overflowText !== null || titleWrap.lines.length === 0) {
    return { ok: false, reason: 'invalid_copy', detail: `article title exceeds ${titleMaxLines} lines` };
  }

  const titleOffsetY = isCover ? 118 : 76;
  const titleBottom = titleOffsetY + titleWrap.lines.length * titleLineHeightPx;
  const dividerY = isCover ? null : titleBottom + 28;
  const paragraphOffsetY = isCover ? 748 : titleBottom + 78;
  const bodyFontSize = isCover ? 34 : ARTICLE_BODY_FONT_SIZE;
  const bodyLineHeight = isCover ? 55 : ARTICLE_BODY_LINE_HEIGHT;
  const paragraphGap = isCover ? 24 : ARTICLE_PARAGRAPH_GAP;
  const bodyItems: Array<{ lines: string[] }> = [];
  for (const sentence of normalized.sentences) {
    const wrapped = wrapText(
      sentence,
      bodyFontSize,
      'regular',
      CONTENT_WIDTH,
      3,
      metrics,
      true,
      true,
    );
    if (wrapped.overflowText !== null || wrapped.lines.length === 0) {
      return { ok: false, reason: 'invalid_copy', detail: 'article sentence exceeds 3 lines' };
    }
    bodyItems.push({ lines: wrapped.lines });
  }

  const bodyHeight = bodyItems.reduce(
    (sum, item, index) => sum + item.lines.length * bodyLineHeight + (index > 0 ? paragraphGap : 0),
    0,
  );
  const contentBottom = paragraphOffsetY + bodyHeight;
  const occupancyRatio = contentBottom / CANVAS_HEIGHT;
  if (contentBottom > Math.round(ARTICLE_PAGE_MAX_OCCUPANCY * CANVAS_HEIGHT)) {
    return {
      ok: false,
      reason: 'invalid_copy',
      detail: `article content too dense: occupancy ${occupancyRatio.toFixed(3)} > ${ARTICLE_PAGE_MAX_OCCUPANCY}`,
    };
  }
  if (!isCover && occupancyRatio < ARTICLE_PAGE_MIN_OCCUPANCY) {
    return {
      ok: false,
      reason: 'invalid_copy',
      detail: `article content too sparse: occupancy ${occupancyRatio.toFixed(3)} < ${ARTICLE_PAGE_MIN_OCCUPANCY}`,
    };
  }

  return {
    ok: true,
    layoutKind: input.layoutKind,
    canvas: { width: CANVAS_WIDTH, height: CANVAS_HEIGHT, padding: CANVAS_PADDING },
    title: {
      fontSize: titleFontSize,
      lineHeightPx: titleLineHeightPx,
      offsetY: titleOffsetY,
      lines: titleWrap.lines,
    },
    dividerY,
    paragraphs: {
      fontSize: bodyFontSize,
      lineHeightPx: bodyLineHeight,
      offsetY: paragraphOffsetY,
      gap: paragraphGap,
      items: bodyItems,
    },
    contentBottom,
    occupancyRatio,
    sanitized: false,
  };
}
