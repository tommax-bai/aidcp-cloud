import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { VisionChatMessage, VisionLlmClient } from '../../src/llm/vision.js';
import {
  createVisualReferenceAnalyzer,
  visualAnalysisCacheKey,
} from '../../src/publish-agent/visual-reference-analyzer.js';
import type { ReferenceVisualAnalysis } from '../../src/publish-agent/visual-reference-types.js';

const images = [
  { index: 4, sourceUrl: 'https://img.test/photo.jpg', capturedAt: 100 },
  { index: 8, sourceUrl: 'https://img.test/ui.jpg', capturedAt: 200 },
];

const bible = {
  summary: '冷静、克制的蓝灰视觉组', palette: ['蓝灰', '白'], colorTemperature: 'cool', contrast: 'medium',
  visualDensity: 'balanced', whitespace: '四周留白', hierarchy: '单一主焦点', mood: ['理性'], texture: ['干净'],
  continuityRules: ['统一蓝灰色'], avoid: ['水印'],
};

const common = (subject: string) => ({
  aspectRatio: '3:4', subject, composition: '居中主视觉', focalHierarchy: '主次清楚', palette: ['蓝灰'],
  lightingOrContrast: '中等对比', negativeSpace: '顶部留白', texture: '干净', mood: '理性', avoid: ['文字复制'],
});

function setOutput(): string {
  return JSON.stringify({
    setStyleBible: bible,
    styleClusters: [{ id: 'c1', label: '蓝灰组', frameIndexes: [0, 1], summary: '统一蓝灰克制风格', palette: ['蓝灰'], traits: ['克制'] }],
    frames: [
      { sourceArrayIndex: 0, kind: 'portrait_photo', confidence: 0.91, clusterId: 'c1', sequenceRole: 'cover', common: common('半身人物轮廓') },
      { sourceArrayIndex: 1, kind: 'ui_document', confidence: 0.94, clusterId: 'c1', sequenceRole: 'detail', common: common('移动端界面结构') },
    ],
  });
}

function photoOutput(): string {
  return JSON.stringify({ frames: [{ sourceArrayIndex: 0, details: {
    family: 'photo', cameraAngle: '平视', focalLengthFeel: '中焦观感', depthOfField: '浅景深', focus: '主体眼部区域',
    light: '柔和侧光', colorGrade: '冷色低饱和', grainSharpness: '轻微颗粒、中等锐度',
  } }] });
}

function uiOutput(): string {
  return JSON.stringify({ frames: [{ sourceArrayIndex: 1, details: {
    family: 'ui_document', viewport: '移动端竖屏', grid: '单列网格', componentDensity: '中等', bordersRadius: '细边框小圆角',
    informationZones: '顶栏、内容区、底栏', depth: '浅层级', background: '浅灰背景',
  } }] });
}

class QueueVision implements VisionLlmClient {
  calls: VisionChatMessage[][] = [];
  constructor(private readonly outputs: string[]) {}
  async chatVision(messages: VisionChatMessage[]): Promise<string> {
    this.calls.push(messages);
    const next = this.outputs.shift();
    if (next === undefined) throw new Error('unexpected call');
    return next;
  }
}

describe('VisualReferenceAnalyzer', () => {
  test('整组分类后按摄影/UI 专用维度分析，输出顺序和非摄影字段不混用', async () => {
    const vision = new QueueVision([setOutput(), photoOutput(), uiOutput()]);
    const analyzer = createVisualReferenceAnalyzer({
      vision, enabled: () => true, getModel: () => 'qwen3.7-plus', getProvider: () => 'dashscope', clock: () => 999,
    });
    const out = await analyzer.analyze({ curatedContentId: null, accountId: 'a', sourceId: 'n', images });
    assert.equal(out.status, 'analyzed');
    assert.equal(out.frameSpecs?.length, 2);
    assert.deepEqual(out.frameSpecs?.map((f) => f.sourceIndex), [4, 8]);
    assert.equal(out.frameSpecs?.[0].details.family, 'photo');
    assert.equal(out.frameSpecs?.[1].details.family, 'ui_document');
    assert.equal('focalLengthFeel' in out.frameSpecs![1].details, false, 'UI 不应硬套摄影参数');
    assert.equal(vision.calls.length, 3, '整组一次 + 两个 specialist family');
    const allPrompts = vision.calls.flatMap((call) => call).flatMap((message) =>
      Array.isArray(message.content) ? message.content.filter((part) => part.type === 'text').map((part) => part.text) : [message.content],
    ).join('\n');
    assert.match(allPrompts, /禁止 OCR/);
    assert.doesNotMatch(allPrompts, /photo\.jpg/, 'URL 只作为 image_url，不写进提示文本');
  });

  test('cacheKey 命中直接复用，零视觉调用', async () => {
    const vision = new QueueVision([]);
    const cacheKey = visualAnalysisCacheKey(images, 'dashscope', 'qwen3.7-plus');
    const cached: ReferenceVisualAnalysis = {
      status: 'analyzed', schemaVersion: 'visual-reference-v1', cacheKey, provider: 'dashscope', model: 'qwen3.7-plus',
      analyzedAt: 888, sourceCount: 2, setStyleBible: bible as ReferenceVisualAnalysis['setStyleBible'],
      styleClusters: [{ id: 'c1', label: '蓝灰组', frameIndexes: [0, 1], summary: '统一', palette: ['蓝灰'], traits: [] }],
      frameSpecs: [
        {
          sourceArrayIndex: 0, sourceIndex: 4, kind: 'portrait_photo', confidence: 0.9, clusterId: 'c1', sequenceRole: 'cover', common: common('人物'),
          details: { family: 'photo', cameraAngle: '平视', focalLengthFeel: '中焦', depthOfField: '浅', focus: '主体', light: '柔光', colorGrade: '冷色', grainSharpness: '轻颗粒' },
        },
        {
          sourceArrayIndex: 1, sourceIndex: 8, kind: 'ui_document', confidence: 0.9, clusterId: 'c1', sequenceRole: 'detail', common: common('界面'),
          details: { family: 'ui_document', viewport: '竖屏', grid: '单列', componentDensity: '中', bordersRadius: '小圆角', informationZones: '三区', depth: '浅', background: '浅灰' },
        },
      ],
    };
    const analyzer = createVisualReferenceAnalyzer({ vision, enabled: () => true, getModel: () => 'qwen3.7-plus', getProvider: () => 'dashscope' });
    const out = await analyzer.analyze({ curatedContentId: 1, accountId: 'a', sourceId: 'n', images, cached });
    assert.equal(out.cacheKey, cacheKey);
    assert.equal(vision.calls.length, 0);
  });

  test('严格 JSON 不匹配时诚实 unavailable，不生成假 frame', async () => {
    const vision = new QueueVision(['{"frames":[]}']);
    const analyzer = createVisualReferenceAnalyzer({ vision, enabled: () => true, getModel: () => 'm', getProvider: () => 'p' });
    const out = await analyzer.analyze({ curatedContentId: null, accountId: 'a', sourceId: 'n', images });
    assert.equal(out.status, 'unavailable');
    assert.equal(out.frameSpecs, undefined);
    assert.match(out.error!, /strict schema/);
  });
});
