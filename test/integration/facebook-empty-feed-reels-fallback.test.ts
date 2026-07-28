import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoleDispatcher, type EdgeCommand } from '../../src/orchestrator/role-dispatcher.js';
import type { Soul } from '../../src/kernel/soul-types.js';

const soul: Soul = {
  identity: { name: 'Test', role: 'tester', background: 'test', tone: 'plain' },
  interests: { primary: ['video'], secondary: [], seed_keywords: [] },
};

const llm = { complete: async () => '{"verdict":"skip","reason":"test"}' };

test('Facebook 明确空 Feed：Cloud 每场只用现有 scroll 命令授权一次 Reels fallback', () => {
  const commands: EdgeCommand[] = [];
  const dispatcher = new RoleDispatcher({ soul, llm, accountPlatform: 'facebook', sendCommand: (command) => commands.push(command) });
  dispatcher.setup();
  dispatcher.startSession();

  dispatcher.bus.emit('feed.empty.confirmed', { startupId: 'start-1', ts: 1 });
  dispatcher.bus.emit('feed.empty.confirmed', { startupId: 'start-1', ts: 2 });

  const fallback = commands.filter((command) => command.action === 'scroll' && command.reason === 'empty_feed_reels_fallback');
  assert.equal(fallback.length, 1, '重复空态报告不得多次导航 Reels');
  dispatcher.endSession('test');
});

test('Facebook 非空 Feed 确认到底：切 Reels、不 refresh，重复回执保持幂等', () => {
  const commands: EdgeCommand[] = [];
  const dispatcher = new RoleDispatcher({ soul, llm, accountPlatform: 'facebook', sendCommand: (command) => commands.push(command) });
  dispatcher.setup();
  dispatcher.startSession();

  dispatcher.bus.emit('action.completed', { action: 'scroll', ok: false, reason: 'feed_exhausted', ts: 1 });
  dispatcher.bus.emit('action.completed', { action: 'scroll', ok: false, reason: 'feed_exhausted', ts: 2 });
  dispatcher.bus.emit('action.completed', { action: 'scroll', ok: false, reason: 'feed_exhausted', ts: 3 });

  const fallback = commands.filter((command) => command.action === 'scroll' && command.reason === 'empty_feed_reels_fallback');
  assert.equal(fallback.length, 1, '重复到底回执每场只能授权一次 Reels fallback');
  assert.equal(commands.some((command) => command.action === 'refresh' && command.reason === 'feed_exhausted_refresh'), false);
  dispatcher.endSession('test');
});

test('Facebook 首页物理卡连续不可上报：Cloud 每场只授权一次 Reels fallback', () => {
  const commands: EdgeCommand[] = [];
  const dispatcher = new RoleDispatcher({ soul, llm, accountPlatform: 'facebook', sendCommand: (command) => commands.push(command) });
  dispatcher.setup();
  dispatcher.startSession();

  dispatcher.bus.emit('feed.present_unreportable.confirmed', { startupId: 'start-1', documentGeneration: 'doc-1', ts: 1 });
  dispatcher.bus.emit('feed.present_unreportable.confirmed', { startupId: 'start-1', documentGeneration: 'doc-1', ts: 2 });
  dispatcher.bus.emit('feed.empty.confirmed', { startupId: 'start-1', documentGeneration: 'doc-1', ts: 3 });

  const fallback = commands.filter((command) => command.action === 'scroll' && command.reason === 'empty_feed_reels_fallback');
  assert.equal(fallback.length, 1, '同场重复结构态及其后空态都不得再次导航 Reels');
  dispatcher.endSession('test');
});

test('Facebook Reels pending/no_target 只做两次兼容握手恢复，耗尽后释放等待新证据', () => {
  const commands: EdgeCommand[] = [];
  const dispatcher = new RoleDispatcher({ soul, llm, accountPlatform: 'facebook', sendCommand: (command) => commands.push(command) });
  dispatcher.setup();
  dispatcher.startSession();

  dispatcher.bus.emit('feed.empty.confirmed', { ts: 1 });
  dispatcher.bus.emit('action.completed', { action: 'scroll', ok: false, reason: 'reels_pending', ts: 2 });
  dispatcher.bus.emit('action.completed', { action: 'scroll', ok: false, reason: 'no_target', ts: 3 });
  dispatcher.bus.emit('action.completed', { action: 'scroll', ok: false, reason: 'reels_pending', ts: 4 });

  let fallback = commands.filter((command) => command.action === 'scroll' && command.reason === 'empty_feed_reels_fallback');
  assert.equal(fallback.length, 3, '首次授权后最多再真正下发两次恢复');

  dispatcher.bus.emit('feed.empty.confirmed', { ts: 5 });
  fallback = commands.filter((command) => command.action === 'scroll' && command.reason === 'empty_feed_reels_fallback');
  assert.equal(fallback.length, 4, '恢复耗尽后回 idle，新一轮页面证据可重新授权');
  dispatcher.endSession('test');
});

test('Facebook Reels 卡片到达才把 fallback 确认为完成，之后迟到失败不再重驱', () => {
  const commands: EdgeCommand[] = [];
  const dispatcher = new RoleDispatcher({ soul, llm, accountPlatform: 'facebook', sendCommand: (command) => commands.push(command) });
  dispatcher.setup();
  dispatcher.startSession();

  dispatcher.bus.emit('feed.empty.confirmed', { ts: 1 });
  dispatcher.bus.emit('page.cards.arrived', {
    cards: [{ index: 0, title: 'reel', likeCount: 0, collectCount: 0, noteId: 'https://www.facebook.com/reel/1' }],
    listKind: 'reels',
    ts: 2,
  });
  dispatcher.bus.emit('action.completed', { action: 'scroll', ok: false, reason: 'reels_pending', ts: 3 });
  dispatcher.bus.emit('feed.empty.confirmed', { ts: 4 });

  const fallback = commands.filter((command) => command.action === 'scroll' && command.reason === 'empty_feed_reels_fallback');
  assert.equal(fallback.length, 1, '可读 Reels 卡确认后，迟到失败和旧空态均不得重导航');
  dispatcher.endSession('test');
});

test('Facebook 未确认到底：继续普通 Feed 滚动，不授权 Reels', () => {
  const commands: EdgeCommand[] = [];
  const dispatcher = new RoleDispatcher({ soul, llm, accountPlatform: 'facebook', sendCommand: (command) => commands.push(command) });
  dispatcher.setup();
  dispatcher.startSession();

  dispatcher.bus.emit('action.completed', {
    action: 'scroll',
    ok: false,
    reason: 'feed_continuation_unconfirmed',
    ts: 1,
  });

  const continuation = commands.filter(
    (command) => command.action === 'scroll' && command.reason === 'feed_continuation_unconfirmed',
  );
  assert.equal(continuation.length, 1, '未形成终止证据时立即走现有普通滚动闸继续');
  assert.equal(
    commands.some((command) => command.reason === 'empty_feed_reels_fallback'),
    false,
    '非终态续滚绝不授权 Reels',
  );
  dispatcher.endSession('test');
});

test('Facebook confirmed Reels 后非空普通 Feed 回归：开启新的 fallback epoch', () => {
  const commands: EdgeCommand[] = [];
  const dispatcher = new RoleDispatcher({ soul, llm, accountPlatform: 'facebook', sendCommand: (command) => commands.push(command) });
  dispatcher.setup();
  dispatcher.startSession();

  dispatcher.bus.emit('feed.empty.confirmed', { ts: 1 });
  dispatcher.bus.emit('page.cards.arrived', {
    cards: [{ index: 0, title: 'reel', likeCount: 0, collectCount: 0, noteId: 'https://www.facebook.com/reel/1' }],
    listKind: 'reels',
    ts: 2,
  });
  dispatcher.bus.emit('feed.empty.confirmed', { ts: 3 });
  dispatcher.bus.emit('page.cards.arrived', {
    cards: [{ index: 0, title: 'feed', likeCount: 0, collectCount: 0, noteId: 'https://www.facebook.com/a/posts/1' }],
    listKind: 'feed',
    ts: 4,
  });
  dispatcher.bus.emit('action.completed', {
    action: 'scroll',
    ok: false,
    reason: 'feed_exhausted',
    ts: 5,
  });

  const fallback = commands.filter(
    (command) => command.action === 'scroll' && command.reason === 'empty_feed_reels_fallback',
  );
  assert.equal(fallback.length, 2, '回到可读普通 Feed 后，新的真实到底可再授权一次');
  dispatcher.endSession('test');
});

test('Facebook pending 握手或 confirmed 后空 Feed 批次不会重开 fallback epoch', () => {
  const commands: EdgeCommand[] = [];
  const dispatcher = new RoleDispatcher({ soul, llm, accountPlatform: 'facebook', sendCommand: (command) => commands.push(command) });
  dispatcher.setup();
  dispatcher.startSession();

  dispatcher.bus.emit('feed.empty.confirmed', { ts: 1 });
  dispatcher.bus.emit('page.cards.arrived', { cards: [], listKind: 'feed', ts: 2 });
  dispatcher.bus.emit('feed.empty.confirmed', { ts: 3 });
  dispatcher.bus.emit('page.cards.arrived', {
    cards: [{ index: 0, title: 'reel', likeCount: 0, collectCount: 0, noteId: 'https://www.facebook.com/reel/1' }],
    listKind: 'reels',
    ts: 4,
  });
  dispatcher.bus.emit('page.cards.arrived', { cards: [], listKind: 'feed', ts: 5 });
  dispatcher.bus.emit('feed.empty.confirmed', { ts: 6 });

  const fallback = commands.filter(
    (command) => command.action === 'scroll' && command.reason === 'empty_feed_reels_fallback',
  );
  assert.equal(fallback.length, 1, 'pending/空批次不构成权威 Feed 回归');
  dispatcher.endSession('test');
});

test('Facebook 搜索批次不重开 fallback epoch，也不消费普通 Feed 继续态', () => {
  const commands: EdgeCommand[] = [];
  const dispatcher = new RoleDispatcher({ soul, llm, accountPlatform: 'facebook', sendCommand: (command) => commands.push(command) });
  dispatcher.setup();
  dispatcher.startSession();

  dispatcher.bus.emit('feed.empty.confirmed', { ts: 1 });
  dispatcher.bus.emit('page.cards.arrived', {
    cards: [{ index: 0, title: 'reel', likeCount: 0, collectCount: 0, noteId: 'https://www.facebook.com/reel/1' }],
    listKind: 'reels',
    ts: 2,
  });
  dispatcher.bus.emit('search.approved', {
    keyword: 'test',
    reason: 'test',
    currentPageType: 'feed',
    source: 'new_concept',
    ts: 3,
  });
  dispatcher.bus.emit('page.cards.arrived', {
    cards: [{ index: 0, title: 'search', likeCount: 0, collectCount: 0, noteId: 'https://www.facebook.com/a/posts/2' }],
    listKind: 'feed',
    ts: 4,
  });
  dispatcher.bus.emit('action.completed', {
    action: 'scroll',
    ok: false,
    reason: 'feed_continuation_unconfirmed',
    ts: 5,
  });
  dispatcher.bus.emit('action.completed', {
    action: 'scroll',
    ok: false,
    reason: 'feed_exhausted',
    ts: 6,
  });

  const fallback = commands.filter(
    (command) => command.action === 'scroll' && command.reason === 'empty_feed_reels_fallback',
  );
  const continuation = commands.filter(
    (command) => command.action === 'scroll' && command.reason === 'feed_continuation_unconfirmed',
  );
  assert.equal(fallback.length, 1, '搜索卡不得把 confirmed epoch 重置为 idle');
  assert.equal(continuation.length, 0, '搜索态的同名失败不得进入普通 Feed 续滚');
  dispatcher.endSession('test');
});

test('Facebook fallback 被浏览配额或软暂停抑制时不进入 pending，保留后续授权资格', () => {
  const quotaCommands: EdgeCommand[] = [];
  const quota = new RoleDispatcher({
    soul,
    llm,
    accountPlatform: 'facebook',
    explainView: () => ({ allowed: false, reason: 'quota:minute', retryAfterMs: 60_000 }),
    setTimeoutFn: () => ({ id: 'quota-wake' }),
    clearTimeoutFn: () => {},
    sendCommand: (command) => quotaCommands.push(command),
  });
  quota.setup();
  quota.startSession();
  quota.bus.emit('feed.empty.confirmed', { ts: 1 });
  assert.equal(quotaCommands.some((command) => command.reason === 'empty_feed_reels_fallback'), false);
  quota.endSession('test');

  const pausedCommands: EdgeCommand[] = [];
  const paused = new RoleDispatcher({ soul, llm, accountPlatform: 'facebook', sendCommand: (command) => pausedCommands.push(command) });
  paused.setup();
  paused.startSession();
  paused.context.setBrowseSuspended(true);
  paused.bus.emit('feed.empty.confirmed', { ts: 2 });
  paused.context.setBrowseSuspended(false);
  paused.bus.emit('feed.empty.confirmed', { ts: 3 });
  const fallback = pausedCommands.filter((command) => command.reason === 'empty_feed_reels_fallback');
  assert.equal(fallback.length, 1, '准入恢复后同一证据仍可授权');
  paused.endSession('test');
});

test('非 Facebook 或非活跃会话不授权 Reels fallback', () => {
  const commands: EdgeCommand[] = [];
  const xhs = new RoleDispatcher({ soul, llm, accountPlatform: 'xiaohongshu', sendCommand: (command) => commands.push(command) });
  xhs.setup();
  xhs.startSession();
  xhs.bus.emit('feed.empty.confirmed', { ts: 1 });
  assert.equal(commands.some((command) => command.reason === 'empty_feed_reels_fallback'), false);
  xhs.bus.emit('action.completed', { action: 'scroll', ok: false, reason: 'feed_exhausted', ts: 2 });
  assert.equal(commands.some((command) => command.action === 'refresh' && command.reason === 'feed_exhausted_refresh'), true);
  xhs.endSession('test');

  const inactive = new RoleDispatcher({ soul, llm, accountPlatform: 'facebook', sendCommand: (command) => commands.push(command) });
  inactive.setup();
  inactive.bus.emit('feed.empty.confirmed', { ts: 3 });
  inactive.bus.emit('feed.present_unreportable.confirmed', { ts: 3 });
  inactive.bus.emit('action.completed', { action: 'scroll', ok: false, reason: 'feed_exhausted', ts: 4 });
  assert.equal(commands.some((command) => command.reason === 'empty_feed_reels_fallback'), false);
});


// —— change restore-facebook-post-join-comment-continuity ——
// 真机死锁：账号因首页出不来内容被切到 Reels（状态「已确认」），随后被批次收尾那条不带任务标识的
// 滚动送回首页。解回可授权态原本只认「非空普通 Feed 回归」，而这个账号的首页永远非空不了 ⇒ 再也回不去
// Reels，五条候选分支又都不接「滚动无目标」，于是零命令悬停 60s 直到冷待机重启。
//
// 解锁证据只用滚动无目标回执，不用 feed.empty.confirmed —— 后者在 Reels 期间到达多半是切面前的迟到
// 旧报告（上面几条用例正是为此立的）。

test('Facebook 已在 Reels epoch 却在普通 Feed 滚不出目标 → 解回可授权态并重开', () => {
  const commands: EdgeCommand[] = [];
  const dispatcher = new RoleDispatcher({ soul, llm, accountPlatform: 'facebook', sendCommand: (command) => commands.push(command) });
  dispatcher.setup();
  dispatcher.startSession();

  dispatcher.bus.emit('feed.empty.confirmed', { ts: 1 });
  dispatcher.bus.emit('page.cards.arrived', {
    cards: [{ index: 0, title: 'reel', likeCount: 0, collectCount: 0, noteId: 'https://www.facebook.com/reel/1' }],
    listKind: 'reels',
    ts: 2,
  });
  dispatcher.bus.emit('action.completed', { action: 'scroll', ok: false, reason: 'no_target', ts: 3 });

  const fallback = commands.filter(
    (command) => command.action === 'scroll' && command.reason === 'empty_feed_reels_fallback',
  );
  assert.equal(fallback.length, 2, '被送回空首页后必须还能再切一次 Reels，绝不钉死');
  dispatcher.endSession('test');
});

test('Facebook 滚动无目标必须给出下一步命令，绝不无命令悬停', () => {
  const commands: EdgeCommand[] = [];
  const dispatcher = new RoleDispatcher({ soul, llm, accountPlatform: 'facebook', sendCommand: (command) => commands.push(command) });
  dispatcher.setup();
  dispatcher.startSession();

  const before = commands.length;
  dispatcher.bus.emit('action.completed', { action: 'scroll', ok: false, reason: 'no_target', ts: 1 });

  assert.ok(commands.length > before, '此前五条候选分支逐条不命中、通用兜底又排除 scroll ⇒ 静默悬停');
  dispatcher.endSession('test');
});

test('Facebook Reels epoch 重开按场有界：用尽后不再重开，绝不在两个空面之间来回弹', () => {
  const commands: EdgeCommand[] = [];
  const dispatcher = new RoleDispatcher({ soul, llm, accountPlatform: 'facebook', sendCommand: (command) => commands.push(command) });
  dispatcher.setup();
  dispatcher.startSession();

  const reelsCards = (ts: number): void => dispatcher.bus.emit('page.cards.arrived', {
    cards: [{ index: 0, title: 'reel', likeCount: 0, collectCount: 0, noteId: `https://www.facebook.com/reel/${ts}` }],
    listKind: 'reels',
    ts,
  });
  const scrollNoTarget = (ts: number): void => dispatcher.bus.emit('action.completed', {
    action: 'scroll', ok: false, reason: 'no_target', ts,
  });

  dispatcher.bus.emit('feed.empty.confirmed', { ts: 1 }); // 首次授权
  reelsCards(2);
  scrollNoTarget(3);                                      // 重开 1
  reelsCards(4);
  scrollNoTarget(5);                                      // 重开 2
  reelsCards(6);
  scrollNoTarget(7);                                      // 已用尽 → 不再重开

  const fallback = commands.filter(
    (command) => command.action === 'scroll' && command.reason === 'empty_feed_reels_fallback',
  );
  assert.equal(fallback.length, 3, '首次授权 + 至多两次重开');
  dispatcher.endSession('test');
});
