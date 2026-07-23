import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  categorySafetyInstruction,
  createFallbackContentVisualBrief,
  ensureContentVisualCategory,
  formatContentVisualCategoryBrief,
  normalizeContentVisualCategoryBrief,
} from '../../src/publish-agent/content-visual-brief.js';
import type { ContentVisualCategoryBrief, ContentVisualCategoryKind } from '../../src/kernel/visual-reference-types.js';

const fixtures: Record<ContentVisualCategoryKind, ContentVisualCategoryBrief> = {
  portrait_photo: { kind: 'portrait_photo', facialExpression: '嘴角克制', gazeDirection: '侧视', headAngle: '微侧', bodyLanguage: '肩颈放松', gesture: '手指自然放松', poseEnergy: '低唤醒但有张力' },
  text_layout: { kind: 'text_layout', coreMessage: '先验证再训练', informationHierarchy: ['结论', '依据'], emphasisTerms: ['验证', '闭环'], readingOrder: '从上到下', informationDensity: '中等', cardStructure: '封面加要点' },
  infographic_chart: { kind: 'infographic_chart', claim: '标准随反馈更新', relationship: '反馈闭环', entities: ['答案', '标准'], direction: '答案到验证再回到训练', steps: ['生成', '验证', '训练'], dataPolicy: '正文无数字，使用无数值关系图' },
  scene_photo: { kind: 'scene_photo', timeAndWeather: '阴天午后', location: '工作室', humanPresence: '一人背影', eventTrace: '刚放下笔', spatialRelationship: '前景笔记、中景人物、背景窗户', motionLevel: '低动态' },
  still_life_photo: { kind: 'still_life_photo', primaryObjects: ['笔记本', '钢笔'], usageState: '翻开并写到一半', objectRelationship: '钢笔压在当前页', lifeTrace: '纸张有折痕', materialFocus: '纸张与金属', handInteraction: '手刚离开笔杆' },
  illustration_3d: { kind: 'illustration_3d', coreMetaphor: '标准在反馈中生长', characterRelationship: '模型与镜像互相校正', symbols: ['循环箭头', '刻度尺'], motionDirection: '顺时针闭环', exaggerationLevel: '适度', storyStage: '形成闭环' },
  ui_document: { kind: 'ui_document', userTask: '查看动态评分', interfaceState: '验证结果页', componentHierarchy: ['总分', '分项依据'], interactionPath: ['生成答案', '查看验证'], informationFocus: '评分差异', fidelityLabel: '概念界面示意，非已上线功能' },
  collage_mixed: { kind: 'collage_mixed', regions: [{ role: '主区', content: '闭环结论', priority: 'high' }, { role: '支撑区', content: '三步过程', priority: 'medium' }], readingOrder: '先主区后支撑区', primarySecondaryRatio: '2:1', continuityElements: ['绿色', '循环箭头'] },
};

describe('contentVisualBrief 分类语义', () => {
  test('八类 discriminated category brief 都能严格解析并格式化', () => {
    for (const [kind, fixture] of Object.entries(fixtures) as Array<[ContentVisualCategoryKind, ContentVisualCategoryBrief]>) {
      const parsed = normalizeContentVisualCategoryBrief(fixture);
      assert.deepEqual(parsed, fixture, `${kind} 应完整保留`);
      assert.match(formatContentVisualCategoryBrief(parsed!), /类型=/);
    }
  });

  test('缺必填字段或未知类型不伪装成有效分类', () => {
    assert.equal(normalizeContentVisualCategoryBrief({ kind: 'ui_document', userTask: '查看评分' }), undefined);
    assert.equal(normalizeContentVisualCategoryBrief({ ...fixtures.still_life_photo, primaryObjects: [] }), undefined);
    assert.equal(normalizeContentVisualCategoryBrief({ kind: 'unknown', foo: 'bar' }), undefined);
  });

  test('planner 缺分类时按正文推断并生成有意义兜底，不退成空泛字段', () => {
    const brief = createFallbackContentVisualBrief({
      subject: '三步反馈闭环信息图', intent: '解释生成、验证、训练的关系', title: '评分标准如何进化',
      content: '先生成答案，再验证标准，最后反哺训练。正文没有提供任何百分比。', tone: '理性克制',
    });
    assert.equal(brief.categoryBrief?.kind, 'infographic_chart');
    assert.match(formatContentVisualCategoryBrief(brief.categoryBrief!), /生成、验证、训练|解释生成、验证、训练的关系/);
    assert.match(categorySafetyInstruction(brief.categoryBrief!), /不得编造.*数字/);
  });

  test('来源帧类型可纠正 planner 分类，但保留正文公共语义', () => {
    const original = createFallbackContentVisualBrief({
      subject: '闭环方法', intent: '解释反馈过程', title: '动态标准', content: '生成后验证，再反馈训练。', tone: '克制',
    }, 'scene_photo');
    const corrected = ensureContentVisualCategory(original, {
      subject: '闭环方法', intent: '解释反馈过程', title: '动态标准', content: '生成后验证，再反馈训练。', tone: '克制',
    }, 'text_layout');
    assert.equal(corrected.categoryBrief?.kind, 'text_layout');
    assert.equal(corrected.narrativeMoment, original.narrativeMoment);
    assert.match(formatContentVisualCategoryBrief(corrected.categoryBrief!), /核心结论=解释反馈过程/);
  });

  test('信息图与 UI 各有独立事实安全边界', () => {
    assert.match(categorySafetyInstruction(fixtures.infographic_chart), /百分比|统计结论/);
    assert.match(categorySafetyInstruction(fixtures.ui_document), /未支持的已上线产品能力/);
  });
});
