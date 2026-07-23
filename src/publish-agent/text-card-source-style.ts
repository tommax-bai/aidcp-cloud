import type { PaletteKey } from '../render/palettes.js';
import type {
  TextCardBackgroundPattern,
  TextCardBulletPresentation,
  TextCardSourceStyle,
} from '../render/text-card.js';
import type { ReferenceVisualAnalysis, VisualFrameSpec } from '../kernel/visual-reference-types.js';

function searchable(frame: VisualFrameSpec, analysis: ReferenceVisualAnalysis): string {
  const cluster = analysis.styleClusters?.find((item) => item.id === frame.clusterId);
  return [
    frame.common.palette.join(' '),
    frame.common.composition,
    frame.common.focalHierarchy,
    frame.common.negativeSpace,
    frame.common.texture,
    JSON.stringify(frame.details),
    analysis.setStyleBible?.palette.join(' '),
    analysis.setStyleBible?.summary,
    analysis.setStyleBible?.hierarchy,
    analysis.setStyleBible?.whitespace,
    analysis.setStyleBible?.continuityRules.join(' '),
    cluster?.palette.join(' '),
    cluster?.summary,
    cluster?.traits.join(' '),
  ].filter(Boolean).join(' ').toLowerCase();
}

function paletteKey(text: string, analysis: ReferenceVisualAnalysis): PaletteKey {
  if (/薄荷|青绿|青色|mint|teal|cyan|emerald/.test(text)) return 'mint';
  if (/浅绿|淡绿|绿色|green/.test(text)) return 'pale-green';
  if (/浅蓝|淡蓝|蓝灰|蓝色|blue/.test(text)) return 'pale-blue';
  if (/薰衣草|淡紫|紫色|lavender|purple/.test(text)) return 'lavender';
  if (/腮红|淡粉|粉色|blush|pink|rose/.test(text)) return 'blush';
  if (/奶油|象牙|米白|cream|ivory/.test(text)) return 'cream';
  if (/燕麦|米色|卡其|oat|beige|khaki/.test(text)) return 'oat';
  if (/暖灰|灰色|gray|grey/.test(text)) return 'warm-gray';
  if (analysis.setStyleBible?.colorTemperature === 'cool') return 'pale-blue';
  if (analysis.setStyleBible?.colorTemperature === 'warm') return 'oat';
  return 'warm-gray';
}

function backgroundPattern(text: string): TextCardBackgroundPattern {
  if (/细网格|方格|坐标纸|grid/.test(text)) return 'fine_grid';
  if (/点阵|圆点|dot/.test(text)) return 'dot_grid';
  return 'none';
}

function bulletPresentation(frame: VisualFrameSpec, text: string): TextCardBulletPresentation {
  const hasNumbering = /编号|序号|数字徽标|数字卡|numbered|number badge/.test(text);
  const hasCards = /卡片|圆角|边框|描边|信息区|模块|分区|色块|card|panel|box/.test(text);
  if (frame.sequenceRole === 'cover' && hasCards) return 'callout';
  if (hasNumbering) return 'numbered_cards';
  if (hasCards || frame.kind === 'ui_document') return 'cards';
  return 'plain';
}

/** 将自由文本视觉分析收窄为 renderer 可消费的白名单设计令牌。 */
export function deriveTextCardSourceStyle(
  frame: VisualFrameSpec,
  analysis: ReferenceVisualAnalysis,
  pageIndex: number,
  pageTotal: number,
): TextCardSourceStyle | undefined {
  if (!['text_layout', 'ui_document', 'infographic_chart'].includes(frame.kind)) return undefined;
  const text = searchable(frame, analysis);
  const pattern = backgroundPattern(text);
  return {
    source: 'reference_analysis',
    paletteKey: paletteKey(text, analysis),
    layout: 'editorial',
    decoration: pattern === 'dot_grid' ? 'dot-grid' : /圆弧|弧形|arc/.test(text) ? 'corner-arc' : 'none',
    backgroundTreatment: /渐变|柔和过渡|gradient/.test(text) ? 'soft_gradient' : 'solid',
    backgroundPattern: pattern,
    bulletPresentation: bulletPresentation(frame, text),
    showPageMarker: pageTotal > 1 && /页码|分页|序列|轮播|page|pagination|连续/.test(text),
    pageIndex,
    pageTotal,
    wordAwareCjk: true,
    fidelityMode: 'balanced',
  };
}

/** 首次审计失败后的唯一确定性修正；不解析模型自然语言，也不扩大 renderer 输入面。 */
export function strengthenTextCardSourceStyle(style: TextCardSourceStyle): TextCardSourceStyle {
  return {
    ...style,
    fidelityMode: 'strict',
    layout: 'editorial',
    showPageMarker: style.pageTotal > 1,
    bulletPresentation: style.bulletPresentation === 'plain' ? 'callout' : style.bulletPresentation,
    wordAwareCjk: true,
  };
}
