/**
 * 文字卡来源风格的**纯类型契约**（kernel 段）。
 *
 * 只含设计令牌枚举与 TextCardSourceStyle 接口，无色板 hex 数据、无渲染函数、无哈希选取逻辑——
 * 那些（PALETTES 数据、selectTheme / fnv1a / satori 胶水）留在 src/render/（content）。
 * 本文件是色板键 / 版式 / 装饰三个联合的**唯一权威**：render/palettes.ts 以 `satisfies` 让其
 * 常量数据逐字对齐本联合（增删色板两处同改，编译期兜底）。
 *
 * 类型层刻意**不含**原图 URL / 像素 / 坐标 / OCR 文本任何字段（防搬运结构隔离，design D13）。
 */

/** 色板键（8 套浅底高对比色板；与 render/palettes.ts 的 PALETTES 数据逐字对齐）。 */
export type PaletteKey = 'cream' | 'oat' | 'pale-blue' | 'pale-green' | 'blush' | 'lavender' | 'warm-gray' | 'mint';

/** 版式：editorial=顶对齐；poster=内容块整体垂直居中。 */
export type LayoutVariant = 'editorial' | 'poster';

/** 角部装饰（简单形状，绝不含水印/角标）。 */
export type Decoration = 'none' | 'corner-arc' | 'dot-grid';

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
