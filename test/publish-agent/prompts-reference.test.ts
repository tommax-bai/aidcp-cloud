/**
 * 保真洗稿 prompt 单测。
 * 覆盖：旧 Creator/Scout 兼容块不再鼓励借题扩写；新四段保真 prompt 明确禁止解读二创/新增事实。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCreatorPrompt,
  buildFaithfulDraftPrompt,
  buildFaithfulRewritePlanPrompt,
  buildFidelityAuditPrompt,
  buildReferenceAnalysisPrompt,
  buildScoutPrompt,
} from '../../src/publish-agent/prompts.js';
import type { FaithfulDraft, FaithfulRewritePlan, ReferenceAnalysis, ScoutDecision, TriggerInput } from '../../src/publish-agent/types.js';
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
  it('有参照：兼容块改为保真约束，不再鼓励补经验/借题扩写', () => {
    const p = buildCreatorPrompt(scout, makeTrigger(true));
    assert.match(p, /【参照笔记——保真洗稿/);
    assert.match(p, /「十个收纳小技巧」/);
    assert.match(p, /参照正文内容/);
    assert.match(p, /仅做保真改写/);
    assert.match(p, /禁止解读二创/);
    assert.match(p, /禁止伪造亲历视角或新增原稿没有的数据/);
    assert.doesNotMatch(p, /补充你自己的经验与判断/);
    // 素材块两套规则并存不混：既有红线一字不动。
    assert.match(p, /【可用素材——精选灵感（仅作灵感，严禁照抄）】/);
    assert.match(p, /【素材使用红线】以上素材只供你体会角度、话题与真实细节；严禁照抄或改写其句子/);
    // 参照块在素材红线之后（独立块，不混入素材列表）。
    assert.ok(p.indexOf('【参照笔记——保真洗稿') > p.indexOf('【素材使用红线】'));
  });

  it('无参照：不出现参照块（既有 /publish 路径零回归）', () => {
    const p = buildCreatorPrompt(scout, makeTrigger(false));
    assert.doesNotMatch(p, /参照笔记/);
    assert.match(p, /【可用素材——精选灵感（仅作灵感，严禁照抄）】/);
  });
});

describe('buildScoutPrompt 参照钉方向', () => {
  it('有参照：兼容块只允许提炼原稿核心，不再引导二创/借题重写', () => {
    const p = buildScoutPrompt(makeTrigger(true));
    assert.match(p, /【参照笔记——保真洗稿路径】/);
    assert.match(p, /「十个收纳小技巧」/);
    assert.match(p, /不得引导解读二创、借题重写或新增原稿没有的事实/);
  });

  it('无参照：不出现参照块', () => {
    const p = buildScoutPrompt(makeTrigger(false));
    assert.doesNotMatch(p, /参照笔记/);
  });
});

describe('保真洗稿四段 prompt', () => {
  const reference = makeTrigger(true).generateInput.referenceNote!;
  const analysis: ReferenceAnalysis = {
    sourceId: 'note-42',
    title: '十个收纳小技巧',
    thesis: '收纳要先分区再分类',
    structure: ['痛点', '方法', '总结'],
    keyFacts: ['抽屉分隔能减少翻找时间'],
    keyClaims: ['先分区再分类更稳'],
    entities: ['抽屉分隔盒'],
    timeline: [],
    mustPreserve: ['先分区再分类'],
    forbiddenAdditions: ['个人实测数据', '未出现的改造案例'],
    perspective: '整理师经验',
    analyzedAt: 1,
  };
  const plan: FaithfulRewritePlan = {
    titleDirection: '保留方法论，不扩展案例',
    paragraphs: [{ source: '方法段', rewriteGoal: '换说法保留步骤', mustKeep: ['先分区再分类'] }],
    styleNotes: ['口语化'],
    forbiddenAdditions: analysis.forbiddenAdditions,
    plannedAt: 1,
  };
  const draft: FaithfulDraft = {
    title: '抽屉先分区',
    content: '先分区，再分类。',
    tone: 'casual',
    style: { rewriteMode: 'faithful' },
    draftedAt: 1,
  };

  it('分析/规划/写稿/审核 prompt 都明确只做保真改写', () => {
    const prompts = [
      buildReferenceAnalysisPrompt(reference, soul),
      buildFaithfulRewritePlanPrompt(analysis, reference, soul),
      buildFaithfulDraftPrompt(analysis, plan, reference, soul),
      buildFidelityAuditPrompt(analysis, plan, draft, reference),
    ];
    for (const p of prompts) {
      assert.match(p, /保真/);
      assert.match(p, /不得|不能|禁止/);
      assert.doesNotMatch(p, /借题重写成/);
    }
    assert.match(prompts[0], /不补背景、不扩展行业知识/);
    assert.match(prompts[1], /不做解读二创，不做借题重写/);
    assert.match(prompts[2], /不得新增原文没有的实测结果/);
    assert.match(prompts[3], /草稿没有新增原稿未出现的事实/);
  });
});
