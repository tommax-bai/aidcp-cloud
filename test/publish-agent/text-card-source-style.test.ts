import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveTextCardSourceStyle,
  strengthenTextCardSourceStyle,
} from '../../src/publish-agent/text-card-source-style.js';
import type { ReferenceVisualAnalysis, VisualFrameSpec } from '../../src/kernel/visual-reference-types.js';

const analysis: ReferenceVisualAnalysis = {
  status: 'analyzed',
  schemaVersion: 'visual-reference-v3',
  cacheKey: 'k',
  provider: 'dashscope',
  model: 'qwen3.7-plus',
  analyzedAt: 1,
  sourceCount: 7,
  setStyleBible: {
    summary: '薄荷绿到米白的柔和渐变知识卡组',
    palette: ['薄荷绿', '米白', '深绿'],
    colorTemperature: 'cool',
    contrast: 'medium',
    visualDensity: 'balanced',
    whitespace: '下半区保留呼吸感',
    hierarchy: '页眉、标题、信息卡、页码、页脚',
    mood: ['理性', '清爽'],
    texture: ['细方格纸'],
    continuityRules: ['统一细网格背景', '每页右上角分页'],
    avoid: ['水印'],
  },
  styleClusters: [{
    id: 'c1', label: '论文知识卡', frameIndexes: [0, 1], summary: '薄荷绿网格与圆角信息区',
    palette: ['薄荷绿', '米白'], traits: ['分页', '圆角卡片'],
  }],
};

function frame(sequenceRole: VisualFrameSpec['sequenceRole'], kind: VisualFrameSpec['kind']): VisualFrameSpec {
  return {
    sourceArrayIndex: sequenceRole === 'cover' ? 0 : 1,
    sourceIndex: sequenceRole === 'cover' ? 0 : 1,
    kind,
    confidence: 0.96,
    clusterId: 'c1',
    sequenceRole,
    common: {
      aspectRatio: '3:4', subject: '知识卡结构', composition: '顶部标题，下方圆角信息卡',
      focalHierarchy: '标题、信息卡、分页', palette: ['薄荷绿', '米白'], lightingOrContrast: '中高对比',
      negativeSpace: '下半区留白', texture: '细网格', mood: '理性清爽', avoid: ['复制文字'],
    },
    details: kind === 'ui_document'
      ? {
          family: 'ui_document', viewport: '竖屏', grid: '单列细网格', componentDensity: '中等',
          bordersRadius: '圆角描边卡片，左侧数字徽标', informationZones: '标题区、三张编号信息卡、页码',
          depth: '浅层级', background: '薄荷绿渐变',
        }
      : {
          family: 'text_layout', grid: '细方格网格', textBlockRatio: '中等', hierarchy: '标题与强调色块',
          alignment: '左对齐', weightContrast: '粗标题细正文', colorBlocks: '圆角信息卡', decorations: '右上分页',
        },
  };
}

test('封面文字卡派生薄荷渐变、细网格、callout 和分页白名单令牌', () => {
  const style = deriveTextCardSourceStyle(frame('cover', 'text_layout'), analysis, 0, 7);
  assert.ok(style);
  assert.deepEqual(
    {
      paletteKey: style.paletteKey,
      backgroundTreatment: style.backgroundTreatment,
      backgroundPattern: style.backgroundPattern,
      bulletPresentation: style.bulletPresentation,
      showPageMarker: style.showPageMarker,
      pageIndex: style.pageIndex,
      pageTotal: style.pageTotal,
    },
    {
      paletteKey: 'mint',
      backgroundTreatment: 'soft_gradient',
      backgroundPattern: 'fine_grid',
      bulletPresentation: 'callout',
      showPageMarker: true,
      pageIndex: 0,
      pageTotal: 7,
    },
  );
});

test('UI 文档型文字卡派生编号信息卡；严格重渲染不扩大输入面', () => {
  const style = deriveTextCardSourceStyle(frame('detail', 'ui_document'), analysis, 1, 7);
  assert.ok(style);
  assert.equal(style.bulletPresentation, 'numbered_cards');
  const strict = strengthenTextCardSourceStyle(style);
  assert.equal(strict.fidelityMode, 'strict');
  assert.equal(strict.showPageMarker, true);
  assert.deepEqual(Object.keys(strict).sort(), Object.keys(style).sort());
});
