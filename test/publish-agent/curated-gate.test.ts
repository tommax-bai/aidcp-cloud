import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CURATED_GATE_CONFIG,
  resolveCuratedGateConfig,
  evaluateAdmission,
  type AdmissionInput,
  type CuratedGateConfig,
} from '../../src/publish-agent/curated-gate.js';

const CONFIG: CuratedGateConfig = DEFAULT_CURATED_GATE_CONFIG;

/** 构造一条「相关、各计数缺省」的准入输入，测试只覆盖差异字段。 */
function makeInput(overrides: Partial<AdmissionInput> = {}): AdmissionInput {
  return {
    noteText: '今天分享一个露营好去处，附近湖边风景很好',
    accountInterests: ['露营', '徒步'],
    likeCount: null,
    collectCount: null,
    botCollected: false,
    ...overrides,
  };
}

describe('AC-CURATED-GATE 准入门槛 + 配置', () => {
  test('DEFAULT_CURATED_GATE_CONFIG 数值正确', () => {
    assert.deepEqual(DEFAULT_CURATED_GATE_CONFIG, {
      collectFloor: 50,
      ratioMin: 0.2,
      ratioLikeFloor: 80,
      minTopicOverlap: 1,
      retentionMax: 1000,
      selectTopK: 8,
    });
  });

  test('resolveCuratedGateConfig Phase 1 恒返回缺省、且为独立副本', () => {
    const a = resolveCuratedGateConfig();
    const b = resolveCuratedGateConfig('acc-123');
    assert.deepEqual(a, DEFAULT_CURATED_GATE_CONFIG);
    assert.deepEqual(b, DEFAULT_CURATED_GATE_CONFIG);
    assert.notStrictEqual(a, DEFAULT_CURATED_GATE_CONFIG, '应是副本，非共享引用');
    a.collectFloor = 999;
    assert.equal(DEFAULT_CURATED_GATE_CONFIG.collectFloor, 50, '改副本不影响常量');
  });

  test('collect 达地板 → 纳入(collect_floor)', () => {
    const r = evaluateAdmission(makeInput({ collectCount: 50, likeCount: 10 }), CONFIG);
    assert.deepEqual(r, { admit: true, reason: 'collect_floor' });
  });

  test('比率达标但 like < ratioLikeFloor → 被拦(below_resonance)', () => {
    // collect/like = 20/50 = 0.4 ≥ 0.20，但 like=50 < 80 → 比率不可信（小样本噪声防护）
    const r = evaluateAdmission(makeInput({ likeCount: 50, collectCount: 20 }), CONFIG);
    assert.deepEqual(r, { admit: false, reason: 'below_resonance' });
  });

  test('比率 + 赞数双过 → 纳入(collect_ratio)（缺省配置下分支即可达）', () => {
    // 缺省 ratioMin×ratioLikeFloor = 0.20×80 = 16 < collectFloor(50)，比率分支真正可达：
    // collect=30 < 50 不达 floor；like=120 ≥ 80，collect/like = 30/120 = 0.25 ≥ 0.20 → 走比率纳入
    const r = evaluateAdmission(makeInput({ likeCount: 120, collectCount: 30 }), CONFIG);
    assert.deepEqual(r, { admit: true, reason: 'collect_ratio' });
  });

  test('跑题（relevanceHits=0 且非 botCollected）→ 被拦(off_topic)', () => {
    const r = evaluateAdmission(
      makeInput({
        noteText: '一篇关于股票投资的硬核分析',
        accountInterests: ['露营', '徒步'],
        collectCount: 500, // 即便共鸣极强，跑题也先被拦
      }),
      CONFIG,
    );
    assert.deepEqual(r, { admit: false, reason: 'off_topic' });
  });

  test('botCollected 豁免相关性且纳入(bot_collect)', () => {
    const r = evaluateAdmission(
      makeInput({
        noteText: '完全无关的内容',
        accountInterests: ['露营'],
        botCollected: true,
      }),
      CONFIG,
    );
    assert.deepEqual(r, { admit: true, reason: 'bot_collect' });
  });

  test('只有点赞、无收藏、相关 → below_resonance（点赞弱信号不单独纳入）', () => {
    const r = evaluateAdmission(makeInput({ likeCount: 99999, collectCount: null }), CONFIG);
    assert.deepEqual(r, { admit: false, reason: 'below_resonance' });
  });

  test('相关性子串匹配大小写不敏感', () => {
    const r = evaluateAdmission(
      makeInput({
        noteText: 'Best CAMPING gear of 2026',
        accountInterests: ['camping'],
        collectCount: 50,
      }),
      CONFIG,
    );
    assert.deepEqual(r, { admit: true, reason: 'collect_floor' });
  });

  test('collectCount 缺失按 0 处理、不编造 → 走比率/兜底', () => {
    // 相关但所有共鸣信号缺失 → below_resonance（诚实置空：null collect 不算达地板）
    const r = evaluateAdmission(makeInput({ collectCount: null, likeCount: null }), CONFIG);
    assert.deepEqual(r, { admit: false, reason: 'below_resonance' });
  });
});
