import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../src/event-bus/index.js';
import { ContentCuratorRole, type NoteData } from '../../src/agents/content-curator-role.js';
import { ContentEvaluator } from '../../src/agents/content-evaluator.js';
import { DeepReader } from '../../src/agents/deep-reader.js';
import { CommentReviewer } from '../../src/agents/comment-reviewer.js';
import { InteractionAppraiserRole } from '../../src/agents/interaction-appraiser-role.js';
import { CommentAppraiser } from '../../src/agents/comment-appraiser.js';
import { SessionContext } from '../../src/agents/session-context.js';
import type { CommentAppraisedPayload, InteractionCompletedPayload, QualityRejectPayload } from '../../src/event-bus/types.js';
import type { Soul } from '../../src/kernel/soul-types.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const soul: Soul = {
  identity: { name: 'Minh Anh', role: 'người tìm việc', background: 'Tìm mọi việc tại Việt Nam', tone: 'thân thiện' },
  interests: { primary: ['tuyển dụng'], secondary: [], seed_keywords: ['cần tuyển'] },
  mandatory_interactions: [{
    id: 'vietnam-recruitment',
    when: 'Bài đăng tuyển dụng hoặc tuyển người tại Việt Nam',
    actions: ['like', 'comment'],
    comment_guidance: 'Bình luận bằng tiếng Việt, hỏi về lương hoặc ca làm.',
    comment_approval: 'auto_approve',
  }],
};
const note: NoteData = {
  noteId: 'fb-101',
  title: 'CẦN TUYỂN NHÂN VIÊN',
  content: 'Cần tuyển công nhân làm việc tại Bình Dương, liên hệ để biết ca làm.',
  author: 'Nhà máy A',
  likeCount: 0,
  collectCount: 0,
};

describe('mandatory interaction causal flow', () => {
  it('列表候选把可能命中强制规则的卡片放在普通兴趣之前，并保留品牌安全底线', async () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    let prompt = '';
    const evaluator = new ContentEvaluator({
      eventBus: bus,
      soul,
      llm: { complete: async (input) => {
        prompt = input;
        return '{"verdict":"valuable","index":1,"reason":"可能命中越南招工规则"}';
      } },
    }, ctx, () => 1);
    evaluator.setVisibleCards([
      { index: 3, noteId: 'fb-other', title: 'Món ngon cuối tuần', likeCount: 10, collectCount: 0 },
      { index: 7, noteId: 'fb-job', title: 'CẦN TUYỂN CÔNG NHÂN TẠI BÌNH DƯƠNG', likeCount: 0, collectCount: 0 },
    ]);
    let selected: any = null;
    bus.on('content.valuable', (payload) => { selected = payload; });

    await evaluator.evaluate('feed');

    assert.match(prompt, /优先级高于普通兴趣挑选/);
    assert.match(prompt, /品牌安全底线仍优先/);
    assert.match(prompt, /vietnam-recruitment/);
    assert.equal(selected?.noteId, 'fb-job');
  });

  it('详情命中后低热度/零软预算/冷却中仍确定性产 like + comment，不调用两层普通判定 LLM', async () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    let decisionCalls = 0;
    const matchLlm = { complete: async () => {
      decisionCalls++;
      return '{"action":"pass","mandatoryRuleId":"vietnam-recruitment","reason":"越南招工帖"}';
    } };
    const mustNotCall = { complete: async () => {
      throw new Error('ordinary appraiser must not run for mandatory match');
    } };

    const curator = new ContentCuratorRole({ eventBus: bus, soul, llm: matchLlm, sessionContext: ctx });
    const deepReader = new DeepReader({ eventBus: bus, soul, getNoteData: () => note, canBrowseImages: () => false });
    const reviewer = new CommentReviewer({ eventBus: bus, soul, llm: mustNotCall, sessionContext: ctx, getNoteData: () => note, canScrollComments: () => false });
    const interaction = new InteractionAppraiserRole({
      eventBus: bus,
      soul,
      llm: mustNotCall,
      sessionContext: ctx,
      getNoteData: () => note,
      getRemainingBudget: () => ({ likes: 0, collects: 0 }),
    });
    const comment = new CommentAppraiser({
      eventBus: bus,
      soul,
      llm: mustNotCall,
      getNoteData: () => note,
      getRemainingComments: () => 0,
      getDailyRemaining: () => 0,
      getCommentCooldownOk: () => false,
    });
    for (const role of [deepReader, reviewer, interaction, comment, curator]) role.subscribe();

    let interactionOut: InteractionCompletedPayload | null = null;
    let commentOut: CommentAppraisedPayload | null = null;
    bus.on('interaction.completed', (payload) => { interactionOut = payload; });
    bus.on('comment.appraised', (payload) => { commentOut = payload; });
    bus.emit('note.detail.arrived', { detail: note, ts: Date.now() });
    await sleep(40);

    const finalInteraction = interactionOut as InteractionCompletedPayload | null;
    const finalComment = commentOut as CommentAppraisedPayload | null;
    assert.equal(decisionCalls, 1, '只允许详情匹配 LLM 调用一次');
    assert.deepEqual(finalInteraction?.actions, ['like']);
    assert.equal(finalInteraction?.mandatoryInteraction?.ruleId, 'vietnam-recruitment');
    assert.equal(finalComment?.mandatoryInteraction?.commentApproval, 'auto_approve');
    assert.equal(finalComment?.reason, 'mandatory_rule:vietnam-recruitment');
  });

  it('详情模型返回未知 rule id → fail-closed quality.reject(parse_failed)', async () => {
    const bus = new EventBus();
    const ctx = new SessionContext();
    const curator = new ContentCuratorRole({
      eventBus: bus,
      soul,
      llm: { complete: async () => '{"action":"pass","mandatoryRuleId":"not-configured","reason":"x"}' },
      sessionContext: ctx,
    });
    curator.subscribe();
    let rejected: QualityRejectPayload | null = null;
    bus.on('quality.reject', (payload) => { rejected = payload; });
    bus.emit('note.detail.arrived', { detail: note, ts: Date.now() });
    await sleep(30);
    const finalRejected = rejected as QualityRejectPayload | null;
    assert.equal(finalRejected?.reason, 'parse_failed');
  });
});
