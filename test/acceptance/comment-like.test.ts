/**
 * 验收用例 AC-CLIKE-* — 详情页「评论点赞」红线（change comment-like-on-detail）。
 *
 * 守护点（聚成产品红线，离线/逻辑级，无 PG）：
 *   - comment_like 是【独立】风控动作：自有当日配额、不并入 like 计数、不进 like/view 比率闸、受限态清零；
 *   - 频率比率闸：早场（笔记赞少）不点，且预闸不过时【不调 LLM】；
 *   - appraiser 解析失败 / 选「都不点」/ 候选已赞 = 弃权（不发 intended），绝不默认挑第一条；
 *   - 发评论撞车护栏：近似照搬可被检出（rewrite-once-then-skip 的判据）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RiskController } from '../../src/risk/risk-controller.js';
import { EventBus } from '../../src/event-bus/index.js';
import { CommentLikeAppraiser } from '../../src/agents/comment-like-appraiser.js';
import { overlapsAny } from '../../src/agents/comment-de-ai-flavor.js';
import { topicKeysFromTitle } from '../../src/cache/valuable-comment-store.js';
import type { Soul } from '../../src/soul/types.js';
import type { NoteData } from '../../src/agents/content-curator-role.js';
import type { CommentCandidate } from '../../src/comm/protocol.js';

const mockSoul: Soul = {
  identity: { name: 'TestBot', role: 'AI爱好者', background: '技术博主', tone: '友好' },
  interests: { primary: ['AI', 'LLM'], secondary: ['编程'], seed_keywords: ['GPT'] },
};
const sampleNote: NoteData = { noteId: 'n1', title: 'LLM 微调实战', content: '步骤与代码', author: '技术猫', likeCount: 200, collectCount: 80 };
const tick = () => new Promise((r) => setTimeout(r, 15));
const candidates: CommentCandidate[] = [
  { anchorId: 'comment-a', author: '甲', text: '这个角度太妙了，学到了', alreadyLiked: false },
  { anchorId: 'comment-b', author: '乙', text: '哈哈哈笑死', alreadyLiked: false },
];

/** 构造一个 appraiser，driveScroll 后回收 intended/skipped 事件与 LLM 调用次数。 */
function makeAppraiser(opts: {
  llmOut: string;
  sessionLikeCounts?: { noteLikes: number; commentLikes: number };
  remainingCommentLikes?: number;
  ratio?: number;
  likeProbability?: number;
  dailyRemaining?: number;
}) {
  const bus = new EventBus();
  let llmCalls = 0;
  const llm = { complete: async () => { llmCalls += 1; return opts.llmOut; } };
  const role = new CommentLikeAppraiser({
    eventBus: bus,
    soul: mockSoul,
    llm,
    getNoteData: () => sampleNote,
    getRemainingCommentLikes: () => opts.remainingCommentLikes ?? 3,
    getSessionLikeCounts: () => opts.sessionLikeCounts ?? { noteLikes: 10, commentLikes: 0 },
    getCommentLikeDailyRemaining: () => opts.dailyRemaining ?? 6,
    ratio: opts.ratio ?? 0.15,
    likeProbability: opts.likeProbability ?? 1, // 默认不被 Bernoulli 拦（测其他闸）
    random: () => 0, // 确定性：random()<likeProbability 恒真
  });
  const intended: unknown[] = [];
  const skipped: { reason: string }[] = [];
  bus.on('comment_like.intended', (e) => { intended.push(e); });
  bus.on('comment_like.skipped', (e) => { skipped.push(e as { reason: string }); });
  role.subscribe();
  async function driveScroll(cands: CommentCandidate[] = candidates) {
    bus.emit('reading.scroll_comments', { noteId: 'n1', sourcePageType: 'feed', ts: 0 });
    bus.emit('action.completed', { action: 'scroll_comments', ok: true, candidates: cands, ts: 0 });
    await tick();
  }
  return { bus, role, driveScroll, intended, skipped, llmCalls: () => llmCalls };
}

describe('AC-CLIKE 评论点赞红线', () => {
  it('AC-CLIKE-RISK comment_like 是独立风控动作：自有配额、不并入 like、受限清零', async () => {
    const rc = new RiskController({ quotaLevel: 'normal' });
    // 自有当日配额（normal=6），与 like（50）各算各的
    assert.equal(rc.dailyRemaining('comment_like'), 6, 'comment_like 应有独立当日配额 normal=6');
    assert.equal(rc.dailyRemaining('like'), 50);
    // 记一条 comment_like → 绝不消耗 like 配额（独立计数，不并入笔记赞）
    assert.equal(await rc.record('comment_like'), true);
    assert.equal(rc.dailyRemaining('like'), 50, '独立计数：comment_like 不消耗 like 配额');
    assert.equal(rc.canDo('like'), true, 'comment_like 不应影响笔记赞放行（含 like/view 比率仅认 like）');
    // 受限态：comment_like 与其它互动一起被清零（仅放行 view）
    const rc2 = new RiskController({ quotaLevel: 'normal' });
    await rc2.applySignal({ kind: 'light' });
    await rc2.applySignal({ kind: 'light' });
    assert.equal(rc2.getState().status, 'restricted');
    assert.equal(rc2.canDo('comment_like'), false, 'restricted 下 comment_like 必须停');
    assert.equal(rc2.canDo('view'), true);
  });

  it('AC-CLIKE-ABSTAIN 解析失败 → 弃权（不发 intended）', async () => {
    const a = makeAppraiser({ llmOut: '这不是JSON' });
    await a.driveScroll();
    assert.equal(a.intended.length, 0, '解析失败绝不下发');
    assert.equal(a.skipped.at(-1)?.reason, 'abstain_or_parse_failed');
  });

  it('AC-CLIKE-ABSTAIN pick=0（都不点）→ 弃权', async () => {
    const a = makeAppraiser({ llmOut: '{"pick":0,"reason":"都一般"}' });
    await a.driveScroll();
    assert.equal(a.intended.length, 0);
  });

  it('AC-CLIKE-PICK 合法 pick → 下发 intended（命中所选锚点）', async () => {
    const a = makeAppraiser({ llmOut: '{"pick":1,"reason":"角度妙"}' });
    await a.driveScroll();
    assert.equal(a.intended.length, 1);
    assert.equal((a.intended[0] as { commentAnchorId: string }).commentAnchorId, 'comment-a');
  });

  it('AC-CLIKE-RATIO 早场（笔记赞少）→ 比率闸拦，且不调 LLM', async () => {
    const a = makeAppraiser({ llmOut: '{"pick":1}', sessionLikeCounts: { noteLikes: 1, commentLikes: 0 } });
    await a.driveScroll();
    assert.equal(a.intended.length, 0, '比率不满足应弃权');
    assert.equal(a.skipped.at(-1)?.reason, 'ratio_gate');
    assert.equal(a.llmCalls(), 0, '预闸不过绝不调 LLM');
  });

  it('AC-CLIKE-ABSTAIN 候选全已赞 → 弃权（绝不回点已赞）', async () => {
    const a = makeAppraiser({ llmOut: '{"pick":1}' });
    await a.driveScroll([{ anchorId: 'comment-a', text: '已赞过', alreadyLiked: true }]);
    assert.equal(a.intended.length, 0);
    assert.equal(a.skipped.at(-1)?.reason, 'no_usable_candidate');
    assert.equal(a.llmCalls(), 0);
  });

  it('AC-CLIKE-OVERLAP 近似照搬可被检出（撞车护栏判据）', () => {
    const ref = '这个角度太妙了，学到了很多东西';
    assert.equal(overlapsAny('这个角度太妙了，学到了很多东西！', [ref]), true, '近似照搬应判 true');
    assert.equal(overlapsAny('完全不同的一句独立看法', [ref]), false, '不相干应判 false');
    assert.equal(overlapsAny('随便', []), false, '无参考恒 false');
  });

  it('AC-CLIKE-TOPICKEYS 标题派生主题键（拉丁词 + CJK 二元组）', () => {
    const keys = topicKeysFromTitle('LLM 微调实战');
    assert.ok(keys.includes('llm'), '应含小写拉丁词 llm');
    assert.ok(keys.includes('微调'), '应含 CJK 二元组 微调');
    assert.deepEqual(topicKeysFromTitle(undefined), [], '无标题 → 空');
  });
});
