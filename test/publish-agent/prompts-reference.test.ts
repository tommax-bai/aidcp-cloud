/**
 * 创作/选题 prompt 洗稿参照块单测（change curated-note-actions）。
 * 覆盖：有参照时 Creator prompt 含独立【参照笔记】块与非照抄红线、素材块规则原样保留；
 * 无参照时不出现参照块（既有路径零回归）；Scout prompt 参照钉方向。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildCreatorPrompt, buildScoutPrompt } from '../../src/publish-agent/prompts.js';
import type { ScoutDecision, TriggerInput } from '../../src/publish-agent/types.js';
import type { Soul } from '../../src/soul/types.js';

const soul: Soul = {
  identity: { name: '小林', role: '家居博主', background: '整理师', tone: '亲切' },
  interests: { primary: ['收纳'], secondary: ['家居'], seed_keywords: ['整理'] },
};

function makeTrigger(withRef: boolean): TriggerInput {
  return {
    metrics: { hoursSinceLastPublish: 10, newConceptCount: 2, likedSinceLastPublish: 1 },
    generateInput: {
      concepts: [{ keyword: '抽屉分隔' }],
      likedContents: [],
      materials: [
        {
          sourceId: 'm1',
          title: '素材笔记',
          body: '素材正文',
          topics: ['收纳'],
          likeCount: 10,
          collectCount: 5,
          botLiked: true,
          botCollected: false,
        },
      ],
      soul,
      recentPosts: [],
      ...(withRef
        ? {
            referenceNote: {
              sourceId: 'note-42',
              title: '十个收纳小技巧',
              body: '参照正文内容……',
              topics: ['收纳', '家居'],
              author: '博主甲',
            },
          }
        : {}),
    },
    recentPublished: [],
    forced: true,
    accountId: 'acc-test',
  };
}

const scout: ScoutDecision = { shouldPublish: true, publishDirection: '收纳技巧', keyPoints: ['a', 'b'], confidence: 0.9, reason: 'r', scoutedAt: 1 };

describe('buildCreatorPrompt 参照块', () => {
  it('有参照：含独立【参照笔记】块、标题/正文节选/非照抄红线；素材块及其红线原样保留', () => {
    const p = buildCreatorPrompt(scout, makeTrigger(true));
    assert.match(p, /【参照笔记——洗稿参照（独立于上方素材规则）】/);
    assert.match(p, /「十个收纳小技巧」/);
    assert.match(p, /参照正文内容/);
    assert.match(p, /禁止逐句照抄、禁止只做同义替换/);
    assert.match(p, /可辨识的表达差异/);
    // 素材块两套规则并存不混：既有红线一字不动。
    assert.match(p, /【可用素材——精选灵感（仅作灵感，严禁照抄）】/);
    assert.match(p, /【素材使用红线】以上素材只供你体会角度、话题与真实细节；严禁照抄或改写其句子/);
    // 参照块在素材红线之后（独立块，不混入素材列表）。
    assert.ok(p.indexOf('【参照笔记——洗稿参照') > p.indexOf('【素材使用红线】'));
  });

  it('无参照：不出现参照块（既有 /publish 路径零回归）', () => {
    const p = buildCreatorPrompt(scout, makeTrigger(false));
    assert.doesNotMatch(p, /参照笔记/);
    assert.match(p, /【可用素材——精选灵感（仅作灵感，严禁照抄）】/);
  });
});

describe('buildScoutPrompt 参照钉方向', () => {
  it('有参照：含参照创作块，要求 publishDirection 钉在参照选题上', () => {
    const p = buildScoutPrompt(makeTrigger(true));
    assert.match(p, /【参照笔记——本次为洗稿参照创作】/);
    assert.match(p, /「十个收纳小技巧」/);
    assert.match(p, /publishDirection 必须钉在这篇参照笔记的选题上/);
  });

  it('无参照：不出现参照块', () => {
    const p = buildScoutPrompt(makeTrigger(false));
    assert.doesNotMatch(p, /参照笔记/);
  });
});
