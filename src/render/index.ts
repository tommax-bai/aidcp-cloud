/**
 * 文字卡渲染模块公开出口（openspec change textcard-cover-form 批 B）。
 *
 * 分层：text-metrics（manifest 字宽度量）→ text-card-layout（纯排版）→
 * palettes（主题模板表 + 确定性选取）→ text-card（satori→resvg 胶水 + lazy 工厂）。
 * 渲染器为独立注入依赖：不实现生图提供方接口、不进图源路由表（design D11）。
 */

export {
  WIDTH_SAFETY_FACTOR,
  DEFAULT_FONT_ASSETS_DIR,
  loadFontManifest,
  createTextMetrics,
  measureWidth,
  isCovered,
  stripUncovered,
  type FontWeightKey,
  type FontManifest,
  type FontManifestWeight,
  type TextMetrics,
} from './text-metrics.js';

export {
  CANVAS_WIDTH,
  CANVAS_HEIGHT,
  CANVAS_PADDING,
  CONTENT_WIDTH,
  CONTENT_HEIGHT,
  TITLE_FONT_LADDER,
  TITLE_MAX_LINES,
  TITLE_MIN_GLYPHS,
  BULLET_MAX_COUNT,
  BULLET_MAX_LINES,
  TAG_MAX_COUNT,
  layoutTextCard,
  type TextCardLayoutInput,
  type TextCardLayoutModel,
  type TextCardLayoutFailure,
  type TextCardLayoutResult,
  type TextCardLayoutOptions,
} from './text-card-layout.js';

export {
  PALETTES,
  LAYOUT_VARIANTS,
  DECORATIONS,
  fnv1a,
  selectTheme,
  contrastRatio,
  hexToRgb,
  relativeLuminance,
  type Palette,
  type LayoutVariant,
  type Decoration,
  type ThemeSelection,
} from './palettes.js';

export {
  OUTPUT_WIDTH,
  OUTPUT_HEIGHT,
  createTextCardRenderer,
  type TextCardCopy,
  type TextCardRenderMeta,
  type TextCardRenderResult,
  type TextCardSeed,
  type TextCardRenderer,
  type TextCardRendererOptions,
} from './text-card.js';
