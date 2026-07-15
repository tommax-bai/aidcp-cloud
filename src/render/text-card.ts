/**
 * 文字卡渲染 — satori→resvg 胶水层与工厂（design D7/D9/D11）。
 *
 * 契约要点：
 *   - 工厂 lazy 加载 satori 与 @resvg/resvg-js，并对字体做 sha256 校验（对 font-manifest），
 *     任一失败 → 显式告警 + 返回 null：服务启动绝不因渲染栈缺失而崩，调用方诚实降级生成式。
 *   - 渲染输入签名仅 (文案, 主题种子)：无原图像素/URL/取色/坐标/OCR 的任何入口（防搬运，
 *     编译期类型层结构保证）；本渲染器不实现生图提供方接口、不进图源路由表。
 *   - 布局所有权在 text-card-layout 纯函数；satori 只做盒子定位（每行 nowrap）。
 *   - 确定性：同 (文案, seed) 字节级一致 PNG；无 Date.now / Math.random。
 *   - 画布：逻辑 1080×1440 → 输出 1728×2304（与现役生成式配图像素一致）。
 *   - 卡面无水印、无角标、无外链图片（评审裁剪 + 合规走既有元数据）。
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CANVAS_HEIGHT,
  CANVAS_PADDING,
  CANVAS_WIDTH,
  CONTENT_HEIGHT,
  layoutTextCard,
  type TextCardLayoutModel,
} from './text-card-layout.js';
import {
  PALETTES,
  selectTheme,
  type Decoration,
  type LayoutVariant,
  type PaletteKey,
  type ThemeSelection,
} from './palettes.js';
import {
  DEFAULT_FONT_ASSETS_DIR,
  createTextMetrics,
  loadFontManifest,
  type FontManifestWeight,
  type TextMetrics,
} from './text-metrics.js';

/** 输出像素（= 现役生成式配图 AIDCP_SEEDREAM_IMAGE_SIZE，图集内不混尺寸；design D9）。 */
export const OUTPUT_WIDTH = 1728;
export const OUTPUT_HEIGHT = 2304;

/** satori 注册的家族名（须与子集字体 name 表一致，见 scripts/build-font-subset.py）。 */
const FONT_FAMILY = 'AidcpSans SC';

/** 渲染输入文案：洗稿产物（标题/要点/标签），别无其他信息通路。 */
export interface TextCardCopy {
  title: string;
  bullets: string[];
  tags: string[];
}

/** 渲染审计元数据（随 CoverFormAudit 上审计，回放「这张卡怎么排出来的」）。 */
export interface TextCardRenderMeta {
  themeKey: string;
  paletteKey: string;
  layoutKey: string;
  titleFontSize: number;
  titleLineCount: number;
  truncated: boolean;
  sanitized: boolean;
  reductions: string[];
  styleSource?: 'reference_analysis';
  backgroundTreatment?: TextCardBackgroundTreatment;
  backgroundPattern?: TextCardBackgroundPattern;
  bulletPresentation?: TextCardBulletPresentation;
  pageMarker?: string;
}

/** 渲染显式结果：成功带 PNG 字节 + meta；失败带原因枚举（绝不静默假成功）。 */
export type TextCardRenderResult =
  | { ok: true; png: Buffer; meta: TextCardRenderMeta }
  | { ok: false; reason: 'invalid_copy' | 'glyph_uncovered' | 'render_failed'; detail?: string };

export type TextCardBackgroundTreatment = 'solid' | 'soft_gradient';
export type TextCardBackgroundPattern = 'none' | 'fine_grid' | 'dot_grid';
export type TextCardBulletPresentation = 'plain' | 'cards' | 'numbered_cards' | 'callout';

/**
 * 来源视觉分析派生出的白名单设计令牌。只允许内部枚举和分页位置，类型层禁止原图 URL、像素、坐标和 OCR 文本进入 renderer。
 */
export interface TextCardSourceStyle {
  source: 'reference_analysis';
  paletteKey: PaletteKey;
  layout: LayoutVariant;
  decoration: Decoration;
  backgroundTreatment: TextCardBackgroundTreatment;
  backgroundPattern: TextCardBackgroundPattern;
  bulletPresentation: TextCardBulletPresentation;
  showPageMarker: boolean;
  pageIndex: number;
  pageTotal: number;
  wordAwareCjk: boolean;
  fidelityMode: 'balanced' | 'strict';
}

/** 主题种子：缺省仍由 accountId/postKey 决定；来源风格存在时只接受上述白名单设计令牌。 */
export interface TextCardSeed {
  accountId: string;
  postKey: string;
  sourceStyle?: TextCardSourceStyle;
}

/** 渲染器公开契约（独立注入依赖；勿实现生图提供方接口、勿进路由表——design D11）。 */
export interface TextCardRenderer {
  render(copy: TextCardCopy, seed: TextCardSeed): Promise<TextCardRenderResult>;
}

/** 中间产物（测试用：SVG 与 RGBA 像素来自同一次 resvg render()，用于越界像素断言）。 */
export type TextCardRenderRaw =
  | {
      ok: true;
      svg: string;
      png: Buffer;
      /** resvg render() 的 RGBA 像素（OUTPUT_WIDTH×OUTPUT_HEIGHT×4）。 */
      pixels: Buffer;
      width: number;
      height: number;
      meta: TextCardRenderMeta;
      theme: ThemeSelection;
    }
  | { ok: false; reason: 'invalid_copy' | 'glyph_uncovered' | 'render_failed'; detail?: string };

/** 内部扩展契约：render 之外暴露 renderRaw 供测试取像素/SVG（不进公开 index 导出面）。 */
export interface TextCardRendererInternal extends TextCardRenderer {
  renderRaw(copy: TextCardCopy, seed: TextCardSeed): Promise<TextCardRenderRaw>;
}

export interface TextCardRendererOptions {
  /** 字体资产目录（默认仓内 assets/fonts）。 */
  assetsDir?: string;
  logger?: { warn: (message: string) => void };
}

/** satori 元素树节点（object-JSX：纯对象、免 react）。 */
interface SatoriNode {
  type: 'div';
  props: {
    style: Record<string, string | number>;
    children?: SatoriNode[] | string;
  };
}

type SatoriFn = (element: unknown, options: unknown) => Promise<string>;

interface ResvgRendered {
  width: number;
  height: number;
  pixels: Buffer;
  asPng(): Buffer;
}

type ResvgCtor = new (
  svg: string,
  options: unknown,
) => { render(): ResvgRendered };

function textLineNode(
  text: string,
  x: number,
  y: number,
  lineHeightPx: number,
  fontSize: number,
  fontWeight: number,
  color: string,
): SatoriNode {
  return {
    type: 'div',
    props: {
      style: {
        position: 'absolute',
        left: x,
        top: y,
        height: lineHeightPx,
        display: 'flex',
        alignItems: 'center',
        whiteSpace: 'nowrap',
        lineHeight: 1,
        fontFamily: FONT_FAMILY,
        fontSize,
        fontWeight,
        color,
      },
      children: text,
    },
  };
}

/** 角部装饰：简单绝对定位形状，仅落画布角部（远离中线/底部——像素断言取样点即避开角部）。 */
function decorationNodes(theme: ThemeSelection): SatoriNode[] {
  if (theme.decoration === 'corner-arc') {
    // 圆心置于右上角点，四分之一圆入画。
    return [
      {
        type: 'div',
        props: {
          style: {
            position: 'absolute',
            left: CANVAS_WIDTH - 220,
            top: -220,
            width: 440,
            height: 440,
            borderRadius: 220,
            backgroundColor: theme.palette.bgAccent,
          },
        },
      },
    ];
  }
  if (theme.decoration === 'dot-grid') {
    // 右上角 4×4 点阵，落在 padding 檐口内（x>984, y<98），不与任何文本相交。
    const nodes: SatoriNode[] = [];
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 4; col++) {
        nodes.push({
          type: 'div',
          props: {
            style: {
              position: 'absolute',
              left: 996 + col * 22,
              top: 20 + row * 22,
              width: 12,
              height: 12,
              borderRadius: 6,
              backgroundColor: theme.palette.accent,
            },
          },
        });
      }
    }
    return nodes;
  }
  return [];
}

function fineGridNodes(theme: ThemeSelection): SatoriNode[] {
  const nodes: SatoriNode[] = [];
  for (let x = 0; x <= CANVAS_WIDTH; x += 90) {
    nodes.push({
      type: 'div',
      props: {
        style: {
          position: 'absolute', left: x, top: 0, width: 1, height: CANVAS_HEIGHT,
          backgroundColor: theme.palette.bgAccent, opacity: 0.45,
        },
      },
    });
  }
  for (let y = 0; y <= CANVAS_HEIGHT; y += 90) {
    nodes.push({
      type: 'div',
      props: {
        style: {
          position: 'absolute', left: 0, top: y, width: CANVAS_WIDTH, height: 1,
          backgroundColor: theme.palette.bgAccent, opacity: 0.45,
        },
      },
    });
  }
  return nodes;
}

function sourceTheme(seed: TextCardSeed): ThemeSelection {
  const fallback = selectTheme(seed.accountId, seed.postKey);
  const style = seed.sourceStyle;
  if (!style) return fallback;
  const palette = PALETTES.find((candidate) => candidate.key === style.paletteKey) ?? fallback.palette;
  const decoration = style.backgroundPattern === 'dot_grid' ? 'dot-grid' : style.decoration;
  return {
    themeKey: `${palette.key}:${style.layout}:${decoration}:reference`,
    palette,
    layout: style.layout,
    decoration,
  };
}

function cardBackgroundNode(top: number, height: number, theme: ThemeSelection): SatoriNode {
  return {
    type: 'div',
    props: {
      style: {
        position: 'absolute',
        left: CANVAS_PADDING - 24,
        top,
        width: CANVAS_WIDTH - (CANVAS_PADDING - 24) * 2,
        height,
        borderRadius: 20,
        backgroundColor: theme.palette.bg,
        border: `2px solid ${theme.palette.bgAccent}`,
      },
    },
  };
}

/** 由布局模型 + 主题拼 satori 元素树（satori 只做盒子定位，断行已在布局层完成）。 */
function buildCardTree(
  model: TextCardLayoutModel,
  theme: ThemeSelection,
  copy: TextCardCopy,
  sourceStyle?: TextCardSourceStyle,
): SatoriNode {
  const children: SatoriNode[] = [
    ...(sourceStyle?.backgroundPattern === 'fine_grid' ? fineGridNodes(theme) : []),
    ...decorationNodes(theme),
  ];
  const { palette } = theme;
  const headerReserve = sourceStyle?.showPageMarker ? 64 : 0;
  // poster 版式：内容块整体垂直居中；editorial：顶对齐。
  const contentTop =
    CANVAS_PADDING + headerReserve +
    (theme.layout === 'poster'
      ? Math.max(0, Math.floor((CONTENT_HEIGHT - headerReserve - model.contentHeight) / 2))
      : 0);

  if (sourceStyle?.showPageMarker) {
    const label = (copy.tags[0] ?? 'NOTE').replace(/^#+/, '').slice(0, 16) || 'NOTE';
    const page = `${String(sourceStyle.pageIndex + 1).padStart(2, '0')} / ${String(sourceStyle.pageTotal).padStart(2, '0')}`;
    children.push(textLineNode(label, CANVAS_PADDING, 48, 36, 28, 700, palette.title));
    children.push(textLineNode(page, CANVAS_WIDTH - CANVAS_PADDING - 132, 48, 36, 28, 700, palette.accent));
  }

  model.title.lines.forEach((line, index) => {
    children.push(
      textLineNode(
        line,
        CANVAS_PADDING,
        contentTop + model.title.offsetY + index * model.title.lineHeightPx,
        model.title.lineHeightPx,
        model.title.fontSize,
        700,
        palette.title,
      ),
    );
  });

  if (model.bullets) {
    let y = contentTop + model.bullets.offsetY;
    const presentation = sourceStyle?.bulletPresentation ?? 'plain';
    if (presentation === 'callout') {
      const blockHeight = model.bullets.items.reduce(
        (sum, item, index) => sum + item.lines.length * model.bullets!.lineHeightPx + (index > 0 ? model.bullets!.gap : 0),
        0,
      );
      children.push(cardBackgroundNode(y - 20, blockHeight + 40, theme));
    }
    for (let itemIndex = 0; itemIndex < model.bullets.items.length; itemIndex++) {
      const item = model.bullets.items[itemIndex];
      const itemHeight = item.lines.length * model.bullets.lineHeightPx;
      if (presentation === 'cards' || presentation === 'numbered_cards') {
        children.push(cardBackgroundNode(y - 14, itemHeight + 28, theme));
      }
      if (presentation === 'numbered_cards') {
        children.push({
          type: 'div',
          props: {
            style: {
              position: 'absolute', left: CANVAS_PADDING, top: y + 3, width: 58, height: 58,
              display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 14,
              backgroundColor: palette.accent, color: palette.bg, fontFamily: FONT_FAMILY,
              fontSize: 30, fontWeight: 700, lineHeight: 1,
            },
            children: String(itemIndex + 1),
          },
        });
      }
      for (const line of item.lines) {
        children.push(
          textLineNode(
            line,
            CANVAS_PADDING + (presentation === 'numbered_cards' ? 82 : 0),
            y,
            model.bullets.lineHeightPx,
            model.bullets.fontSize,
            400,
            palette.title,
          ),
        );
        y += model.bullets.lineHeightPx;
      }
      y += model.bullets.gap;
    }
  }

  if (model.tags) {
    children.push({
      type: 'div',
      props: {
        style: {
          position: 'absolute',
          left: CANVAS_PADDING,
          top: contentTop + model.tags.offsetY,
          display: 'flex',
          flexDirection: 'row',
          gap: model.tags.gap,
        },
        children: model.tags.pills.map(
          (pill): SatoriNode => ({
            type: 'div',
            props: {
              style: {
                width: pill.width,
                height: model.tags!.pillHeight,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: Math.floor(model.tags!.pillHeight / 2),
                backgroundColor: palette.pillBg,
                color: palette.pillText,
                fontFamily: FONT_FAMILY,
                fontSize: model.tags!.fontSize,
                fontWeight: 400,
                whiteSpace: 'nowrap',
                lineHeight: 1,
              },
              children: pill.text,
            },
          }),
        ),
      },
    });
  }

  return {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        position: 'relative',
        width: CANVAS_WIDTH,
        height: CANVAS_HEIGHT,
        backgroundColor: palette.bg,
        ...(sourceStyle?.backgroundTreatment === 'soft_gradient'
          ? { backgroundImage: `linear-gradient(135deg, ${palette.bg} 0%, #FFFFFF 52%, ${palette.bgAccent} 100%)` }
          : {}),
        fontFamily: FONT_FAMILY,
      },
      children,
    },
  };
}

class SatoriTextCardRenderer implements TextCardRendererInternal {
  constructor(
    private readonly satori: SatoriFn,
    private readonly Resvg: ResvgCtor,
    private readonly metrics: TextMetrics,
    private readonly regularFont: Buffer,
    private readonly boldFont: Buffer,
  ) {}

  async render(copy: TextCardCopy, seed: TextCardSeed): Promise<TextCardRenderResult> {
    const raw = await this.renderRaw(copy, seed);
    if (!raw.ok) return raw;
    return { ok: true, png: raw.png, meta: raw.meta };
  }

  async renderRaw(copy: TextCardCopy, seed: TextCardSeed): Promise<TextCardRenderRaw> {
    const theme = sourceTheme(seed);
    const sourceStyle = seed.sourceStyle;
    const headerReserve = sourceStyle?.showPageMarker ? 64 : 0;
    const model = layoutTextCard(
      { title: copy.title, bullets: copy.bullets, tags: copy.tags },
      this.metrics,
      sourceStyle
        ? {
            contentHeightPx: CONTENT_HEIGHT - headerReserve,
            wordAwareCjk: sourceStyle.wordAwareCjk,
            bulletContentWidthPx: sourceStyle.bulletPresentation === 'numbered_cards' ? CANVAS_WIDTH - CANVAS_PADDING * 2 - 82 : undefined,
          }
        : undefined,
    );
    if (!model.ok) {
      return { ok: false, reason: model.reason, detail: model.detail };
    }

    const meta: TextCardRenderMeta = {
      themeKey: theme.themeKey,
      paletteKey: theme.palette.key,
      layoutKey: theme.layout,
      titleFontSize: model.title.fontSize,
      titleLineCount: model.title.lines.length,
      truncated: model.truncated,
      sanitized: model.sanitized,
      reductions: model.reductions,
      ...(sourceStyle
        ? {
            styleSource: 'reference_analysis' as const,
            backgroundTreatment: sourceStyle.backgroundTreatment,
            backgroundPattern: sourceStyle.backgroundPattern,
            bulletPresentation: sourceStyle.bulletPresentation,
            ...(sourceStyle.showPageMarker
              ? { pageMarker: `${sourceStyle.pageIndex + 1}/${sourceStyle.pageTotal}` }
              : {}),
          }
        : {}),
    };

    try {
      const tree = buildCardTree(model, theme, copy, sourceStyle);
      const svg = await this.satori(tree, {
        width: CANVAS_WIDTH,
        height: CANVAS_HEIGHT,
        fonts: [
          { name: FONT_FAMILY, data: this.regularFont, weight: 400, style: 'normal' },
          { name: FONT_FAMILY, data: this.boldFont, weight: 700, style: 'normal' },
        ],
      });
      const resvg = new this.Resvg(svg, {
        fitTo: { mode: 'width', value: OUTPUT_WIDTH },
        font: { loadSystemFonts: false },
      });
      const rendered = resvg.render();
      if (rendered.width !== OUTPUT_WIDTH || rendered.height !== OUTPUT_HEIGHT) {
        return {
          ok: false,
          reason: 'render_failed',
          detail: `unexpected raster size ${rendered.width}x${rendered.height}`,
        };
      }
      const pixels = rendered.pixels;
      const png = rendered.asPng();
      return {
        ok: true,
        svg,
        png,
        pixels,
        width: rendered.width,
        height: rendered.height,
        meta,
        theme,
      };
    } catch (err) {
      return {
        ok: false,
        reason: 'render_failed',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

function readVerifiedFont(assetsDir: string, weight: FontManifestWeight): Buffer {
  const filePath = join(assetsDir, weight.file);
  const data = readFileSync(filePath);
  const sha256 = createHash('sha256').update(data).digest('hex');
  if (sha256 !== weight.sha256) {
    throw new Error(
      `font sha256 mismatch for ${weight.file}: expected ${weight.sha256}, got ${sha256}`,
    );
  }
  return data;
}

/**
 * 渲染器工厂：lazy 加载渲染栈 + 字体 sha256 校验。
 * 任一环节失败 → 显式 warn + 返回 null（服务照常启动；text_card 请求诚实降级生成式，
 * 由调用方审计 renderer_unavailable——spec「确定性云端渲染栈与诚实降级」）。
 */
export async function createTextCardRenderer(
  opts?: TextCardRendererOptions,
): Promise<TextCardRenderer | null> {
  const logger = opts?.logger ?? console;
  const assetsDir = opts?.assetsDir ?? DEFAULT_FONT_ASSETS_DIR;
  try {
    const manifest = loadFontManifest(assetsDir);
    const metrics = createTextMetrics(assetsDir);
    const regularFont = readVerifiedFont(assetsDir, manifest.weights.regular);
    const boldFont = readVerifiedFont(assetsDir, manifest.weights.bold);
    const satoriModule = (await import('satori')) as { default: unknown };
    const resvgModule = (await import('@resvg/resvg-js')) as { Resvg: unknown };
    const satoriFn = satoriModule.default as SatoriFn;
    const Resvg = resvgModule.Resvg as ResvgCtor;
    if (typeof satoriFn !== 'function' || typeof Resvg !== 'function') {
      throw new Error('satori/@resvg/resvg-js module shape unexpected');
    }
    return new SatoriTextCardRenderer(satoriFn, Resvg, metrics, regularFont, boldFont);
  } catch (err) {
    logger.warn(
      `[text-card] renderer unavailable, text_card covers will degrade to generative: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}
