/**
 * 文字卡渲染 — 主题模板表与确定性选取（design D10）。
 *
 * 8 色板 × 2 版式 × 3 角部装饰 = 48 离散组合，全部本系统自有：
 *   - FNV-1a(accountId) 定该账号的主配色对与版式（账号内视觉身份稳定 = 像真人品牌）；
 *   - FNV-1a(accountId + ':' + postKey) 只定装饰选择（账号间分散、不可聚类）。
 * 色板 hex 固定不抖、无位置抖动层（评审裁剪）；种子刻意不含随机运行令牌——
 * 同一（账号, 帖子）重试字节恒定为可测不变量。绝不从参照图取色（防搬运）。
 * 对比度红线：全表 标题/背景 与 胶囊文字/胶囊底 ≥ 4.5:1，由离线单测全表校验。
 */

/** 色板：浅底高对比家族（键仅用于审计与测试断言，不进卡面）。 */
export interface Palette {
  key: string;
  /** 画布底色（浅）。 */
  bg: string;
  /** 装饰用同族浅色（角弧/点阵）。 */
  bgAccent: string;
  /** 标题/正文主色（深）。 */
  title: string;
  /** 强调色（装饰细节备用）。 */
  accent: string;
  /** 标签胶囊底色。 */
  pillBg: string;
  /** 标签胶囊文字色。 */
  pillText: string;
}

/** 8 套浅底高对比色板（cream/oat/pale-blue/pale-green/blush/lavender/warm-gray/mint）。 */
export const PALETTES: readonly Palette[] = [
  {
    key: 'cream',
    bg: '#FBF4E4',
    bgAccent: '#F1E5C9',
    title: '#3E3226',
    accent: '#C57B32',
    pillBg: '#F0E3C4',
    pillText: '#4A3B24',
  },
  {
    key: 'oat',
    bg: '#F5EFE6',
    bgAccent: '#E9DFCE',
    title: '#3B342B',
    accent: '#A9803E',
    pillBg: '#EBE1CE',
    pillText: '#49402F',
  },
  {
    key: 'pale-blue',
    bg: '#EDF3F8',
    bgAccent: '#DAE7F1',
    title: '#24354A',
    accent: '#4A7FB5',
    pillBg: '#DBE7F1',
    pillText: '#2A415C',
  },
  {
    key: 'pale-green',
    bg: '#EEF5EC',
    bgAccent: '#DCEBD7',
    title: '#26382A',
    accent: '#588F5F',
    pillBg: '#DCEAD6',
    pillText: '#2E4A34',
  },
  {
    key: 'blush',
    bg: '#FAF0EE',
    bgAccent: '#F3DEDA',
    title: '#46282B',
    accent: '#B56064',
    pillBg: '#F2DEDA',
    pillText: '#5C3438',
  },
  {
    key: 'lavender',
    bg: '#F3F0FA',
    bgAccent: '#E5DFF3',
    title: '#322B4A',
    accent: '#7A6BB5',
    pillBg: '#E5DFF3',
    pillText: '#3E355C',
  },
  {
    key: 'warm-gray',
    bg: '#F4F2EF',
    bgAccent: '#E6E2DC',
    title: '#35322D',
    accent: '#8C8273',
    pillBg: '#E8E4DE',
    pillText: '#443F38',
  },
  {
    key: 'mint',
    bg: '#ECF6F2',
    bgAccent: '#D8ECE3',
    title: '#1F3B33',
    accent: '#4F9B82',
    pillBg: '#D8ECE2',
    pillText: '#284B40',
  },
] as const;

/** 版式：editorial=顶对齐；poster=内容块整体垂直居中。 */
export const LAYOUT_VARIANTS = ['editorial', 'poster'] as const;
export type LayoutVariant = (typeof LAYOUT_VARIANTS)[number];

/** 角部装饰（简单形状，绝不含水印/角标）。 */
export const DECORATIONS = ['none', 'corner-arc', 'dot-grid'] as const;
export type Decoration = (typeof DECORATIONS)[number];

/** FNV-1a 32-bit 哈希（UTF-8 字节流；无符号返回）。 */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(input)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** 主题选取结果（themeKey = palette:layout:decoration，进渲染审计 meta）。 */
export interface ThemeSelection {
  themeKey: string;
  palette: Palette;
  layout: LayoutVariant;
  decoration: Decoration;
}

/**
 * 确定性主题选取：账号哈希定色板+版式（跨帖稳定），(账号,帖子) 种子只定装饰。
 * postKey 由调用方给定（sourceId，缺则标题哈希——见 design D10），绝不含随机运行令牌。
 */
export function selectTheme(accountId: string, postKey: string): ThemeSelection {
  const accountHash = fnv1a(accountId);
  const palette = PALETTES[accountHash % PALETTES.length];
  const layout = LAYOUT_VARIANTS[(accountHash >>> 8) % LAYOUT_VARIANTS.length];
  const postHash = fnv1a(`${accountId}:${postKey}`);
  const decoration = DECORATIONS[postHash % DECORATIONS.length];
  return {
    themeKey: `${palette.key}:${layout}:${decoration}`,
    palette,
    layout,
    decoration,
  };
}

function srgbChannelToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** 解析 #RRGGBB 为 [r,g,b]（0-255）。 */
export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) throw new Error(`invalid hex color: ${hex}`);
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

/** WCAG 相对亮度。 */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return (
    0.2126 * srgbChannelToLinear(r) +
    0.7152 * srgbChannelToLinear(g) +
    0.0722 * srgbChannelToLinear(b)
  );
}

/** WCAG 对比度（≥1；模板表红线为 ≥4.5:1，离线单测全表校验）。 */
export function contrastRatio(hexA: string, hexB: string): number {
  const la = relativeLuminance(hexA);
  const lb = relativeLuminance(hexB);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}
