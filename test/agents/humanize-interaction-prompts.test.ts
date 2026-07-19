/**
 * change humanize-interaction-prompts — 新增行为的关键用例（测试克制：只覆盖 load-bearing 改动）。
 * 覆盖：判定 prompt 去评分器姿态（无 confidence / 无预算台账）+ 兜底原则选择性；深读体验 + 会话状态注入；
 *       选卡受控好奇豁免（random 可注入）；评论 reason 穿透；撰写语境注入 + nothing_genuine 诚实弃权；
 *       去 AI 味评论体裁召回（客套句命中触发改写，阈值 1）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../src/event-bus/index.js';
import { InteractionAppraiserRole } from '../../src/agents/interaction-appraiser-role.js';
import { ContentEvaluator } from '../../src/agents/content-evaluator.js';
import { CommentAppraiser } from '../../src/agents/comment-appraiser.js';
import { CommentComposer } from '../../src/agents/comment-composer.js';
import { CommentDeAiFlavor } from '../../src/agents/comment-de-ai-flavor.js';
import { SessionContext } from '../../src/agents/session-context.js';
import type { NoteData } from '../../src/agents/content-curator-role.js';
import type { Soul } from '../../src/soul/types.js';

const soul: Soul = {
  identity: { name: 'TestBot', role: 'AI研发工程师', background: '大厂做 LLM 落地', tone: '技术向、偶尔幽默' },
  interests: { primary: ['LLM'], secondary: ['RAG'], seed_keywords: ['vLLM'] },
  behavior_guidelines: { style: '精准浏览、点赞收藏讲分寸', privacy: 'x', collection_principle: '硬核才收藏', like_principle: '真戳到才点' },
};
const note = (over: Partial<NoteData> = {}): NoteData => ({ noteId: 'n1', title: 't', content: 'c', author: '作者甲', likeCount: 500, collectCount: 150, ...over });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('interaction_appraiser：去评分器姿态 + 上下文注入', () => {
  async function capturePrompt(ctx: SessionContext, payloadOver: Record<string, unknown> = {}) {
    let prompt = '';
    const role = new InteractionAppraiserRole({
      eventBus: new EventBus(), soul,
      llm: { complete: async (p) => { prompt = p; return '{"action":"pass","reason":"平"}'; } },
      sessionContext: ctx,
      getNoteData: () => note(),
      getRemainingBudget: () => ({ likes: 5, collects: 3 }),
    });
    (role as unknown as { onReadingDone: (p: unknown) => Promise<void> }).onReadingDone({
      noteId: 'n1', sourcePageType: 'feed', imagesBrowsed: 4, commentsRead: 2, keyPoints: [], readDurationMs: 0, ts: 0, ...payloadOver,
    });
    await sleep(5);
    return prompt;
  }

  it('prompt 不含 confidence 输出字段、不含剩余预算台账', async () => {
    const p = await capturePrompt(new SessionContext());
    assert.doesNotMatch(p, /confidence/);
    assert.doesNotMatch(p, /剩余预算/);
  });

  it('注入刚读完的真实体验（翻图数）', async () => {
    const p = await capturePrompt(new SessionContext());
    assert.match(p, /刚读完这篇/);
    assert.match(p, /翻了 4 张图/);
  });

  it('keyPoints 非空才注入印象（当前恒空 → 不出现）', async () => {
    const empty = await capturePrompt(new SessionContext(), { keyPoints: [] });
    assert.doesNotMatch(empty, /印象最深/);
    const withKp = await capturePrompt(new SessionContext(), { keyPoints: ['切块策略', '召回率'] });
    assert.match(withKp, /印象最深的是 切块策略；召回率/);
  });

  it('注入会话状态并在真互动后累积', async () => {
    const ctx = new SessionContext();
    ctx.markVisited('a'); ctx.markVisited('b');
    const p = await capturePrompt(ctx);
    assert.match(p, /本场你已经看过 2 篇笔记/);
    // 真互动后 recentInteractions 累积（下一篇能看到）
    const role = new InteractionAppraiserRole({
      eventBus: new EventBus(), soul,
      llm: { complete: async () => '{"action":"like","reason":"戳"}' },
      sessionContext: ctx,
      getNoteData: () => note(),
      getRemainingBudget: () => ({ likes: 5, collects: 3 }),
    });
    (role as unknown as { onReadingDone: (p: unknown) => Promise<void> }).onReadingDone({ noteId: 'n1', sourcePageType: 'feed', imagesBrowsed: 0, commentsRead: 0, keyPoints: [], readDurationMs: 0, ts: 0 });
    await sleep(5);
    assert.deepEqual([...ctx.recentInteractions], ['like']);
  });

  it('兜底点赞原则是选择性（无 behavior_guidelines 时不含「轻量高频」）', async () => {
    const noBg: Soul = { identity: soul.identity, interests: soul.interests };
    let prompt = '';
    const role = new InteractionAppraiserRole({
      eventBus: new EventBus(), soul: noBg,
      llm: { complete: async (p) => { prompt = p; return '{"action":"pass","reason":"x"}'; } },
      sessionContext: new SessionContext(),
      getNoteData: () => note(),
      getRemainingBudget: () => ({ likes: 5, collects: 3 }),
    });
    (role as unknown as { onReadingDone: (p: unknown) => Promise<void> }).onReadingDone({ noteId: 'n1', sourcePageType: 'feed', imagesBrowsed: 0, commentsRead: 0, keyPoints: [], readDurationMs: 0, ts: 0 });
    await sleep(5);
    assert.doesNotMatch(prompt, /轻量高频/);
  });

  it('三档点赞倾向逐档注入软偏好，且更喜欢仍保留 pass', () => {
    const prompts = (['normal', 'like_more', 'like_most'] as const).map((like_affinity) => {
      const role = new InteractionAppraiserRole({
        eventBus: new EventBus(),
        soul: { ...soul, behavior_guidelines: { ...soul.behavior_guidelines!, like_affinity } },
        llm: { complete: async () => '{"action":"pass","reason":"x"}' },
        sessionContext: new SessionContext(),
        getNoteData: () => note(),
        getRemainingBudget: () => ({ likes: 5, collects: 3 }),
      });
      return role.previewPrompt();
    });
    assert.match(prompts[0], /点赞倾向：正常/);
    assert.match(prompts[0], /多数普通内容仍然跳过/);
    assert.match(prompts[1], /点赞倾向：喜欢/);
    assert.match(prompts[1], /适度偏向点赞/);
    assert.match(prompts[2], /点赞倾向：更喜欢/);
    assert.match(prompts[2], /明显偏向点赞/);
    assert.match(prompts[2], /即使“更喜欢”也必须保留这个出口/);
  });

  it('更喜欢不绕过普通预算闸，也不形成 mandatory like', async () => {
    const bus = new EventBus();
    let llmCalls = 0;
    const completed: unknown[] = [];
    bus.on('interaction.completed', (event) => { completed.push(event); });
    const role = new InteractionAppraiserRole({
      eventBus: bus,
      soul: { ...soul, behavior_guidelines: { ...soul.behavior_guidelines!, like_affinity: 'like_most' } },
      llm: { complete: async () => { llmCalls++; return '{"action":"like","reason":"x"}'; } },
      sessionContext: new SessionContext(),
      getNoteData: () => note(),
      getRemainingBudget: () => ({ likes: 0, collects: 0 }),
    });
    await (role as unknown as { onReadingDone: (p: unknown) => Promise<void> }).onReadingDone({
      noteId: 'n1', sourcePageType: 'feed', imagesBrowsed: 0, commentsRead: 0, keyPoints: [], readDurationMs: 0, ts: 0,
    });
    assert.equal(llmCalls, 0, '软倾向不得绕过预算预闸');
    assert.deepEqual(completed, []);
  });
});

describe('content_evaluator：受控好奇豁免（random 可注入）', () => {
  function makeEval(random: () => number) {
    let prompt = '';
    const role = new ContentEvaluator(
      { eventBus: new EventBus(), soul, llm: { complete: async (p) => { prompt = p; return '{"verdict":"skip","reason":"无"}'; } } },
      new SessionContext(),
      random,
    );
    role.setVisibleCards([{ index: 0, title: '有趣标题', likeCount: 10, collectCount: 2 }]);
    return { role, getPrompt: () => prompt };
  }
  it('掷骰命中（random=0）→ 追加好奇许可', async () => {
    const { role, getPrompt } = makeEval(() => 0);
    await role.evaluate('feed');
    assert.match(getPrompt(), /兴趣之外/);
  });
  it('掷骰未命中（random=0.99）→ prompt 无好奇许可', async () => {
    const { role, getPrompt } = makeEval(() => 0.99);
    await role.evaluate('feed');
    assert.doesNotMatch(getPrompt(), /兴趣之外/);
  });
});

describe('评论链：reason 穿透 + 撰写语境 + 诚实弃权', () => {
  it('comment_appraiser 把 reason 穿透进 comment.appraised', async () => {
    const bus = new EventBus();
    const role = new CommentAppraiser({
      eventBus: bus, soul,
      llm: { complete: async () => '{"comment":true,"reason":"这条讲透了推理优化"}' },
      getNoteData: () => note({ likeCount: 2000, collectCount: 500 }),
      getRemainingComments: () => 2,
    });
    role.subscribe();
    let appraised: any = null;
    bus.on('comment.appraised', (p) => { appraised = p; });
    bus.emit('interaction.completed', { noteId: 'n1', sourcePageType: 'feed', actions: ['like'], ts: Date.now() });
    await sleep(20);
    assert.equal(appraised?.reason, '这条讲透了推理优化');
  });

  it('comment_composer 注入 reason/互动类型/作者，decline → skip(nothing_genuine)', async () => {
    const bus = new EventBus();
    let prompt = '';
    const role = new CommentComposer({
      eventBus: bus, soul,
      getNoteData: () => note(),
      llm: { complete: async (p) => { prompt = p; return '{"decline":"nothing_genuine"}'; } },
    });
    role.subscribe();
    let skipped: any = null;
    let composed: any = null;
    bus.on('comment.skipped', (p) => { skipped = p; });
    bus.on('comment.composed', (p) => { composed = p; });
    bus.emit('comment.appraised', { noteId: 'n1', sourcePageType: 'feed', actions: ['like', 'collect'], reason: '真有共鸣', ts: Date.now() });
    await sleep(20);
    assert.match(prompt, /真有共鸣/);
    assert.match(prompt, /点赞并收藏了/);
    assert.match(prompt, /作者甲/);
    assert.equal(composed, null, '弃权不产出草稿');
    assert.equal(skipped?.reason, 'nothing_genuine');
  });
});

describe('comment_de_ai_flavor：评论体裁客套句召回（阈值 1）', () => {
  it('单条客套句「感谢分享」命中 → 触发人设口吻改写', async () => {
    const bus = new EventBus();
    let rewriteCalled = false;
    const role = new CommentDeAiFlavor({
      eventBus: bus, soul,
      llm: { complete: async () => { rewriteCalled = true; return '这套思路挺实在的'; } },
    });
    role.subscribe();
    let cleared: any = null;
    bus.on('comment.cleared', (p) => { cleared = p; });
    bus.emit('comment.composed', { noteId: 'n1', sourcePageType: 'feed', actions: ['like'], draft: '感谢分享，很有用', ts: Date.now() });
    await sleep(20);
    assert.equal(rewriteCalled, true, '客套句应触发改写（阈值 1）');
    assert.equal(cleared?.text, '这套思路挺实在的');
  });

  it('正常口语评论不触发改写', async () => {
    const bus = new EventBus();
    let rewriteCalled = false;
    const role = new CommentDeAiFlavor({
      eventBus: bus, soul,
      llm: { complete: async () => { rewriteCalled = true; return 'x'; } },
    });
    role.subscribe();
    bus.emit('comment.composed', { noteId: 'n1', sourcePageType: 'feed', actions: ['like'], draft: '这个分块策略我也踩过坑，后来换了重叠窗口', ts: Date.now() });
    await sleep(20);
    assert.equal(rewriteCalled, false);
  });
});
