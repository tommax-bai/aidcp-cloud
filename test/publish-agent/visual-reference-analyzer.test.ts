import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { VisionChatMessage, VisionLlmClient } from '@content/llm/vision.js';
import {
  buildVisualReferenceSetPrompt,
  buildVisualReferenceSpecialistPrompt,
  createVisualReferenceAnalyzer,
  normalizeReferenceVisualAnalysis,
  visualAnalysisCacheKey,
} from '@content/publish-agent/visual-reference-analyzer.js';
import type { ReferenceVisualAnalysis } from '@kernel/kernel/visual-reference-types.js';

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
      { sourceArrayIndex: 0, kind: 'portrait_photo', confidence: 0.91, clusterId: 'c1', sequenceRole: 'cover' },
      { sourceArrayIndex: 1, kind: 'ui_document', confidence: 0.94, clusterId: 'c1', sequenceRole: 'detail' },
    ],
  });
}

function photoOutput(): string {
  return JSON.stringify({ frames: [{ sourceArrayIndex: 0, common: common('半身人物轮廓'), details: {
    family: 'photo', cameraAngle: '平视', focalLengthFeel: '中焦观感', depthOfField: '浅景深', focus: '主体眼部区域',
    light: '柔和侧光', colorGrade: '冷色低饱和', grainSharpness: '轻微颗粒、中等锐度',
    facialExpression: '眉眼放松、嘴角轻微上扬', gazeDirection: '侧视画外', headAngle: '头部微侧',
    bodyPose: '肩颈放松的头肩像', gesture: '无明显手势', poseEnergy: '低能量松弛',
    emotionalValence: '轻微正向', emotionalArousal: '低唤醒',
  } }] });
}

function uiOutput(): string {
  return JSON.stringify({ frames: [{ sourceArrayIndex: 1, common: common('移动端界面结构'), details: {
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
    assert.equal(out.frameSpecs?.[0].details.family === 'photo' ? out.frameSpecs[0].details.gazeDirection : '', '侧视画外');
    assert.equal(out.frameSpecs?.[0].details.family === 'photo' ? out.frameSpecs[0].details.poseEnergy : '', '低能量松弛');
    assert.equal(out.frameSpecs?.[1].details.family, 'ui_document');
    assert.equal('focalLengthFeel' in out.frameSpecs![1].details, false, 'UI 不应硬套摄影参数');
    assert.equal(vision.calls.length, 3, '整组一次 + 两个 specialist family');
    const firstText = (call: VisionChatMessage[]): string => {
      const content = call[0]?.content;
      return Array.isArray(content) && content[0]?.type === 'text' ? content[0].text : '';
    };
    assert.equal(firstText(vision.calls[0]), buildVisualReferenceSetPrompt());
    assert.equal(firstText(vision.calls[1]), buildVisualReferenceSpecialistPrompt('photo', [0]));
    assert.equal(firstText(vision.calls[2]), buildVisualReferenceSpecialistPrompt('ui_document', [1]));
    const allPrompts = vision.calls.flatMap((call) => call).flatMap((message) =>
      Array.isArray(message.content) ? message.content.filter((part) => part.type === 'text').map((part) => part.text) : [message.content],
    ).join('\n');
    assert.match(allPrompts, /禁止 OCR/);
    assert.doesNotMatch(allPrompts, /photo\.jpg/, 'URL 只作为 image_url，不写进提示文本');
  });

  test('v2 历史反推缓存失效，避免缺少人物神态维度的旧结果继续复用', () => {
    const oldCache = {
      status: 'unavailable', schemaVersion: 'visual-reference-v2', cacheKey: 'old', provider: 'dashscope', model: 'qwen3.7-plus',
      analyzedAt: 888, sourceCount: 1, error: 'legacy cache',
    };
    assert.equal(normalizeReferenceVisualAnalysis(oldCache), undefined);
  });

  test('cacheKey 命中直接复用，零视觉调用', async () => {
    const vision = new QueueVision([]);
    const cacheKey = visualAnalysisCacheKey(images, 'dashscope', 'qwen3.7-plus');
    const cached: ReferenceVisualAnalysis = {
      status: 'analyzed', schemaVersion: 'visual-reference-v3', cacheKey, provider: 'dashscope', model: 'qwen3.7-plus',
      analyzedAt: 888, sourceCount: 2, setStyleBible: bible as ReferenceVisualAnalysis['setStyleBible'],
      styleClusters: [{ id: 'c1', label: '蓝灰组', frameIndexes: [0, 1], summary: '统一', palette: ['蓝灰'], traits: [] }],
      frameSpecs: [
        {
          sourceArrayIndex: 0, sourceIndex: 4, kind: 'portrait_photo', confidence: 0.9, clusterId: 'c1', sequenceRole: 'cover', common: common('人物'),
          details: {
            family: 'photo', cameraAngle: '平视', focalLengthFeel: '中焦', depthOfField: '浅', focus: '主体',
            light: '柔光', colorGrade: '冷色', grainSharpness: '轻颗粒', facialExpression: '克制微笑',
            gazeDirection: '侧视', headAngle: '微侧', bodyPose: '肩颈放松', gesture: '无', poseEnergy: '低',
            emotionalValence: '正向', emotionalArousal: '低',
          },
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

  test('七张同类文字卡 specialist 按三张上限分批并发，整组 pass 保持单次', async () => {
    const manyImages = Array.from({ length: 7 }, (_, index) => ({
      index,
      sourceUrl: `https://img.test/card-${index}.jpg`,
      capturedAt: index + 1,
    }));
    const set = JSON.stringify({
      setStyleBible: { ...bible, summary: '薄荷绿细网格知识卡组', palette: ['薄荷绿', '米白'] },
      styleClusters: [{
        id: 'c1', label: '知识卡', frameIndexes: [0, 1, 2, 3, 4, 5, 6],
        summary: '统一薄荷绿网格与圆角信息卡', palette: ['薄荷绿', '米白'], traits: ['细网格', '圆角卡片', '分页'],
      }],
      frames: manyImages.map((_, sourceArrayIndex) => ({
        sourceArrayIndex,
        kind: 'text_layout',
        confidence: 0.96,
        clusterId: 'c1',
        sequenceRole: sourceArrayIndex === 0 ? 'cover' : 'detail',
      })),
    });
    const batch = (indexes: number[]) => JSON.stringify({
      frames: indexes.map((sourceArrayIndex) => ({
        sourceArrayIndex,
        common: {
          ...common('知识卡版式'),
          composition: '顶部标题，下方圆角信息卡',
          palette: ['薄荷绿', '米白', '深绿'],
        },
        details: {
          family: 'text_layout', grid: '细方格背景', textBlockRatio: '中高', hierarchy: '页眉、标题、信息卡、页码',
          alignment: '左对齐', weightContrast: '标题粗体正文常规', colorBlocks: '浅色圆角信息卡', decorations: '分页标记',
        },
      })),
    });
    const vision = new QueueVision([set, batch([0, 1, 2]), batch([3, 4, 5]), batch([6])]);
    const analyzer = createVisualReferenceAnalyzer({
      vision,
      enabled: () => true,
      getModel: () => 'qwen3.7-plus',
      getProvider: () => 'dashscope',
      specialistBatchSize: 3,
    });
    const out = await analyzer.analyze({ curatedContentId: null, accountId: 'a', sourceId: 'cards', images: manyImages });
    assert.equal(out.status, 'analyzed');
    assert.equal(out.frameSpecs?.length, 7);
    assert.equal(vision.calls.length, 4, '整组一次 + specialist 三批');
    const specialistImageCounts = vision.calls.slice(1).map((call) => call.flatMap((message) =>
      Array.isArray(message.content) ? message.content.filter((part) => part.type === 'image_url') : [],
    ).length);
    assert.deepEqual(specialistImageCounts, [3, 3, 1]);
  });
});
