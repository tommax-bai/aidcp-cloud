/**
 * Integration tests for RoleDispatcher — 验证6条闭环路径。
 *
 * 每个测试用 mock LLM 返回预设结果，验证事件链正确传播并最终回到 feed.entered。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RoleDispatcher } from '@automation/orchestrator/role-dispatcher.js';
import type { EdgeCommand } from '@automation/orchestrator/role-dispatcher.js';
import { SEARCH_THRESHOLD } from '@automation/agents/feed-scroller.js';
import type { Soul } from '@kernel/kernel/soul-types.js';
import type { EventBus } from '@automation/event-bus/index.js';

const mockSoul: Soul = {
  identity: { name: 'TestBot', role: 'AI爱好者', background: '技术博主', tone: '友好' },
  interests: { primary: ['AI', 'LLM'], secondary: ['编程', '技术'], seed_keywords: ['GPT', 'Transformer', 'RAG'] },
};

/** 创建 mock LLM，每次调用使用 setTimeout 模拟真实异步 */
function createMockLlm(responses: string[]) {
  let callIndex = 0;
  return {
    complete: async (_prompt: string): Promise<string> => {
      const resp = responses[callIndex] ?? responses[responses.length - 1];
      callIndex++;
      return new Promise((resolve) => setTimeout(() => resolve(resp), 5));
    },
    get callCount() { return callIndex; },
  };
}

/** 等待指定事件触发（带 predicate 过滤和超时） */
function waitForEvent<T = unknown>(
  bus: EventBus,
  event: string,
  predicate?: (p: T) => boolean,
  timeoutMs = 5000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(new Error(`Timeout (${timeoutMs}ms) waiting for event "${event}"`));
    }, timeoutMs);
    const unsub = (bus as any).on(event, (p: T) => {
      if (!predicate || predicate(p)) {
        clearTimeout(timer);
        unsub();
        resolve(p);
      }
    });
  });
}

/**
 * 构造带"假边缘"闭环回应的 dispatcher：模拟真实边缘对云端指令的回报，让 mock-LLM 驱动的
 * 链路能跑到底（否则会停在"等边缘回传"处超时）：
 *  - 开普通笔记(open_note) → 回 note.detail.arrived（带 note 数据），
 *    触发 ContentCurator 等下游（它监听 note.detail.arrived，而非已废弃的 note.entered）；
 *  - 深读子动作(browse_images / scroll_comments) → 回 action.completed{ok:true}，
 *    让 DeepReader / CommentReviewer 据回执推进到 reading.images_done / reading.done；
 *  - 进主页(profile_open) → 回 profile.detail.arrived（带作者资料），触发 ProfileBrowser → FollowAgent；
 *  - 关注(follow) → 回 action.completed{action:'follow', ok:true}，触发 BackToFeed 返回。
 */
function makeDispatcher(
  llm: { complete(p: string): Promise<string> },
  commands: EdgeCommand[],
  note?: { noteId: string; title: string; content: string; author?: string; authorId?: string; likeCount: number; collectCount: number },
  profile?: { authorId: string; postsCount: number; followersCount: number; extracted?: boolean },
): RoleDispatcher {
  let dispatcher: RoleDispatcher;
  const sendCommand = (cmd: EdgeCommand): void => {
    commands.push(cmd);
    if (cmd.action === 'open_note' && note) {
      setTimeout(() => dispatcher.bus.emit('note.detail.arrived', { detail: note, ts: Date.now() }), 0);
    } else if (cmd.action === 'browse_images' || cmd.action === 'scroll_comments') {
      setTimeout(() => dispatcher.bus.emit('action.completed', { action: cmd.action, ok: true, ts: Date.now() }), 0);
    } else if (cmd.action === 'profile_open') {
      const detail = profile ?? { authorId: 'author_pro', postsCount: 50, followersCount: 10000, extracted: true };
      setTimeout(() => dispatcher.bus.emit('profile.detail.arrived', { detail, ts: Date.now() }), 0);
    } else if (cmd.action === 'follow') {
      setTimeout(() => dispatcher.bus.emit('action.completed', { action: 'follow', ok: true, ts: Date.now() }), 0);
    }
  };
  dispatcher = new RoleDispatcher({ soul: mockSoul, llm, sendCommand });
  return dispatcher;
}

describe('RoleDispatcher Integration', () => {

  // ─── 路径 A: 无价值→翻页 ─────────────────────────────────────

  it('路径A: 无价值卡片 → content.no_valuable → FeedScroller → feed.scrolled → scroll指令', async () => {
    const commands: EdgeCommand[] = [];
    const llm = createMockLlm(['{"verdict":"skip","reason":"不相关"}']);
    const dispatcher = new RoleDispatcher({ soul: mockSoul, llm, sendCommand: (cmd) => commands.push(cmd) });
    dispatcher.setup();
    dispatcher.startSession();

    // 模拟 Edge 反馈循环：每次 scroll 指令后 Edge 上报新的空卡片
    // 第一次触发：空卡片 → content.no_valuable → FeedScroller → feed.scrolled → scroll指令
    for (let i = 0; i < 4; i++) {
      dispatcher.bus.emit('page.cards.arrived', { cards: [], ts: Date.now() });
      await new Promise((r) => setTimeout(r, 10));
    }

    // 验证：4次 scroll 指令
    const scrollCmds = commands.filter((c) => c.action === 'scroll' && c.reason === 'feed_scroll');
    assert.ok(scrollCmds.length >= 4, `应有至少4个scroll指令, 实际=${scrollCmds.length}`);

    dispatcher.endSession();
  });

  // ─── idle 看门狗 nudge 接线 ───────────────────────────────────

  it('看门狗: session.idle_nudge → scroll 指令(idle_recover_nudge)', async () => {
    const commands: EdgeCommand[] = [];
    const llm = createMockLlm([]);
    const dispatcher = new RoleDispatcher({ soul: mockSoul, llm, sendCommand: (cmd) => commands.push(cmd) });
    dispatcher.setup();
    dispatcher.startSession();

    // 模拟看门狗在停滞时发出的恢复 nudge（SessionMonitor.checkIdle 会 emit 该事件）
    dispatcher.bus.emit('session.idle_nudge', { reason: 'idle_recover_nudge', ts: Date.now() });
    await new Promise((r) => setTimeout(r, 10));

    const nudgeScroll = commands.filter((c) => c.action === 'scroll' && c.reason === 'idle_recover_nudge');
    assert.equal(nudgeScroll.length, 1, `idle_nudge 应翻译为一次 scroll(idle_recover_nudge)，实际=${nudgeScroll.length}`);

    dispatcher.endSession();
  });

  it('排队态: transport 在线但 browser absent 时不激活看门狗，ready 后才开场，standby 后再拆除', async () => {
    const commands: EdgeCommand[] = [];
    const dispatcher = new RoleDispatcher({
      soul: mockSoul,
      llm: createMockLlm([]),
      sendCommand: (cmd) => commands.push(cmd),
    });
    dispatcher.setup();

    dispatcher.bus.emit('edge.hello', {
      edgeId: 'edge-queued',
      accountId: 'acct-queued',
      browserState: 'absent',
      ts: 1,
    });
    assert.equal(dispatcher.active, false, 'hello 只证明控制面在线，browser absent 时不得开浏览会话');

    dispatcher.bus.emit('session.idle_nudge', { reason: 'idle_recover_nudge', ts: 240_001 });
    assert.equal(
      commands.filter((cmd) => cmd.action === 'scroll' && cmd.reason === 'idle_recover_nudge').length,
      0,
      '排队超过看门狗阈值也没有页面恢复命令',
    );

    dispatcher.bus.emit('edge.browser_status', { state: 'ready', reason: 'wake_completed', ts: 250_000 });
    assert.equal(dispatcher.active, true, '只有 browser ready 才激活浏览会话');
    dispatcher.bus.emit('session.idle_nudge', { reason: 'idle_recover_nudge', ts: 490_001 });
    assert.equal(
      commands.filter((cmd) => cmd.action === 'scroll' && cmd.reason === 'idle_recover_nudge').length,
      1,
      'ready 后页面看门狗恢复正常翻译',
    );

    dispatcher.bus.emit('edge.browser_status', { state: 'absent', reason: 'cold_standby', ts: 500_000 });
    assert.equal(dispatcher.active, false, '浏览器进入待机后立即拆除浏览会话/看门狗');
    dispatcher.bus.emit('session.idle_nudge', { reason: 'idle_recover_nudge', ts: 740_001 });
    assert.equal(
      commands.filter((cmd) => cmd.action === 'scroll' && cmd.reason === 'idle_recover_nudge').length,
      1,
      'standby 后不得残留页面恢复翻译',
    );
  });

  it('facebook: Feed scroll 出口在 normal 档携带 11s dwellMs 中心', async () => {
    const commands: EdgeCommand[] = [];
    const llm = createMockLlm([]);
    const dispatcher = new RoleDispatcher({
      soul: mockSoul,
      llm,
      sendCommand: (cmd) => commands.push(cmd),
      accountPlatform: 'facebook',
      getNickname: () => 'FB Name',
    });
    dispatcher.setCurrentAccountId('fb-acc');
    dispatcher.setup();
    dispatcher.startSession();

    dispatcher.bus.emit('feed.scrolled', { pageType: 'feed', scrollCount: 1, ts: Date.now() });
    await new Promise((r) => setTimeout(r, 10));

    const scroll = commands.find((c) => c.action === 'scroll' && c.reason === 'feed_scroll');
    assert.ok(scroll, '应下发 feed_scroll');
    assert.equal(
      scroll!.params?.dwellMs,
      11_000,
      `FB Feed scroll 出口应有 11s normal 中心，实际=${JSON.stringify(scroll!.params)}`,
    );
    dispatcher.endSession();
  });

  it('facebook: Reels 续刷复用同一个 11s dwellMs 中心', async () => {
    const commands: EdgeCommand[] = [];
    const dispatcher = new RoleDispatcher({
      soul: mockSoul,
      llm: createMockLlm([]),
      sendCommand: (cmd) => commands.push(cmd),
      accountPlatform: 'facebook',
      facebookRuleModeDecision: () => ({
        mode: 'facebook_rule',
        blocker: null,
        policyRevision: 1,
        rulePolicy: { viewsPerLike: 5, joinEveryNRounds: 2 },
      }),
      applyFacebookRuleView: async () => { throw new Error('invalid Reel identity must short-circuit first'); },
      updateFacebookRuleBatch: async () => undefined,
    });
    dispatcher.setCurrentAccountId('fb-acc');
    dispatcher.setup();
    dispatcher.startSession();

    dispatcher.bus.emit('facebook.rule.view.confirmed', {
      accountId: 'fb-acc',
      noteId: '',
      sourceDedupeKey: 'reel-without-stable-key',
      source: 'reels',
      occurredAt: Date.now(),
    });
    await new Promise((r) => setTimeout(r, 10));

    const scroll = commands.find((c) => c.action === 'scroll' && c.reason === 'rule_unstable_content_key');
    assert.ok(scroll, `Reels 续刷应复用统一 scroll 出口，实际=${JSON.stringify(commands)}`);
    assert.equal(scroll!.params?.dwellMs, 11_000);
    dispatcher.endSession();
  });

  it('facebook: 首批 page.cards{startupId} 仅就地读取本人身份，不访问 profile、不恢复页面', async () => {
    const commands: EdgeCommand[] = [];
    const setCalls: { accountId: string; nickname: string }[] = [];
    const llm = createMockLlm([]);
    const dispatcher = new RoleDispatcher({
      soul: mockSoul,
      llm,
      sendCommand: (cmd) => commands.push(cmd),
      accountPlatform: 'facebook',
      hasIdentityReadCurrent: () => true,
      getNickname: () => null,
      setNickname: (accountId, nickname) => { setCalls.push({ accountId, nickname }); },
    });
    dispatcher.setCurrentAccountId('fb-acc');
    dispatcher.setup();
    dispatcher.startSession();

    // 时机统一：FB 与 XHS 同样在「完整浏览器启动后首批 page.cards{startupId}」武装本人昵称采集。
    dispatcher.bus.emit('page.cards.arrived', { cards: [], startupId: 'fb-startup-1', ts: Date.now() });
    await new Promise((r) => setTimeout(r, 10));

    const identityRead = commands.find((c) => c.action === 'identity_read_current');
    assert.ok(identityRead, 'FB 首批 page.cards{startupId} 应下发无导航身份读取');
    assert.equal(commands.some((c) => c.action === 'profile_open'), false, '本人身份读取不得复用作者主页命令');
    const captureId = (identityRead!.params as { captureId?: string }).captureId;
    assert.ok(captureId);

    dispatcher.bus.emit('identity.observed.arrived', {
      observation: {
        captureId,
        accountId: 'fb-acc',
        nickname: '真实FB昵称',
        source: 'current_page',
        pageEffect: 'none',
      },
      accountId: 'fb-acc',
      ts: Date.now(),
    });
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(setCalls, [{ accountId: 'fb-acc', nickname: '真实FB昵称' }], 'FB 就地读回的非空昵称应差异写库');
    assert.equal(
      commands.some((c) => c.action === 'back' || c.action === 'refresh'),
      false,
      'FB 就地读取完成后不得发页面恢复命令',
    );

    dispatcher.endSession();
  });

  it('facebook: 旧 Edge 未声明身份能力时跳过二次采集，不回落 profile.open', async () => {
    const commands: EdgeCommand[] = [];
    const dispatcher = new RoleDispatcher({
      soul: mockSoul,
      llm: createMockLlm([]),
      sendCommand: (cmd) => commands.push(cmd),
      accountPlatform: 'facebook',
    });
    dispatcher.setCurrentAccountId('fb-old-edge');
    dispatcher.setup();
    dispatcher.startSession();
    dispatcher.bus.emit('page.cards.arrived', {
      cards: [],
      startupId: 'fb-old-startup',
      ts: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(commands.some((command) => command.action === 'identity_read_current'), false);
    assert.equal(commands.some((command) => command.action === 'profile_open'), false);
    dispatcher.endSession();
  });

  // ─── back_to_feed 透传 sourcePageType → targetPage ───────────

  it('back_to_feed: feed.entered{pageType} 透传为 navigation.back{targetPage}（搜索会话回搜索结果）', async () => {
    const commands: EdgeCommand[] = [];
    const llm = createMockLlm([]);
    const dispatcher = new RoleDispatcher({ soul: mockSoul, llm, sendCommand: (cmd) => commands.push(cmd) });
    dispatcher.setup();
    dispatcher.startSession();

    dispatcher.bus.emit('feed.entered', { pageType: 'search', trigger: 'back_to_feed', ts: Date.now() });
    await new Promise((r) => setTimeout(r, 10));
    const backSearch = commands.filter((c) => c.action === 'back' && (c.params as { targetPage?: string })?.targetPage === 'search');
    assert.equal(backSearch.length, 1, `搜索来源 back 应带 targetPage:'search'，实际=${JSON.stringify(commands.filter(c => c.action === 'back'))}`);

    dispatcher.bus.emit('feed.entered', { pageType: 'feed', trigger: 'back_to_feed', ts: Date.now() });
    await new Promise((r) => setTimeout(r, 10));
    const backFeed = commands.filter((c) => c.action === 'back' && (c.params as { targetPage?: string })?.targetPage === 'feed');
    assert.equal(backFeed.length, 1, `feed 来源 back 应带 targetPage:'feed'`);

    dispatcher.endSession();
  });

  // ─── 路径 B: 搜索链路 ────────────────────────────────────────

  it('路径B: 连续无价值滚动 → search.needed → SearchEvaluator → search.approved → SearchExecutor → feed.entered(search)', async () => {
    const commands: EdgeCommand[] = [];
    // ContentEvaluator 连续 SEARCH_THRESHOLD 次返回 skip（触发搜索阈值，change bounded-search-excursion 后为 20），
    // 随后 SearchEvaluator 返回 search。用常量而非硬编码 5，使本用例对阈值调整稳健。
    const llm = createMockLlm([
      ...Array.from({ length: SEARCH_THRESHOLD }, () => '{"verdict":"skip","reason":"不相关"}'),
      '{"verdict":"search","keyword":"GPT","reason":"需要搜索新内容"}',
    ]);
    const dispatcher = new RoleDispatcher({ soul: mockSoul, llm, sendCommand: (cmd) => commands.push(cmd) });
    dispatcher.setup();

    const cards = [{ index: 0, title: '美食攻略', likeCount: 10, collectCount: 2, noteId: 'food1' }];

    // 等待 search_completed 事件
    const searchCompletedPromise = waitForEvent(
      dispatcher.bus,
      'feed.entered',
      (p: any) => p.trigger === 'search_completed' && p.pageType === 'search',
      8000,
    );

    dispatcher.startSession();

    // 模拟 Edge 反馈循环：SEARCH_THRESHOLD 次卡片上报触发评估（同一 noteId → feedCardsBrowsed 恒 1、不触发 60 张刷新）
    for (let i = 0; i < SEARCH_THRESHOLD; i++) {
      dispatcher.bus.emit('page.cards.arrived', { cards, ts: Date.now() });
      await new Promise((r) => setTimeout(r, 20));
    }

    await searchCompletedPromise;

    // 验证 search 指令
    const searchCmd = commands.find((c) => c.action === 'search');
    assert.ok(searchCmd, '应产出 search 指令');
    assert.equal((searchCmd!.params as any)?.keyword, 'GPT');

    // 验证有多个 scroll 指令
    const scrollCmds = commands.filter((c) => c.action === 'scroll');
    assert.ok(scrollCmds.length >= 4, `应有至少4个scroll指令, 实际=${scrollCmds.length}`);

    dispatcher.endSession();
  });

  // ─── 路径 C: 有价值→质量差 ────────────────────────────────────

  it('路径C: content.valuable → NoteOpener → note.entered → ContentCurator(reject) → quality.reject → BackToFeed → feed.entered', async () => {
    const commands: EdgeCommand[] = [];
    // 第1次 LLM：ContentEvaluator → valuable
    // 第2次 LLM：ContentCuratorRole → close_note (reject)
    const llm = createMockLlm([
      '{"verdict":"valuable","index":0,"reason":"AI技术相关","confidence":0.9}',
      '{"action":"close_note","reason":"内容空洞无深度","confidence":0.8}',
    ]);
    const note = {
      noteId: 'note_0', title: 'AI绘画教程', content: '标题党文章，无实质内容...',
      author: '小红', likeCount: 100, collectCount: 50,
    };
    const dispatcher = makeDispatcher(llm, commands, note);
    dispatcher.setup();
    dispatcher.updateNoteData(note);

    // 等待 back_to_feed 事件
    const backToFeedPromise = waitForEvent(
      dispatcher.bus,
      'feed.entered',
      (p: any) => p.trigger === 'back_to_feed',
      5000,
    );

    dispatcher.startSession();

    // 模拟 Edge 上报卡片，触发评估
    dispatcher.bus.emit('page.cards.arrived', {
      cards: [{ index: 0, title: 'AI绘画教程', likeCount: 100, collectCount: 50, noteId: 'note_0' }],
      ts: Date.now(),
    });

    await backToFeedPromise;

    // 验证 open_note 指令
    assert.ok(commands.some((c) => c.action === 'open_note'),
      '应产出 open_note 指令');

    // 验证返回指令（统一经 feed.entered(back_to_feed) → back）
    assert.ok(commands.some((c) => c.action === 'back' && c.reason === 'back_to_feed'),
      '应产出 back 指令');

    dispatcher.endSession();
  });

  // ─── 路径 D: 质量好→不互动 ────────────────────────────────────

  it('路径D: quality.pass → DeepReader → reading.done → InteractionAppraiser(skip) → interaction.skipped → BackToFeed → feed.entered', async () => {
    const commands: EdgeCommand[] = [];
    // 第1次：ContentEvaluator → valuable
    // 第2次：ContentCuratorRole → pass
    // 第3次：InteractionAppraiser → pass（不互动）
    const llm = createMockLlm([
      '{"verdict":"valuable","index":0,"reason":"与LLM相关","confidence":0.9}',
      '{"action":"pass","reason":"内容有料有深度","confidence":0.85}',
      '{"action":"skip","reason":"评论无需浏览"}',
      '{"action":"pass","reason":"还不够惊艳","confidence":0.5}',
    ]);
    const note = {
      noteId: 'note_0', title: 'LLM最新进展', content: '详细的技术分析，包含架构设计与benchmark...',
      author: '技术猫', likeCount: 200, collectCount: 80,
    };
    const dispatcher = makeDispatcher(llm, commands, note);
    dispatcher.setup();
    dispatcher.updateNoteData(note);

    // 等待 back_to_feed
    const backToFeedPromise = waitForEvent(
      dispatcher.bus,
      'feed.entered',
      (p: any) => p.trigger === 'back_to_feed',
      5000,
    );

    dispatcher.startSession();

    // 模拟 Edge 上报卡片
    dispatcher.bus.emit('page.cards.arrived', {
      cards: [{ index: 0, title: 'LLM最新进展', likeCount: 200, collectCount: 80, noteId: 'note_0' }],
      ts: Date.now(),
    });

    await backToFeedPromise;

    // 验证 open_note 指令
    assert.ok(commands.some((c) => c.action === 'open_note'),
      '应产出 open_note 指令');

    // 验证无 like/collect 指令
    assert.ok(!commands.some((c) => c.action === 'like' || c.action === 'collect'),
      '不应产出互动指令');

    dispatcher.endSession();
  });

  // ─── 路径 E: 互动→不去主页 ────────────────────────────────────

  it('路径E: interaction.completed → AuthorEvaluator(skip) → profile.skipped → BackToFeed → feed.entered', async () => {
    const commands: EdgeCommand[] = [];
    // 第1次：ContentEvaluator → valuable
    // 第2次：ContentCuratorRole → pass
    // 第3次：InteractionAppraiser → like
    // 第4次：AuthorEvaluator → skip
    const llm = createMockLlm([
      '{"verdict":"valuable","index":0,"reason":"与AI相关","confidence":0.9}',
      '{"action":"pass","reason":"内容优质","confidence":0.9}',
      '{"action":"skip","reason":"评论无需浏览"}',
      '{"action":"like","reason":"有启发","confidence":0.8}',
      '{"verdict":"skip","reason":"作者方向与兴趣不完全匹配"}',
    ]);
    const note = {
      noteId: 'note_0', title: 'AI Agent实践', content: '深度讲解AI Agent架构...',
      author: '博主A', authorId: 'author_1', likeCount: 300, collectCount: 100,
    };
    const dispatcher = makeDispatcher(llm, commands, note);
    dispatcher.setup();
    dispatcher.updateNoteData(note);

    // 等待 back_to_feed（由 profile.skipped 触发）
    const backToFeedPromise = waitForEvent(
      dispatcher.bus,
      'feed.entered',
      (p: any) => p.trigger === 'back_to_feed',
      5000,
    );

    dispatcher.startSession();

    // 模拟 Edge 上报卡片
    dispatcher.bus.emit('page.cards.arrived', {
      cards: [{ index: 0, title: 'AI Agent实践', likeCount: 300, collectCount: 100, noteId: 'note_0' }],
      ts: Date.now(),
    });

    await backToFeedPromise;

    // 验证 like 指令
    assert.ok(commands.some((c) => c.action === 'like'),
      '应产出 like 指令');

    // 验证无 profile 打开指令
    const profileOpen = commands.find((c) => c.action === 'profile_open');
    assert.ok(!profileOpen, '不应打开 profile');

    dispatcher.endSession();
  });

  // ─── 路径 F: 完整 Profile 链路 ─────────────────────────────────

  it('路径F: interaction.completed → AuthorEvaluator(visit) → ProfileOpener → ProfileBrowser → FollowAgent → profile.done → BackToFeed → feed.entered', async () => {
    const commands: EdgeCommand[] = [];
    // 第1次：ContentEvaluator → valuable
    // 第2次：ContentCuratorRole → pass（quality）
    // 第3次：CommentReviewer → skip（reading）
    // 第4次：InteractionAppraiser → collect
    // 第5次：CommentAppraiser → comment:false（不评，走 comment.skipped → 是否进主页评估）
    // 第6次：AuthorEvaluator → visit
    // 第7次：FollowAgent → follow
    const llm = createMockLlm([
      '{"verdict":"valuable","index":0,"reason":"深度技术文章","confidence":0.95}',
      '{"action":"pass","reason":"高质量原创内容","confidence":0.9}',
      '{"action":"skip","reason":"评论无需浏览"}',
      '{"action":"collect","reason":"值得反复参考","confidence":0.9}',
      '{"comment":false,"reason":"无真实可说，不评"}',
      '{"verdict":"visit","reason":"作者专业度极高","confidence":0.85}',
      '{"verdict":"follow","reason":"持续优质输出","confidence":0.8}',
    ]);
    // 高热度精品笔记（>1000 赞 且 >300 收藏）：过 engagement-restraint 评论硬数值门槛，
    // 使 CommentAppraiser 仍调 LLM（消费 comment:false 那次），保持 7 次 LLM 调用序列对齐。
    const note = {
      noteId: 'note_0', title: '深度学习实战指南',
      content: '非常优质的深度学习实战文章，包含完整代码和架构图...',
      author: '大佬博主', authorId: 'author_pro', likeCount: 1500, collectCount: 600,
    };
    const dispatcher = makeDispatcher(llm, commands, note, { authorId: 'author_pro', postsCount: 50, followersCount: 10000, extracted: true });
    dispatcher.setup();
    dispatcher.updateNoteData(note);

    // 等待 back_to_feed（由 profile.done 触发）
    const backToFeedPromise = waitForEvent(
      dispatcher.bus,
      'feed.entered',
      (p: any) => p.trigger === 'back_to_feed',
      5000,
    );

    dispatcher.startSession();

    // 模拟 Edge 上报卡片
    dispatcher.bus.emit('page.cards.arrived', {
      cards: [{ index: 0, title: '深度学习实战指南', likeCount: 1500, collectCount: 600, noteId: 'note_0' }],
      ts: Date.now(),
    });

    await backToFeedPromise;

    // 验证 open_note 指令
    assert.ok(commands.some((c) => c.action === 'open_note' && (c.params as any)?.noteId === 'note_0'),
      '应产出 open_note 指令');

    // 验证 collect 指令
    assert.ok(commands.some((c) => c.action === 'collect'),
      '应产出 collect 指令');

    // 验证进入 profile
    assert.ok(commands.some((c) => c.action === 'profile_open'),
      '应产出 profile 打开指令');

    // 验证 follow 指令
    assert.ok(commands.some((c) => c.action === 'follow'),
      '应产出 follow 指令');

    // 验证返回指令（关注成功后经 feed.entered(back_to_feed) → back）
    assert.ok(commands.some((c) => c.action === 'back' && c.reason === 'back_to_feed'),
      '应产出 back 指令');

    dispatcher.endSession();
  });

  // ─── SessionMonitor 集成测试 ────────────────────────────────

  it('SessionMonitor: 配额耗尽时自动终止会话', () => {
    const commands: EdgeCommand[] = [];
    const llm = createMockLlm(['{"verdict":"skip","reason":"不相关"}']);
    const dispatcher = new RoleDispatcher({ soul: mockSoul, llm, sendCommand: (cmd) => commands.push(cmd) });
    dispatcher.setup();
    dispatcher.startSession();

    // 手动耗尽所有配额
    for (let i = 0; i < 10; i++) dispatcher.consumeBudget('like');
    for (let i = 0; i < 5; i++) dispatcher.consumeBudget('collect');
    for (let i = 0; i < 5; i++) dispatcher.consumeBudget('search');

    // 触发 action.completed 事件，SessionMonitor 检查配额
    dispatcher.bus.emit('action.completed', { action: 'scroll', ok: true, ts: Date.now() });

    // 会话应已终止
    assert.equal(dispatcher.active, false, '会话应已自动终止');
  });

  it('follow 配额按真实回执扣减：真实新关注扣 1、already_followed/失败不扣', () => {
    const commands: EdgeCommand[] = [];
    const llm = createMockLlm(['{"verdict":"skip","reason":"不相关"}']);
    const dispatcher = new RoleDispatcher({ soul: mockSoul, llm, sendCommand: (cmd) => commands.push(cmd) });
    dispatcher.setup();
    dispatcher.startSession();

    const start = dispatcher.remainingFollows; // freshBudget follows:3

    // 真实新关注（ok:true 不带 reason）→ 扣 1
    dispatcher.bus.emit('action.completed', { action: 'follow', ok: true, ts: Date.now() });
    assert.equal(dispatcher.remainingFollows, start - 1, '真实新关注应扣 1 配额');

    // already_followed 良性 no-op（ok:true + reason）→ 不扣
    dispatcher.bus.emit('action.completed', { action: 'follow', ok: true, reason: 'already_followed', ts: Date.now() });
    assert.equal(dispatcher.remainingFollows, start - 1, 'already_followed no-op 不应扣配额');

    // 关注失败（ok:false）→ 不扣
    dispatcher.bus.emit('action.completed', { action: 'follow', ok: false, reason: 'btn_no-btn', ts: Date.now() });
    assert.equal(dispatcher.remainingFollows, start - 1, '关注失败不应扣配额');

    dispatcher.endSession();
  });

  // ─── 会话生命周期: 边缘新 hello 重置会话 ──────────────────────

  it('边缘新 hello → restartSession：endSession 后重连可重新驱动浏览', async () => {
    const commands: EdgeCommand[] = [];
    const llm = createMockLlm(['{"verdict":"skip","reason":"不相关"}']);
    const dispatcher = new RoleDispatcher({ soul: mockSoul, llm, sendCommand: (cmd) => commands.push(cmd) });
    dispatcher.setup();
    dispatcher.startSession();

    // 会话超时/超限结束 → 拆除全部订阅
    dispatcher.endSession('会话时长超限');
    assert.equal(dispatcher.active, false, 'endSession 后会话应不活跃');

    // 结束后：边缘重连上报卡片，无人处理 → 不产生指令（复现 bug 现象）
    commands.length = 0;
    dispatcher.bus.emit('page.cards.arrived', { cards: [], ts: Date.now() });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(commands.length, 0, 'endSession 后 page.cards 不应再产生指令');

    // 边缘新 hello → 会话重启（修复点）
    dispatcher.bus.emit('edge.hello', { edgeId: 'edge-demo', ts: Date.now() });
    assert.equal(dispatcher.active, true, 'edge.hello 后会话应重新活跃');

    // 重启后：上报空卡片应重新驱动 → scroll 指令
    commands.length = 0;
    for (let i = 0; i < 2; i++) {
      dispatcher.bus.emit('page.cards.arrived', { cards: [], ts: Date.now() });
      await new Promise((r) => setTimeout(r, 10));
    }
    const scrollCmds = commands.filter((c) => c.action === 'scroll');
    assert.ok(scrollCmds.length >= 1, `重启后应重新产生 scroll 指令, 实际=${scrollCmds.length}`);

    dispatcher.endSession();
  });

  // ─── 动作失败兜底（防死锁） ──────────────────────────────────

  it('action.completed ok=false → 兜底 scroll 续刷，不让事件循环死等', async () => {
    const commands: EdgeCommand[] = [];
    const llm = createMockLlm(['{"verdict":"skip","reason":"x"}']);
    const dispatcher = new RoleDispatcher({ soul: mockSoul, llm, sendCommand: (cmd) => commands.push(cmd) });
    dispatcher.setup();
    dispatcher.startSession();

    // 模拟 open_note 执行失败（modal_timeout）：边缘不会再报 note.detail/page.cards
    commands.length = 0;
    dispatcher.bus.emit('action.completed', { action: 'open_note', ok: false, reason: 'modal_timeout', ts: Date.now() });
    await new Promise((r) => setTimeout(r, 10));

    const recover = commands.find(
      (c) => c.action === 'scroll' && String(c.reason ?? '').includes('recover_after_open_note_failed'),
    );
    assert.ok(recover, `open_note 失败后应下发兜底 scroll，实际=${JSON.stringify(commands)}`);
  });

  it('action.completed scroll ok=false → 不递归触发兜底 scroll', async () => {
    const commands: EdgeCommand[] = [];
    const llm = createMockLlm(['{"verdict":"skip","reason":"x"}']);
    const dispatcher = new RoleDispatcher({ soul: mockSoul, llm, sendCommand: (cmd) => commands.push(cmd) });
    dispatcher.setup();
    dispatcher.startSession();

    commands.length = 0;
    dispatcher.bus.emit('action.completed', { action: 'scroll', ok: false, reason: 'no_target', ts: Date.now() });
    await new Promise((r) => setTimeout(r, 10));

    const recover = commands.find(
      (c) => c.action === 'scroll' && String(c.reason ?? '').includes('recover_after_scroll_failed'),
    );
    assert.equal(recover, undefined, `scroll 失败不应递归下发兜底 scroll，实际=${JSON.stringify(commands)}`);
  });

  it('action.completed join_group ok=false → 不触发兜底 scroll', async () => {
    const commands: EdgeCommand[] = [];
    const llm = createMockLlm(['{"verdict":"skip","reason":"x"}']);
    const dispatcher = new RoleDispatcher({ soul: mockSoul, llm, sendCommand: (cmd) => commands.push(cmd) });
    dispatcher.setup();
    dispatcher.startSession();

    commands.length = 0;
    dispatcher.bus.emit('action.completed', { action: 'join_group', ok: false, reason: 'task_failed', ts: Date.now() });
    await new Promise((r) => setTimeout(r, 10));

    const recover = commands.find(
      (c) => c.action === 'scroll' && String(c.reason ?? '').includes('recover_after_join_group_failed'),
    );
    assert.equal(recover, undefined, `join_group 失败不应下发兜底 scroll，实际=${JSON.stringify(commands)}`);
  });

  // ─── 返回成功后的自驱动续刷（change rescan-after-successful-back）────────────
  //
  // 为什么这两条必须存在：决策环只被「新一批卡片到达」推进。Native 迁移后小红书的返回只回动作
  // 回执、不再随附卡片（Facebook 侧仍带），于是每看完一条笔记就停在原地，直到分钟量级的空闲兜底
  // 把它踢一下 —— 每一层回执都成功，只是慢，外部观察不到异常。dev 实测里唯一能让循环前进的路径
  // 反而是**返回失败**（失败有兜底滚动），判据整个反了。规格那条要求本就写着
  // 「MUST NOT 仅依赖 edge 主动重报 page.cards」，这两条锁的就是它缺的那条腿。

  it('action.completed back ok=true → 主动续扫（rescan_after_back），不靠空闲兜底推进', async () => {
    const commands: EdgeCommand[] = [];
    const llm = createMockLlm(['{"verdict":"skip","reason":"x"}']);
    const dispatcher = new RoleDispatcher({ soul: mockSoul, llm, sendCommand: (cmd) => commands.push(cmd) });
    dispatcher.setup();
    dispatcher.startSession();

    commands.length = 0;
    dispatcher.bus.emit('action.completed', { action: 'back', ok: true, reason: 'list_ready', ts: Date.now() });
    await new Promise((r) => setTimeout(r, 10));

    // 原因名逐字断言、不用 includes：它是日志与回执里唯一能把「续扫」和「失败兜底」分开的东西，
    // 写错等于两条路径在档案里合流，事后再也分不出循环是被哪条推动的。
    const rescans = commands.filter(
      (c) => c.action === 'scroll' && String(c.reason ?? '') === 'rescan_after_back',
    );
    assert.equal(
      rescans.length,
      1,
      `返回成功后应恰好下发一次 rescan_after_back，实际=${JSON.stringify(commands)}`,
    );
    const recover = commands.find((c) => String(c.reason ?? '').includes('recover_after_back_failed'));
    assert.equal(recover, undefined, '返回成功 MUST NOT 同时触发失败兜底');
  });

  it('action.completed back ok=false → 仍走失败兜底，且不发 rescan_after_back（两条路径互斥）', async () => {
    const commands: EdgeCommand[] = [];
    const llm = createMockLlm(['{"verdict":"skip","reason":"x"}']);
    const dispatcher = new RoleDispatcher({ soul: mockSoul, llm, sendCommand: (cmd) => commands.push(cmd) });
    dispatcher.setup();
    dispatcher.startSession();

    commands.length = 0;
    dispatcher.bus.emit('action.completed', { action: 'back', ok: false, reason: 'list_not_confirmed', ts: Date.now() });
    await new Promise((r) => setTimeout(r, 10));

    const recover = commands.find(
      (c) => c.action === 'scroll' && String(c.reason ?? '').includes('recover_after_back_failed'),
    );
    assert.ok(recover, `返回失败仍应下发兜底 scroll，实际=${JSON.stringify(commands)}`);
    const rescan = commands.find((c) => String(c.reason ?? '') === 'rescan_after_back');
    assert.equal(rescan, undefined, '返回失败 MUST NOT 被记成一次正常续扫');
  });

  it('facebook: 搜索失败恢复 scroll 也携带拟人停留 dwellMs', async () => {
    const commands: EdgeCommand[] = [];
    const llm = createMockLlm([]);
    const dispatcher = new RoleDispatcher({
      soul: mockSoul,
      llm,
      sendCommand: (cmd) => commands.push(cmd),
      accountPlatform: 'facebook',
      getNickname: () => 'FB Name',
    });
    dispatcher.setCurrentAccountId('fb-acc');
    dispatcher.setup();
    dispatcher.startSession();

    commands.length = 0;
    dispatcher.bus.emit('action.completed', { action: 'search', ok: false, reason: 'no_target', ts: Date.now() });
    await new Promise((r) => setTimeout(r, 10));

    const recover = commands.find((c) => c.action === 'scroll' && c.reason === 'recover_after_search_failed');
    assert.ok(recover, `search 失败后应下发兜底 scroll，实际=${JSON.stringify(commands)}`);
    assert.equal(
      recover!.params?.dwellMs,
      11_000,
      `FB search 恢复 scroll 应保留共享的 11s normal 中心，实际=${JSON.stringify(recover!.params)}`,
    );
    dispatcher.endSession();
  });

  // ─── facebook-browse-and-like-loop 5.2: 会话启动平台闸对 Facebook 放行 ─────────────────
  // 原 facebook-scheduled-comment 2.8 曾断言「FB 无 browse → 拒绝」；本 change 为 FB 声明 browse（edge 侧
  // FacebookBrowseSession 原子同落），启动闸应【放行】FB 浏览闭环（spec 场景「Facebook account can start a
  // browse session after capabilities are added」）。会话启动信号 = feed.entered{session_start}。
  // 注：启动闸对「注册项不含 browse 的平台」仍诚实拒绝（gate 逻辑 role-dispatcher.ts 未改）；现有两个平台
  // （xhs/facebook）均已声明 browse，故拒绝路径无可注册的无 browse 平台可被真机触发，由 gate 单行
  // `capabilities.includes('browse')` 保证不变。

  it('5.2: facebook 平台（已声明 browse）→ 启动闸放行，起浏览会话（发 feed.entered{session_start}）', async () => {
    const llm = createMockLlm(['{"verdict":"skip"}']);
    const dispatcher = new RoleDispatcher({ soul: mockSoul, llm, sendCommand: () => {}, accountPlatform: 'facebook' });
    dispatcher.setCurrentAccountId('fb-acc');
    dispatcher.setup();
    const starts: unknown[] = [];
    dispatcher.bus.on('feed.entered', (p: unknown) => { starts.push(p); });
    dispatcher.tryStartSession(); // 经 canStartSession 平台闸
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(starts.length >= 1, 'facebook 账号声明 browse 后应正常启动浏览会话（平台闸放行）');
  });

  it('facebook: 没有内容评估证据时，reading.done 不会自然触发 like', async () => {
    const commands: EdgeCommand[] = [];
    const llm = createMockLlm(['{"action":"like","reason":"不该被调用"}']);
    const dispatcher = new RoleDispatcher({
      soul: mockSoul,
      llm,
      sendCommand: (cmd) => commands.push(cmd),
      accountPlatform: 'facebook',
      getNickname: () => 'FB Name',
    });
    const note = {
      noteId: 'https://www.facebook.com/a/posts/pfbid0FB',
      title: 'FB post',
      content: 'content',
      author: 'Alice',
      likeCount: 10,
      collectCount: 0,
    };
    dispatcher.setCurrentAccountId('fb-acc');
    dispatcher.setup();
    dispatcher.startSession();
    dispatcher.updateNoteData(note);

    const skipped: Array<{ reason?: string }> = [];
    dispatcher.bus.on('interaction.skipped', (p) => { skipped.push(p); });
    dispatcher.bus.emit('reading.done', {
      noteId: note.noteId,
      sourcePageType: 'feed',
      imagesBrowsed: 0,
      commentsRead: 0,
      keyPoints: [],
      readDurationMs: 100,
      ts: Date.now(),
    });
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(llm.callCount, 0, '资格闸失败时不应调互动评估 LLM');
    assert.equal(skipped.at(-1)?.reason, 'fb_content_not_selected');
    assert.ok(!commands.some((c) => c.action === 'like'), '不应下发 like');
    dispatcher.endSession();
  });

  it('facebook: content.valuable + quality.pass + interaction_appraiser=like → 才下发 like', async () => {
    const commands: EdgeCommand[] = [];
    const llm = createMockLlm([
      '{"action":"like","reason":"符合人设"}',
      '{"action":"like","reason":"符合人设"}',
    ]);
    const dispatcher = new RoleDispatcher({
      soul: mockSoul,
      llm,
      sendCommand: (cmd) => commands.push(cmd),
      accountPlatform: 'facebook',
      getNickname: () => 'FB Name',
    });
    const note = {
      noteId: 'https://www.facebook.com/a/posts/pfbid0FB',
      title: 'FB post',
      content: 'useful local post with enough detail',
      author: 'Alice',
      likeCount: 10,
      collectCount: 0,
    };
    dispatcher.setCurrentAccountId('fb-acc');
    dispatcher.setup();
    dispatcher.startSession();
    dispatcher.updateNoteData(note);

    dispatcher.bus.emit('content.valuable', {
      index: 0,
      noteId: note.noteId,
      title: note.title,
      reason: '内容相关',
      confidence: 0.9,
      sourcePageType: 'feed',
      ts: Date.now(),
    });
    dispatcher.bus.emit('quality.pass', {
      noteId: note.noteId,
      sourcePageType: 'feed',
      reason: '详情有价值',
      ts: Date.now(),
    });
    dispatcher.bus.emit('reading.done', {
      noteId: note.noteId,
      sourcePageType: 'feed',
      imagesBrowsed: 0,
      commentsRead: 0,
      keyPoints: [],
      readDurationMs: 100,
      ts: Date.now(),
    });
    await new Promise((r) => setTimeout(r, 60));

    assert.ok(commands.some((c) => c.action === 'open_note' && (c.params as { noteId?: string })?.noteId === note.noteId));
    assert.ok(commands.some((c) => c.action === 'like' && (c.params as { noteId?: string })?.noteId === note.noteId));
    dispatcher.endSession();
  });

  it('2.8: 缺省/xiaohongshu 平台（含 browse）→ 启动闸放行，正常起会话', async () => {
    const llm = createMockLlm(['{"verdict":"skip"}']);
    const dispatcher = new RoleDispatcher({ soul: mockSoul, llm, sendCommand: () => {}, accountPlatform: 'xiaohongshu' });
    dispatcher.setCurrentAccountId('xhs-acc');
    dispatcher.setup();
    const starts: unknown[] = [];
    dispatcher.bus.on('feed.entered', (p: unknown) => { starts.push(p); });
    dispatcher.tryStartSession();
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(starts.length >= 1, 'xhs 账号应正常启动会话（平台闸不拦）');
  });

  // ─── 现场评论归集（change platform-vocabulary-and-thresholds 2.1）─────────────
  // 小红书 note.detail 不带评论，评论区正文只在 scroll_comments 回执的 candidates 里；dispatcher 应把它
  // 归到当前笔记上，供撰写器贴合评论区语境。以「撰写 prompt 是否含该评论文本」端到端验证 harvest→compose。
  describe('scroll_comments 现场评论归集 → 撰写语境', () => {
    /** 起一个活跃会话 + 捕获所有撰写 prompt（撰写器经 commonOptions 用同一 llm）。 */
    function makeHarvestFixture() {
      const prompts: string[] = [];
      const llm = {
        complete: async (p: string): Promise<string> => {
          prompts.push(p);
          return '{"decline":"nothing_genuine"}'; // 只关心 prompt，不需要真草稿
        },
      };
      const note = { noteId: 'note_0', title: '测试笔记', content: '正文', likeCount: 100, collectCount: 50 };
      const dispatcher = new RoleDispatcher({ soul: mockSoul, llm, sendCommand: () => {} });
      dispatcher.setup();
      dispatcher.updateNoteData(note);
      dispatcher.startSession();
      return { dispatcher, prompts };
    }

    it('scroll_comments 候选归到当前笔记 → 撰写 prompt 带上这些评论', async () => {
      const { dispatcher, prompts } = makeHarvestFixture();
      dispatcher.bus.emit('action.completed', {
        action: 'scroll_comments', ok: true, noteId: 'note_0',
        candidates: [
          { anchorId: 'c1', text: '这个分块策略学到了' },
          { anchorId: 'c2', text: '召回怎么调' },
          { anchorId: 'c3', text: '   ' }, // 空白评论应被过滤
        ],
        ts: Date.now(),
      });
      dispatcher.bus.emit('comment.appraised', { noteId: 'note_0', sourcePageType: 'feed', actions: ['like'], ts: Date.now() });
      await new Promise((r) => setTimeout(r, 20));
      const composePrompt = prompts.find((p) => /现有的评论/.test(p));
      assert.ok(composePrompt, '撰写 prompt 应含现场评论块');
      assert.match(composePrompt!, /这个分块策略学到了/);
      assert.match(composePrompt!, /召回怎么调/);
      dispatcher.endSession();
    });

    it('回执 noteId 与当前笔记不符 → 不归集（不污染别的笔记语境）', async () => {
      const { dispatcher, prompts } = makeHarvestFixture();
      dispatcher.bus.emit('action.completed', {
        action: 'scroll_comments', ok: true, noteId: 'other_note',
        candidates: [{ anchorId: 'c1', text: '错配笔记的评论' }],
        ts: Date.now(),
      });
      dispatcher.bus.emit('comment.appraised', { noteId: 'note_0', sourcePageType: 'feed', actions: ['like'], ts: Date.now() });
      await new Promise((r) => setTimeout(r, 20));
      assert.ok(!prompts.some((p) => /错配笔记的评论/.test(p)), '错配 noteId 的评论绝不进撰写 prompt');
      dispatcher.endSession();
    });
  });

  // ─── 评论支线在途暂停态（change comment-approval-target-hold）──────────────
  // 触发评论、进人审时把账号钉在待评论帖上：经 sendCommand 统一出口扣住一切离页命令，
  // 覆盖撰写/去AI味/审批全程；终局先解除再下发评论；配合 pauseClock 推迟窗内 should_end。
  describe('评论支线在途暂停态（钉在待评论帖上等审批）', () => {
    function seed(commands: EdgeCommand[], opts: Record<string, unknown> = {}): RoleDispatcher {
      const llm = createMockLlm([]); // composer 会 await（不同步 skip），本组测试均同步断言、不等其 resolve
      const dispatcher = new RoleDispatcher({ soul: mockSoul, llm, sendCommand: (cmd) => commands.push(cmd), ...opts });
      dispatcher.setup();
      dispatcher.updateNoteData({ noteId: 'n1', title: 't', content: '正文正文正文', likeCount: 500, collectCount: 0 });
      dispatcher.startSession();
      commands.length = 0; // 清掉开场命令（feed.entered 等）
      return dispatcher;
    }

    it('(a) 撰写窗内并行点赞回 no_target(stale) → 不重扫滚屏（FB feed 就地读）', () => {
      const commands: EdgeCommand[] = [];
      const dispatcher = seed(commands, { accountPlatform: 'facebook', hasInlineTargeting: () => true });
      // 确立要评本帖 → 进入在途暂停态（撰写窗，comment.cleared 尚未发出）
      dispatcher.bus.emit('comment.appraised', { noteId: 'n1', sourcePageType: 'feed', actions: ['like'], ts: Date.now() });
      // 并行点赞在就地卡上回 no_target（卡位移）
      dispatcher.bus.emit('action.completed', { action: 'like', ok: false, reason: 'no_target', ts: Date.now() });
      const rescan = commands.filter((c) => c.action === 'scroll' && c.reason === 'rescan_after_stale_target');
      assert.equal(rescan.length, 0, `评论支线在途不应重扫滚屏（会把待评论帖滚走），实际=${rescan.length}`);
      dispatcher.endSession();
    });

    it('(b) 审批窗内 idle_nudge / feed.scrolled / refresh 全被扣住；终局后恢复', () => {
      const commands: EdgeCommand[] = [];
      const dispatcher = seed(commands);
      dispatcher.bus.emit('comment.appraised', { noteId: 'n1', sourcePageType: 'feed', actions: ['like'], ts: Date.now() });
      // 窗内各类会离开待评论帖的触发均不下发
      dispatcher.bus.emit('session.idle_nudge', { reason: 'idle_recover_nudge', ts: Date.now() });
      dispatcher.bus.emit('feed.scrolled', { pageType: 'feed', scrollCount: 1, ts: Date.now() });
      dispatcher.bus.emit('feed.refresh.needed', { cardsBrowsed: 20, currentPageType: 'feed', ts: Date.now() });
      const moved = commands.filter((c) =>
        (c.action === 'scroll' && (c.reason === 'idle_recover_nudge' || c.reason === 'feed_scroll')) ||
        c.action === 'refresh');
      assert.equal(moved.length, 0, `在途窗内不得下发任何移动命令，实际=${moved.length}（${moved.map((c) => c.reason).join(',')}）`);
      // 终局（超时跳过）→ 解除在途 + 恢复
      dispatcher.bus.emit('comment.skipped', { noteId: 'n1', sourcePageType: 'feed', actions: ['like'], reason: 'approval_timeout', ts: Date.now() });
      commands.length = 0;
      dispatcher.bus.emit('session.idle_nudge', { reason: 'idle_recover_nudge', ts: Date.now() });
      const resumed = commands.filter((c) => c.action === 'scroll' && c.reason === 'idle_recover_nudge');
      assert.equal(resumed.length, 1, `终局后 idle_nudge 应恢复翻译为 scroll，实际=${resumed.length}`);
      dispatcher.endSession();
    });

    it('(c) comment.appraised 暂停时钟(comment_subline)、终局恢复时钟（should_end 延后到评论支线终局）', () => {
      const commands: EdgeCommand[] = [];
      const dispatcher = seed(commands);
      const sm = (dispatcher as unknown as { sessionMonitor: { pauseClock(r: string): void; resumeClock(r: string): void } }).sessionMonitor;
      const paused: string[] = [];
      const resumed: string[] = [];
      const op = sm.pauseClock.bind(sm);
      const or = sm.resumeClock.bind(sm);
      sm.pauseClock = (r: string) => { paused.push(r); op(r); };
      sm.resumeClock = (r: string) => { resumed.push(r); or(r); };
      dispatcher.bus.emit('comment.appraised', { noteId: 'n1', sourcePageType: 'feed', actions: ['like'], ts: Date.now() });
      assert.ok(paused.includes('comment_subline'), 'comment.appraised 应暂停时钟(comment_subline) 以延后窗内 should_end');
      dispatcher.bus.emit('comment.skipped', { noteId: 'n1', sourcePageType: 'feed', actions: ['like'], reason: 'approval_timeout', ts: Date.now() });
      assert.ok(resumed.includes('comment_subline'), '评论支线终局应恢复时钟(comment_subline)');
      dispatcher.endSession();
    });

    it('(c2) currentNote 不匹配（composer 会同步 skip）→ 不置在途标志、不卡死浏览', () => {
      const commands: EdgeCommand[] = [];
      const dispatcher = seed(commands);
      // 对「非当前笔记」触发 appraised：composer 同步 !note skip，若无条件置标志会卡死永久抑制
      dispatcher.bus.emit('comment.appraised', { noteId: 'OTHER', sourcePageType: 'feed', actions: ['like'], ts: Date.now() });
      dispatcher.bus.emit('session.idle_nudge', { reason: 'idle_recover_nudge', ts: Date.now() });
      const scroll = commands.filter((c) => c.action === 'scroll' && c.reason === 'idle_recover_nudge');
      assert.equal(scroll.length, 1, `未进入在途暂停态时 idle_nudge 应照常翻译为 scroll（不卡死），实际=${scroll.length}`);
      dispatcher.endSession();
    });

    it('(d) 终局(approved)先清在途标志再下发评论 → 评论命令不被自己的暂停态扣住（XHS 直发）', () => {
      const commands: EdgeCommand[] = [];
      const dispatcher = seed(commands, { accountPlatform: 'xiaohongshu' });
      dispatcher.bus.emit('comment.appraised', { noteId: 'n1', sourcePageType: 'feed', actions: ['like'], ts: Date.now() });
      dispatcher.bus.emit('comment.approved', { noteId: 'n1', sourcePageType: 'feed', actions: ['like'], text: '真的学到了', ts: Date.now() });
      const commentCmd = commands.filter((c) => c.action === 'comment');
      assert.equal(commentCmd.length, 1, `approved 后应下发 1 条评论命令（先清标志再发），实际=${commentCmd.length}`);
      assert.equal((commentCmd[0].params as { text?: string })?.text, '真的学到了');
      dispatcher.endSession();
    });

    // ── 对抗性复核修复回归（review wf_71b324de：preemption / 迁移抑制 / 巡视让位 / appraiser 窗）──
    it('(e) 被抢占的评论回执 ⇒ 解除 comment_subline 暂停 + 清 pendingComment + 不恢复滚动', () => {
      const commands: EdgeCommand[] = [];
      const dispatcher = seed(commands, { accountPlatform: 'xiaohongshu' });
      const sm = (dispatcher as unknown as { sessionMonitor: { resumeClock(r: string): void } }).sessionMonitor;
      const resumed: string[] = [];
      const or = sm.resumeClock.bind(sm);
      sm.resumeClock = (r: string) => { resumed.push(r); or(r); };
      dispatcher.bus.emit('comment.appraised', { noteId: 'n1', sourcePageType: 'feed', actions: ['like'], ts: Date.now() });
      dispatcher.bus.emit('comment.approved', { noteId: 'n1', sourcePageType: 'feed', actions: ['like'], text: 'hi', ts: Date.now() });
      const before = commands.length;
      dispatcher.bus.emit('action.completed', { action: 'comment', ok: false, reason: 'preempted_by_task', ts: Date.now() });
      assert.ok(resumed.includes('comment_subline'), '被抢占的评论回执应解除 comment_subline 时钟暂停（防永冻 should_end）');
      assert.equal((dispatcher as unknown as { pendingComment: unknown }).pendingComment, null, '被抢占后清 pendingComment（不留悬挂）');
      assert.equal(commands.slice(before).filter((c) => c.action === 'scroll').length, 0, '被抢占不发恢复滚动（尊重抢占语义）');
      dispatcher.endSession();
    });

    it('(f) FB 迁移 open_note 被软暂停拦下 ⇒ 清 pendingMigration + 收敛评论支线（不永冻时钟）', () => {
      const commands: EdgeCommand[] = [];
      const dispatcher = seed(commands, { accountPlatform: 'facebook', hasInlineTargeting: () => true });
      const sm = (dispatcher as unknown as { sessionMonitor: { resumeClock(r: string): void } }).sessionMonitor;
      const resumed: string[] = [];
      const or = sm.resumeClock.bind(sm);
      sm.resumeClock = (r: string) => { resumed.push(r); or(r); };
      dispatcher.bus.emit('comment.appraised', { noteId: 'n1', sourcePageType: 'feed', actions: ['like'], ts: Date.now() });
      // 模拟审批期并发通知巡视的软暂停
      (dispatcher as unknown as { sessionContext: { setBrowseSuspended(b: boolean): void } }).sessionContext.setBrowseSuspended(true);
      const before = commands.length;
      dispatcher.bus.emit('comment.approved', { noteId: 'n1', sourcePageType: 'feed', actions: ['like'], text: 'hi', ts: Date.now() });
      assert.equal(commands.slice(before).filter((c) => c.action === 'open_note').length, 0, '软暂停期迁移 open_note 不下发');
      assert.equal((dispatcher as unknown as { pendingMigration: unknown }).pendingMigration, null, '迁移被拦下 ⇒ 清 pendingMigration（不留孤儿劫持后续回执）');
      assert.ok(resumed.includes('comment_subline'), '迁移被拦下应收敛评论支线、解除时钟暂停（不永冻 should_end）');
      dispatcher.endSession();
    });

    it('(g) 评论支线在途 ⇒ 通知巡视让位（不开通知页）；评论结算后补跑', async () => {
      const commands: EdgeCommand[] = [];
      const dispatcher = seed(commands, { accountPlatform: 'xiaohongshu' });
      dispatcher.bus.emit('comment.appraised', { noteId: 'n1', sourcePageType: 'feed', actions: ['like'], ts: Date.now() });
      const before = commands.length;
      dispatcher.bus.emit('notification.detected.arrived', { epoch: 1, unreadCount: 3, ts: Date.now() });
      assert.equal(commands.slice(before).filter((c) => c.action === 'open_notifications').length, 0, '评论支线在途 ⇒ 巡视让位、不把账号导离待评论帖');
      // 评论结算（跳过）→ 微任务补跑被让位的巡视
      dispatcher.bus.emit('comment.skipped', { noteId: 'n1', sourcePageType: 'feed', actions: ['like'], reason: 'approval_timeout', ts: Date.now() });
      await new Promise((r) => setTimeout(r, 5));
      assert.ok(commands.some((c) => c.action === 'open_notifications'), '评论结算后被让位的巡视补跑（open_notifications），未读不被永久搁置');
      dispatcher.endSession();
    });

    it('(h) comment.appraising（评估-LLM 起）即进入在途暂停态，覆盖 appraiser 残留窗', () => {
      const commands: EdgeCommand[] = [];
      const dispatcher = seed(commands, { accountPlatform: 'facebook', hasInlineTargeting: () => true });
      // 仅到 comment.appraising（尚未 appraised）：appraiser-LLM 判定进行中
      dispatcher.bus.emit('comment.appraising', { noteId: 'n1', sourcePageType: 'feed', actions: ['like'], ts: Date.now() });
      dispatcher.bus.emit('action.completed', { action: 'like', ok: false, reason: 'no_target', ts: Date.now() });
      const rescan = commands.filter((c) => c.action === 'scroll' && c.reason === 'rescan_after_stale_target');
      assert.equal(rescan.length, 0, 'comment.appraising 后 appraiser 窗内并行点赞 no_target 不重扫（覆盖残留窗）');
      dispatcher.endSession();
    });

    it('(i) 评论子链总超时 → 单次诚实 skip、恢复浏览，迟到 appraised/approved 不再续期或下发', async () => {
      const commands: EdgeCommand[] = [];
      const dispatcher = seed(commands, {
        commentSublineTimeoutMs: 10,
        llm: { complete: async () => new Promise<string>(() => {}) },
      });
      const timeoutSkips: unknown[] = [];
      dispatcher.bus.on('comment.skipped', (payload) => {
        if (payload.reason === 'comment_subline_timeout') timeoutSkips.push(payload);
      });

      dispatcher.bus.emit('comment.appraising', { noteId: 'n1', sourcePageType: 'feed', actions: ['like'], ts: Date.now() });
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(timeoutSkips.length, 1, '总超时只应发出一次 comment_subline_timeout');
      assert.equal((dispatcher as unknown as { commentInflight: boolean }).commentInflight, false, '总超时应释放钉页状态');

      commands.length = 0;
      dispatcher.bus.emit('session.idle_nudge', { reason: 'idle_recover_nudge', ts: Date.now() });
      assert.equal(
        commands.filter((c) => c.action === 'scroll' && c.reason === 'idle_recover_nudge').length,
        1,
        '总超时后浏览应恢复，不再被 comment_inflight 扣住',
      );

      commands.length = 0;
      dispatcher.bus.emit('comment.appraised', { noteId: 'n1', sourcePageType: 'feed', actions: ['like'], ts: Date.now() });
      dispatcher.bus.emit('comment.approved', { noteId: 'n1', sourcePageType: 'feed', actions: ['like'], text: '迟到授权', ts: Date.now() });
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(timeoutSkips.length, 1, '迟到 appraised 不得重新启动总超时或发第二个 skip');
      assert.equal(commands.filter((c) => c.action === 'comment' || c.action === 'open_note').length, 0, '迟到 approved 绝不下发评论或迁移命令');
      dispatcher.endSession();
    });
  });
});
