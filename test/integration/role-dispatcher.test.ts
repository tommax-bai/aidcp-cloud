/**
 * Integration tests for RoleDispatcher — 验证6条闭环路径。
 *
 * 每个测试用 mock LLM 返回预设结果，验证事件链正确传播并最终回到 feed.entered。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RoleDispatcher } from '../../src/orchestrator/role-dispatcher.js';
import type { EdgeCommand } from '../../src/orchestrator/role-dispatcher.js';
import { SEARCH_THRESHOLD } from '../../src/agents/feed-scroller.js';
import type { Soul } from '../../src/soul/types.js';
import type { EventBus } from '../../src/event-bus/index.js';

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

  it('facebook: feed_scroll 即使新卡差分为 0 也携带拟人停留 dwellMs', async () => {
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
    assert.ok(
      typeof scroll!.params?.dwellMs === 'number' && (scroll!.params!.dwellMs as number) >= 6000,
      `FB feed_scroll 应有 6s+ dwellMs 保底，实际=${JSON.stringify(scroll!.params)}`,
    );
    dispatcher.endSession();
  });

  it('facebook: 首批 page.cards{startupId} 武装本人昵称采集（profile_open direct）+ 本人 detail 差异写库（change facebook-nickname-capture-timing）', async () => {
    const commands: EdgeCommand[] = [];
    const setCalls: { accountId: string; nickname: string }[] = [];
    const llm = createMockLlm([]);
    const dispatcher = new RoleDispatcher({
      soul: mockSoul,
      llm,
      sendCommand: (cmd) => commands.push(cmd),
      accountPlatform: 'facebook',
      getNickname: () => null,
      setNickname: (accountId, nickname) => { setCalls.push({ accountId, nickname }); },
    });
    dispatcher.setCurrentAccountId('fb-acc');
    dispatcher.setup();
    dispatcher.startSession();

    // 时机统一：FB 与 XHS 同样在「完整浏览器启动后首批 page.cards{startupId}」武装本人昵称采集。
    dispatcher.bus.emit('page.cards.arrived', { cards: [], startupId: 'fb-startup-1', ts: Date.now() });
    await new Promise((r) => setTimeout(r, 10));

    const profileOpen = commands.find(
      (c) => c.action === 'profile_open' && (c.params as { direct?: boolean } | undefined)?.direct === true,
    );
    assert.ok(profileOpen, 'FB 首批 page.cards{startupId} 应武装本人昵称采集、下发 profile_open{direct}');
    assert.equal((profileOpen!.params as { authorId?: string }).authorId, 'fb-acc', 'direct 采集应指向本连接账号');

    // 边缘就地读回本人 detail（authorId === 连接 accountId、非空昵称）→ 云端差异写库。
    dispatcher.bus.emit('profile.detail.arrived', {
      detail: { authorId: 'fb-acc', postsCount: 0, followersCount: 0, extracted: false, nickname: '真实FB昵称' },
      accountId: 'fb-acc',
      ts: Date.now(),
    });
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(setCalls, [{ accountId: 'fb-acc', nickname: '真实FB昵称' }], 'FB 就地读回的非空昵称应差异写库');

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
    assert.ok(
      typeof recover!.params?.dwellMs === 'number' && (recover!.params!.dwellMs as number) >= 6000,
      `FB search 恢复 scroll 应有 6s+ dwellMs 保底，实际=${JSON.stringify(recover!.params)}`,
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
});
