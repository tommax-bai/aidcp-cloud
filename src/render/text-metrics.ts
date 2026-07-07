/**
 * 文字卡渲染 — 字宽度量层。
 *
 * 只读 assets/fonts/font-manifest.json 里的每码点 advance（font units），
 * 运行时零字体解析：断行/字号阶梯/垂直缩减全部据此纯函数推进（design D8/D11）。
 * 本层所有函数确定性：无 Date.now / Math.random / IO 之外的任何环境依赖。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 字重键：与 font-manifest.json weights 键一致（Regular=400 / Bold=700）。 */
export type FontWeightKey = 'regular' | 'bold';

/** manifest 单字重段：文件名 + sha256 + 每码点 advance（键为小写 hex 码点）。 */
export interface FontManifestWeight {
  file: string;
  sha256: string;
  advances: Record<string, number>;
}

/** font-manifest.json 顶层结构（由 scripts/build-font-subset.py 生成）。 */
export interface FontManifest {
  unitsPerEm: number;
  generatedBy: string;
  sourceNote: string;
  weights: { regular: FontManifestWeight; bold: FontManifestWeight };
}

/**
 * 行宽安全系数（2.5%）。
 *
 * 布局所有权契约（design D11 must-fix）：断行由自算 advance 行宽决定、satori 只做
 * 盒子定位（每行 nowrap）；自算宽与 satori 实际排版存在字形度量差（Latin kerning、
 * 标点挤压），行宽预算内置 2-3% 安全系数吸收——CJK 无 kerning 基本零损、Latin 混排吃余量。
 * 该余量是契约的一部分，混排 golden 测试断言渲染产物无越界像素。
 */
export const WIDTH_SAFETY_FACTOR = 1.025;

/** 默认字体资产目录：<repo>/assets/fonts（相对本模块源码位置解析，tsx 直跑源码成立）。 */
export const DEFAULT_FONT_ASSETS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'assets',
  'fonts',
);

const manifestCache = new Map<string, FontManifest>();

/** 惰性加载并缓存 font-manifest.json（按目录缓存；文件缺失/损坏时抛错，由调用方决定降级）。 */
export function loadFontManifest(assetsDir: string = DEFAULT_FONT_ASSETS_DIR): FontManifest {
  const cached = manifestCache.get(assetsDir);
  if (cached) return cached;
  const raw = readFileSync(join(assetsDir, 'font-manifest.json'), 'utf8');
  const parsed = JSON.parse(raw) as FontManifest;
  if (
    typeof parsed.unitsPerEm !== 'number' ||
    !parsed.weights?.regular?.advances ||
    !parsed.weights?.bold?.advances
  ) {
    throw new Error('font-manifest.json malformed: missing unitsPerEm/weights.advances');
  }
  manifestCache.set(assetsDir, parsed);
  return parsed;
}

/** 度量句柄：绑定某一 manifest 的纯函数集合（布局层以此为唯一宽度来源）。 */
export interface TextMetrics {
  manifest: FontManifest;
  /** 文本渲染宽度（px）= Σ(advance/unitsPerEm×fontSize) × 安全系数；未覆盖码点计 0（须先剥离）。 */
  measureWidth(text: string, fontSizePx: number, weight: FontWeightKey): number;
  /** 码点是否被该字重字体覆盖（cmap 预检）。 */
  isCovered(codepoint: number, weight: FontWeightKey): boolean;
  /** 剥离未覆盖码点（含 emoji/变体选择符）：kept=保留串，stripped=被剥字符拼接。 */
  stripUncovered(text: string, weight: FontWeightKey): { kept: string; stripped: string };
}

/** 构造绑定指定资产目录的度量句柄（默认仓内 assets/fonts）。 */
export function createTextMetrics(assetsDir: string = DEFAULT_FONT_ASSETS_DIR): TextMetrics {
  const manifest = loadFontManifest(assetsDir);
  const advancesOf = (weight: FontWeightKey): Record<string, number> =>
    weight === 'bold' ? manifest.weights.bold.advances : manifest.weights.regular.advances;

  const isCovered = (codepoint: number, weight: FontWeightKey): boolean =>
    advancesOf(weight)[codepoint.toString(16)] !== undefined;

  const measureWidth = (text: string, fontSizePx: number, weight: FontWeightKey): number => {
    const advances = advancesOf(weight);
    let unitsSum = 0;
    for (const ch of text) {
      const advance = advances[ch.codePointAt(0)!.toString(16)];
      if (advance !== undefined) unitsSum += advance;
    }
    return (unitsSum / manifest.unitsPerEm) * fontSizePx * WIDTH_SAFETY_FACTOR;
  };

  const stripUncovered = (
    text: string,
    weight: FontWeightKey,
  ): { kept: string; stripped: string } => {
    let kept = '';
    let stripped = '';
    for (const ch of text) {
      if (isCovered(ch.codePointAt(0)!, weight)) kept += ch;
      else stripped += ch;
    }
    return { kept, stripped };
  };

  return { manifest, measureWidth, isCovered, stripUncovered };
}

let defaultMetrics: TextMetrics | null = null;

function getDefaultMetrics(): TextMetrics {
  if (!defaultMetrics) defaultMetrics = createTextMetrics();
  return defaultMetrics;
}

/** 便捷导出：默认资产目录下的宽度测量（见 TextMetrics.measureWidth）。 */
export function measureWidth(text: string, fontSizePx: number, weight: FontWeightKey): number {
  return getDefaultMetrics().measureWidth(text, fontSizePx, weight);
}

/** 便捷导出：默认资产目录下的覆盖预检（见 TextMetrics.isCovered）。 */
export function isCovered(codepoint: number, weight: FontWeightKey): boolean {
  return getDefaultMetrics().isCovered(codepoint, weight);
}

/** 便捷导出：默认资产目录下的未覆盖码点剥离（见 TextMetrics.stripUncovered）。 */
export function stripUncovered(
  text: string,
  weight: FontWeightKey,
): { kept: string; stripped: string } {
  return getDefaultMetrics().stripUncovered(text, weight);
}
