import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BODY_LENGTH_BANDS,
  BODY_LENGTH_TOLERANCE,
  bodyLengthCorrection,
  describeBodyLengthBand,
  judgeBodyLength,
  measureBodyLength,
} from '../../src/publish-agent/body-length-band.js';
import { buildCreatorPrompt } from '../../src/publish-agent/prompts.js';
import type { ScoutDecision, TriggerInput } from '../../src/publish-agent/types.js';

function makeTrigger(platform: TriggerInput['platform']): TriggerInput {
  const trigger: TriggerInput = {
    metrics: { hoursSinceLastPublish: 30, newConceptCount: 3, likedSinceLastPublish: 20 },
    generateInput: {
      concepts: [{ keyword: 'RAG 重排' }],
      likedContents: [],
      soul: {
        identity: { name: '小林', role: 'AI研发', background: '3年', tone: '理性' },
        interests: { primary: ['LLM'], secondary: [], seed_keywords: ['RAG'] },
        engagement_rules: { like: [], skip: [], comment_trigger: [] },
        browse_patterns: {
          mode: 'state_machine',
          states: { browse: { action: 'x', transitions: [] } },
          session: { max_duration_min: 10, max_likes: 8, max_searches: 3, cooldown_between_actions_sec: [3, 8] },
        },
      },
      recentPosts: [],
    },
    recentPublished: [],
    platform,
  };
  if (platform === 'facebook') trigger.generateInput.soul.writing_language = 'en';
  return trigger;
}

const scoutDecision: ScoutDecision = {
  shouldPublish: true,
  publishDirection: 'RAG 检索优化',
  keyPoints: ['向量切块'],
  confidence: 0.8,
  reason: '素材充足',
  scoutedAt: 1700000000000,
};

describe('正文长度区间：prompt 文案与校验器同源', () => {
  // 这条断言的价值全在「读表、不读字面量」上：区间改了而 prompt 没改，症状是
  // 「规则明明写着却不生效」，没有任何东西会报错。所以这里 MUST NOT 写死 100-350。
  for (const platform of ['facebook', 'xiaohongshu'] as const) {
    test(`${platform} 的 prompt 长度要求由 BODY_LENGTH_BANDS 生成，而非各写一份数字`, () => {
      const band = BODY_LENGTH_BANDS[platform];
      assert.ok(band, `${platform} 应在区间表内`);
      const prompt = buildCreatorPrompt(scoutDecision, makeTrigger(platform));
      assert.ok(
        prompt.includes(`${band.min}-${band.max}`),
        `prompt 未出现区间表里的 ${band.min}-${band.max}`,
      );
      assert.equal(describeBodyLengthBand(platform), `${band.min}-${band.max}`);
    });
  }

  test('不在表内的平台不设闸，也 MUST NOT 借用别的平台的数字', () => {
    assert.equal(describeBodyLengthBand('wechat_channels'), '');
    assert.equal(judgeBodyLength('随便多长都行', 'wechat_channels').kind, 'no_band');
  });

  test('platform 缺省按小红书解释（与 TriggerInput.platform 的既有语义一致）', () => {
    assert.equal(describeBodyLengthBand(undefined), describeBodyLengthBand('xiaohongshu'));
  });
});

describe('judgeBodyLength 三态', () => {
  const band = BODY_LENGTH_BANDS.xiaohongshu!;
  const slack = Math.round((band.max - band.min) * BODY_LENGTH_TOLERANCE);
  const body = (n: number) => '字'.repeat(n);

  test('合区间 → in_band，偏离为 0', () => {
    const verdict = judgeBodyLength(body(band.min + 10), 'xiaohongshu');
    assert.equal(verdict.kind, 'in_band');
    assert.equal(verdict.overshoot, 0);
  });

  test('越界但在容差内 → near_band（记档即可，不重写）', () => {
    const over = judgeBodyLength(body(band.max + slack), 'xiaohongshu');
    assert.equal(over.kind, 'near_band');
    assert.equal(over.overshoot, slack);

    const under = judgeBodyLength(body(band.min - slack), 'xiaohongshu');
    assert.equal(under.kind, 'near_band');
    assert.equal(under.overshoot, slack);
  });

  test('越出容差 → out_of_tolerance（两个方向都要判到）', () => {
    assert.equal(judgeBodyLength(body(band.max + slack + 1), 'xiaohongshu').kind, 'out_of_tolerance');
    assert.equal(judgeBodyLength(body(band.min - slack - 1), 'xiaohongshu').kind, 'out_of_tolerance');
  });

  test('字数按码位算，与边缘逐字循环、与 fill-budget 换算同口径', () => {
    // '👍' 的 String.length 是 2、码位是 1。三处口径若不一致，同一篇稿子会有三个长度。
    assert.equal(measureBodyLength('👍👍👍'), 3);
    assert.notEqual('👍👍👍'.length, 3);
  });

  test('首尾空白不计入长度（模型常在正文外挂换行）', () => {
    assert.equal(measureBodyLength('\n\n  正文  \n'), 2);
  });
});

describe('bodyLengthCorrection', () => {
  test('必须点名实测字数、目标区间与修改方向——不带反馈的重试只是重掷骰子', () => {
    const band = BODY_LENGTH_BANDS.facebook!;
    const tooLong = bodyLengthCorrection(judgeBodyLength('字'.repeat(band.max * 3), 'facebook'));
    assert.match(tooLong, new RegExp(String(band.max * 3)));
    assert.match(tooLong, new RegExp(`${band.min}-${band.max}`));
    assert.match(tooLong, /偏长/);

    const tooShort = bodyLengthCorrection(judgeBodyLength('字', 'facebook'));
    assert.match(tooShort, /偏短/);
  });

  test('无区间的平台不产生纠正说明', () => {
    assert.equal(bodyLengthCorrection(judgeBodyLength('随便', 'wechat_channels')), '');
  });
});
